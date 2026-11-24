import type {
  ApiKeyCreated,
  ApiKeySummary,
  AuditEntry,
  AutoUpdateConfig,
  BackupSummary,
  BulkUpdateResult,
  DashboardData,
  FleetUpdateCheckSummary,
  HostInventory,
  HostSummary,
  LogSource,
  Operation,
  RegistryCredentialInput,
  RegistryCredentialSummary,
  SessionUser,
  StackDetail,
  StackMetadata,
  StackSummary,
  UpdateCheckResult,
  UpdateQueueView,
  WorkerUpdateBulkResult,
} from "@shared/types";
import type { PaletteId } from "@shared/palettes";

/** True when the actor holds a scope. A "*" grant covers every scope. */
export function can(scopes: readonly string[] | null | undefined, scope: string): boolean {
  return Boolean(scopes?.some((granted) => granted === "*" || granted === scope));
}

/** Standard disabled-control reason shown in title and aria-disabled text. */
export function scopeReason(scope: string): string {
  return `Requires ${scope}`;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw new ApiError(
      response.status,
      payload?.code ?? "request_failed",
      payload?.detail ?? payload?.message ?? `Request failed with ${response.status}`,
      payload?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json() as Promise<T>;
  return (await response.text()) as T;
}

export interface MeResponse {
  actor: {
    type: "user" | "key";
    id: string;
    name: string;
    role: string;
    scopes: string[];
  };
  user: SessionUser | null;
  version: string;
  publicUrl: string;
  stacksDir: string;
  defaultPalette: PaletteId;
  preferences: { palette: PaletteId | null };
}

export interface OidcSettings {
  enabled: boolean;
  active: boolean;
  restartRequired: boolean;
  name: string;
  discoveryUrl: string;
  clientId: string;
  scopes: string[];
  autoProvision: boolean;
  defaultRole: string;
  allowedDomains: string[];
  hasClientSecret: boolean;
  callbackUrl: string;
}

export interface OidcPatch {
  enabled?: boolean;
  name?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string | null;
  scopes?: string[];
  autoProvision?: boolean;
  defaultRole?: string;
  allowedDomains?: string[];
}

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromName: string;
  fromEmail: string;
  hasPassword: boolean;
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

export interface SettingsResponse {
  version: string;
  publicUrl: string;
  authPublicUrl: string;
  restartRequired: boolean;
  stacksDir: string;
  dataDir: string;
  dbPath: string;
  trustProxy: boolean;
  allowedOrigins: string[];
  autoUpdate: AutoUpdateConfig;
  oidc: OidcSettings;
  smtp: SmtpSettings;
  stacksDirLocked: boolean;
  dockerDetected: boolean;
  bootstrap: {
    port: number;
    host: string;
    dataDir: string;
    dbPath: string;
    mode: string;
  };
}

export interface SettingsPatch {
  publicUrl?: string;
  stacksDir?: string;
  allowedOrigins?: string[];
  trustProxy?: boolean;
  autoUpdate?: Partial<AutoUpdateConfig>;
  oidc?: OidcPatch;
  smtp?: SmtpPatch;
}

export interface AuthConfig {
  password: boolean;
  oidc: { providerId: string; name: string } | null;
}

export interface NotificationChannelSummary {
  id: string;
  name: string;
  type: "email" | "ntfy" | "webhook";
  config: Record<string, unknown>;
  events: string[];
  enabled: boolean;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDelivery {
  id: string;
  channelId: string;
  event: string;
  status: "sent" | "failed";
  error: string | null;
  createdAt: string;
}

export interface NotificationChannelInput {
  name: string;
  type: "email" | "ntfy" | "webhook";
  config: Record<string, unknown>;
  secret?: Record<string, unknown> | null;
  events: string[];
  enabled: boolean;
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface InviteSummary {
  id: string;
  email: string;
  name: string | null;
  role: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface InviteCreated {
  invite: InviteSummary;
  token: string;
  url: string;
  emailSent?: boolean;
  emailError?: string | null;
}

export interface InviteDetails {
  email: string;
  name: string | null;
  role: string;
  invitedBy: string;
  expiresAt: string;
}

export interface UserCreateInput {
  name: string;
  email: string;
  password: string;
  role: string;
}

export interface UserUpdateInput {
  name?: string;
  role?: string;
  password?: string;
}

export const api = {
  me: () => request<MeResponse>("/api/me"),
  updatePreferences: (palette: PaletteId | null) =>
    request<{ preference: PaletteId | null; palette: PaletteId; defaultPalette: PaletteId }>("/api/preferences", {
      method: "PUT",
      body: JSON.stringify({ palette }),
    }),
  dashboard: () => request<DashboardData>("/api/dashboard"),
  hosts: () => request<HostSummary[]>("/api/hosts"),
  host: (id: string) => request<HostSummary>(`/api/hosts/${id}`),
  logSources: () => request<LogSource[]>("/api/logs/sources"),
  enrollHost: (name: string) =>
    request<{ token: string; managerUrl: string; expiresAt: string }>("/api/hosts/enroll", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  inventory: (id: string) => request<HostInventory>(`/api/hosts/${id}/inventory`),
  stacks: (query = "") => request<StackSummary[]>(`/api/stacks${query}`),
  stack: (id: string) => request<StackDetail>(`/api/stacks/${id}`),
  createStack: (name: string, compose: string) =>
    request<StackDetail>("/api/stacks", { method: "POST", body: JSON.stringify({ name, compose }) }),
  scan: () => request<{ ok: boolean; count: number }>("/api/stacks/scan", { method: "POST" }),
  saveStack: (id: string, body: { compose?: string; env?: string; metadata?: StackMetadata; baseHash?: string }) =>
    request<StackDetail>(`/api/stacks/${id}/compose`, { method: "PUT", body: JSON.stringify(body) }),
  saveStackMetadata: (id: string, metadata: StackMetadata) =>
    request<StackDetail>(`/api/stacks/${id}/metadata`, { method: "PUT", body: JSON.stringify({ metadata }) }),
  runAutoUpdate: (id: string) =>
    request<Operation>(`/api/stacks/${id}/auto-update/run`, { method: "POST", body: JSON.stringify({}) }),
  checkUpdates: (id: string) =>
    request<UpdateCheckResult>(`/api/stacks/${id}/updates/check`, { method: "POST", body: JSON.stringify({}) }),
  checkAllUpdates: () =>
    request<FleetUpdateCheckSummary>("/api/updates/check", { method: "POST", body: JSON.stringify({}) }),
  applyAllUpdates: () =>
    request<BulkUpdateResult>("/api/updates/apply", { method: "POST", body: JSON.stringify({}) }),
  updateQueue: () => request<UpdateQueueView>("/api/update-queue"),
  reorderUpdateQueue: (ids: string[]) =>
    request<UpdateQueueView>("/api/update-queue/order", { method: "PUT", body: JSON.stringify({ ids }) }),
  removeUpdateQueueEntry: (id: string) =>
    request<{ ok: boolean }>(`/api/update-queue/${encodeURIComponent(id)}`, { method: "DELETE" }),
  validateStack: (id: string, compose: string) =>
    request<{ ok: boolean; errors: string[] }>(`/api/stacks/${id}/validate`, { method: "POST", body: JSON.stringify({ compose }) }),
  stackAction: (id: string, action: string, body: { profiles?: string[]; confirmName?: string } = {}) =>
    request<Operation>(`/api/stacks/${id}/actions/${action}`, { method: "POST", body: JSON.stringify(body) }),
  serviceAction: (id: string, service: string, action: string) =>
    request<Operation>(`/api/stacks/${id}/services/${encodeURIComponent(service)}/actions/${action}`, { method: "POST", body: JSON.stringify({}) }),
  exec: (id: string, service: string, command: string) =>
    request<{ stdout: string; stderr: string; exitCode: number }>(`/api/stacks/${id}/exec`, {
      method: "POST",
      body: JSON.stringify({ service, command }),
    }),
  stackLogs: (id: string, tail = 200) => request<string>(`/api/stacks/${id}/logs?tail=${tail}`),
  restoreSnapshot: (id: string, file: string) =>
    request<StackDetail>(`/api/stacks/${id}/snapshots/${encodeURIComponent(file)}/restore`, { method: "POST" }),
  operations: () => request<Operation[]>("/api/operations?compact=1"),
  operation: (id: string) => request<Operation>(`/api/operations/${id}`),
  updateWorker: (hostId: string) =>
    request<Operation>(`/api/hosts/${hostId}/self-update`, { method: "POST" }),
  updateAllWorkers: () =>
    request<WorkerUpdateBulkResult>("/api/hosts/self-update", { method: "POST" }),
  audit: (params: { limit?: number; stackId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.stackId) query.set("stackId", params.stackId);
    const suffix = query.toString();
    return request<AuditEntry[]>(`/api/audit${suffix ? `?${suffix}` : ""}`);
  },
  backups: () => request<BackupSummary[]>("/api/backups"),
  createBackup: () => request<BackupSummary>("/api/backups", { method: "POST" }),
  restoreBackup: (id: string) =>
    request<{ ok: boolean; backupId: string; restartRequired: boolean; message: string }>(`/api/backups/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    }),
  deleteBackup: (id: string) =>
    request<{ ok: boolean }>(`/api/backups/${id}?confirm=true`, { method: "DELETE" }),
  exportAudit: (format: "csv" | "json", stackId?: string) => {
    const query = new URLSearchParams({ format });
    if (stackId) query.set("stackId", stackId);
    return request<string>(`/api/audit/export?${query.toString()}`);
  },
  keys: () => request<ApiKeySummary[]>("/api/keys"),
  createKey: (body: { name: string; scopes: string[]; hostIds?: string[]; stackIds?: string[]; expiresAt?: string }) =>
    request<ApiKeyCreated>("/api/keys", { method: "POST", body: JSON.stringify(body) }),
  revokeKey: (id: string) => request<{ ok: boolean }>(`/api/keys/${id}`, { method: "DELETE" }),
  deleteKey: (id: string) => request<{ ok: boolean }>(`/api/keys/${id}/permanent`, { method: "DELETE" }),
  pruneRevokedKeys: () => request<{ ok: boolean; count: number }>("/api/keys/prune-revoked", { method: "POST", body: JSON.stringify({}) }),
  users: () => request<UserSummary[]>("/api/users"),
  createUser: (body: UserCreateInput) =>
    request<UserSummary>("/api/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, body: UserUpdateInput) =>
    request<UserSummary>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/api/users/${id}`, { method: "DELETE" }),
  invites: () => request<InviteSummary[]>("/api/invites"),
  createInvite: (body: { email: string; name?: string; role: string; sendEmail?: boolean }) =>
    request<InviteCreated>("/api/invites", { method: "POST", body: JSON.stringify(body) }),
  revokeInvite: (id: string) =>
    request<{ ok: boolean }>(`/api/invites/${id}`, { method: "DELETE" }),
  invite: (token: string) =>
    request<InviteDetails>(`/api/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, body: { name: string; password: string }) =>
    request<{ ok: boolean; email: string }>(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  settings: () => request<SettingsResponse>("/api/settings"),
  updateSettings: (body: SettingsPatch) =>
    request<{ changed: string[]; reindexRequired: boolean; settings: SettingsResponse }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  registries: () => request<RegistryCredentialSummary[]>("/api/registries"),
  createRegistry: (body: RegistryCredentialInput) =>
    request<RegistryCredentialSummary>("/api/registries", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateRegistry: (id: string, body: Partial<RegistryCredentialInput>) =>
    request<RegistryCredentialSummary>(`/api/registries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteRegistry: (id: string) =>
    request<{ ok: true }>(`/api/registries/${id}`, { method: "DELETE" }),
  authConfig: () => request<AuthConfig>("/api/auth-config"),
  startOidc: () => request<{ url: string; redirect?: boolean }>("/api/auth/sign-in/social", {
    method: "POST",
    body: JSON.stringify({ provider: "oidc", callbackURL: `${window.location.origin}/` }),
  }),
  testSmtp: () => request<{ ok: boolean; to: string }>("/api/settings/smtp/test", {
    method: "POST",
    body: JSON.stringify({}),
  }),
  notificationChannels: () => request<NotificationChannelSummary[]>("/api/notifications/channels"),
  createNotificationChannel: (body: NotificationChannelInput) =>
    request<NotificationChannelSummary>("/api/notifications/channels", { method: "POST", body: JSON.stringify(body) }),
  updateNotificationChannel: (id: string, body: Partial<NotificationChannelInput>) =>
    request<NotificationChannelSummary>(`/api/notifications/channels/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteNotificationChannel: (id: string) =>
    request<{ ok: boolean }>(`/api/notifications/channels/${id}`, { method: "DELETE" }),
  testNotificationChannel: (id: string) =>
    request<{ ok: boolean }>(`/api/notifications/channels/${id}/test`, { method: "POST", body: JSON.stringify({}) }),
  notificationDeliveries: (limit = 50) =>
    request<NotificationDelivery[]>(`/api/notifications/deliveries?limit=${limit}`),
  containerLogs: (id: string, hostId?: string, tail = 200) => {
    const query = new URLSearchParams({ tail: String(tail) });
    if (hostId) query.set("hostId", hostId);
    return request<string>(`/api/containers/${id}/logs?${query.toString()}`);
  },
  containerAction: (id: string, action: string, hostId?: string) => {
    const query = hostId ? `?hostId=${encodeURIComponent(hostId)}` : "";
    return request<{ ok: boolean; output: string }>(`/api/containers/${id}/actions/${action}${query}`, { method: "POST" });
  },
  login: (email: string, password: string) =>
    request<{ token: string; user: SessionUser }>("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ success?: boolean }>("/api/auth/sign-out", { method: "POST", body: JSON.stringify({}) }),
};

export async function streamStackLogs(
  stackId: string,
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/stacks/${stackId}/logs/stream`, {
    credentials: "include",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new ApiError(response.status, "log_stream_failed", "Could not open the log stream.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}
