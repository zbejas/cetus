import { and, eq, lt, sql } from "drizzle-orm";
import type { AutoUpdateConfig } from "@shared/types.ts";
import { db, runDatabaseMaintenance } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { AUTO_UPDATE_ACTOR, startAutoUpdateOperation } from "./operations.ts";
import { getStackRow, readMetadata } from "./stacks.ts";
import { getHostRow, hostRowToSummary } from "./hosts.ts";
import { isCetusWorkerStackName } from "./cetusWorker.ts";
import { cronMatches, isValidCron } from "./cron.ts";
import {
  readAutoUpdateCooldown,
  readAutoUpdateState,
  recordAutoUpdateRun,
  refreshAllAutoUpdateNextRuns,
  refreshAutoUpdateNext,
} from "./autoUpdateState.ts";
import { resolveAutoUpdate } from "./autoUpdateConfig.ts";
import { readGlobalAutoUpdate } from "./globalAutoUpdate.ts";
import { checkStacksForUpdates, pendingUpdateServices, readUpdateCheck } from "./updateCheckState.ts";
import { createBackup, listBackups } from "./backups.ts";
import { refreshManagerRegistryConfig } from "./registries.ts";
import { config } from "../config.ts";

let started = false;
let ticking = false;
let checksStarted = false;
let backupsStarted = false;
let backupTicking = false;
let retentionStarted = false;
let cooldownLoggedAt = 0;

function refreshAllNextRuns() {
  refreshAllAutoUpdateNextRuns(readGlobalAutoUpdate());
}

const pendingAutoUpdates = new Map<string, NonNullable<AutoUpdateConfig>>();

function autoUpdateConcurrency() {
  const configured = Number(process.env.CETUS_AUTO_UPDATE_CONCURRENCY ?? 2);
  if (!Number.isFinite(configured)) return 2;
  return Math.max(1, Math.min(8, Math.floor(configured)));
}

function runningUpdateCount() {
  const row = db.select({ count: sql<number>`count(*)` }).from(schema.operation)
    .where(and(eq(schema.operation.type, "update"), eq(schema.operation.status, "running")))
    .get();
  return Number(row?.count ?? 0);
}

function queueDueAutoUpdates(now: Date) {
  const global = readGlobalAutoUpdate();
  for (const row of db.select().from(schema.stack).all()) {
    if (pendingAutoUpdates.has(row.id)) continue;
    const workerStack = isCetusWorkerStackName(row.name, row.projectName);
    if (workerStack) {
      const host = getHostRow(row.hostId);
      if (!host || host.kind !== "worker" || host.status !== "online") continue;
      const summary = hostRowToSummary(host);
      if (!summary.workerUpdateSupported || !summary.workerUpdateAvailable) continue;
    }
    const autoConfig = resolveAutoUpdate(readMetadata(row), global).config;
    if (!autoConfig?.enabled || !autoConfig.cron) continue;
    if (!cronMatches(autoConfig.cron, now, autoConfig.timezone || "UTC")) continue;
    const running = db.select().from(schema.operation).where(and(
      eq(schema.operation.stackId, row.id),
      eq(schema.operation.status, "running"),
    )).get();
    if (running) continue;
    const state = readAutoUpdateState(row.id);
    if (state.lastRunAt && Math.abs(now.getTime() - new Date(state.lastRunAt).getTime()) < 60_000) continue;

    let nextConfig = autoConfig;
    if (!workerStack && config.updateCheckEnabled) {
      const pending = pendingUpdateServices(row.id, autoConfig);
      if (pending && pending.length === 0) {
        recordAutoUpdateRun(row.id, "skipped", null);
        refreshAutoUpdateNext(row.id, autoConfig);
        continue;
      }
      if (pending?.length) nextConfig = { ...autoConfig, services: pending };
    }
    pendingAutoUpdates.set(row.id, nextConfig);
  }
}

