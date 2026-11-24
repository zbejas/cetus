import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

const now = () => new Date();

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role").$type<"admin" | "operator" | "viewer">().notNull().default("viewer"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [
  index("session_user_idx").on(table.userId),
  index("session_expires_idx").on(table.expiresAt),
]);

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
}, (table) => [index("account_user_idx").on(table.userId)]);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
}, (table) => [index("verification_identifier_idx").on(table.identifier)]);

export const hostCredential = sqliteTable("host_credential", {
  hostId: text("host_id").primaryKey().references(() => host.id, { onDelete: "cascade" }),
  secretHash: text("secret_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export const host = sqliteTable("host", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  kind: text("kind").$type<"local" | "worker">().notNull().default("local"),
  status: text("status").$type<"online" | "offline" | "degraded">().notNull().default("offline"),
  dockerVersion: text("docker_version"),
  os: text("os"),
  arch: text("arch"),
  cpus: integer("cpus"),
  memory: integer("memory"),
  info: text("info"),
  labels: text("labels").notNull().default("{}"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const stack = sqliteTable("stack", {
  id: text("id").primaryKey(),
  hostId: text("host_id").notNull().references(() => host.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  dir: text("dir").notNull(),
  composeFile: text("compose_file").notNull().default("compose.yaml"),
  projectName: text("project_name").notNull(),
  status: text("status").$type<"running" | "partial" | "stopped" | "created" | "error" | "unknown" | "updating">().notNull().default("unknown"),
  displayName: text("display_name"),
  description: text("description"),
  tags: text("tags").notNull().default("[]"),
  icon: text("icon"),
  metadata: text("metadata").notNull().default("{}"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  lastDeployedAt: integer("last_deployed_at", { mode: "timestamp" }),
}, (table) => [
  uniqueIndex("stack_host_name_idx").on(table.hostId, table.name),
  index("stack_host_idx").on(table.hostId),
  index("stack_host_status_idx").on(table.hostId, table.status),
]);

export const operation = sqliteTable("operation", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  status: text("status").$type<"queued" | "running" | "success" | "failed" | "cancelled">().notNull().default("queued"),
  hostId: text("host_id").references(() => host.id, { onDelete: "set null" }),
  stackId: text("stack_id").references(() => stack.id, { onDelete: "set null" }),
  stackName: text("stack_name"),
  actorType: text("actor_type").notNull().default("user"),
  actorId: text("actor_id"),
  actorName: text("actor_name").notNull().default("system"),
  output: text("output").notNull().default(""),
  exitCode: integer("exit_code"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
}, (table) => [
  index("operation_stack_idx").on(table.stackId),
  index("operation_stack_status_idx").on(table.stackId, table.status),
  index("operation_status_idx").on(table.status),
  index("operation_started_idx").on(table.startedAt),
]);

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  actorName: text("actor_name").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  hostId: text("host_id"),
  stackId: text("stack_id"),
  metadata: text("metadata").notNull().default("{}"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
}, (table) => [
  index("audit_created_idx").on(table.createdAt),
  index("audit_stack_idx").on(table.stackId),
  index("audit_stack_created_idx").on(table.stackId, table.createdAt),
]);

export const apiKey = sqliteTable("api_key", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull().unique(),
  hash: text("hash").notNull(),
  scopes: text("scopes").notNull().default("[]"),
  hostIds: text("host_ids").notNull().default("[]"),
  stackIds: text("stack_ids").notNull().default("[]"),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const registryCredential = sqliteTable("registry_credential", {
  id: text("id").primaryKey(),
  registry: text("registry").notNull(),
  username: text("username").notNull(),
  secret: text("secret").notNull(),
  hostIds: text("host_ids").notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
}, (table) => [index("registry_credential_registry_idx").on(table.registry)]);

export const userPreference = sqliteTable("user_preference", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  palette: text("palette"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const notificationChannel = sqliteTable("notification_channel", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").$type<"email" | "ntfy" | "webhook">().notNull(),
  config: text("config").notNull().default("{}"),
  secret: text("secret"),
  events: text("events").notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const notificationDelivery = sqliteTable("notification_delivery", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => notificationChannel.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  status: text("status").$type<"sent" | "failed">().notNull(),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
}, (table) => [
  index("notification_delivery_channel_idx").on(table.channelId),
  index("notification_delivery_created_idx").on(table.createdAt),
]);

export const invite = sqliteTable("invite", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  role: text("role").$type<"admin" | "operator" | "viewer">().notNull().default("viewer"),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: text("invited_by").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
}, (table) => [index("invite_email_idx").on(table.email)]);

export const backup = sqliteTable("backup", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  size: integer("size").notNull().default(0),
  status: text("status").$type<"creating" | "complete" | "failed">().notNull().default("creating"),
  error: text("error"),
  actorName: text("actor_name"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  completedAt: integer("completed_at", { mode: "timestamp" }),
}, (table) => [index("backup_created_idx").on(table.createdAt)]);

export const snapshot = sqliteTable("snapshot", {
  id: text("id").primaryKey(),
  stackId: text("stack_id").notNull().references(() => stack.id, { onDelete: "cascade" }),
  file: text("file").notNull(),
  hash: text("hash").notNull(),
  size: integer("size").notNull().default(0),
  author: text("author"),
  reason: text("reason").notNull().default("save"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
}, (table) => [index("snapshot_stack_idx").on(table.stackId)]);

export const schema = {
  user,
  session,
  account,
  verification,
  host,
  hostCredential,
  stack,
  operation,
  auditLog,
  apiKey,
  setting,
  registryCredential,
  userPreference,
  invite,
  notificationChannel,
  notificationDelivery,
  backup,
  snapshot,
};
