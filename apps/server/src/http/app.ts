import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Elysia, t } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { auth, seedAdminFromEnvironment } from "../auth.ts";
import { config, trustedOrigins } from "../config.ts";
import { ALL_SCOPES, ROLE_SCOPES, hasScope } from "@shared/scopes.ts";
import { isPaletteId } from "@shared/palettes.ts";
import type { Actor, AuditEntry, OperationType, Role, StackMetadata } from "@shared/types.ts";
import { ApiError, jsonError } from "../lib/errors.ts";
import { apiDocsClient, apiDocsHtml } from "../lib/apiDocs.ts";
import {
  actorCanTarget,
  createApiKey,
  deleteInactiveApiKey,
  getActor,
  getClientIp,
  getSessionUser,
  listApiKeys,
  pruneRevokedApiKeys,
  recordAudit,
  requireActor,
  requireScope,
  revokeApiKey,
} from "../lib/security.ts";
import {
  composeLogs,
  docker,
  listContainers,
  runCommand,
} from "../lib/docker.ts";
import { listLogSources } from "../lib/logSources.ts";
import { getSettingsView, updateSettings } from "../lib/settings.ts";
import { readAutoUpdateState, recordAutoUpdateRun, refreshAutoUpdateNext } from "../lib/autoUpdateState.ts";
import { startAutoUpdateScheduler, startBackupScheduler, startRetentionScheduler, startUpdateCheckScheduler } from "../lib/scheduler.ts";
import { createBackup, deleteBackup, getBackup, listBackups, recoverInterruptedBackups, stageRestore } from "../lib/backups.ts";
import { checkStackForUpdates, checkStacksForUpdates, listUpdateChecks, markAutoUpdateApplied, readUpdateCheck } from "../lib/updateCheckState.ts";
import { getUserPalette, setUserPalette } from "../lib/preferences.ts";
import {
  createInviteRecord,
  findValidInvite,
  listPendingInvites,
  markInviteAccepted,
  revokeInviteRecord,
} from "../lib/invites.ts";
import { escapeHtml, sendMail, smtpConfigured } from "../lib/mailer.ts";
import {
  createChannel,
  deleteChannel,
  listChannels,
  listDeliveries,
  sendChannelTest,
  updateChannel,
  type NotificationChannelType,
} from "../lib/notifications.ts";
import {
  getHostInventory,
  getHostRow,
  getHostSummary,
  listHosts,
  LOCAL_HOST_ID,
} from "../lib/hosts.ts";
import {
  createStack,
  getStackDetail,
  getStackRow,
  listStacks,
  readMetadata,
  restoreSnapshot,
  validateStackMetadata,
  saveStackFiles,
  syncStacks,
  validateComposeText,
} from "../lib/stacks.ts";
import {
  appendOutput,
  finishOperation,
  getOperation,
  listOperations,
  refreshStackAfterOperation,
  startAutoUpdateOperation,
  startComposeOperation,
  startDeleteOperation,
} from "../lib/operations.ts";
import { getStats } from "../lib/docker.ts";
import {
  addPendingWorker,
  getRemoteHost,
  getRemoteInventory,
  endRemoteLogStream,
  failRemoteLogStream,
  failRemoteLogStreamsForHost,
  pushRemoteLogChunk,
  registerRemoteLogStream,
  requestWorkerMetadataWrite,
  resolveMetadataWrite,
  updateRemoteStackMetadata,
  registerWorker,
  rejectLogResponse,
  removePendingWorker,
  removeRemoteLogStream,
  requestWorkerContainerLogs,
  requestWorkerLogs,
  resolveLogResponse,
  resolveUpdateCheck,
  sendToWorker,
  unregisterWorker,
} from "../lib/remote.ts";
import { syncRemoteStacks } from "../lib/stacks.ts";

const startedAt = Date.now();

function auditToJson(row: typeof schema.auditLog.$inferSelect): AuditEntry {
  let metadata: Record<string, unknown> | null = null;
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    metadata = null;
  }
  return {
    id: row.id,
    actorType: row.actorType,
    actorName: row.actorName,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    hostId: row.hostId,
    stackId: row.stackId,
    metadata,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function getRecentAudit(limit = 20, stackId?: string): AuditEntry[] {
  const query = db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.createdAt)).limit(limit);
  if (stackId) {
    return db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.stackId, stackId))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(limit)
      .all()
      .map(auditToJson);
  }
  return query.all().map(auditToJson);
}

async function actorFor(request: Request): Promise<Actor> {
  return requireActor(await getActor(request));
}

async function actorForScope(request: Request, scope: string): Promise<Actor> {
  const actor = await actorFor(request);
  requireScope(actor, scope);
  return actor;
}

const USER_ROLES: Role[] = ["admin", "operator", "viewer"];

function isUserRole(value: unknown): value is Role {
  return typeof value === "string" && USER_ROLES.includes(value as Role);
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function adminCount() {
  const rows = db.select({ count: sql<number>`count(*)` }).from(schema.user).where(eq(schema.user.role, "admin")).all();
  return Number(rows[0]?.count ?? 0);
}

function userSummary(row: typeof schema.user.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

async function setUserPassword(userId: string, password: string) {
  const token = crypto.randomBytes(24).toString("base64url");
  const identifier = `reset-password:${token}`;
  const now = new Date();
  db.insert(schema.verification).values({
    id: crypto.randomUUID(),
    identifier,
    value: userId,
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  }).run();
  try {
    await auth.api.resetPassword({ body: { newPassword: password, token } });
  } finally {
    db.delete(schema.verification).where(eq(schema.verification.identifier, identifier)).run();
  }
}

function keyRestrictions(actor: Actor) {
  if (actor.type !== "key") return { hostIds: [], stackIds: [] };
  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, actor.id)).get();
  if (!row) return { hostIds: [], stackIds: [] };
  try {
    return {
      hostIds: JSON.parse(row.hostIds) as string[],
      stackIds: JSON.parse(row.stackIds) as string[],
    };
  } catch {
    return { hostIds: [], stackIds: [] };
  }
}

function assertTarget(actor: Actor, hostId?: string | null, stackId?: string | null) {
  if (!actorCanTarget(actor, { hostId, stackId }, keyRestrictions(actor))) {
    throw new ApiError(403, "target_forbidden", "This key is restricted to other hosts or stacks.");
  }
}

function assertInstanceTarget(actor: Actor) {
  if (actor.type !== "key") return;
  const restrictions = keyRestrictions(actor);
  if (restrictions.hostIds.length > 0 || restrictions.stackIds.length > 0) {
    throw new ApiError(403, "target_forbidden", "Instance backups are not available to a host- or stack-restricted key.");
  }
}

function filterHostsForActor(actor: Actor, hosts: Awaited<ReturnType<typeof listHosts>>) {
  if (actor.type !== "key") return hosts;
  const restrictions = keyRestrictions(actor);
  if (restrictions.hostIds.length === 0) return hosts;
  return hosts.filter((host) => restrictions.hostIds.includes(host.id));
}

function filterStacksForActor(actor: Actor, stacks: Awaited<ReturnType<typeof listStacks>>) {
  if (actor.type !== "key") return stacks;
  const restrictions = keyRestrictions(actor);
  return stacks.filter((stack) => {
    if (restrictions.hostIds.length > 0 && !restrictions.hostIds.includes(stack.hostId)) return false;
    if (restrictions.stackIds.length > 0 && !restrictions.stackIds.includes(stack.id)) return false;
    return true;
  });
}

function filterAuditForActor(actor: Actor, entries: AuditEntry[]) {
  if (actor.type !== "key") return entries;
  const restrictions = keyRestrictions(actor);
  return entries.filter((entry) => {
    if (restrictions.hostIds.length > 0 && entry.hostId && !restrictions.hostIds.includes(entry.hostId)) return false;
    if (restrictions.stackIds.length > 0 && entry.stackId && !restrictions.stackIds.includes(entry.stackId)) return false;
    return true;
  });
}

function redactStackDetail<T extends { env: string } | null>(actor: Actor, detail: T): T {
  if (!detail || hasScope(actor.scopes, "secrets:reveal")) return detail;
  return { ...detail, env: "", envRedacted: true } as T;
}

function dockerTarget(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new ApiError(422, "invalid_container", "Container ID or name is not valid.");
  }
  return value;
}

function logTail(value: unknown, fallback = 500) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(Math.floor(parsed), 5_000));
}

function keepLogStreamAlive(
  enqueue: (chunk: Uint8Array) => void,
  encoder: TextEncoder,
  atLineBoundary: () => boolean,
) {
  const timer = setInterval(() => {
    if (!atLineBoundary()) return;
    try {
      enqueue(encoder.encode("\n"));
    } catch {
      clearInterval(timer);
    }
  }, 5_000);
  return () => clearInterval(timer);
}

function stackIdForProject(hostId: string, project: string | null) {
  if (!project) return null;
  return db.select({ id: schema.stack.id }).from(schema.stack).where(and(
    eq(schema.stack.hostId, hostId),
    eq(schema.stack.projectName, project),
  )).get()?.id ?? null;
}

async function findContainerOnHost(hostId: string, containerId: string) {
  const owner = getHostRow(hostId);
  if (!owner) throw new ApiError(404, "host_not_found", "Host not found.");
  const containers = owner.kind === "local"
    ? await listContainers()
    : getRemoteInventory(hostId)?.containers ?? [];
  const matches = containers.filter((entry) => entry.id === containerId || (containerId.length >= 6 && entry.id.startsWith(containerId)));
  if (matches.length === 0) throw new ApiError(404, "container_not_found", "Container not found on this host.");
  if (matches.length > 1) throw new ApiError(409, "container_ambiguous", "Container ID prefix matches more than one container.");
  return matches[0];
}

function assertContainerTarget(actor: Actor, hostId: string, project: string | null) {
  const stackId = stackIdForProject(hostId, project);
  assertTarget(actor, hostId, stackId);
  return stackId;
}

function stackOperationArgs(action: string, profiles: string[] = []): { args: string[]; argsAfter?: string[]; deployed?: boolean } {
  const profileArgs = profiles.flatMap((profile) => ["--profile", profile]);
  switch (action) {
    case "deploy":
      return { args: ["up", "-d", "--remove-orphans", ...profileArgs], deployed: true };
    case "start":
      return { args: ["up", "-d", ...profileArgs], deployed: true };
    case "stop":
      return { args: ["stop"] };
    case "restart":
      return { args: ["restart"] };
    case "down":
      return { args: ["down", "--remove-orphans"] };
    case "update":
      return { args: ["pull"], argsAfter: ["up", "-d", "--remove-orphans", ...profileArgs], deployed: true };
    default:
      throw new ApiError(400, "invalid_action", `Unknown stack action: ${action}`);
  }
}

