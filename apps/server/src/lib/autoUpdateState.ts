import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { AutoUpdateConfig, AutoUpdateState, StackMetadata } from "@shared/types.ts";
import { nextCronDate } from "./cron.ts";
import { resolveAutoUpdate } from "./autoUpdateConfig.ts";
import { isCetusWorkerStackName } from "./cetusWorker.ts";

interface StoredRun {
  at: string;
  status: string;
  operationId: string | null;
}

const COOLDOWN_KEY = "autoupdate.cooldown";

function readSetting(key: string) {
  return db.select().from(schema.setting).where(eq(schema.setting.key, key)).get()?.value ?? null;
}

function writeSetting(key: string, value: string) {
  const now = new Date();
  db.insert(schema.setting)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value, updatedAt: now } })
    .run();
}

function lastKey(stackId: string) {
  return `autoupdate.last:${stackId}`;
}

function nextKey(stackId: string) {
  return `autoupdate.next:${stackId}`;
}

export function readAutoUpdateCooldown(): string | null {
  const raw = readSetting(COOLDOWN_KEY);
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > Date.now() ? new Date(at).toISOString() : null;
}

export function setAutoUpdateCooldown(minutes = 360) {
  const capped = Math.max(5, Math.min(1440, Math.floor(minutes)));
  const until = new Date(Date.now() + capped * 60_000).toISOString();
  writeSetting(COOLDOWN_KEY, until);
  return until;
}

export function readAutoUpdateState(stackId: string): AutoUpdateState {
  let last: StoredRun | null = null;
  try {
    const raw = readSetting(lastKey(stackId));
    if (raw) last = JSON.parse(raw) as StoredRun;
  } catch {
    last = null;
  }
  return {
    nextRunAt: readSetting(nextKey(stackId)),
    lastRunAt: last?.at ?? null,
    lastStatus: last?.status ?? null,
    lastOperationId: last?.operationId ?? null,
  };
}

export function recordAutoUpdateRun(stackId: string, status: string, operationId: string | null) {
  writeSetting(lastKey(stackId), JSON.stringify({
    at: new Date().toISOString(),
    status,
    operationId,
  }));
}

export function refreshAutoUpdateNext(stackId: string, config: AutoUpdateConfig | null | undefined) {
  if (!config?.enabled || !config.cron) {
    db.delete(schema.setting).where(eq(schema.setting.key, nextKey(stackId))).run();
    return null;
  }
  const next = nextCronDate(config.cron, config.timezone || "UTC");
  if (next) writeSetting(nextKey(stackId), next);
  else db.delete(schema.setting).where(eq(schema.setting.key, nextKey(stackId))).run();
  return next;
}

export function refreshAllAutoUpdateNextRuns(global: AutoUpdateConfig) {
  for (const row of db.select().from(schema.stack).all()) {
    if (isCetusWorkerStackName(row.name, row.projectName)) {
      refreshAutoUpdateNext(row.id, null);
      continue;
    }
    let metadata: StackMetadata = {};
    try {
      metadata = JSON.parse(row.metadata) as StackMetadata;
    } catch {
      metadata = {};
    }
    refreshAutoUpdateNext(row.id, resolveAutoUpdate(metadata, global).config);
  }
}
