import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { sendMail } from "./mailer.ts";
import { openSecret, sealSecret } from "./secrets.ts";

export type NotificationChannelType = "email" | "ntfy" | "webhook";

export interface NotificationPayload {
  event: string;
  title: string;
  message: string;
  stackId?: string | null;
  stackName?: string | null;
  hostId?: string | null;
}

type ChannelConfig = Record<string, unknown>;

export interface NotificationChannelView {
  id: string;
  name: string;
  type: NotificationChannelType;
  config: ChannelConfig;
  events: string[];
  enabled: boolean;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

function parseObject(value: string | null | undefined): ChannelConfig {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ChannelConfig : {};
  } catch {
    return {};
  }
}

function parseEvents(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function toView(row: typeof schema.notificationChannel.$inferSelect): NotificationChannelView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: parseObject(row.config),
    events: parseEvents(row.events),
    enabled: row.enabled,
    hasSecret: Boolean(row.secret),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function listChannels() {
  return db.select().from(schema.notificationChannel).orderBy(desc(schema.notificationChannel.createdAt)).all().map(toView);
}

export function createChannel(input: {
  name: string;
  type: NotificationChannelType;
  config: ChannelConfig;
  secret?: Record<string, unknown> | null;
  events: string[];
  enabled: boolean;
}) {
  const now = new Date();
  const row: typeof schema.notificationChannel.$inferInsert = {
    id: crypto.randomUUID(),
    name: input.name,
    type: input.type,
    config: JSON.stringify(input.config),
    secret: input.secret && Object.keys(input.secret).length > 0 ? sealSecret(JSON.stringify(input.secret)) : null,
    events: JSON.stringify(input.events),
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.notificationChannel).values(row).run();
  return toView(row as typeof schema.notificationChannel.$inferSelect);
}

export function updateChannel(id: string, input: {
  name?: string;
  type?: NotificationChannelType;
  config?: ChannelConfig;
  secret?: Record<string, unknown> | null;
  events?: string[];
  enabled?: boolean;
}) {
  const existing = db.select().from(schema.notificationChannel).where(eq(schema.notificationChannel.id, id)).get();
  if (!existing) return null;
  const next = {
    name: input.name ?? existing.name,
    type: input.type ?? existing.type,
    config: input.config === undefined ? existing.config : JSON.stringify(input.config),
    secret: input.secret === null
      ? null
      : input.secret && Object.keys(input.secret).length > 0
        ? sealSecret(JSON.stringify(input.secret))
        : existing.secret,
    events: input.events === undefined ? existing.events : JSON.stringify(input.events),
    enabled: input.enabled ?? existing.enabled,
    updatedAt: new Date(),
  };
  db.update(schema.notificationChannel).set(next).where(eq(schema.notificationChannel.id, id)).run();
  const row = db.select().from(schema.notificationChannel).where(eq(schema.notificationChannel.id, id)).get();
  return row ? toView(row) : null;
}

export function deleteChannel(id: string) {
  const existing = db.select({ id: schema.notificationChannel.id }).from(schema.notificationChannel).where(eq(schema.notificationChannel.id, id)).get();
  if (!existing) return false;
  db.delete(schema.notificationChannel).where(eq(schema.notificationChannel.id, id)).run();
  return true;
}

function readSecret(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const opened = openSecret(value);
  if (!opened) return {};
  try {
    const parsed = JSON.parse(opened);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function emailRecipients(config: ChannelConfig): string[] {
  const value = config.to;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

async function sendChannel(row: typeof schema.notificationChannel.$inferSelect, payload: NotificationPayload) {
  const config = parseObject(row.config);
  const secret = readSecret(row.secret);
  if (row.type === "email") {
    const to = emailRecipients(config);
    if (to.length === 0) throw new Error("This email channel has no recipients.");
    await sendMail({
      to,
      subject: `[Cetus] ${payload.title}`,
      text: `${payload.message}\n\nEvent: ${payload.event}\n${payload.stackName ? `Stack: ${payload.stackName}\n` : ""}`,
    });
    return;
  }

  if (row.type === "ntfy") {
    const serverUrl = String(config.serverUrl ?? "https://ntfy.sh").replace(/\/$/, "");
    const topic = String(config.topic ?? "").trim();
    if (!topic) throw new Error("This ntfy channel has no topic.");
    const headers: Record<string, string> = {
      "Content-Type": "text/plain",
      Title: payload.title,
      Priority: "default",
    };
    if (secret.token) headers.Authorization = `Bearer ${String(secret.token)}`;
    const response = await fetch(`${serverUrl}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: payload.message,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`ntfy returned ${response.status}.`);
    return;
  }

  const url = String(config.url ?? "").trim();
  if (!url) throw new Error("This webhook channel has no URL.");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret.token) headers.Authorization = `Bearer ${String(secret.token)}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Webhook returned ${response.status}.`);
}

function recordDelivery(channelId: string, payload: NotificationPayload, status: "sent" | "failed", error?: string) {
  db.insert(schema.notificationDelivery).values({
    id: crypto.randomUUID(),
    channelId,
    event: payload.event,
    status,
    error: error ?? null,
    createdAt: new Date(),
  }).run();
}

export async function sendChannelTest(id: string) {
  const row = db.select().from(schema.notificationChannel).where(eq(schema.notificationChannel.id, id)).get();
  if (!row) return { ok: false, error: "Channel not found." };
  const payload: NotificationPayload = {
    event: "test",
    title: "Cetus test notification",
    message: "This is a test notification from Cetus. If you can read this, the channel is working.",
  };
  try {
    await sendChannel(row, payload);
    recordDelivery(row.id, payload, "sent");
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delivery failed.";
    recordDelivery(row.id, payload, "failed", message);
    return { ok: false, error: message };
  }
}

export async function notifyEvent(payload: NotificationPayload) {
  const rows = db.select().from(schema.notificationChannel).where(eq(schema.notificationChannel.enabled, true)).all();
  const matching = rows.filter((row) => {
    const events = parseEvents(row.events);
    return events.length === 0 || events.includes(payload.event);
  });
  if (matching.length === 0) return;
  await Promise.allSettled(matching.map(async (row) => {
    try {
      await sendChannel(row, payload);
      recordDelivery(row.id, payload, "sent");
    } catch (error) {
      recordDelivery(row.id, payload, "failed", error instanceof Error ? error.message : "Delivery failed.");
    }
  }));
}

export function listDeliveries(limit = 50) {
  return db.select().from(schema.notificationDelivery)
    .orderBy(desc(schema.notificationDelivery.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all()
    .map((row) => ({
      id: row.id,
      channelId: row.channelId,
      event: row.event,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    }));
}
