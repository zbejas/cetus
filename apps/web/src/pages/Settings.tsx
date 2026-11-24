import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  Ban,
  Bell,
  Boxes,
  CalendarClock,
  Check,
  Copy,
  DatabaseBackup,
  Download,
  Fingerprint,
  FolderOpen,
  Globe,
  Info,
  KeyRound,
  Link2,
  LockKeyhole,
  ListFilter,
  Mail,
  MailPlus,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  Send,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  UserPlus,
  UserRound,
  Users,
} from "lucide-react";
import { ALL_SCOPES, ROLE_SCOPES } from "@shared/scopes";
import { DEFAULT_PALETTE, PALETTES, type PaletteId } from "@shared/palettes";
import type {
  ApiKeyCreated,
  ApiKeySummary,
  BackupSummary,
  HostSummary,
  RegistryCredentialInput,
  RegistryCredentialSummary,
  Role,
} from "@shared/types";
import {
  ApiError,
  api,
  can,
  scopeReason,
  type InviteCreated,
  type NotificationChannelInput,
  type NotificationChannelSummary,
  type UserSummary,
} from "../lib/api";
import {
  queryKeys,
  useAudit,
  useBackups,
  useCreateBackup,
  useCreateInvite,
  useCreateKey,
  useCreateUser,
  useDeleteUser,
  useCreateNotificationChannel,
  useDeleteNotificationChannel,
  useInvites,
  useKeys,
  useMe,
  useNotificationChannels,
  useNotificationDeliveries,
  useDeleteBackup,
  useDeleteKey,
  usePruneRevokedKeys,
  useRestoreBackup,
  useRevokeInvite,
  useRevokeKey,
  useScanStacks,
  useSettings,
  useUpdateNotificationChannel,
  useUpdateUser,
  useUsers,
  useHosts,
  useRegistries,
  useSaveRegistry,
  useDeleteRegistry,
} from "../lib/queries";
import { formatBytes, formatDate, relativeTime, shortId, titleCase } from "../lib/format";
import { GlobalAutoUpdateDialog } from "../components/GlobalAutoUpdateDialog";
import { useToast } from "../components/Toast";
import { Badge, Button, Dialog, EmptyState, IconButton, Input, PageHeader, Skeleton } from "../components/ui";
import { scheduleLabel } from "../lib/autoUpdate";

type SettingsTab = "general" | "appearance" | "updates" | "registries" | "authentication" | "mail" | "access" | "notifications" | "keys" | "mcp" | "audit" | "backup";
type BadgeTone = "default" | "accent" | "success" | "warn" | "danger" | "info";

type SettingsNavItem = { id: SettingsTab; label: string; icon: typeof Server; scope?: string };

