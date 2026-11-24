import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { DEFAULT_PALETTE } from "@shared/palettes.ts";
import type { Role } from "@shared/types.ts";
import packageJson from "../../../package.json";

const cwd = process.cwd();

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const dataDir = ensureDir(path.resolve(process.env.CETUS_DATA_DIR ?? path.join(cwd, "data")));
const dbPath = process.env.CETUS_DB_PATH ?? path.join(dataDir, "cetus.db");

function readStoredSettings(file: string) {
  try {
    if (!fs.existsSync(file)) return new Map<string, string>();
    const database = new Database(file, { readonly: true });
    const rows = database.query("select key, value from setting where key like 'settings.%'").all() as {
      key: string;
      value: string;
    }[];
    database.close();
    return new Map(rows.map((row) => [row.key, row.value]));
  } catch {
    return new Map<string, string>();
  }
}

const stored = readStoredSettings(dbPath);

function storedValue(key: string) {
  return stored.get(`settings.${key}`) ?? null;
}

function httpUrl(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function boolValue(key: string, environmentDefault: boolean) {
  const value = storedValue(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return environmentDefault;
}

function stringList(key: string, fallback: string[]) {
  const value = storedValue(key);
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Fall through to the environment default.
  }
  return fallback;
}

const envAllowedOrigins = process.env.CETUS_ALLOWED_ORIGINS
  ?.split(",")
  .map((value) => value.trim())
  .filter(Boolean) ?? [];

const initialPublicUrl = httpUrl(process.env.CETUS_PUBLIC_URL, "http://localhost:3000");
const publicUrl = httpUrl(storedValue("publicUrl"), initialPublicUrl);
const stacksDir = ensureDir(path.resolve(storedValue("stacksDir") ?? process.env.CETUS_STACKS_DIR ?? "/opt/stacks"));
const masterKeyPath = process.env.CETUS_MASTER_KEY_FILE ?? path.join(dataDir, "master.key");
export const masterKey = readOrCreateSecret(masterKeyPath, process.env.CETUS_MASTER_KEY);

const storedOidcRole = storedValue("oidcDefaultRole");
const oidcDefaultRole: Role = storedOidcRole === "admin" || storedOidcRole === "operator" || storedOidcRole === "viewer"
  ? storedOidcRole
  : "viewer";
const oidcEnabled = boolValue("oidcEnabled", false);
const oidcDiscoveryUrl = storedValue("oidcDiscoveryUrl") ?? "";
const oidcClientId = storedValue("oidcClientId") ?? "";
const oidcClientSecretSealed = storedValue("oidcClientSecret");
const oidc = {
  enabled: oidcEnabled,
  name: storedValue("oidcName") ?? "Single sign-on",
  discoveryUrl: oidcDiscoveryUrl,
  clientId: oidcClientId,
  clientSecretSealed: oidcClientSecretSealed,
  scopes: stringList("oidcScopes", ["openid", "profile", "email"]),
  autoProvision: boolValue("oidcAutoProvision", true),
  defaultRole: oidcDefaultRole,
  allowedDomains: stringList("oidcAllowedDomains", []),
};
const oidcActive = oidc.enabled && Boolean(oidc.discoveryUrl && oidc.clientId && oidc.clientSecretSealed);

const smtpPortValue = Number(storedValue("smtpPort") ?? 587);
const smtpPort = Number.isInteger(smtpPortValue) && smtpPortValue > 0 && smtpPortValue <= 65535 ? smtpPortValue : 587;
const smtp = {
  enabled: boolValue("smtpEnabled", false),
  host: storedValue("smtpHost") ?? "",
  port: smtpPort,
  secure: boolValue("smtpSecure", smtpPort === 465),
  username: storedValue("smtpUsername") ?? "",
  passwordSealed: storedValue("smtpPassword"),
  fromName: storedValue("smtpFromName") ?? "Cetus",
  fromEmail: storedValue("smtpFromEmail") ?? "",
};

export const config = {
  port: Number(process.env.CETUS_PORT ?? 3000),
  host: process.env.CETUS_HOST ?? "0.0.0.0",
  publicUrl,
  initialPublicUrl,
  authPublicUrl: publicUrl,
  allowSameOriginBootstrap: !storedValue("publicUrl"),
  dataDir,
  dbPath,
  stacksDir,
  allowedOrigins: stringList("allowedOrigins", envAllowedOrigins),
  get authSecretPath() {
    return path.join(this.dataDir, "auth.secret");
  },
  masterKeyPath,
  get oidcActive() {
    return oidcActive;
  },
  oidcRestartRequired: false,
  oidc,
  smtp,
  get trashDir() {
    return ensureDir(path.join(this.dataDir, "trash"));
  },
  get operationsDir() {
    return ensureDir(path.join(this.dataDir, "operations"));
  },
  isProduction: process.env.NODE_ENV === "production",
  get backupDir() {
    return ensureDir(path.join(this.dataDir, "backups"));
  },
  backupEnabled: process.env.CETUS_BACKUP_ENABLED !== "false",
  backupCron: process.env.CETUS_BACKUP_CRON ?? "0 3 * * *",
  backupTimezone: process.env.CETUS_BACKUP_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  backupKeep: Math.max(1, Number(process.env.CETUS_BACKUP_KEEP ?? 11) || 11),
  updateCheckEnabled: process.env.CETUS_UPDATE_CHECK_ENABLED !== "false",
  auditRetentionDays: Math.max(1, Number(process.env.CETUS_AUDIT_RETENTION_DAYS ?? 90) || 90),
  notificationRetentionDays: Math.max(1, Number(process.env.CETUS_NOTIFICATION_RETENTION_DAYS ?? 30) || 30),
  trustProxy: boolValue("trustProxy", process.env.CETUS_TRUST_PROXY === "true"),
  dockerDetected: false,
  allowStacksDirChange: process.env.CETUS_ALLOW_STACKS_DIR_CHANGE === "true",
  adminEmail: process.env.CETUS_ADMIN_EMAIL ?? "",
  adminPassword: process.env.CETUS_ADMIN_PASSWORD ?? "",
  defaultPalette: DEFAULT_PALETTE,
  version: packageJson.version,
};

export const bootstrap = {
  port: config.port,
  host: config.host,
  dataDir: config.dataDir,
  dbPath: config.dbPath,
  initialPublicUrl: config.initialPublicUrl,
};

export function readOrCreateSecret(file: string, envValue?: string): string {
  if (envValue) return envValue;
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const authSecret = readOrCreateSecret(config.authSecretPath, process.env.CETUS_AUTH_SECRET);

const baseOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...envAllowedOrigins,
];

export function currentTrustedOrigins() {
  return Array.from(new Set([config.publicUrl, ...baseOrigins, ...config.allowedOrigins]));
}

export const trustedOrigins = currentTrustedOrigins();

export function refreshTrustedOrigins() {
  trustedOrigins.splice(0, trustedOrigins.length, ...currentTrustedOrigins());
}
