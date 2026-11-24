import crypto from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Role } from "@shared/types.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InviteSummary {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function toSummary(row: typeof schema.invite.$inferSelect): InviteSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() <= Date.now(),
  };
}

export function createInviteRecord(input: {
  email: string;
  name: string | null;
  role: Role;
  invitedBy: string;
}) {
  const token = crypto.randomBytes(24).toString("base64url");
  const now = new Date();
  const row: typeof schema.invite.$inferInsert = {
    id: crypto.randomUUID(),
    email: input.email,
    name: input.name,
    role: input.role,
    tokenHash: hashToken(token),
    invitedBy: input.invitedBy,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    createdAt: now,
  };
  db.insert(schema.invite).values(row).run();
  return { token, invite: toSummary(row as typeof schema.invite.$inferSelect) };
}

export function listPendingInvites() {
  return db
    .select()
    .from(schema.invite)
    .where(isNull(schema.invite.acceptedAt))
    .orderBy(desc(schema.invite.createdAt))
    .all()
    .map(toSummary);
}

export function findValidInvite(token: string) {
  if (!token || token.length > 200) return null;
  return db
    .select()
    .from(schema.invite)
    .where(
      and(
        eq(schema.invite.tokenHash, hashToken(token)),
        isNull(schema.invite.acceptedAt),
        gt(schema.invite.expiresAt, new Date()),
      ),
    )
    .get() ?? null;
}

export function markInviteAccepted(id: string) {
  db.update(schema.invite)
    .set({ acceptedAt: new Date() })
    .where(eq(schema.invite.id, id))
    .run();
}

export function revokeInviteRecord(id: string) {
  const existing = db.select({ id: schema.invite.id }).from(schema.invite).where(eq(schema.invite.id, id)).get();
  if (!existing) return false;
  db.delete(schema.invite).where(eq(schema.invite.id, id)).run();
  return true;
}
