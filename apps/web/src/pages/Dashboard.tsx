import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity as ActivityIcon,
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  Container,
  FolderSearch,
  HeartPulse,
  Layers,
  LoaderCircle,
  Plus,
  RefreshCw,
  ScrollText,
  Server,
  TriangleAlert,
  Zap,
} from "lucide-react";
import type { AuditEntry, DashboardData, HostSummary, StackSummary } from "@shared/types";
import { useApplyAllUpdates, useCheckAllUpdates, useDashboard, useMe, useScanStacks } from "../lib/queries";
import { can, scopeReason } from "../lib/api";
import { scheduleLabel } from "../lib/autoUpdate";
import { GlobalAutoUpdateDialog } from "../components/GlobalAutoUpdateDialog";
import { useToast } from "../components/Toast";
import { StatusBadge, StatusDot } from "../components/Status";
import { Badge, Button, EmptyState, IconButton, PageHeader, Skeleton } from "../components/ui";
import { formatBytes, formatDate, formatPercent, relativeTime, titleCase } from "../lib/format";

const NEW_STACK_FLAG = "cetus:new-stack";

type ActivityTone = "accent" | "success" | "warn" | "danger";
type MeterTone = "success" | "warn" | "danger" | undefined;

export function DashboardPage() {
  const dashboard = useDashboard();
  const scan = useScanStacks();
  const updateCheck = useCheckAllUpdates();
  const applyAll = useApplyAllUpdates();
  const me = useMe();
  const canWrite = can(me.data?.actor.scopes, "stacks:write");
  const canApply = can(me.data?.actor.scopes, "updates:apply");
  const canConfigure = can(me.data?.actor.scopes, "settings:write");
  const writeReason = scopeReason("stacks:write");
  const toast = useToast();
  const navigate = useNavigate();
  const data = dashboard.data;
  const [refreshing, setRefreshing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const handlingNewStack = useRef(false);

  async function refreshDashboard() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await dashboard.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    function handleNewStack() {
      if (handlingNewStack.current || !canWrite) return;
      try {
        sessionStorage.setItem(NEW_STACK_FLAG, "1");
      } catch {
        // The stacks page still opens if storage is unavailable.
      }
      navigate({ to: "/stacks" });
    }
    window.addEventListener("cetus:new-stack", handleNewStack);
    return () => window.removeEventListener("cetus:new-stack", handleNewStack);
  }, [navigate, canWrite]);

  function openNewStack() {
    if (!canWrite) return;
    try {
      sessionStorage.setItem(NEW_STACK_FLAG, "1");
    } catch {
      // Private storage can be unavailable. The event still covers mounted pages.
    }
    handlingNewStack.current = true;
    try {
      window.dispatchEvent(new CustomEvent("cetus:new-stack"));
    } finally {
      handlingNewStack.current = false;
    }
    navigate({ to: "/stacks" });
  }

  function scanFolder() {
    if (!canWrite) return;
    scan.mutate(undefined, {
      onSuccess: (result) => {
        toast.success("Folder scanned", `${result.count} stack${result.count === 1 ? "" : "s"} indexed.`);
      },
      onError: (error) => {
        toast.error("Scan failed", error instanceof Error ? error.message : "Unknown error");
      },
    });
  }

  const pageActions = (
    <>
      <Button
        variant="primary"
        onClick={openNewStack}
        disabled={!canWrite}
        aria-disabled={!canWrite}
        title={canWrite ? undefined : writeReason}
      >
        <Plus size={14} /> New stack
      </Button>
      <Button
        onClick={scanFolder}
        loading={canWrite && scan.isPending}
        disabled={!canWrite}
        aria-disabled={!canWrite}
        title={canWrite ? undefined : writeReason}
      >
        <FolderSearch size={14} /> Scan folder
      </Button>
      <IconButton
        label="Refresh dashboard"
        onClick={() => void refreshDashboard()}
        disabled={refreshing}
        style={{ opacity: refreshing ? 0.6 : 1 }}
      >
        <RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} />
      </IconButton>
    </>
  );

  if (dashboard.isLoading) {
    return (
      <div>
        <PageHeader title="Overview" description="Connecting to the fleet." actions={pageActions} />
        <div className="metric-grid" style={{ marginBottom: 12 }}>
          {[0, 1, 2, 3].map((index) => (
            <div className="panel metric" key={index}>
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-3 h-2.5 w-32" />
            </div>
          ))}
        </div>
        <div className="grid gap-3 xl:grid-cols-3">
          <div className="grid gap-3 content-start xl:col-span-2">
            <LoadingPanel rows={2} />
            <LoadingPanel rows={4} />
          </div>
          <div className="grid gap-3 content-start">
            <LoadingPanel rows={2} />
            <LoadingPanel rows={4} />
            <LoadingPanel rows={2} />
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <PageHeader title="Overview" description="Live fleet health and recent activity." actions={pageActions} />
        <div className="panel">
          <EmptyState
            icon={<TriangleAlert size={20} />}
            title="Dashboard unavailable"
            description={
              dashboard.error instanceof Error
                ? dashboard.error.message
                : "The overview could not be loaded. Check that the Cetus server is reachable, then try again."
            }
            action={
              <Button onClick={() => dashboard.refetch()} loading={dashboard.isFetching}>
                <RefreshCw size={14} /> Retry
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const totals = data.totals;
  const hosts = data.hosts;
  const notOnline = totals.hosts - totals.hostsOnline;
  const offlineHosts = hosts.filter((host) => host.status === "offline").length;
  const degradedHosts = hosts.filter((host) => host.status === "degraded").length;
  const notRunning = totals.stacks - totals.running;
  const hostsPercent = totals.hosts > 0 ? (totals.hostsOnline / totals.hosts) * 100 : 0;
  const stacksPercent = totals.stacks > 0 ? (totals.running / totals.stacks) * 100 : 0;
  const hostNoun = totals.hosts === 1 ? "host" : "hosts";
  const stackNoun = totals.stacks === 1 ? "stack" : "stacks";

  function openFirstHost() {
    const host = hosts[0];
    if (host) {
      navigate({ to: "/hosts/$hostId", params: { hostId: host.id } });
      return;
    }
    navigate({ to: "/hosts" });
  }

  async function updateAll() {
    if (!canApply || applyAll.isPending) return;
    try {
      const result = await applyAll.mutateAsync();
      await dashboard.refetch();
      if (result.started.length > 0) {
        toast.success(
          `Updating ${result.started.length} stack${result.started.length === 1 ? "" : "s"}`,
          result.skipped.length > 0
            ? `${result.skipped.length} skipped. Progress is on each stack page.`
            : "Progress is on each stack page.",
        );
      } else if (result.skipped.length > 0) {
        toast.push({
          title: "No updates started",
          description: result.skipped[0]?.reason ?? "No eligible stack was found.",
          tone: "info",
        });
      } else {
        toast.success("Nothing to update", "No visible stack has an available image update.");
      }
    } catch (error) {
      toast.error("Update all failed", error instanceof Error ? error.message : "The update request did not complete.");
    }
  }

  async function checkForUpdates() {
    if (updateCheck.isPending) return;
    try {
      const result = await updateCheck.mutateAsync();
      await dashboard.refetch();
      if (result.updates > 0) {
        toast.success(
          "Updates available",
          `${result.updates} stack${result.updates === 1 ? "" : "s"} behind the registry. ${result.checked} checked.`,
        );
      } else if (result.failed > 0 || result.unchecked > 0) {
        toast.push({
          title: "Check incomplete",
          description: `${result.checked} stack${result.checked === 1 ? "" : "s"} checked. ${result.failed} failed, ${result.unchecked} image${result.unchecked === 1 ? "" : "s"} could not be checked.`,
          tone: "info",
        });
      } else {
        toast.success(
          "Images are current",
          `${result.checked} stack${result.checked === 1 ? "" : "s"} checked.`,
        );
      }
    } catch (error) {
      toast.error("Update check failed", error instanceof Error ? error.message : "The registry sweep did not complete.");
    }
  }

  return (
    <div>
      <PageHeader
        title="Overview"
        description={`Live fleet health · ${totals.hostsOnline} of ${totals.hosts} ${hostNoun} online · ${totals.running} of ${totals.stacks} ${stackNoun} running`}
        actions={pageActions}
      />

      <div className="metric-grid" style={{ marginBottom: 12 }}>
        <Metric
          label="Hosts online"
          value={String(totals.hostsOnline)}
          suffix={`/ ${totals.hosts}`}
          icon={Server}
          progress={hostsPercent}
          progressTone={notOnline === 0 ? "success" : totals.hostsOnline === 0 ? "danger" : "warn"}
          sub={
            totals.hosts === 0 ? (
              "No hosts enrolled"
            ) : notOnline === 0 ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <StatusDot status="online" /> All hosts responding
              </span>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <StatusDot status={offlineHosts > 0 ? "offline" : "partial"} />
                {[
                  offlineHosts > 0 ? `${offlineHosts} offline` : null,
                  degradedHosts > 0 ? `${degradedHosts} degraded` : null,
                ].filter(Boolean).join(" · ") || `${notOnline} not online`}
              </span>
            )
          }
        />
        <Metric
          label="Stacks running"
          value={String(totals.running)}
          suffix={`/ ${totals.stacks}`}
          icon={Layers}
          progress={stacksPercent}
          progressTone={notRunning === 0 ? "success" : undefined}
          sub={notRunning === 0 ? "Every stack is running" : `${notRunning} stack${notRunning === 1 ? "" : "s"} not running`}
        />
        <Metric
          label="Containers"
          value={String(totals.containers)}
          icon={Container}
          sub={`Across ${totals.hosts} host${totals.hosts === 1 ? "" : "s"}`}
        />
        <Metric
          label="Unhealthy"
          value={String(totals.unhealthy)}
          icon={HeartPulse}
          tone={totals.unhealthy > 0 ? "danger" : "accent"}
          sub={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <StatusDot status={totals.unhealthy > 0 ? "unhealthy" : "healthy"} />
              {totals.unhealthy > 0
                ? "Needs operator attention"
                : "No unhealthy stacks reported"}
            </span>
          }
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="grid gap-3 content-start xl:col-span-2">
          <FleetHealthPanel hosts={hosts} />
          <RecentStacksPanel stacks={data.recentStacks} onCreate={openNewStack} canWrite={canWrite} />
          <QuickActionsPanel
            onNewStack={openNewStack}
            onScan={scanFolder}
            scanning={canWrite && scan.isPending}
            canWrite={canWrite}
            onOpenHost={openFirstHost}
            onOpenLogs={() => navigate({ to: "/logs" })}
            onOpenActivity={() => navigate({ to: "/activity" })}
          />
        </div>
        <div className="grid gap-3 content-start">
          <UpdateQueuePanel
            updates={data.updates}
            checkedAt={data.updatesCheckedAt ?? null}
            failed={data.updatesFailed ?? 0}
            checking={updateCheck.isPending}
            onCheck={() => void checkForUpdates()}
            globalAutoUpdate={data.globalAutoUpdate}
            canApply={canApply}
            canConfigure={canConfigure}
            updating={applyAll.isPending}
            onUpdateAll={() => void updateAll()}
            onConfigureSchedule={() => setScheduleOpen(true)}
          />
          <ActivityPanel activity={data.activity} />
        </div>
      </div>
      <GlobalAutoUpdateDialog
        open={scheduleOpen}
        config={data.globalAutoUpdate}
        onClose={() => setScheduleOpen(false)}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
  sub,
  icon: Icon,
  tone = "accent",
  progress,
  progressTone,
}: {
  label: string;
  value: string;
  suffix?: string;
  sub: ReactNode;
  icon: LucideIcon;
  tone?: "accent" | "danger";
  progress?: number;
  progressTone?: MeterTone;
}) {
  const danger = tone === "danger";
  return (
    <section className="panel metric" aria-label={label}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div className="metric-label">{label}</div>
        <span
          style={{
            width: 28,
            height: 28,
            display: "grid",
            placeItems: "center",
            borderRadius: 8,
            border: `1px solid ${danger ? "color-mix(in oklab, var(--danger) 30%, transparent)" : "var(--accent-line)"}`,
            background: danger ? "var(--danger-soft)" : "var(--accent-soft)",
            color: danger ? "var(--danger)" : "var(--accent)",
            flex: "none",
          }}
        >
          <Icon size={14} />
        </span>
      </div>
      <div className="metric-value" style={danger ? { color: "var(--danger)" } : undefined}>
        {value}
        {suffix ? (
          <span style={{ marginLeft: 5, color: "var(--muted)", fontSize: 13, fontWeight: 500, letterSpacing: 0 }}>{suffix}</span>
        ) : null}
      </div>
      {typeof progress === "number" ? (
        <div className="progress" data-tone={progressTone} style={{ marginTop: 9 }}>
          <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      ) : null}
      <div className="metric-sub">{sub}</div>
    </section>
  );
}

function FleetHealthPanel({ hosts }: { hosts: HostSummary[] }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Server size={15} color="var(--accent)" />
          <h3>Fleet health</h3>
          <Badge>{hosts.length}</Badge>
        </div>
      </div>

      {hosts.length === 0 ? (
        <EmptyState
          icon={<Server size={20} />}
          title="No hosts enrolled"
          description="Connect a Docker host before creating stacks. The local host is registered automatically when the engine is reachable."
        />
      ) : (
        hosts.map((host, index) => <HostRow key={host.id} host={host} first={index === 0} />)
      )}
    </section>
  );
}

