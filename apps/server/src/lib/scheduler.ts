import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { AUTO_UPDATE_ACTOR, startAutoUpdateOperation } from "./operations.ts";
import { readMetadata } from "./stacks.ts";
import { cronMatches, isValidCron } from "./cron.ts";
import { readAutoUpdateState, refreshAutoUpdateNext } from "./autoUpdateState.ts";
import { checkStacksForUpdates, readUpdateCheck } from "./updateCheckState.ts";
import { createBackup, listBackups } from "./backups.ts";
import { config } from "../config.ts";

let started = false;
let ticking = false;
let checksStarted = false;
let backupsStarted = false;
let backupTicking = false;
let retentionStarted = false;

function refreshAllNextRuns() {
  for (const row of db.select().from(schema.stack).all()) {
    try {
      refreshAutoUpdateNext(row.id, readMetadata(row));
    } catch (error) {
      console.error("[cetus] could not refresh auto-update next run", row.name, error);
    }
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    for (const row of db.select().from(schema.stack).all()) {
      const metadata = readMetadata(row);
      const config = metadata.autoUpdate;
      if (!config?.enabled || !config.cron) continue;
      const timezone = config.timezone || "UTC";
      if (!cronMatches(config.cron, now, timezone)) continue;
      const running = db.select().from(schema.operation).where(and(
        eq(schema.operation.stackId, row.id),
        eq(schema.operation.status, "running"),
      )).get();
      if (running) continue;
      const state = readAutoUpdateState(row.id);
      if (state.lastRunAt && Math.abs(now.getTime() - new Date(state.lastRunAt).getTime()) < 60_000) continue;
      try {
        startAutoUpdateOperation(row.id, AUTO_UPDATE_ACTOR);
        console.log(`[cetus] auto-update started for ${row.name}`);
      } catch (error) {
        console.error(`[cetus] auto-update failed to start for ${row.name}`, error);
      }
    }
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
  }, 30_000);
}

async function runUpdateCheckSweep() {
  try {
    const cutoff = Date.now() - 60 * 60 * 1_000;
    const rows = db.select().from(schema.stack).all().filter((row) => {
      if (row.status === "updating") return false;
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
