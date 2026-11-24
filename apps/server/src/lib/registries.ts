import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { RegistryCredentialInput, RegistryCredentialSummary } from "@shared/types.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { config } from "../config.ts";
import { ApiError } from "./errors.ts";
import { openSecret, sealSecret } from "./secrets.ts";
import { LOCAL_HOST_ID } from "./hosts.ts";
import { listRemoteHosts, sendToWorker } from "./remote.ts";
import { clearRemoteDigestCache } from "./updateCheck.ts";

type RegistryRow = typeof schema.registryCredential.$inferSelect;

export interface NormalizedRegistry {
  label: string;
  key: string;
}

export function normalizeRegistry(input: string): NormalizedRegistry {
  const raw = input.trim();
  if (!raw) throw new ApiError(422, "registry_invalid", "Registry is required.");
  const lower = raw.toLowerCase().replace(/\/+$/, "");
  const hostOnly = lower.replace(/^https?:\/\//, "");
  if (
    hostOnly === "docker.io"
    || hostOnly === "index.docker.io"
    || hostOnly === "registry-1.docker.io"
    || lower === "https://index.docker.io/v1"
    || lower === "http://index.docker.io/v1"
  ) {
    return { label: "docker.io", key: "https://index.docker.io/v1/" };
  }
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.username || url.password) throw new Error("credentials");
    if (url.pathname !== "/" || url.search || url.hash) throw new Error("path");
    const host = url.host.toLowerCase();
    if (!host || host.includes(" ")) throw new Error("host");
    return { label: host, key: host };
  } catch {
    throw new ApiError(
      422,
      "registry_invalid",
      "Registry must be a hostname such as ghcr.io or registry.example.com:5000.",
    );
  }
}

function parseHostIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))];
  } catch {
    return [];
  }
}

function hostRows() {
  return db.select().from(schema.host).all();
}

function validateHostIds(input: string[]): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ApiError(422, "registry_hosts_required", "Select at least one host for this registry credential.");
  }
  const unique = [...new Set(input.map(String).map((id) => id.trim()).filter(Boolean))];
  const known = new Set(hostRows().map((host) => host.id));
  const missing = unique.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new ApiError(422, "registry_host_unknown", "One or more selected hosts no longer exist.");
  }
  return unique;
}

function validateHostOverlap(registryKey: string, hostIds: string[], excludeId?: string) {
  const hosts = new Map(hostRows().map((host) => [host.id, host.name]));
  for (const row of db.select().from(schema.registryCredential).all()) {
    if (!row.enabled || row.id === excludeId) continue;
    if (normalizeRegistry(row.registry).key !== registryKey) continue;
    const overlap = parseHostIds(row.hostIds).filter((id) => hostIds.includes(id));
    if (overlap.length > 0) {
      const names = overlap.map((id) => hosts.get(id) ?? id).join(", ");
      throw new ApiError(
        422,
        "registry_host_conflict",
        `Another enabled credential for this registry already targets: ${names}.`,
      );
    }
  }
}