function HostRow({ host, first }: { host: HostSummary; first: boolean }) {
  const online = host.status === "online";
  const degraded = host.status === "degraded";
  const cpuPercent = host.cpuUsage ?? null;
  const memoryPercent =
    host.memoryUsed != null && host.memory != null
      ? (host.memoryUsed / host.memory) * 100
      : null;
  const diskPercent =
    host.diskUsed != null && host.diskTotal != null
      ? (host.diskUsed / host.diskTotal) * 100
      : null;
  const memoryValue =
    host.memoryUsed != null && host.memory != null
      ? `${formatBytes(host.memoryUsed)} / ${formatBytes(host.memory)}`
      : host.memory != null
        ? `${formatBytes(host.memory)} total`
        : "n/a";
  const diskValue =
    host.diskUsed != null && host.diskTotal != null
      ? `${formatBytes(host.diskUsed)} / ${formatBytes(host.diskTotal)}`
      : host.diskTotal != null
        ? `${formatBytes(host.diskTotal)} total`
        : "n/a";
  const docker = host.dockerVersion ? `Docker ${host.dockerVersion}` : "Docker unavailable";

  return (
    <div style={{ borderTop: first ? undefined : "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 10px", flexWrap: "wrap" }}>
        <div
          className="stack-avatar"
          style={{
            color: online ? "var(--accent)" : degraded ? "var(--warn)" : "var(--danger)",
            background: online ? "var(--accent-soft)" : degraded ? "var(--warn-soft)" : "var(--danger-soft)",
            borderColor: online ? "var(--accent-line)" : degraded ? "color-mix(in oklab, var(--warn) 35%, transparent)" : "color-mix(in oklab, var(--danger) 35%, transparent)",
          }}
        >
          <Server size={15} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <Link to="/hosts/$hostId" params={{ hostId: host.id }} style={{ color: "var(--text)", fontWeight: 600, fontSize: 13 }}>
              {host.name}
            </Link>
            <Badge tone={online ? "success" : degraded ? "warn" : "danger"}>
              <StatusDot status={host.status} /> {titleCase(host.status)}
            </Badge>
            <span className="chip">{titleCase(host.kind)}</span>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>{host.os ?? "OS unavailable"}</span>
          </div>
          <div style={{ marginTop: 2, color: "var(--muted)", fontSize: 11 }}>
            {docker} · {host.stackCount} stack{host.stackCount === 1 ? "" : "s"} · {host.runningStacks} running · {host.containerCount} containers · {host.imageCount} images
          </div>
        </div>
        <Link to="/hosts/$hostId" params={{ hostId: host.id }} className="btn btn-ghost btn-sm">
          Open <ArrowUpRight size={12} />
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-3" style={{ padding: "0 16px 14px 56px" }}>
        <ResourceMeter label="CPU" value={cpuPercent === null ? "n/a" : formatPercent(cpuPercent, 1)} percent={cpuPercent} />
        <ResourceMeter label="Memory" value={memoryValue} percent={memoryPercent} />
        <ResourceMeter label="Disk" value={diskValue} percent={diskPercent} />
      </div>
    </div>
  );
}

