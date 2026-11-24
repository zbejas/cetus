import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { config } from "../config.ts";
import { readAutoUpdateState, refreshAutoUpdateNext } from "./autoUpdateState.ts";
import { clearUpdateCheck, listUpdateChecks, readUpdateCheck } from "./updateCheckState.ts";
import { resolveAutoUpdate, validateAutoUpdateConfig } from "./autoUpdateConfig.ts";
import { readGlobalAutoUpdate } from "./globalAutoUpdate.ts";
import { isCetusWorkerStackName } from "./cetusWorker.ts";

export { isCetusWorkerStackName } from "./cetusWorker.ts";
import type {
  ServiceState,
  SnapshotInfo,
  StackDetail,
  StackMetadata,
  StackStatus,
  StackSummary,
} from "@shared/types.ts";
import { composePs, getStats, parseLabels } from "./docker.ts";
import { LOCAL_HOST_ID, ensureLocalHost, getHostRow, hostRowToSummary } from "./hosts.ts";
import {
  getRemoteStack,
  requestWorkerComposeWrite,
  requestWorkerMetadataWrite,
  updateRemoteStackFiles,
  updateRemoteStackMetadata,
  type RemoteStackSnapshot,
} from "./remote.ts";
import { ApiError } from "./errors.ts";

type StackRow = typeof schema.stack.$inferSelect;
type HostRow = typeof schema.host.$inferSelect;

export const COMPOSE_FILE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

const serviceCache = new Map<string, { at: number; services: ServiceState[] }>();
const SERVICE_TTL_MS = 4_000;

export function invalidateStackCache(id?: string) {
  if (id) {
    serviceCache.delete(id);
  } else {
    serviceCache.clear();
  }
}