function drainAutoUpdateQueue() {
  const cooldown = readAutoUpdateCooldown();
  if (cooldown) {
    if (pendingAutoUpdates.size > 0 && Date.now() - cooldownLoggedAt > 5 * 60_000) {
      cooldownLoggedAt = Date.now();
      console.log(`[cetus] auto-update paused after a registry rate limit until ${cooldown}`);
    }
    return;
  }
  const limit = autoUpdateConcurrency();
  let running = runningUpdateCount();
  let started = 0;
  for (const [stackId, config] of pendingAutoUpdates) {
    if (running >= limit) break;
    pendingAutoUpdates.delete(stackId);
    const row = getStackRow(stackId);
    if (!row) continue;
    if (isCetusWorkerStackName(row.name, row.projectName)) {
      const host = getHostRow(row.hostId);
      if (!host || host.status !== "online") continue;
      const summary = hostRowToSummary(host);
      if (!summary.workerUpdateSupported || !summary.workerUpdateAvailable) continue;
    }
    const active = db.select().from(schema.operation).where(and(
      eq(schema.operation.stackId, stackId),
      eq(schema.operation.status, "running"),
    )).get();
    if (active) continue;
    try {
      startAutoUpdateOperation(stackId, AUTO_UPDATE_ACTOR, undefined, {
        config,
        trigger: "schedule",
      });
      running += 1;
      started += 1;
      console.log(`[cetus] auto-update started for ${row.name}`);
    } catch (error) {
      console.error(`[cetus] auto-update failed to start for ${row.name}`, error);
    }
  }
  if (started > 0 && pendingAutoUpdates.size > 0) {
    console.log(`[cetus] auto-update queue: ${running} running, ${pendingAutoUpdates.size} pending`);
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    queueDueAutoUpdates(new Date());
    drainAutoUpdateQueue();
  } catch (error) {
    console.error("[cetus] auto-update scheduler tick failed", error);
  } finally {
    ticking = false;
  }
}

export function startAutoUpdateScheduler() {
  if (started) return;
  started = true;
  refreshAllNextRuns();
  setInterval(() => {
    void tick();
  }, 15_000);
}

async function runUpdateCheckSweep() {
  try {
    refreshManagerRegistryConfig();
    const cutoff = Date.now() - 60 * 60 * 1_000;
    const rows = db.select().from(schema.stack).all().filter((row) => {
      if (row.status === "updating") return false;
      if (isCetusWorkerStackName(row.name, row.projectName)) return false;
      const cached = readUpdateCheck(row.id);
      return !cached || new Date(cached.checkedAt).getTime() < cutoff;
    });
    if (!rows.length) return;
    const outcomes = await checkStacksForUpdates(rows);
    const checked = outcomes.filter((outcome) => outcome.result).length;
    const available = outcomes.filter((outcome) => outcome.result?.available).length;
    console.log(`[cetus] update check: ${checked}/${rows.length} stacks checked, ${available} with updates`);
  } catch (error) {
    console.error("[cetus] update check sweep failed", error);
  }
}

export function startUpdateCheckScheduler() {
  if (checksStarted) return;
  checksStarted = true;
  if (!config.updateCheckEnabled) {
    console.log("[cetus] registry update checks are disabled");
    return;
  }
  setTimeout(() => {
    void runUpdateCheckSweep();
  }, 15_000);
  setInterval(() => {
    void runUpdateCheckSweep();
  }, 6 * 60 * 60 * 1_000);
}

async function runBackupTick() {
  if (!config.backupEnabled || backupTicking) return;
  if (!isValidCron(config.backupCron)) return;
  const now = new Date();
  if (!cronMatches(config.backupCron, now, config.backupTimezone)) return;
  const recent = listBackups().find((backup) =>
    backup.actorName === "scheduler" &&
    backup.status === "complete" &&
    now.getTime() - new Date(backup.createdAt).getTime() < 50 * 60 * 1_000
  );
  if (recent) return;
  backupTicking = true;
  try {
    const backup = await createBackup({ actorName: "scheduler", reason: "scheduled" });
    console.log(`[cetus] scheduled backup complete: ${backup.filename} (${backup.size} bytes)`);
  } catch (error) {
    console.error("[cetus] scheduled backup failed", error);
  } finally {
    backupTicking = false;
  }
}

function pruneExpiredRecords() {
  const now = Date.now();
  const auditCutoff = new Date(now - config.auditRetentionDays * 24 * 60 * 60 * 1_000);
  const deliveryCutoff = new Date(now - config.notificationRetentionDays * 24 * 60 * 60 * 1_000);
  db.delete(schema.auditLog).where(lt(schema.auditLog.createdAt, auditCutoff)).run();
  db.delete(schema.notificationDelivery)
    .where(lt(schema.notificationDelivery.createdAt, deliveryCutoff))
    .run();
  runDatabaseMaintenance();
}

export function startRetentionScheduler() {
  if (retentionStarted) return;
  retentionStarted = true;
  setTimeout(pruneExpiredRecords, 30_000);
  setInterval(pruneExpiredRecords, 24 * 60 * 60 * 1_000);
}

export function startBackupScheduler() {
  if (backupsStarted) return;
  backupsStarted = true;
  if (!config.backupEnabled) {
    console.log("[cetus] scheduled backups are disabled");
    return;
  }
  if (!isValidCron(config.backupCron)) {
    console.warn(`[cetus] backup cron "${config.backupCron}" is invalid; scheduled backups are idle`);
    return;
  }
  console.log(`[cetus] scheduled backups: ${config.backupCron} (${config.backupTimezone}), keeping ${config.backupKeep}`);
  setTimeout(() => {
    void runBackupTick();
  }, 20_000);
  setInterval(() => {
    void runBackupTick();
  }, 60_000);
}