const mcpTools = [
  {
    name: "list_hosts",
    description: "List managed hosts and their status.",
    scope: "hosts:read",
    mode: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_stacks",
    description: "List Compose stacks across the fleet.",
    scope: "stacks:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        hostId: { type: "string", description: "Optional host filter." },
        query: { type: "string", description: "Optional name filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_stack",
    description: "Get full detail for one stack, including services and compose files.",
    scope: "stacks:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { stackId: { type: "string" } },
      required: ["stackId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_stack_logs",
    description: "Read recent logs for a stack.",
    scope: "logs:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string" },
        tail: { type: "number", minimum: 1, maximum: 2000 },
      },
      required: ["stackId"],
      additionalProperties: false,
    },
  },
  {
    name: "deploy_stack",
    description: "Deploy a stack. Requires mcp:write and stacks:deploy.",
    scope: "stacks:deploy",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string" },
        profiles: { type: "array", items: { type: "string" } },
      },
      required: ["stackId"],
      additionalProperties: false,
    },
  },
  {
    name: "stack_lifecycle",
    description: "Start, stop, restart, or down a stack. Requires mcp:write and stacks:deploy.",
    scope: "stacks:deploy",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string" },
        action: { type: "string", enum: ["start", "stop", "restart", "down"] },
        confirm: { type: "boolean", description: "Required true when action is down." },
      },
      required: ["stackId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "get_host",
    description: "Get one host with Docker info, resource use, and counters.",
    scope: "hosts:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string" } },
      required: ["hostId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_host_inventory",
    description: "Get containers, images, volumes, networks, disk use, and Docker info for one host.",
    scope: "hosts:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string" } },
      required: ["hostId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_containers",
    description: "List containers across visible hosts, or on one host.",
    scope: "containers:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        hostId: { type: "string", description: "Optional host filter." },
        query: { type: "string", description: "Optional name, image, or state filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_container_logs",
    description: "Read recent logs for one container.",
    scope: "logs:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string" },
        hostId: { type: "string", description: "Defaults to the local host." },
        tail: { type: "number", minimum: 1, maximum: 5000 },
        timestamps: { type: "boolean" },
      },
      required: ["containerId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_stack_compose",
    description: "Read the compose file, env file, metadata, hashes, profiles, and snapshots for a stack. Env values require secrets:reveal.",
    scope: "stacks:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { stackId: { type: "string" } },
      required: ["stackId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_services",
    description: "List services for one stack with state, health, ports, and resource use.",
    scope: "stacks:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { stackId: { type: "string" } },
      required: ["stackId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_updates",
    description: "Read cached image update state for visible stacks, or for one stack.",
    scope: "updates:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { stackId: { type: "string", description: "Optional stack filter." } },
      additionalProperties: false,
    },
  },
  {
    name: "check_updates",
    description: "Check registries for image updates on visible stacks, or on one stack.",
    scope: "updates:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { stackId: { type: "string", description: "Optional stack filter." } },
      additionalProperties: false,
    },
  },
  {
    name: "get_activity",
    description: "Read recent audit entries for visible hosts and stacks.",
    scope: "audit:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 200 },
        stackId: { type: "string", description: "Optional stack filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_operations",
    description: "List recent operations for visible hosts and stacks.",
    scope: "stacks:read",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 200 },
        stackId: { type: "string", description: "Optional stack filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_stack",
    description: "Create a local Compose stack from a compose file. Requires mcp:write and stacks:write.",
    scope: "stacks:write",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase letters, numbers, dashes, and underscores." },
        compose: { type: "string" },
      },
      required: ["name", "compose"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_stack_compose",
    description: "Save compose, env, or metadata for a local stack. Requires mcp:write and stacks:write. Use baseHash to reject a stale write.",
    scope: "stacks:write",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string" },
        compose: { type: "string" },
        env: { type: "string" },
        metadata: { type: "object" },
        baseHash: { type: "string" },
      },
      required: ["stackId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_stack",
    description: "Move a local stack to trash after stopping it. Requires mcp:write, stacks:delete, confirm: true, and the exact stack name.",
    scope: "stacks:delete",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string" },
        name: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["stackId", "name", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "service_action",
    description: "Start, stop, or restart one service. Requires mcp:write and stacks:deploy.",
    scope: "stacks:deploy",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string" },
        service: { type: "string" },
        action: { type: "string", enum: ["start", "stop", "restart"] },
      },
      required: ["stackId", "service", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "stack_exec",
    description: "Run a non-interactive command in a service container on the local host. Requires mcp:write and containers:exec.",
    scope: "containers:exec",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string" },
        service: { type: "string" },
        command: { type: "string", description: "Passed to sh -lc." },
      },
      required: ["stackId", "service", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "container_action",
    description: "Start, stop, restart, pause, unpause, or remove a local container. Requires mcp:write and containers:write.",
    scope: "containers:write",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string" },
        hostId: { type: "string", description: "Defaults to the local host." },
        action: { type: "string", enum: ["start", "stop", "restart", "pause", "unpause", "remove"] },
      },
      required: ["containerId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_update",
    description: "Run the configured health-gated auto-update for one stack. Requires mcp:write and updates:apply.",
    scope: "updates:apply",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: { stackId: { type: "string" } },
      required: ["stackId"],
      additionalProperties: false,
    },
  },
] as const;

function mcpStack(actor: Actor, stackId: unknown) {
  const row = getStackRow(String(stackId ?? ""));
  if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
  assertTarget(actor, row.hostId, row.id);
  return row;
}

function mcpLimit(value: unknown, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), 200));
}

async function executeMcpTool(actor: Actor, name: string, args: Record<string, any>) {
  const tool = mcpTools.find((entry) => entry.name === name);
  if (!tool) throw new ApiError(404, "mcp_tool_not_found", `Unknown tool: ${name}`);
  if (!actor.scopes.includes("mcp:read") && !actor.scopes.includes("mcp:write")) {
    throw new ApiError(403, "forbidden", "MCP key requires mcp:read or mcp:write.");
  }
  if (tool.mode === "write" && !actor.scopes.includes("mcp:write")) {
    throw new ApiError(403, "forbidden", "MCP key requires mcp:write for this tool.");
  }
  requireScope(actor, tool.scope);

  switch (name) {
    case "list_hosts":
      return filterHostsForActor(actor, await listHosts());
    case "list_stacks": {
      const stacks = filterStacksForActor(actor, await listStacks(args.hostId));
      return args.query
        ? stacks.filter((stack) => `${stack.name} ${stack.displayName}`.toLowerCase().includes(String(args.query).toLowerCase()))
        : stacks;
    }
    case "get_stack": {
      const detail = await getStackDetail(String(args.stackId));
      if (!detail) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, detail.hostId, detail.id);
      return redactStackDetail(actor, detail);
    }
    case "get_stack_logs": {
      const row = getStackRow(String(args.stackId));
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      const owner = getHostRow(row.hostId);
      if (owner?.kind === "worker") return requestWorkerLogs(row.hostId, row.name, Number(args.tail ?? 200), row.projectName);
      return composeLogs(row.dir, row.projectName, Number(args.tail ?? 200));
    }
    case "deploy_stack": {
      const row = getStackRow(String(args.stackId));
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      const profiles = Array.isArray(args.profiles) ? args.profiles.map(String) : [];
      return startComposeOperation({
        type: "deploy",
        stackId: row.id,
        args: stackOperationArgs("deploy", profiles).args,
        actor,
        deployed: true,
        auditAction: "mcp.deploy",
      });
    }
    case "stack_lifecycle": {
      const row = getStackRow(String(args.stackId));
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      const action = String(args.action);
      if (action === "down" && args.confirm !== true) {
        throw new ApiError(422, "confirm_required", "Pass confirm: true to stop and remove the stack.");
      }
      const spec = stackOperationArgs(action);
      return startComposeOperation({
        type: action as OperationType,
        stackId: row.id,
        args: spec.args,
        actor,
        deployed: spec.deployed,
        auditAction: `mcp.${action}`,
      });
    }
    case "get_host": {
      const hosts = filterHostsForActor(actor, await listHosts());
      const host = hosts.find((entry) => entry.id === String(args.hostId));
      if (!host) throw new ApiError(404, "host_not_found", "Host not found.");
      return host;
    }
    case "get_host_inventory": {
      const host = getHostRow(String(args.hostId));
      if (!host) throw new ApiError(404, "host_not_found", "Host not found.");
      assertTarget(actor, host.id, null);
      const inventory = await getHostInventory(host.id);
      if (!inventory) throw new ApiError(404, "inventory_unavailable", "Host inventory is not available.");
      return inventory;
    }
    case "list_containers": {
      const hosts = filterHostsForActor(actor, await listHosts())
        .filter((host) => !args.hostId || host.id === String(args.hostId));
      if (args.hostId && hosts.length === 0) throw new ApiError(404, "host_not_found", "Host not found.");
      const query = args.query ? String(args.query).toLowerCase() : "";
      const inventories = await Promise.all(hosts.map(async (host) => ({
        host,
        inventory: await getHostInventory(host.id),
      })));
      const restrictions = keyRestrictions(actor);
      return inventories.flatMap(({ host, inventory }) => (inventory?.containers ?? [])
        .filter((container) => actorCanTarget(actor, {
          hostId: host.id,
          stackId: container.project ? stackIdForProject(host.id, container.project) : null,
        }, restrictions))
        .filter((container) => !query || `${container.names} ${container.image} ${container.state} ${container.status}`.toLowerCase().includes(query))
        .map((container) => ({ ...container, hostId: host.id, hostName: host.name })));
    }
    case "get_container_logs": {
      const hostId = String(args.hostId ?? LOCAL_HOST_ID);
      const container = await findContainerOnHost(hostId, String(args.containerId));
      assertContainerTarget(actor, hostId, container.project);
      const tail = logTail(args.tail, 200);
      const timestamps = args.timestamps === true;
      if (hostId !== LOCAL_HOST_ID) {
        return requestWorkerContainerLogs(hostId, container.id, tail, timestamps);
      }
      const result = await docker([
        "logs",
        "--tail",
        String(tail),
        ...(timestamps ? ["--timestamps"] : []),
        container.id,
      ], { timeoutMs: 20_000 });
      return `${result.stdout}${result.stderr}`;
    }
    case "get_stack_compose": {
      const row = mcpStack(actor, args.stackId);
      const detail = await getStackDetail(row.id);
      if (!detail) throw new ApiError(404, "stack_not_found", "Stack not found.");
      const redacted = redactStackDetail(actor, detail);
      return {
        stackId: row.id,
        name: row.name,
        composeFile: row.composeFile,
        compose: redacted.compose,
        composeHash: redacted.composeHash,
        env: redacted.env,
        envHash: redacted.envHash,
        envRedacted: Boolean((redacted as typeof detail & { envRedacted?: boolean }).envRedacted),
        metadata: redacted.metadata,
        profiles: redacted.profiles,
        snapshots: redacted.snapshots,
      };
    }
    case "list_services": {
      const row = mcpStack(actor, args.stackId);
      const detail = await getStackDetail(row.id);
      if (!detail) throw new ApiError(404, "stack_not_found", "Stack not found.");
      return detail.services;
    }
    case "get_updates": {
      if (args.stackId) {
        const row = mcpStack(actor, args.stackId);
        return { stackId: row.id, stackName: row.name, updateCheck: readUpdateCheck(row.id) };
      }
      const stacks = filterStacksForActor(actor, await listStacks());
      return stacks.map((stack) => ({
        stackId: stack.id,
        stackName: stack.name,
        hostId: stack.hostId,
        updateCheck: readUpdateCheck(stack.id),
      }));
    }
    case "check_updates": {
      if (args.stackId) {
        const row = mcpStack(actor, args.stackId);
        return checkStackForUpdates(row);
      }
      const rows = filterStacksForActor(actor, await listStacks())
        .flatMap((stack) => {
          const row = getStackRow(stack.id);
          return row ? [row] : [];
        });
      const outcomes = await checkStacksForUpdates(rows);
      return outcomes.map((outcome) => ({
        stackId: outcome.stackId,
        stackName: outcome.stackName,
        available: outcome.result?.available ?? false,
        error: outcome.error ?? null,
      }));
    }
    case "get_activity": {
      const limit = mcpLimit(args.limit, 20);
      if (args.stackId) {
        const row = mcpStack(actor, args.stackId);
        return filterAuditForActor(actor, getRecentAudit(limit, row.id));
      }
      return filterAuditForActor(actor, getRecentAudit(limit));
    }
    case "list_operations": {
      const limit = mcpLimit(args.limit, 50);
      let operations = listOperations(limit);
      if (args.stackId) {
        const row = mcpStack(actor, args.stackId);
        operations = operations.filter((operation) => operation.stackId === row.id);
      }
      return operations.filter((operation) => actorCanTarget(
        actor,
        { hostId: operation.hostId, stackId: operation.stackId },
        keyRestrictions(actor),
      ));
    }
    case "create_stack": {
      assertTarget(actor, LOCAL_HOST_ID, null);
      const detail = await createStack(String(args.name), String(args.compose), actor.name);
      recordAudit({
        actor,
        action: "mcp.stack.create",
        resourceType: "stack",
        resourceId: detail.id,
        hostId: detail.hostId,
        stackId: detail.id,
        metadata: { name: detail.name },
      });
      return redactStackDetail(actor, detail);
    }
    case "edit_stack_compose": {
      const row = mcpStack(actor, args.stackId);
      if (getHostRow(row.hostId)?.kind === "worker") {
        throw new ApiError(501, "remote_edit_unsupported", "Remote compose editing is not supported yet.");
      }
      const metadata = args.metadata;
      if (metadata !== undefined) {
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
          throw new ApiError(422, "invalid_metadata", "Metadata must be a JSON object.");
        }
        validateStackMetadata(metadata as StackMetadata);
      }
      const detail = await saveStackFiles(row.id, {
        compose: args.compose === undefined ? undefined : String(args.compose),
        env: args.env === undefined ? undefined : String(args.env),
        metadata: metadata as StackMetadata | undefined,
        baseHash: args.baseHash === undefined ? undefined : String(args.baseHash),
      }, actor.name);
      recordAudit({
        actor,
        action: "mcp.stack.save",
        resourceType: "stack",
        resourceId: row.id,
        hostId: row.hostId,
        stackId: row.id,
        metadata: { file: row.composeFile },
      });
      return redactStackDetail(actor, detail);
    }
    case "delete_stack": {
      const row = mcpStack(actor, args.stackId);
      if (args.confirm !== true || String(args.name ?? "") !== row.name) {
        throw new ApiError(422, "confirm_required", "Pass confirm: true and the exact stack name to delete it.");
      }
      if (getHostRow(row.hostId)?.kind === "worker") {
        throw new ApiError(501, "remote_delete_unsupported", "Remote delete is not supported yet.");
      }
      return startDeleteOperation(row.id, actor);
    }
    case "service_action": {
      const row = mcpStack(actor, args.stackId);
      const service = String(args.service ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service)) {
        throw new ApiError(422, "invalid_service", "Service name is not valid.");
      }
      const action = String(args.action ?? "");
      const allowed: Record<string, { args: string[]; deployed: boolean }> = {
        start: { args: ["up", "-d", service], deployed: true },
        stop: { args: ["stop", service], deployed: false },
        restart: { args: ["restart", service], deployed: false },
      };
      const spec = allowed[action];
      if (!spec) throw new ApiError(400, "invalid_action", "Unsupported service action.");
      return startComposeOperation({
        type: action as OperationType,
        stackId: row.id,
        args: spec.args,
        actor,
        deployed: spec.deployed,
        auditAction: `mcp.service.${action}`,
      });
    }
    case "stack_exec": {
      const row = mcpStack(actor, args.stackId);
      if (getHostRow(row.hostId)?.kind === "worker") {
        throw new ApiError(501, "remote_exec_unsupported", "Remote stack exec is not supported yet.");
      }
      const service = String(args.service ?? "");
      const command = String(args.command ?? "");
      if (!service || !command) throw new ApiError(422, "invalid_exec", "Service and command are required.");
      const result = await docker([
        "compose",
        "-p",
        row.projectName,
        "exec",
        "-T",
        service,
        "sh",
        "-lc",
        command,
      ], { cwd: row.dir, timeoutMs: 60_000 });
      recordAudit({
        actor,
        action: "mcp.service.exec",
        resourceType: "stack",
        resourceId: row.id,
        hostId: row.hostId,
        stackId: row.id,
        metadata: { service, command: command.slice(0, 240) },
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    }
    case "container_action": {
      const hostId = String(args.hostId ?? LOCAL_HOST_ID);
      if (hostId !== LOCAL_HOST_ID) {
        throw new ApiError(501, "remote_container_unsupported", "Remote container actions are not supported yet.");
      }
      const containerId = dockerTarget(String(args.containerId ?? ""));
      const container = await findContainerOnHost(hostId, containerId);
      assertContainerTarget(actor, hostId, container.project);
      const action = String(args.action ?? "");
      const allowed = new Set(["start", "stop", "restart", "pause", "unpause", "remove"]);
      if (!allowed.has(action)) throw new ApiError(400, "invalid_action", "Unsupported container action.");
      const result = await docker(action === "remove" ? ["rm", "-f", container.id] : [action, container.id], { timeoutMs: 30_000 });
      recordAudit({
        actor,
        action: `mcp.container.${action}`,
        resourceType: "container",
        resourceId: container.id,
        hostId,
      });
      if (result.exitCode !== 0) throw new ApiError(500, "docker_error", result.stderr || "Docker action failed.");
      return { ok: true, output: `${result.stdout}${result.stderr}` };
    }
    case "apply_update": {
      const row = mcpStack(actor, args.stackId);
      try {
        return startAutoUpdateOperation(row.id, actor);
      } catch (error) {
        throw new ApiError(422, "auto_update_unavailable", error instanceof Error ? error.message : "Auto-update is not configured.");
      }
    }
    default:
      throw new ApiError(404, "mcp_tool_not_found", `Unknown tool: ${name}`);
  }
}

