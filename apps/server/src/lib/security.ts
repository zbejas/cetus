import crypto from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { auth } from "../auth.ts";
import { config } from "../config.ts";
import { ROLE_SCOPES, hasScope } from "@shared/scopes.ts";
import type { Actor, ApiKeySummary, Role, SessionUser } from "@shared/types.ts";
import { ApiError } from "./errors.ts";

type UserRow = typeof schema.user.$inferSelect;

export function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: (user.role ?? "viewer") as Role,
    image: user.image,
  };
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  const row = session.user as unknown as UserRow;
  return toSessionUser(row);
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function extractApiKey(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return request.headers.get("x-api-key");
}

export function hashApiKey(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function verifyApiKey(raw: string): { actor: Actor; hostIds: string[]; stackIds: string[] } | null {
  if (!raw.startsWith("cetus_")) return null;
  const rest = raw.slice("cetus_".length);
  const dot = rest.indexOf(".");
  if (dot < 1) return null;
  const prefix = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!prefix || !secret) return null;

  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.prefix, prefix)).get();
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  const expected = Buffer.from(row.hash);
  const actual = Buffer.from(hashApiKey(secret));
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  db.update(schema.apiKey).set({ lastUsedAt: new Date() }).where(eq(schema.apiKey.id, row.id)).run();

  return {
    actor: {
      type: "key",
      id: row.id,
      name: row.name,
      role: "key",
      scopes: parseJsonArray(row.scopes),
      keyId: row.id,
    },
    hostIds: parseJsonArray(row.hostIds),
    stackIds: parseJsonArray(row.stackIds),
  };
}

export async function getActor(request: Request): Promise<Actor | null> {
  const raw = extractApiKey(request);
  if (raw) {
    const verified = verifyApiKey(raw);
    return verified?.actor ?? null;
  }

  const user = await getSessionUser(request);
  if (user) {
    return {
      type: "user",
      id: user.id,
      name: user.name,
      role: user.role,
      scopes: ROLE_SCOPES[user.role] ?? ROLE_SCOPES.viewer,
    };
  }

  return null;
}

export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new ApiError(401, "unauthorized", "Sign in or provide an API key.");
  return actor;
}

export function requireScope(actor: Actor, scope: string) {
  if (!hasScope(actor.scopes, scope)) {
    throw new ApiError(403, "forbidden", `Missing scope: ${scope}`);
  }
}

export function requireAnyScope(actor: Actor, scopes: string[]) {
  if (!scopes.some((scope) => hasScope(actor.scopes, scope))) {
    throw new ApiError(403, "forbidden", `Missing one of: ${scopes.join(", ")}`);
  }
}

export function actorCanTarget(
  actor: Actor,
  targets: { hostId?: string | null; stackId?: string | null },
  restrictions: { hostIds: string[]; stackIds: string[] },
) {
  if (actor.type !== "key") return true;
  if (restrictions.hostIds.length > 0) {
    if (!targets.hostId || !restrictions.hostIds.includes(targets.hostId)) return false;
  }
  if (restrictions.stackIds.length > 0) {
    if (!targets.stackId || !restrictions.stackIds.includes(targets.stackId)) return false;
  }
  return true;
}

export function createApiKey(input: {
  name: string;
  scopes: string[];
  hostIds?: string[];
  stackIds?: string[];
  createdBy: string;
  expiresAt?: Date | null;
}): { summary: ApiKeySummary; secret: string } {
  const prefix = crypto.randomBytes(6).toString("base64url");
  const secret = crypto.randomBytes(24).toString("base64url");
  const id = crypto.randomUUID();
  const now = new Date();
  const fullSecret = `cetus_${prefix}.${secret}`;

  db.insert(schema.apiKey).values({
    id,
    name: input.name,
    prefix,
    hash: hashApiKey(secret),
    scopes: JSON.stringify(input.scopes),
    hostIds: JSON.stringify(input.hostIds ?? []),
    stackIds: JSON.stringify(input.stackIds ?? []),
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
  }).run();

  return {
    summary: {
      id,
      name: input.name,
      prefix,
      scopes: input.scopes,
      hostIds: input.hostIds ?? [],
      stackIds: input.stackIds ?? [],
      createdBy: input.createdBy,
      createdAt: now.toISOString(),
      lastUsedAt: null,
      expiresAt: input.expiresAt?.toISOString() ?? null,
      revokedAt: null,
    },
    secret: fullSecret,
  };
}

export function listApiKeys(): ApiKeySummary[] {
  return db.select().from(schema.apiKey).all().map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseJsonArray(row.scopes),
    hostIds: parseJsonArray(row.hostIds),
    stackIds: parseJsonArray(row.stackIds),
    createdBy: row.createdBy ?? "",
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}

export function revokeApiKey(id: string) {
  db.update(schema.apiKey).set({ revokedAt: new Date() }).where(eq(schema.apiKey.id, id)).run();
}

export function deleteInactiveApiKey(id: string) {
  const row = db.select().from(schema.apiKey).where(eq(schema.apiKey.id, id)).get();
  if (!row) return { ok: false as const, reason: "not_found" as const };
  const expired = Boolean(row.expiresAt && row.expiresAt.getTime() <= Date.now());
  if (!row.revokedAt && !expired) {
    return { ok: false as const, reason: "active" as const, name: row.name };
  }
  db.delete(schema.apiKey).where(eq(schema.apiKey.id, id)).run();
  return { ok: true as const, name: row.name, prefix: row.prefix };
}

export function pruneRevokedApiKeys() {
  const rows = db.select({ id: schema.apiKey.id }).from(schema.apiKey).where(isNotNull(schema.apiKey.revokedAt)).all();
  if (rows.length === 0) return 0;
  db.delete(schema.apiKey).where(isNotNull(schema.apiKey.revokedAt)).run();
  return rows.length;
}

export function getClientIp(request: Request) {
  if (!config.trustProxy) return null;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return request.headers.get("x-real-ip");
}

export function recordAudit(input: {
  actor: Actor;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  hostId?: string | null;
  stackId?: string | null;
  metadata?: Record<string, unknown>;
  request?: Request;
}) {
  db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorName: input.actor.name,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    hostId: input.hostId ?? null,
    stackId: input.stackId ?? null,
    metadata: JSON.stringify(input.metadata ?? {}),
    ip: input.request ? getClientIp(input.request) : null,
    userAgent: input.request?.headers.get("user-agent") ?? null,
    createdAt: new Date(),
  }).run();
}
