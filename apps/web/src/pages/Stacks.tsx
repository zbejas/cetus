import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import YAML from "yaml";
import {
  Box,
  ExternalLink,
  FolderSearch,
  Layers,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  Search,
  Server,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import type { StackStatus, StackSummary } from "@shared/types";
import { api, ApiError, can, scopeReason } from "../lib/api";
import { queryKeys, useCreateStack, useHosts, useMe, useScanStacks, useStacks } from "../lib/queries";
import { useToast } from "../components/Toast";
import { StatusBadge } from "../components/Status";
import { Button, Dialog, EmptyState, IconButton, Input, PageHeader, Skeleton } from "../components/ui";
import { formatDate, relativeTime, titleCase } from "../lib/format";

const NEW_STACK_FLAG = "cetus:new-stack";
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DEFAULT_COMPOSE = `services:
  web:
    image: nginx:alpine
    ports:
      - "18091:80"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost/"]
      interval: 30s
      timeout: 3s
      retries: 3
`;

type StatusTab = "all" | "running" | "degraded" | "stopped";

const STATUS_TABS: Array<{ key: StatusTab; label: string }> = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "degraded", label: "Degraded" },
  { key: "stopped", label: "Stopped" },
];

const STATUS_RANK: Record<StackStatus, number> = {
  running: 0,
  updating: 1,
  partial: 2,
  error: 3,
  created: 4,
  stopped: 5,
  unknown: 6,
};

function matchesStatus(stack: StackSummary, tab: StatusTab) {
  if (tab === "all") return true;
  if (tab === "running") return stack.status === "running";
  if (tab === "degraded") return stack.status === "partial" || stack.status === "error";
  return stack.status === "stopped" || stack.status === "created" || stack.status === "unknown";
}