const workerConnections = new Map<string, string>();

function hashWorkerSecret(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function hashEnrollToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqualHex(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sendWorker(ws: any, payload: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // socket is already gone
  }
}

async function handleWorkerMessage(ws: any, raw: unknown) {
  let message: any;
  try {
    if (typeof raw === "string") {
      message = JSON.parse(raw);
    } else if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
      message = JSON.parse(new TextDecoder().decode(raw));
    } else {
      message = raw;
    }
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;
  console.log("[cetus] worker message", message.type);

  if (message.type === "hello") {
    const info = message.info ?? {};
    let hostId: string | null = null;
    let hostName = String(message.name ?? "worker");
    let newSecret: string | null = null;

    if (message.token) {
      const settingKey = `worker-enroll:${hashEnrollToken(String(message.token))}`;
      const tokenRow = db.select().from(schema.setting).where(eq(schema.setting.key, settingKey)).get();
      if (!tokenRow) {
        sendWorker(ws, { type: "error", message: "Invalid or already used enrollment token." });
        return;
      }
      let parsed: { name?: string; expiresAt?: number } = {};
      try { parsed = JSON.parse(tokenRow.value); } catch { parsed = {}; }
      if (!parsed.expiresAt || parsed.expiresAt < Date.now()) {
        db.delete(schema.setting).where(eq(schema.setting.key, settingKey)).run();
        sendWorker(ws, { type: "error", message: "Enrollment token expired." });
        return;
      }
      hostName = String(parsed.name ?? hostName);
      hostId = `host-${crypto.randomUUID()}`;
      newSecret = crypto.randomBytes(32).toString("base64url");
      const slugBase = hostName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "worker";
      const slug = `${slugBase}-${crypto.randomBytes(2).toString("hex")}`;
      const now = new Date();
      db.insert(schema.host).values({
        id: hostId,
        name: hostName,
        slug,
        kind: "worker",
        status: "online",
        dockerVersion: info.dockerVersion ?? null,
        os: info.os ?? null,
        arch: info.arch ?? null,
        cpus: info.cpus ?? null,
        memory: info.memory ?? null,
        info: JSON.stringify(info),
        labels: "{}",
        lastSeenAt: now,
        createdAt: now,
      }).run();
      db.insert(schema.hostCredential).values({
        hostId,
        secretHash: hashWorkerSecret(newSecret),
        createdAt: now,
      }).run();
      db.delete(schema.setting).where(eq(schema.setting.key, settingKey)).run();
    } else if (message.hostId && message.secret) {
      const hostRow = getHostRow(String(message.hostId));
      const credential = db.select().from(schema.hostCredential).where(eq(schema.hostCredential.hostId, String(message.hostId))).get();
      if (!hostRow || !credential || credential.revokedAt || !safeEqualHex(credential.secretHash, hashWorkerSecret(String(message.secret)))) {
        sendWorker(ws, { type: "error", message: "Worker credential rejected." });
        return;
      }
      hostId = hostRow.id;
      hostName = hostRow.name;
      db.update(schema.host).set({
        status: "online",
        lastSeenAt: new Date(),
        dockerVersion: info.dockerVersion ?? hostRow.dockerVersion,
        os: info.os ?? hostRow.os,
        arch: info.arch ?? hostRow.arch,
        cpus: info.cpus ?? hostRow.cpus,
        memory: info.memory ?? hostRow.memory,
        info: JSON.stringify(info),
      }).where(eq(schema.host.id, hostId)).run();
    }

    if (!hostId) {
      sendWorker(ws, { type: "error", message: "Enrollment token or worker credential required." });
      return;
    }

    workerConnections.set(ws.id, hostId);
    removePendingWorker(ws.id);
    registerWorker({
      hostId,
      name: hostName,
      info,
      stacks: [],
      inventory: null,
      lastSeen: Date.now(),
      ws,
    });
    sendWorker(ws, {
      type: "enrolled",
      hostId,
      name: hostName,
      secret: newSecret,
      resumed: !newSecret,
      managerVersion: config.version,
    });
    return;
  }

  const hostId = workerConnections.get(ws.id);
  if (!hostId) return;
  const hostRow = getHostRow(hostId);
  if (!hostRow) return;

  if (message.type === "snapshot") {
    const info = message.info ?? message.host?.info ?? {};
    const stacks = Array.isArray(message.stacks) ? message.stacks : [];
    db.update(schema.host).set({
      status: "online",
      lastSeenAt: new Date(),
      dockerVersion: info.dockerVersion ?? hostRow.dockerVersion,
      os: info.os ?? hostRow.os,
      arch: info.arch ?? hostRow.arch,
      cpus: info.cpus ?? hostRow.cpus,
      memory: info.memory ?? hostRow.memory,
      info: JSON.stringify(info),
    }).where(eq(schema.host.id, hostId)).run();
    syncRemoteStacks(hostId, stacks);
    registerWorker({
      hostId,
      name: hostRow.name,
      info,
      stacks,
      inventory: message.inventory ?? null,
      lastSeen: Date.now(),
      ws,
    });
    return;
  }

  if (message.type === "heartbeat") {
    db.update(schema.host).set({ status: "online", lastSeenAt: new Date() }).where(eq(schema.host.id, hostId)).run();
    return;
  }

  if (message.type === "operation.output") {
    const operation = getOperation(String(message.operationId));
    if (operation?.hostId !== hostId) return;
    appendOutput(String(message.operationId), String(message.text ?? ""));
    return;
  }

  if (message.type === "operation.finished") {
    const operation = getOperation(String(message.operationId));
    if (operation?.hostId !== hostId) return;
    const status = message.status === "success" ? "success" : "failed";
    finishOperation(String(message.operationId), status, typeof message.exitCode === "number" ? message.exitCode : null);
    if (operation?.stackId) {
      const autoState = readAutoUpdateState(operation.stackId);
      if (autoState.lastOperationId === operation.id) {
        const autoStatus = typeof message.autoUpdateStatus === "string" ? message.autoUpdateStatus : status;
        recordAutoUpdateRun(operation.stackId, autoStatus, operation.id);
        const row = getStackRow(operation.stackId);
        if (row) {
          refreshAutoUpdateNext(row.id, readMetadata(row));
          if (autoStatus === "success") {
            markAutoUpdateApplied(row.id, readMetadata(row).autoUpdate?.services);
          }
        }
      }
      await refreshStackAfterOperation(operation.stackId, Boolean(message.deployed));
    }
    return;
  }

  if (message.type === "logs.response") {
    if (message.error) {
      rejectLogResponse(String(message.requestId), String(message.error));
    } else {
      resolveLogResponse(String(message.requestId), String(message.text ?? ""));
    }
    return;
  }

  if (message.type === "container.logs.chunk") {
    pushRemoteLogChunk(String(message.requestId), String(message.text ?? ""));
    return;
  }

  if (message.type === "container.logs.end") {
    endRemoteLogStream(String(message.requestId));
    return;
  }

  if (message.type === "container.logs.error") {
    failRemoteLogStream(String(message.requestId), String(message.error ?? "Container log stream failed."));
    return;
  }

  if (message.type === "metadata.written") {
    resolveMetadataWrite(String(message.requestId), message.error ? String(message.error) : null);
    return;
  }

  if (message.type === "update-check.result") {
    resolveUpdateCheck(
      String(message.requestId),
      Array.isArray(message.results) ? message.results : null,
      message.error ? String(message.error) : null,
    );
    return;
  }

  if (message.type === "snapshot.request") {
    sendWorker(ws, { type: "snapshot.request" });
  }
}

async function handleWorkerClose(ws: any) {
  removePendingWorker(ws.id);
  const hostId = workerConnections.get(ws.id);
  if (!hostId) return;
  workerConnections.delete(ws.id);
  if ([...workerConnections.values()].includes(hostId)) return;
  unregisterWorker(hostId);
  failRemoteLogStreamsForHost(hostId, "Worker disconnected before the log stream finished.");
  db.update(schema.host).set({ status: "offline", lastSeenAt: new Date() }).where(eq(schema.host.id, hostId)).run();
}

async function handleMcp(request: Request) {
  const actor = await getActor(request);
  if (!actor) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, { status: 401 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }

  const id = body?.id ?? null;
  const method = body?.method;
  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

  if (body?.jsonrpc !== "2.0" || typeof method !== "string") {
    return fail(-32600, "Invalid Request: jsonrpc must be \"2.0\" and method must be a string.");
  }

  try {
    if (method === "initialize") {
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cetus", version: config.version },
        instructions: "Compose-native fleet control. Use scoped API keys. Destructive actions require explicit confirmation.",
      });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return new Response(null, { status: 202 });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") {
      if (!actor.scopes.includes("mcp:read") && !actor.scopes.includes("mcp:write") && !actor.scopes.includes("*")) {
        return fail(-32001, "MCP key requires mcp:read or mcp:write.");
      }
      return reply({
        tools: mcpTools
          .filter((tool) => actor.scopes.includes(tool.scope) || actor.scopes.includes("*"))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
      });
    }
    if (method === "tools/call") {
      const name = String(body?.params?.name ?? "");
      const args = (body?.params?.arguments ?? {}) as Record<string, any>;
      const result = await executeMcpTool(actor, name, args);
      recordAudit({
        actor,
        action: "mcp.tool",
        resourceType: "mcp",
        resourceId: name,
        metadata: { tool: name, args },
      });
      return reply({
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        structuredContent: { result },
      });
    }
    return fail(-32601, `Method not found: ${method}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (method === "tools/call") {
      recordAudit({
        actor,
        action: "mcp.tool",
        resourceType: "mcp",
        resourceId: String(body?.params?.name ?? ""),
        metadata: { tool: body?.params?.name, args: body?.params?.arguments, error: message },
      });
      return reply({ content: [{ type: "text", text: message }], isError: true });
    }
    if (error instanceof ApiError) return fail(-32000, error.message);
    console.error(error);
    return fail(-32603, message);
  }
}

export async function createApp() {
  await seedAdminFromEnvironment();
  await syncStacks();
  await getHostInventory(LOCAL_HOST_ID);

  if (getRecentAudit(1).length === 0) {
    const systemActor: Actor = { type: "user", id: "system", name: "system", role: "admin", scopes: ["*"] };
    recordAudit({ actor: systemActor, action: "instance.ready", resourceType: "instance", metadata: { version: config.version } });
  }

  setInterval(() => {
    const cutoff = new Date(Date.now() - 90_000);
    db.update(schema.host)
      .set({ status: "offline" })
      .where(and(eq(schema.host.kind, "worker"), eq(schema.host.status, "online"), lt(schema.host.lastSeenAt, cutoff)))
      .run();
  }, 30_000);

  recoverInterruptedBackups();
  startAutoUpdateScheduler();
  startUpdateCheckScheduler();
  startBackupScheduler();
  startRetentionScheduler();

  const loginAttempts = new Map<string, number[]>();
  const app = new Elysia({ name: "cetus" })
    .onError(({ error }) => jsonError(error))
    .onRequest(({ request, set, server }) => {
      const url = new URL(request.url);
      const isApi = url.pathname.startsWith("/api/") || url.pathname === "/mcp";
      if (isApi && request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        const origin = request.headers.get("origin");
        const sameOriginBootstrap = config.allowSameOriginBootstrap && origin === url.origin;
        if (origin && !trustedOrigins.includes(origin) && !sameOriginBootstrap) {
          set.status = 403;
          return Response.json({ error: { code: "origin_forbidden", message: "Request origin is not allowed." } }, { status: 403 });
        }
      }
      if (url.pathname === "/api/auth/sign-in/email" && request.method === "POST") {
        const address = getClientIp(request) ?? server?.requestIP(request)?.address ?? "local";
        const now = Date.now();
        const recent = (loginAttempts.get(address) ?? []).filter((at) => now - at < 60_000);
        if (recent.length >= 20) {
          set.status = 429;
          return Response.json({ error: { code: "rate_limited", message: "Too many sign-in attempts. Try again in a minute." } }, { status: 429 });
        }
        recent.push(now);
        loginAttempts.set(address, recent);
      }
    })
    .onAfterHandle(({ set }) => {
      set.headers["x-content-type-options"] = "nosniff";
      set.headers["x-frame-options"] = "DENY";
      set.headers["referrer-policy"] = "same-origin";
      set.headers["permissions-policy"] = "camera=(), microphone=(), geolocation=()";
      if (config.isProduction) {
        set.headers["content-security-policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
        if (config.publicUrl.startsWith("https://")) {
          set.headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
        }
      }
    })
    .use(openapi({
      provider: null,
      path: "/api/docs",
      specPath: "/api/openapi.json",
      documentation: {
        info: {
          title: "Cetus API",
          version: config.version,
          description: "Scoped REST API for a Cetus manager. Browser requests use the better-auth session cookie. Scripts and AI clients use an API key as `Authorization: Bearer cetus_<prefix>.<secret>`. Public routes are health, auth config, better-auth routes, and invite validation and acceptance.",
        },
        servers: [{ url: config.publicUrl, description: "This manager" }],
        tags: [
          { name: "Health", description: "Public liveness and auth capability" },
          { name: "Hosts", description: "Docker hosts and inventory" },
          { name: "Stacks", description: "Compose stacks, files, snapshots, and operations" },
          { name: "Logs", description: "Container and stack logs" },
          { name: "Operations", description: "Long-running actions" },
          { name: "Access", description: "Users, invites, and API keys" },
          { name: "Settings", description: "Instance settings, OIDC, SMTP, and notifications" },
          { name: "Audit", description: "Audit and activity history" },
          { name: "Backups", description: "Local backup, download, and restore" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              description: "Cetus API key. The key must carry the scopes for the route.",
            },
          },
        },
      },
      exclude: {
        paths: ["/api/docs", "/api/docs/client.js"],
      },
    }))
    .get("/api/health", () => ({
      ok: true,
      version: config.version,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      database: "ok",
      stacksDir: config.stacksDir,
    }))
    .get("/api/docs", () => new Response(apiDocsHtml(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }))
    .get("/api/docs/client.js", () => new Response(apiDocsClient(), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    }))
    .get("/api/auth-config", () => ({
      password: true,
      oidc: config.oidcActive
        ? { providerId: "oidc", name: config.oidc.name }
        : null,
    }))
    .get("/api/me", async ({ request }) => {
      const actor = await getActor(request);
      if (!actor) throw new ApiError(401, "unauthorized", "Sign in to continue.");
      const user = await getSessionUser(request);
      return {
        actor,
        user,
        version: config.version,
        publicUrl: config.publicUrl,
        stacksDir: config.stacksDir,
        defaultPalette: config.defaultPalette,
        preferences: { palette: user ? getUserPalette(user.id) : null },
      };
    })
    .put("/api/preferences", async ({ request, body }) => {
      const user = await getSessionUser(request);
      if (!user) throw new ApiError(401, "unauthorized", "Sign in to change your palette.");
      const palette = body.palette === null ? null : body.palette;
      if (palette !== null && !isPaletteId(palette)) {
        throw new ApiError(422, "invalid_palette", "Unknown palette.");
      }
      setUserPalette(user.id, palette);
      const actor = await getActor(request);
      if (actor) {
        recordAudit({
          actor,
          action: "preferences.palette",
          resourceType: "user",
          resourceId: user.id,
          metadata: { palette: palette ?? "default" },
          request,
        });
      }
      return {
        preference: palette,
        palette: palette ?? config.defaultPalette,
        defaultPalette: config.defaultPalette,
      };
    }, {
      body: t.Object({ palette: t.Union([t.String(), t.Null()]) }),
    })
    .get("/api/dashboard", async ({ request }) => {
      const actor = await actorForScope(request, "stacks:read");
      const [allHosts, allStacks] = await Promise.all([listHosts(), listStacks()]);
      const hosts = filterHostsForActor(actor, allHosts);
      const stacks = filterStacksForActor(actor, allStacks);
      const containers = hosts.reduce((sum, host) => sum + host.containerCount, 0);
      const activity = hasScope(actor.scopes, "audit:read")
        ? filterAuditForActor(actor, getRecentAudit(12))
        : [];
      const checks = listUpdateChecks();
      const updates: {
        stackId: string;
        stackName: string;
        hostName: string;
        image: string;
        currentDigest: string;
        latestDigest: string;
        service: string;
        checkedAt: string;
      }[] = [];
      for (const stack of stacks) {
        const check = checks.get(stack.id);
        if (!check?.available) continue;
        for (const service of check.services) {
          if (!service.updateAvailable) continue;
          updates.push({
            stackId: stack.id,
            stackName: stack.displayName,
            hostName: stack.hostName,
            image: service.image,
            currentDigest: service.currentDigest ?? "",
            latestDigest: service.latestDigest ?? "",
            service: service.service,
            checkedAt: check.checkedAt,
          });
        }
      }
      updates.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
      const updatesFailed = stacks.reduce((sum, stack) => {
        const check = checks.get(stack.id);
        return sum + (check?.services.filter((service) => service.error).length ?? 0);
      }, 0);
      return {
        totals: {
          hosts: hosts.length,
          hostsOnline: hosts.filter((host) => host.status === "online").length,
          stacks: stacks.length,
          running: stacks.filter((stack) => stack.status === "running").length,
          unhealthy: stacks.filter((stack) => stack.status === "partial" || stack.status === "error").length,
          containers,
          updates: updates.length,
        },
        hosts,
        recentStacks: stacks.slice(0, 6),
        activity,
        updates,
        updatesCheckedAt: updates[0]?.checkedAt ?? [...checks.values()].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0]?.checkedAt ?? null,
        updatesFailed,
        actor,
      };
    })
    .get("/api/hosts", async ({ request }) => {
      const actor = await actorForScope(request, "hosts:read");
      return filterHostsForActor(actor, await listHosts());
    })
    .post("/api/hosts/enroll", async ({ request, body }) => {
      const actor = await actorForScope(request, "hosts:enroll");
      const token = crypto.randomBytes(18).toString("base64url");
      const expiresAt = Date.now() + 15 * 60 * 1000;
      const key = `worker-enroll:${hashEnrollToken(token)}`;
      const value = JSON.stringify({ name: body.name, expiresAt });
      const now = new Date();
      db.insert(schema.setting).values({ key, value, updatedAt: now }).onConflictDoUpdate({
        target: schema.setting.key,
        set: { value, updatedAt: now },
      }).run();
      const wsBase = config.publicUrl.replace(/^http/, "ws").replace(/\/$/, "");
      const managerUrl = `${wsBase}/api/ws/worker`;
      recordAudit({
        actor,
        action: "host.enroll",
        resourceType: "host",
        metadata: { name: body.name, expiresAt },
        request,
      });
      return { token, managerUrl, expiresAt: new Date(expiresAt).toISOString() };
    }, {
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }) }),
    })
    .get("/api/hosts/:id", async ({ request, params }) => {
      const actor = await actorForScope(request, "hosts:read");
      assertTarget(actor, params.id, null);
      const host = await getHostSummary(params.id);
      if (!host) throw new ApiError(404, "host_not_found", "Host not found.");
      return host;
    })
    .get("/api/hosts/:id/inventory", async ({ request, params }) => {
      const actor = await actorForScope(request, "hosts:read");
      assertTarget(actor, params.id, null);
      const inventory = await getHostInventory(params.id);
      if (!inventory) throw new ApiError(404, "host_not_found", "Host not found.");
      return inventory;
    })
    .get("/api/stacks", async ({ request, query }) => {
      const actor = await actorForScope(request, "stacks:read");
      let stacks = await listStacks(query.hostId ? String(query.hostId) : undefined);
      if (query.q) {
        const q = String(query.q).toLowerCase();
        stacks = stacks.filter((stack) => `${stack.name} ${stack.displayName} ${stack.tags.join(" ")}`.toLowerCase().includes(q));
      }
      if (query.status) stacks = stacks.filter((stack) => stack.status === String(query.status));
      if (actor.type === "key") {
        const restrictions = keyRestrictions(actor);
        if (restrictions.stackIds.length > 0) stacks = stacks.filter((stack) => restrictions.stackIds.includes(stack.id));
        if (restrictions.hostIds.length > 0) stacks = stacks.filter((stack) => restrictions.hostIds.includes(stack.hostId));
      }
      return stacks;
    })
    .post("/api/stacks", async ({ request, body }) => {
      const actor = await actorForScope(request, "stacks:write");
      const stack = await createStack(body.name, body.compose, actor.name);
      recordAudit({ actor, action: "stack.create", resourceType: "stack", resourceId: stack.id, hostId: stack.hostId, stackId: stack.id, metadata: { name: stack.name }, request });
      return stack;
    }, {
      body: t.Object({ name: t.String(), compose: t.String() }),
    })
    .post("/api/stacks/scan", async ({ request }) => {
      const actor = await actorForScope(request, "stacks:write");
      const count = await syncStacks();
      recordAudit({ actor, action: "stack.scan", resourceType: "instance", metadata: { count }, request });
      return { ok: true, count };
    })
    .get("/api/stacks/:id", async ({ request, params }) => {
      const actor = await actorForScope(request, "stacks:read");
      const detail = await getStackDetail(params.id);
      if (!detail) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, detail.hostId, detail.id);
      return redactStackDetail(actor, detail);
    })
    .put("/api/stacks/:id/compose", async ({ request, params, body }) => {
      const actor = await actorForScope(request, "stacks:write");
      const existing = getStackRow(params.id);
      if (!existing) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, existing.hostId, existing.id);
      const detail = await saveStackFiles(params.id, {
        compose: body.compose,
        env: body.env,
        metadata: body.metadata as any,
        baseHash: body.baseHash,
      }, actor.name);
      recordAudit({ actor, action: "stack.save", resourceType: "stack", resourceId: params.id, hostId: existing.hostId, stackId: params.id, metadata: { file: existing.composeFile }, request });
      return detail;
    }, {
      body: t.Object({
        compose: t.Optional(t.String()),
        env: t.Optional(t.String()),
        metadata: t.Optional(t.Any()),
        baseHash: t.Optional(t.String()),
      }),
    })
    .put("/api/stacks/:id/metadata", async ({ request, params, body }) => {
      const actor = await actorForScope(request, "stacks:write");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
        throw new ApiError(422, "invalid_metadata", "Metadata must be a JSON object.");
      }
      const metadata = body.metadata as StackMetadata;
      validateStackMetadata(metadata);
      const owner = getHostRow(row.hostId);
      if (owner?.kind === "worker") {
        await requestWorkerMetadataWrite(row.hostId, row.name, metadata as Record<string, unknown>);
        updateRemoteStackMetadata(row.hostId, row.name, metadata);
        db.update(schema.stack).set({
          metadata: JSON.stringify(metadata),
          displayName: metadata.displayName ?? row.displayName,
          description: metadata.description ?? row.description,
          tags: JSON.stringify(metadata.tags ?? []),
          updatedAt: new Date(),
        }).where(eq(schema.stack.id, row.id)).run();
        refreshAutoUpdateNext(row.id, metadata);
        recordAudit({ actor, action: "stack.metadata", resourceType: "stack", resourceId: row.id, hostId: row.hostId, stackId: row.id, request });
        return await getStackDetail(row.id);
      }
      const detail = await saveStackFiles(row.id, { metadata }, actor.name);
      recordAudit({ actor, action: "stack.metadata", resourceType: "stack", resourceId: row.id, hostId: row.hostId, stackId: row.id, request });
      return detail;
    }, {
      body: t.Object({ metadata: t.Any() }),
    })
    .post("/api/stacks/:id/updates/check", async ({ request, params }) => {
      const actor = await actorForScope(request, "stacks:read");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      try {
        const result = await checkStackForUpdates(row);
        recordAudit({
          actor,
          action: "stack.update-check",
          resourceType: "stack",
          resourceId: row.id,
          hostId: row.hostId,
          stackId: row.id,
          metadata: {
            available: result.available,
            services: result.services.filter((service) => service.updateAvailable).map((service) => service.service),
          },
          request,
        });
        return result;
      } catch (error) {
        throw new ApiError(502, "update_check_failed", error instanceof Error ? error.message : "Update check failed.");
      }
    })
    .post("/api/updates/check", async ({ request }) => {
      const actor = await actorForScope(request, "stacks:read");
      const visible = filterStacksForActor(actor, await listStacks());
      const rows = visible.flatMap((stack) => {
        const row = getStackRow(stack.id);
        return row ? [row] : [];
      });
      const outcomes = await checkStacksForUpdates(rows);
      const checked = outcomes.filter((outcome) => outcome.result).length;
      const available = outcomes.filter((outcome) => outcome.result?.available).length;
      const unchecked = outcomes.reduce(
        (sum, outcome) => sum + (outcome.result?.services.filter((service) => service.error).length ?? 0),
        0,
      );
      recordAudit({
        actor,
        action: "updates.check",
        resourceType: "instance",
        metadata: { stacks: rows.length, checked, failed: outcomes.length - checked, available },
        request,
      });
      return {
        checked,
        failed: outcomes.length - checked,
        unchecked,
        updates: available,
        checkedAt: new Date().toISOString(),
        results: outcomes.map((outcome) => ({
          stackId: outcome.stackId,
          stackName: outcome.stackName,
          available: outcome.result?.available ?? false,
          checkedAt: outcome.result?.checkedAt ?? null,
          error: outcome.error ?? null,
        })),
      };
    })
    .post("/api/stacks/:id/auto-update/run", async ({ request, params }) => {
      const actor = await actorForScope(request, "stacks:deploy");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      try {
        return startAutoUpdateOperation(row.id, actor, request);
      } catch (error) {
        throw new ApiError(422, "auto_update_unavailable", error instanceof Error ? error.message : "Auto-update is not configured.");
      }
    })
    .post("/api/stacks/:id/validate", async ({ request, params, body }) => {
      await actorForScope(request, "stacks:read");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      return validateComposeText(body.compose);
    }, { body: t.Object({ compose: t.String() }) })
    .post("/api/stacks/:id/actions/:action", async ({ request, params, body }) => {
      const actor = await actorForScope(request, params.action === "delete" ? "stacks:delete" : "stacks:deploy");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      if (params.action === "delete") {
        if (body.confirmName !== row.name) {
          throw new ApiError(422, "confirm_required", "Type the stack name to confirm deletion.");
        }
        return startDeleteOperation(row.id, actor, request);
      }
      const spec = stackOperationArgs(params.action, body.profiles ?? []);
      return startComposeOperation({
        type: params.action as OperationType,
        stackId: row.id,
        args: spec.args,
        argsAfter: spec.argsAfter,
        actor,
        deployed: spec.deployed,
        request,
      });
    }, {
      body: t.Object({
        profiles: t.Optional(t.Array(t.String())),
        confirmName: t.Optional(t.String()),
      }),
    })
    .post("/api/stacks/:id/services/:service/actions/:action", async ({ request, params }) => {
      const actor = await actorForScope(request, "stacks:deploy");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      const service = params.service;
      const action = params.action;
      const allowed: Record<string, string[]> = {
        start: ["up", "-d", service],
        stop: ["stop", service],
        restart: ["restart", service],
      };
      const args = allowed[action];
      if (!args) throw new ApiError(400, "invalid_action", "Unsupported service action.");
      return startComposeOperation({
        type: action as OperationType,
        stackId: row.id,
        args,
        actor,
        deployed: action === "start",
        auditAction: `service.${action}`,
        request,
      });
    })
    .post("/api/stacks/:id/exec", async ({ request, params, body }) => {
      const actor = await actorForScope(request, "containers:exec");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      const owner = getHostRow(row.hostId);
      if (owner?.kind === "worker") {
        throw new ApiError(501, "remote_exec_unsupported", "Remote stack exec is not supported yet.");
      }
      const result = await docker([
        "compose",
        "-p",
        row.projectName,
        "exec",
        "-T",
        body.service,
        "sh",
        "-lc",
        body.command,
      ], { cwd: row.dir, timeoutMs: 60_000 });
      recordAudit({
        actor,
        action: "service.exec",
        resourceType: "stack",
        resourceId: row.id,
        hostId: row.hostId,
        stackId: row.id,
        metadata: { service: body.service, command: body.command.slice(0, 240) },
        request,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    }, {
      body: t.Object({
        service: t.String(),
        command: t.String({ minLength: 1, maxLength: 4_000 }),
      }),
    })
    .get("/api/stacks/:id/logs", async ({ request, params, query }) => {
      const actor = await actorForScope(request, "logs:read");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      const owner = getHostRow(row.hostId);
      const tail = logTail(query.tail, 200);
      const timestamps = query.timestamps === "1" || query.timestamps === "true";
      if (owner?.kind === "worker") return requestWorkerLogs(row.hostId, row.name, tail, row.projectName, timestamps);
      return composeLogs(row.dir, row.projectName, tail, timestamps);
    })
    .get("/api/stacks/:id/logs/stream", async ({ request, params, query }) => {
      const actor = await actorForScope(request, "logs:read");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      const tail = Math.max(0, Math.min(Number(query.tail ?? 200), 5_000));
      const timestamps = query.timestamps === "1" || query.timestamps === "true";
      const owner = getHostRow(row.hostId);
      if (owner?.kind === "worker") {
        try {
          const text = await requestWorkerLogs(row.hostId, row.name, tail, row.projectName, timestamps);
          return new Response(text, {
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" },
          });
        } catch (error) {
          throw new ApiError(503, "worker_logs_unavailable", error instanceof Error ? error.message : "Worker did not return logs.");
        }
      }
      const proc = Bun.spawn(["docker", "compose", "-p", row.projectName, "logs", "-f", "--tail", String(tail), "--no-color", ...(timestamps ? ["--timestamps"] : [])], {
        cwd: row.dir,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      request.signal.addEventListener("abort", () => proc.kill());
      const encoder = new TextEncoder();
      let atLineBoundary = true;
      let stopHeartbeat: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          stopHeartbeat = keepLogStreamAlive(
            (chunk) => controller.enqueue(chunk),
            encoder,
            () => atLineBoundary,
          );
          const pump = async (source: ReadableStream<Uint8Array>) => {
            const reader = source.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value?.length) {
                atLineBoundary = value[value.length - 1] === 0x0a;
                controller.enqueue(value);
              }
            }
          };
          try {
            await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
            controller.close();
          } catch {
            try { controller.close(); } catch { /* already closed */ }
          } finally {
            stopHeartbeat?.();
          }
        },
        cancel() {
          stopHeartbeat?.();
          proc.kill();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      });
    })
    .get("/api/stacks/:id/snapshots", async ({ request, params }) => {
      const actor = await actorForScope(request, "stacks:read");
      const detail = await getStackDetail(params.id);
      if (!detail) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, detail.hostId, detail.id);
      return detail.snapshots;
    })
    .post("/api/stacks/:id/snapshots/:file/restore", async ({ request, params }) => {
      const actor = await actorForScope(request, "stacks:write");
      const row = getStackRow(params.id);
      if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
      assertTarget(actor, row.hostId, row.id);
      const owner = getHostRow(row.hostId);
      if (owner?.kind === "worker") {
        throw new ApiError(501, "remote_edit_unsupported", "Remote snapshot restore is not supported yet.");
      }
      const detail = await restoreSnapshot(params.id, params.file, actor.name);
      recordAudit({ actor, action: "stack.restore", resourceType: "stack", resourceId: params.id, hostId: row.hostId, stackId: params.id, metadata: { file: params.file }, request });
      return detail;
    })
    .get("/api/operations", async ({ request }) => {
      const actor = await actorForScope(request, "stacks:read");
      const operations = listOperations(60);
      if (actor.type !== "key") return operations;
      const restrictions = keyRestrictions(actor);
      return operations.filter((operation) => {
        if (restrictions.stackIds.length > 0 && operation.stackId && !restrictions.stackIds.includes(operation.stackId)) return false;
        if (restrictions.hostIds.length > 0 && operation.hostId && !restrictions.hostIds.includes(operation.hostId)) return false;
        return true;
      });
    })
    .get("/api/operations/:id", async ({ request, params }) => {
      const actor = await actorForScope(request, "stacks:read");
      const operation = getOperation(params.id);
      if (!operation) throw new ApiError(404, "operation_not_found", "Operation not found.");
      assertTarget(actor, operation.hostId, operation.stackId);
      return operation;
    })
    .get("/api/audit", async ({ request, query }) => {
      const actor = await actorForScope(request, "audit:read");
      const limit = Math.min(Number(query.limit ?? 100), 500);
      const entries = getRecentAudit(limit, query.stackId ? String(query.stackId) : undefined);
      return filterAuditForActor(actor, entries);
    })
    .get("/api/backups", async ({ request }) => {
      const actor = await actorForScope(request, "backup:read");
      assertInstanceTarget(actor);
      return listBackups();
    })
    .post("/api/backups", async ({ request }) => {
      const actor = await actorForScope(request, "backup:write");
      assertInstanceTarget(actor);
      const backup = await createBackup({ actorName: actor.name, reason: "manual" });
      recordAudit({
        actor,
        action: "backup.create",
        resourceType: "backup",
        resourceId: backup.id,
        metadata: { filename: backup.filename, size: backup.size },
        request,
      });
      return backup;
    })
    .get("/api/backups/:id/download", async ({ request, params }) => {
      const actor = await actorForScope(request, "backup:read");
      assertInstanceTarget(actor);
      const backup = getBackup(params.id);
      if (!backup) throw new ApiError(404, "backup_not_found", "Backup not found.");
      if (backup.status !== "complete") throw new ApiError(422, "backup_incomplete", "Only a complete backup can be downloaded.");
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(["tar", "-czf", "-", "-C", config.backupDir, backup.filename], {
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        throw new ApiError(500, "backup_archive_failed", error instanceof Error ? error.message : "Could not create the backup archive.");
      }
      recordAudit({
        actor,
        action: "backup.download",
        resourceType: "backup",
        resourceId: backup.id,
        metadata: { filename: backup.filename },
        request,
      });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value?.length) controller.enqueue(value);
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() {
          try { proc.kill(); } catch { /* already gone */ }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${backup.filename}.tar.gz"`,
          "cache-control": "no-store",
        },
      });
    })
    .post("/api/backups/:id/restore", async ({ request, params, body }) => {
      const actor = await actorForScope(request, "backup:write");
      assertInstanceTarget(actor);
      if (body.confirm !== true) {
        throw new ApiError(422, "confirm_required", "Pass confirm: true to stage this restore.");
      }
      const running = db.select().from(schema.operation)
        .where(eq(schema.operation.status, "running"))
        .get();
      if (running) throw new ApiError(409, "operation_running", "Wait for the running operation to finish before restoring.");
      const marker = stageRestore(params.id);
      recordAudit({
        actor,
        action: "backup.restore",
        resourceType: "backup",
        resourceId: params.id,
        metadata: { restartRequired: true },
        request,
      });
      return {
        ok: true,
        backupId: marker.backupId,
        restartRequired: true,
        message: "Restore staged. Restart the manager to replace the database, keys, and stack files.",
      };
    }, {
      body: t.Object({ confirm: t.Boolean() }),
    })
    .delete("/api/backups/:id", async ({ request, params, query }) => {
      const actor = await actorForScope(request, "backup:write");
      assertInstanceTarget(actor);
      if (query.confirm !== "true") {
        throw new ApiError(422, "confirm_required", "Pass ?confirm=true to delete this backup.");
      }
      deleteBackup(params.id);
      recordAudit({
        actor,
        action: "backup.delete",
        resourceType: "backup",
        resourceId: params.id,
        request,
      });
      return { ok: true };
    })
    .get("/api/audit/export", async ({ request, query }) => {
      const actor = await actorForScope(request, "audit:export");
      const limit = Math.min(Math.max(Number(query.limit ?? 5_000) || 5_000, 1), 20_000);
      const entries = filterAuditForActor(actor, getRecentAudit(limit, query.stackId ? String(query.stackId) : undefined));
      const format = query.format === "json" ? "json" : "csv";
      recordAudit({
        actor,
        action: "audit.export",
        resourceType: "audit",
        metadata: { format, count: entries.length, limit },
        request,
      });
      if (format === "json") {
        return new Response(JSON.stringify(entries, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": "attachment; filename=\"cetus-audit.json\"",
            "cache-control": "no-store",
          },
        });
      }
      const header = ["createdAt", "actorType", "actorName", "action", "resourceType", "resourceId", "hostId", "stackId", "ip", "metadata"];
      const rows = entries.map((entry) => [
        entry.createdAt,
        entry.actorType,
        entry.actorName,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.hostId,
        entry.stackId,
        entry.ip,
        entry.metadata ? JSON.stringify(entry.metadata) : "",
      ].map(csvCell).join(","));
      return new Response(`${header.join(",")}\n${rows.join("\n")}\n`, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": "attachment; filename=\"cetus-audit.csv\"",
          "cache-control": "no-store",
        },
      });
    })
    .get("/api/keys", async ({ request }) => {
      await actorForScope(request, "keys:read");
      return listApiKeys();
    })
    .post("/api/keys", async ({ request, body }) => {
      const actor = await actorForScope(request, "keys:write");
      const invalid = body.scopes.filter((scope) => !ALL_SCOPES.includes(scope as any));
      if (invalid.length > 0) throw new ApiError(422, "invalid_scope", `Unknown scopes: ${invalid.join(", ")}`);
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) {
        throw new ApiError(422, "invalid_expiry", "expiresAt must be a valid ISO date.");
      }
      const created = createApiKey({
        name: body.name,
        scopes: body.scopes,
        hostIds: body.hostIds,
        stackIds: body.stackIds,
        createdBy: actor.name,
        expiresAt,
      });
      recordAudit({ actor, action: "key.create", resourceType: "api_key", resourceId: created.summary.id, metadata: { name: body.name, scopes: body.scopes }, request });
      return created;
    }, {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 80 }),
        scopes: t.Array(t.String()),
        hostIds: t.Optional(t.Array(t.String())),
        stackIds: t.Optional(t.Array(t.String())),
        expiresAt: t.Optional(t.String()),
      }),
    })
    .delete("/api/keys/:id/permanent", async ({ request, params }) => {
      const actor = await actorForScope(request, "keys:write");
      const result = deleteInactiveApiKey(params.id);
      if (!result.ok) {
        if (result.reason === "not_found") throw new ApiError(404, "key_not_found", "API key not found.");
        throw new ApiError(422, "key_active", "Revoke this key before deleting it.");
      }
      recordAudit({
        actor,
        action: "key.delete",
        resourceType: "api_key",
        resourceId: params.id,
        metadata: { name: result.name },
        request,
      });
      return { ok: true };
    })
    .post("/api/keys/prune-revoked", async ({ request }) => {
      const actor = await actorForScope(request, "keys:write");
      const count = pruneRevokedApiKeys();
      recordAudit({
        actor,
        action: "key.prune",
        resourceType: "api_key",
        metadata: { count },
        request,
      });
      return { ok: true, count };
    })
    .delete("/api/keys/:id", async ({ request, params }) => {
      const actor = await actorForScope(request, "keys:write");
      revokeApiKey(params.id);
      recordAudit({ actor, action: "key.revoke", resourceType: "api_key", resourceId: params.id, request });
      return { ok: true };
    })
    .get("/api/users", async ({ request }) => {
      await actorForScope(request, "users:read");
      return db.select().from(schema.user).all().map(userSummary);
    })
    .post("/api/users", async ({ request, body }) => {
      const actor = await actorForScope(request, "users:write");
      if (!isUserRole(body.role)) {
        throw new ApiError(422, "invalid_role", "Role must be admin, operator, or viewer.");
      }
      const email = normalizeEmail(body.email);
      const name = body.name.trim();
      if (!name) throw new ApiError(422, "invalid_name", "Name is required.");
      const existing = db.select().from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`).get();
      if (existing) throw new ApiError(409, "email_exists", "A user with that email already exists.");
      try {
        await auth.api.signUpEmail({
          body: { email, password: body.password, name },
        });
      } catch (error) {
        throw new ApiError(422, "user_create_failed", error instanceof Error ? error.message : "Could not create the user.");
      }
      db.update(schema.user).set({ role: body.role, name, updatedAt: new Date() }).where(sql`lower(${schema.user.email}) = ${email}`).run();
      const created = db.select().from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`).get();
      if (!created) throw new ApiError(500, "user_create_failed", "The user was created but could not be read back.");
      db.delete(schema.session).where(eq(schema.session.userId, created.id)).run();
      recordAudit({
        actor,
        action: "user.create",
        resourceType: "user",
        resourceId: created.id,
        metadata: { email, role: body.role },
        request,
      });
      return userSummary(created);
    }, {
      body: t.Object({
        email: t.String({ format: "email" }),
        name: t.String({ minLength: 1, maxLength: 80 }),
        password: t.String({ minLength: 8, maxLength: 200 }),
        role: t.String(),
      }),
    })
    .patch("/api/users/:id", async ({ request, params, body }) => {
      const actor = await actorForScope(request, "users:write");
      const target = db.select().from(schema.user).where(eq(schema.user.id, params.id)).get();
      if (!target) throw new ApiError(404, "user_not_found", "User not found.");
      if (body.role !== undefined && !isUserRole(body.role)) {
        throw new ApiError(422, "invalid_role", "Role must be admin, operator, or viewer.");
      }
      const name = body.name === undefined ? undefined : body.name.trim();
      if (body.name !== undefined && !name) throw new ApiError(422, "invalid_name", "Name is required.");
      if (body.role && body.role !== "admin" && target.role === "admin" && adminCount() <= 1) {
        throw new ApiError(422, "last_admin", "Promote another admin before changing the last admin's role.");
      }

      const changed: string[] = [];
      db.update(schema.user)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.user.id, target.id))
        .run();
      if (name !== undefined && name !== target.name) changed.push("name");
      if (body.role !== undefined && body.role !== target.role) changed.push("role");
      if (body.password !== undefined) {
        await setUserPassword(target.id, body.password);
        changed.push("password");
        if (actor.id !== target.id) {
          db.delete(schema.session).where(eq(schema.session.userId, target.id)).run();
        }
      }
      const updated = db.select().from(schema.user).where(eq(schema.user.id, target.id)).get();
      if (!updated) throw new ApiError(404, "user_not_found", "User not found.");
      if (changed.length > 0) {
        recordAudit({
          actor,
          action: "user.update",
          resourceType: "user",
          resourceId: target.id,
          metadata: { email: target.email, changed },
          request,
        });
      }
      return userSummary(updated);
    }, {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
        role: t.Optional(t.String()),
        password: t.Optional(t.String({ minLength: 8, maxLength: 200 })),
      }),
    })
    .delete("/api/users/:id", async ({ request, params }) => {
      const actor = await actorForScope(request, "users:write");
      const target = db.select().from(schema.user).where(eq(schema.user.id, params.id)).get();
      if (!target) throw new ApiError(404, "user_not_found", "User not found.");
      if (target.id === actor.id) {
        throw new ApiError(422, "cannot_delete_self", "You cannot remove your own account.");
      }
      if (target.role === "admin" && adminCount() <= 1) {
        throw new ApiError(422, "last_admin", "You cannot remove the last admin.");
      }
      db.delete(schema.user).where(eq(schema.user.id, target.id)).run();
      recordAudit({
        actor,
        action: "user.delete",
        resourceType: "user",
        resourceId: target.id,
        metadata: { email: target.email, role: target.role },
        request,
      });
      return { ok: true };
    })
    .get("/api/invites", async ({ request }) => {
      await actorForScope(request, "users:read");
      return listPendingInvites();
    })
    .post("/api/invites", async ({ request, body }) => {
      const actor = await actorForScope(request, "users:write");
      if (!isUserRole(body.role)) {
        throw new ApiError(422, "invalid_role", "Role must be admin, operator, or viewer.");
      }
      const email = normalizeEmail(body.email);
      const name = body.name?.trim() || null;
      const existing = db.select().from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`).get();
      if (existing) throw new ApiError(409, "email_exists", "A user with that email already exists.");
      const pending = listPendingInvites().find((entry) => entry.email === email && !entry.expired);
      if (pending) throw new ApiError(409, "invite_exists", "A pending invite already exists for that email.");
      const created = createInviteRecord({ email, name, role: body.role, invitedBy: actor.name });
      const url = `${config.publicUrl.replace(/\/$/, "")}/invite/${created.token}`;
      let emailSent = false;
      let emailError: string | null = null;
      if (body.sendEmail) {
        if (!smtpConfigured()) {
          emailError = "SMTP is not configured. Copy the invite link instead.";
        } else {
          try {
            await sendMail({
              to: email,
              subject: `${actor.name} invited you to Cetus`,
              text: `You have been invited to Cetus as ${body.role}.\n\nOpen this one-time link to create your account:\n${url}\n\nThis link expires ${created.invite.expiresAt}.`,
              html: `<p>You have been invited to Cetus as <strong>${escapeHtml(body.role)}</strong>.</p><p><a href="${escapeHtml(url)}">Create your account</a></p><p>This one-time link expires ${escapeHtml(created.invite.expiresAt)}.</p>`,
            });
            emailSent = true;
          } catch (error) {
            emailError = error instanceof Error ? error.message : "The invite email could not be sent.";
          }
        }
      }
      recordAudit({
        actor,
        action: "invite.create",
        resourceType: "invite",
        resourceId: created.invite.id,
        metadata: { email, role: body.role, expiresAt: created.invite.expiresAt, emailSent },
        request,
      });
      return { invite: created.invite, token: created.token, url, emailSent, emailError };
    }, {
      body: t.Object({
        email: t.String({ format: "email" }),
        name: t.Optional(t.String({ maxLength: 80 })),
        role: t.String(),
        sendEmail: t.Optional(t.Boolean()),
      }),
    })
    .delete("/api/invites/:id", async ({ request, params }) => {
      const actor = await actorForScope(request, "users:write");
      if (!revokeInviteRecord(params.id)) throw new ApiError(404, "invite_not_found", "Invite not found.");
      recordAudit({
        actor,
        action: "invite.revoke",
        resourceType: "invite",
        resourceId: params.id,
        request,
      });
      return { ok: true };
    })
    .get("/api/invites/:token", async ({ params }) => {
      const invite = findValidInvite(params.token);
      if (!invite) throw new ApiError(404, "invite_invalid", "This invite is invalid or has expired.");
      return {
        email: invite.email,
        name: invite.name,
        role: invite.role,
        invitedBy: invite.invitedBy,
        expiresAt: invite.expiresAt.toISOString(),
      };
    })
    .post("/api/invites/:token/accept", async ({ request, params, body }) => {
      const invite = findValidInvite(params.token);
      if (!invite) throw new ApiError(404, "invite_invalid", "This invite is invalid or has expired.");
      const email = normalizeEmail(invite.email);
      const name = body.name.trim() || invite.name?.trim() || "";
      if (!name) throw new ApiError(422, "invalid_name", "Enter your name to accept the invite.");
      const existing = db.select().from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`).get();
      if (existing) throw new ApiError(409, "email_exists", "An account with this email already exists. Sign in instead.");
      try {
        await auth.api.signUpEmail({
          body: { email, password: body.password, name },
        });
      } catch (error) {
        throw new ApiError(422, "invite_accept_failed", error instanceof Error ? error.message : "Could not create the account.");
      }
      db.update(schema.user)
        .set({ name, role: invite.role, updatedAt: new Date() })
        .where(sql`lower(${schema.user.email}) = ${email}`)
        .run();
      const created = db.select().from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`).get();
      if (!created) throw new ApiError(500, "invite_accept_failed", "The account was created but could not be read back.");
      db.delete(schema.session).where(eq(schema.session.userId, created.id)).run();
      markInviteAccepted(invite.id);
      recordAudit({
        actor: { type: "user", id: created.id, name, role: invite.role, scopes: ROLE_SCOPES[invite.role] ?? ROLE_SCOPES.viewer },
        action: "invite.accept",
        resourceType: "user",
        resourceId: created.id,
        metadata: { email, invitedBy: invite.invitedBy },
        request,
      });
      return { ok: true, email };
    }, {
      body: t.Object({
        name: t.String({ maxLength: 80 }),
        password: t.String({ minLength: 8, maxLength: 200 }),
      }),
    })
    .get("/api/settings", async ({ request }) => {
      await actorForScope(request, "settings:read");
      return getSettingsView();
    })
    .put("/api/settings", async ({ request, body }) => {
      const actor = await actorForScope(request, "settings:write");
      let result: ReturnType<typeof updateSettings>;
      try {
        const { oidc: oidcBody, smtp: smtpBody, ...rest } = body;
        if (oidcBody?.defaultRole && !isUserRole(oidcBody.defaultRole)) {
          throw new Error("OIDC default role must be admin, operator, or viewer.");
        }
        const oidc = oidcBody
          ? { ...oidcBody, defaultRole: oidcBody.defaultRole as Role | undefined }
          : undefined;
        result = updateSettings({ ...rest, ...(oidc ? { oidc } : {}), ...(smtpBody ? { smtp: smtpBody } : {}) });
      } catch (error) {
        throw new ApiError(422, "invalid_setting", error instanceof Error ? error.message : "Invalid setting.");
      }
      recordAudit({
        actor,
        action: "settings.update",
        resourceType: "instance",
        metadata: { changed: result.changed },
        request,
      });
      return result;
    }, {
      body: t.Object({
        publicUrl: t.Optional(t.String()),
        stacksDir: t.Optional(t.String()),
        allowedOrigins: t.Optional(t.Array(t.String())),
        trustProxy: t.Optional(t.Boolean()),
        oidc: t.Optional(t.Object({
          enabled: t.Optional(t.Boolean()),
          name: t.Optional(t.String({ maxLength: 120 })),
          discoveryUrl: t.Optional(t.String({ maxLength: 500 })),
          clientId: t.Optional(t.String({ maxLength: 300 })),
          clientSecret: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
          scopes: t.Optional(t.Array(t.String({ maxLength: 120 }))),
          autoProvision: t.Optional(t.Boolean()),
          defaultRole: t.Optional(t.String()),
          allowedDomains: t.Optional(t.Array(t.String({ maxLength: 200 }))),
        })),
        smtp: t.Optional(t.Object({
          enabled: t.Optional(t.Boolean()),
          host: t.Optional(t.String({ maxLength: 300 })),
          port: t.Optional(t.Integer({ minimum: 1, maximum: 65535 })),
          secure: t.Optional(t.Boolean()),
          username: t.Optional(t.String({ maxLength: 300 })),
          password: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
          fromName: t.Optional(t.String({ maxLength: 120 })),
          fromEmail: t.Optional(t.String({ maxLength: 300 })),
        })),
      }),
    })
    .post("/api/settings/smtp/test", async ({ request }) => {
      await actorForScope(request, "settings:write");
      const user = await getSessionUser(request);
      if (!user?.email) throw new ApiError(422, "no_email", "SMTP tests must be sent from a signed-in user account.");
      if (!smtpConfigured()) throw new ApiError(422, "smtp_not_configured", "Enable SMTP and set a host and sender address first.");
      try {
        await sendMail({
          to: user.email,
          subject: "Cetus SMTP test",
          text: `SMTP is working. This test was sent from Cetus to ${user.email}.`,
        });
      } catch (error) {
        throw new ApiError(502, "smtp_failed", error instanceof Error ? error.message : "The test email could not be sent.");
      }
      return { ok: true, to: user.email };
    })
    .get("/api/notifications/channels", async ({ request }) => {
      await actorForScope(request, "notifications:read");
      return listChannels();
    })
    .post("/api/notifications/channels", async ({ request, body }) => {
      const actor = await actorForScope(request, "notifications:write");
      const type = body.type as NotificationChannelType;
      if (!["email", "ntfy", "webhook"].includes(type)) {
        throw new ApiError(422, "invalid_channel", "Channel type must be email, ntfy, or webhook.");
      }
      const name = body.name.trim();
      if (!name) throw new ApiError(422, "invalid_channel", "Channel name is required.");
      const created = createChannel({
        name,
        type,
        config: body.config ?? {},
        secret: body.secret ?? null,
        events: body.events ?? [],
        enabled: body.enabled ?? true,
      });
      recordAudit({ actor, action: "notification.create", resourceType: "notification", resourceId: created.id, metadata: { name, type }, request });
      return created;
    }, {
      body: t.Object({
        name: t.String({ maxLength: 120 }),
        type: t.String(),
        config: t.Optional(t.Any()),
        secret: t.Optional(t.Any()),
        events: t.Optional(t.Array(t.String())),
        enabled: t.Optional(t.Boolean()),
      }),
    })
    .patch("/api/notifications/channels/:id", async ({ request, params, body }) => {
      const actor = await actorForScope(request, "notifications:write");
      if (body.type !== undefined && !["email", "ntfy", "webhook"].includes(body.type)) {
        throw new ApiError(422, "invalid_channel", "Channel type must be email, ntfy, or webhook.");
      }
      const updated = updateChannel(params.id, {
        name: body.name?.trim(),
        type: body.type as NotificationChannelType | undefined,
        config: body.config,
        secret: body.secret === undefined ? undefined : body.secret as Record<string, unknown> | null,
        events: body.events,
        enabled: body.enabled,
      });
      if (!updated) throw new ApiError(404, "channel_not_found", "Notification channel not found.");
      recordAudit({ actor, action: "notification.update", resourceType: "notification", resourceId: updated.id, metadata: { name: updated.name, type: updated.type }, request });
      return updated;
    }, {
      body: t.Object({
        name: t.Optional(t.String({ maxLength: 120 })),
        type: t.Optional(t.String()),
        config: t.Optional(t.Any()),
        secret: t.Optional(t.Any()),
        events: t.Optional(t.Array(t.String())),
        enabled: t.Optional(t.Boolean()),
      }),
    })
    .delete("/api/notifications/channels/:id", async ({ request, params }) => {
      const actor = await actorForScope(request, "notifications:write");
      if (!deleteChannel(params.id)) throw new ApiError(404, "channel_not_found", "Notification channel not found.");
      recordAudit({ actor, action: "notification.delete", resourceType: "notification", resourceId: params.id, request });
      return { ok: true };
    })
    .post("/api/notifications/channels/:id/test", async ({ request, params }) => {
      const actor = await actorForScope(request, "notifications:write");
      const result = await sendChannelTest(params.id);
      if (!result.ok) throw new ApiError(502, "notification_failed", result.error ?? "The test notification failed.");
      recordAudit({ actor, action: "notification.test", resourceType: "notification", resourceId: params.id, request });
      return { ok: true };
    })
    .get("/api/notifications/deliveries", async ({ request, query }) => {
      await actorForScope(request, "notifications:read");
      return listDeliveries(Number(query.limit ?? 50));
    })
    .get("/api/logs/sources", async ({ request }) => {
      const actor = await actorForScope(request, "logs:read");
      const hosts = filterHostsForActor(actor, await listHosts());
      const sources = await listLogSources(hosts);
      if (actor.type !== "key") return sources;
      const restrictions = keyRestrictions(actor);
      return sources.filter((source) => {
        if (restrictions.stackIds.length > 0 && (!source.stackId || !restrictions.stackIds.includes(source.stackId))) return false;
        return true;
      });
    })
    .get("/api/containers/:id/logs", async ({ request, params, query }) => {
      const actor = await actorForScope(request, "logs:read");
      const hostId = query.hostId ? String(query.hostId) : LOCAL_HOST_ID;
      const containerId = dockerTarget(params.id);
      const container = await findContainerOnHost(hostId, containerId);
      assertContainerTarget(actor, hostId, container.project);
      const tail = logTail(query.tail, 200);
      const timestamps = query.timestamps === "1" || query.timestamps === "true";
      if (hostId !== LOCAL_HOST_ID) {
        return requestWorkerContainerLogs(hostId, container.id, tail, timestamps);
      }
      const args = ["logs", "--tail", String(tail), ...(timestamps ? ["--timestamps"] : []), container.id];
      const result = await docker(args, { timeoutMs: 20_000 });
      return `${result.stdout}${result.stderr}`;
    })
    .get("/api/containers/:id/logs/stream", async ({ request, params, query }) => {
      const actor = await actorForScope(request, "logs:read");
      const hostId = query.hostId ? String(query.hostId) : LOCAL_HOST_ID;
      const containerId = dockerTarget(params.id);
      const container = await findContainerOnHost(hostId, containerId);
      assertContainerTarget(actor, hostId, container.project);
      const tail = logTail(query.tail, 500);
      const timestamps = query.timestamps !== "0" && query.timestamps !== "false";

      if (hostId !== LOCAL_HOST_ID) {
        if (!getRemoteHost(hostId)) {
          throw new ApiError(503, "worker_offline", "The worker for this host is not connected.");
        }
        const requestId = crypto.randomUUID();
        const encoder = new TextEncoder();
        let cancelled = false;
        let atLineBoundary = true;
        let stopHeartbeat: (() => void) | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            stopHeartbeat = keepLogStreamAlive(
              (chunk) => controller.enqueue(chunk),
              encoder,
              () => atLineBoundary,
            );
            const close = () => {
              if (cancelled) return;
              stopHeartbeat?.();
              try { controller.close(); } catch { /* already closed */ }
            };
            registerRemoteLogStream(requestId, {
              hostId,
              push: (text) => {
                if (cancelled) return;
                atLineBoundary = text.endsWith("\n");
                try { controller.enqueue(encoder.encode(text)); } catch { /* stream closed */ }
              },
              close,
              fail: (message) => {
                if (cancelled) return;
                stopHeartbeat?.();
                try { controller.error(new Error(message)); } catch { /* stream closed */ }
              },
            });
            const sent = sendToWorker(hostId, {
              type: "container.logs.start",
              requestId,
              containerId: container.id,
              tail,
              timestamps,
            });
            if (!sent) {
              failRemoteLogStream(requestId, "Worker is not connected.");
            }
          },
          cancel() {
            cancelled = true;
            stopHeartbeat?.();
            sendToWorker(hostId, { type: "container.logs.stop", requestId });
            removeRemoteLogStream(requestId);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      }

      const proc = Bun.spawn([
        "docker",
        "logs",
        "-f",
        "--tail",
        String(tail),
        ...(timestamps ? ["--timestamps"] : []),
        container.id,
      ], {
        stdout: "pipe",
        stderr: "pipe",
      });
      request.signal.addEventListener("abort", () => proc.kill());
      const encoder = new TextEncoder();
      let atLineBoundary = true;
      let stopHeartbeat: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          stopHeartbeat = keepLogStreamAlive(
            (chunk) => controller.enqueue(chunk),
            encoder,
            () => atLineBoundary,
          );
          const pump = async (source: ReadableStream<Uint8Array>) => {
            const reader = source.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value?.length) {
                atLineBoundary = value[value.length - 1] === 0x0a;
                controller.enqueue(value);
              }
            }
          };
          try {
            await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
            controller.close();
          } catch {
            try { controller.close(); } catch { /* already closed */ }
          } finally {
            stopHeartbeat?.();
          }
        },
        cancel() {
          stopHeartbeat?.();
          proc.kill();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      });
    })
    .post("/api/containers/:id/actions/:action", async ({ request, params, query }) => {
      const actor = await actorForScope(request, "containers:write");
      const hostId = query.hostId ? String(query.hostId) : LOCAL_HOST_ID;
      assertTarget(actor, hostId, null);
      if (hostId !== LOCAL_HOST_ID) {
        throw new ApiError(501, "remote_container_unsupported", "Remote container actions are not supported yet.");
      }
      const allowed = new Set(["start", "stop", "restart", "pause", "unpause", "remove"]);
      if (!allowed.has(params.action)) throw new ApiError(400, "invalid_action", "Unsupported container action.");
      const args = params.action === "remove" ? ["rm", "-f", params.id] : [params.action, params.id];
      const result = await docker(args, { timeoutMs: 30_000 });
      recordAudit({ actor, action: `container.${params.action}`, resourceType: "container", resourceId: params.id, request });
      if (result.exitCode !== 0) throw new ApiError(500, "docker_error", result.stderr || "Docker action failed.");
      return { ok: true, output: `${result.stdout}${result.stderr}` };
    })
    .post("/mcp", ({ request }) => handleMcp(request))
    .ws("/api/ws/worker", {
      open(ws) {
        console.log('[cetus] worker socket open', ws.id);
        addPendingWorker(ws.id, ws);
      },
      message(ws, message) {
        void handleWorkerMessage(ws, message);
      },
      close(ws) {
        console.log('[cetus] worker socket close', ws.id);
        void handleWorkerClose(ws);
      },
    })
    .get("/api/stats", async ({ request }) => {
      await actorForScope(request, "metrics:read");
      return Array.from(await getStats().then((map) => map.entries())).map(([name, stats]) => ({ name, ...stats }));
    });

  app.all("/api/auth/*", ({ request, set }) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth/sign-up/email" || pathname.startsWith("/api/auth/sign-up/")) {
      set.status = 403;
      return { error: { code: "signup_disabled", message: "Public sign-up is disabled. Ask an admin for an account." } };
    }
    return auth.handler(request);
  });

  const webDist = path.resolve("dist/web");
  app.get("/*", async ({ request, params, set }) => {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/auth/")) {
      return auth.handler(request);
    }
    if (pathname.startsWith("/api/")) {
      set.status = 404;
      return { error: { code: "not_found", message: "API route not found." } };
    }
    if (!fs.existsSync(webDist)) {
      set.status = 503;
      return "Cetus API is running. Build the web app with `bun run build:web` or open the Vite server on port 5173.";
    }
    const requested = params["*"] || "index.html";
    const candidate = path.resolve(webDist, requested.replace(/^[/\\]+/, ""));
    const root = path.resolve(webDist) + path.sep;
    const file = candidate.startsWith(root) ? Bun.file(candidate) : null;
    if (file && (await file.exists())) return file;
    return Bun.file(path.join(webDist, "index.html"));
  });

  return app;
}
