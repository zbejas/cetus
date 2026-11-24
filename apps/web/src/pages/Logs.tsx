import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  ChevronDown,
  Columns2,
  Layers,
  LayoutGrid,
  ListFilter,
  PanelLeft,
  Play,
  Search,
  Server,
  TerminalSquare,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useLogSources } from "../lib/queries";
import { useToast } from "../components/Toast";
import { Button, EmptyState, Skeleton } from "../components/ui";
import { LogViewer, type LogViewerSource } from "../components/LogViewer";
import { fuzzyScore } from "../lib/logs";
import type { LogSource } from "@shared/types";

const MAX_PANES = 4;

function sourceKey(source: Pick<LogSource, "hostId" | "id">) {
  return `${source.hostId}:${source.id}`;
}

function toViewerSource(source: LogSource): LogViewerSource {
  return {
    kind: "container",
    id: source.id,
    hostId: source.hostId,
    title: source.name.replace(/^\//, ""),
    subtitle: `${source.stackName ?? "standalone"} · ${source.hostName} · ${source.image}`,
    remote: source.hostKind !== "local",
    live: Boolean(source.running),
  };
}

export function LogsPage() {
  const sources = useLogSources();
  const toast = useToast();
  const routerSearch = useRouterState({ select: (state) => state.location.searchStr });
  const params = useMemo(() => new URLSearchParams(routerSearch), [routerSearch]);
  const containerParam = params.get("container");
  const hostParam = params.get("host");

  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [hostFilter, setHostFilter] = useState("all");
  const [runningOnly, setRunningOnly] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia("(min-width: 901px)").matches,
  );
  const [focusedPane, setFocusedPane] = useState<string | null>(null);
  const appliedDeepLink = useRef<string | null>(null);
  const autoSelected = useRef(false);

  const allSources = sources.data ?? [];
  const keyed = useMemo(() => new Map(allSources.map((source) => [sourceKey(source), source])), [allSources]);
  const selectedSources = selected.map((key) => keyed.get(key)).filter((source): source is LogSource => Boolean(source));
  const hosts = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of allSources) map.set(source.hostId, source.hostName);
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allSources]);

  // Apply a deep link once per container id, or open the first running
  // container on a cold visit so the page is immediately useful.
  useEffect(() => {
    if (!allSources.length) return;
    if (containerParam) {
      const match = allSources.find((source) =>
        (source.id === containerParam || source.id.startsWith(containerParam)) &&
        (!hostParam || source.hostId === hostParam),
      );
      if (match) {
        const key = sourceKey(match);
        if (appliedDeepLink.current !== key) {
          appliedDeepLink.current = key;
          setSelected((current) => current.includes(key) ? current : [...current, key].slice(-MAX_PANES));
        }
      }
      return;
    }
    if (autoSelected.current) return;
    autoSelected.current = true;
    const first = allSources.find((source) => source.running && source.state === "running") ?? allSources[0];
    if (first) setSelected([sourceKey(first)]);
  }, [allSources, containerParam, hostParam]);

  // Drop selections whose container disappeared after a refresh.
  useEffect(() => {
    setSelected((current) => {
      const next = current.filter((key) => keyed.has(key));
      return next.length === current.length ? current : next;
    });
  }, [keyed]);

  // Keep one deep-linkable primary selection in the URL without a full route
  // navigation or a scroll jump.
  const primaryId = selectedSources[0]?.id;
  const primaryHostId = selectedSources[0]?.hostId;
  useEffect(() => {
    const url = new URL(window.location.href);
    if (primaryId && primaryHostId) {
      url.searchParams.set("container", primaryId);
      url.searchParams.set("host", primaryHostId);
    } else {
      url.searchParams.delete("container");
      url.searchParams.delete("host");
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, [primaryId, primaryHostId]);

  const filtered = useMemo(() => {
    return allSources.filter((source) => {
      if (hostFilter !== "all" && source.hostId !== hostFilter) return false;
      if (runningOnly && !source.running) return false;
      if (deferredSearch.trim()) {
        const haystack = `${source.name} ${source.names} ${source.image} ${source.service ?? ""} ${source.project ?? ""} ${source.hostName}`;
        if (fuzzyScore(haystack, deferredSearch) === null) return false;
      }
      return true;
    });
  }, [allSources, deferredSearch, hostFilter, runningOnly]);

  const groups = useMemo(() => {
    const map = new Map<string, { key: string; hostName: string; project: string; sources: LogSource[] }>();
    for (const source of filtered) {
      const key = `${source.hostId}:${source.project ?? "__standalone"}`;
      const group = map.get(key) ?? {
        key,
        hostName: source.hostName,
        project: source.stackName ?? source.project ?? "Standalone containers",
        sources: [],
      };
      group.sources.push(source);
      map.set(key, group);
    }
    return [...map.values()].sort((a, b) =>
      a.hostName === b.hostName ? a.project.localeCompare(b.project) : a.hostName.localeCompare(b.hostName),
    );
  }, [filtered]);

  function openSource(source: LogSource) {
    const key = sourceKey(source);
    if (selected.includes(key)) return;
    setSelected((current) => {
      if (!current.length) return [key];
      const target = focusedPane && current.includes(focusedPane)
        ? focusedPane
        : current[current.length - 1];
      return current.map((item) => item === target ? key : item);
    });
    setFocusedPane(null);
    if (window.matchMedia("(max-width: 900px)").matches) setSourcesOpen(false);
  }

  function openInNewPane(source: LogSource) {
    const key = sourceKey(source);
    if (selected.includes(key)) {
      setFocusedPane(key);
      return;
    }
    if (selected.length >= MAX_PANES) {
      toast.push({
        title: "Pane limit reached",
        description: "Close a log pane before opening a fifth container.",
        tone: "info",
      });
      return;
    }
    setSelected((current) => [...current, key]);
    setFocusedPane(null);
    if (window.matchMedia("(max-width: 900px)").matches) setSourcesOpen(false);
  }

  function closeSource(key: string) {
    setSelected((current) => current.filter((item) => item !== key));
    if (focusedPane === key) setFocusedPane(null);
  }

  useEffect(() => {
    if (focusedPane && !selected.includes(focusedPane)) setFocusedPane(null);
  }, [focusedPane, selected]);

  const runningCount = allSources.filter((source) => source.running).length;
  const focusedSource = focusedPane
    ? selectedSources.find((source) => sourceKey(source) === focusedPane) ?? null
    : null;
  const visibleSources = focusedSource ? [focusedSource] : selectedSources;

  return (
    <div className="logs-page">
      {focusedSource ? (
        <div className="logs-focus-bar">
          <div className="logs-focus-title">
            <TerminalSquare size={15} />
            <strong>{focusedSource.service ?? focusedSource.name}</strong>
            <span>{focusedSource.name}</span>
          </div>
          <Button variant="ghost" onClick={() => setFocusedPane(null)}>
            <LayoutGrid size={14} /> Show all panes
          </Button>
        </div>
      ) : null}
      <div className="logs-page-head">
        <div>
          <h1>Logs</h1>
          <p>
            {allSources.length
              ? `${allSources.length} containers across ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"} · ${runningCount} running`
              : "Live tails from every container in the fleet."}
          </p>
        </div>
        <div className="logs-head-actions">
          <Button
            variant="ghost"
            className="logs-sources-toggle"
            onClick={() => setSourcesOpen((value) => !value)}
            aria-expanded={sourcesOpen}
            aria-label={sourcesOpen ? "Hide containers" : "Show containers"}
          >
            <PanelLeft size={14} /> <span className="logs-action-label">Containers</span>
            <ChevronDown size={13} data-open={sourcesOpen} />
          </Button>
          <Button
            variant="ghost"
            onClick={() => setSelected([])}
            disabled={!selected.length}
            aria-label="Clear all log panes"
          >
            <X size={13} /> <span className="logs-action-label">Clear all</span>
          </Button>
        </div>
      </div>

      <div className="logs-layout" data-sources-open={sourcesOpen}>
        <aside className="logs-sources" aria-label="Container sources">
          <div className="logs-source-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a container"
              aria-label="Find a container"
              spellCheck={false}
            />
            {search ? (
              <button type="button" onClick={() => setSearch("")} aria-label="Clear container search">
                <X size={12} />
              </button>
            ) : null}
          </div>

          <div className="logs-source-filters">
            <label>
              <Server size={12} />
              <select value={hostFilter} onChange={(event) => setHostFilter(event.target.value)} aria-label="Filter by host">
                <option value="all">All hosts</option>
                {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
              </select>
            </label>
            <button
              type="button"
              data-active={runningOnly}
              onClick={() => setRunningOnly((value) => !value)}
              aria-pressed={runningOnly}
            >
              <Play size={11} /> Running
            </button>
          </div>

          {sources.isLoading ? (
            <div className="logs-source-skeleton" aria-busy="true">
              {[0, 1, 2, 3, 4, 5].map((row) => <Skeleton key={row} className="h-10 w-full" />)}
            </div>
          ) : sources.isError ? (
            <EmptyState
              icon={<TerminalSquare size={18} />}
              title="Containers unavailable"
              description="Cetus could not load the container list."
              action={<Button size="sm" onClick={() => void sources.refetch()}>Retry</Button>}
            />
          ) : !filtered.length ? (
            <div className="logs-source-empty">
              <ListFilter size={16} />
              <strong>No containers match</strong>
              <span>Try a different search or host.</span>
            </div>
          ) : (
            <div className="logs-source-list">
              {groups.map((group) => (
                <section key={group.key} className="logs-source-group">
                  <div className="logs-source-group-head">
                    <span className="mono">{group.project}</span>
                    <span>{group.hostName}</span>
                  </div>
                  {group.sources.map((source) => {
                    const key = sourceKey(source);
                    const isSelected = selected.includes(key);
                    return (
                      <div key={key} className="logs-source-row" data-selected={isSelected}>
                        <button
                          type="button"
                          className="logs-source-main"
                          onClick={() => openSource(source)}
                          aria-label={`Open logs for ${source.name}`}
                          aria-pressed={isSelected}
                        >
                          <span className="log-status-dot" data-status={source.running ? "live" : "ended"} />
                          <span className="logs-source-info">
                            <span className="logs-source-name">
                              {source.service ?? source.name}
                              {source.unmanaged ? <em>standalone</em> : null}
                            </span>
                            <span className="logs-source-meta">{source.name} · {source.image}</span>
                          </span>
                          <span className="logs-source-state">{source.state}</span>
                        </button>
                        {!isSelected ? (
                          <button
                            type="button"
                            className="logs-source-new"
                            onClick={() => openInNewPane(source)}
                            aria-label={`Open ${source.name} in a new panel`}
                            title="Open in a new panel"
                          >
                            <Columns2 size={13} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </aside>

        <div className="logs-workspace">
          {visibleSources.length ? (
            <div className="logs-panes" data-count={visibleSources.length}>
              {visibleSources.map((source) => (
                <LogViewer
                  key={sourceKey(source)}
                  source={toViewerSource(source)}
                  onClose={() => closeSource(sourceKey(source))}
                  onExpand={() => setFocusedPane(sourceKey(source))}
                />
              ))}
            </div>
          ) : (
            <div className="logs-welcome">
              <div className="logs-welcome-icon"><TerminalSquare size={22} /></div>
              <h2>Pick a container</h2>
              <p>Choose a container from the left to tail its logs. Open up to four at once for a split view.</p>
              <div className="logs-welcome-actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    const first = allSources.find((source) => source.running) ?? allSources[0];
                    if (first) {
                      setSelected([sourceKey(first)]);
                      setSourcesOpen(false);
                    }
                  }}
                  disabled={!allSources.length}
                >
                  <Play size={13} /> Open first running
                </Button>
                <Link to="/hosts" className="btn"><Layers size={13} /> Browse hosts</Link>
              </div>
              <div className="logs-welcome-hint">
                {runningCount} running containers are ready to tail across {hosts.length} {hosts.length === 1 ? "host" : "hosts"}.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