function ResourceMeter({ label, value, percent }: { label: string; value: string; percent: number | null }) {
  const tone: MeterTone = percent === null ? undefined : percent >= 90 ? "danger" : percent >= 75 ? "warn" : undefined;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
        <span style={{ color: "var(--muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</span>
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            color: tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--text-soft)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {value}
        </span>
      </div>
      <div
        className="progress"
        data-tone={tone}
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(Math.min(100, Math.max(0, percent)))}
        aria-valuetext={percent === null ? "No sample reported" : undefined}
      >
        <span style={{ width: `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%` }} />
      </div>
    </div>
  );
}

function RecentStacksPanel({ stacks, onCreate, canWrite }: { stacks: StackSummary[]; onCreate: () => void; canWrite: boolean }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Layers size={15} color="var(--accent)" />
          <h3>Recent stacks</h3>
          <Badge>{stacks.length}</Badge>
        </div>
        <Link to="/stacks" className="btn btn-ghost btn-sm">
          View all <ChevronRight size={12} />
        </Link>
      </div>

      {stacks.length === 0 ? (
        <EmptyState
          icon={<Layers size={20} />}
          title="No stacks yet"
          description="Create a stack from a Compose template or scan the stacks directory for existing files."
          action={
            <Button
              size="sm"
              variant="primary"
              onClick={onCreate}
              disabled={!canWrite}
              aria-disabled={!canWrite}
              title={canWrite ? undefined : scopeReason("stacks:write")}
            >
              <Plus size={13} /> New stack
            </Button>
          }
        />
      ) : (
        stacks.map((stack, index) => (
          <Link
            key={stack.id}
            to="/stacks/$stackId"
            params={{ stackId: stack.id }}
            className="command-item"
            style={{ padding: "10px 16px", borderRadius: 0, borderTop: index === 0 ? undefined : "1px solid var(--border)" }}
          >
            <div className="stack-avatar" style={{ width: 30, height: 30 }}>
              <Layers size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <strong
                  style={{
                    color: "var(--text)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {stack.displayName}
                </strong>
                {stack.updateAvailable ? (
                  <span className="badge badge-info" style={{ minHeight: 18, padding: "0 6px", fontSize: 9.5 }}>
                    Update
                  </span>
                ) : null}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 3 }}>
                <span className="chip" style={{ height: 19, padding: "0 6px", fontSize: 10 }}>
                  <Server size={9} /> {stack.hostName}
                </span>
                <span style={{ color: "var(--muted)", fontSize: 10.5 }}>
                  {stack.runningCount}/{stack.serviceCount} services
                </span>
                <span style={{ color: "var(--muted-2)", fontSize: 10 }}>·</span>
                <span style={{ color: "var(--muted)", fontSize: 10.5 }} title={formatDate(stack.updatedAt)}>
                  {relativeTime(stack.updatedAt)}
                </span>
              </div>
            </div>
            <StatusBadge status={stack.status} />
            <ChevronRight size={14} className="hidden sm:block" style={{ color: "var(--muted-2)", flex: "none" }} />
          </Link>
        ))
      )}
    </section>
  );
}

