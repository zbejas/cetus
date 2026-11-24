import { Link } from "@tanstack/react-router";
import { Boxes, ChevronRight, Container, Cpu, HardDrive, Images, Layers, Plus, Server } from "lucide-react";
import { useHosts } from "../lib/queries";
import { Badge, Button, EmptyState, PageHeader, Skeleton } from "../components/ui";
import { StatusDot } from "../components/Status";
import { formatBytes, relativeTime } from "../lib/format";

export function HostsPage() {
  const hosts = useHosts();
  const list = hosts.data ?? [];
  const online = list.filter((host) => host.status === "online").length;

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
            return (
              <Link key={host.id} to="/hosts/$hostId" params={{ hostId: host.id }} className="panel host-card">
                <div className="host-card-head">
                  <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                    <span className="host-icon"><Server size={16} /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="host-card-name">{host.name}</div>
                      <div className="host-card-meta">
                        {host.kind === "local" ? "Local manager" : "Worker host"} · {host.dockerVersion ?? "Docker not reported"}
                      </div>
                    </div>
                  </div>
                  <Badge tone={host.status === "online" ? "success" : "danger"}>
                    <StatusDot status={host.status} /> {host.status}
                  </Badge>
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
                  <ChevronRight size={14} style={{ marginLeft: "auto" }} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
