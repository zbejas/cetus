import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { config } from "../config.ts";
import type { Actor, AutoUpdateConfig, Operation, OperationType } from "@shared/types.ts";
import { recordAudit } from "./security.ts";
import { getHostRow } from "./hosts.ts";
import { sendToWorker } from "./remote.ts";
import {
  clearRemoteStackDeleting,
  getStackDetail,
  getStackRow,
  invalidateStackCache,
  markRemoteStackDeleting,
  moveToTrash,
  readMetadata,
  snapshotCurrent,
} from "./stacks.ts";
import { runAutoUpdate } from "./autoUpdateRunner.ts";
import { recordAutoUpdateRun, refreshAutoUpdateNext } from "./autoUpdateState.ts";
import { manualAutoUpdateConfig, resolveAutoUpdate } from "./autoUpdateConfig.ts";
import { readGlobalAutoUpdate } from "./globalAutoUpdate.ts";
import { markAutoUpdateApplied } from "./updateCheckState.ts";
import { notifyEvent } from "./notifications.ts";

const buffers = new Map<string, string>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function operationToJson(row: typeof schema.operation.$inferSelect): Operation {
  return {
    id: row.id,
    type: row.type as OperationType,
    status: row.status,
    stackId: row.stackId,
    stackName: row.stackName,
    hostId: row.hostId,
    actorName: row.actorName,
    output: row.output,
    exitCode: row.exitCode,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function getOperation(id: string): Operation | null {
  const row = db.select().from(schema.operation).where(eq(schema.operation.id, id)).get();
  if (!row) return null;
  const buffered = buffers.get(id);
  return operationToJson(buffered ? { ...row, output: `${row.output}${buffered}` } : row);
}

export function listOperations(limit = 50): Operation[] {
  return db.select().from(schema.operation).orderBy(desc(schema.operation.startedAt)).limit(limit).all().map(operationToJson);
}

export function createOperation(input: {
  type: OperationType;
  hostId?: string | null;
  stackId?: string | null;
  stackName?: string | null;
  actor: Actor;
}): Operation {
  const id = crypto.randomUUID();
  const now = new Date();
  db.insert(schema.operation).values({
    id,
    type: input.type,
    status: "running",
    hostId: input.hostId ?? null,
    stackId: input.stackId ?? null,
    stackName: input.stackName ?? null,
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorName: input.actor.name,
    output: "",
    startedAt: now,
  }).run();
  buffers.set(id, "");
  return operationToJson(db.select().from(schema.operation).where(eq(schema.operation.id, id)).get()!);
}

function flushOutput(id: string) {
  const buffer = buffers.get(id);
  if (buffer === undefined) return;
  buffers.set(id, "");
  if (!buffer) return;
  const row = db.select().from(schema.operation).where(eq(schema.operation.id, id)).get();
  if (!row) return;
  const combined = `${row.output}${buffer}`;
  const trimmed = combined.length > 300_000 ? combined.slice(combined.length - 300_000) : combined;
  db.update(schema.operation).set({ output: trimmed }).where(eq(schema.operation.id, id)).run();
}

export function appendOutput(id: string, chunk: string) {
  const current = buffers.get(id) ?? "";
  buffers.set(id, `${current}${chunk}`);
  if (current.length > 32_000) flushOutput(id);
  if (!flushTimers.has(id)) {
    flushTimers.set(id, setTimeout(() => {
      flushTimers.delete(id);
      flushOutput(id);
    }, 300));
  }
}

export function finishOperation(id: string, status: "success" | "failed" | "cancelled", exitCode: number | null) {
  flushOutput(id);
  const finishedAt = new Date();
  db.update(schema.operation).set({ status, exitCode, finishedAt }).where(eq(schema.operation.id, id)).run();
  const row = db.select().from(schema.operation).where(eq(schema.operation.id, id)).get();
  if (row) {
    const file = path.join(config.operationsDir, `${id}.log`);
    fs.writeFileSync(file, row.output);
    const event = status === "failed" ? "operation.failed" : status === "success" ? "operation.success" : "operation.cancelled";
    void notifyEvent({
      event,
      title: `${row.stackName ?? "Operation"} ${status}`,
      message: `Operation ${row.type} for ${row.stackName ?? "a stack"} finished with status ${status}.`,
      stackId: row.stackId,
      stackName: row.stackName,
      hostId: row.hostId,
    });
  }
  buffers.delete(id);
  const timer = flushTimers.get(id);
  if (timer) clearTimeout(timer);
  flushTimers.delete(id);
}

export async function refreshStackAfterOperation(stackId: string, deployed: boolean) {
  invalidateStackCache(stackId);
  const detail = await getStackDetail(stackId);
  if (!detail) return;
  db.update(schema.stack).set({
    status: detail.status,
    updatedAt: new Date(),
    ...(deployed ? { lastDeployedAt: new Date() } : {}),
  }).where(eq(schema.stack.id, stackId)).run();
}

export interface ComposeOperationInput {
  type: OperationType;
  stackId: string;
  args: string[];
  argsAfter?: string[];
  actor: Actor;
  deployed?: boolean;
  auditAction?: string;
  request?: Request;
}

export function startComposeOperation(input: ComposeOperationInput): Operation {
  const stackRow = getStackRow(input.stackId);
  if (!stackRow) throw new Error("Stack not found");
  const owner = getHostRow(stackRow.hostId);
  if (owner?.kind !== "worker" && ["deploy", "update", "down"].includes(input.type)) {
    try {
      snapshotCurrent(stackRow, input.type, input.actor.name);
    } catch (error) {
      console.error("[cetus] snapshot before operation failed", error);
    }
  }
  const operation = createOperation({
    type: input.type,
    hostId: stackRow.hostId,
    stackId: stackRow.id,
    stackName: stackRow.name,
    actor: input.actor,
  });

  recordAudit({
    actor: input.actor,
    action: input.auditAction ?? input.type,
    resourceType: "stack",
    resourceId: stackRow.id,
    hostId: stackRow.hostId,
    stackId: stackRow.id,
    metadata: { operationId: operation.id, args: input.args },
    request: input.request,
  });

  if (owner?.kind === "worker") {
    const sent = sendToWorker(stackRow.hostId, {
      type: "command",
      operationId: operation.id,
      stackName: stackRow.name,
      projectName: stackRow.projectName,
      args: input.args,
      argsAfter: input.argsAfter ?? [],
      action: input.type,
    });
    if (!sent) {
      appendOutput(operation.id, "[cetus] Worker is not connected.\n");
      finishOperation(operation.id, "failed", 1);
    }
    return operation;
  }

  void (async () => {
    try {
      const pump = async (stream: ReadableStream<Uint8Array>, prefix = "") => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          appendOutput(operation.id, prefix + decoder.decode(value, { stream: true }));
        }
      };

      const run = async (args: string[]) => {
        const proc = Bun.spawn(["docker", "compose", "-p", stackRow.projectName, ...args], {
          cwd: stackRow.dir,
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        await Promise.all([
          pump(proc.stdout),
          pump(proc.stderr, "[stderr] "),
        ]);
        return proc.exited;
      };

      let exitCode = await run(input.args);
      if (exitCode === 0 && input.argsAfter?.length) {
        appendOutput(operation.id, `\n[cetus] $ docker compose -p ${stackRow.projectName} ${input.argsAfter.join(" ")}\n`);
        exitCode = await run(input.argsAfter);
      }
      const status = exitCode === 0 ? "success" : "failed";
      finishOperation(operation.id, status, exitCode);
      await refreshStackAfterOperation(stackRow.id, Boolean(input.deployed && exitCode === 0));
    } catch (error) {
      appendOutput(operation.id, `\n[cetus] ${error instanceof Error ? error.message : String(error)}\n`);
      finishOperation(operation.id, "failed", 1);
      await refreshStackAfterOperation(stackRow.id, false);
    }
  })();

  return operation;
}

export const AUTO_UPDATE_ACTOR: Actor = {
  type: "user",
  id: "system",
  name: "Auto-update",
  role: "admin",
  scopes: ["*"],
};

export interface AutoUpdateRunOptions {
  config?: AutoUpdateConfig;
  trigger?: "schedule" | "manual" | "bulk";
}

export function startAutoUpdateOperation(
  stackId: string,
  actor: Actor,
  request?: Request,
  options: AutoUpdateRunOptions = {},
): Operation {
  const stackRow = getStackRow(stackId);
  if (!stackRow) throw new Error("Stack not found");
  const metadata = readMetadata(stackRow);
  const global = readGlobalAutoUpdate();
  const resolved = options.config ?? resolveAutoUpdate(metadata, global).config;
  const config = resolved ?? manualAutoUpdateConfig(metadata, global);
  const running = db.select().from(schema.operation).where(and(
    eq(schema.operation.stackId, stackId),
    eq(schema.operation.status, "running"),
  )).get();
  if (running) throw new Error("Another operation is already running for this stack.");

  const operation = createOperation({
    type: "update",
    hostId: stackRow.hostId,
    stackId: stackRow.id,
    stackName: stackRow.name,
    actor,
  });

  recordAutoUpdateRun(stackRow.id, "running", operation.id);
  recordAudit({
    actor,
    action: "stack.auto-update",
    resourceType: "stack",
    resourceId: stackRow.id,
    hostId: stackRow.hostId,
    stackId: stackRow.id,
    metadata: {
      operationId: operation.id,
      cron: config.cron,
      timezone: config.timezone,
      trigger: options.trigger ?? "manual",
    },
    request,
  });

  const owner = getHostRow(stackRow.hostId);
  if (owner?.kind === "worker") {
    const sent = sendToWorker(stackRow.hostId, {
      type: "auto-update",
      operationId: operation.id,
      stackName: stackRow.name,
      projectName: stackRow.projectName,
      composeFile: stackRow.composeFile,
      config,
    });
    if (!sent) {
      appendOutput(operation.id, "[cetus] Worker is not connected.\n");
      finishOperation(operation.id, "failed", 1);
      recordAutoUpdateRun(stackRow.id, "failed", operation.id);
    }
    return operation;
  }

  try {
    snapshotCurrent(stackRow, "auto-update", actor.name);
  } catch (error) {
    console.error("[cetus] snapshot before auto-update failed", error);
  }

  void (async () => {
    try {
      const result = await runAutoUpdate(
        { dir: stackRow.dir, projectName: stackRow.projectName, composeFile: stackRow.composeFile },
        {
          services: config.services,
          excludeServices: config.excludeServices,
          healthCheck: config.healthCheck,
          rollback: config.rollback,
          healthGraceSeconds: config.healthGraceSeconds,
        },
        (chunk) => appendOutput(operation.id, chunk),
      );
      finishOperation(operation.id, result.status === "success" ? "success" : "failed", result.status === "success" ? 0 : 1);
      recordAutoUpdateRun(stackRow.id, result.status, operation.id);
      refreshAutoUpdateNext(stackRow.id, config);
      await refreshStackAfterOperation(stackRow.id, result.status === "success");
      if (result.status === "success") {
        markAutoUpdateApplied(stackRow.id, config.services, config.excludeServices);
      }
    } catch (error) {
      appendOutput(operation.id, `[cetus] ${error instanceof Error ? error.message : String(error)}\n`);
      finishOperation(operation.id, "failed", 1);
      recordAutoUpdateRun(stackRow.id, "failed", operation.id);
    }
  })();

  return operation;
}

export function startDeleteOperation(stackId: string, actor: Actor, request?: Request): Operation {
  const stackRow = getStackRow(stackId);
  if (!stackRow) throw new Error("Stack not found");
  const owner = getHostRow(stackRow.hostId);
  const operation = createOperation({
    type: "delete",
    hostId: stackRow.hostId,
    stackId: stackRow.id,
    stackName: stackRow.name,
    actor,
  });

  recordAudit({
    actor,
    action: "delete",
    resourceType: "stack",
    resourceId: stackRow.id,
    hostId: stackRow.hostId,
    stackId: stackRow.id,
    metadata: { operationId: operation.id },
    request,
  });

  if (owner?.kind === "worker") {
    markRemoteStackDeleting(stackRow.hostId, stackRow.name);
    const sent = sendToWorker(stackRow.hostId, {
      type: "command",
      operationId: operation.id,
      stackName: stackRow.name,
      projectName: stackRow.projectName,
      args: ["down", "--remove-orphans"],
      argsAfter: [],
      action: "delete",
    });
    if (!sent) {
      clearRemoteStackDeleting(stackRow.hostId, stackRow.name);
      appendOutput(operation.id, "[cetus] Worker is not connected.\n");
      finishOperation(operation.id, "failed", 1);
    }
    return operation;
  }

  try {
    snapshotCurrent(stackRow, "delete", actor.name);
  } catch (error) {
    console.error("[cetus] snapshot before delete failed", error);
  }

  void (async () => {
    try {
      const proc = Bun.spawn(["docker", "compose", "-p", stackRow.projectName, "down", "--remove-orphans"], {
        cwd: stackRow.dir,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const pump = async (stream: ReadableStream<Uint8Array>, prefix = "") => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          appendOutput(operation.id, prefix + decoder.decode(value, { stream: true }));
        }
      };
      await Promise.all([pump(proc.stdout), pump(proc.stderr, "[stderr] ")]);
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const target = path.join(config.trashDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${stackRow.name}`);
        moveToTrash(stackRow.dir, target);
        db.delete(schema.stack).where(eq(schema.stack.id, stackRow.id)).run();
        invalidateStackCache(stackRow.id);
        appendOutput(operation.id, `\n[cetus] Moved stack to ${target}\n`);
        finishOperation(operation.id, "success", 0);
      } else {
        finishOperation(operation.id, "failed", exitCode);
      }
    } catch (error) {
      appendOutput(operation.id, `\n[cetus] ${error instanceof Error ? error.message : String(error)}\n`);
      finishOperation(operation.id, "failed", 1);
    }
  })();

  return operation;
}
