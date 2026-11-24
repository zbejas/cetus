import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Role } from "@shared/types.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { bootstrap, config, refreshTrustedOrigins } from "../config.ts";
import { sealSecret } from "./secrets.ts";

const USER_ROLES: Role[] = ["admin", "operator", "viewer"];

export interface OidcPatch {
  enabled?: boolean;
  name?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string | null;
  scopes?: string[];
  autoProvision?: boolean;
  defaultRole?: Role;
  allowedDomains?: string[];
}

export interface SmtpPatch {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string | null;
  fromName?: string;
  fromEmail?: string;
}

export interface SettingsPatch {
  publicUrl?: string;
  stacksDir?: string;
  allowedOrigins?: string[];
  trustProxy?: boolean;
  oidc?: OidcPatch;
  smtp?: SmtpPatch;
}

function writeSetting(key: string, value: string) {
  const now = new Date();
  db.insert(schema.setting)
    .values({ key: `settings.${key}`, value, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.setting.key,
      set: { value, updatedAt: now },
    })
    .run();
}

function normalizeUrl(value: string, field: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must use http or https.`);
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Origin "${value}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Origin "${value}" must use http or https.`);
  }
  return url.origin;
}

function normalizeStacksDir(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || trimmed.includes("\0")) {
    throw new Error("Stacks directory must be an absolute path.");
  }
  fs.mkdirSync(trimmed, { recursive: true });
  return path.resolve(trimmed);
}

function smtpView() {
  return {
    enabled: config.smtp.enabled,
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    username: config.smtp.username,
    fromName: config.smtp.fromName,
    fromEmail: config.smtp.fromEmail,
    hasPassword: Boolean(config.smtp.passwordSealed),
  };
}

function oidcView() {
  return {
    enabled: config.oidc.enabled,
    active: config.oidcActive,
    restartRequired: config.oidcRestartRequired,
    name: config.oidc.name,
    discoveryUrl: config.oidc.discoveryUrl,
    clientId: config.oidc.clientId,
    scopes: config.oidc.scopes,
    autoProvision: config.oidc.autoProvision,
    defaultRole: config.oidc.defaultRole,
    allowedDomains: config.oidc.allowedDomains,
    hasClientSecret: Boolean(config.oidc.clientSecretSealed),
    callbackUrl: `${config.publicUrl}/api/auth/callback/oidc`,
  };
}

export function getSettingsView() {
  return {
    version: config.version,
    publicUrl: config.publicUrl,
    authPublicUrl: config.authPublicUrl,
    restartRequired: config.publicUrl !== config.authPublicUrl,
    stacksDir: config.stacksDir,
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    trustProxy: config.trustProxy,
    allowedOrigins: config.allowedOrigins,
    oidc: oidcView(),
    smtp: smtpView(),
    stacksDirLocked: config.dockerDetected && !config.allowStacksDirChange,
    dockerDetected: config.dockerDetected,
    bootstrap: {
      port: bootstrap.port,
      host: bootstrap.host,
      dataDir: bootstrap.dataDir,
      dbPath: bootstrap.dbPath,
      mode: config.isProduction ? "production" : "development",
    },
  };
}