const SETTINGS_GROUPS: { id: string; label: string; items: SettingsNavItem[] }[] = [
  {
    id: "instance",
    label: "Instance",
    items: [
      { id: "general", label: "General", icon: Server, scope: "settings:read" },
      { id: "appearance", label: "Appearance", icon: Palette },
    ],
  },
  {
    id: "access",
    label: "Access",
    items: [
      { id: "authentication", label: "Authentication", icon: Fingerprint, scope: "settings:read" },
      { id: "access", label: "Users & invites", icon: Users, scope: "users:read" },
      { id: "keys", label: "API keys", icon: KeyRound, scope: "keys:read" },
      { id: "mcp", label: "MCP", icon: Terminal, scope: "keys:read" },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    items: [
      { id: "registries", label: "Registries", icon: LockKeyhole, scope: "settings:read" },
      { id: "mail", label: "Mail", icon: Mail, scope: "settings:read" },
      { id: "notifications", label: "Notifications", icon: Bell, scope: "notifications:read" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { id: "updates", label: "Updates", icon: CalendarClock, scope: "settings:read" },
      { id: "backup", label: "Backups", icon: Archive, scope: "backup:read" },
      { id: "audit", label: "Audit", icon: ScrollText, scope: "audit:read" },
    ],
  },
];

const TABS = SETTINGS_GROUPS.flatMap((group) => group.items);

function tabFromLocation(): SettingsTab {
  const value = new URLSearchParams(window.location.search).get("tab");
  return TABS.some((entry) => entry.id === value) ? value as SettingsTab : "general";
}

const EMPTY_SCOPES: readonly string[] = [];

const MCP_READ_SCOPES: readonly string[] = [
  "mcp:read",
  "hosts:read",
  "stacks:read",
  "containers:read",
  "logs:read",
  "updates:read",
  "audit:read",
];
const MCP_RW_SCOPES: readonly string[] = [
  ...MCP_READ_SCOPES,
  "mcp:write",
  "stacks:write",
  "stacks:deploy",
  "stacks:delete",
  "containers:write",
  "containers:exec",
  "updates:apply",
];

const SCOPE_GROUPS: { label: string; scopes: readonly string[] }[] = [
  { label: "Hosts", scopes: ["hosts:read", "hosts:write", "hosts:enroll"] },
  { label: "Stacks", scopes: ["stacks:read", "stacks:write", "stacks:deploy", "stacks:delete"] },
  {
    label: "Containers",
    scopes: ["containers:read", "containers:write", "containers:exec", "terminal:container"],
  },
  { label: "Images", scopes: ["images:read", "images:write", "images:prune"] },
  { label: "Volumes", scopes: ["volumes:read", "volumes:write", "volumes:prune"] },
  { label: "Networks", scopes: ["networks:read", "networks:write", "networks:prune"] },
  {
    label: "Runtime",
    scopes: [
      "events:read",
      "logs:read",
      "metrics:read",
      "system:prune",
      "notifications:read",
      "notifications:write",
    ],
  },
  { label: "Updates", scopes: ["updates:read", "updates:apply"] },
  { label: "Access", scopes: ["users:read", "users:write", "keys:read", "keys:write", "grants:write"] },
  { label: "Audit", scopes: ["audit:read", "audit:export"] },
  { label: "Settings", scopes: ["settings:read", "settings:write", "secrets:reveal"] },
  { label: "Backup", scopes: ["backup:read", "backup:write"] },
  { label: "MCP", scopes: ["mcp:read", "mcp:write"] },
];

const SCOPE_PRESETS: { label: string; scopes: readonly string[]; hint: string }[] = [
  {
    label: "Read only",
    scopes: ALL_SCOPES.filter((scope) => scope.endsWith(":read")),
    hint: "Every read scope",
  },
  { label: "Operator", scopes: ROLE_SCOPES.operator, hint: "Operator role scope set" },
  { label: "MCP read", scopes: MCP_READ_SCOPES, hint: "Read-only MCP tools" },
  { label: "MCP read+write", scopes: MCP_RW_SCOPES, hint: "All MCP tools" },
];

const ROLE_ORDER: Role[] = ["admin", "operator", "viewer"];

const ROLE_META: Record<Role, { description: string; tone: BadgeTone }> = {
  admin: {
    description: "Full control of the instance, including users, keys, settings, secrets, backup, and audit export.",
    tone: "accent",
  },
  operator: {
    description: "Deploys and operates workloads and containers. No access to users, keys, settings, backup, or audit.",
    tone: "info",
  },
  viewer: {
    description: "Read-only visibility into hosts, stacks, containers, logs, metrics, updates, and notifications.",
    tone: "default",
  },
};

const MCP_TOOLS: { name: string; mode: "read" | "write"; scopes: string; description: string }[] = [
  { name: "list_hosts", mode: "read", scopes: "hosts:read", description: "List managed hosts and their status." },
  { name: "get_host", mode: "read", scopes: "hosts:read", description: "Get one host with Docker info, resources, and counters." },
  { name: "get_host_inventory", mode: "read", scopes: "hosts:read", description: "Get containers, images, volumes, networks, disk, and Docker info." },
  { name: "list_containers", mode: "read", scopes: "containers:read", description: "List containers across visible hosts, or on one host." },
  { name: "get_container_logs", mode: "read", scopes: "logs:read", description: "Read recent logs for one container." },
  { name: "list_stacks", mode: "read", scopes: "stacks:read", description: "List Compose stacks across the fleet." },
  { name: "get_stack", mode: "read", scopes: "stacks:read", description: "Get full stack detail, services, and compose files." },
  { name: "get_stack_compose", mode: "read", scopes: "stacks:read", description: "Read compose, env, metadata, hashes, profiles, and snapshots." },
  { name: "list_services", mode: "read", scopes: "stacks:read", description: "List services with state, health, ports, and resource use." },
  { name: "get_stack_logs", mode: "read", scopes: "logs:read", description: "Read recent logs for one stack." },
  { name: "get_updates", mode: "read", scopes: "updates:read", description: "Read cached image update state." },
  { name: "check_updates", mode: "read", scopes: "updates:read", description: "Check registries for image updates." },
  { name: "get_activity", mode: "read", scopes: "audit:read", description: "Read recent audit entries." },
  { name: "list_operations", mode: "read", scopes: "stacks:read", description: "List recent operations." },
  { name: "create_stack", mode: "write", scopes: "mcp:write + stacks:write", description: "Create a local Compose stack." },
  { name: "edit_stack_compose", mode: "write", scopes: "mcp:write + stacks:write", description: "Save compose, env, or metadata for a local stack." },
  { name: "delete_stack", mode: "write", scopes: "mcp:write + stacks:delete", description: "Move a stack to trash after confirmation." },
  { name: "deploy_stack", mode: "write", scopes: "mcp:write + stacks:deploy", description: "Deploy a stack, optionally with profiles." },
  { name: "stack_lifecycle", mode: "write", scopes: "mcp:write + stacks:deploy", description: "Start, stop, restart, or down a stack." },
  { name: "service_action", mode: "write", scopes: "mcp:write + stacks:deploy", description: "Start, stop, or restart one service." },
  { name: "stack_exec", mode: "write", scopes: "mcp:write + containers:exec", description: "Run a command in a local service container." },
  { name: "container_action", mode: "write", scopes: "mcp:write + containers:write", description: "Start, stop, restart, pause, unpause, or remove a managed Compose container on any host." },
  { name: "apply_update", mode: "write", scopes: "mcp:write + updates:apply", description: "Run the configured health-gated auto-update for one stack." },
  { name: "apply_all_updates", mode: "write", scopes: "mcp:write + updates:apply", description: "Update every visible stack with an available image update." },
];

export function SettingsPage() {
  const me = useMe();
  const [tab, setTab] = useState<SettingsTab>(tabFromLocation);
  const [createOpen, setCreateOpen] = useState(false);
  const [initialScopes, setInitialScopes] = useState<readonly string[]>(EMPTY_SCOPES);
  const scopes = me.data?.actor.scopes;
  const visibleGroups = useMemo(
    () => SETTINGS_GROUPS
      .map((group) => ({
        ...group,
        items: group.items.filter((entry) => !entry.scope || can(scopes, entry.scope)),
      }))
      .filter((group) => group.items.length > 0),
    [scopes],
  );
  const visibleTabs = useMemo(() => visibleGroups.flatMap((group) => group.items), [visibleGroups]);

  useEffect(() => {
    if (me.isLoading) return;
    if (!visibleTabs.some((entry) => entry.id === tab)) {
      setTab(visibleTabs[0]?.id ?? "appearance");
    }
  }, [me.isLoading, tab, visibleTabs]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "general") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url);
  }, [tab]);

  function openCreate(scopes: readonly string[] = EMPTY_SCOPES) {
    setInitialScopes(scopes);
    setCreateOpen(true);
  }

  return (
    <div>
      <PageHeader title="Settings" description="Instance configuration, access, integrations, and maintenance." />

      <label className="settings-mobile-select">
        <span className="label">Settings section</span>
        <select
          className="select"
          value={tab}
          onChange={(event) => setTab(event.target.value as SettingsTab)}
        >
          {visibleGroups.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {group.items.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <div className="settings-shell">
        <nav className="settings-nav" aria-label="Settings sections">
          {visibleGroups.map((group) => (
            <div
              className="settings-nav-group"
              role="group"
              aria-labelledby={`settings-group-${group.id}`}
              key={group.id}
            >
              <div className="settings-nav-label" id={`settings-group-${group.id}`}>{group.label}</div>
              <div className="settings-nav-items">
                {group.items.map((entry) => {
                  const Icon = entry.icon;
                  const active = tab === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className="settings-nav-item"
                      data-active={active}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setTab(entry.id)}
                    >
                      <Icon size={14} />
                      <span>{entry.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="settings-content">
          {tab === "general" ? <GeneralTab /> : null}
          {tab === "appearance" ? <AppearanceTab /> : null}
          {tab === "updates" ? <UpdatesTab /> : null}
          {tab === "registries" ? <RegistriesTab /> : null}
          {tab === "authentication" ? <AuthenticationTab /> : null}
          {tab === "mail" ? <MailTab /> : null}
          {tab === "access" ? <AccessTab /> : null}
          {tab === "notifications" ? <NotificationsTab /> : null}
          {tab === "keys" ? <KeysTab onCreate={() => openCreate()} /> : null}
          {tab === "mcp" ? <McpTab onCreate={() => openCreate(MCP_RW_SCOPES)} /> : null}
          {tab === "audit" ? <AuditTab /> : null}
          {tab === "backup" ? <BackupTab /> : null}
        </div>
      </div>

      <CreateKeyFlow
        open={createOpen}
        initialScopes={initialScopes}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}

type SettingsForm = {
  publicUrl: string;
  stacksDir: string;
  allowedOrigins: string;
  trustProxy: boolean;
};

function AppearanceTab() {
  const me = useMe();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [savingUser, setSavingUser] = useState<PaletteId | null>(null);

  const currentPreference = me.data?.preferences.palette ?? null;
  const defaultPalette = me.data?.defaultPalette ?? DEFAULT_PALETTE;
  const effective = currentPreference ?? defaultPalette;
  const effectiveName = PALETTES.find((palette) => palette.id === effective)?.name ?? "Glacier";
  const defaultName = PALETTES.find((palette) => palette.id === defaultPalette)?.name ?? "Glacier";

  async function choosePersonal(palette: PaletteId | null) {
    setSavingUser(palette ?? defaultPalette);
    try {
      await api.updatePreferences(palette);
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      toast.success(
        "Palette updated",
        palette
          ? `${PALETTES.find((entry) => entry.id === palette)?.name ?? "Palette"} is now your palette.`
          : `Following the ${defaultName} default.`,
      );
    } catch (error) {
      toast.error("Palette not changed", errorMessage(error, "The API rejected the palette."));
    } finally {
      setSavingUser(null);
    }
  }

  if (me.isLoading) {
    return <PanelSkeleton rows={4} />;
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Palette size={15} color="var(--accent)" />
          <h3>Your palette</h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {currentPreference === null ? <Badge>Default</Badge> : null}
          <Badge tone="accent">{effectiveName}</Badge>
        </div>
      </div>
      <div className="settings-form">
        <div>
          <span className="label">Account appearance</span>
          <p className="help" style={{ marginTop: 4 }}>
            {defaultName} is the default. Your choice belongs to your account and follows you between browsers.
          </p>
        </div>
        <div className="palette-grid">
          {PALETTES.map((palette) => (
            <button
              key={palette.id}
              type="button"
              className="palette-choice"
              data-active={effective === palette.id}
              aria-pressed={effective === palette.id}
              disabled={savingUser !== null}
              onClick={() => void choosePersonal(palette.id)}
            >
              <span className="palette-swatches" aria-hidden="true">
                {palette.colors.map((color) => <span key={color} style={{ background: color }} />)}
              </span>
              <span className="palette-copy">
                <strong>{palette.name}</strong>
                <small>{palette.note}{palette.id === defaultPalette ? " · default" : ""}</small>
              </span>
              {effective === palette.id ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
        {currentPreference !== null ? (
          <div>
            <Button size="sm" variant="ghost" onClick={() => void choosePersonal(null)} disabled={savingUser !== null}>
              Use {defaultName} default
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}


type OidcForm = {
  enabled: boolean;
  name: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  autoProvision: boolean;
  defaultRole: Role;
  allowedDomains: string;
};

function AuthenticationTab() {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<OidcForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    const oidc = settings.data.oidc;
    setForm({
      enabled: oidc.enabled,
      name: oidc.name,
      discoveryUrl: oidc.discoveryUrl,
      clientId: oidc.clientId,
      clientSecret: "",
      scopes: oidc.scopes.join(" "),
      autoProvision: oidc.autoProvision,
      defaultRole: (ROLE_META[oidc.defaultRole as Role] ? oidc.defaultRole : "viewer") as Role,
      allowedDomains: oidc.allowedDomains.join(", "),
    });
  }, [settings.data]);

  if (settings.isLoading) return <PanelSkeleton rows={7} />;
  if (settings.isError || !settings.data) {
    return <ErrorPanel title="Authentication settings could not be loaded" error={settings.error} onRetry={() => settings.refetch()} retrying={settings.isFetching} />;
  }
  if (!form) return <PanelSkeleton rows={7} />;

  const oidc = settings.data.oidc;

  function patch<K extends keyof OidcForm>(key: K, value: OidcForm[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const result = await api.updateSettings({
        oidc: {
          enabled: form.enabled,
          name: form.name,
          discoveryUrl: form.discoveryUrl,
          clientId: form.clientId,
          ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
          scopes: form.scopes.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
          autoProvision: form.autoProvision,
          defaultRole: form.defaultRole,
          allowedDomains: form.allowedDomains.split(/[\s,]+/).map((value) => value.trim().toLowerCase()).filter(Boolean),
        },
      });
      setForm((current) => current ? { ...current, clientSecret: "" } : current);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toast.success("Authentication saved", result.settings.oidc.restartRequired ? "Restart the manager to apply the OIDC changes." : "Single sign-on is up to date.");
    } catch (error) {
      toast.error("Authentication not saved", errorMessage(error, "The API rejected the OIDC settings."));
    } finally {
      setSaving(false);
    }
  }

  async function copyCallback() {
    if (await copyToClipboard(oidc.callbackUrl)) {
      setCopied(true);
      toast.success("Callback URL copied", "Register this URL with your identity provider.");
    } else {
      toast.error("Copy failed", "Select the callback URL and copy it manually.");
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Fingerprint size={15} color="var(--accent)" />
            <h3>Single sign-on</h3>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Badge tone={oidc.active ? "success" : "default"}>{oidc.active ? "Active" : "Inactive"}</Badge>
            {oidc.restartRequired ? <Badge tone="warn">Restart needed</Badge> : null}
          </div>
        </div>
        <div className="settings-form">
          <div>
            <span className="label">OIDC provider</span>
            <p className="help" style={{ marginTop: 4 }}>
              One generic OpenID Connect provider via discovery. Password sign-in stays available as the local break-glass path.
            </p>
          </div>

          {oidc.restartRequired ? (
            <div className="settings-warning">
              <AlertTriangle size={14} />
              <span>OIDC settings are saved. Restart the manager with <code className="mono">systemctl restart cetus-manager</code> to apply them.</span>
            </div>
          ) : null}

          <div className="surface-soft" style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Callback URL</div>
              <div className="mono" style={{ marginTop: 4, overflowWrap: "anywhere", color: "var(--text-soft)", fontSize: 11.5 }}>{oidc.callbackUrl}</div>
            </div>
            <Button size="sm" onClick={() => void copyCallback()}><Copy size={13} /> {copied ? "Copied" : "Copy"}</Button>
          </div>

          <SwitchRow
            label="Enable OIDC sign-in"
            description="Show the single sign-on button on the login page."
            checked={form.enabled}
            onChange={(value) => patch("enabled", value)}
          />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div>
              <label className="label" htmlFor="oidc-name">Button name</label>
              <Input id="oidc-name" value={form.name} onChange={(event) => patch("name", event.target.value)} placeholder="Sign in with Pocket ID" maxLength={120} />
            </div>
            <div>
              <label className="label" htmlFor="oidc-default-role">Default role for new accounts</label>
              <select id="oidc-default-role" className="select" value={form.defaultRole} onChange={(event) => patch("defaultRole", event.target.value as Role)}>
                {ROLE_ORDER.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="oidc-discovery">Discovery URL</label>
            <Input id="oidc-discovery" value={form.discoveryUrl} onChange={(event) => patch("discoveryUrl", event.target.value)} placeholder="https://id.example.com/.well-known/openid-configuration" spellCheck={false} />
            <div className="help">Use the provider's OpenID configuration document. Cetus discovers the authorization, token, and JWKS endpoints from it.</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div>
              <label className="label" htmlFor="oidc-client-id">Client ID</label>
              <Input id="oidc-client-id" value={form.clientId} onChange={(event) => patch("clientId", event.target.value)} autoComplete="off" spellCheck={false} />
            </div>
            <div>
              <label className="label" htmlFor="oidc-client-secret">Client secret</label>
              <Input id="oidc-client-secret" type="password" value={form.clientSecret} onChange={(event) => patch("clientSecret", event.target.value)} autoComplete="new-password" placeholder={oidc.hasClientSecret ? "Saved. Leave blank to keep it." : "Paste the client secret"} />
              <div className="help">Stored encrypted with the instance master key. It is never returned to the browser.</div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div>
              <label className="label" htmlFor="oidc-scopes">Scopes</label>
              <Input id="oidc-scopes" value={form.scopes} onChange={(event) => patch("scopes", event.target.value)} placeholder="openid profile email" spellCheck={false} />
              <div className="help">Space or comma separated.</div>
            </div>
            <div>
              <label className="label" htmlFor="oidc-domains">Allowed email domains</label>
              <Input id="oidc-domains" value={form.allowedDomains} onChange={(event) => patch("allowedDomains", event.target.value)} placeholder="example.com, ops.example.com" spellCheck={false} />
              <div className="help">Leave blank to allow any domain. New OIDC accounts outside this list are rejected.</div>
            </div>
          </div>

          <SwitchRow
            label="Auto-provision users"
            description="Create a local account on first successful OIDC sign-in. Disable to require a pre-existing account."
            checked={form.autoProvision}
            onChange={(value) => patch("autoProvision", value)}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
          <Button variant="primary" onClick={() => void save()} loading={saving}>Save authentication</Button>
        </div>
      </section>
    </div>
  );
}

type SmtpForm = {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
};

function MailTab() {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<SmtpForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    const smtp = settings.data.smtp;
    setForm({
      enabled: smtp.enabled,
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      password: "",
      fromName: smtp.fromName,
      fromEmail: smtp.fromEmail,
    });
  }, [settings.data]);

  if (settings.isLoading) return <PanelSkeleton rows={7} />;
  if (settings.isError || !settings.data) {
    return <ErrorPanel title="Mail settings could not be loaded" error={settings.error} onRetry={() => settings.refetch()} retrying={settings.isFetching} />;
  }
  if (!form) return <PanelSkeleton rows={7} />;

  const smtp = settings.data.smtp;

  function patch<K extends keyof SmtpForm>(key: K, value: SmtpForm[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      const result = await api.updateSettings({
        smtp: {
          enabled: form.enabled,
          host: form.host,
          port: Number(form.port),
          secure: form.secure,
          username: form.username,
          ...(form.password.trim() ? { password: form.password.trim() } : {}),
          fromName: form.fromName,
          fromEmail: form.fromEmail,
        },
      });
      setForm((current) => current ? { ...current, password: "" } : current);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toast.success("Mail saved", result.changed.includes("smtp") ? "SMTP settings are live." : "No values changed.");
    } catch (error) {
      toast.error("Mail not saved", errorMessage(error, "The API rejected the SMTP settings."));
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      const result = await api.testSmtp();
      toast.success("Test email sent", `Check ${result.to}.`);
    } catch (error) {
      toast.error("Test email failed", errorMessage(error, "SMTP rejected the message."));
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Mail size={15} color="var(--accent)" />
          <h3>Outgoing mail</h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Badge tone={smtp.enabled ? "success" : "default"}>{smtp.enabled ? "Enabled" : "Disabled"}</Badge>
          <Button size="sm" onClick={() => void sendTest()} loading={testing} disabled={!smtp.enabled}>
            <Send size={13} /> Send test
          </Button>
        </div>
      </div>
      <form onSubmit={save}>
        <div className="settings-form">
          <SwitchRow
            label="Enable SMTP"
            description="Use this server for invite emails, notification emails, and tests."
            checked={form.enabled}
            onChange={(value) => patch("enabled", value)}
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div>
              <label className="label" htmlFor="smtp-from-name">Sender name</label>
              <Input id="smtp-from-name" value={form.fromName} onChange={(event) => patch("fromName", event.target.value)} placeholder="Cetus" maxLength={120} />
            </div>
            <div>
              <label className="label" htmlFor="smtp-from-email">Sender email</label>
              <Input id="smtp-from-email" type="email" value={form.fromEmail} onChange={(event) => patch("fromEmail", event.target.value)} placeholder="cetus@example.com" autoComplete="email" />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <div>
              <label className="label" htmlFor="smtp-host">Host</label>
              <Input id="smtp-host" value={form.host} onChange={(event) => patch("host", event.target.value)} placeholder="smtp.example.com" spellCheck={false} />
            </div>
            <div>
              <label className="label" htmlFor="smtp-port">Port</label>
              <Input id="smtp-port" type="number" min={1} max={65535} value={form.port} onChange={(event) => patch("port", Number(event.target.value))} />
              <div className="help">587 for STARTTLS, 465 for implicit TLS, 25 for local relays.</div>
            </div>
            <div>
              <label className="label" htmlFor="smtp-username">Username</label>
              <Input id="smtp-username" value={form.username} onChange={(event) => patch("username", event.target.value)} autoComplete="username" spellCheck={false} />
            </div>
            <div>
              <label className="label" htmlFor="smtp-password">Password</label>
              <Input id="smtp-password" type="password" value={form.password} onChange={(event) => patch("password", event.target.value)} autoComplete="new-password" placeholder={smtp.hasPassword ? "Saved. Leave blank to keep it." : "Optional"} />
              <div className="help">Stored encrypted with the instance master key.</div>
            </div>
          </div>
          <SwitchRow
            label="Implicit TLS"
            description="Turn on for port 465. Leave off for STARTTLS on port 587 or a local relay."
            checked={form.secure}
            onChange={(value) => patch("secure", value)}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
          <Button type="submit" variant="primary" loading={saving}>Save mail settings</Button>
        </div>
      </form>
    </section>
  );
}

const NOTIFICATION_EVENTS = [
  { id: "operation.failed", label: "Operation failed", hint: "Deploy, update, lifecycle, or worker operation failed." },
  { id: "operation.success", label: "Operation succeeded", hint: "Operation completed without an error." },
  { id: "operation.cancelled", label: "Operation cancelled", hint: "Operation was cancelled." },
];

function channelTypeLabel(type: string) {
  if (type === "email") return "Email";
  if (type === "ntfy") return "ntfy";
  if (type === "webhook") return "Webhook";
  return type;
}

function channelTarget(channel: NotificationChannelSummary) {
  const config = channel.config;
  if (channel.type === "email") {
    const to = Array.isArray(config.to) ? config.to.join(", ") : String(config.to ?? "");
    return to || "No recipients";
  }
  if (channel.type === "ntfy") return `${String(config.serverUrl ?? "https://ntfy.sh")}/${String(config.topic ?? "")}`;
  return String(config.url ?? "No URL");
}

function NotificationsTab() {
  const me = useMe();
  const canWrite = can(me.data?.actor.scopes, "notifications:write");
  const channels = useNotificationChannels();
  const deliveries = useNotificationDeliveries();
  const settings = useSettings(canWrite);
  const deleteChannel = useDeleteNotificationChannel();
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<NotificationChannelSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NotificationChannelSummary | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const channelNames = new Map((channels.data ?? []).map((channel) => [channel.id, channel.name]));
  const smtpReady = Boolean(settings.data?.smtp.enabled && settings.data.smtp.host && settings.data.smtp.fromEmail);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(channel: NotificationChannelSummary) {
    setEditing(channel);
    setDialogOpen(true);
  }

  async function test(channel: NotificationChannelSummary) {
    setTestingId(channel.id);
    try {
      await api.testNotificationChannel(channel.id);
      toast.success("Test sent", `${channel.name} accepted the test.`);
      await deliveries.refetch();
    } catch (error) {
      toast.error("Test failed", errorMessage(error, "The channel rejected the test."));
      await deliveries.refetch();
    } finally {
      setTestingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteChannel.mutateAsync(deleteTarget.id);
      toast.success("Channel removed", `${deleteTarget.name} will no longer receive alerts.`);
      setDeleteTarget(null);
    } catch (error) {
      toast.error("Channel not removed", errorMessage(error, "The channel could not be deleted."));
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Bell size={15} color="var(--accent)" />
            <h3>Notification channels</h3>
            {channels.data ? <Badge>{channels.data.length}</Badge> : null}
          </div>
          {canWrite ? (
            <Button variant="primary" size="sm" onClick={openCreate}><Plus size={14} /> Add channel</Button>
          ) : null}
        </div>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", color: "var(--muted)", fontSize: 12 }}>
          Send operation alerts to email, ntfy, or a JSON webhook. Choose events per channel. Empty means every event.
          {canWrite && !smtpReady ? " Email channels need SMTP in the Mail tab." : ""}
        </div>

        {channels.isLoading ? (
          <RowsSkeleton rows={3} />
        ) : channels.isError ? (
          <ErrorState title="Channels could not be loaded" error={channels.error} onRetry={() => channels.refetch()} retrying={channels.isFetching} />
        ) : !channels.data?.length ? (
          <EmptyState
            icon={<Bell size={20} />}
            title="No notification channels"
            description="Add a channel to get a message when a deploy or update fails."
            action={canWrite ? <Button variant="primary" onClick={openCreate}><Plus size={14} /> Add channel</Button> : undefined}
          />
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="data-table" aria-label="Notification channels">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Target</th>
                  <th scope="col">Events</th>
                  <th scope="col">Status</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {channels.data.map((channel) => (
                  <tr key={channel.id}>
                    <td data-label="Name"><strong style={{ fontWeight: 600 }}>{channel.name}</strong></td>
                    <td data-label="Type"><Badge>{channelTypeLabel(channel.type)}</Badge></td>
                    <td data-label="Target"><span className="mono" style={{ fontSize: 10.5, overflowWrap: "anywhere" }}>{channelTarget(channel)}</span></td>
                    <td data-label="Events">
                      <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{channel.events.length ? channel.events.join(", ") : "All events"}</span>
                    </td>
                    <td data-label="Status"><Badge tone={channel.enabled ? "success" : "default"}>{channel.enabled ? "Enabled" : "Paused"}</Badge></td>
                    <td data-label="Actions">
                      {canWrite ? (
                        <div className="user-row-actions">
                          <IconButton type="button" label={`Test ${channel.name}`} disabled={testingId === channel.id} onClick={() => void test(channel)}>
                            <Send size={13} />
                          </IconButton>
                          <IconButton type="button" label={`Edit ${channel.name}`} onClick={() => openEdit(channel)}>
                            <Pencil size={13} />
                          </IconButton>
                          <IconButton type="button" label={`Remove ${channel.name}`} onClick={() => setDeleteTarget(channel)}>
                            <Trash2 size={13} />
                          </IconButton>
                        </div>
                      ) : <span style={{ color: "var(--muted)" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ScrollText size={15} color="var(--accent)" />
            <h3>Recent deliveries</h3>
          </div>
          <span style={{ color: "var(--muted)", fontSize: 11 }}>Last 30 attempts</span>
        </div>
        {deliveries.isLoading ? (
          <RowsSkeleton rows={3} />
        ) : !deliveries.data?.length ? (
          <div style={{ padding: 16 }}><span className="help">No notifications have been sent yet. Use the test button on a channel.</span></div>
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="data-table" aria-label="Notification deliveries">
              <thead><tr><th scope="col">Time</th><th scope="col">Channel</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Error</th></tr></thead>
              <tbody>
                {deliveries.data.map((delivery) => (
                  <tr key={delivery.id}>
                    <td data-label="Time"><span style={{ fontSize: 11.5, color: "var(--muted)" }}>{formatDate(delivery.createdAt)}</span></td>
                    <td data-label="Channel">{channelNames.get(delivery.channelId) ?? "Deleted channel"}</td>
                    <td data-label="Event"><span className="mono" style={{ fontSize: 10.5 }}>{delivery.event}</span></td>
                    <td data-label="Status"><Badge tone={delivery.status === "sent" ? "success" : "danger"}>{delivery.status}</Badge></td>
                    <td data-label="Error"><span style={{ fontSize: 11.5, color: "var(--danger)" }}>{delivery.error ?? "—"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ChannelDialog
        open={dialogOpen}
        channel={editing}
        smtpReady={smtpReady}
        onClose={() => { setDialogOpen(false); setEditing(null); }}
      />

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Remove notification channel"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void confirmDelete()} loading={deleteChannel.isPending}>Remove channel</Button>
          </>
        }
      >
        <div style={{ color: "var(--muted)", fontSize: 12.5, lineHeight: 1.6 }}>
          Remove <strong style={{ color: "var(--text-soft)" }}>{deleteTarget?.name}</strong>? Its delivery history is deleted too.
        </div>
      </Dialog>
    </div>
  );
}

function ChannelDialog({
  open,
  channel,
  smtpReady,
  onClose,
}: {
  open: boolean;
  channel: NotificationChannelSummary | null;
  smtpReady: boolean;
  onClose: () => void;
}) {
  const createChannel = useCreateNotificationChannel();
  const updateChannel = useUpdateNotificationChannel();
  const toast = useToast();
  const [name, setName] = useState("");
  const [type, setType] = useState<NotificationChannelInput["type"]>("email");
  const [enabled, setEnabled] = useState(true);
  const [events, setEvents] = useState<string[]>(["operation.failed"]);
  const [to, setTo] = useState("");
  const [serverUrl, setServerUrl] = useState("https://ntfy.sh");
  const [topic, setTopic] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const config = channel?.config ?? {};
    setName(channel?.name ?? "");
    setType(channel?.type ?? "email");
    setEnabled(channel?.enabled ?? true);
    setEvents(channel?.events ?? ["operation.failed"]);
    setTo(Array.isArray(config.to) ? config.to.join(", ") : String(config.to ?? ""));
    setServerUrl(String(config.serverUrl ?? "https://ntfy.sh"));
    setTopic(String(config.topic ?? ""));
    setUrl(String(config.url ?? ""));
    setToken("");
    setFormError(null);
    createChannel.reset();
    updateChannel.reset();
    // Mutation objects are stable for the lifetime of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel]);

  const busy = createChannel.isPending || updateChannel.isPending;

  function toggleEvent(event: string) {
    setEvents((current) => current.includes(event) ? current.filter((value) => value !== event) : [...current, event]);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Give the channel a name.");
      return;
    }
    if (type === "email" && !to.trim()) {
      setFormError("Add at least one email recipient.");
      return;
    }
    if (type === "email" && !smtpReady) {
      setFormError("SMTP is not configured. Save mail settings first.");
      return;
    }
    if (type === "ntfy" && (!serverUrl.trim() || !topic.trim())) {
      setFormError("ntfy needs a server URL and topic.");
      return;
    }
    if (type === "webhook" && !url.trim()) {
      setFormError("Webhook needs a URL.");
      return;
    }
    const config = type === "email"
      ? { to: to.split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean) }
      : type === "ntfy"
        ? { serverUrl: serverUrl.trim(), topic: topic.trim() }
        : { url: url.trim() };
    const secret = token.trim() ? { token: token.trim() } : undefined;
    const body: NotificationChannelInput = {
      name: trimmedName,
      type,
      config,
      ...(secret ? { secret } : {}),
      events,
      enabled,
    };
    try {
      if (channel) {
        await updateChannel.mutateAsync({ id: channel.id, body: { ...body, secret: secret ?? undefined } });
        toast.success("Channel updated", `${trimmedName} is saved.`);
      } else {
        await createChannel.mutateAsync(body);
        toast.success("Channel created", `${trimmedName} will receive matching alerts.`);
      }
      setFormError(null);
      onClose();
    } catch (error) {
      setFormError(errorMessage(error, "The channel could not be saved."));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={channel ? "Edit notification channel" : "Add notification channel"}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="channel-form" variant="primary" loading={busy}>Save channel</Button>
        </>
      }
    >
      <form id="channel-form" onSubmit={save} style={{ display: "grid", gap: 16 }}>
        {formError ? (
          <div role="alert" style={{ padding: "9px 11px", borderRadius: 9, border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12 }}>
            {formError}
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <div>
            <label className="label" htmlFor="channel-name">Name</label>
            <Input id="channel-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ops email, Home ntfy, Deploy webhook" maxLength={120} />
          </div>
          <div>
            <label className="label" htmlFor="channel-type">Type</label>
            <select id="channel-type" className="select" value={type} onChange={(event) => setType(event.target.value as NotificationChannelInput["type"])}>
              <option value="email">Email</option>
              <option value="ntfy">ntfy</option>
              <option value="webhook">Webhook</option>
            </select>
          </div>
        </div>

        {type === "email" ? (
          <div>
            <label className="label" htmlFor="channel-email-to">Recipients</label>
            <Input id="channel-email-to" value={to} onChange={(event) => setTo(event.target.value)} placeholder="ops@example.com, me@example.com" autoComplete="off" />
            <div className="help">{smtpReady ? "Comma separated. Uses the SMTP server from the Mail tab." : "SMTP is not configured yet. Add it in the Mail tab before saving this channel."}</div>
          </div>
        ) : null}

        {type === "ntfy" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div>
              <label className="label" htmlFor="channel-ntfy-server">Server URL</label>
              <Input id="channel-ntfy-server" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://ntfy.sh" spellCheck={false} />
            </div>
            <div>
              <label className="label" htmlFor="channel-ntfy-topic">Topic</label>
              <Input id="channel-ntfy-topic" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="cetus-alerts" spellCheck={false} />
            </div>
          </div>
        ) : null}

        {type === "webhook" ? (
          <div>
            <label className="label" htmlFor="channel-webhook-url">Webhook URL</label>
            <Input id="channel-webhook-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/hooks/cetus" spellCheck={false} />
            <div className="help">Cetus posts <span className="mono">{"{ event, title, message, stackId, stackName, hostId }"}</span> as JSON.</div>
          </div>
        ) : null}

        {type !== "email" ? (
          <div>
            <label className="label" htmlFor="channel-token">Access token (optional)</label>
            <Input id="channel-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" placeholder={channel?.hasSecret ? "Saved. Leave blank to keep it." : "Sent as a bearer token"} />
            <div className="help">Stored encrypted. Leave blank to keep an existing token.</div>
          </div>
        ) : null}

        <div>
          <div className="section-title" style={{ marginBottom: 8 }}>Events</div>
          <div className="surface-soft" style={{ display: "grid", gap: 8, padding: "10px 12px" }}>
            {NOTIFICATION_EVENTS.map((event) => (
              <label key={event.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={events.includes(event.id)} onChange={() => toggleEvent(event.id)} style={{ marginTop: 2, accentColor: "var(--accent)" }} />
                <span>
                  <span style={{ fontSize: 12.5, fontWeight: 550 }}>{event.label}</span>
                  <span className="help" style={{ display: "block", margin: 0 }}>{event.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="help">Leave all unchecked to receive every event.</div>
        </div>

        <SwitchRow label="Enabled" description="Pause the channel without deleting it." checked={enabled} onChange={setEnabled} />
      </form>
    </Dialog>
  );
}


function RegistriesTab() {
  const me = useMe();
  const registries = useRegistries();
  const hosts = useHosts();
  const deleteRegistry = useDeleteRegistry();
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RegistryCredentialSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RegistryCredentialSummary | null>(null);
  const canWrite = can(me.data?.actor.scopes, "settings:write");

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(credential: RegistryCredentialSummary) {
    setEditing(credential);
    setDialogOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteRegistry.mutateAsync(deleteTarget.id);
      toast.success("Credential removed", `${deleteTarget.registry} no longer applies to its hosts.`);
      setDeleteTarget(null);
    } catch (error) {
      toast.error("Credential not removed", errorMessage(error, "The credential could not be deleted."));
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <LockKeyhole size={15} color="var(--accent)" />
            <h3>Registry credentials</h3>
            {registries.data ? <Badge>{registries.data.length}</Badge> : null}
          </div>
          {canWrite ? (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus size={14} /> Add credential
            </Button>
          ) : null}
        </div>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", color: "var(--muted)", fontSize: 12 }}>
          Store a token once, then use it for image update checks and pulls on the hosts you pick. Secrets are encrypted
          at rest and never returned to the browser.
        </div>

        {registries.isLoading ? (
          <RowsSkeleton rows={3} />
        ) : registries.isError ? (
          <ErrorState title="Registry credentials could not be loaded" error={registries.error} onRetry={() => registries.refetch()} retrying={registries.isFetching} />
        ) : !registries.data?.length ? (
          <EmptyState
            icon={<LockKeyhole size={20} />}
            title="No registry credentials"
            description="Add a GHCR or Docker Hub token so private images pull and update checks stop hitting anonymous rate limits."
            action={canWrite ? <Button variant="primary" onClick={openCreate}><Plus size={14} /> Add credential</Button> : undefined}
          />
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="data-table" aria-label="Registry credentials">
              <thead>
                <tr>
                  <th scope="col">Registry</th>
                  <th scope="col">Username</th>
                  <th scope="col">Hosts</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {registries.data.map((credential) => (
                  <tr key={credential.id}>
                    <td data-label="Registry"><span className="mono" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{credential.registry}</span></td>
                    <td data-label="Username">{credential.username}</td>
                    <td data-label="Hosts">
                      <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                        {credential.hosts.length
                          ? credential.hosts.map((host) => (
                              <span key={host.id} className="chip" style={{ fontSize: 10.5 }}>{host.name}</span>
                            ))
                          : <span style={{ color: "var(--muted)", fontSize: 11.5 }}>No matching hosts</span>}
                      </span>
                    </td>
                    <td data-label="Status">
                      <Badge tone={credential.enabled ? "success" : "default"}>{credential.enabled ? "Enabled" : "Paused"}</Badge>
                    </td>
                    <td data-label="Updated"><span style={{ fontSize: 11.5, color: "var(--muted)" }}>{relativeTime(credential.updatedAt)}</span></td>
                    <td data-label="Actions">
                      {canWrite ? (
                        <div className="user-row-actions">
                          <IconButton type="button" label={`Edit ${credential.registry}`} onClick={() => openEdit(credential)}>
                            <Pencil size={13} />
                          </IconButton>
                          <IconButton type="button" label={`Remove ${credential.registry}`} onClick={() => setDeleteTarget(credential)}>
                            <Trash2 size={13} />
                          </IconButton>
                        </div>
                      ) : <span style={{ color: "var(--muted)" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Server size={15} color="var(--accent)" />
            <h3>How hosts receive credentials</h3>
          </div>
        </div>
        <div className="panel-body" style={{ display: "grid", gap: 8, color: "var(--text-soft)", fontSize: 12.5 }}>
          <p style={{ margin: 0 }}>
            The manager writes its own <span className="mono">DOCKER_CONFIG</span> and sends each worker a matching
            config over the authenticated WebSocket. Workers keep the file at <span className="mono">0600</span> in
            their data directory.
          </p>
          <p className="help" style={{ margin: 0 }}>
            Use a personal access token with read access to packages. Leave the secret blank when editing to keep the
            saved one. A credential can target each host once per registry.
          </p>
        </div>
      </section>

      <RegistryDialog
        open={dialogOpen}
        credential={editing}
        hosts={hosts.data ?? []}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Remove registry credential"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void confirmDelete()} loading={deleteRegistry.isPending}>Remove credential</Button>
          </>
        }
      >
        <div style={{ color: "var(--muted)", fontSize: 12.5, lineHeight: 1.6 }}>
          Remove <strong style={{ color: "var(--text-soft)" }}>{deleteTarget?.username}</strong> for{" "}
          <span className="mono">{deleteTarget?.registry}</span>? Targeted hosts lose access the next time they pull.
        </div>
      </Dialog>
    </div>
  );
}

function RegistryDialog({
  open,
  credential,
  hosts,
  onClose,
}: {
  open: boolean;
  credential: RegistryCredentialSummary | null;
  hosts: HostSummary[];
  onClose: () => void;
}) {
  const save = useSaveRegistry();
  const toast = useToast();
  const [registry, setRegistry] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRegistry(credential?.registry ?? "");
    setUsername(credential?.username ?? "");
    setSecret("");
    setHostIds(credential?.hostIds ?? []);
    setEnabled(credential?.enabled ?? true);
    setFormError(null);
    save.reset();
    // Mutation objects are stable for the lifetime of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, credential]);

  function toggleHost(id: string) {
    setHostIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedRegistry = registry.trim();
    const trimmedUsername = username.trim();
    if (!trimmedRegistry) {
      setFormError("Enter a registry such as ghcr.io or docker.io.");
      return;
    }
    if (!trimmedUsername) {
      setFormError("Enter the registry username.");
      return;
    }
    if (!credential && !secret.trim()) {
      setFormError("Enter a password or access token for this credential.");
      return;
    }
    if (hostIds.length === 0) {
      setFormError("Select at least one host.");
      return;
    }
    const body: RegistryCredentialInput = {
      registry: trimmedRegistry,
      username: trimmedUsername,
      hostIds,
      enabled,
      ...(secret.trim() ? { secret: secret.trim() } : {}),
    };
    try {
      if (credential) {
        await save.mutateAsync({ id: credential.id, body });
        toast.success("Credential updated", `${trimmedRegistry} is saved for ${hostIds.length} host${hostIds.length === 1 ? "" : "s"}.`);
      } else {
        await save.mutateAsync({ body });
        toast.success("Credential created", `${trimmedRegistry} now applies to ${hostIds.length} host${hostIds.length === 1 ? "" : "s"}.`);
      }
      setFormError(null);
      onClose();
    } catch (error) {
      setFormError(errorMessage(error, "The credential could not be saved."));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={credential ? "Edit registry credential" : "Add registry credential"}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="registry-form" variant="primary" loading={save.isPending}>Save credential</Button>
        </>
      }
    >
      <form id="registry-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        {formError ? (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 11px", borderRadius: 9, border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12 }}>
            <AlertTriangle size={14} style={{ marginTop: 1, flex: "none" }} />
            <span>{formError}</span>
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <div>
            <label className="label" htmlFor="registry-host">Registry</label>
            <Input
              id="registry-host"
              value={registry}
              onChange={(event) => setRegistry(event.target.value)}
              placeholder="ghcr.io"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="help">Docker Hub, GHCR, or a self-hosted hostname with an optional port.</div>
          </div>
          <div>
            <label className="label" htmlFor="registry-username">Username</label>
            <Input
              id="registry-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="github-user"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="registry-secret">Password or access token</label>
          <Input
            id="registry-secret"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="new-password"
            placeholder={credential ? "Saved. Leave blank to keep it." : "Personal access token with package read"}
          />
          <div className="help">Stored with the Cetus master key. The value is never sent back to the browser.</div>
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <span className="label" style={{ marginBottom: 0 }}>Hosts</span>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>{hostIds.length} selected</span>
          </div>
          {hosts.length === 0 ? (
            <div className="help">No hosts are registered yet.</div>
          ) : (
            <div className="surface-soft" style={{ display: "grid", gap: 2, padding: "8px 10px", maxHeight: 220, overflow: "auto" }}>
              {hosts.map((host) => (
                <label
                  key={host.id}
                  style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 28, padding: "2px 3px", borderRadius: 6, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={hostIds.includes(host.id)}
                    onChange={() => toggleHost(host.id)}
                    style={{ width: 13, height: 13, accentColor: "var(--accent)", flex: "none" }}
                  />
                  <span style={{ fontSize: 12.5, fontWeight: 550 }}>{host.name}</span>
                  <Badge tone={host.kind === "local" ? "accent" : "default"}>{host.kind === "local" ? "Manager" : "Worker"}</Badge>
                  <span className="mono" style={{ marginLeft: "auto", color: "var(--muted-2)", fontSize: 10 }}>{host.slug}</span>
                </label>
              ))}
            </div>
          )}
          <div className="help">The manager uses its own selection locally. Workers receive only credentials that target them.</div>
        </div>

        <SwitchRow
          label="Enabled"
          description="Pause the credential without deleting it. Paused credentials are removed from host configs."
          checked={enabled}
          onChange={setEnabled}
        />
      </form>
    </Dialog>
  );
}


function UpdatesTab() {
  const me = useMe();
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const canWrite = can(me.data?.actor.scopes, "settings:write");

  if (settings.isLoading) return <PanelSkeleton rows={5} />;
  if (settings.isError || !settings.data) {
    return <ErrorPanel title="Update settings could not be loaded" error={settings.error} onRetry={() => settings.refetch()} retrying={settings.isFetching} />;
  }

  const config = settings.data.autoUpdate;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CalendarClock size={15} color="var(--accent)" />
            <h3>Global auto-update</h3>
            <Badge tone={config.enabled ? "success" : "default"}>{config.enabled ? "Fleet default on" : "Off"}</Badge>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setOpen(true)}
            disabled={!canWrite}
            aria-disabled={!canWrite}
            title={canWrite ? undefined : scopeReason("settings:write")}
          >
            <CalendarClock size={14} /> Configure
          </Button>
        </div>
        <div className="panel-body" style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0, color: "var(--text-soft)", fontSize: 13 }}>
            Default schedule: <strong>{scheduleLabel(config)}</strong>
          </p>
          <p className="help" style={{ margin: 0, maxWidth: "88ch" }}>
            Stacks without a custom schedule inherit this default. Cetus only pulls services with a changed digest. Open
            a stack's auto-update dialog to give it its own schedule, or uncheck services such as gluetun so they keep
            their current image.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
            <span className="chip">Health gate {config.healthCheck === false ? "off" : "on"}</span>
            <span className="chip">Rollback {config.rollback === false ? "off" : "on"}</span>
            <span className="chip mono">{config.cron}</span>
            <span className="chip">{config.timezone}</span>
          </div>
        </div>
      </section>

      <GlobalAutoUpdateDialog open={open} config={config} onClose={() => setOpen(false)} />
    </div>
  );
}

function BackupTab() {
  const me = useMe();
  const backups = useBackups();
  const create = useCreateBackup();
  const restore = useRestoreBackup();
  const remove = useDeleteBackup();
  const toast = useToast();
  const canWrite = can(me.data?.actor.scopes, "backup:write");
  const [restoreTarget, setRestoreTarget] = useState<BackupSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupSummary | null>(null);
  const [confirmText, setConfirmText] = useState("");

  if (backups.isLoading) return <PanelSkeleton rows={5} />;
  if (backups.isError || !backups.data) {
    return <ErrorPanel title="Backups could not be loaded" error={backups.error} onRetry={() => backups.refetch()} retrying={backups.isFetching} />;
  }

  async function runBackup() {
    try {
      const created = await create.mutateAsync();
      toast.success("Backup created", `${created.filename} · ${formatBytes(created.size)}`);
    } catch (error) {
      toast.error("Backup failed", errorMessage(error, "The API rejected the backup request."));
    }
  }

  async function stageRestore() {
    if (!restoreTarget) return;
    try {
      await restore.mutateAsync(restoreTarget.id);
      setRestoreTarget(null);
      setConfirmText("");
      toast.success("Restore staged", "Restart the manager to replace the database, keys, and stack files.");
    } catch (error) {
      toast.error("Restore not staged", errorMessage(error, "The API rejected the restore request."));
    }
  }

  async function removeBackup() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
      toast.success("Backup deleted", deleteTarget.filename);
    } catch (error) {
      toast.error("Backup not deleted", errorMessage(error, "The API rejected the delete request."));
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <DatabaseBackup size={15} color="var(--accent)" />
            <h3>Backups</h3>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone="accent">Local</Badge>
            {canWrite ? (
              <Button variant="primary" size="sm" onClick={() => void runBackup()} loading={create.isPending}>
                <Archive size={14} /> Run backup
              </Button>
            ) : null}
          </div>
        </div>
        <div className="card-body" style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <p className="help" style={{ margin: 0 }}>
            Each backup contains a consistent SQLite copy, the master key, the auth secret, and the stack files.
            Scheduled backups run daily at 03:00 server time and keep the newest 11. Restore stages the files and
            asks you to restart the manager.
          </p>
        </div>
        {backups.data.length === 0 ? (
          <EmptyState
            icon={<Archive size={20} />}
            title="No backups yet"
            description="Run a backup before upgrading the image or moving the instance."
          />
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="data-table" aria-label="Backups">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Backup</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th style={{ width: 280 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.data.map((backup) => (
                  <tr key={backup.id}>
                    <td>
                      <span title={formatDate(backup.createdAt)}>{relativeTime(backup.createdAt)}</span>
                      <div className="help">{backup.actorName || "system"}</div>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 11.5 }}>{backup.filename}</span>
                      {backup.error ? <div className="help" style={{ color: "var(--danger)" }}>{backup.error}</div> : null}
                    </td>
                    <td>{formatBytes(backup.size)}</td>
                    <td>
                      <Badge tone={backup.status === "complete" ? "success" : backup.status === "failed" ? "danger" : "info"}>
                        {titleCase(backup.status)}
                      </Badge>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, flexWrap: "nowrap" }}>
                        {backup.status === "complete" ? (
                          <>
                            <a
                              className="btn btn-ghost btn-sm"
                              href={`/api/backups/${backup.id}/download`}
                              download={`${backup.filename}.tar.gz`}
                              aria-label={`Download backup ${backup.filename}`}
                            >
                              <Download size={13} /> Download
                            </a>
                            {canWrite ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { setConfirmText(""); setRestoreTarget(backup); }}
                              >
                                <RotateCcw size={13} /> Restore
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                        {canWrite ? (
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(backup)}>
                            <Trash2 size={13} /> Delete
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(restoreTarget)}
        onClose={() => { setRestoreTarget(null); setConfirmText(""); }}
        title="Restore backup"
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setRestoreTarget(null); setConfirmText(""); }}>Cancel</Button>
            <Button
              variant="danger"
              disabled={confirmText !== "restore"}
              loading={restore.isPending}
              onClick={() => void stageRestore()}
            >
              Stage restore
            </Button>
          </>
        )}
      >
        <p style={{ marginTop: 0 }}>
          Restore <span className="mono">{restoreTarget?.filename}</span>? The current database, keys, and stack files
          are archived under <span className="mono">data/restore-previous</span> and <span className="mono">data/trash</span>.
          The manager must be restarted to apply the restore.
        </p>
        <label className="label" htmlFor="restore-confirm">Type <span className="mono">restore</span> to confirm</label>
        <Input
          id="restore-confirm"
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete backup"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => void removeBackup()}>
              Delete backup
            </Button>
          </>
        )}
      >
        <p style={{ marginTop: 0 }}>
          Delete <span className="mono">{deleteTarget?.filename}</span>? The archive is removed from disk and cannot
          be recovered.
        </p>
      </Dialog>
    </div>
  );
}

function GeneralTab() {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const scan = useScanStacks();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [savedReindex, setSavedReindex] = useState(false);
  const [form, setForm] = useState<SettingsForm | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    setForm({
      publicUrl: settings.data.publicUrl,
      stacksDir: settings.data.stacksDir,
      allowedOrigins: settings.data.allowedOrigins.join("\n"),
      trustProxy: settings.data.trustProxy,
    });
  }, [settings.data]);

  if (settings.isLoading) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <PanelSkeleton rows={5} />
        <PanelSkeleton rows={2} />
      </div>
    );
  }

  if (settings.isError || !settings.data) {
    return <ErrorPanel title="Settings could not be loaded" error={settings.error} onRetry={() => settings.refetch()} retrying={settings.isFetching} />;
  }

  if (!form) {
    return <PanelSkeleton rows={5} />;
  }

  const data = settings.data;
  const dirty =
    form.publicUrl !== data.publicUrl ||
    form.stacksDir !== data.stacksDir ||
    form.allowedOrigins.trim() !== data.allowedOrigins.join("\n") ||
    form.trustProxy !== data.trustProxy;

  function patch<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const origins = form.allowedOrigins
        .split(/[\n,]+/)
        .map((value) => value.trim())
        .filter(Boolean);
      const result = await api.updateSettings({
        publicUrl: form.publicUrl,
        stacksDir: form.stacksDir,
        allowedOrigins: origins,
        trustProxy: form.trustProxy,
      });
      setSavedReindex(result.reindexRequired);
      setForm({
        publicUrl: result.settings.publicUrl,
        stacksDir: result.settings.stacksDir,
        allowedOrigins: result.settings.allowedOrigins.join("\n"),
        trustProxy: result.settings.trustProxy,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toast.success("Settings saved", result.changed.length ? `Updated ${result.changed.join(", ")}.` : "No values changed.");
    } catch (error) {
      toast.error("Settings not saved", errorMessage(error, "The API rejected the update."));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!settings.data) return;
    setForm({
      publicUrl: settings.data.publicUrl,
      stacksDir: settings.data.stacksDir,
      allowedOrigins: settings.data.allowedOrigins.join("\n"),
      trustProxy: settings.data.trustProxy,
    });
    setSavedReindex(false);
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16, alignItems: "start" }}>
        <section className="panel">
          <div className="panel-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Server size={15} color="var(--accent)" />
              <h3>Instance</h3>
            </div>
            <Badge tone="accent">Database-backed</Badge>
          </div>
          <div className="settings-form">
            <label className="field">
              <span className="label">Public URL</span>
              <Input
                value={form.publicUrl}
                onChange={(event) => patch("publicUrl", event.target.value)}
                placeholder="https://cetus.example.com"
                spellCheck={false}
              />
              <span className="help">Used for links, worker enrollment, and MCP examples. Auth restarts still use the issuer from boot.</span>
            </label>
            <label className="field">
              <span className="label">Stacks directory</span>
              <Input
                value={form.stacksDir}
                onChange={(event) => patch("stacksDir", event.target.value)}
                placeholder="/opt/stacks"
                spellCheck={false}
                className="mono"
                disabled={data.stacksDirLocked}
                title={data.stacksDirLocked ? "Locked because Docker is detected" : undefined}
              />
              <span className="help">
                {data.stacksDirLocked
                  ? "Locked because Docker is detected. Set CETUS_ALLOW_STACKS_DIR_CHANGE=true to override."
                  : "Absolute path on the manager. Save, then rescan the folder to reindex existing stacks."}
              </span>
              {data.stacksDirLocked ? (
                <span className="settings-lock"><LockKeyhole size={11} /> locked by Docker detection</span>
              ) : null}
            </label>
            <label className="field">
              <span className="label">Allowed origins</span>
              <textarea
                className="textarea mono"
                value={form.allowedOrigins}
                onChange={(event) => patch("allowedOrigins", event.target.value)}
                placeholder={"https://cetus.example.com"}
                spellCheck={false}
                rows={3}
              />
              <span className="help">One origin per line, or comma separated. Local development origins are always allowed.</span>
            </label>
            {form.publicUrl !== data.authPublicUrl ? (
              <div className="settings-warning">
                <AlertTriangle size={14} />
                <span>Public URL changed. Restart the API to move the better-auth issuer to the new URL.</span>
              </div>
            ) : null}
          </div>
          <div className="settings-toggles">
            <SwitchRow
              label="Trust proxy"
              description="Honor X-Forwarded-For and X-Real-IP from SWAG, Caddy, or Cloudflare."
              checked={form.trustProxy}
              onChange={(value) => patch("trustProxy", value)}
            />
          </div>
          <div className="settings-actions">
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || saving}>
              <Check size={14} /> Save changes
            </Button>
            <Button variant="ghost" onClick={reset} disabled={!dirty || saving}>Reset</Button>
            {dirty ? <span className="help">Unsaved changes</span> : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <FolderOpen size={15} color="var(--accent)" />
              <h3>Bootstrap</h3>
            </div>
            <Badge>Environment</Badge>
          </div>
          <div style={{ margin: 0 }}>
            <SettingRow icon={<Fingerprint size={14} />} label="Version" hint="Build reported by the API">
              <span className="mono" style={{ fontSize: 12 }}>{data.version}</span>
            </SettingRow>
            <SettingRow icon={<Globe size={14} />} label="Auth issuer" hint="Public URL captured at process start">
              <span className="mono" style={{ fontSize: 11, overflowWrap: "anywhere", textAlign: "right" }}>{data.authPublicUrl}</span>
            </SettingRow>
            <SettingRow icon={<Server size={14} />} label="Bind" hint="Port and address from CETUS_PORT and CETUS_HOST">
              <span className="mono" style={{ fontSize: 11.5 }}>{data.bootstrap.host}:{data.bootstrap.port}</span>
            </SettingRow>
            <SettingRow icon={<FolderOpen size={14} />} label="Data directory" hint="Database, auth material, operation logs, and trash">
              <span className="mono" style={{ fontSize: 11, overflowWrap: "anywhere", textAlign: "right" }}>{data.bootstrap.dataDir}</span>
              <CopyButton value={data.bootstrap.dataDir} label="Data path copied" buttonLabel="Copy data path" description={data.bootstrap.dataDir} />
            </SettingRow>
            <SettingRow icon={<Boxes size={14} />} label="Database" hint="SQLite file">
              <span className="mono" style={{ fontSize: 11, overflowWrap: "anywhere", textAlign: "right" }}>{data.bootstrap.dbPath}</span>
              <CopyButton value={data.bootstrap.dbPath} label="Database path copied" buttonLabel="Copy database path" description={data.bootstrap.dbPath} />
            </SettingRow>
            <SettingRow icon={<Info size={14} />} label="Mode" hint="NODE_ENV at process start">
              <Badge tone={data.bootstrap.mode === "production" ? "success" : "default"}>{data.bootstrap.mode}</Badge>
            </SettingRow>
          </div>
          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", color: "var(--muted)", fontSize: 11.5 }}>
            These values are resolved at process start. Change the container environment and restart to move the database or data directory.
          </div>
        </section>
      </div>

      {savedReindex ? (
        <div className="settings-warning" style={{ justifyContent: "space-between" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <FolderOpen size={14} /> Stacks directory changed. Reindex to apply it to the stack list.
          </span>
          <Button
            size="sm"
            onClick={() => scan.mutate(undefined, {
              onSuccess: (result) => {
                setSavedReindex(false);
                toast.success("Stacks reindexed", `${result.count} compose stacks scanned.`);
              },
              onError: (error) => toast.error("Scan failed", errorMessage(error, "Could not scan the new directory.")),
            })}
            loading={scan.isPending}
          >
            Rescan stacks
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  onChange,
  tone,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  tone?: "warn";
}) {
  return (
    <div className="settings-switch-row">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
        <div className="help" style={{ marginTop: 2 }}>{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="settings-switch"
        data-on={checked}
        data-tone={tone}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function AccessTab() {
  const users = useUsers();
  const invites = useInvites();
  const me = useMe();
  const settings = useSettings();
  const updateUser = useUpdateUser();
  const revokeInvite = useRevokeInvite();
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserSummary | null>(null);
  const [resetUser, setResetUser] = useState<UserSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);

  const currentUserId = me.data?.user?.id ?? null;
  const currentRole = me.data?.user?.role ?? null;
  const canManage = can(me.data?.actor.scopes, "users:write");
  const rows = useMemo(() => {
    return [...(users.data ?? [])].sort((a, b) => {
      const roleDelta = ROLE_ORDER.indexOf(a.role as Role) - ROLE_ORDER.indexOf(b.role as Role);
      return roleDelta || a.name.localeCompare(b.name);
    });
  }, [users.data]);
  const pendingInvites = invites.data ?? [];
  const activeInvites = pendingInvites.filter((invite) => !invite.expired).length;
  const smtpReady = Boolean(settings.data?.smtp.enabled && settings.data.smtp.host && settings.data.smtp.fromEmail);
  const rolePendingId = updateUser.isPending && updateUser.variables?.body.role !== undefined
    ? updateUser.variables.id
    : null;

  async function changeRole(user: UserSummary, role: Role) {
    if (role === user.role) return;
    try {
      await updateUser.mutateAsync({ id: user.id, body: { role } });
      toast.success("Role updated", `${user.name} is now ${titleCase(role).toLowerCase()}.`);
    } catch (error) {
      toast.error("Role not changed", errorMessage(error, "The API rejected the role change."));
      void users.refetch();
    }
  }

  async function revoke(inviteId: string, email: string) {
    try {
      await revokeInvite.mutateAsync(inviteId);
      toast.success("Invite revoked", `${email} can no longer use that link.`);
    } catch (error) {
      toast.error("Invite not revoked", errorMessage(error, "The invite could not be revoked."));
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Users size={15} color="var(--accent)" />
            <h3>Users</h3>
            {users.data ? <Badge>{users.data.length}</Badge> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {me.data?.user ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 11 }}>
                <UserRound size={12} /> {me.data.user.name}
              </span>
            ) : null}
            {canManage ? (
              <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
                <UserPlus size={14} /> Add user
              </Button>
            ) : null}
          </div>
        </div>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", color: "var(--muted)", fontSize: 12 }}>
          Accounts, roles, and access are managed here. Invite links are one-time and expire after seven days. No email service is required.
        </div>

        {users.isLoading ? (
          <RowsSkeleton rows={4} />
        ) : users.isError ? (
          <ErrorState title="Users could not be loaded" error={users.error} onRetry={() => users.refetch()} retrying={users.isFetching} />
        ) : !rows.length ? (
          <EmptyState
            icon={<Users size={20} />}
            title="No users yet"
            description="Create the first account here. Roles decide what that account can see and operate."
            action={canManage ? <Button variant="primary" onClick={() => setAddOpen(true)}><UserPlus size={14} /> Add user</Button> : undefined}
          />
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="data-table" aria-label="Instance users">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Created</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => {
                  const isYou = user.id === currentUserId;
                  const role = (ROLE_META[user.role as Role] ? user.role : "viewer") as Role;
                  return (
                    <tr key={user.id}>
                      <td data-label="Name">
                        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                          <strong style={{ fontWeight: 600 }}>{user.name}</strong>
                          {isYou ? <Badge tone="accent">You</Badge> : null}
                        </div>
                      </td>
                      <td data-label="Email">
                        <span className="mono" style={{ fontSize: 11.5, overflowWrap: "anywhere" }}>{user.email}</span>
                      </td>
                      <td data-label="Role">
                        {canManage && !isYou ? (
                          <select
                            className="select user-role-select"
                            aria-label={`Role for ${user.name}`}
                            value={role}
                            disabled={updateUser.isPending}
                            onChange={(event) => void changeRole(user, event.target.value as Role)}
                          >
                            {ROLE_ORDER.map((entry) => <option key={entry} value={entry}>{titleCase(entry)}</option>)}
                          </select>
                        ) : (
                          <span title={isYou ? "Ask another admin to change your role." : undefined}>
                            <Badge tone={ROLE_META[role].tone}>{titleCase(role)}</Badge>
                          </span>
                        )}
                        {rolePendingId === user.id ? <span className="help" style={{ marginTop: 3 }}>Saving…</span> : null}
                      </td>
                      <td data-label="Created">
                        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{formatDate(user.createdAt)}</span>
                      </td>
                      <td data-label="Actions">
                        {canManage ? (
                          <div className="user-row-actions">
                            <IconButton type="button" label={`Edit ${user.name}`} onClick={() => setEditUser(user)}>
                              <Pencil size={13} />
                            </IconButton>
                            <IconButton type="button" label={`Reset password for ${user.name}`} onClick={() => setResetUser(user)}>
                              <KeyRound size={13} />
                            </IconButton>
                            <IconButton
                              type="button"
                              label={`Remove ${user.name}`}
                              disabled={isYou}
                              title={isYou ? "You cannot remove your own account." : undefined}
                              onClick={() => setDeleteTarget(user)}
                            >
                              <Trash2 size={13} />
                            </IconButton>
                          </div>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <MailPlus size={15} color="var(--accent)" />
            <h3>Invites</h3>
            {invites.data ? <Badge>{activeInvites} active</Badge> : null}
          </div>
          {canManage ? (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Link2 size={13} /> New invite
            </Button>
          ) : null}
        </div>

        {invites.isLoading ? (
          <RowsSkeleton rows={2} />
        ) : invites.isError ? (
          <ErrorState title="Invites could not be loaded" error={invites.error} onRetry={() => invites.refetch()} retrying={invites.isFetching} />
        ) : !pendingInvites.length ? (
          <EmptyState
            icon={<MailPlus size={20} />}
            title="No pending invites"
            description="Create a one-time link for someone who should join this instance. Copy it into your normal chat or email."
          />
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="data-table" aria-label="Pending invites">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Invited by</th>
                  <th scope="col">Expires</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingInvites.map((invite) => (
                  <tr key={invite.id}>
                    <td data-label="Email">
                      <span className="mono" style={{ fontSize: 11.5, overflowWrap: "anywhere" }}>{invite.email}</span>
                      {invite.name ? <div style={{ color: "var(--muted)", fontSize: 10.5 }}>{invite.name}</div> : null}
                    </td>
                    <td data-label="Role">
                      <Badge tone={ROLE_META[invite.role as Role]?.tone ?? "default"}>{titleCase(invite.role)}</Badge>
                    </td>
                    <td data-label="Invited by"><span style={{ fontSize: 11.5 }}>{invite.invitedBy}</span></td>
                    <td data-label="Expires">
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{formatExpiry(invite.expiresAt)}</span>
                        <Badge tone={invite.expired ? "warn" : "success"}>{invite.expired ? "Expired" : "Active"}</Badge>
                      </div>
                    </td>
                    <td data-label="Actions">
                      {canManage ? (
                        <div className="user-row-actions">
                          <IconButton
                            type="button"
                            label={`Revoke invite for ${invite.email}`}
                            disabled={revokeInvite.isPending}
                            onClick={() => void revoke(invite.id, invite.email)}
                          >
                            <Trash2 size={13} />
                          </IconButton>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ShieldCheck size={15} color="var(--accent)" />
            <h3>Roles and scopes</h3>
          </div>
          <span style={{ color: "var(--muted)", fontSize: 11 }}>Fixed by role</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          {ROLE_ORDER.map((role) => {
            const meta = ROLE_META[role];
            const scopes = ROLE_SCOPES[role];
            return (
              <div
                key={role}
                style={{
                  minWidth: 0,
                  padding: "14px 16px",
                  borderRight: "1px solid var(--border)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <Badge tone={meta.tone}>{titleCase(role)}</Badge>
                  {currentRole === role ? <Badge tone="accent">Your role</Badge> : null}
                  <span className="mono" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 10.5 }}>
                    {scopes.length} scopes
                  </span>
                </div>
                <p style={{ margin: "8px 0 10px", color: "var(--muted)", fontSize: 12, lineHeight: 1.5, minHeight: 38 }}>
                  {meta.description}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {scopes.map((scope) => (
                    <ScopeToken key={scope} scope={scope} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <AddUserDialog open={addOpen} smtpReady={smtpReady} onClose={() => setAddOpen(false)} />
      <EditUserDialog user={editUser} onClose={() => setEditUser(null)} />
      <ResetPasswordDialog user={resetUser} onClose={() => setResetUser(null)} />
      <DeleteUserDialog user={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </div>
  );
}

function AddUserDialog({ open, smtpReady, onClose }: { open: boolean; smtpReady: boolean; onClose: () => void }) {
  const createInvite = useCreateInvite();
  const createUser = useCreateUser();
  const toast = useToast();
  const [mode, setMode] = useState<"invite" | "password">("invite");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [password, setPassword] = useState("");
  const [sendEmail, setSendEmail] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<InviteCreated | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode("invite");
    setName("");
    setEmail("");
    setRole("viewer");
    setPassword("");
    setSendEmail(smtpReady);
    setFormError(null);
    setCreated(null);
    setCopied(false);
  }, [open, smtpReady]);

  const busy = createInvite.isPending || createUser.isPending;

  function close() {
    setCreated(null);
    setFormError(null);
    onClose();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setFormError("Enter the email for the new account.");
      return;
    }
    if (mode === "password" && !trimmedName) {
      setFormError("Enter a name for the new account.");
      return;
    }
    if (mode === "password" && password.length < 8) {
      setFormError("Use at least 8 characters for the temporary password.");
      return;
    }
    setFormError(null);
    try {
      if (mode === "invite") {
        const result = await createInvite.mutateAsync({
          email: normalizedEmail,
          ...(trimmedName ? { name: trimmedName } : {}),
          role,
          sendEmail: sendEmail && smtpReady,
        });
        setCreated(result);
      } else {
        await createUser.mutateAsync({ name: trimmedName, email: normalizedEmail, password, role });
        toast.success("User created", `${trimmedName} can sign in with the password you set.`);
        close();
      }
    } catch (error) {
      setFormError(errorMessage(error, "The account could not be provisioned."));
    }
  }

  async function copyLink() {
    if (!created) return;
    if (await copyToClipboard(created.url)) {
      setCopied(true);
      toast.success("Invite link copied", "Send it to the person you want to invite.");
    } else {
      toast.error("Copy failed", "Select the link and copy it manually.");
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={created ? "Invite link" : "Add user"}
      footer={
        created ? (
          <>
            <Button variant="ghost" onClick={close}>Done</Button>
            <Button variant="primary" onClick={() => void copyLink()}>
              <Copy size={14} /> {copied ? "Copied" : "Copy link"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button
              type="submit"
              form="add-user-form"
              variant="primary"
              loading={busy}
            >
              {mode === "invite" ? <><MailPlus size={14} /> Create invite</> : <><UserPlus size={14} /> Create user</>}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 9, background: "var(--success-soft)", border: "1px solid color-mix(in oklab, var(--success) 30%, transparent)", color: "var(--success)", fontSize: 12.5, fontWeight: 600 }}>
            <Check size={15} /> Invite ready for {created.invite.email}
          </div>
          <div>
            <label className="label" htmlFor="invite-link">One-time link</label>
            <Input
              id="invite-link"
              className="mono"
              value={created.url}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              style={{ fontSize: 11.5 }}
            />
            <div className="help">
              Expires {formatExpiry(created.invite.expiresAt)}. The link can be used once. It grants {titleCase(created.invite.role).toLowerCase()} access when accepted.
            </div>
          </div>
          <div className="surface-soft" style={{ padding: "9px 11px", color: created.emailSent ? "var(--success)" : "var(--muted)", fontSize: 12 }}>
            {created.emailSent
              ? `Invite emailed to ${created.invite.email}.`
              : created.emailError
                ? created.emailError
                : "Copy this link into your normal chat or email."}
          </div>
        </div>
      ) : (
        <form id="add-user-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
          <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
          {formError ? (
            <div
              role="alert"
              style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 11px", borderRadius: 9, border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12 }}
            >
              <AlertTriangle size={14} style={{ marginTop: 1, flex: "none" }} />
              <span>{formError}</span>
            </div>
          ) : null}

          <div className="tabs" role="group" aria-label="Provisioning method" style={{ width: "fit-content" }}>
            <button type="button" className="tab" data-active={mode === "invite"} aria-pressed={mode === "invite"} onClick={() => { setMode("invite"); setFormError(null); }}>
              <MailPlus size={13} /> Invite link
            </button>
            <button type="button" className="tab" data-active={mode === "password"} aria-pressed={mode === "password"} onClick={() => { setMode("password"); setFormError(null); }}>
              <KeyRound size={13} /> Set password
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div>
              <label className="label" htmlFor="add-user-name">Name {mode === "password" ? <span aria-hidden="true">*</span> : <span style={{ color: "var(--muted)", fontWeight: 400 }}>(optional)</span>}</label>
              <Input
                id="add-user-name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Jordan Lee"
                autoComplete="name"
                maxLength={80}
                required={mode === "password"}
              />
            </div>
            <div>
              <label className="label" htmlFor="add-user-email">Email <span aria-hidden="true">*</span></label>
              <Input
                id="add-user-email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="jordan@example.com"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="add-user-role">Role</label>
              <select id="add-user-role" name="role" className="select" value={role} onChange={(event) => setRole(event.target.value as Role)}>
                {ROLE_ORDER.map((entry) => <option key={entry} value={entry}>{titleCase(entry)}</option>)}
              </select>
              <div className="help">{ROLE_META[role].description}</div>
            </div>
          </div>

          {mode === "password" ? (
            <div>
              <label className="label" htmlFor="add-user-password">Temporary password <span aria-hidden="true">*</span></label>
              <Input
                id="add-user-password"
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                maxLength={200}
                required
              />
              <div className="help">At least 8 characters. Share it through your normal channel. The user can be given a new one from this page at any time.</div>
            </div>
          ) : null}

          {mode === "invite" ? (
            <div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, cursor: smtpReady ? "pointer" : "default" }}>
                <input
                  type="checkbox"
                  checked={sendEmail}
                  disabled={!smtpReady}
                  onChange={(event) => setSendEmail(event.target.checked)}
                  style={{ accentColor: "var(--accent)" }}
                />
                Email this invite to the recipient
              </label>
              <div className="help">
                {smtpReady
                  ? "Uses the SMTP server from Settings > Mail. The link is still shown once here."
                  : "Configure SMTP in Settings > Mail to email invites. You can copy the link instead."}
              </div>
            </div>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}

function EditUserDialog({ user, onClose }: { user: UserSummary | null; onClose: () => void }) {
  const me = useMe();
  const updateUser = useUpdateUser();
  const toast = useToast();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [formError, setFormError] = useState<string | null>(null);
  const isSelf = user?.id === me.data?.user?.id;

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setRole((ROLE_META[user.role as Role] ? user.role : "viewer") as Role);
    setFormError(null);
    updateUser.reset();
    // updateUser is stable for the lifetime of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("Name is required.");
      return;
    }
    try {
      await updateUser.mutateAsync({
        id: user.id,
        body: { name: trimmed, ...(isSelf ? {} : { role }) },
      });
      toast.success("User updated", `${trimmed} is saved.`);
      setFormError(null);
      onClose();
    } catch (error) {
      setFormError(errorMessage(error, "The user could not be updated."));
    }
  }

  return (
    <Dialog
      open={Boolean(user)}
      onClose={onClose}
      title="Edit user"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="edit-user-form" variant="primary" loading={updateUser.isPending}>Save changes</Button>
        </>
      }
    >
      <form id="edit-user-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        {formError ? (
          <div role="alert" style={{ padding: "9px 11px", borderRadius: 9, border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12 }}>
            {formError}
          </div>
        ) : null}
        <div>
          <label className="label" htmlFor="edit-user-name">Name</label>
          <Input
            id="edit-user-name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            maxLength={80}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="edit-user-email">Email</label>
          <Input id="edit-user-email" value={user?.email ?? ""} readOnly autoComplete="email" />
          <div className="help">Email addresses are the sign-in identity and cannot be changed here.</div>
        </div>
        <div>
          <label className="label" htmlFor="edit-user-role">Role</label>
          <select id="edit-user-role" className="select" value={role} disabled={isSelf} onChange={(event) => setRole(event.target.value as Role)}>
            {ROLE_ORDER.map((entry) => <option key={entry} value={entry}>{titleCase(entry)}</option>)}
          </select>
          <div className="help">{isSelf ? "Ask another admin to change your role." : ROLE_META[role].description}</div>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserSummary | null; onClose: () => void }) {
  const me = useMe();
  const updateUser = useUpdateUser();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const isSelf = user?.id === me.data?.user?.id;

  useEffect(() => {
    if (!user) return;
    setPassword("");
    setConfirm("");
    setFormError(null);
    updateUser.reset();
    // updateUser is stable for the lifetime of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user) return;
    if (password.length < 8) {
      setFormError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setFormError("The two passwords do not match.");
      return;
    }
    try {
      await updateUser.mutateAsync({ id: user.id, body: { password } });
      toast.success(isSelf ? "Password changed" : "Password reset", isSelf ? "Use the new password next time you sign in." : `${user.name}'s active sessions were signed out.`);
      setFormError(null);
      onClose();
    } catch (error) {
      setFormError(errorMessage(error, "The password could not be changed."));
    }
  }

  return (
    <Dialog
      open={Boolean(user)}
      onClose={onClose}
      title={isSelf ? "Change your password" : "Reset password"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="reset-password-form" variant="primary" loading={updateUser.isPending}>
            {isSelf ? "Change password" : "Reset password"}
          </Button>
        </>
      }
    >
      <form id="reset-password-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        <input type="text" name="username" autoComplete="username" value={user?.email ?? ""} readOnly hidden />
        {formError ? (
          <div role="alert" style={{ padding: "9px 11px", borderRadius: 9, border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12 }}>
            {formError}
          </div>
        ) : null}
        <div style={{ color: "var(--muted)", fontSize: 12.5 }}>
          {isSelf ? "Set a new password for your account." : <>Set a new password for <strong style={{ color: "var(--text-soft)" }}>{user?.name}</strong>. Their current sessions will be signed out.</>}
        </div>
        <div>
          <label className="label" htmlFor="reset-password">New password</label>
          <Input
            id="reset-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            required
          />
          <div className="help">At least 8 characters.</div>
        </div>
        <div>
          <label className="label" htmlFor="reset-password-confirm">Confirm new password</label>
          <Input
            id="reset-password-confirm"
            name="confirm"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            required
          />
        </div>
      </form>
    </Dialog>
  );
}

function DeleteUserDialog({ user, onClose }: { user: UserSummary | null; onClose: () => void }) {
  const deleteUser = useDeleteUser();
  const toast = useToast();
  const [confirm, setConfirm] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setConfirm("");
    setFormError(null);
    deleteUser.reset();
    // deleteUser is stable for the lifetime of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user) return;
    if (confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
      setFormError("Type the account email exactly to confirm.");
      return;
    }
    try {
      await deleteUser.mutateAsync(user.id);
      toast.success("User removed", `${user.name} can no longer sign in.`);
      setFormError(null);
      onClose();
    } catch (error) {
      setFormError(errorMessage(error, "The user could not be removed."));
    }
  }

  return (
    <Dialog
      open={Boolean(user)}
      onClose={onClose}
      title="Remove user"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="delete-user-form" variant="danger" loading={deleteUser.isPending}>Remove user</Button>
        </>
      }
    >
      <form id="delete-user-form" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
        {formError ? (
          <div role="alert" style={{ padding: "9px 11px", borderRadius: 9, border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12 }}>
            {formError}
          </div>
        ) : null}
        <div style={{ color: "var(--muted)", fontSize: 12.5, lineHeight: 1.6 }}>
          This permanently removes <strong style={{ color: "var(--text-soft)" }}>{user?.name}</strong> and signs out every session. API keys they created stay intact.
        </div>
        <div>
          <label className="label" htmlFor="delete-user-confirm">Type <span className="mono">{user?.email}</span> to confirm</label>
          <Input
            id="delete-user-confirm"
            name="confirm"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </div>
      </form>
    </Dialog>
  );
}


function KeysTab({ onCreate }: { onCreate: () => void }) {
  const keys = useKeys();
  const revoke = useRevokeKey();
  const remove = useDeleteKey();
  const prune = usePruneRevokedKeys();
  const toast = useToast();
  const [revokeTarget, setRevokeTarget] = useState<ApiKeySummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeySummary | null>(null);
  const [pruneOpen, setPruneOpen] = useState(false);

  const rows = useMemo(() => {
    return [...(keys.data ?? [])].sort((a, b) => {
      const aRevoked = Boolean(a.revokedAt);
      const bRevoked = Boolean(b.revokedAt);
      if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [keys.data]);

  const activeCount = rows.filter((key) => {
    if (key.revokedAt) return false;
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return false;
    return true;
  }).length;
  const revokedCount = rows.filter((key) => Boolean(key.revokedAt)).length;

  function isInactive(key: ApiKeySummary) {
    return Boolean(key.revokedAt) || Boolean(key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now());
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast.success("API key deleted", `"${deleteTarget.name}" was removed from the list.`);
      setDeleteTarget(null);
    } catch (error) {
      toast.error("Delete failed", errorMessage(error, "Could not delete the key."));
    }
  }

  async function confirmPrune() {
    try {
      const result = await prune.mutateAsync();
      toast.success("Revoked keys deleted", `${result.count} key${result.count === 1 ? "" : "s"} removed.`);
      setPruneOpen(false);
    } catch (error) {
      toast.error("Cleanup failed", errorMessage(error, "Could not delete the revoked keys."));
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    try {
      await revoke.mutateAsync(revokeTarget.id);
      toast.success("API key revoked", `"${revokeTarget.name}" can no longer authenticate.`);
      setRevokeTarget(null);
    } catch (error) {
      toast.error("Revoke failed", errorMessage(error, "Could not revoke the key."));
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <KeyRound size={15} color="var(--accent)" />
            <h3>API keys</h3>
            {keys.data ? <Badge>{keys.data.length}</Badge> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {revokedCount > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setPruneOpen(true)}>
                <Trash2 size={13} /> Delete revoked ({revokedCount})
              </Button>
            ) : null}
            <Button variant="primary" size="sm" onClick={onCreate}>
              <Plus size={14} /> Create key
            </Button>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 16px", borderBottom: "1px solid var(--border)", color: "var(--muted)", fontSize: 12 }}>
          <span>Scoped credentials for the API and MCP.</span>
          {keys.data ? (
            <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5 }}>
              {activeCount} active / {keys.data.length} total
            </span>
          ) : null}
        </div>

        {keys.isLoading ? (
          <RowsSkeleton rows={6} />
        ) : keys.isError ? (
          <ErrorState title="API keys could not be loaded" error={keys.error} onRetry={() => keys.refetch()} retrying={keys.isFetching} />
        ) : !rows.length ? (
          <EmptyState
            icon={<KeyRound size={20} />}
            title="No API keys yet"
            description="Create a scoped key for automation, CI, or an MCP client. The full secret is shown once."
            action={<Button variant="primary" onClick={onCreate}><Plus size={14} /> Create key</Button>}
          />
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="data-table" aria-label="API keys">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Targets</th>
                  <th scope="col">Created by</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Expiry / status</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((key) => (
                  <tr key={key.id}>
                    <td data-label="Name">
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <strong style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{key.name}</strong>
                        {isMcpKey(key) ? <Badge tone="accent"><Terminal size={10} /> MCP</Badge> : null}
                      </div>
                      <div className="mono" style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 2 }}>
                        cetus_{key.prefix}.…
                      </div>
                    </td>
                    <td data-label="Scopes"><KeyScopes scopes={key.scopes} /></td>
                    <td data-label="Targets"><KeyTargets apiKey={key} /></td>
                    <td data-label="Created by">
                      <div style={{ fontSize: 11.5 }}>{key.createdBy || "unknown"}</div>
                      <div style={{ color: "var(--muted)", fontSize: 10.5 }}>{formatDate(key.createdAt)}</div>
                    </td>
                    <td data-label="Last used">
                      <span title={key.lastUsedAt ? formatDate(key.lastUsedAt) : undefined} style={{ fontSize: 11.5, color: key.lastUsedAt ? "var(--text-soft)" : "var(--muted)" }}>
                        {key.lastUsedAt ? relativeTime(key.lastUsedAt) : "Never"}
                      </span>
                    </td>
                    <td data-label="Expiry / status"><KeyValidity apiKey={key} /></td>
                    <td data-label="Actions" style={{ textAlign: "right" }}>
                      {isInactive(key) ? (
                        <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(key)}>
                          <Trash2 size={12} /> Delete
                        </Button>
                      ) : (
                        <Button size="sm" variant="danger" onClick={() => setRevokeTarget(key)}>
                          <Ban size={12} /> Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke API key"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmRevoke} loading={revoke.isPending}>
              <Ban size={14} /> Revoke key
            </Button>
          </>
        }
      >
        {revokeTarget ? (
          <div style={{ display: "grid", gap: 12 }}>
            <p style={{ margin: 0, color: "var(--text-soft)" }}>
              Revoke <strong>{revokeTarget.name}</strong>{" "}
              <span className="mono" style={{ color: "var(--muted)", fontSize: 11.5 }}>cetus_{revokeTarget.prefix}.…</span>?
              Clients using it lose access immediately. This cannot be undone.
            </p>
            {isMcpKey(revokeTarget) ? (
              <div className="badge badge-warn" style={{ alignSelf: "flex-start" }}>
                <Terminal size={11} /> MCP clients will fail on their next call
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete API key"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete} loading={remove.isPending}>
              <Trash2 size={14} /> Delete key
            </Button>
          </>
        }
      >
        {deleteTarget ? (
          <p style={{ margin: 0, color: "var(--text-soft)", lineHeight: 1.6 }}>
            Permanently delete <strong>{deleteTarget.name}</strong>{" "}
            <span className="mono" style={{ color: "var(--muted)", fontSize: 11.5 }}>cetus_{deleteTarget.prefix}.…</span>?
            This key is {deleteTarget.revokedAt ? "revoked" : "expired"} and cannot authenticate. Deleting removes its
            metadata from this list permanently.
          </p>
        ) : null}
      </Dialog>

      <Dialog
        open={pruneOpen}
        onClose={() => setPruneOpen(false)}
        title="Delete revoked keys"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPruneOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={confirmPrune} loading={prune.isPending}>
              <Trash2 size={14} /> Delete {revokedCount} key{revokedCount === 1 ? "" : "s"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, color: "var(--text-soft)", lineHeight: 1.6 }}>
          Permanently delete {revokedCount} revoked key{revokedCount === 1 ? "" : "s"}. They are already unable to
          authenticate. This cannot be undone.
        </p>
      </Dialog>
    </>
  );
}

function McpTab({ onCreate }: { onCreate: () => void }) {
  const settings = useSettings();
  const origin = settings.data?.publicUrl?.replace(/\/$/, "") ?? window.location.origin;
  const endpoint = `${origin}/mcp`;

  const clientConfig = `{
  "mcpServers": {
    "cetus": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer cetus_..."
      }
    }
  }
}`;

  const initializeCurl = `curl -sS ${endpoint} \\
  -H "Authorization: Bearer $CETUS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cetus-cli","version":"1.0.0"}}}'`;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel">
        <div className="panel-header" style={{ flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <Terminal size={15} color="var(--accent)" />
            <h3>MCP server</h3>
            <Badge tone="accent">JSON-RPC 2.0</Badge>
          </div>
          <Button variant="primary" size="sm" onClick={onCreate} style={{ marginLeft: "auto" }}>
            <KeyRound size={14} /> Create MCP key
          </Button>
        </div>
        <div className="panel-body" style={{ display: "grid", gap: 14 }}>
          <p style={{ margin: 0, color: "var(--text-soft)", maxWidth: "88ch", lineHeight: 1.6 }}>
            Cetus exposes a Model Context Protocol server over HTTP. Clients send JSON-RPC requests to{" "}
            <code className="mono" style={{ color: "var(--text)" }}>POST /mcp</code> with an API key in the Authorization
            header. It supports <code className="mono">initialize</code>, <code className="mono">tools/list</code>, and{" "}
            <code className="mono">tools/call</code>, plus ping and the standard initialized and cancelled notifications.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, paddingTop: 2 }}>
            <div style={{ minWidth: 0 }}>
              <div className="label">Endpoint</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11.5, overflowWrap: "anywhere" }}>POST {endpoint}</span>
                <CopyButton value={endpoint} label="MCP endpoint copied" buttonLabel="Copy MCP endpoint" description={endpoint} />
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="label">Authentication</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 11.5 }}>Authorization: Bearer cetus_...</span>
                <Badge>API key</Badge>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface-2)" }}>
            <Info size={15} color="var(--muted)" style={{ marginTop: 2, flex: "none" }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>MCP keys are ordinary API keys</div>
              <p className="help" style={{ margin: "2px 0 0", maxWidth: "92ch" }}>
                Add <code className="mono">mcp:read</code> or <code className="mono">mcp:write</code>, plus the resource
                scopes each tool needs. Read tools use <code className="mono">mcp:read</code>. Write tools need{" "}
                <code className="mono">mcp:write</code> and their resource scope, for example{" "}
                <code className="mono">stacks:deploy</code> or <code className="mono">containers:exec</code>.
              </p>
            </div>
          </div>

          {settings.isError ? (
            <div className="help" style={{ color: "var(--warn)", margin: 0 }}>
              The configured public URL could not be loaded. The examples use this browser's origin instead.
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ListFilter size={15} color="var(--accent)" />
            <h3>Tools</h3>
            <Badge>{MCP_TOOLS.length}</Badge>
          </div>
          <span style={{ color: "var(--muted)", fontSize: 11 }}>Filtered by key scopes</span>
        </div>
        <div className="table-wrap" style={{ borderRadius: 0 }}>
          <table className="data-table" aria-label="MCP tools">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Mode</th>
                <th scope="col">Required scopes</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {MCP_TOOLS.map((tool) => (
                <tr key={tool.name}>
                  <td data-label="Tool">
                    <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>{tool.name}</span>
                  </td>
                  <td data-label="Mode">
                    <Badge tone={tool.mode === "write" ? "warn" : "default"}>{tool.mode}</Badge>
                  </td>
                  <td data-label="Required scopes">
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>{tool.scopes}</span>
                  </td>
                  <td data-label="Description">
                    <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>{tool.description}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "9px 16px", borderTop: "1px solid var(--border)", color: "var(--muted)", fontSize: 11 }}>
          <code className="mono">tools/list</code> only returns tools allowed by the key's resource scopes.
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 12 }}>
        <CodeBlock title="Client config" language="json" code={clientConfig} />
        <CodeBlock title="Initialize request" language="bash" code={initializeCurl} />
      </div>
      <div className="help" style={{ margin: 0 }}>
        Replace <code className="mono">cetus_...</code> with the full secret shown once when the key was created.
      </div>
    </div>
  );
}

function AuditTab() {
  const audit = useAudit();
  const toast = useToast();
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return audit.data ?? [];
    return (audit.data ?? []).filter((entry) =>
      `${entry.action} ${entry.actorName}`.toLowerCase().includes(needle),
    );
  }, [audit.data, filter]);

  async function exportAudit(format: "csv" | "json") {
    if (!filtered.length) return;
    try {
      const text = await api.exportAudit(format);
      const blob = new Blob([text], { type: format === "csv" ? "text/csv" : "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
      anchor.href = url;
      anchor.download = `cetus-audit-${stamp}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success("Audit exported", `Audit history downloaded as ${format.toUpperCase()}.`);
    } catch (error) {
      toast.error("Audit not exported", errorMessage(error, "The API rejected the export request."));
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ScrollText size={15} color="var(--accent)" />
          <h3>Audit log</h3>
          {audit.data ? <Badge>{audit.data.length}</Badge> : null}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button onClick={() => void exportAudit("csv")} disabled={!filtered.length} title="Export the filtered rows as CSV">
            <Download size={14} /> CSV
          </Button>
          <Button onClick={() => void exportAudit("json")} disabled={!filtered.length} title="Export the filtered rows as JSON">
            <Download size={14} /> JSON
          </Button>
        </div>
      </div>

      {audit.isLoading ? (
        <RowsSkeleton rows={9} />
      ) : audit.isError ? (
        <ErrorState title="Audit log could not be loaded" error={audit.error} onRetry={() => audit.refetch()} retrying={audit.isFetching} />
      ) : !audit.data?.length ? (
        <EmptyState
          icon={<ScrollText size={20} />}
          title="No audit events yet"
          description="Key changes, stack and container operations, and MCP tool calls appear here as they happen."
        />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 360 }}>
              <Search
                size={13}
                style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none" }}
              />
              <Input
                id="audit-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by action or actor"
                aria-label="Filter audit by action or actor"
                style={{ paddingLeft: 30 }}
              />
            </div>
            {filter ? (
              <Button size="sm" variant="ghost" onClick={() => setFilter("")}>Clear filter</Button>
            ) : null}
            <span className="mono" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 10.5 }}>
              {filtered.length} of {audit.data.length} events
            </span>
          </div>

          {!filtered.length ? (
            <EmptyState
              icon={<Search size={20} />}
              title="No matching events"
              description={`Nothing matched "${filter}". Try an action such as key.create or an actor name.`}
              action={<Button size="sm" onClick={() => setFilter("")}>Clear filter</Button>}
            />
          ) : (
            <div className="table-wrap" style={{ borderRadius: 0 }}>
              <table className="data-table" aria-label="Audit log">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Resource</th>
                    <th scope="col">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry) => (
                    <tr key={entry.id}>
                      <td data-label="Time">
                        <div style={{ fontSize: 11.5 }}>{formatDate(entry.createdAt)}</div>
                        <div style={{ color: "var(--muted)", fontSize: 10.5 }}>{relativeTime(entry.createdAt)}</div>
                      </td>
                      <td data-label="Actor">
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <strong style={{ fontWeight: 600 }}>{entry.actorName}</strong>
                          <span className="chip" style={{ height: 18, fontSize: 9.5, padding: "0 5px" }}>{entry.actorType}</span>
                        </div>
                      </td>
                      <td data-label="Action">
                        <span className="mono" style={{ fontSize: 11.5, color: "var(--text-soft)" }}>{entry.action}</span>
                      </td>
                      <td data-label="Resource">
                        <span style={{ fontSize: 11.5 }}>{titleCase(entry.resourceType)}</span>
                        {entry.resourceId ? (
                          <span
                            className="mono"
                            title={entry.resourceId}
                            style={{ marginLeft: 6, color: "var(--muted)", fontSize: 10.5 }}
                          >
                            {shortId(entry.resourceId, 8)}
                          </span>
                        ) : null}
                      </td>
                      <td data-label="IP">
                        <span className="mono" style={{ fontSize: 11 }}>{entry.ip ?? "n/a"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: "9px 16px", borderTop: "1px solid var(--border)", color: "var(--muted)", fontSize: 11 }}>
            Showing the most recent {audit.data.length} events. Export uses the current filter.
          </div>
        </>
      )}
    </section>
  );
}

function CreateKeyFlow({
  open,
  initialScopes,
  onClose,
}: {
  open: boolean;
  initialScopes: readonly string[];
  onClose: () => void;
}) {
  const createKey = useCreateKey();
  const toast = useToast();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiry, setExpiry] = useState("");
  const [hostTargets, setHostTargets] = useState("");
  const [stackTargets, setStackTargets] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setScopes([...initialScopes]);
    setExpiry("");
    setHostTargets("");
    setStackTargets("");
    setFormError(null);
    createKey.reset();
    // initialScopes is a stable constant owned by the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialScopes]);

  function toggleScope(scope: string) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope],
    );
  }

  function toggleGroup(groupScopes: readonly string[]) {
    setScopes((current) => {
      const allSelected = groupScopes.every((scope) => current.includes(scope));
      if (allSelected) return current.filter((scope) => !groupScopes.includes(scope));
      return [...new Set([...current, ...groupScopes])];
    });
  }

  function closeCreate() {
    setFormError(null);
    onClose();
  }

  function closeSecret() {
    if (created) {
      toast.success("API key created", `"${created.name}" is now in the key list.`);
    }
    setCreated(null);
    setFormError(null);
    onClose();
  }

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Give the key a name so it can be identified later.");
      return;
    }
    if (scopes.length === 0) {
      setFormError("Select at least one scope.");
      return;
    }

    let expiresAt: string | undefined;
    if (expiry) {
      const date = new Date(`${expiry}T23:59:59`);
      if (Number.isNaN(date.getTime())) {
        setFormError("The expiry date is invalid.");
        return;
      }
      if (date.getTime() <= Date.now()) {
        setFormError("The expiry date must be in the future.");
        return;
      }
      expiresAt = date.toISOString();
    }

    try {
      const response = await createKey.mutateAsync({
        name: trimmedName,
        scopes: ALL_SCOPES.filter((scope) => scopes.includes(scope)),
        hostIds: parseTargets(hostTargets),
        stackIds: parseTargets(stackTargets),
        expiresAt,
      });
      const result = normalizeCreatedKey(response);
      setCreated(result);
      setFormError(null);
    } catch (error) {
      setFormError(errorMessage(error, "The key could not be created."));
    }
  }

  const selectedCount = scopes.length;

  return (
    <>
      <Dialog
        open={open && created === null}
        onClose={closeCreate}
        title="Create API key"
        wide
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate}>Cancel</Button>
            <Button variant="primary" onClick={submit} loading={createKey.isPending}>
              <KeyRound size={14} /> Create key
            </Button>
          </>
        }
      >
        <div style={{ display: "grid", gap: 18 }}>
          {formError ? (
            <div
              role="alert"
              style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 11px", borderRadius: 9, border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)", background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12 }}
            >
              <AlertTriangle size={14} style={{ marginTop: 1, flex: "none" }} />
              <span>{formError}</span>
            </div>
          ) : null}

          <div>
            <label className="label" htmlFor="key-name">Name</label>
            <Input
              id="key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="ci-deploy, grafana-read, mcp-agent"
              maxLength={80}
              autoComplete="off"
            />
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <span className="label" style={{ marginBottom: 0 }}>Quick presets</span>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>{selectedCount} of {ALL_SCOPES.length} scopes selected</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {SCOPE_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  size="sm"
                  type="button"
                  title={preset.hint}
                  onClick={() => setScopes([...preset.scopes])}
                >
                  {preset.label}
                </Button>
              ))}
              <Button size="sm" type="button" variant="ghost" onClick={() => setScopes([])}>Clear</Button>
            </div>
            <div className="help">Presets replace the selection. Adjust individual scopes below.</div>
          </div>

          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>
              <span>Scopes</span>
              <span className="mono" style={{ fontSize: 10, letterSpacing: 0, textTransform: "none" }}>Enforced per request</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px 18px" }}>
              {SCOPE_GROUPS.map((group) => {
                const groupSelected = group.scopes.filter((scope) => scopes.includes(scope)).length;
                const allSelected = groupSelected === group.scopes.length;
                return (
                  <div key={group.label} style={{ minWidth: 0, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                      <span style={{ color: "var(--text-soft)", fontSize: 10.5, fontWeight: 650, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {group.label}
                      </span>
                      <span className="mono" style={{ color: "var(--muted-2)", fontSize: 9.5 }}>
                        {groupSelected}/{group.scopes.length}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ marginLeft: "auto", height: 20, padding: "0 4px", fontSize: 10 }}
                        onClick={() => toggleGroup(group.scopes)}
                      >
                        {allSelected ? "None" : "All"}
                      </button>
                    </div>
                    <div style={{ display: "grid", gap: 1 }}>
                      {group.scopes.map((scope) => (
                        <label
                          key={scope}
                          style={{ display: "flex", alignItems: "center", gap: 7, minHeight: 23, padding: "2px 3px", borderRadius: 6, cursor: "pointer" }}
                        >
                          <input
                            type="checkbox"
                            checked={scopes.includes(scope)}
                            onChange={() => toggleScope(scope)}
                            style={{ width: 13, height: 13, accentColor: "var(--accent)", flex: "none" }}
                          />
                          <span className="mono" style={{ fontSize: 11, color: scopes.includes(scope) ? "var(--text)" : "var(--text-soft)" }}>
                            {scope}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div>
              <label className="label" htmlFor="key-expiry">Expiry (optional)</label>
              <Input
                id="key-expiry"
                type="date"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              />
              <div className="help">Ends at 23:59 local time. Leave blank for no expiry.</div>
            </div>
            <div>
              <label className="label" htmlFor="key-hosts">Host targets (optional)</label>
              <Input
                id="key-hosts"
                value={hostTargets}
                onChange={(event) => setHostTargets(event.target.value)}
                placeholder="host-local, host-eu-1"
                autoComplete="off"
              />
              <div className="help">Comma-separated host IDs.</div>
            </div>
            <div>
              <label className="label" htmlFor="key-stacks">Stack targets (optional)</label>
              <Input
                id="key-stacks"
                value={stackTargets}
                onChange={(event) => setStackTargets(event.target.value)}
                placeholder="stack-id, another-stack-id"
                autoComplete="off"
              />
              <div className="help">Comma-separated stack IDs.</div>
            </div>
          </div>

          <div className="surface-soft" style={{ padding: "9px 11px", display: "flex", alignItems: "flex-start", gap: 8 }}>
            <Shield size={14} color="var(--muted)" style={{ marginTop: 1, flex: "none" }} />
            <div className="help" style={{ margin: 0 }}>
              Targets narrow a key to specific hosts and stacks. Leave both blank to allow every target. IDs are shown on
              the hosts and stacks pages.
            </div>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={created !== null}
        onClose={closeSecret}
        title="Copy your API key"
        footer={
          <Button variant="primary" onClick={closeSecret}>
            <Check size={14} /> I stored the key
          </Button>
        }
      >
        {created ? (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Badge tone="success"><Check size={11} /> Key created</Badge>
              <span style={{ color: "var(--muted)", fontSize: 11.5 }}>Copy the secret before closing this dialog.</span>
            </div>

            <div
              style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 12px", borderRadius: 10, border: "1px solid color-mix(in oklab, var(--warn) 35%, transparent)", background: "var(--warn-soft)" }}
            >
              <ShieldAlert size={17} color="var(--warn)" style={{ marginTop: 1, flex: "none" }} />
              <div>
                <div style={{ color: "var(--warn)", fontSize: 12.5, fontWeight: 600 }}>This secret is shown once</div>
                <p className="help" style={{ margin: "2px 0 0" }}>
                  Cetus stores only a hash. If you lose it, revoke the key and create a new one.
                </p>
              </div>
            </div>

            <div
              className="surface-soft"
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "#060a0e", borderColor: "var(--border-strong)" }}
            >
              <code className="mono" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", color: "#d6e4ec", fontSize: 12 }}>
                {created.secret}
              </code>
              <Button
                size="sm"
                onClick={() => {
                  void copyToClipboard(created.secret).then((copied) => {
                    if (copied) toast.success("Secret copied", "Paste it into your client now.");
                    else toast.error("Copy failed", "Select the secret and copy it manually.");
                  });
                }}
              >
                <Copy size={13} /> Copy
              </Button>
            </div>

            <dl className="kv" style={{ gridTemplateColumns: "92px minmax(0, 1fr)" }}>
              <dt>Name</dt>
              <dd>{created.name}</dd>
              <dt>Prefix</dt>
              <dd className="mono">cetus_{created.prefix}.…</dd>
              <dt>Scopes</dt>
              <dd>{created.scopes.length} selected</dd>
              <dt>Targets</dt>
              <dd>{describeTargets(created)}</dd>
              <dt>Expiry</dt>
              <dd>{created.expiresAt ? formatExpiry(created.expiresAt) : "No expiry"}</dd>
            </dl>

            <div className="help" style={{ margin: 0 }}>
              Store it in a secret manager, CI variable, or MCP client config. Do not commit it.
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function SettingRow({
  icon,
  label,
  hint,
  children,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid color-mix(in oklab, var(--border) 70%, transparent)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "1 1 190px", minWidth: 0 }}>
        <span
          style={{
            width: 28,
            height: 28,
            display: "grid",
            placeItems: "center",
            flex: "none",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            color: "var(--muted)",
          }}
        >
          {icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
          <div style={{ marginTop: 1, color: "var(--muted)", fontSize: 11.5 }}>{hint}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", justifyContent: "flex-end", flexWrap: "wrap", minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

function ScopeToken({ scope }: { scope: string }) {
  return (
    <span
      className="mono"
      style={{
        padding: "1px 5px",
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: "var(--surface-2)",
        color: "var(--text-soft)",
        fontSize: 9.5,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
      }}
    >
      {scope}
    </span>
  );
}

function KeyScopes({ scopes }: { scopes: string[] }) {
  if (!scopes.length) return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>None</span>;
  const shown = scopes.slice(0, 3);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 280 }} title={scopes.join(", ")}>
      {shown.map((scope) => (
        <span key={scope} className="chip mono" style={{ height: 19, padding: "0 5px", fontSize: 9.5 }}>
          {scope}
        </span>
      ))}
      {scopes.length > shown.length ? (
        <span className="chip" style={{ height: 19, padding: "0 5px", fontSize: 9.5 }}>+{scopes.length - shown.length}</span>
      ) : null}
    </div>
  );
}

function KeyTargets({ apiKey }: { apiKey: ApiKeySummary }) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      <span
        className="chip"
        title={apiKey.hostIds.length ? apiKey.hostIds.join(", ") : "Not restricted by host"}
        style={{ height: 19, padding: "0 6px", fontSize: 9.5 }}
      >
        {apiKey.hostIds.length ? `${apiKey.hostIds.length} host${apiKey.hostIds.length === 1 ? "" : "s"}` : "All hosts"}
      </span>
      <span
        className="chip"
        title={apiKey.stackIds.length ? apiKey.stackIds.join(", ") : "Not restricted by stack"}
        style={{ height: 19, padding: "0 6px", fontSize: 9.5 }}
      >
        {apiKey.stackIds.length ? `${apiKey.stackIds.length} stack${apiKey.stackIds.length === 1 ? "" : "s"}` : "All stacks"}
      </span>
    </div>
  );
}

function KeyValidity({ apiKey }: { apiKey: ApiKeySummary }) {
  if (apiKey.revokedAt) {
    return (
      <div>
        <Badge tone="danger">Revoked</Badge>
        <div style={{ marginTop: 3, color: "var(--muted)", fontSize: 10.5 }}>{formatDate(apiKey.revokedAt)}</div>
      </div>
    );
  }
  if (apiKey.expiresAt) {
    const expired = new Date(apiKey.expiresAt).getTime() <= Date.now();
    return (
      <div>
        <Badge tone={expired ? "warn" : "default"}>{expired ? "Expired" : "Expires"}</Badge>
        <div style={{ marginTop: 3, color: "var(--muted)", fontSize: 10.5 }}>{formatExpiry(apiKey.expiresAt)}</div>
      </div>
    );
  }
  return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>No expiry</span>;
}

function CopyButton({
  value,
  label,
  description,
  buttonLabel,
}: {
  value: string;
  label: string;
  description?: string;
  buttonLabel?: string;
}) {
  const toast = useToast();

  async function handleCopy() {
    const copied = await copyToClipboard(value);
    if (copied) {
      toast.success(label, description);
    } else {
      toast.error("Copy failed", "Clipboard access was denied. Select the value and copy it manually.");
    }
  }

  return (
    <IconButton label={buttonLabel ?? label} onClick={handleCopy} style={{ width: 28, height: 28 }}>
      <Copy size={12} />
    </IconButton>
  );
}

function CodeBlock({ title, code, language }: { title: string; code: string; language: string }) {
  return (
    <section className="surface-soft" style={{ overflow: "hidden", background: "#060a0e", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <span className="mono" style={{ color: "var(--muted)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em" }}>{title}</span>
        <span className="chip" style={{ height: 18, padding: "0 5px", fontSize: 9.5 }}>{language}</span>
        <div style={{ marginLeft: "auto" }}>
          <CopyButton value={code} label={`${title} copied`} buttonLabel={`Copy ${title}`} />
        </div>
      </div>
      <pre className="mono" style={{ margin: 0, padding: "12px 14px", overflowX: "auto", color: "#c8d6df", fontSize: 11.5, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {code}
      </pre>
    </section>
  );
}

function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ padding: 16, display: "grid", gap: 10 }}>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

function PanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-5 w-24" />
      </div>
      <RowsSkeleton rows={rows} />
    </div>
  );
}

function ErrorState({
  title,
  error,
  onRetry,
  retrying,
}: {
  title: string;
  error: Error | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <EmptyState
      icon={<AlertTriangle size={20} />}
      title={title}
      description={errorMessage(error, "The API returned an unexpected error.")}
      action={
        <Button size="sm" onClick={onRetry} loading={retrying}>
          <RefreshCw size={13} /> Retry
        </Button>
      }
    />
  );
}

function ErrorPanel({
  title,
  error,
  onRetry,
  retrying,
}: {
  title: string;
  error: Error | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="panel">
      <ErrorState title={title} error={error} onRetry={onRetry} retrying={retrying} />
    </div>
  );
}

function isMcpKey(apiKey: ApiKeySummary) {
  return apiKey.scopes.includes("mcp:read") || apiKey.scopes.includes("mcp:write");
}

function normalizeCreatedKey(result: ApiKeyCreated): ApiKeyCreated {
  // The endpoint currently wraps the new key as { summary, secret }. Accept both
  // shapes so the reveal dialog keeps working if the API is flattened later.
  const maybe = result as unknown as { summary?: ApiKeySummary; secret?: string };
  if (maybe.summary && maybe.secret) {
    return { ...maybe.summary, secret: maybe.secret };
  }
  return result;
}

async function copyToClipboard(value: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path for non-secure contexts or denied permissions.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function parseTargets(value: string) {
  return Array.from(new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ));
}

function formatExpiry(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeTargets(apiKey: ApiKeySummary) {
  const parts: string[] = [];
  if (apiKey.hostIds.length) parts.push(`${apiKey.hostIds.length} host${apiKey.hostIds.length === 1 ? "" : "s"}`);
  if (apiKey.stackIds.length) parts.push(`${apiKey.stackIds.length} stack${apiKey.stackIds.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "All hosts and stacks";
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}