function summaryFor(row: RegistryRow): RegistryCredentialSummary {
  const hostIds = parseHostIds(row.hostIds);
  const hosts = new Map(hostRows().map((host) => [host.id, host]));
  return {
    id: row.id,
    registry: row.registry,
    registryKey: normalizeRegistry(row.registry).key,
    username: row.username,
    hostIds,
    hosts: hostIds.flatMap((id) => {
      const host = hosts.get(id);
      return host ? [{ id: host.id, name: host.name, kind: host.kind }] : [];
    }),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function getRow(id: string) {
  return db.select().from(schema.registryCredential).where(eq(schema.registryCredential.id, id)).get() ?? null;
}

export function listRegistryCredentials(): RegistryCredentialSummary[] {
  return db.select().from(schema.registryCredential).all()
    .sort((a, b) => a.registry.localeCompare(b.registry) || a.username.localeCompare(b.username))
    .map(summaryFor);
}

export function buildDockerConfigForHost(hostId: string): { auths: Record<string, { auth: string }> } {
  const auths: Record<string, { auth: string }> = {};
  for (const row of db.select().from(schema.registryCredential).all()) {
    if (!row.enabled) continue;
    if (!parseHostIds(row.hostIds).includes(hostId)) continue;
    const secret = openSecret(row.secret);
    if (!secret) continue;
    const registry = normalizeRegistry(row.registry);
    auths[registry.key] = {
      auth: Buffer.from(`${row.username}:${secret}`, "utf8").toString("base64"),
    };
  }
  return { auths };
}

export function dockerConfigJsonForHost(hostId: string) {
  return `${JSON.stringify(buildDockerConfigForHost(hostId), null, 2)}\n`;
}

export function applyManagerRegistryConfig() {
  const dir = path.join(config.dataDir, "docker");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "config.json");
  const temp = path.join(dir, `.config.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, dockerConfigJsonForHost(LOCAL_HOST_ID), { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  process.env.DOCKER_CONFIG = dir;
}

export function sendRegistryAuthToWorker(hostId: string) {
  return sendToWorker(hostId, {
    type: "registry.auth",
    config: buildDockerConfigForHost(hostId),
  });
}

export function applyRegistryCredentialChange() {
  applyManagerRegistryConfig();
  for (const worker of listRemoteHosts()) {
    sendRegistryAuthToWorker(worker.hostId);
  }
  clearRemoteDigestCache();
}

export function createRegistryCredential(
  input: RegistryCredentialInput,
): RegistryCredentialSummary {
  const registry = normalizeRegistry(input.registry);
  const username = String(input.username ?? "").trim();
  const secret = String(input.secret ?? "").trim();
  if (!username) {
    throw new ApiError(422, "registry_username_required", "Username is required.");
  }
  if (!secret) {
    throw new ApiError(422, "registry_secret_required", "Password or access token is required.");
  }
  const hostIds = validateHostIds(input.hostIds);
  validateHostOverlap(registry.key, hostIds);
  const now = new Date();
  const id = crypto.randomUUID();
  db.insert(schema.registryCredential).values({
    id,
    registry: registry.label,
    username,
    secret: sealSecret(secret),
    hostIds: JSON.stringify(hostIds),
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }).run();
  applyRegistryCredentialChange();
  return summaryFor(getRow(id)!);
}

export function updateRegistryCredential(
  id: string,
  input: Partial<RegistryCredentialInput>,
): RegistryCredentialSummary {
  const row = getRow(id);
  if (!row) throw new ApiError(404, "registry_not_found", "Registry credential not found.");
  const registry = input.registry === undefined ? normalizeRegistry(row.registry) : normalizeRegistry(input.registry);
  const username = input.username === undefined ? row.username : String(input.username).trim();
  if (!username) {
    throw new ApiError(422, "registry_username_required", "Username is required.");
  }
  const hostIds = input.hostIds === undefined ? parseHostIds(row.hostIds) : validateHostIds(input.hostIds);
  if (hostIds.length === 0) {
    throw new ApiError(422, "registry_hosts_required", "Select at least one host for this registry credential.");
  }
  const enabled = input.enabled ?? row.enabled;
  if (enabled) validateHostOverlap(registry.key, hostIds, id);
  let secret = row.secret;
  if (input.secret !== undefined) {
    const next = String(input.secret).trim();
    if (!next) {
      throw new ApiError(422, "registry_secret_required", "Password or access token cannot be empty.");
    }
    secret = sealSecret(next);
  }
  db.update(schema.registryCredential).set({
    registry: registry.label,
    username,
    secret,
    hostIds: JSON.stringify(hostIds),
    enabled,
    updatedAt: new Date(),
  }).where(eq(schema.registryCredential.id, id)).run();
  applyRegistryCredentialChange();
  return summaryFor(getRow(id)!);
}

export function deleteRegistryCredential(id: string) {
  const row = getRow(id);
  if (!row) throw new ApiError(404, "registry_not_found", "Registry credential not found.");
  const summary = summaryFor(row);
  db.delete(schema.registryCredential).where(eq(schema.registryCredential.id, id)).run();
  applyRegistryCredentialChange();
  return summary;
}