export function hashText(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function safeStackName(name: string) {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function readMetadata(row: StackRow): StackMetadata {
  return parseJson<StackMetadata>(row.metadata, {});
}

export function validateStackMetadata(metadata: StackMetadata) {
  if (metadata.autoUpdate) validateAutoUpdateConfig(metadata.autoUpdate);
}

export function findComposeFile(dir: string): string | null {
  for (const name of COMPOSE_FILE_NAMES) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

export function validateComposeText(text: string): { ok: boolean; errors: string[] } {
  try {
    const doc = YAML.parse(text);
    if (!doc || typeof doc !== "object") {
      return { ok: false, errors: ["Compose file must be a YAML object."] };
    }
    if (!doc.services || typeof doc.services !== "object" || Object.keys(doc.services).length === 0) {
      return { ok: false, errors: ["Compose file must define at least one service under services."] };
    }
    return { ok: true, errors: [] };
  } catch (error) {
    if (error instanceof YAML.YAMLParseError) {
      return { ok: false, errors: [error.message] };
    }
    return { ok: false, errors: [error instanceof Error ? error.message : "Invalid YAML"] };
  }
}

function parseCompose(text: string): Record<string, any> {
  try {
    const doc = YAML.parse(text);
    return doc && typeof doc === "object" ? doc : {};
  } catch {
    return {};
  }
}

function serviceProfiles(compose: Record<string, any>): string[] {
  const profiles = new Set<string>();
  for (const service of Object.values(compose.services ?? {}) as any[]) {
    for (const profile of service?.profiles ?? []) profiles.add(String(profile));
  }
  return [...profiles].sort();
}

export function isOneShot(name: string, service: Record<string, any>) {
  if (service?.["x-cetus-one-shot"] === true) return true;
  return name.startsWith("init") && service?.restart === "no";
}

function publishedPorts(ps: Record<string, any> | undefined): ServiceState["ports"] {
  const publishers = ps?.Publishers;
  if (Array.isArray(publishers)) {
    const seen = new Set<string>();
    return publishers
      .filter((publisher) => Number(publisher.PublishedPort) > 0)
      .filter((publisher) => {
        const key = `${publisher.PublishedPort}:${publisher.TargetPort}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((publisher) => ({
        published: String(publisher.PublishedPort),
        target: String(publisher.TargetPort),
        protocol: publisher.Protocol ?? "tcp",
        url: `http://localhost:${publisher.PublishedPort}`,
      }));
  }

  const raw = String(ps?.Ports ?? "");
  const result: ServiceState["ports"] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    const match = trimmed.match(/(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1)?:?(\d+)->(\d+)\/(tcp|udp)/);
    if (match) {
      result.push({
        published: match[1],
        target: match[2],
        protocol: match[3],
        url: `http://localhost:${match[1]}`,
      });
    }
  }
  return result;
}

export function computeStatus(services: ServiceState[]): StackStatus {
  if (services.length === 0) return "created";
  const expected = services.filter((service) => !service.oneShot);
  const relevant = expected.length > 0 ? expected : services;
  const running = relevant.filter((service) => service.state === "running" || service.state === "restarting").length;
  const unhealthy = relevant.some((service) => (service.state === "running" || service.state === "restarting") && service.health === "unhealthy");
  if (running === relevant.length) return unhealthy ? "partial" : "running";
  if (running > 0) return "partial";
  if (relevant.every((service) => service.state === "exited" || service.state === "dead")) return "stopped";
  if (relevant.every((service) => service.state === "created")) return "created";
  return "unknown";
}

async function getServicesForStack(row: StackRow): Promise<ServiceState[]> {
  const owner = getHostRow(row.hostId);
  if (owner?.kind === "worker") {
    return getRemoteStack(row.hostId, row.name)?.services ?? [];
  }
  const cached = serviceCache.get(row.id);
  if (cached && Date.now() - cached.at < SERVICE_TTL_MS) return cached.services;

  const composePath = path.join(row.dir, row.composeFile);
  let compose: Record<string, any> = {};
  try {
    compose = parseCompose(fs.readFileSync(composePath, "utf8"));
  } catch {
    compose = {};
  }

  const definitions = (compose.services ?? {}) as Record<string, any>;
  const psRows = await composePs(row.dir, row.projectName);
  const psByService = new Map<string, Record<string, any>>();
  for (const ps of psRows) {
    const service = String(ps.Service ?? "");
    if (service) psByService.set(service, ps);
  }

  const stats = await getStats();
  const services: ServiceState[] = Object.entries(definitions).map(([name, definition]) => {
    const ps = psByService.get(name);
    const image = String(definition?.image ?? ps?.Image ?? "unknown");
    const containerName = String(ps?.Names ?? ps?.Name ?? "");
    const stat = stats.get(containerName);
    const healthRaw = String(ps?.Health ?? "").toLowerCase();
    const health: ServiceState["health"] =
      healthRaw === "healthy" || healthRaw === "unhealthy" || healthRaw === "starting"
        ? healthRaw
        : "none";
    return {
      name,
      image,
      state: (String(ps?.State ?? "created").toLowerCase() as ServiceState["state"]) ?? "unknown",
      health,
      status: String(ps?.Status ?? (ps ? "" : "Not created")),
      ports: publishedPorts(ps),
      containerId: ps?.ID ? String(ps.ID) : null,
      containerName: containerName || null,
      cpu: stat?.cpu ?? null,
      memoryUsed: stat?.memoryUsed ?? null,
      memoryLimit: stat?.memoryLimit ?? null,
      uptime: ps?.RunningFor ? String(ps.RunningFor) : null,
      oneShot: isOneShot(name, definition ?? {}),
    };
  });

  serviceCache.set(row.id, { at: Date.now(), services });
  return services;
}

export function buildStackSummary(row: StackRow, host: HostRow, services?: ServiceState[]): StackSummary {
  const metadata = readMetadata(row);
  const list = services ?? [];
  const runningCount = list.filter((service) => service.state === "running" || service.state === "restarting").length;
  return {
    id: row.id,
    hostId: row.hostId,
    hostName: host.name,
    hostKind: host.kind,
    name: row.name,
    displayName: row.displayName || metadata.displayName || row.name,
    description: row.description || metadata.description || "",
    tags: parseJson<string[]>(row.tags, []),
    icon: row.icon,
    status: row.status === "updating" ? "updating" : computeStatus(list),
    composeFile: row.composeFile,
    projectName: row.projectName,
    dir: row.dir,
    serviceCount: list.length,
    runningCount,
    updatedAt: row.updatedAt.toISOString(),
    lastDeployedAt: row.lastDeployedAt?.toISOString() ?? null,
    updateAvailable: false,
  };
}

export async function listStacks(hostId?: string): Promise<StackSummary[]> {
  const rows = (hostId
    ? db.select().from(schema.stack).where(eq(schema.stack.hostId, hostId)).all()
    : db.select().from(schema.stack).all())
    .filter((row) => !isCetusWorkerStackName(row.name, row.projectName));
  const hosts = new Map(db.select().from(schema.host).all().map((row) => [row.id, row]));
  const checks = listUpdateChecks();

  const summaries = await Promise.all(rows.map(async (row) => {
    const host = hosts.get(row.hostId);
    if (!host) return null;
    const services = await getServicesForStack(row);
    const summary = buildStackSummary(row, host, services);
    summary.updateAvailable = checks.get(row.id)?.available ?? false;
    return summary;
  }));

  return summaries.filter((row): row is StackSummary => Boolean(row)).sort((a, b) => {
    const order = { running: 0, partial: 1, updating: 2, stopped: 3, created: 4, error: 5, unknown: 6 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.displayName.localeCompare(b.displayName);
  });
}

export function getStackRow(id: string): StackRow | null {
  return db.select().from(schema.stack).where(eq(schema.stack.id, id)).get() ?? null;
}

function listSnapshots(stackId: string, dir: string): SnapshotInfo[] {
  const snapshotDir = path.join(dir, ".cetus", "snapshots");
  if (!fs.existsSync(snapshotDir)) return [];
  const rows: SnapshotInfo[] = [];
  for (const file of fs.readdirSync(snapshotDir)) {
    const full = path.join(snapshotDir, file);
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    const content = fs.readFileSync(full);
    rows.push({
      file,
      hash: hashText(content.toString("utf8")),
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
    });
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}

export async function getStackDetail(id: string): Promise<StackDetail | null> {
  const row = getStackRow(id);
  if (!row) return null;
  const host = getHostRow(row.hostId);
  if (!host) return null;
  const autoUpdateState = readAutoUpdateState(row.id);
  const updateCheck = readUpdateCheck(row.id);
  const globalAutoUpdate = readGlobalAutoUpdate();

  if (host.kind === "worker") {
    const remote = getRemoteStack(row.hostId, row.name);
    if (!remote) return null;
    const summary = buildStackSummary(row, host, remote.services);
    summary.updateAvailable = updateCheck?.available ?? false;
    const metadata = remote.metadata ?? readMetadata(row);
    const resolved = resolveAutoUpdate(metadata, globalAutoUpdate);
    return {
      ...summary,
      status: remote.status ?? summary.status,
      compose: remote.compose,
      env: remote.env,
      composeHash: hashText(remote.compose),
      envHash: hashText(remote.env),
      metadata,
      services: remote.services,
      snapshots: [],
      profiles: remote.profiles ?? [],
      host: hostRowToSummary(host),
      autoUpdateState,
      updateCheck,
      globalAutoUpdate,
      effectiveAutoUpdate: resolved.config,
      autoUpdateSource: resolved.source,
    };
  }

  const services = await getServicesForStack(row);
  const metadata = readMetadata(row);
  const resolved = resolveAutoUpdate(metadata, globalAutoUpdate);
  const composePath = path.join(row.dir, row.composeFile);
  const envPath = path.join(row.dir, ".env");
  const compose = fs.existsSync(composePath) ? fs.readFileSync(composePath, "utf8") : "";
  const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const summary = buildStackSummary(row, host, services);
  summary.updateAvailable = updateCheck?.available ?? false;
  return {
    ...summary,
    compose,
    env,
    composeHash: hashText(compose),
    envHash: hashText(env),
    metadata,
    services,
    snapshots: listSnapshots(row.id, row.dir),
    profiles: serviceProfiles(parseCompose(compose)),
    host: hostRowToSummary(host),
    autoUpdateState,
    updateCheck,
    globalAutoUpdate,
    effectiveAutoUpdate: resolved.config,
    autoUpdateSource: resolved.source,
  };
}

export function snapshotCurrent(row: StackRow, reason: string, author: string) {
  const composePath = path.join(row.dir, row.composeFile);
  if (!fs.existsSync(composePath)) return null;
  const content = fs.readFileSync(composePath);
  const dir = path.join(row.dir, ".cetus", "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${stamp}-${row.composeFile}`;
  fs.writeFileSync(path.join(dir, file), content);
  const id = crypto.randomUUID();
  db.insert(schema.snapshot).values({
    id,
    stackId: row.id,
    file,
    hash: hashText(content.toString("utf8")),
    size: content.length,
    author,
    reason,
    createdAt: new Date(),
  }).run();
  return file;
}

function atomicWrite(file: string, content: string) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o644;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, file);
}

export interface SaveStackFilesInput {
  compose?: string;
  env?: string;
  metadata?: StackMetadata;
  baseHash?: string;
}

export async function saveStackFiles(
  id: string,
  input: SaveStackFilesInput,
  actorName: string,
): Promise<StackDetail> {
  const row = getStackRow(id);
  if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
  const owner = getHostRow(row.hostId);
  if (owner?.kind === "worker") {
    return saveRemoteStackFiles(row, input, actorName);
  }
  const composePath = path.join(row.dir, row.composeFile);
  const current = fs.existsSync(composePath) ? fs.readFileSync(composePath, "utf8") : "";
  if (input.baseHash && hashText(current) !== input.baseHash) {
    throw new ApiError(409, "compose_conflict", "The compose file changed on disk. Review the difference and save again.", {
      currentHash: hashText(current),
      current,
    });
  }

  if (input.metadata !== undefined) {
    validateStackMetadata(input.metadata);
  }

  if (input.compose !== undefined) {
    const validation = validateComposeText(input.compose);
    if (!validation.ok) {
      throw new ApiError(422, "compose_invalid", validation.errors.join("\n"), validation.errors);
    }
    snapshotCurrent(row, "save", actorName);
    atomicWrite(composePath, input.compose);
  }

  if (input.env !== undefined) {
    atomicWrite(path.join(row.dir, ".env"), input.env);
  }

  if (input.metadata !== undefined) {
    atomicWrite(path.join(row.dir, "cetus.json"), `${JSON.stringify(input.metadata, null, 2)}\n`);
  }

  const composeText = input.compose ?? current;
  const compose = parseCompose(composeText);
  const metadata = input.metadata ?? readMetadata(row);
  db.update(schema.stack).set({
    updatedAt: new Date(),
    metadata: JSON.stringify(metadata),
    displayName: metadata.displayName ?? row.displayName,
    description: metadata.description ?? row.description,
    tags: JSON.stringify(metadata.tags ?? parseJson<string[]>(row.tags, [])),
    projectName: metadata.projectName ?? row.projectName,
  }).where(eq(schema.stack.id, id)).run();

  serviceCache.delete(id);
  refreshAutoUpdateNext(id, resolveAutoUpdate(metadata, readGlobalAutoUpdate()).config);
  return (await getStackDetail(id))!;
}

async function saveRemoteStackFiles(
  row: StackRow,
  input: SaveStackFilesInput,
  actorName: string,
): Promise<StackDetail> {
  if (input.metadata !== undefined) validateStackMetadata(input.metadata);
  if (input.compose !== undefined) {
    const validation = validateComposeText(input.compose);
    if (!validation.ok) {
      throw new ApiError(422, "compose_invalid", validation.errors.join("\n"), validation.errors);
    }
  }

  if (input.compose !== undefined || input.env !== undefined) {
    const written = await requestWorkerComposeWrite(row.hostId, row.name, {
      compose: input.compose,
      env: input.env,
      baseHash: input.baseHash,
    });
    updateRemoteStackFiles(row.hostId, row.name, written);
  }

  if (input.metadata !== undefined) {
    await requestWorkerMetadataWrite(row.hostId, row.name, input.metadata as Record<string, unknown>);
    updateRemoteStackMetadata(row.hostId, row.name, input.metadata);
    db.update(schema.stack).set({
      metadata: JSON.stringify(input.metadata),
      displayName: input.metadata.displayName ?? row.displayName,
      description: input.metadata.description ?? row.description,
      tags: JSON.stringify(input.metadata.tags ?? parseJson<string[]>(row.tags, [])),
      icon: input.metadata.icon ?? row.icon,
      projectName: input.metadata.projectName ?? row.projectName,
      updatedAt: new Date(),
    }).where(eq(schema.stack.id, row.id)).run();
  } else {
    db.update(schema.stack).set({ updatedAt: new Date() }).where(eq(schema.stack.id, row.id)).run();
  }

  serviceCache.delete(row.id);
  const metadata = input.metadata ?? readMetadata(row);
  refreshAutoUpdateNext(row.id, resolveAutoUpdate(metadata, readGlobalAutoUpdate()).config);
  const detail = await getStackDetail(row.id);
  if (!detail) throw new ApiError(404, "stack_not_found", "Stack not found.");
  return detail;
}

export async function restoreSnapshot(id: string, file: string, actorName: string) {
  const row = getStackRow(id);
  if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
  const snapshotDir = path.join(row.dir, ".cetus", "snapshots");
  const full = path.join(snapshotDir, path.basename(file));
  if (!full.startsWith(snapshotDir) || !fs.existsSync(full)) {
    throw new ApiError(404, "snapshot_not_found", "Snapshot not found.");
  }
  const content = fs.readFileSync(full, "utf8");
  return saveStackFiles(id, { compose: content }, actorName);
}

export async function createStack(name: string, compose: string, actorName: string): Promise<StackDetail> {
  if (!safeStackName(name)) {
    throw new ApiError(422, "invalid_stack_name", "Stack name can only contain lowercase letters, numbers, dashes, and underscores.");
  }
  const validation = validateComposeText(compose);
  if (!validation.ok) {
    throw new ApiError(422, "compose_invalid", validation.errors.join("\n"), validation.errors);
  }
  const dir = path.join(config.stacksDir, name);
  if (fs.existsSync(dir)) throw new ApiError(409, "stack_exists", "A stack with that name already exists.");
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, "compose.yaml"), compose);
  await syncStacks();
  const row = db.select().from(schema.stack).where(and(
    eq(schema.stack.hostId, LOCAL_HOST_ID),
    eq(schema.stack.name, name),
  )).get();
  if (!row) throw new ApiError(500, "stack_create_failed", "Stack was created but could not be indexed.");
  return (await getStackDetail(row.id))!;
}

