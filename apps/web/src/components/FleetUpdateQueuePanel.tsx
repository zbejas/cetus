import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ListOrdered, TriangleAlert, X } from "lucide-react";
import type { UpdateQueueEntry } from "@shared/types";
import { can } from "../lib/api";
import { useMe, useRemoveUpdateQueueEntry, useReorderUpdateQueue, useUpdateQueue } from "../lib/queries";
import { formatDate, relativeTime, titleCase } from "../lib/format";
import { useToast } from "./Toast";
import { Badge, IconButton } from "./ui";

function statusTone(status: UpdateQueueEntry["status"]) {
  if (status === "running") return "accent" as const;
  if (status === "success") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "skipped") return "warn" as const;
  return "default" as const;
}

export function FleetUpdateQueuePanel() {
  const queue = useUpdateQueue();
  const me = useMe();
  const reorder = useReorderUpdateQueue();
  const remove = useRemoveUpdateQueueEntry();
  const toast = useToast();
  const canApply = can(me.data?.actor.scopes, "updates:apply");
  const active = queue.data?.active ?? [];
  const recent = queue.data?.recent ?? [];
  const pausedUntil = queue.data?.pausedUntil ?? null;

  if (active.length === 0 && recent.length === 0) return null;

  const queued = active.filter((entry) => entry.status === "queued");
  const running = active.filter((entry) => entry.status === "running");

  function move(id: string, direction: -1 | 1) {
    const ids = queued.map((entry) => entry.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids, {
      onError: (error) => toast.error("Queue not reordered", error instanceof Error ? error.message : "The queue changed."),
    });
  }

  function drop(entry: UpdateQueueEntry) {
    remove.mutate(entry.id, {
      onSuccess: () => toast.success("Removed from queue", `${entry.displayName} will not update from the queue.`),
      onError: (error) => toast.error("Could not remove from queue", error instanceof Error ? error.message : "The queue changed."),
    });
  }

  return (
    <section className="panel" aria-label="Update queue">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ListOrdered size={15} color="var(--accent)" />
          <h3>Update queue</h3>
          <Badge tone={active.length > 0 ? "accent" : "default"}>
            {active.length > 0 ? `${active.length} active` : "Idle"}
          </Badge>
        </div>
        <span className="muted hidden sm:inline" style={{ fontSize: 11 }}>Runs one stack at a time</span>
      </div>
      <div className="panel-body" style={{ display: "grid", gap: 12 }}>
        {pausedUntil && active.length > 0 ? (
          <div className="update-queue-paused">
            <TriangleAlert size={13} />
            <span>Paused after a registry rate limit until {formatDate(pausedUntil)}.</span>
          </div>
        ) : null}
        {active.length > 0 ? (
          <div className="update-queue-list">
            {running.map((entry) => (
              <div key={entry.id} className="update-queue-row" data-status="running">
                <span className="update-queue-index"><span className="update-queue-dot" /></span>
                <div className="update-queue-main">
                  <Link to="/stacks/$stackId" params={{ stackId: entry.stackId }} className="update-queue-name" title={entry.displayName}>
                    {entry.displayName}
                  </Link>
                  <span className="update-queue-meta" title={`${entry.hostName} · started ${relativeTime(entry.startedAt)}`}>
                    {entry.hostName} · started {relativeTime(entry.startedAt)}
                  </span>
                </div>
                <Badge tone="accent">Running</Badge>
              </div>
            ))}
            {queued.map((entry, index) => (
              <div key={entry.id} className="update-queue-row" data-status="queued">
                <span className="update-queue-index">{index + 1}</span>
                <div className="update-queue-main">
                  <Link to="/stacks/$stackId" params={{ stackId: entry.stackId }} className="update-queue-name" title={entry.displayName}>
                    {entry.displayName}
                  </Link>
                  <span className="update-queue-meta" title={`${entry.hostName} · queued ${relativeTime(entry.createdAt)}`}>
                    {entry.hostName} · queued {relativeTime(entry.createdAt)}
                  </span>
                </div>
                <Badge tone="default">Queued</Badge>
                {canApply ? (
                  <div className="update-queue-actions">
                    <IconButton
                      label={`Move ${entry.displayName} earlier`}
                      title="Move earlier"
                      disabled={index === 0 || reorder.isPending}
                      onClick={() => move(entry.id, -1)}
                    >
                      <ArrowUp size={13} />
                    </IconButton>
                    <IconButton
                      label={`Move ${entry.displayName} later`}
                      title="Move later"
                      disabled={index === queued.length - 1 || reorder.isPending}
                      onClick={() => move(entry.id, 1)}
                    >
                      <ArrowDown size={13} />
                    </IconButton>
                    <IconButton
                      label={`Remove ${entry.displayName} from the queue`}
                      title="Remove from queue"
                      disabled={remove.isPending}
                      onClick={() => drop(entry)}
                    >
                      <X size={13} />
                    </IconButton>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {recent.length > 0 ? (
          <div className="update-queue-recent" role="group" aria-labelledby="update-queue-recent-label">
            <span className="update-queue-section-label" id="update-queue-recent-label">Recent updates</span>
            {recent.slice(0, 4).map((entry) => (
              <div key={entry.id} className="update-queue-recent-row">
                <span className="update-queue-name" title={entry.displayName}>{entry.displayName}</span>
                <span className="update-queue-meta">{relativeTime(entry.finishedAt ?? entry.createdAt)}</span>
                <Badge tone={statusTone(entry.status)}>{titleCase(entry.status)}</Badge>
              </div>
            ))}
          </div>
        ) : null}

        {active.length > 0 && queued.length > 0 ? (
          <p className="help" style={{ margin: 0 }}>
            The next stack starts when the current update finishes. Reorder to change what runs next, or remove a stack to skip it.
          </p>
        ) : null}
      </div>
    </section>
  );
}