function ActivityPanel({ activity }: { activity: AuditEntry[] }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ActivityIcon size={15} color="var(--accent)" />
          <h3>Activity</h3>
        </div>
        <Link to="/activity" className="btn btn-ghost btn-sm">
          View all <ChevronRight size={12} />
        </Link>
      </div>
      {activity.length === 0 ? (
        <EmptyState
          icon={<ActivityIcon size={20} />}
          title="No activity yet"
          description="Stack operations, scans, and configuration changes will appear here."
        />
      ) : (
        <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
          <div className="timeline">
            {activity.slice(0, 8).map((entry) => (
              <div className="timeline-item" key={entry.id}>
                <span className="timeline-dot" data-tone={activityTone(entry.action)} />
                <div className="timeline-body" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {actionLabel(entry.action)}
                    </strong>
                    <span className="timeline-time" style={{ flex: "none" }} title={formatDate(entry.createdAt)}>
                      {relativeTime(entry.createdAt)}
                    </span>
                  </div>
                  <div className="timeline-time">
                    {entry.actorName}
                    {entry.resourceType ? ` · ${titleCase(entry.resourceType)}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function UpdateQueuePanel({
  updates,
  checkedAt,
  failed,
  checking,
  onCheck,
  globalAutoUpdate,
  canApply,
  canConfigure,
  updating,
  onUpdateAll,
  onConfigureSchedule,
}: {
  updates: DashboardData["updates"];
  checkedAt: string | null;
  failed: number;
  checking: boolean;
  onCheck: () => void;
  globalAutoUpdate: DashboardData["globalAutoUpdate"];
  canApply: boolean;
  canConfigure: boolean;
  updating: boolean;
  onUpdateAll: () => void;
  onConfigureSchedule: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-header" style={{ flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <RefreshCw size={15} color="var(--accent)" />
          <h3>Update queue</h3>
          <Badge tone={updates.length > 0 ? "warn" : "default"}>{updates.length} queued</Badge>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Button
            size="sm"
            variant="ghost"
            onClick={onConfigureSchedule}
            disabled={!canConfigure}
            aria-disabled={!canConfigure}
            title={canConfigure ? scheduleLabel(globalAutoUpdate) : scopeReason("settings:write")}
          >
            <CalendarClock size={13} /> Schedule
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={onUpdateAll}
            loading={canApply && updating}
            disabled={!canApply || updates.length === 0}
            aria-disabled={!canApply || updates.length === 0}
            title={
              !canApply
                ? scopeReason("updates:apply")
                : updates.length === 0
                  ? "No visible stack has an available update"
                  : "Pull newer images and recreate every stack with an update"
            }
          >
            <Zap size={13} /> Update all
          </Button>
        </div>
      </div>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", color: "var(--muted)", fontSize: 11 }}>
        Global auto-update: <strong style={{ color: "var(--text-soft)", fontWeight: 600 }}>{scheduleLabel(globalAutoUpdate)}</strong>. Per-stack schedules and service exclusions override it.
      </div>

      {updates.length === 0 ? (
        <div className="panel-body">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span
              style={{
                width: 32,
                height: 32,
                display: "grid",
                placeItems: "center",
                borderRadius: 9,
                border: "1px solid var(--border)",
                background: "var(--surface-2)",
                color: failed ? "var(--warn)" : checkedAt ? "var(--success)" : "var(--muted)",
                flex: "none",
              }}
            >
              <RefreshCw size={17} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {checkedAt ? "No updates found" : "No update checks yet"}
              </div>
              <div style={{ marginTop: 3, color: "var(--muted)", fontSize: 12 }}>
                {checkedAt
                  ? failed
                    ? `${failed} image${failed === 1 ? "" : "s"} could not be checked. Last sweep ${relativeTime(checkedAt)}.`
                    : `Every checked image is current. Last sweep ${relativeTime(checkedAt)}.`
                  : "Run a registry digest sweep now."}
              </div>
            </div>
          </div>
          <p style={{ margin: "12px 0 0", color: "var(--muted)", fontSize: 11.5, lineHeight: 1.55 }}>
            Cetus compares each running image digest with its registry manifest. Checks run every six hours and can be
            triggered from here or from a stack page.
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={onCheck}
            loading={checking}
            disabled={checking}
            style={{ marginTop: 11, border: "1px solid var(--border)" }}
          >
            <RefreshCw size={13} /> {checkedAt ? "Check again" : "Check now"}
          </Button>
        </div>
      ) : (
        <div>
          {updates.map((update, index) => (
            <Link
              key={`${update.stackId}-${update.service ?? update.image}`}
              to="/stacks/$stackId"
              params={{ stackId: update.stackId }}
              className="command-item"
              style={{ padding: "10px 16px", borderRadius: 0, borderTop: index === 0 ? undefined : "1px solid var(--border)" }}
            >
              <RefreshCw size={14} color="var(--warn)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "var(--text)", fontSize: 12.5, fontWeight: 600 }}>{update.stackName}</div>
                <div className="mono" style={{ color: "var(--muted)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {update.image}
                </div>
              </div>
              <Badge tone="warn">{update.hostName}</Badge>
            </Link>
          ))}
          <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCheck}
              loading={checking}
              disabled={checking}
            >
              <RefreshCw size={13} /> Check again
            </Button>
            {failed > 0 ? (
              <span className="muted" style={{ fontSize: 10.5 }}>
                {failed} image{failed === 1 ? "" : "s"} could not be checked
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function QuickActionsPanel({
  onNewStack,
  onScan,
  scanning,
  canWrite,
  onOpenHost,
  onOpenLogs,
  onOpenActivity,
}: {
  onNewStack: () => void;
  onScan: () => void;
  scanning: boolean;
  canWrite: boolean;
  onOpenHost: () => void;
  onOpenLogs: () => void;
  onOpenActivity: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={15} color="var(--accent)" />
          <h3>Quick actions</h3>
        </div>
      </div>
      <div>
        <QuickAction
          icon={Plus}
          label="New stack"
          hint="Start from a Compose template"
          onClick={onNewStack}
          disabled={!canWrite}
          disabledReason={scopeReason("stacks:write")}
        />
        <QuickAction
          icon={scanning ? LoaderCircle : FolderSearch}
          label="Scan folder"
          hint="Index compose files on disk"
          onClick={onScan}
          disabled={scanning || !canWrite}
          disabledReason={!canWrite ? scopeReason("stacks:write") : "Scan already running"}
          spinning={scanning}
          divider
        />
        <QuickAction icon={Server} label="Open host" hint="Inspect Docker inventory and resources" onClick={onOpenHost} divider />
        <QuickAction icon={ScrollText} label="Open logs" hint="Tail containers across every host" onClick={onOpenLogs} divider />
        <QuickAction icon={ActivityIcon} label="View activity" hint="Audit log for every operation" onClick={onOpenActivity} divider />
      </div>
    </section>
  );
}

function QuickAction({
  icon: Icon,
  label,
  hint,
  onClick,
  disabled,
  disabledReason,
  spinning,
  divider,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  spinning?: boolean;
  divider?: boolean;
}) {
  return (
    <button
      type="button"
      className="command-item"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      title={disabled ? disabledReason : undefined}
      style={{
        width: "100%",
        padding: "10px 16px",
        borderRadius: 0,
        borderTop: divider ? "1px solid var(--border)" : undefined,
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          display: "grid",
          placeItems: "center",
          borderRadius: 8,
          background: "var(--surface-3)",
          border: "1px solid var(--border)",
          color: "var(--accent)",
          flex: "none",
        }}
      >
        <Icon size={14} className={spinning ? "animate-spin" : undefined} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", color: "var(--text)", fontSize: 12.5, fontWeight: 600 }}>{label}</span>
        <span style={{ display: "block", marginTop: 1, color: "var(--muted)", fontSize: 11 }}>{hint}</span>
      </span>
      <ArrowUpRight size={13} style={{ color: "var(--muted-2)", flex: "none" }} />
    </button>
  );
}

function LoadingPanel({ rows }: { rows: number }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3 w-12" />
      </div>
      <div style={{ padding: "2px 16px" }}>
        {Array.from({ length: rows }).map((_, index) => (
          <div
            key={index}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 0",
              borderTop: index === 0 ? undefined : "1px solid var(--border)",
            }}
          >
            <Skeleton className="h-8 w-8" />
            <div style={{ flex: 1, display: "grid", gap: 6 }}>
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
            <Skeleton className="hidden h-6 w-16 sm:block" />
          </div>
        ))}
      </div>
    </section>
  );
}

const ACTION_LABELS: Record<string, string> = {
  deploy: "Deployed",
  stop: "Stopped",
  update: "Updated",
  scan: "Folder scanned",
  "stack.create": "Stack created",
  "stack.save": "Stack saved",
  "stack.scan": "Folder scanned",
  "stack.delete": "Stack deleted",
  "key.create": "Key created",
  "key.revoke": "Key revoked",
  "host.enroll": "Host enrolled",
  "service.exec": "Service command",
  "instance.ready": "Instance ready",
};

function actionLabel(action: string) {
  return ACTION_LABELS[action] ?? titleCase(action.replace(/\./g, " "));
}

function activityTone(action: string): ActivityTone {
  const value = action.toLowerCase();
  if (value.includes("delete") || value.includes("revoke") || value.includes("fail") || value.includes("error")) return "danger";
  if (value.includes("save") || value.includes("update") || value.includes("stop") || value.includes("down")) return "warn";
  if (value.includes("deploy") || value.includes("start") || value.includes("create") || value.includes("scan") || value.includes("ready") || value.includes("enroll")) return "success";
  return "accent";
}
