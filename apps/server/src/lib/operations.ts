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
import { readAutoUpdateState, recordAutoUpdateRun, refreshAutoUpdateNext } from "./autoUpdateState.ts";
import { manualAutoUpdateConfig, resolveAutoUpdate } from "./autoUpdateConfig.ts";
import { readGlobalAutoUpdate } from "./globalAutoUpdate.ts";
import { markAutoUpdateApplied } from "./updateCheckState.ts";
import { notifyEvent } from "./notifications.ts";
import { getSelfInfo, isSelfUpdateTarget } from "./selfInfo.ts";

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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function selfUpdateKey(operationId: string) {
  return `selfupdate:${operationId}`;
}

function removeSelfUpdateTag(tag: string | undefined) {
  if (!tag) return;
  Bun.spawnSync(["docker", "rmi", tag], { stdout: "pipe", stderr: "pipe" });
}

function buildSelfUpdateScript(input: {
  operationId: string;
  dir: string;
  projectName: string;
  serviceName: string;
  imageRef: string;
  backupTag: string;
  statusFile: string;
  logFile: string;
  services?: string[];
  healthGraceSeconds: number;
}) {
  const quote = shellQuote;
  const pullTargets = input.services?.length ? ` ${input.services.map(quote).join(" ")}` : "";
  return `set -u
OUT=${quote(input.logFile)}
STATUS=${quote(input.statusFile)}
: > "$OUT"
finish() {
  code=$1
  status=$2
  printf '{"operationId":"${input.operationId}","status":"%s","exitCode":%s}\\n' "$status" "$code" > "$STATUS"
  exit "$code"
}
cd ${quote(input.dir)} >> "$OUT" 2>&1 || finish 1 failed
docker compose -p ${quote(input.projectName)} pull${pullTargets} >> "$OUT" 2>&1 || finish $? failed
docker compose -p ${quote(input.projectName)} up -d --remove-orphans >> "$OUT" 2>&1 || {
  echo "[cetus] compose up failed. Restoring the previous image." >> "$OUT"
  docker tag ${quote(input.backupTag)} ${quote(input.imageRef)} >> "$OUT" 2>&1 || true
  docker compose -p ${quote(input.projectName)} up -d --force-recreate >> "$OUT" 2>&1 || true
  finish 1 failed
}
for i in $(seq 1 ${Math.max(10, Math.min(input.healthGraceSeconds, 600))}); do
  cid=$(docker compose -p ${quote(input.projectName)} ps -q ${quote(input.serviceName)} 2>/dev/null | head -n 1)
  if [ -n "$cid" ]; then
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
    if [ "$health" = "healthy" ] || [ "$health" = "running" ]; then
      finish 0 success
    fi
  fi
  sleep 1
done
echo "[cetus] New container did not become healthy. Restoring the previous image." >> "$OUT"
docker tag ${quote(input.backupTag)} ${quote(input.imageRef)} >> "$OUT" 2>&1 || true
docker compose -p ${quote(input.projectName)} up -d --force-recreate >> "$OUT" 2>&1 || true
finish 1 failed
`;
}

