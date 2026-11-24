import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { AutoUpdateState, StackMetadata } from "@shared/types.ts";
import { nextCronDate } from "./cron.ts";

interface StoredRun {
  at: string;
  status: string;
  operationId: string | null;
}

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

export function refreshAutoUpdateNext(stackId: string, metadata: StackMetadata | null | undefined) {
  const config = metadata?.autoUpdate;
  if (!config?.enabled || !config.cron) {
    db.delete(schema.setting).where(eq(schema.setting.key, nextKey(stackId))).run();
    return null;
  }
  const next = nextCronDate(config.cron, config.timezone || "UTC");
  if (next) writeSetting(nextKey(stackId), next);
  else db.delete(schema.setting).where(eq(schema.setting.key, nextKey(stackId))).run();
  return next;
}
