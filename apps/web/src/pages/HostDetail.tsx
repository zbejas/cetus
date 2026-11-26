import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  Container as ContainerIcon,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  HardDrive,
  Images,
  Layers,
  LoaderCircle,
  MemoryStick,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ScrollText,
  Server,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api, ApiError, can, scopeReason } from "../lib/api";
import { queryKeys, useHost, useInventory, useMe, useStacks, useUpdateWorker } from "../lib/queries";
import { useToast } from "../components/Toast";
import { Badge, Button, Dialog, EmptyState, IconButton, Skeleton } from "../components/ui";
import { HostMaintenanceDialog, type MaintenanceTarget } from "../components/HostMaintenanceDialog";
import { LogViewer } from "../components/LogViewer";
import { StatusBadge } from "../components/Status";
import { formatBytes, formatDate, formatPercent, relativeTime, shortId, titleCase } from "../lib/format";
import { parsePortTokens, publishedPortHref } from "../lib/ports";
import type {
  DockerContainer,
  DockerDfRow,
  DockerImage,
  DockerNetwork,
  DockerVolume,
  HostInventory,
  HostSummary,
  StackSummary,
} from "@shared/types";

type HostTab = "overview" | "containers" | "images" | "volumes" | "networks" | "df";

const TABS: Array<{ id: HostTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "containers", label: "Containers" },
  { id: "images", label: "Images" },
  { id: "volumes", label: "Volumes" },
  { id: "networks", label: "Networks" },
  { id: "df", label: "System DF" },
];

const DOCKER_SOCKET = "unix:///var/run/docker.sock";