function startSelfUpdateOperation(
  stackRow: NonNullable<ReturnType<typeof getStackRow>>,
  actor: Actor,
  request?: Request,
  options: { trigger?: "schedule" | "manual" | "bulk"; config?: AutoUpdateConfig; trackAutoUpdate?: boolean } = {},
): Operation {
  const self = getSelfInfo();
  if (!self) throw new Error("Cetus could not identify its own container for a self-update.");
  const running = db.select().from(schema.operation).where(and(
    eq(schema.operation.stackId, stackRow.id),
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
  if (options.trackAutoUpdate) {
    recordAutoUpdateRun(stackRow.id, "running", operation.id);
  }
  recordAudit({
    actor,
    action: options.trackAutoUpdate ? "stack.auto-update" : "update",
    resourceType: "stack",
    resourceId: stackRow.id,
    hostId: stackRow.hostId,
    stackId: stackRow.id,
    metadata: {
      operationId: operation.id,
      selfUpdate: true,
      trigger: options.trigger ?? "manual",
      ...(options.config ? { cron: options.config.cron, timezone: options.config.timezone } : {}),
    },
    request,
  });

  const statusFile = path.join(config.operationsDir, `self-update-${operation.id}.json`);
  const logFile = path.join(config.operationsDir, `self-update-${operation.id}.log`);
  const helperName = `cetus-self-update-${operation.id}`;
  const backupTag = `cetus-self-update:${operation.id}`;
  const settingKey = selfUpdateKey(operation.id);

  const backup = Bun.spawnSync(["docker", "tag", self.imageRef, backupTag], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (backup.exitCode !== 0) {
    const error = backup.stderr.toString().trim() || backup.stdout.toString().trim() || "Docker could not save a rollback tag.";
    appendOutput(operation.id, `[cetus] Self-update could not save the current image: ${error}\n`);
    finishOperation(operation.id, "failed", 1);
    if (options.trackAutoUpdate) recordAutoUpdateRun(stackRow.id, "failed", operation.id);
    return operation;
  }

  const meta = {
    operationId: operation.id,
    stackId: stackRow.id,
    helperName,
    backupTag,
    statusFile,
    logFile,
  };
  const now = new Date();
  db.insert(schema.setting)
    .values({ key: settingKey, value: JSON.stringify(meta), updatedAt: now })
    .onConflictDoUpdate({
      target: schema.setting.key,
      set: { value: JSON.stringify(meta), updatedAt: now },
    })
    .run();

  const dockerConfig = process.env.DOCKER_CONFIG ?? path.join(config.dataDir, "docker");
  const result = Bun.spawnSync([
    "docker",
    "run",
    "--rm",
    "-d",
    "--name",
    helperName,
    "--volumes-from",
    self.containerId,
    "-e",
    `DOCKER_CONFIG=${dockerConfig}`,
    "--entrypoint",
    "sh",
    self.imageRef,
    "-lc",
    buildSelfUpdateScript({
      operationId: operation.id,
      dir: stackRow.dir,
      projectName: stackRow.projectName,
      serviceName: self.service,
      imageRef: self.imageRef,
      backupTag,
      statusFile,
      logFile,
      services: options.config?.services,
      healthGraceSeconds: options.config?.healthGraceSeconds ?? 90,
    }),
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    db.delete(schema.setting).where(eq(schema.setting.key, settingKey)).run();
    const error = result.stderr.toString().trim() || result.stdout.toString().trim() || "The helper container did not start.";
    appendOutput(operation.id, `[cetus] Self-update helper failed to start: ${error}\n`);
    finishOperation(operation.id, "failed", 1);
    removeSelfUpdateTag(backupTag);
    if (options.trackAutoUpdate) recordAutoUpdateRun(stackRow.id, "failed", operation.id);
  } else {
    appendOutput(
      operation.id,
      "[cetus] Cetus is running in this stack. The update continues in a detached helper container so recreating the manager does not interrupt it.\n",
    );
  }
  return operation;
}

let reconcilingSelfUpdates = false;

export async function reconcileSelfUpdates() {
  if (reconcilingSelfUpdates) return;
  reconcilingSelfUpdates = true;
  try {
    await reconcileSelfUpdatesOnce();
  } finally {
    reconcilingSelfUpdates = false;
  }
}

async function reconcileSelfUpdatesOnce() {
  const rows = db.select().from(schema.setting).all().filter((row) => row.key.startsWith("selfupdate:"));
  for (const row of rows) {
    let meta: {
      operationId?: string;
      stackId?: string;
      helperName?: string;
      backupTag?: string;
      statusFile?: string;
      logFile?: string;
    };
    try {
      meta = JSON.parse(row.value) as typeof meta;
    } catch {
      db.delete(schema.setting).where(eq(schema.setting.key, row.key)).run();
      continue;
    }
    if (!meta.operationId || !meta.helperName || !meta.statusFile || !meta.logFile) {
      removeSelfUpdateTag(meta.backupTag);
      db.delete(schema.setting).where(eq(schema.setting.key, row.key)).run();
      continue;
    }

    if (!fs.existsSync(meta.statusFile)) {
      const inspect = Bun.spawnSync([
        "docker",
        "inspect",
        "--format",
        "{{.State.Status}}",
        meta.helperName,
      ], { stdout: "pipe", stderr: "pipe" });
      const helperStatus = inspect.exitCode === 0 ? inspect.stdout.toString().trim() : "missing";
      if (helperStatus === "running" || helperStatus === "created" || helperStatus === "restarting") continue;
      const operation = getOperation(meta.operationId);
      if (operation?.status === "running") {
        appendOutput(meta.operationId, "\n[cetus] Self-update helper exited before reporting a status.\n");
        finishOperation(meta.operationId, "failed", 1);
        if (operation.stackId) await refreshStackAfterOperation(operation.stackId, false);
      }
      removeSelfUpdateTag(meta.backupTag);
      db.delete(schema.setting).where(eq(schema.setting.key, row.key)).run();
      continue;
    }

    let status: { status?: string; exitCode?: number } = {};
    try {
      status = JSON.parse(fs.readFileSync(meta.statusFile, "utf8")) as typeof status;
    } catch {
      status = {};
    }
    const success = status.status === "success";
    const operation = getOperation(meta.operationId);
    if (operation?.status === "running") {
      const log = fs.existsSync(meta.logFile) ? fs.readFileSync(meta.logFile, "utf8") : "";
      if (log) {
        db.update(schema.operation)
          .set({ output: log.length > 300_000 ? log.slice(log.length - 300_000) : log })
          .where(eq(schema.operation.id, meta.operationId))
          .run();
      }
      finishOperation(meta.operationId, success ? "success" : "failed", typeof status.exitCode === "number" ? status.exitCode : null);
      if (operation.stackId) {
        const stackRow = getStackRow(operation.stackId);
        if (stackRow) {
          const autoState = readAutoUpdateState(operation.stackId);
          if (autoState.lastOperationId === operation.id) {
            const config = resolveAutoUpdate(readMetadata(stackRow), readGlobalAutoUpdate()).config;
            recordAutoUpdateRun(operation.stackId, success ? "success" : "failed", operation.id);
            refreshAutoUpdateNext(operation.stackId, config);
            if (success) markAutoUpdateApplied(operation.stackId, config?.services, config?.excludeServices);
          }
        }
        await refreshStackAfterOperation(operation.stackId, success);
      }
    }
    removeSelfUpdateTag(meta.backupTag);
    db.delete(schema.setting).where(eq(schema.setting.key, row.key)).run();
    fs.rmSync(meta.statusFile, { force: true });
    fs.rmSync(meta.logFile, { force: true });
  }
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
  if (input.type === "update" && isSelfUpdateTarget(stackRow)) {
    return startSelfUpdateOperation(stackRow, input.actor, input.request, { trigger: "manual" });
  }
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
  if (isSelfUpdateTarget(stackRow)) {
    return startSelfUpdateOperation(stackRow, actor, request, {
      trigger: options.trigger ?? "manual",
      config,
      trackAutoUpdate: true,
    });
  }
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