export function moveToTrash(source: string, target: string) {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

const remoteDeleteTombstones = new Map<string, number>();

function remoteDeleteKey(hostId: string, name: string) {
  return `${hostId}:${name}`;
}

export function markRemoteStackDeleting(hostId: string, name: string, ttlMs = 60_000) {
  remoteDeleteTombstones.set(remoteDeleteKey(hostId, name), Date.now() + ttlMs);
}

export function clearRemoteStackDeleting(hostId: string, name: string) {
  remoteDeleteTombstones.delete(remoteDeleteKey(hostId, name));
}

function isRemoteStackDeleting(hostId: string, name: string) {
  const key = remoteDeleteKey(hostId, name);
  const expiresAt = remoteDeleteTombstones.get(key);
  if (!expiresAt) return false;
  if (expiresAt > Date.now()) return true;
  remoteDeleteTombstones.delete(key);
  return false;
}

export async function deleteStack(id: string, actorName: string) {
  const row = getStackRow(id);
  if (!row) throw new ApiError(404, "stack_not_found", "Stack not found.");
  const target = path.join(config.trashDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${row.name}`);
  moveToTrash(row.dir, target);
  db.delete(schema.stack).where(eq(schema.stack.id, id)).run();
  serviceCache.delete(id);
  clearUpdateCheck(id);
  return target;
}

export function syncRemoteStacks(hostId: string, remoteStacks: RemoteStackSnapshot[]): number {
  const existing = db.select().from(schema.stack).where(eq(schema.stack.hostId, hostId)).all();
  const existingByName = new Map(existing.map((row) => [row.name, row]));
  const seen = new Set<string>();

  for (const remote of remoteStacks) {
    if (isRemoteStackDeleting(hostId, remote.name)) continue;
    seen.add(remote.name);
    const metadata = remote.metadata ?? {};
    const values = {
      hostId,
      name: remote.name,
      dir: remote.dir,
      composeFile: remote.composeFile,
      projectName: remote.projectName,
      status: remote.status,
      displayName: metadata.displayName ?? remote.displayName ?? null,
      description: metadata.description ?? remote.description ?? null,
      tags: JSON.stringify(metadata.tags ?? remote.tags ?? []),
      icon: metadata.icon ?? null,
      metadata: JSON.stringify(metadata),
      updatedAt: new Date(),
    };
    const current = existingByName.get(remote.name);
    if (current) {
      db.update(schema.stack).set(values).where(eq(schema.stack.id, current.id)).run();
    } else {
      db.insert(schema.stack).values({ id: crypto.randomUUID(), ...values }).run();
    }
  }

  for (const row of existing) {
    if (!seen.has(row.name)) db.delete(schema.stack).where(eq(schema.stack.id, row.id)).run();
  }
  return seen.size;
}

export async function syncStacks(): Promise<number> {
  await ensureLocalHost();
  const existing = db.select().from(schema.stack).where(eq(schema.stack.hostId, LOCAL_HOST_ID)).all();
  const existingByName = new Map(existing.map((row) => [row.name, row]));
  const seen = new Set<string>();

  for (const entry of fs.readdirSync(config.stacksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(config.stacksDir, entry.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) continue;
    seen.add(entry.name);
    const metadata = readMetadataFromDir(dir);
    const existingRow = existingByName.get(entry.name);
    const values = {
      hostId: LOCAL_HOST_ID,
      name: entry.name,
      dir,
      composeFile,
      projectName: metadata.projectName ?? entry.name,
      status: existingRow?.status ?? "unknown",
      displayName: metadata.displayName ?? existingRow?.displayName ?? null,
      description: metadata.description ?? existingRow?.description ?? null,
      tags: JSON.stringify(metadata.tags ?? []),
      icon: metadata.icon ?? null,
      metadata: JSON.stringify(metadata),
      updatedAt: new Date(),
    };
    if (existingRow) {
      db.update(schema.stack).set(values).where(eq(schema.stack.id, existingRow.id)).run();
    } else {
      db.insert(schema.stack).values({ id: crypto.randomUUID(), ...values }).run();
    }
  }

  for (const row of existing) {
    if (!seen.has(row.name)) {
      db.delete(schema.stack).where(eq(schema.stack.id, row.id)).run();
      serviceCache.delete(row.id);
    }
  }

  return seen.size;
}

function readMetadataFromDir(dir: string): StackMetadata {
  const file = path.join(dir, "cetus.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as StackMetadata;
  } catch {
    return {};
  }
}
