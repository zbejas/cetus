import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Actor, AutoUpdateConfig, UpdateQueueEntry, UpdateQueueView } from "@shared/types.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { getHostRow } from "./hosts.ts";
import { getStackRow } from "./stacks.ts";
import { manualAutoUpdateConfig } from "./autoUpdateConfig.ts";
import { readGlobalAutoUpdate } from "./globalAutoUpdate.ts";
import { readAutoUpdateCooldown } from "./autoUpdateState.ts";
import { pendingUpdateServices } from "./updateCheckState.ts";
import { isCetusWorkerStackName } from "./cetusWorker.ts";
import { getOperation, startAutoUpdateOperation } from "./operations.ts";
import { onOperationFinished } from "./operationEvents.ts";

type QueueRow = typeof schema.updateQueue.$inferSelect;

const QUEUE_ACTOR: Actor = {
  type: "user",
  id: "system",
  name: "Update queue",
  role: "admin",
  scopes: ["*"],
};

let started = false;
let draining = false;

function queueConcurrency() {
  const configured = Number(process.env.CETUS_UPDATE_QUEUE_CONCURRENCY ?? 1);
  if (!Number.isFinite(configured)) return 1;
  return Math.max(1, Math.min(8, Math.floor(configured)));
}

function parseConfig(row: QueueRow): AutoUpdateConfig {
  try {
    return JSON.parse(row.config) as AutoUpdateConfig;
  } catch {
    return manualAutoUpdateConfig(null, readGlobalAutoUpdate());
  }
}

function toEntry(row: QueueRow): UpdateQueueEntry {
  const stack = getStackRow(row.stackId);
  const host = getHostRow(row.hostId);
  return {
    id: row.id,
    stackId: row.stackId,
    stackName: row.stackName,
    displayName: stack?.displayName || row.stackName,
    hostId: row.hostId,
    hostName: host?.name ?? row.hostId,
    status: row.status,
    position: row.position,
    trigger: row.trigger,
    operationId: row.operationId,
    error: row.error,
    actorName: row.actorName,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function listUpdateQueue(): UpdateQueueView {
  const rows = db.select().from(schema.updateQueue).all();
  const active = rows
    .filter((row) => row.status === "queued" || row.status === "running")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "running" ? -1 : 1;
      return a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime();
    })
    .map(toEntry);
  const recent = rows
    .filter((row) => row.status !== "queued" && row.status !== "running")
    .sort((a, b) => (b.finishedAt?.getTime() ?? b.createdAt.getTime()) - (a.finishedAt?.getTime() ?? a.createdAt.getTime()))
    .slice(0, 20)
    .map(toEntry);
  return { active, recent, pausedUntil: readAutoUpdateCooldown() };
}

export function getUpdateQueueEntry(id: string) {
  const row = db.select().from(schema.updateQueue).where(eq(schema.updateQueue.id, id)).get();
  return row ? toEntry(row) : null;
}

export function enqueueUpdateQueue(input: {
  stacks: Array<{ stackId: string; config: AutoUpdateConfig }>;
  actorName: string;
  trigger: "manual" | "bulk";
}) {
  const activeStacks = new Set(
    db.select({ stackId: schema.updateQueue.stackId }).from(schema.updateQueue)
      .where(inArray(schema.updateQueue.status, ["queued", "running"]))
      .all()
      .map((row) => row.stackId),
  );
  const maxRow = db.select({ max: sql<number>`coalesce(max(${schema.updateQueue.position}), -1)` })
    .from(schema.updateQueue)
    .get();
  let position = Number(maxRow?.max ?? -1);
  const ids: string[] = [];
  const skipped: string[] = [];
  const now = new Date();
  db.transaction((tx) => {
    for (const item of input.stacks) {
      if (activeStacks.has(item.stackId)) {
        skipped.push(item.stackId);
        continue;
      }
      const stack = getStackRow(item.stackId);
      if (!stack || isCetusWorkerStackName(stack.name, stack.projectName)) {
        skipped.push(item.stackId);
        continue;
      }
      activeStacks.add(item.stackId);
      position += 1;
      const id = crypto.randomUUID();
      tx.insert(schema.updateQueue).values({
        id,
        stackId: stack.id,
        hostId: stack.hostId,
        stackName: stack.name,
        status: "queued",
        position,
        trigger: input.trigger,
        config: JSON.stringify(item.config),
        actorName: input.actorName,
        createdAt: now,
      }).run();
      ids.push(id);
    }
  });
  return { ids, skipped };
}

export function queueOrderError(ids: string[], queuedIds: string[]) {
  if (ids.length !== queuedIds.length) {
    return "The queue changed while it was being reordered. Refresh and try again.";
  }
  const expected = new Set(queuedIds);
  if (new Set(ids).size !== ids.length || ids.some((id) => !expected.has(id))) {
    return "The queue order does not match the queued stacks.";
  }
  return null;
}

export function reorderUpdateQueue(ids: string[]) {
  const queued = db.select().from(schema.updateQueue)
    .where(eq(schema.updateQueue.status, "queued"))
    .orderBy(asc(schema.updateQueue.position))
    .all();
  const error = queueOrderError(ids, queued.map((row) => row.id));
  if (error) throw new Error(error);
  db.transaction((tx) => {
    ids.forEach((id, index) => {
      tx.update(schema.updateQueue).set({ position: index }).where(eq(schema.updateQueue.id, id)).run();
    });
  });
}

export function removeUpdateQueueEntry(id: string) {
  const row = db.select().from(schema.updateQueue).where(eq(schema.updateQueue.id, id)).get();
  if (!row) return false;
  if (row.status === "running") throw new Error("This update is already running and cannot be removed.");
  db.delete(schema.updateQueue).where(eq(schema.updateQueue.id, id)).run();
  return true;
}

