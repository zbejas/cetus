import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity as ActivityIcon,
  CircleCheck,
  CircleX,
  Download,
  ListFilter,
  RefreshCw,
  ScrollText,
  Search,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { ApiError } from "../lib/api";
import { useAudit, useOperation, useOperations } from "../lib/queries";
import { useToast } from "../components/Toast";
import { Badge, Button, Dialog, EmptyState, Input, PageHeader, Skeleton } from "../components/ui";
import { StatusBadge } from "../components/Status";
import { formatDate, relativeTime, shortId, titleCase } from "../lib/format";
import type { AuditEntry, Operation } from "@shared/types";

type ActorFilter = "all" | "user" | "key";
type FamilyFilter = "all" | ActionFamily;
type ActionFamily = "stack" | "container" | "key" | "settings" | "mcp" | "other";
type RangeFilter = "all" | "1h" | "24h" | "7d";

const RANGE_OPTIONS: Array<{ value: RangeFilter; label: string; ms: number | null }> = [
  { value: "all", label: "All time", ms: null },
  { value: "1h", label: "Last hour", ms: 60 * 60 * 1_000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1_000 },
];

const FAMILY_OPTIONS: Array<{ value: FamilyFilter; label: string }> = [
  { value: "all", label: "All actions" },
  { value: "stack", label: "Stack" },
  { value: "container", label: "Container" },
  { value: "key", label: "Key" },
  { value: "settings", label: "Settings" },
  { value: "mcp", label: "MCP" },
];

const FAMILY_LABELS: Record<ActionFamily, string> = {
  stack: "Stack",
  container: "Container",
  key: "Key",
  settings: "Settings",
  mcp: "MCP",
  other: "Other",
};