export function HostDetailPage({ hostId }: { hostId: string }) {
  const hostQuery = useHost(hostId);
  const inventoryQuery = useInventory(hostId);
  const stacksQuery = useStacks(`?hostId=${encodeURIComponent(hostId)}`);
  const me = useMe();
  const updateWorker = useUpdateWorker();
  const canContainerWrite = can(me.data?.actor.scopes, "containers:write");
  const canWorkerUpdate = can(me.data?.actor.scopes, "updates:apply");
  const canImageWrite = can(me.data?.actor.scopes, "images:write");
  const canImagePrune = can(me.data?.actor.scopes, "images:prune");
  const canVolumeWrite = can(me.data?.actor.scopes, "volumes:write");
  const canVolumePrune = can(me.data?.actor.scopes, "volumes:prune");
  const canNetworkWrite = can(me.data?.actor.scopes, "networks:write");
  const canNetworkPrune = can(me.data?.actor.scopes, "networks:prune");
  const canSystemPrune = can(me.data?.actor.scopes, "system:prune");
  const queryClient = useQueryClient();
  const toast = useToast();

  const [tab, setTab] = useState<HostTab>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DockerContainer | null>(null);
  const [logsTarget, setLogsTarget] = useState<DockerContainer | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [maintenance, setMaintenance] = useState<MaintenanceTarget | null>(null);

  const host = inventoryQuery.data?.host ?? hostQuery.data;
  const inventory = inventoryQuery.data;
  const remote = host ? host.kind !== "local" : hostId !== "host-local";

  const sortedContainers = useMemo(() => sortContainers(inventory?.containers ?? []), [inventory?.containers]);

  async function copy(value: string, title: string, description = value) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(title, description);
    } catch {
      toast.error("Copy failed", "Clipboard access is blocked in this browser.");
    }
  }

  async function refreshInventory() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.inventory(hostId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.host(hostId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.hosts }),
      queryClient.invalidateQueries({ queryKey: ["audit"] }),
    ]);
  }

  async function confirmWorkerUpdate() {
    if (!host) return;
    try {
      await updateWorker.mutateAsync(host.id);
      toast.success("Worker update started", `${host.name} will reconnect when the new container is healthy.`);
      setUpdateOpen(false);
      await refreshInventory();
    } catch (error) {
      toast.error("Worker update failed", errorMessage(error, "The worker update could not be started."));
    }
  }

  async function performAction(container: DockerContainer, action: string): Promise<boolean> {
    if (!canContainerWrite || container.unmanaged) return false;
    const key = `${container.id}:${action}`;
    setBusy(key);
    try {
      await api.containerAction(container.id, action, hostId);
      const outcome = action === "remove"
        ? "removed"
        : action === "start"
          ? "started"
          : action === "stop"
            ? "stopped"
            : action === "restart"
              ? "restarted"
              : titleCase(action);
      toast.success(`Container ${outcome}`, container.names);
      await refreshInventory();
      return true;
    } catch (error) {
      toast.error(`${titleCase(action)} failed`, errorMessage(error, "Docker did not accept the action."));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function removeContainer() {
    if (!removeTarget) return;
    const removed = await performAction(removeTarget, "remove");
    if (removed) setRemoveTarget(null);
  }

  function loadLogs(container: DockerContainer) {
    setLogsTarget(container);
  }

  function closeLogs() {
    setLogsTarget(null);
  }

  if (hostQuery.isLoading && !inventoryQuery.data) return <HostPageSkeleton />;

  if (!host) {
    return (
      <div className="panel">
        <EmptyState
          icon={<TriangleAlert size={20} />}
          title="Host unavailable"
          description={errorMessage(hostQuery.error, "Cetus could not load this host. It may have been removed.")}
          action={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <Button
                onClick={() => {
                  void hostQuery.refetch();
                  void inventoryQuery.refetch();
                }}
              >
                <RefreshCw size={14} /> Retry
              </Button>
              <Link to="/stacks" className="btn">Back to stacks</Link>
            </div>
          }
        />
      </div>
    );
  }

  const dockerRoot = inventory?.info?.dockerRootDir ?? "";
  const counts: Partial<Record<HostTab, number>> = inventory
    ? {
        containers: inventory.containers.length,
        images: inventory.images.length,
        volumes: inventory.volumes.length,
        networks: inventory.networks.length,
        df: inventory.df.length,
      }
    : {};

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, color: "var(--muted)", fontSize: 12 }}>
        <Link to="/" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }}>
          <ArrowLeft size={14} /> Fleet
        </Link>
        <ChevronRight size={12} />
        <Link to="/hosts" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }}>Hosts</Link>
      </div>

      <div className="page-header" style={{ marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 26, fontWeight: 650, letterSpacing: "-0.045em" }}>{host.name}</h2>
            <StatusBadge status={host.status} />
            <Badge>{titleCase(host.kind)} host</Badge>
            {host.workerUpdateAvailable ? <Badge tone="warn">Update available</Badge> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 7, color: "var(--muted)", fontSize: 12 }}>
            <span>{host.dockerVersion ? `Docker ${host.dockerVersion}` : "Docker version unavailable"}</span>
            <span>·</span>
            <span>Cetus {host.cetusVersion ?? "version not reported"}</span>
            <span>·</span>
            <span>{host.os ?? inventory?.info?.os ?? "OS unavailable"} / {host.arch ?? inventory?.info?.architecture ?? "arch unavailable"}</span>
            <span>·</span>
            <span>{host.cpus ?? inventory?.info?.cpus ?? "n/a"} CPUs</span>
            <span>·</span>
            <span>{formatBytes(host.memory)} memory</span>
            <span>·</span>
            <span title={host.lastSeenAt ? formatDate(host.lastSeenAt) : undefined}>last seen {relativeTime(host.lastSeenAt)}</span>
          </div>
        </div>
        <div className="page-actions">
          {host.kind === "worker" && host.workerUpdateAvailable ? (
            <Button
              variant="primary"
              onClick={() => setUpdateOpen(true)}
              disabled={!host.workerUpdateSupported || host.status !== "online" || !canWorkerUpdate}
              title={
                !host.workerUpdateSupported
                  ? "Update this worker manually once to enable panel updates."
                  : host.status !== "online"
                    ? "This worker is offline. Start it before updating."
                    : !canWorkerUpdate ? scopeReason("updates:apply") : undefined
              }
            >
              <RefreshCw size={14} /> Update worker
            </Button>
          ) : null}
          <Link to="/stacks" search={{ hostId }} className="btn">
            <Layers size={14} /> Open stacks
          </Link>
          <Button
            onClick={() => void copy(DOCKER_SOCKET, "Docker socket copied")}
            disabled={remote}
            title={remote ? "The Docker socket is only exposed for the local host." : DOCKER_SOCKET}
          >
            <Copy size={14} /> Copy socket
          </Button>
          <Button
            onClick={() => void copy(dockerRoot, "Docker root copied")}
            disabled={!dockerRoot}
            title={dockerRoot || "Docker root is not reported yet."}
          >
            <Copy size={14} /> Copy root dir
          </Button>
          <Link to="/hosts/enroll" className="btn">
            <Plus size={14} /> Add worker
          </Link>
        </div>
      </div>

      {host.kind === "worker" && (!host.cetusVersion || (host.workerUpdateAvailable && !host.workerUpdateSupported)) ? (
        <div
          className="panel"
          style={{ padding: "10px 14px", marginBottom: 14, borderColor: "color-mix(in oklab, var(--warn) 35%, transparent)" }}
        >
          <strong style={{ fontSize: 12.5 }}>Manual update required</strong>
          <div className="help" style={{ marginTop: 3 }}>
            This worker has not reported a Cetus version or predates self-update support. Update it once with its worker
            compose file. After it reconnects on the new build, the update button and global schedule will manage it.
          </div>
        </div>
      ) : null}

      {!inventory && inventoryQuery.isLoading ? (
        <SummarySkeleton />
      ) : (
        <SummaryStrip host={host} inventory={inventory} />
      )}

      <div style={{ overflowX: "auto", marginBottom: 14, paddingBottom: 2 }}>
        <div className="tabs" role="tablist" aria-label="Host inventory" style={{ width: "max-content" }}>
          {TABS.map((item) => {
            const count = counts[item.id];
            return (
              <button
                key={item.id}
                id={`host-tab-${item.id}`}
                role="tab"
                aria-selected={tab === item.id}
                aria-controls="host-panel"
                className="tab"
                data-active={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                {count !== undefined ? <span className="tab-count">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id="host-panel"
        aria-labelledby={`host-tab-${tab}`}
      >
        {!inventory && inventoryQuery.isLoading ? (
          <InventorySkeleton />
        ) : !inventory && inventoryQuery.isError ? (
          <QueryErrorPanel
            title="Inventory unavailable"
            description={errorMessage(inventoryQuery.error, "Cetus could not read Docker inventory for this host.")}
            onRetry={() => void inventoryQuery.refetch()}
          />
        ) : inventory ? (
          tab === "overview" ? (
            <OverviewTab
              host={host}
              inventory={inventory}
              stacks={stacksQuery.data ?? []}
              stacksLoading={stacksQuery.isLoading}
              stacksError={stacksQuery.error}
              onRetryStacks={() => void stacksQuery.refetch()}
              onOpenContainers={() => setTab("containers")}
            />
          ) : tab === "containers" ? (
            <ContainersTab
              host={host}
              containers={sortedContainers}
              busy={busy}
              canWrite={canContainerWrite}
              canPrune={canSystemPrune}
              onPrune={() => setMaintenance({ kind: "container-prune" })}
              onAction={(container, action) => void performAction(container, action)}
              onLogs={(container) => void loadLogs(container)}
              onRemove={setRemoveTarget}
            />
          ) : tab === "images" ? (
            <ImagesTab
              images={inventory.images}
              canWrite={canImageWrite}
              canPrune={canImagePrune}
              onRemove={(image) => setMaintenance({ kind: "image-remove", image })}
              onPrune={() => setMaintenance({ kind: "image-prune" })}
            />
          ) : tab === "volumes" ? (
            <VolumesTab
              volumes={inventory.volumes}
              canWrite={canVolumeWrite}
              canPrune={canVolumePrune}
              onRemove={(volume) => setMaintenance({ kind: "volume-remove", volume })}
              onPrune={() => setMaintenance({ kind: "volume-prune" })}
            />
          ) : tab === "networks" ? (
            <NetworksTab
              networks={inventory.networks}
              canWrite={canNetworkWrite}
              canPrune={canNetworkPrune}
              onRemove={(network) => setMaintenance({ kind: "network-remove", network })}
              onPrune={() => setMaintenance({ kind: "network-prune" })}
            />
          ) : (
            <DfTab
              rows={inventory.df}
              canPrune={canSystemPrune}
              onPrune={() => setMaintenance({ kind: "system-prune" })}
            />
          )
        ) : null}
      </div>

      <Dialog
        open={removeTarget !== null}
        onClose={() => {
          if (!busy) setRemoveTarget(null);
        }}
        title="Remove container"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)} disabled={busy !== null}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => void removeContainer()}
              loading={removeTarget ? busy === `${removeTarget.id}:remove` : false}
              disabled={busy !== null}
            >
              <Trash2 size={14} /> Remove
            </Button>
          </>
        }
      >
        {removeTarget ? (
          <>
            <p style={{ marginTop: 0, color: "var(--text-soft)" }}>
              This runs <code className="mono">docker rm -f {removeTarget.names}</code>. The container and its writable layer are removed.
              Images, named volumes, and Compose files are not touched.
            </p>
            <div className="surface-soft" style={{ display: "grid", gap: 4, padding: "10px 12px", fontSize: 12, overflowWrap: "anywhere" }}>
              <span className="mono">{removeTarget.names}</span>
              <span className="mono muted" style={{ fontSize: 11 }}>{removeTarget.id}</span>
              <span className="muted">{removeTarget.image}</span>
            </div>
            <p className="help" style={{ marginTop: 12 }}>
              Managed containers can be recreated by the next Compose deploy. Removing a container does not remove its stack.
            </p>
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={updateOpen}
        onClose={() => {
          if (!updateWorker.isPending) setUpdateOpen(false);
        }}
        title={`Update ${host.name}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUpdateOpen(false)} disabled={updateWorker.isPending}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void confirmWorkerUpdate()}
              loading={updateWorker.isPending}
            >
              <RefreshCw size={14} /> Update worker
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0, color: "var(--text-soft)" }}>
          This pulls the current Cetus image and recreates the worker container. The worker is briefly offline while the
          new container starts and passes its health check.
        </p>
        <div className="surface-soft" style={{ display: "grid", gap: 4, padding: "10px 12px", fontSize: 12 }}>
          <span>Worker version: <span className="mono">{host.cetusVersion ?? "not reported"}</span></span>
          <span className="muted">The manager and worker images should match after the update.</span>
        </div>
      </Dialog>

      <Dialog
        open={logsTarget !== null}
        onClose={closeLogs}
        title={logsTarget ? `Logs: ${logsTarget.names}` : "Container logs"}
        wide
        footer={
          <>
            {logsTarget ? (
              <Link
                to="/logs"
                search={{ container: logsTarget.id, host: hostId }}
                className="btn"
                onClick={closeLogs}
              >
                <ExternalLink size={13} /> Open full view
              </Link>
            ) : null}
            <Button variant="ghost" onClick={closeLogs}>Close</Button>
          </>
        }
      >
        {logsTarget ? (
          <LogViewer
            source={{
              kind: "container",
              id: logsTarget.id,
              hostId,
              title: logsTarget.names,
              subtitle: `${logsTarget.image} · ${hostId}`,
              remote,
              live: logsTarget.state === "running",
            }}
            compact
          />
        ) : null}
      </Dialog>

      <HostMaintenanceDialog
        hostId={hostId}
        target={maintenance}
        onClose={() => setMaintenance(null)}
      />
    </div>
  );
}

function SummaryStrip({ host, inventory }: { host: HostSummary; inventory: HostInventory | undefined }) {
  const containers = inventory?.containers ?? [];
  const running = containers.filter((container) => container.state === "running").length;
  const total = inventory ? containers.length : host.containerCount;
  const images = inventory ? inventory.images.length : host.imageCount;
  const volumes = inventory ? inventory.volumes.length : null;
  const networks = inventory ? inventory.networks.length : null;
  const disk = inventory?.disk ?? (
    host.diskUsed !== null && host.diskTotal !== null
      ? { used: host.diskUsed, total: host.diskTotal, available: Math.max(0, host.diskTotal - host.diskUsed) }
      : null
  );
  const diskPercent = disk && disk.total > 0 ? clampPercent((disk.used / disk.total) * 100) : null;

  return (
    <div
      className="surface-soft"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(158px, 1fr))",
        gap: 12,
        padding: "12px 14px",
        marginBottom: 14,
      }}
    >
      <SummaryItem
        icon={<ContainerIcon size={14} />}
        label="Containers"
        value={inventory ? `${running}/${total}` : "n/a"}
        sub={inventory ? `${running} running` : `${total} total, inventory unavailable`}
      />
      <SummaryItem
        icon={<Images size={14} />}
        label="Images"
        value={images}
        sub="cached on this host"
      />
      <SummaryItem
        icon={<Database size={14} />}
        label="Volumes"
        value={volumes ?? "n/a"}
        sub={volumes === null ? "not reported" : "named volumes"}
      />
      <SummaryItem
        icon={<Network size={14} />}
        label="Networks"
        value={networks ?? "n/a"}
        sub={networks === null ? "not reported" : "bridge and overlay"}
      />
      <SummaryItem
        icon={<HardDrive size={14} />}
        label="Disk"
        value={diskPercent === null ? "n/a" : formatPercent(diskPercent)}
        sub={disk ? `${formatBytes(disk.used)} of ${formatBytes(disk.total)} · ${formatBytes(disk.available)} free` : "not reported"}
        progress={diskPercent === null ? undefined : { value: diskPercent, tone: usageTone(diskPercent) }}
      />
    </div>
  );
}

function SummaryItem({
  icon,
  label,
  value,
  sub,
  progress,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  progress?: { value: number; tone?: "warn" | "danger" };
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          style={{
            width: 30,
            height: 30,
            display: "grid",
            placeItems: "center",
            flex: "none",
            borderRadius: 9,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            color: "var(--accent)",
          }}
        >
          {icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="metric-label" style={{ fontSize: 10 }}>{label}</div>
          <div style={{ marginTop: 2, fontSize: 13, fontWeight: 650, letterSpacing: "-0.02em" }}>{value}</div>
        </div>
      </div>
      {sub ? <div className="muted" style={{ marginTop: 5, marginLeft: 39, fontSize: 11 }}>{sub}</div> : null}
      {progress ? (
        <div
          className="progress"
          data-tone={progress.tone}
          style={{ marginTop: 7, marginLeft: 39 }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.value)}
          aria-label={`${label} usage`}
        >
          <span style={{ width: `${progress.value}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function HostStacksPanel({
  host,
  stacks,
  loading,
  error,
  onRetry,
}: {
  host: HostSummary;
  stacks: StackSummary[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const preview = stacks.slice(0, 8);

  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Layers size={15} color="var(--accent)" />
          <h3>Stacks</h3>
          {loading ? <Skeleton className="h-5 w-7" /> : <Badge>{stacks.length}</Badge>}
        </div>
        {loading || error || stacks.length > 0 ? (
          <Link to="/stacks" search={{ hostId: host.id }} className="btn btn-ghost btn-sm">
            View all <ChevronRight size={12} />
          </Link>
        ) : null}
      </div>

      {loading ? (
        <div style={{ display: "grid", gap: 10, padding: 16 }}>
          {[0, 1, 2].map((row) => <Skeleton key={row} className="h-9 w-full" />)}
        </div>
      ) : error ? (
        <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <TriangleAlert size={15} color="var(--warn)" />
          <span className="muted" style={{ fontSize: 12 }}>
            {errorMessage(error, "Stacks could not be loaded for this host.")}
          </span>
          <Button size="sm" variant="ghost" onClick={onRetry} style={{ marginLeft: "auto" }}>
            <RefreshCw size={12} /> Retry
          </Button>
        </div>
      ) : preview.length === 0 ? (
        <div className="panel-body" style={{ display: "grid", gap: 4 }}>
          <strong style={{ fontSize: 12.5, fontWeight: 600 }}>No stacks indexed</strong>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {host.kind === "worker"
              ? "This worker has not reported any Compose stacks yet."
              : "Scan the stacks folder or create a Compose project to see it here."}
          </span>
        </div>
      ) : (
        <div className="table-wrap" style={{ borderRadius: 0 }}>
          <table className="data-table" aria-label={`Stacks on ${host.name}`}>
            <thead>
              <tr>
                <th scope="col">Stack</th>
                <th scope="col">Status</th>
                <th scope="col">Services</th>
                <th scope="col">Last deploy</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((stack) => (
                <tr key={stack.id}>
                  <td data-label="Stack">
                    <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                      <span className="stack-avatar" aria-hidden="true" style={{ width: 28, height: 28 }}>
                        <Layers size={13} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <Link
                            to="/stacks/$stackId"
                            params={{ stackId: stack.id }}
                            className="container-stack-link"
                            style={{
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {stack.displayName}
                          </Link>
                          {stack.updateAvailable ? <Badge tone="info">Update</Badge> : null}
                        </div>
                        <div
                          className="mono muted"
                          style={{
                            marginTop: 1,
                            fontSize: 10.5,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {stack.name}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td data-label="Status"><StatusBadge status={stack.status} /></td>
                  <td data-label="Services">
                    <span
                      className="mono"
                      style={{ fontSize: 11.5 }}
                      title={`${stack.runningCount} of ${stack.serviceCount} services running`}
                    >
                      {stack.runningCount}/{stack.serviceCount}
                    </span>
                  </td>
                  <td data-label="Last deploy">
                    <span
                      className="muted"
                      style={{ fontSize: 11.5 }}
                      title={stack.lastDeployedAt ? formatDate(stack.lastDeployedAt) : "Not deployed yet"}
                    >
                      {stack.lastDeployedAt ? relativeTime(stack.lastDeployedAt) : "Never"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OverviewTab({
  host,
  inventory,
  stacks,
  stacksLoading,
  stacksError,
  onRetryStacks,
  onOpenContainers,
}: {
  host: HostSummary;
  inventory: HostInventory;
  stacks: StackSummary[];
  stacksLoading: boolean;
  stacksError: unknown;
  onRetryStacks: () => void;
  onOpenContainers: () => void;
}) {
  const info = inventory.info;
  const disk = inventory.disk;
  const running = inventory.containers.filter((container) => container.state === "running");
  const runningPreview = [...running].sort((a, b) => a.names.localeCompare(b.names)).slice(0, 8);
  const warnings = info?.warnings ?? [];
  const memoryTotal = host.memory ?? inventory.host.memory ?? info?.memory ?? null;
  const memoryUsed = host.memoryUsed ?? inventory.host.memoryUsed ?? null;
  const memoryPercent = memoryTotal && memoryTotal > 0 && memoryUsed !== null
    ? clampPercent((memoryUsed / memoryTotal) * 100)
    : null;
  const diskPercent = disk && disk.total > 0 ? clampPercent((disk.used / disk.total) * 100) : null;
  const cpuPercent = clampPercent(host.cpuUsage ?? inventory.host.cpuUsage);

  return (
    <div className="stack-layout">
      <div className="stack-main">
        <HostStacksPanel
          host={host}
          stacks={stacks}
          loading={stacksLoading}
          error={stacksError}
          onRetry={onRetryStacks}
        />

        <section className="panel">
          <div className="panel-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ContainerIcon size={15} color="var(--accent)" />
              <h3>Running containers</h3>
              <Badge>{running.length}</Badge>
            </div>
            <Button size="sm" variant="ghost" onClick={onOpenContainers}>
              View all <ChevronRight size={12} />
            </Button>
          </div>
          {runningPreview.length ? (
            <div className="table-wrap" style={{ borderRadius: 0 }}>
              <table className="data-table" aria-label="Running containers">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Image</th>
                    <th scope="col">Compose</th>
                    <th scope="col">Ports</th>
                    <th scope="col">Uptime</th>
                  </tr>
                </thead>
                <tbody>
                  {runningPreview.map((container) => (
                    <tr key={container.id}>
                      <td data-label="Name">
                        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                          {container.stackId ? (
                            <Link
                              to="/stacks/$stackId"
                              params={{ stackId: container.stackId }}
                              className="container-stack-link"
                              style={{ fontWeight: 600 }}
                              title={`Open ${container.project ?? "stack"}`}
                            >
                              {container.names}
                            </Link>
                          ) : (
                            <strong style={{ fontWeight: 600 }}>{container.names}</strong>
                          )}
                          <span className="mono muted" style={{ fontSize: 10.5 }}>{shortId(container.id, 12)}</span>
                        </div>
                      </td>
                      <td data-label="Image">
                        <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>{container.image}</span>
                      </td>
                      <td data-label="Compose">
                        {container.project ? (
                          container.stackId ? (
                            <Link
                              to="/stacks/$stackId"
                              params={{ stackId: container.stackId }}
                              className="mono container-stack-link"
                              style={{ fontSize: 11.5 }}
                              title={`Open ${container.project}`}
                            >
                              {container.project}/{container.service ?? "service"}
                            </Link>
                          ) : (
                            <span className="mono" style={{ fontSize: 11.5 }}>{container.project}/{container.service ?? "service"}</span>
                          )
                        ) : (
                          <span className="badge badge-warn" style={{ minHeight: 18, fontSize: 9.5 }}>unmanaged</span>
                        )}
                      </td>
                      <td data-label="Ports"><PortList ports={container.ports} host={host} /></td>
                      <td data-label="Uptime"><span className="muted" style={{ fontSize: 11.5 }}>{container.runningFor || "n/a"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<ContainerIcon size={18} />}
              title="No running containers"
              description="Stopped containers wait in the Containers tab. Deploy a stack to bring services up."
            />
          )}
        </section>
      </div>

      <aside className="inspector">
        <section className="surface metric">
          <div className="metric-label"><Cpu size={12} /> CPU load</div>
          <div className="metric-value">{formatPercent(cpuPercent)}</div>
          <div className="metric-sub">{host.cpus ?? inventory.host.cpus ?? info?.cpus ?? "n/a"} cores available</div>
          {cpuPercent !== null ? (
            <div
              className="progress"
              data-tone={usageTone(cpuPercent)}
              style={{ marginTop: 12 }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(cpuPercent)}
              aria-label="CPU load"
            >
              <span style={{ width: `${cpuPercent}%` }} />
            </div>
          ) : null}
        </section>

        <section className="surface metric">
          <div className="metric-label"><MemoryStick size={12} /> Memory in use</div>
          <div className="metric-value">{formatPercent(memoryPercent)}</div>
          <div className="metric-sub">
            {memoryUsed !== null && memoryTotal !== null
              ? `${formatBytes(memoryUsed)} of ${formatBytes(memoryTotal)}`
              : "Memory usage not reported"}
          </div>
          {memoryPercent !== null ? (
            <div
              className="progress"
              data-tone={usageTone(memoryPercent)}
              style={{ marginTop: 12 }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(memoryPercent)}
              aria-label="Memory usage"
            >
              <span style={{ width: `${memoryPercent}%` }} />
            </div>
          ) : null}
        </section>

        <section className="surface metric">
          <div className="metric-label"><HardDrive size={12} /> Disk</div>
          <div className="metric-value">{formatPercent(diskPercent)}</div>
          <div className="metric-sub">
            {disk
              ? `${formatBytes(disk.used)} of ${formatBytes(disk.total)} · ${formatBytes(disk.available)} free`
              : "Disk usage not reported"}
          </div>
          {diskPercent !== null ? (
            <div
              className="progress"
              data-tone={usageTone(diskPercent)}
              style={{ marginTop: 12 }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(diskPercent)}
              aria-label="Disk usage"
            >
              <span style={{ width: `${diskPercent}%` }} />
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Server size={15} color="var(--accent)" />
              <h3>Docker engine</h3>
            </div>
            <span className="mono muted" style={{ fontSize: 11 }}>{info?.serverVersion ?? "not reported"}</span>
          </div>
          <div className="panel-body">
            {info ? (
              <>
                <dl className="kv">
                  <dt>Server version</dt><dd className="mono">{info.serverVersion}</dd>
                  <dt>API version</dt><dd className="mono">{info.apiVersion}</dd>
                  <dt>OS</dt><dd>{info.os}</dd>
                  <dt>Kernel</dt><dd className="mono">{info.kernel}</dd>
                  <dt>Architecture</dt><dd>{info.architecture}</dd>
                  <dt>Driver</dt><dd>{info.driver || "n/a"}</dd>
                  <dt>Docker root</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{info.dockerRootDir || "n/a"}</dd>
                  <dt>Socket</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{DOCKER_SOCKET}</dd>
                  <dt>Containers</dt>
                  <dd>{info.containersRunning} running · {info.containersStopped} stopped · {info.containersPaused} paused</dd>
                  <dt>Images</dt><dd>{info.images}</dd>
                  <dt>Warnings</dt><dd>{warnings.length ? `${warnings.length} reported` : "None reported"}</dd>
                </dl>
                {warnings.length ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 9,
                      marginTop: 14,
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid color-mix(in oklab, var(--warn) 30%, transparent)",
                      background: "var(--warn-soft)",
                    }}
                  >
                    <TriangleAlert size={14} color="var(--warn)" style={{ flex: "none", marginTop: 2 }} />
                    <div>
                      <div style={{ color: "var(--warn)", fontSize: 12, fontWeight: 600 }}>Docker warnings</div>
                      <ul style={{ margin: "5px 0 0", paddingLeft: 18, color: "var(--text-soft)", fontSize: 12 }}>
                        {warnings.map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState
                icon={<Server size={18} />}
                title="Docker engine unavailable"
                description="Docker did not return engine information for this host. Inventory retries automatically."
              />
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function ContainersTab({
  host,
  containers,
  busy,
  canWrite,
  canPrune,
  onAction,
  onLogs,
  onRemove,
  onPrune,
}: {
  host: HostSummary;
  containers: DockerContainer[];
  busy: string | null;
  canWrite: boolean;
  canPrune: boolean;
  onAction: (container: DockerContainer, action: string) => void;
  onLogs: (container: DockerContainer) => void;
  onRemove: (container: DockerContainer) => void;
  onPrune: () => void;
}) {
  const running = containers.filter((container) => container.state === "running").length;
  const unmanaged = containers.filter((container) => container.unmanaged).length;
  const writeReason = canWrite ? undefined : scopeReason("containers:write");
  const pruneReason = canPrune ? "Remove stopped containers." : scopeReason("system:prune");

  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ContainerIcon size={15} color="var(--accent)" />
          <h3>Containers</h3>
          <Badge>{containers.length}</Badge>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted hidden sm:inline" style={{ fontSize: 11 }}>
            {running} running{unmanaged ? ` · ${unmanaged} unmanaged` : ""}
          </span>
          <Button size="sm" variant="ghost" onClick={onPrune} disabled={!canPrune} title={pruneReason}>
            <Trash2 size={12} /> Prune
          </Button>
        </div>
      </div>
      {containers.length ? (
        <div className="table-wrap" style={{ borderRadius: 0 }}>
          <table className="data-table" aria-label="Containers on this host">
            <thead>
              <tr>
                <th scope="col">Container</th>
                <th scope="col">Image</th>
                <th scope="col">State</th>
                <th scope="col">Status</th>
                <th scope="col">Ports</th>
                <th scope="col">Compose</th>
                <th scope="col" style={{ width: 214 }}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {containers.map((container) => {
                const actionPrefix = `${container.id}:`;
                const rowBusy = busy?.startsWith(actionPrefix) ?? false;
                const actionReason = container.unmanaged ? "Standalone containers are read-only" : writeReason;
                const actionsDisabled = busy !== null || !canWrite || container.unmanaged;
                const stackId = container.stackId ?? null;
                return (
                  <tr key={container.id}>
                    <td data-label="Container">
                      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flexWrap: "wrap" }}>
                        {stackId ? (
                          <Link
                            to="/stacks/$stackId"
                            params={{ stackId }}
                            className="container-stack-link"
                            style={{ fontWeight: 600, overflowWrap: "anywhere" }}
                            title={`Open ${container.project ?? "stack"}`}
                          >
                            {container.names}
                          </Link>
                        ) : (
                          <strong style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{container.names}</strong>
                        )}
                        {container.unmanaged ? (
                          <span
                            className="badge badge-warn"
                            style={{ minHeight: 18, padding: "1px 6px", fontSize: 9.5 }}
                            title="Not created by Docker Compose"
                          >
                            unmanaged
                          </span>
                        ) : null}
                      </div>
                      <div className="mono muted" style={{ marginTop: 2, fontSize: 10.5 }}>{shortId(container.id, 12)}</div>
                    </td>
                    <td data-label="Image">
                      <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)", overflowWrap: "anywhere" }}>{container.image}</span>
                    </td>
                    <td data-label="State"><ContainerStateBadge state={container.state} /></td>
                    <td data-label="Status"><span className="muted" style={{ fontSize: 11.5 }}>{container.status || "n/a"}</span></td>
                    <td data-label="Ports"><PortList ports={container.ports} host={host} /></td>
                    <td data-label="Compose">
                      {container.unmanaged ? (
                        <span className="muted" style={{ fontSize: 11 }}>Not Compose managed</span>
                      ) : (
                        <div style={{ display: "grid", gap: 2, whiteSpace: "nowrap" }}>
                          {stackId ? (
                            <Link
                              to="/stacks/$stackId"
                              params={{ stackId }}
                              className="mono container-stack-link"
                              style={{ fontSize: 11.5 }}
                              title={`Open ${container.project ?? "stack"}`}
                            >
                              {container.project}
                            </Link>
                          ) : (
                            <span className="mono" style={{ fontSize: 11.5 }}>{container.project}</span>
                          )}
                          <span className="muted" style={{ fontSize: 10.5 }}>{container.service ?? "service"}</span>
                        </div>
                      )}
                    </td>
                    <td data-label="Actions" style={{ whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, flexWrap: "nowrap" }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Logs for ${container.names}`}
                          title={`Logs for ${container.names}`}
                          onClick={() => onLogs(container)}
                        >
                          <ScrollText size={12} /> Logs
                        </Button>
                        {container.state === "running" ? (
                          <>
                            <IconButton
                              label={`Stop ${container.names}${actionReason ? ` (${actionReason})` : ""}`}
                              title={actionReason ?? `Stop ${container.names}`}
                              disabled={actionsDisabled}
                              aria-disabled={actionsDisabled}
                              onClick={() => onAction(container, "stop")}
                            >
                              {busy === `${container.id}:stop` ? <LoaderCircle size={13} className="animate-spin" /> : <Square size={13} />}
                            </IconButton>
                            <IconButton
                              label={`Restart ${container.names}${actionReason ? ` (${actionReason})` : ""}`}
                              title={actionReason ?? `Restart ${container.names}`}
                              disabled={actionsDisabled}
                              aria-disabled={actionsDisabled}
                              onClick={() => onAction(container, "restart")}
                            >
                              {busy === `${container.id}:restart` ? <LoaderCircle size={13} className="animate-spin" /> : <RotateCw size={13} />}
                            </IconButton>
                          </>
                        ) : (
                          <IconButton
                            label={`Start ${container.names}${actionReason ? ` (${actionReason})` : ""}`}
                            title={actionReason ?? `Start ${container.names}`}
                            disabled={actionsDisabled}
                            aria-disabled={actionsDisabled}
                            onClick={() => onAction(container, "start")}
                          >
                            {busy === `${container.id}:start` ? <LoaderCircle size={13} className="animate-spin" /> : <Play size={13} />}
                          </IconButton>
                        )}
                        <IconButton
                          label={`Remove ${container.names}${actionReason ? ` (${actionReason})` : ""}`}
                          title={actionReason ?? `Remove ${container.names}`}
                          disabled={rowBusy || actionsDisabled}
                          aria-disabled={actionsDisabled}
                          onClick={() => onRemove(container)}
                          style={{ color: "var(--danger)" }}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<ContainerIcon size={18} />}
          title="No containers reported"
          description="Nothing is running or stopped on this host. Deploy a stack to create containers."
        />
      )}
    </section>
  );
}

function ImagesTab({
  images,
  canWrite,
  canPrune,
  onRemove,
  onPrune,
}: {
  images: DockerImage[];
  canWrite: boolean;
  canPrune: boolean;
  onRemove: (image: DockerImage) => void;
  onPrune: () => void;
}) {
  const writeReason = canWrite ? undefined : scopeReason("images:write");
  const pruneReason = !canPrune
    ? scopeReason("images:prune")
    : images.length === 0
      ? "No images to prune."
      : "Remove unused images from this host.";
  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Images size={15} color="var(--accent)" />
          <h3>Images</h3>
          <Badge>{images.length}</Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={onPrune} disabled={!canPrune || images.length === 0} title={pruneReason}>
          <Trash2 size={12} /> Prune
        </Button>
      </div>
      {images.length ? (
        <div className="table-wrap" style={{ borderRadius: 0 }}>
          <table className="data-table" aria-label="Docker images">
            <thead>
              <tr>
                <th scope="col">Repository:tag</th>
                <th scope="col">Image ID</th>
                <th scope="col">Digest</th>
                <th scope="col">Size</th>
                <th scope="col">Created</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {images.map((image) => {
                const dangling = image.repository === "<none>";
                const label = dangling ? "dangling" : `${image.repository}:${image.tag || "none"}`;
                return (
                  <tr key={`${image.repository}:${image.tag}:${image.id}`}>
                    <td data-label="Repository:tag">
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{label}</span>
                        {dangling ? <Badge tone="warn">untagged</Badge> : null}
                      </div>
                    </td>
                    <td data-label="Image ID">
                      <span className="mono muted" style={{ fontSize: 11 }} title={image.id}>{shortImageId(image.id)}</span>
                    </td>
                    <td data-label="Digest">
                      <span className="mono muted" style={{ fontSize: 11 }} title={image.digest ?? undefined}>
                        {image.digest ? shortId(image.digest, 19) : "none"}
                      </span>
                    </td>
                    <td data-label="Size"><span style={{ fontSize: 12 }}>{image.size}</span></td>
                    <td data-label="Created" title={formatDate(image.createdAt)}>
                      <span className="muted" style={{ fontSize: 11.5 }}>{image.createdSince || formatDate(image.createdAt)}</span>
                    </td>
                    <td data-label="Actions">
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <IconButton
                          label={`Remove image ${label}`}
                          title={writeReason ?? `Remove ${label}`}
                          disabled={!canWrite}
                          onClick={() => onRemove(image)}
                          style={{ color: "var(--danger)" }}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<Images size={18} />}
          title="No images reported"
          description="Docker has no cached images on this host."
        />
      )}
    </section>
  );
}

function VolumesTab({
  volumes,
  canWrite,
  canPrune,
  onRemove,
  onPrune,
}: {
  volumes: DockerVolume[];
  canWrite: boolean;
  canPrune: boolean;
  onRemove: (volume: DockerVolume) => void;
  onPrune: () => void;
}) {
  const writeReason = canWrite ? undefined : scopeReason("volumes:write");
  const pruneReason = !canPrune
    ? scopeReason("volumes:prune")
    : volumes.length === 0
      ? "No volumes to prune."
      : "Remove unused volumes from this host.";
  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Database size={15} color="var(--accent)" />
          <h3>Volumes</h3>
          <Badge>{volumes.length}</Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={onPrune} disabled={!canPrune || volumes.length === 0} title={pruneReason}>
          <Trash2 size={12} /> Prune
        </Button>
      </div>
      {volumes.length ? (
        <div className="table-wrap" style={{ borderRadius: 0 }}>
          <table className="data-table" aria-label="Docker volumes">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Driver</th>
                <th scope="col">Scope</th>
                <th scope="col">Mountpoint</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {volumes.map((volume) => (
                <tr key={volume.name}>
                  <td data-label="Name">
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" }}>{volume.name}</span>
                  </td>
                  <td data-label="Driver"><span className="chip">{volume.driver || "local"}</span></td>
                  <td data-label="Scope"><span style={{ fontSize: 12 }}>{volume.scope || "n/a"}</span></td>
                  <td data-label="Mountpoint">
                    <span className="mono muted" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{volume.mountpoint || "n/a"}</span>
                  </td>
                  <td data-label="Actions">
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <IconButton
                        label={`Remove volume ${volume.name}`}
                        title={writeReason ?? `Remove ${volume.name}`}
                        disabled={!canWrite}
                        onClick={() => onRemove(volume)}
                        style={{ color: "var(--danger)" }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<Database size={18} />}
          title="No volumes reported"
          description="No named volumes exist on this host yet."
        />
      )}
    </section>
  );
}

function NetworksTab({
  networks,
  canWrite,
  canPrune,
  onRemove,
  onPrune,
}: {
  networks: DockerNetwork[];
  canWrite: boolean;
  canPrune: boolean;
  onRemove: (network: DockerNetwork) => void;
  onPrune: () => void;
}) {
  const writeReason = canWrite ? undefined : scopeReason("networks:write");
  const pruneReason = !canPrune
    ? scopeReason("networks:prune")
    : networks.length === 0
      ? "No networks to prune."
      : "Remove unused networks from this host.";
  const systemNetworks = new Set(["bridge", "host", "none", "docker_gwbridge", "ingress"]);
  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Network size={15} color="var(--accent)" />
          <h3>Networks</h3>
          <Badge>{networks.length}</Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={onPrune} disabled={!canPrune || networks.length === 0} title={pruneReason}>
          <Trash2 size={12} /> Prune
        </Button>
      </div>
      {networks.length ? (
        <div className="table-wrap" style={{ borderRadius: 0 }}>
          <table className="data-table" aria-label="Docker networks">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Driver</th>
                <th scope="col">Scope</th>
                <th scope="col">Internal</th>
                <th scope="col">IPv6</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {networks.map((network) => {
                const managed = systemNetworks.has(network.name);
                return (
                  <tr key={network.id}>
                    <td data-label="Name">
                      <div style={{ display: "grid", gap: 2 }}>
                        <strong className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{network.name}</strong>
                        <span className="mono muted" style={{ fontSize: 10.5 }}>{shortId(network.id, 12)}</span>
                      </div>
                    </td>
                    <td data-label="Driver"><span className="chip">{network.driver === "null" ? "n/a" : network.driver}</span></td>
                    <td data-label="Scope"><span style={{ fontSize: 12 }}>{network.scope}</span></td>
                    <td data-label="Internal">
                      <Badge tone={network.internal ? "warn" : "default"}>{network.internal ? "Yes" : "No"}</Badge>
                    </td>
                    <td data-label="IPv6">
                      <Badge tone={network.ipv6 ? "info" : "default"}>{network.ipv6 ? "Yes" : "No"}</Badge>
                    </td>
                    <td data-label="Actions">
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <IconButton
                          label={`Remove network ${network.name}`}
                          title={managed ? "Docker-managed networks cannot be removed." : writeReason ?? `Remove ${network.name}`}
                          disabled={!canWrite || managed}
                          onClick={() => onRemove(network)}
                          style={{ color: "var(--danger)" }}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<Network size={18} />}
          title="No networks reported"
          description="Docker has not created any networks beyond the defaults."
        />
      )}
    </section>
  );
}

function DfTab({
  rows,
  canPrune,
  onPrune,
}: {
  rows: DockerDfRow[];
  canPrune: boolean;
  onPrune: () => void;
}) {
  const pruneReason = !canPrune
    ? scopeReason("system:prune")
    : rows.length === 0
      ? "No Docker data to prune."
      : "Remove stopped containers, unused networks, dangling images, and build cache.";
  return (
    <section className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <HardDrive size={15} color="var(--accent)" />
          <h3>System DF</h3>
          <Badge>{rows.length}</Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={onPrune} disabled={!canPrune || rows.length === 0} title={pruneReason}>
          <Trash2 size={12} /> Prune
        </Button>
      </div>
      {rows.length ? (
        <div className="table-wrap" style={{ borderRadius: 0 }}>
          <table className="data-table" aria-label="Docker disk usage">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Total</th>
                <th scope="col">Active</th>
                <th scope="col">Size</th>
                <th scope="col">Reclaimable</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const percent = reclaimablePercent(row);
                return (
                  <tr key={`${row.type}-${index}`}>
                    <td data-label="Type">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 160 }}>
                        <strong style={{ fontWeight: 600 }}>{row.type}</strong>
                        <span className="mono muted" style={{ fontSize: 10.5 }}>{Math.round(percent)}%</span>
                      </div>
                      <div
                        className="progress"
                        data-tone={percent > 0 ? "warn" : undefined}
                        style={{ marginTop: 6, maxWidth: 240 }}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(percent)}
                        aria-label={`${row.type} reclaimable`}
                      >
                        <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
                      </div>
                    </td>
                    <td data-label="Total"><span className="mono" style={{ fontSize: 12 }}>{row.totalCount || "0"}</span></td>
                    <td data-label="Active"><span className="mono" style={{ fontSize: 12 }}>{row.active || "0"}</span></td>
                    <td data-label="Size"><span style={{ fontSize: 12 }}>{row.size || "0 B"}</span></td>
                    <td data-label="Reclaimable"><span style={{ fontSize: 12 }}>{row.reclaimable || "0 B"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<HardDrive size={18} />}
          title="No disk usage reported"
          description="Docker did not return system df rows for this host."
        />
      )}
    </section>
  );
}

function ContainerStateBadge({ state }: { state: string }) {
  const tone = state === "running"
    ? "success"
    : state === "exited" || state === "dead"
      ? "danger"
      : state === "paused" || state === "restarting"
        ? "warn"
        : state === "created"
          ? "info"
          : "default";
  return (
    <Badge tone={tone}>
      <span className="status-dot" data-status={state} />
      {titleCase(state)}
    </Badge>
  );
}

function PortList({ ports, host }: { ports: string; host: HostSummary }) {
  const values = parsePortTokens(ports);
  if (!values.length) return <span className="muted" style={{ fontSize: 11 }}>none</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {values.map((port, index) => {
        const href = publishedPortHref(port, host, window.location.hostname);
        const key = `${port.raw}-${index}`;
        return href ? (
          <a
            key={key}
            className="chip mono port-chip-link"
            style={{ fontSize: 10 }}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={`Open ${href}`}
          >
            {port.raw} <ExternalLink size={9} />
          </a>
        ) : (
          <span className="chip mono" key={key} style={{ fontSize: 10 }}>{port.raw}</span>
        );
      })}
    </div>
  );
}

function QueryErrorPanel({ title, description, onRetry }: { title: string; description: string; onRetry: () => void }) {
  return (
    <div className="panel">
      <EmptyState
        icon={<TriangleAlert size={20} />}
        title={title}
        description={description}
        action={
          <Button onClick={onRetry}>
            <RefreshCw size={14} /> Retry
          </Button>
        }
      />
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div
      className="surface-soft"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(158px, 1fr))",
        gap: 12,
        padding: "12px 14px",
        marginBottom: 14,
      }}
    >
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} style={{ display: "grid", gap: 7 }}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-5 w-28 max-w-full" />
        </div>
      ))}
    </div>
  );
}

function HostPageSkeleton() {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Skeleton className="h-4 w-28" />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 8 }}>
          <Skeleton className="h-8 w-56 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      <SummarySkeleton />
      <Skeleton className="h-9 w-96 max-w-full" />
      <div className="panel" style={{ padding: 16, display: "grid", gap: 10 }}>
        {[0, 1, 2, 3, 4].map((row) => <Skeleton key={row} className="h-9 w-full" />)}
      </div>
    </div>
  );
}

function InventorySkeleton() {
  return (
    <div className="panel" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-12" />
      </div>
      {[0, 1, 2, 3, 4, 5].map((row) => <Skeleton key={row} className="h-10 w-full" />)}
    </div>
  );
}

function sortContainers(containers: DockerContainer[]): DockerContainer[] {
  const rank = (state: string) => {
    if (state === "running") return 0;
    if (state === "restarting" || state === "paused") return 1;
    if (state === "created") return 2;
    return 3;
  };
  return [...containers].sort((a, b) => {
    const diff = rank(a.state) - rank(b.state);
    return diff !== 0 ? diff : a.names.localeCompare(b.names);
  });
}

function shortImageId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

function clampPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function usageTone(value: number | null): "warn" | "danger" | undefined {
  if (value === null) return undefined;
  if (value >= 90) return "danger";
  if (value >= 75) return "warn";
  return undefined;
}

function reclaimablePercent(row: DockerDfRow): number {
  const labeled = row.reclaimable.match(/\(([\d.]+)%\)/);
  if (labeled) {
    const value = Number(labeled[1]);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  }
  const size = parseDockerSize(row.size);
  const reclaimable = parseDockerSize(row.reclaimable);
  if (size <= 0) return 0;
  return Math.min(100, Math.max(0, (reclaimable / size) * 100));
}

function parseDockerSize(value: string): number {
  const match = value.split("(")[0].trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const powers: Record<string, number> = {
    B: 1,
    KB: 1_000,
    KIB: 1_024,
    MB: 1_000_000,
    MIB: 1_048_576,
    GB: 1_000_000_000,
    GIB: 1_073_741_824,
    TB: 1_000_000_000_000,
    TIB: 1_099_511_627_776,
  };
  return amount * (powers[unit] ?? 0);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}