function markQueueEntry(id: string, update: Partial<QueueRow>) {
  db.update(schema.updateQueue).set(update).where(eq(schema.updateQueue.id, id)).run();
}

const RESTARTED_QUEUE_ERROR = "The manager restarted while this update was running.";

function queueStatusFromOperation(status: string): UpdateQueueEntry["status"] {
  return status === "success" ? "success" : status === "cancelled" ? "cancelled" : "failed";
}

function queueErrorFromOperation(status: string) {
  return status === "failed" ? "The update operation failed. Open the operation for details." : null;
}

export function startNextQueuedUpdate() {
  if (draining) return;
  draining = true;
  try {
    if (readAutoUpdateCooldown()) return;
    const limit = queueConcurrency();
    let running = db.select({ count: sql<number>`count(*)` }).from(schema.updateQueue)
      .where(eq(schema.updateQueue.status, "running"))
      .get();
    let runningCount = Number(running?.count ?? 0);
    while (runningCount < limit) {
      const row = db.select().from(schema.updateQueue)
        .where(eq(schema.updateQueue.status, "queued"))
        .orderBy(asc(schema.updateQueue.position), asc(schema.updateQueue.createdAt))
        .get();
      if (!row) break;
      const stack = getStackRow(row.stackId);
      if (!stack) {
        markQueueEntry(row.id, { status: "failed", error: "The stack is no longer indexed.", finishedAt: new Date() });
        continue;
      }
      const active = db.select().from(schema.operation).where(and(
        eq(schema.operation.stackId, row.stackId),
        eq(schema.operation.status, "running"),
      )).get();
      if (active) {
        markQueueEntry(row.id, {
          status: "skipped",
          error: "Another operation is already running for this stack.",
          finishedAt: new Date(),
        });
        continue;
      }
      let config = parseConfig(row);
      const pending = pendingUpdateServices(row.stackId, config);
      if (pending && pending.length === 0) {
        markQueueEntry(row.id, {
          status: "skipped",
          error: "No changed services were found when the queue reached this stack.",
          finishedAt: new Date(),
        });
        continue;
      }
      if (pending?.length) config = { ...config, services: pending };
      try {
        const operation = startAutoUpdateOperation(row.stackId, QUEUE_ACTOR, undefined, {
          config,
          trigger: "queue",
        });
        const current = getOperation(operation.id);
        if (!current || current.status !== "running") {
          markQueueEntry(row.id, {
            status: current?.status === "success" ? "success" : current?.status === "cancelled" ? "cancelled" : "failed",
            operationId: operation.id,
            startedAt: new Date(),
            finishedAt: new Date(),
            error: current?.status === "success" ? null : "The update finished before the queue could start the next stack.",
          });
          continue;
        }
        markQueueEntry(row.id, {
          status: "running",
          operationId: operation.id,
          startedAt: new Date(),
          error: null,
        });
        runningCount += 1;
      } catch (error) {
        markQueueEntry(row.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "The update could not start.",
          finishedAt: new Date(),
        });
      }
    }
  } finally {
    draining = false;
  }
}

function finishQueuedOperation(operationId: string, status: string) {
  const row = db.select().from(schema.updateQueue).where(eq(schema.updateQueue.operationId, operationId)).get();
  if (!row) return;
  const reconcilable = row.status === "running" || (row.status === "failed" && row.error === RESTARTED_QUEUE_ERROR);
  if (!reconcilable) return;
  const finalStatus = queueStatusFromOperation(status);
  markQueueEntry(row.id, {
    status: finalStatus,
    finishedAt: new Date(),
    error: queueErrorFromOperation(status),
  });
  const timer = setTimeout(() => startNextQueuedUpdate(), 0);
  timer.unref?.();
}

export function recoverUpdateQueue() {
  const pending = db.select().from(schema.updateQueue)
    .where(or(
      eq(schema.updateQueue.status, "running"),
      and(
        eq(schema.updateQueue.status, "failed"),
        eq(schema.updateQueue.error, RESTARTED_QUEUE_ERROR),
      ),
    ))
    .all();
  for (const row of pending) {
    const operation = row.operationId ? getOperation(row.operationId) : null;
    if (operation && operation.status !== "running") {
      markQueueEntry(row.id, {
        status: queueStatusFromOperation(operation.status),
        finishedAt: operation.finishedAt ? new Date(operation.finishedAt) : new Date(),
        error: queueErrorFromOperation(operation.status),
      });
      continue;
    }
    if (row.status === "running") {
      markQueueEntry(row.id, {
        status: "failed",
        error: RESTARTED_QUEUE_ERROR,
        finishedAt: new Date(),
      });
    }
  }
}

export function pruneUpdateQueue() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
  db.delete(schema.updateQueue).where(and(
    inArray(schema.updateQueue.status, ["success", "failed", "cancelled", "skipped"]),
    lt(schema.updateQueue.createdAt, cutoff),
  )).run();
  const stale = db.select({ id: schema.updateQueue.id }).from(schema.updateQueue)
    .where(inArray(schema.updateQueue.status, ["success", "failed", "cancelled", "skipped"]))
    .orderBy(desc(schema.updateQueue.finishedAt))
    .all()
    .slice(100);
  if (stale.length > 0) {
    db.delete(schema.updateQueue).where(inArray(schema.updateQueue.id, stale.map((row) => row.id))).run();
  }
}

export function startUpdateQueueScheduler() {
  if (started) return;
  started = true;
  recoverUpdateQueue();
  onOperationFinished(finishQueuedOperation);
  setTimeout(() => startNextQueuedUpdate(), 2_000);
  const timer = setInterval(() => startNextQueuedUpdate(), 5_000);
  timer.unref?.();
}