export function ActivityPage() {
  const operationsQuery = useOperations();
  const auditQuery = useAudit();
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [actorType, setActorType] = useState<ActorFilter>("all");
  const [family, setFamily] = useState<FamilyFilter>("all");
  const [range, setRange] = useState<RangeFilter>("all");
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const operationQuery = useOperation(selectedOperationId);

  const operationActorTypes = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of auditQuery.data ?? []) {
      const operationId = typeof entry.metadata?.operationId === "string" ? entry.metadata.operationId : null;
      if (operationId) map.set(operationId, entry.actorType);
    }
    return map;
  }, [auditQuery.data]);

  const cutoff = range === "all" ? null : Date.now() - (RANGE_OPTIONS.find((option) => option.value === range)?.ms ?? 0);
  const term = search.trim().toLowerCase();
  const activeFilters = Boolean(term) || actorType !== "all" || family !== "all" || range !== "all";

  const filteredAudit = useMemo(() => {
    return (auditQuery.data ?? []).filter((entry) => {
      if (cutoff !== null && new Date(entry.createdAt).getTime() < cutoff) return false;
      if (actorType !== "all" && entry.actorType !== actorType) return false;
      if (family !== "all" && actionFamily(entry) !== family) return false;
      if (term) {
        const haystack = [
          entry.action,
          entry.actorName,
          entry.actorType,
          entry.resourceType,
          entry.resourceId ?? "",
          entry.ip ?? "",
        ].join(" ").toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [auditQuery.data, cutoff, actorType, family, term]);

  const filteredOperations = useMemo(() => {
    if (family !== "all" && family !== "stack") return [];
    return (operationsQuery.data ?? []).filter((operation) => {
      if (cutoff !== null && new Date(operation.startedAt).getTime() < cutoff) return false;
      if (actorType !== "all" && operationActorTypes.get(operation.id) !== actorType) return false;
      if (term) {
        const haystack = [
          operation.type,
          operation.stackName ?? "",
          operation.actorName,
          operation.id,
        ].join(" ").toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [operationsQuery.data, operationActorTypes, cutoff, actorType, family, term]);

  const successful = filteredOperations.filter((operation) => operation.status === "success").length;
  const failed = filteredOperations.filter((operation) => operation.status === "failed").length;
  const uniqueActors = new Set([
    ...filteredAudit.map((entry) => entry.actorName),
    ...filteredOperations.map((operation) => operation.actorName),
  ]).size;
  const runningOperations = filteredOperations.filter((operation) => operation.status === "running").length;
  const rangeLabel = RANGE_OPTIONS.find((option) => option.value === range)?.label ?? "All time";

  const selectedOperation = operationQuery.data
    ?? operationsQuery.data?.find((operation) => operation.id === selectedOperationId)
    ?? null;

  function clearFilters() {
    setSearch("");
    setActorType("all");
    setFamily("all");
    setRange("all");
  }

  async function refreshAll() {
    setRefreshing(true);
    try {
      await Promise.all([operationsQuery.refetch(), auditQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  function exportJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      filters: {
        search: search.trim(),
        actorType,
        family,
        range,
        rangeLabel,
      },
      summary: {
        successfulOperations: successful,
        failedOperations: failed,
        uniqueActors,
        auditEvents: filteredAudit.length,
      },
      operations: filteredOperations,
      audit: filteredAudit,
    };
    downloadFile(
      `cetus-activity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      JSON.stringify(payload, null, 2),
      "application/json",
    );
    toast.success(
      "Activity exported",
      `${countLabel(filteredAudit.length, "audit event")} and ${countLabel(filteredOperations.length, "operation")}.`,
    );
  }

  async function copyOutput(operation: Operation) {
    try {
      await navigator.clipboard.writeText(operation.output);
      toast.success("Output copied", `${shortId(operation.id)} is on your clipboard.`);
    } catch {
      toast.error("Copy failed", "Clipboard access is blocked in this browser.");
    }
  }

  function downloadOutput(operation: Operation) {
    downloadFile(
      `cetus-${operation.type}-${shortId(operation.id)}.log`,
      operation.output || "No output captured for this operation.",
      "text/plain",
    );
    toast.success("Output downloaded", "The operation log was saved as a text file.");
  }

  return (
    <div>
      <PageHeader
        title="Activity"
        description="Operations, audit events, and the actors behind them."
        actions={
          <>
            <Button
              onClick={exportJson}
              disabled={filteredAudit.length === 0 && filteredOperations.length === 0}
              title={filteredAudit.length === 0 && filteredOperations.length === 0 ? "No entries match the current filters." : "Download the current view as JSON"}
            >
              <Download size={14} /> Export JSON
            </Button>
            <Button variant="ghost" onClick={() => void refreshAll()} loading={refreshing}>
              <RefreshCw size={14} /> Refresh
            </Button>
          </>
        }
      />

      <div className="metric-grid" style={{ marginBottom: 14 }}>
        <section className="surface metric">
          <div className="metric-label"><CircleCheck size={12} color="var(--success)" /> Successful operations</div>
          <div className="metric-value" style={{ color: !operationsQuery.isLoading && !operationsQuery.isError && successful > 0 ? "var(--success)" : undefined }}>
            {operationsQuery.isLoading ? <Skeleton className="h-7 w-12" /> : operationsQuery.isError ? "n/a" : successful}
          </div>
          <div className="metric-sub">
            {operationsQuery.isLoading
              ? "Loading operations"
              : operationsQuery.isError
                ? "Operations unavailable"
                : `${countLabel(filteredOperations.length, "operation")} in view`}
          </div>
        </section>

        <section className="surface metric">
          <div className="metric-label"><CircleX size={12} color="var(--danger)" /> Failed operations</div>
          <div className="metric-value" style={{ color: !operationsQuery.isLoading && !operationsQuery.isError && failed > 0 ? "var(--danger)" : undefined }}>
            {operationsQuery.isLoading ? <Skeleton className="h-7 w-12" /> : operationsQuery.isError ? "n/a" : failed}
          </div>
          <div className="metric-sub">
            {operationsQuery.isLoading
              ? "Loading operations"
              : operationsQuery.isError
                ? "Operations unavailable"
                : `${countLabel(filteredOperations.length, "operation")} in view`}
          </div>
        </section>

        <section className="surface metric">
          <div className="metric-label"><UserRound size={12} color="var(--accent)" /> Unique actors</div>
          <div className="metric-value">
            {operationsQuery.isLoading && auditQuery.isLoading ? <Skeleton className="h-7 w-12" /> : uniqueActors}
          </div>
          <div className="metric-sub">People and API keys in view</div>
        </section>

        <section className="surface metric">
          <div className="metric-label"><ActivityIcon size={12} color="var(--accent)" /> Events in range</div>
          <div className="metric-value">
            {auditQuery.isLoading ? <Skeleton className="h-7 w-12" /> : auditQuery.isError ? "n/a" : filteredAudit.length}
          </div>
          <div className="metric-sub">
            {auditQuery.isError ? "Audit trail unavailable" : rangeLabel}
          </div>
        </section>
      </div>

      <section className="surface" style={{ padding: "12px 14px", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <ListFilter size={14} color="var(--accent)" />
          <strong style={{ fontSize: 12 }}>Filters</strong>
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            {countLabel(filteredOperations.length, "operation")} · {countLabel(filteredAudit.length, "audit event")}
          </span>
          {activeFilters ? (
            <Button size="sm" variant="ghost" style={{ marginLeft: "auto" }} onClick={clearFilters}>
              <X size={12} /> Clear
            </Button>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "2 1 240px", minWidth: 0 }}>
            <label className="label" htmlFor="activity-search">Search</label>
            <div style={{ position: "relative" }}>
              <Search
                size={13}
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--muted)",
                  pointerEvents: "none",
                }}
              />
              <Input
                id="activity-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Action, actor, stack, or IP"
                style={{ paddingLeft: 30 }}
              />
            </div>
          </div>
          <div style={{ flex: "1 1 150px", minWidth: 0 }}>
            <label className="label" htmlFor="activity-actor">Actor</label>
            <select
              id="activity-actor"
              className="select"
              value={actorType}
              onChange={(event) => setActorType(event.target.value as ActorFilter)}
            >
              <option value="all">All actors</option>
              <option value="user">People</option>
              <option value="key">API keys</option>
            </select>
          </div>
          <div style={{ flex: "1 1 150px", minWidth: 0 }}>
            <label className="label" htmlFor="activity-family">Action family</label>
            <select
              id="activity-family"
              className="select"
              value={family}
              onChange={(event) => setFamily(event.target.value as FamilyFilter)}
            >
              {FAMILY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: "1 1 150px", minWidth: 0 }}>
            <label className="label" htmlFor="activity-range">Time range</label>
            <select
              id="activity-range"
              className="select"
              value={range}
              onChange={(event) => setRange(event.target.value as RangeFilter)}
            >
              {RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <ScrollText size={15} color="var(--accent)" />
            <h3>Operations</h3>
            <Badge>{filteredOperations.length}</Badge>
            {runningOperations > 0 ? (
              <Badge tone="warn">
                <span className="status-dot" data-status="running" /> {runningOperations} running
              </Badge>
            ) : null}
          </div>
          <span className="muted hidden sm:inline" style={{ fontSize: 11 }}>Stack actions with retained output</span>
        </div>

        {operationsQuery.isLoading ? (
          <SectionSkeleton rows={4} />
        ) : operationsQuery.isError ? (
          <EmptyState
            icon={<TriangleAlert size={18} />}
            title="Operations unavailable"
            description={errorMessage(operationsQuery.error, "Cetus could not load recent operations.")}
            action={
              <Button onClick={() => void operationsQuery.refetch()}>
                <RefreshCw size={13} /> Retry
              </Button>
            }
          />
        ) : filteredOperations.length === 0 ? (
          <EmptyState
            icon={<ScrollText size={18} />}
            title={activeFilters ? "No operations in this view" : "No operations yet"}
            description={
              activeFilters && family !== "all" && family !== "stack"
                ? "Operations track stack actions. Container, key, settings, and MCP events appear in the audit trail below."
                : activeFilters
                  ? "No operations match the current filters. Widen the time range or clear filters."
                  : "Stack deploys, restarts, and lifecycle actions appear here with their retained output."
            }
            action={activeFilters ? <Button variant="ghost" onClick={clearFilters}><X size={12} /> Clear filters</Button> : undefined}
          />
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="data-table" aria-label="Recent operations">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Type</th>
                  <th scope="col">Stack</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Started</th>
                  <th scope="col"><span className="sr-only">Output</span></th>
                </tr>
              </thead>
              <tbody>
                {filteredOperations.map((operation) => (
                  <tr key={operation.id}>
                    <td data-label="Status"><StatusBadge status={operation.status} /></td>
                    <td data-label="Type">
                      <div style={{ display: "grid", gap: 2 }}>
                        <strong style={{ fontWeight: 600 }}>{titleCase(operation.type)}</strong>
                        <span className="mono muted" style={{ fontSize: 10.5 }}>{shortId(operation.id)}</span>
                      </div>
                    </td>
                    <td data-label="Stack">
                      {operation.stackId ? (
                        <Link
                          to="/stacks/$stackId"
                          params={{ stackId: operation.stackId }}
                          className="accent"
                          style={{ fontSize: 12 }}
                        >
                          {operation.stackName ?? shortId(operation.stackId)}
                        </Link>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>None</span>
                      )}
                    </td>
                    <td data-label="Actor"><span style={{ fontSize: 12 }}>{operation.actorName}</span></td>
                    <td data-label="Duration"><span className="mono" style={{ fontSize: 11.5 }}>{operationDuration(operation)}</span></td>
                    <td data-label="Started" title={formatDate(operation.startedAt)}>
                      <span className="muted" style={{ fontSize: 11.5 }}>{relativeTime(operation.startedAt)}</span>
                    </td>
                    <td data-label="Output">
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`View output for ${titleCase(operation.type)} operation ${shortId(operation.id)}`}
                          onClick={() => setSelectedOperationId(operation.id)}
                        >
                          <ScrollText size={12} /> Output
                        </Button>
                      </div>
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
            <ActivityIcon size={15} color="var(--accent)" />
            <h3>Audit trail</h3>
            <Badge>{filteredAudit.length}</Badge>
          </div>
          <span className="muted hidden sm:inline" style={{ fontSize: 11 }}>Newest first · latest 100 events</span>
        </div>

        {auditQuery.isLoading ? (
          <SectionSkeleton rows={5} />
        ) : auditQuery.isError ? (
          <EmptyState
            icon={<TriangleAlert size={18} />}
            title="Audit trail unavailable"
            description={errorMessage(auditQuery.error, "Cetus could not load the audit trail.")}
            action={
              <Button onClick={() => void auditQuery.refetch()}>
                <RefreshCw size={13} /> Retry
              </Button>
            }
          />
        ) : filteredAudit.length === 0 ? (
          <EmptyState
            icon={<ActivityIcon size={18} />}
            title={activeFilters ? "No matching audit events" : "No audit events yet"}
            description={
              activeFilters
                ? "No events match the current filters. Widen the time range or clear filters."
                : "Actions performed by people and API keys are recorded here as they happen."
            }
            action={activeFilters ? <Button variant="ghost" onClick={clearFilters}><X size={12} /> Clear filters</Button> : undefined}
          />
        ) : (
          <div className="panel-body" style={{ padding: "4px 16px 8px" }}>
            <div className="timeline">
              {filteredAudit.map((entry) => {
                const entryFamily = actionFamily(entry);
                return (
                  <div className="timeline-item" key={entry.id}>
                    <span className="timeline-dot" data-tone={auditTone(entry, entryFamily)} />
                    <div className="timeline-body" style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                        <strong className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{entry.action}</strong>
                        <span className="chip">{FAMILY_LABELS[entryFamily]}</span>
                        <span
                          className="timeline-time"
                          style={{ marginLeft: "auto", whiteSpace: "nowrap" }}
                          title={new Date(entry.createdAt).toISOString()}
                        >
                          {formatDate(entry.createdAt)}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                          marginTop: 3,
                          color: "var(--muted)",
                          fontSize: 11,
                        }}
                      >
                        <span>{entry.actorName}</span>
                        <span>·</span>
                        <span>{entry.actorType === "key" ? "API key" : titleCase(entry.actorType)}</span>
                        <span>·</span>
                        <span className="mono">
                          {titleCase(entry.resourceType)}{entry.resourceId ? ` ${shortId(entry.resourceId, 10)}` : ""}
                        </span>
                        <span>·</span>
                        <span className="mono">{entry.ip ?? "no IP"}</span>
                        <span>·</span>
                        <span>{relativeTime(entry.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <Dialog
        open={selectedOperationId !== null}
        onClose={() => setSelectedOperationId(null)}
        title={selectedOperation ? `${titleCase(selectedOperation.type)} operation` : "Operation detail"}
        wide
        footer={<Button variant="ghost" onClick={() => setSelectedOperationId(null)}>Close</Button>}
      >
        {selectedOperation ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              <StatusBadge status={selectedOperation.status} />
              <Badge tone="accent">{titleCase(selectedOperation.type)}</Badge>
              <span className="mono muted" style={{ fontSize: 11 }}>{selectedOperation.id}</span>
            </div>

            <dl className="kv" style={{ gridTemplateColumns: "92px minmax(0, 1fr)" }}>
              <dt>Stack</dt>
              <dd>
                {selectedOperation.stackId ? (
                  <Link
                    to="/stacks/$stackId"
                    params={{ stackId: selectedOperation.stackId }}
                    className="accent"
                  >
                    {selectedOperation.stackName ?? selectedOperation.stackId}
                  </Link>
                ) : "None"}
              </dd>
              <dt>Actor</dt><dd>{selectedOperation.actorName}</dd>
              <dt>Started</dt>
              <dd>{formatDate(selectedOperation.startedAt)} <span className="muted">({relativeTime(selectedOperation.startedAt)})</span></dd>
              <dt>Finished</dt>
              <dd>
                {selectedOperation.finishedAt
                  ? formatDate(selectedOperation.finishedAt)
                  : selectedOperation.status === "running"
                    ? "In progress"
                    : "n/a"}
              </dd>
              <dt>Duration</dt><dd className="mono">{operationDuration(selectedOperation)}</dd>
              <dt>Exit code</dt>
              <dd
                className="mono"
                style={{
                  color: selectedOperation.exitCode === 0
                    ? "var(--success)"
                    : selectedOperation.exitCode !== null
                      ? "var(--danger)"
                      : undefined,
                }}
              >
                {selectedOperation.exitCode ?? "n/a"}
              </dd>
            </dl>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "16px 0 8px" }}>
              <span className="label" style={{ margin: 0 }}>Output</span>
              <span className="muted" style={{ fontSize: 11 }}>{selectedOperation.output.length.toLocaleString()} characters</span>
              {selectedOperation.status === "running" ? (
                <span className="muted" style={{ fontSize: 11 }}>Live while the operation runs</span>
              ) : null}
              <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copyOutput(selectedOperation)}
                  disabled={!selectedOperation.output}
                >
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => downloadOutput(selectedOperation)}
                  disabled={!selectedOperation.output}
                >
                  <Download size={12} /> Download
                </Button>
              </div>
            </div>
            <pre className="log-view" style={{ minHeight: 200, maxHeight: 420 }}>
              {selectedOperation.output || "No output captured for this operation."}
            </pre>
          </>
        ) : operationQuery.isError ? (
          <EmptyState
            icon={<TriangleAlert size={18} />}
            title="Operation unavailable"
            description={errorMessage(operationQuery.error, "Cetus could not load this operation.")}
            action={
              <Button onClick={() => void operationQuery.refetch()}>
                <RefreshCw size={13} /> Retry
              </Button>
            }
          />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-6 w-20" />
            </div>
            {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-4 w-full" />)}
            <Skeleton className="h-52 w-full" />
          </div>
        )}
      </Dialog>
    </div>
  );
}

function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div style={{ padding: 16, display: "grid", gap: 10 }}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

function actionFamily(entry: AuditEntry): ActionFamily {
  const action = entry.action.toLowerCase();
  if (action.startsWith("container.") || entry.resourceType === "container") return "container";
  if (action.startsWith("key.") || entry.resourceType === "api_key") return "key";
  if (action.startsWith("mcp.") || entry.resourceType === "mcp") return "mcp";
  if (
    action.startsWith("settings.")
    || entry.resourceType === "settings"
    || entry.resourceType === "instance"
    || entry.resourceType === "user"
  ) return "settings";
  if (entry.resourceType === "stack" || entry.resourceType === "service") return "stack";
  if (["deploy", "start", "stop", "restart", "down", "update", "save", "delete", "scan", "restore", "exec"].includes(action)) return "stack";
  return "other";
}

function auditTone(entry: AuditEntry, family: ActionFamily): string | undefined {
  const action = entry.action.toLowerCase();
  if (
    action.includes("delete")
    || action.includes("revoke")
    || action.includes("remove")
    || action.endsWith(".down")
  ) return "danger";
  if (family === "key") return "warn";
  if (family === "container") return "success";
  if (family === "settings" || family === "other") return undefined;
  return "accent";
}

function operationDuration(operation: Operation): string {
  const start = new Date(operation.startedAt).getTime();
  const end = operation.finishedAt ? new Date(operation.finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "n/a";
  const totalSeconds = Math.max(0, Math.round((end - start) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