export function updateSettings(patch: SettingsPatch) {
  const changed: string[] = [];
  let reindexRequired = false;

  if (patch.publicUrl !== undefined) {
    const value = normalizeUrl(patch.publicUrl, "Public URL");
    if (value !== config.publicUrl) changed.push("publicUrl");
    config.publicUrl = value;
    config.allowSameOriginBootstrap = false;
    writeSetting("publicUrl", value);
  }

  if (patch.stacksDir !== undefined) {
    const value = normalizeStacksDir(patch.stacksDir);
    if (config.dockerDetected && !config.allowStacksDirChange && value !== config.stacksDir) {
      throw new Error("Stacks directory is locked because Docker is detected. Set CETUS_ALLOW_STACKS_DIR_CHANGE=true to override.");
    }
    if (value !== config.stacksDir) {
      reindexRequired = true;
      changed.push("stacksDir");
    }
    config.stacksDir = value;
    writeSetting("stacksDir", value);
  }

  if (patch.allowedOrigins !== undefined) {
    const value = Array.from(new Set(patch.allowedOrigins.map(normalizeOrigin)));
    if (value.join("\n") !== config.allowedOrigins.join("\n")) changed.push("allowedOrigins");
    config.allowedOrigins = value;
    writeSetting("allowedOrigins", JSON.stringify(value));
  }

  if (patch.trustProxy !== undefined) {
    if (patch.trustProxy !== config.trustProxy) changed.push("trustProxy");
    config.trustProxy = patch.trustProxy;
    writeSetting("trustProxy", String(patch.trustProxy));
  }

  if (patch.oidc) {
    const input = patch.oidc;
    const next = {
      enabled: input.enabled ?? config.oidc.enabled,
      name: (input.name ?? config.oidc.name).trim() || "Single sign-on",
      discoveryUrl: input.discoveryUrl === undefined
        ? config.oidc.discoveryUrl
        : input.discoveryUrl.trim()
          ? normalizeUrl(input.discoveryUrl, "OIDC discovery URL")
          : "",
      clientId: (input.clientId ?? config.oidc.clientId).trim(),
      clientSecretSealed: input.clientSecret === null
        ? null
        : input.clientSecret?.trim()
          ? sealSecret(input.clientSecret.trim())
          : config.oidc.clientSecretSealed,
      scopes: Array.from(new Set((input.scopes ?? config.oidc.scopes).map((scope) => scope.trim()).filter(Boolean))),
      autoProvision: input.autoProvision ?? config.oidc.autoProvision,
      defaultRole: input.defaultRole ?? config.oidc.defaultRole,
      allowedDomains: Array.from(new Set((input.allowedDomains ?? config.oidc.allowedDomains)
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean))),
    };
    if (!USER_ROLES.includes(next.defaultRole)) throw new Error("OIDC default role is invalid.");
    if (next.enabled) {
      if (!next.discoveryUrl) throw new Error("OIDC discovery URL is required when single sign-on is enabled.");
      if (!next.clientId) throw new Error("OIDC client ID is required when single sign-on is enabled.");
      if (!next.clientSecretSealed) throw new Error("OIDC client secret is required when single sign-on is enabled.");
      if (next.scopes.length === 0) throw new Error("At least one OIDC scope is required.");
    }

    const changedFields: string[] = [];
    if (next.enabled !== config.oidc.enabled) changedFields.push("enabled");
    if (next.name !== config.oidc.name) changedFields.push("name");
    if (next.discoveryUrl !== config.oidc.discoveryUrl) changedFields.push("discoveryUrl");
    if (next.clientId !== config.oidc.clientId) changedFields.push("clientId");
    if (next.clientSecretSealed !== config.oidc.clientSecretSealed) changedFields.push("clientSecret");
    if (next.scopes.join(",") !== config.oidc.scopes.join(",")) changedFields.push("scopes");
    if (next.autoProvision !== config.oidc.autoProvision) changedFields.push("autoProvision");
    if (next.defaultRole !== config.oidc.defaultRole) changedFields.push("defaultRole");
    if (next.allowedDomains.join(",") !== config.oidc.allowedDomains.join(",")) changedFields.push("allowedDomains");

    if (changedFields.length > 0) {
      Object.assign(config.oidc, next);
      writeSetting("oidcEnabled", String(next.enabled));
      writeSetting("oidcName", next.name);
      writeSetting("oidcDiscoveryUrl", next.discoveryUrl);
      writeSetting("oidcClientId", next.clientId);
      writeSetting("oidcScopes", JSON.stringify(next.scopes));
      writeSetting("oidcAutoProvision", String(next.autoProvision));
      writeSetting("oidcDefaultRole", next.defaultRole);
      writeSetting("oidcAllowedDomains", JSON.stringify(next.allowedDomains));
      if (next.clientSecretSealed) writeSetting("oidcClientSecret", next.clientSecretSealed);
      else db.delete(schema.setting).where(eq(schema.setting.key, "settings.oidcClientSecret")).run();
      config.oidcRestartRequired = true;
      changed.push("oidc");
    }
  }

  if (patch.smtp) {
    const input = patch.smtp;
    const port = input.port ?? config.smtp.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP port must be between 1 and 65535.");
    const next = {
      enabled: input.enabled ?? config.smtp.enabled,
      host: (input.host ?? config.smtp.host).trim(),
      port,
      secure: input.secure ?? config.smtp.secure,
      username: (input.username ?? config.smtp.username).trim(),
      passwordSealed: input.password === null
        ? null
        : input.password?.trim()
          ? sealSecret(input.password.trim())
          : config.smtp.passwordSealed,
      fromName: (input.fromName ?? config.smtp.fromName).trim() || "Cetus",
      fromEmail: (input.fromEmail ?? config.smtp.fromEmail).trim().toLowerCase(),
    };
    if (next.enabled) {
      if (!next.host) throw new Error("SMTP host is required when email is enabled.");
      if (!next.fromEmail || !next.fromEmail.includes("@")) throw new Error("A valid sender email is required when email is enabled.");
    }
    const changedFields: string[] = [];
    if (next.enabled !== config.smtp.enabled) changedFields.push("enabled");
    if (next.host !== config.smtp.host) changedFields.push("host");
    if (next.port !== config.smtp.port) changedFields.push("port");
    if (next.secure !== config.smtp.secure) changedFields.push("secure");
    if (next.username !== config.smtp.username) changedFields.push("username");
    if (next.passwordSealed !== config.smtp.passwordSealed) changedFields.push("password");
    if (next.fromName !== config.smtp.fromName) changedFields.push("fromName");
    if (next.fromEmail !== config.smtp.fromEmail) changedFields.push("fromEmail");

    if (changedFields.length > 0) {
      Object.assign(config.smtp, next);
      writeSetting("smtpEnabled", String(next.enabled));
      writeSetting("smtpHost", next.host);
      writeSetting("smtpPort", String(next.port));
      writeSetting("smtpSecure", String(next.secure));
      writeSetting("smtpUsername", next.username);
      writeSetting("smtpFromName", next.fromName);
      writeSetting("smtpFromEmail", next.fromEmail);
      if (next.passwordSealed) writeSetting("smtpPassword", next.passwordSealed);
      else db.delete(schema.setting).where(eq(schema.setting.key, "settings.smtpPassword")).run();
      changed.push("smtp");
    }
  }

  refreshTrustedOrigins();
  return { changed, reindexRequired, settings: getSettingsView() };
}
