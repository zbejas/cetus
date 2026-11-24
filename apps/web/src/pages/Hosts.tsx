import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Boxes, ChevronRight, Container, Cpu, HardDrive, Images, Layers, Plus, Server } from "lucide-react";
import type { HostSummary } from "@shared/types";
import { ApiError, can, scopeReason } from "../lib/api";
import { useHosts, useMe, useUpdateWorker } from "../lib/queries";
import { Badge, Button, Dialog, EmptyState, PageHeader, Skeleton } from "../components/ui";
import { StatusDot } from "../components/Status";
import { useToast } from "../components/Toast";
import { formatBytes, relativeTime } from "../lib/format";

export function HostsPage() {
  const hosts = useHosts();
  const me = useMe();
  const updateWorker = useUpdateWorker();
  const toast = useToast();
  const list = hosts.data ?? [];
  const online = list.filter((host) => host.status === "online").length;
  const canUpdate = can(me.data?.actor.scopes, "updates:apply");
  const [updateTarget, setUpdateTarget] = useState<HostSummary | null>(null);

  async function confirmWorkerUpdate() {
    if (!updateTarget) return;
    try {
      await updateWorker.mutateAsync(updateTarget.id);
      toast.success("Worker update started", `${updateTarget.name} will reconnect when the new container is healthy.`);
      setUpdateTarget(null);
    } catch (error) {
      toast.error("Worker update failed", errorMessage(error, "The worker update could not be started."));
    }
  }

  return (
    <div>
      <PageHeader
        title="Hosts"
        description={list.length ? `${list.length} hosts · ${online} online` : "Docker engines managed by this Cetus instance."}
        actions={
          <Link to="/hosts/enroll" className="btn">
            <Plus size={14} /> Add worker
          </Link>
        }
      />

      {hosts.isLoading ? (
        <div className="hosts-grid" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="panel" style={{ padding: 18, display: "grid", gap: 12 }}>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-56" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      ) : hosts.isError ? (
        <div className="panel">
          <EmptyState
            icon={<Server size={20} />}
            title="Hosts unavailable"
            description="Cetus could not load the host list."
            action={<Button onClick={() => void hosts.refetch()}>Retry</Button>}
          />
        </div>
      ) : list.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<Server size={20} />}
            title="No hosts yet"
            description="Enroll a worker or start the local manager with the Docker socket mounted."
            action={<Link to="/hosts/enroll" className="btn btn-primary">Add a worker</Link>}
          />
        </div>
      ) : (
        <div className="hosts-grid">
          {list.map((host) => {
            const memoryPercent = host.memory && host.memoryUsed !== null
              ? Math.min(100, (host.memoryUsed / host.memory) * 100)
              : null;
            const diskPercent = host.diskTotal && host.diskUsed !== null
              ? Math.min(100, (host.diskUsed / host.diskTotal) * 100)
              : null;
            const updateReason = !host.workerUpdateSupported
              ? "Update this worker manually once to enable panel updates."
              : host.status !== "online"
                ? "This worker is offline. Start it before updating."
                : !canUpdate
                  ? scopeReason("updates:apply")
                  : undefined;
            return (
              <div key={host.id} className="panel host-card">
                <Link
                  to="/hosts/$hostId"
                  params={{ hostId: host.id }}
                  className="host-card-overlay"
                  aria-label={`Open ${host.name}`}
                />
                <div className="host-card-head">
                  <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                    <span className="host-icon"><Server size={16} /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="host-card-name">{host.name}</div>
                      <div className="host-card-meta">
                        {host.kind === "local" ? "Local manager" : "Worker host"} · {host.dockerVersion ?? "Docker not reported"} · Cetus {host.cetusVersion ?? "version not reported"}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {host.kind === "worker" && !host.cetusVersion ? <Badge tone="warn">Manual update</Badge> : null}
                    {host.workerUpdateAvailable ? <Badge tone="warn">Update available</Badge> : null}
                    <Badge tone={host.status === "online" ? "success" : "danger"}>
                      <StatusDot status={host.status} /> {host.status}
                    </Badge>
                  </div>
                </div>

                <div className="host-card-os">{host.os ?? "Operating system not reported"} / {host.arch ?? "arch n/a"} · {host.cpus ?? "n/a"} CPUs</div>

                <div className="host-card-stats">
                  <span><Layers size={12} /> <strong>{host.stackCount}</strong> {host.stackCount === 1 ? "stack" : "stacks"}</span>
                  <span><Container size={12} /> <strong>{host.containerCount}</strong> {host.containerCount === 1 ? "container" : "containers"}</span>
                  <span><Images size={12} /> <strong>{host.imageCount}</strong> {host.imageCount === 1 ? "image" : "images"}</span>
                </div>

                <div className="host-card-meters">
                  <div>
                    <span><Cpu size={11} /> CPU <em>{host.cpuUsage === null ? "n/a" : `${Math.round(host.cpuUsage)}%`}</em></span>
                    <div className="progress" data-tone={host.cpuUsage && host.cpuUsage > 80 ? "danger" : "success"}>
                      <span style={{ width: `${Math.min(100, host.cpuUsage ?? 0)}%` }} />
                    </div>
                  </div>
                  <div>
                    <span><HardDrive size={11} /> Disk <em>{diskPercent === null ? "n/a" : `${Math.round(diskPercent)}%`}</em></span>
                    <div className="progress" data-tone={diskPercent && diskPercent > 85 ? "danger" : "success"}>
                      <span style={{ width: `${diskPercent ?? 0}%` }} />
                    </div>
                  </div>
                </div>

                <div className="host-card-foot">
                  <span className="muted">{host.memory && host.memoryUsed !== null ? `${formatBytes(host.memoryUsed)} of ${formatBytes(host.memory)} memory` : "Memory not reported"}</span>
                  <span className="muted">seen {relativeTime(host.lastSeenAt)}</span>
                  {host.workerUpdateAvailable ? (
                    <span className="host-card-action" style={{ marginLeft: "auto" }}>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setUpdateTarget(host)}
                        loading={updateWorker.isPending && updateWorker.variables === host.id}
                        disabled={!host.workerUpdateSupported || host.status !== "online" || !canUpdate || updateWorker.isPending}
                        title={updateReason}
                      >
                        Update worker
                      </Button>
                    </span>
                  ) : (
                    <ChevronRight size={14} style={{ marginLeft: "auto" }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={updateTarget !== null}
        onClose={() => {
          if (!updateWorker.isPending) setUpdateTarget(null);
        }}
        title={updateTarget ? `Update ${updateTarget.name}` : "Update worker"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUpdateTarget(null)} disabled={updateWorker.isPending}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirmWorkerUpdate()} loading={updateWorker.isPending}>
              Update worker
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0, color: "var(--text-soft)" }}>
          This pulls the current Cetus image and recreates the worker container. The worker is briefly offline while the
          new container starts and passes its health check.
        </p>
        <div className="surface-soft" style={{ display: "grid", gap: 4, padding: "10px 12px", fontSize: 12 }}>
          <span>Worker version: <span className="mono">{updateTarget?.cetusVersion ?? "not reported"}</span></span>
          <span className="muted">The manager and worker images should match after the update.</span>
        </div>
      </Dialog>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}