export function StacksPage() {
  const stacks = useStacks();
  const hostsQuery = useHosts();
  const scan = useScanStacks();
  const create = useCreateStack();
  const me = useMe();
  const canWrite = can(me.data?.actor.scopes, "stacks:write");
  const canDeploy = can(me.data?.actor.scopes, "stacks:deploy");
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const urlHostId = useMemo(() => new URLSearchParams(searchStr).get("hostId")?.trim() || "all", [searchStr]);
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [hostFilter, setHostFilter] = useState(urlHostId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<"start" | "stop" | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [moreStack, setMoreStack] = useState<StackSummary | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [compose, setCompose] = useState(DEFAULT_COMPOSE);
  const [formError, setFormError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => stacks.data ?? [], [stacks.data]);

  const hosts = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    (hostsQuery.data ?? []).forEach((host) => map.set(host.id, { id: host.id, name: host.name }));
    all.forEach((stack) => {
      if (!map.has(stack.hostId)) map.set(stack.hostId, { id: stack.hostId, name: stack.hostName });
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [all, hostsQuery.data]);

  const activeHostName = hostFilter === "all"
    ? ""
    : hosts.find((host) => host.id === hostFilter)?.name ?? hostFilter;

  const searched = useMemo(() => {
    const query = search.trim().toLowerCase();
    return all.filter((stack) => {
      if (hostFilter !== "all" && stack.hostId !== hostFilter) return false;
      if (!query) return true;
      return `${stack.name} ${stack.displayName} ${stack.tags.join(" ")} ${stack.hostName}`.toLowerCase().includes(query);
    });
  }, [all, hostFilter, search]);

  const filtered = useMemo(
    () => searched.filter((stack) => matchesStatus(stack, statusTab)),
    [searched, statusTab],
  );

  const sorted = useMemo(
    () => [...filtered].sort(
      (a, b) => (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99) || a.displayName.localeCompare(b.displayName),
    ),
    [filtered],
  );

  const statusCounts = useMemo(() => ({
    all: searched.length,
    running: searched.filter((stack) => matchesStatus(stack, "running")).length,
    degraded: searched.filter((stack) => matchesStatus(stack, "degraded")).length,
    stopped: searched.filter((stack) => matchesStatus(stack, "stopped")).length,
  }), [searched]);

  const totalRunning = all.filter((stack) => stack.status === "running").length;
  const visibleRunning = filtered.filter((stack) => stack.status === "running").length;
  const hasFilters = search.trim() !== "" || statusTab !== "all" || hostFilter !== "all";
  const visibleIds = useMemo(() => sorted.map((stack) => stack.id), [sorted]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = visibleIds.some((id) => selected.has(id));

  useEffect(() => {
    function handleNewStack() {
      try {
        sessionStorage.removeItem(NEW_STACK_FLAG);
      } catch {
        // Storage can be unavailable. The dialog still opens from the event.
      }
      if (canWrite) setCreateOpen(true);
    }

    window.addEventListener("cetus:new-stack", handleNewStack);
    let pending = false;
    try {
      pending = sessionStorage.getItem(NEW_STACK_FLAG) === "1";
      if (pending) sessionStorage.removeItem(NEW_STACK_FLAG);
    } catch {
      pending = false;
    }
    if (pending && canWrite) setCreateOpen(true);
    return () => window.removeEventListener("cetus:new-stack", handleNewStack);
  }, [canWrite]);

  useEffect(() => {
    setHostFilter((current) => (current === urlHostId ? current : urlHostId));
  }, [urlHostId]);

  useEffect(() => {
    const visible = new Set(visibleIds);
    setSelected((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Set<string>();
      current.forEach((id) => {
        if (visible.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : current;
    });
  }, [visibleIds]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [allSelected, someSelected]);

  useEffect(() => {
    if (!createOpen) return;
    const timer = window.setTimeout(() => document.getElementById("stack-name")?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [createOpen]);

  function invalidateStacks() {
    queryClient.invalidateQueries({ queryKey: ["stacks"] });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    queryClient.invalidateQueries({ queryKey: queryKeys.operations });
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

  function openCreate() {
    if (!canWrite) return;
    setFormError(null);
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
    setFormError(null);
  }

  function changeHostFilter(value: string) {
    setHostFilter(value);
    const url = new URL(window.location.href);
    if (value === "all") url.searchParams.delete("hostId");
    else url.searchParams.set("hostId", value);
    window.history.replaceState(window.history.state, "", url);
  }

  function clearFilters() {
    setSearch("");
    setStatusTab("all");
    setHostFilter("all");
    const url = new URL(window.location.href);
    url.searchParams.delete("hostId");
    window.history.replaceState(window.history.state, "", url);
  }

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openStack(stack: StackSummary) {
    navigate({ to: "/stacks/$stackId", params: { stackId: stack.id } });
  }

  async function runStackAction(stack: StackSummary, action: string) {
    if (!canDeploy) return;
    const key = `${stack.id}:${action}`;
    setRowBusy(key);
    try {
      await api.stackAction(stack.id, action);
      toast.success(`${titleCase(action)} queued`, `${stack.displayName} on ${stack.hostName}.`);
      invalidateStacks();
    } catch (error) {
      toast.error(`${titleCase(action)} failed`, error instanceof ApiError ? error.message : "Unknown error");
    } finally {
      setRowBusy((current) => (current === key ? null : current));
    }
  }

  async function runBulk(action: "start" | "stop") {
    if (!canDeploy) return;
    const targets = all.filter((stack) => selected.has(stack.id));
    if (targets.length === 0) return;
    setBulkBusy(action);
    try {
      const results = await Promise.allSettled(targets.map((stack) => api.stackAction(stack.id, action)));
      const succeeded = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - succeeded;
      const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");

      if (failed === 0) {
        toast.success(`${titleCase(action)} queued`, `${succeeded} of ${targets.length} stacks queued.`);
      } else if (succeeded === 0) {
        toast.error(
          `${titleCase(action)} failed`,
          firstFailure?.reason instanceof Error ? firstFailure.reason.message : "No operations were queued.",
        );
      } else {
        toast.push({
          title: `${titleCase(action)} partially queued`,
          description: `${succeeded} of ${targets.length} stacks queued. ${failed} could not start.`,
          tone: "info",
        });
      }
      invalidateStacks();
    } finally {
      setBulkBusy(null);
      setSelected(new Set());
    }
  }

  function runFromMore(action: string) {
    if (!moreStack) return;
    const stack = moreStack;
    setMoreStack(null);
    void runStackAction(stack, action);
  }

  function validateCreate(): string | null {
    const trimmed = name.trim();
    if (!trimmed) return "Enter a stack name.";
    if (!NAME_PATTERN.test(trimmed)) {
      return "Use lowercase letters, numbers, dashes, or underscores. Start with a letter or number.";
    }
    try {
      const parsed = YAML.parse(compose);
      const services = parsed && typeof parsed === "object"
        ? (parsed as { services?: unknown }).services
        : null;
      if (!services || typeof services !== "object" || Array.isArray(services) || Object.keys(services as Record<string, unknown>).length === 0) {
        return "Compose YAML must define at least one service.";
      }
    } catch (error) {
      return `Compose YAML is invalid: ${error instanceof Error ? error.message : "parse error"}`;
    }
    return null;
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    const validation = validateCreate();
    if (validation) {
      setFormError(validation);
      return;
    }
    setFormError(null);
    try {
      const stack = await create.mutateAsync({ name: name.trim(), compose });
      toast.success("Stack created", `${stack.displayName} is ready to deploy.`);
      setCreateOpen(false);
      setName("");
      setCompose(DEFAULT_COMPOSE);
      navigate({ to: "/stacks/$stackId", params: { stackId: stack.id } });
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : "Could not create the stack.");
    }
  }

  const pageActions = (
    <>
      <Button
        onClick={scanFolder}
        loading={canWrite && scan.isPending}
        disabled={!canWrite}
        aria-disabled={!canWrite}
        title={canWrite ? undefined : scopeReason("stacks:write")}
      >
        <FolderSearch size={14} /> Scan folder
      </Button>
      <Button
        variant="primary"
        onClick={openCreate}
        disabled={!canWrite}
        aria-disabled={!canWrite}
        title={canWrite ? undefined : scopeReason("stacks:write")}
      >
        <Plus size={14} /> New stack
      </Button>
    </>
  );

  const description = stacks.isLoading
    ? "Loading stacks from the fleet."
    : all.length === 0
      ? "No stacks indexed yet."
      : hasFilters
        ? `${sorted.length} of ${all.length} stacks · ${visibleRunning} running`
        : `${all.length} stack${all.length === 1 ? "" : "s"} across ${hosts.length} host${hosts.length === 1 ? "" : "s"} · ${totalRunning} running`;

  if (stacks.isLoading) {
    return (
      <div>
        <PageHeader title="Stacks" description="Loading stacks from the fleet." actions={pageActions} />
        <div className="panel">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-8 w-28" />
          </div>
          <div style={{ padding: "0 14px" }}>
            {Array.from({ length: 6 }).map((_, index) => (
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
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-8 w-8" />
                <div style={{ flex: 1, display: "grid", gap: 6 }}>
                  <Skeleton className="h-3 w-44" />
                  <Skeleton className="h-2.5 w-28" />
                </div>
                <Skeleton className="hidden h-6 w-16 sm:block" />
                <Skeleton className="hidden h-6 w-20 md:block" />
                <Skeleton className="h-6 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (stacks.isError && !stacks.data) {
    return (
      <div>
        <PageHeader title="Stacks" description="The stack index is unavailable." actions={pageActions} />
        <div className="panel">
          <EmptyState
            icon={<TriangleAlert size={20} />}
            title="Could not load stacks"
            description={stacks.error instanceof Error ? stacks.error.message : "The stack index is unreachable. Check the server and try again."}
            action={
              <Button onClick={() => stacks.refetch()} loading={stacks.isFetching}>
                <RefreshCw size={14} /> Retry
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Stacks" description={description} actions={pageActions} />

      {all.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<Layers size={20} />}
            title="No stacks yet"
            description="Create your first Compose stack, or scan the stacks directory for existing projects."
            action={
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
                <Button
                  variant="primary"
                  onClick={openCreate}
                  disabled={!canWrite}
                  aria-disabled={!canWrite}
                  title={canWrite ? undefined : scopeReason("stacks:write")}
                >
                  <Plus size={14} /> Create stack
                </Button>
                <Button
                  onClick={scanFolder}
                  loading={canWrite && scan.isPending}
                  disabled={!canWrite}
                  aria-disabled={!canWrite}
                  title={canWrite ? undefined : scopeReason("stacks:write")}
                >
                  <FolderSearch size={14} /> Scan folder
                </Button>
              </div>
            }
          />
        </div>
      ) : (
        <section className="panel">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 360 }}>
              <Search
                size={14}
                style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none" }}
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, tag, or host"
                aria-label="Search stacks"
                style={{ paddingLeft: 32, paddingRight: search ? 32 : 10 }}
              />
              {search ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  style={{ position: "absolute", right: 3, top: 3, width: 28, height: 28, padding: 0 }}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>

            <div className="max-w-full overflow-x-auto">
              <div className="tabs" role="group" aria-label="Filter stacks by status">
                {STATUS_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className="tab"
                    data-active={statusTab === tab.key}
                    aria-pressed={statusTab === tab.key}
                    onClick={() => setStatusTab(tab.key)}
                    style={{ padding: "0 7px", gap: 4 }}
                  >
                    {tab.label}
                    <span className="tab-count">{statusCounts[tab.key]}</span>
                  </button>
                ))}
              </div>
            </div>

            {hosts.length > 1 || hostFilter !== "all" ? (
              <select
                className="select"
                value={hostFilter}
                onChange={(event) => changeHostFilter(event.target.value)}
                aria-label="Filter stacks by host"
                style={{ width: 150, flex: "0 1 170px" }}
              >
                <option value="all">All hosts</option>
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>{host.name}</option>
                ))}
              </select>
            ) : null}

            {hostFilter !== "all" ? (
              <span className="filter-chip">
                <Server size={11} />
                Host: {activeHostName}
                <button
                  type="button"
                  className="filter-chip-remove"
                  aria-label={`Remove host filter ${activeHostName}`}
                  onClick={() => changeHostFilter("all")}
                >
                  <X size={11} />
                </button>
              </span>
            ) : null}

            {hasFilters ? (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                <X size={12} /> Clear
              </Button>
            ) : null}

            <span className="muted hidden sm:inline" style={{ marginLeft: "auto", fontSize: 11, whiteSpace: "nowrap" }}>
              {sorted.length} shown
            </span>
          </div>

          {selected.size > 0 ? (
            <div
              role="region"
              aria-label="Bulk stack actions"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                padding: "8px 12px",
                borderBottom: "1px solid var(--border)",
                background: "var(--accent-soft)",
              }}
            >
              <strong style={{ fontSize: 12 }}>{selected.size} selected</strong>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>Operations are queued per stack.</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginLeft: "auto" }}>
                <Button
                  size="sm"
                  onClick={() => runBulk("start")}
                  loading={bulkBusy === "start"}
                  disabled={bulkBusy !== null || !canDeploy}
                  aria-disabled={!canDeploy}
                  title={canDeploy ? undefined : scopeReason("stacks:deploy")}
                >
                  <Play size={12} /> Start selected
                </Button>
                <Button
                  size="sm"
                  onClick={() => runBulk("stop")}
                  loading={bulkBusy === "stop"}
                  disabled={bulkBusy !== null || !canDeploy}
                  aria-disabled={!canDeploy}
                  title={canDeploy ? undefined : scopeReason("stacks:deploy")}
                >
                  <Square size={12} /> Stop selected
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={bulkBusy !== null}>
                  Clear
                </Button>
              </div>
            </div>
          ) : null}

          {sorted.length === 0 ? (
            <EmptyState
              icon={<Search size={20} />}
              title="No matching stacks"
              description="Try a different name, tag, host, or status filter."
              action={
                <Button size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <div className="table-wrap stacks-table-wrap max-h-[calc(100dvh-310px)] max-[720px]:max-h-none" style={{ borderRadius: 0 }}>
              <table className="data-table stacks-table" aria-label="Stacks across the fleet">
                <caption className="sr-only">
                  Stacks across the fleet. Select rows for bulk actions, or use a row action to open, deploy, or stop a stack.
                </caption>
                <colgroup className="stacks-colgroup">
                  <col style={{ width: "28%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "13%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          aria-label="Select all visible stacks"
                          style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
                        />
                        Stack
                      </span>
                    </th>
                    <th scope="col">Host</th>
                    <th scope="col">Status</th>
                    <th scope="col">Services</th>
                    <th scope="col">Image/Project</th>
                    <th scope="col">Updated</th>
                    <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((stack) => (
                    <StackRow
                      key={stack.id}
                      stack={stack}
                      selected={selected.has(stack.id)}
                      busyAction={rowBusy?.startsWith(`${stack.id}:`) ? rowBusy.slice(stack.id.length + 1) : null}
                      onToggle={() => toggleSelected(stack.id)}
                      onOpen={() => openStack(stack)}
                      onAction={(action) => void runStackAction(stack, action)}
                      onMore={() => setMoreStack(stack)}
                      canDeploy={canDeploy}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Dialog
        open={createOpen}
        onClose={closeCreate}
        title="New stack"
        wide
        className="m-auto"
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form="create-stack-form"
              loading={canWrite && create.isPending}
              disabled={!canWrite}
              aria-disabled={!canWrite}
              title={canWrite ? undefined : scopeReason("stacks:write")}
            >
              <Plus size={14} /> Create stack
            </Button>
          </>
        }
      >
        <form id="create-stack-form" onSubmit={submitCreate}>
          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <label className="label" htmlFor="stack-name">Stack name</label>
              <Input
                id="stack-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-stack"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="help">Lowercase letters, numbers, dashes, and underscores. A new folder is created in the stacks directory.</p>
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <label className="label" htmlFor="stack-compose" style={{ marginBottom: 0 }}>Compose YAML</label>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setCompose(DEFAULT_COMPOSE);
                    setFormError(null);
                  }}
                >
                  <RotateCw size={12} /> Reset template
                </Button>
              </div>
              <textarea
                id="stack-compose"
                className="textarea"
                value={compose}
                onChange={(event) => setCompose(event.target.value)}
                spellCheck={false}
                style={{ minHeight: 280, marginTop: 6 }}
              />
              <p className="help">The template publishes port 18091. Change it if the port is already in use.</p>
            </div>

            {formError ? (
              <div
                role="alert"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "9px 11px",
                  border: "1px solid color-mix(in oklab, var(--danger) 35%, transparent)",
                  borderRadius: 9,
                  background: "var(--danger-soft)",
                  color: "var(--danger)",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                }}
              >
                <TriangleAlert size={14} style={{ flex: "none", marginTop: 1 }} />
                <span>{formError}</span>
              </div>
            ) : null}
          </div>
        </form>
      </Dialog>

      <Dialog
        open={moreStack !== null}
        onClose={() => setMoreStack(null)}
        title={moreStack ? `Actions for ${moreStack.displayName}` : "Stack actions"}
        className="m-auto"
        footer={<Button variant="ghost" onClick={() => setMoreStack(null)}>Close</Button>}
      >
        {moreStack ? (
          <div style={{ display: "grid", gap: 8 }}>
            <p style={{ margin: "0 0 4px", color: "var(--muted)", fontSize: 12 }}>
              Operations run on {moreStack.hostName} and return immediately. Progress is available in the stack detail.
            </p>
            <Button
              onClick={() => runFromMore("update")}
              disabled={!canDeploy}
              aria-disabled={!canDeploy}
              title={canDeploy ? undefined : scopeReason("stacks:deploy")}
              style={{ justifyContent: "flex-start" }}
            >
              <RefreshCw size={14} /> Pull and recreate
            </Button>
            <Button
              onClick={() => runFromMore("restart")}
              disabled={!canDeploy}
              aria-disabled={!canDeploy}
              title={canDeploy ? undefined : scopeReason("stacks:deploy")}
              style={{ justifyContent: "flex-start" }}
            >
              <RotateCw size={14} /> Restart stack
            </Button>
            <Button
              onClick={() => runFromMore("stop")}
              disabled={!canDeploy}
              aria-disabled={!canDeploy}
              title={canDeploy ? undefined : scopeReason("stacks:deploy")}
              style={{ justifyContent: "flex-start" }}
            >
              <Square size={14} /> Stop stack
            </Button>
            <Button
              onClick={() => runFromMore("down")}
              disabled={!canDeploy}
              aria-disabled={!canDeploy}
              title={canDeploy ? undefined : scopeReason("stacks:deploy")}
              style={{ justifyContent: "flex-start" }}
            >
              <Box size={14} /> Down and keep files
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const stack = moreStack;
                setMoreStack(null);
                openStack(stack);
              }}
              style={{ justifyContent: "flex-start" }}
            >
              <ExternalLink size={14} /> Open stack detail
            </Button>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function StackRow({
  stack,
  selected,
  busyAction,
  onToggle,
  onOpen,
  onAction,
  onMore,
  canDeploy,
}: {
  stack: StackSummary;
  selected: boolean;
  busyAction: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onAction: (action: string) => void;
  onMore: () => void;
  canDeploy: boolean;
}) {
  const busy = Boolean(busyAction);
  const deployDisabled = busy || !canDeploy;
  const stopDisabled = busy || !canDeploy || (stack.status !== "running" && stack.runningCount === 0);
  const deployReason = !canDeploy ? scopeReason("stacks:deploy") : undefined;
  const stopReason = !canDeploy
    ? scopeReason("stacks:deploy")
    : stack.status !== "running" && stack.runningCount === 0
      ? "Stack is not running"
      : undefined;

  return (
    <tr
      data-selected={selected}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
          event.preventDefault();
          onOpen();
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <td data-label="Stack">
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <input
            type="checkbox"
            checked={selected}
            onClick={(event) => event.stopPropagation()}
            onChange={onToggle}
            aria-label={`Select ${stack.displayName}`}
            style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer", flex: "none" }}
          />
          <div className="stack-avatar">
            <Layers size={14} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <strong
                style={{
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
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
            <div
              className="mono"
              style={{
                marginTop: 1,
                color: "var(--muted)",
                fontSize: 10.5,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {stack.name}
              {stack.tags.length > 0 ? ` · ${stack.tags.slice(0, 2).join(", ")}` : ""}
            </div>
          </div>
        </div>
      </td>
      <td data-label="Host">
        <span className="chip" title={`${stack.hostName} · ${titleCase(stack.hostKind)}`}>
          <Server size={10} /> {stack.hostName}
        </span>
      </td>
      <td data-label="Status"><StatusBadge status={stack.status} /></td>
      <td data-label="Services">
        <span title={`${stack.runningCount} of ${stack.serviceCount} services running`}>
          <strong style={{ fontWeight: 600 }}>{stack.runningCount}</strong>
          <span className="muted" style={{ fontSize: 11 }}> / {stack.serviceCount}</span>
        </span>
      </td>
      <td data-label="Image/Project">
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--text-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stack.projectName}</div>
          <div style={{ color: "var(--muted)", fontSize: 10.5 }}>{stack.composeFile}</div>
        </div>
      </td>
      <td data-label="Updated">
        <span style={{ color: "var(--text-soft)", fontSize: 11.5 }} title={formatDate(stack.updatedAt)}>
          {relativeTime(stack.updatedAt)}
        </span>
      </td>
      <td data-label="Actions" onClick={(event) => event.stopPropagation()}>
        <div className="service-row-actions" style={{ justifyContent: "flex-end" }}>
          <IconButton
            label={`Open ${stack.displayName}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            <ExternalLink size={13} />
          </IconButton>
          <IconButton
            label={`Deploy ${stack.displayName}${deployReason ? ` (${deployReason})` : ""}`}
            disabled={deployDisabled}
            aria-disabled={!canDeploy}
            title={deployReason ?? `Deploy ${stack.displayName}`}
            onClick={(event) => {
              event.stopPropagation();
              onAction("deploy");
            }}
            style={deployDisabled ? { opacity: 0.45 } : undefined}
          >
            {busyAction === "deploy" ? <LoaderCircle size={13} className="animate-spin" /> : <Rocket size={13} />}
          </IconButton>
          <IconButton
            label={`Stop ${stack.displayName}${stopReason ? ` (${stopReason})` : ""}`}
            disabled={stopDisabled}
            aria-disabled={!canDeploy}
            title={stopReason ?? `Stop ${stack.displayName}`}
            onClick={(event) => {
              event.stopPropagation();
              onAction("stop");
            }}
            style={stopDisabled ? { opacity: 0.35 } : undefined}
          >
            {busyAction === "stop" ? <LoaderCircle size={13} className="animate-spin" /> : <Square size={13} />}
          </IconButton>
          <IconButton
            label={`More actions for ${stack.displayName}`}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onMore();
            }}
            style={busy ? { opacity: 0.45 } : undefined}
          >
            <MoreHorizontal size={14} />
          </IconButton>
        </div>
      </td>
    </tr>
  );
}
