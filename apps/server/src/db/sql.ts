export const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id);
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_user_idx ON account(user_id);
CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS host (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'offline',
  docker_version TEXT,
  os TEXT,
  arch TEXT,
  cpus INTEGER,
  memory INTEGER,
  info TEXT,
  labels TEXT NOT NULL DEFAULT '{}',
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS host_credential (
  host_id TEXT PRIMARY KEY NOT NULL REFERENCES host(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS stack (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES host(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  compose_file TEXT NOT NULL DEFAULT 'compose.yaml',
  project_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  display_name TEXT,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  icon TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  last_deployed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS stack_host_name_idx ON stack(host_id, name);
CREATE INDEX IF NOT EXISTS stack_host_idx ON stack(host_id);
CREATE TABLE IF NOT EXISTS operation (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  host_id TEXT REFERENCES host(id) ON DELETE SET NULL,
  stack_id TEXT REFERENCES stack(id) ON DELETE SET NULL,
  stack_name TEXT,
  actor_type TEXT NOT NULL DEFAULT 'user',
  actor_id TEXT,
  actor_name TEXT NOT NULL DEFAULT 'system',
  output TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS operation_stack_idx ON operation(stack_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  host_id TEXT,
  stack_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS audit_stack_idx ON audit_log(stack_id);
CREATE TABLE IF NOT EXISTS api_key (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  host_ids TEXT NOT NULL DEFAULT '[]',
  stack_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registry_credential (
  id TEXT PRIMARY KEY NOT NULL,
  registry TEXT NOT NULL,
  username TEXT NOT NULL,
  secret TEXT NOT NULL,
  host_ids TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_credential_registry_idx ON registry_credential(registry);
CREATE TABLE IF NOT EXISTS user_preference (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  palette TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invite (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invite_email_idx ON invite(email);
CREATE TABLE IF NOT EXISTS notification_channel (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  secret TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_delivery (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL REFERENCES notification_channel(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notification_delivery_channel_idx ON notification_delivery(channel_id);
CREATE TABLE IF NOT EXISTS backup (
  id TEXT PRIMARY KEY NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'creating',
  error TEXT,
  actor_name TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS backup_created_idx ON backup(created_at);
CREATE TABLE IF NOT EXISTS snapshot (
  id TEXT PRIMARY KEY NOT NULL,
  stack_id TEXT NOT NULL REFERENCES stack(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  reason TEXT NOT NULL DEFAULT 'save',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshot_stack_idx ON snapshot(stack_id);
`;
