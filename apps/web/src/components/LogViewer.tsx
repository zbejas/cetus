import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Braces,
  Clock3,
  Copy,
  Download,
  Maximize2,
  Pause,
  Play,
  RotateCw,
  Search,
  Trash2,
  WrapText,
  X,
} from "lucide-react";
import { useToast } from "./Toast";
import { Button, IconButton, Skeleton } from "./ui";
import { ApiError } from "../lib/api";
import {
  compileSearch,
  formatLogDate,
  formatLogLine,
  formatLogTime,
  logEntryText,
  matchesLevel,
  parseLogLine,
  splitHighlights,
  type LogEntry,
  type LogLevel,
} from "../lib/logs";

export interface LogViewerSource {
  kind: "container" | "stack";
  id: string;
  hostId?: string;
  title: string;
  subtitle?: string;
  remote?: boolean;
  live?: boolean;
}

const LEVELS: { id: LogLevel; label: string }[] = [
  { id: "error", label: "Error" },
  { id: "warn", label: "Warn" },
  { id: "info", label: "Info" },
  { id: "debug", label: "Debug" },
];

const MAX_LINES = 5_000;

type Status = "connecting" | "reconnecting" | "live" | "ended" | "error" | "snapshot";

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Plain-HTTP origins do not get the async clipboard API.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Clipboard access is blocked.");
}

export function LogViewer({
  source,
  compact = false,
  snapshot = false,
  onClose,
  onExpand,
  extraHeader,
  initialTail = 500,
}: {
  source: LogViewerSource;
  compact?: boolean;
  snapshot?: boolean;
  onClose?: () => void;
  onExpand?: () => void;
  extraHeader?: React.ReactNode;
  initialTail?: number;
}) {
  const toast = useToast();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [regex, setRegex] = useState(false);
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set());
  const [tail, setTail] = useState(initialTail);
  const [nonce, setNonce] = useState(0);

  const pausedRef = useRef(false);
  const liveRef = useRef(Boolean(source.live));
  const pendingRef = useRef<LogEntry[]>([]);
  const pausedBufferRef = useRef<LogEntry[]>([]);
  const rafRef = useRef<number | null>(null);
  const nextIdRef = useRef(1);
  const bodyRef = useRef<HTMLDivElement>(null);

  const sourceKey = `${source.kind}:${source.hostId ?? ""}:${source.id}`;

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    liveRef.current = Boolean(source.live);
  }, [source.live]);

  useEffect(() => {
    let active = true;
    let attempt = 0;
    let normalEndRetries = 0;
    let retryTimer: number | null = null;
    let lastTimestampMs = 0;
    const controller = new AbortController();

    setEntries([]);
    setPendingCount(0);
    setError(null);
    setStatus("connecting");
    setPaused(false);
    pausedRef.current = false;
    pendingRef.current = [];
    pausedBufferRef.current = [];
    nextIdRef.current = 1;

    const parseLine = (line: string) => parseLogLine(line, nextIdRef.current++, { stack: source.kind === "stack" });

    const ingestLine = (line: string, floorMs = 0) => {
      if (!line.trim()) return;
      const entry = {
        ...parseLine(line),
        stream: "stdout" as const,
      };
      if (entry.timestamp) {
        const timestampMs = Date.parse(entry.timestamp);
        if (Number.isFinite(timestampMs)) {
          if (floorMs && timestampMs <= floorMs) return;
          lastTimestampMs = Math.max(lastTimestampMs, timestampMs);
        }
      }
      if (pausedRef.current) {
        pausedBufferRef.current.push(entry);
        if (pausedBufferRef.current.length > MAX_LINES) pausedBufferRef.current.shift();
        setPendingCount(pausedBufferRef.current.length);
        return;
      }
      pendingRef.current.push(entry);
      if (rafRef.current === null) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null;
          const batch = pendingRef.current;
          pendingRef.current = [];
          if (!batch.length) return;
          setEntries((current) => {
            const next = current.concat(batch);
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        });
      }
    };

    const streamUrl = (reconnect: boolean) => {
      const requestTail = reconnect ? Math.max(tail, 200) : tail;
      if (source.kind === "stack") {
        return snapshot
          ? `/api/stacks/${source.id}/logs?tail=${requestTail}&timestamps=1`
          : `/api/stacks/${source.id}/logs/stream?tail=${requestTail}&timestamps=1`;
      }
      return `/api/containers/${source.id}/logs/stream?hostId=${encodeURIComponent(source.hostId ?? "host-local")}&tail=${requestTail}&timestamps=1`;
    };

    const connect = async () => {
      if (!active) return;
      const reconnecting = attempt > 0;
      setStatus(reconnecting ? "reconnecting" : "connecting");
      const floorMs = reconnecting ? lastTimestampMs : 0;

      try {
        const response = await fetch(streamUrl(reconnecting), { credentials: "include", signal: controller.signal });
        if (!response.ok) {
          const message = await response.text().catch(() => "");
          throw new ApiError(response.status, "log_stream_failed", message || `Could not open logs (${response.status}).`);
        }
        if (!response.body) throw new Error("The log stream returned no body.");
        if (snapshot) {
          const text = await response.text();
          for (const line of text.split("\n")) ingestLine(line);
          if (active) setStatus("snapshot");
          return;
        }
        if (!active) return;
        setError(null);
        setStatus("live");
        const openedAt = Date.now();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let carry = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) {
            attempt = 0;
            setStatus("live");
          }
          const chunk = decoder.decode(value, { stream: true });
          const combined = carry + chunk;
          const lines = combined.split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) ingestLine(line, floorMs);
        }
        if (carry) ingestLine(carry, floorMs);
        if (!active) return;
        if (liveRef.current && !snapshot && normalEndRetries < 3) {
          if (Date.now() - openedAt > 10_000) normalEndRetries = 0;
          normalEndRetries += 1;
          attempt += 1;
          setStatus("reconnecting");
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void connect();
          }, 2_000);
          return;
        }
        setStatus("ended");
      } catch (caught) {
        if (!active || controller.signal.aborted) return;
        const permanent = caught instanceof ApiError && [401, 403, 404].includes(caught.status);
        attempt += 1;
        setError(caught instanceof Error ? caught.message : "The log stream failed.");
        if (permanent || attempt > 8) {
          setStatus("error");
          return;
        }
        setStatus("reconnecting");
        const delay = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void connect();
        }, delay);
      }
    };

    void connect();

    return () => {
      active = false;
      controller.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [sourceKey, snapshot, tail, nonce, source.kind, source.id, source.hostId]);

  useEffect(() => {
    if (!follow) return;
    const element = bodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries, follow, deferredQuery, levels]);

  const search = useMemo(() => compileSearch(deferredQuery, regex), [deferredQuery, regex]);

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
    for (const entry of entries) {
      counts[entry.level ?? "info"] += 1;
    }
    return counts;
  }, [entries]);

  const visible = useMemo(() => {
    return entries.filter((entry) => {
      if (levels.size > 0 && !matchesLevel(entry, levels)) return false;
      if (search && !search.test(logEntryText(entry))) return false;
      return true;
    });
  }, [entries, levels, search]);

  function toggleLevel(level: LogLevel) {
    setLevels((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  function togglePause() {
    if (!paused) {
      setPaused(true);
      pausedRef.current = true;
      return;
    }
    setPaused(false);
    pausedRef.current = false;
    const buffer = pausedBufferRef.current;
    pausedBufferRef.current = [];
    setPendingCount(0);
    if (buffer.length) {
      setEntries((current) => {
        const next = current.concat(buffer);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
      setFollow(true);
    }
  }

  function clearLogs() {
    setEntries([]);
    setPendingCount(0);
    pausedBufferRef.current = [];
    pendingRef.current = [];
  }

  function reconnect() {
    setNonce((value) => value + 1);
  }

  function copyVisible() {
    const text = visible.map((entry) => formatLogLine(entry, timestamps)).join("\n");
    void copyText(text)
      .then(() => toast.success("Logs copied", `${visible.length.toLocaleString()} visible lines on your clipboard.`))
      .catch(() => toast.error("Copy failed", "Clipboard access is blocked in this browser."));
  }

  function downloadLogs() {
    const text = visible.map((entry) => formatLogLine(entry, true)).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${source.title.replace(/[^a-z0-9._-]+/gi, "-")}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const statusLabel = paused
    ? "PAUSED"
    : status === "live"
      ? "LIVE"
      : status === "snapshot"
        ? "SNAPSHOT"
        : status === "reconnecting"
          ? "RECONNECTING"
          : status === "connecting"
            ? "CONNECTING"
            : status === "ended"
              ? "ENDED"
              : "ERROR";

  const visibleCountText = deferredQuery.trim() || levels.size > 0
    ? `${visible.length.toLocaleString()} of ${entries.length.toLocaleString()}`
    : entries.length.toLocaleString();

  return (
    <section className="log-pane" data-compact={compact} aria-label={`Logs for ${source.title}`}>
      <header className="log-pane-head">
        <div className="log-source">
          <span className="log-status-dot" data-status={statusLabel.toLowerCase()} />
          <div className="log-source-copy">
            <div className="log-source-title">
              <span className="mono">{source.title}</span>
              {source.remote ? <span className="badge log-badge">remote</span> : null}
            </div>
            <div className="log-source-sub">
              {source.subtitle ?? (source.kind === "stack" ? "Compose stack" : "Container")}
            </div>
          </div>
        </div>
        {extraHeader ? <div className="log-extra-header">{extraHeader}</div> : null}
        <div className="log-head-actions">
          <span className="log-state" data-status={statusLabel.toLowerCase()}>{statusLabel}</span>
          <IconButton label={paused ? "Resume logs" : "Pause logs"} title={paused ? "Resume" : "Pause"} onClick={togglePause}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </IconButton>
          <IconButton label="Copy visible logs" title="Copy" onClick={copyVisible} disabled={!visible.length}>
            <Copy size={14} />
          </IconButton>
          <IconButton label="Download logs" title="Download" onClick={downloadLogs} disabled={!visible.length}>
            <Download size={14} />
          </IconButton>
          {onExpand ? (
            <IconButton label="Focus this pane" title="Focus pane" onClick={onExpand}>
              <Maximize2 size={14} />
            </IconButton>
          ) : null}
          {onClose ? (
            <IconButton label="Close log pane" title="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          ) : null}
        </div>
      </header>

      <div className="log-toolbar">
        <div className="log-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter logs"
            aria-label="Filter log lines"
            spellCheck={false}
          />
          <button
            type="button"
            className="log-regex"
            data-active={regex}
            onClick={() => setRegex((value) => !value)}
            title="Treat the filter as a regular expression"
            aria-label="Toggle regular expression filter"
            aria-pressed={regex}
          >
            .*
          </button>
          {deferredQuery.trim() ? (
            <span className="log-match-count" data-error={Boolean(search?.error)}>
              {search?.error ? "bad regex" : `${visible.length.toLocaleString()}`}
            </span>
          ) : null}
        </div>
        <div className="log-levels" role="group" aria-label="Log levels">
          {LEVELS.map((level) => (
            <button
              key={level.id}
              type="button"
              className="log-level-chip"
              data-level={level.id}
              data-active={levels.has(level.id)}
              onClick={() => toggleLevel(level.id)}
              aria-pressed={levels.has(level.id)}
              title={`${level.label}: ${levelCounts[level.id].toLocaleString()} lines`}
            >
              {level.label}
              <span>{levelCounts[level.id]}</span>
            </button>
          ))}
        </div>
        <div className="log-view-toggles">
          <IconButton
            label={timestamps ? "Hide timestamps" : "Show timestamps"}
            title="Timestamps"
            className="log-toggle"
            data-active={timestamps}
            onClick={() => setTimestamps((value) => !value)}
          >
            <Clock3 size={14} />
          </IconButton>
          <IconButton
            label={wrap ? "Disable line wrap" : "Wrap long lines"}
            title="Wrap lines"
            className="log-toggle"
            data-active={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText size={14} />
          </IconButton>
        </div>
      </div>

      {search?.error ? <div className="log-search-error">{search.error}</div> : null}

      {status === "reconnecting" || (status === "error" && entries.length > 0) ? (
        <div className="log-stream-banner" data-status={status}>
          <RotateCw size={12} className={status === "reconnecting" ? "animate-spin" : undefined} />
          <span>
            {status === "reconnecting"
              ? "Connection lost. Reconnecting automatically..."
              : error ?? "The log stream stopped. Reconnect to continue."}
          </span>
          {status === "error" ? (
            <button type="button" onClick={reconnect}>Retry now</button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={bodyRef}
        className="log-body"
        data-wrap={wrap}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          setFollow(atBottom);
        }}
      >
        {entries.length === 0 && (status === "connecting" || status === "reconnecting") ? (
          <div className="log-skeleton" aria-busy="true">
            {[64, 42, 78, 55, 38, 70, 49].map((width, index) => (
              <Skeleton key={index} className="h-3" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : status === "error" && entries.length === 0 ? (
          <div className="log-empty">
            <strong>Log stream unavailable</strong>
            <span>{error ?? "Cetus could not open this log stream."}</span>
            <Button size="sm" onClick={reconnect}><RotateCw size={12} /> Reconnect</Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="log-empty">
            <strong>{status === "snapshot" ? "No log output" : "Waiting for output"}</strong>
            <span>The container has not written logs yet.</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="log-empty">
            <strong>No lines match</strong>
            <span>Clear the filter or choose another level.</span>
          </div>
        ) : (
          visible.map((entry) => (
            <div
              key={entry.id}
              className="log-row"
              data-level={entry.level ?? undefined}
              data-continuation={entry.continuation || undefined}
            >
              {timestamps ? (
                <span className="log-time" title={formatLogDate(entry.timestamp)}>
                  {formatLogTime(entry.timestamp) || " ".repeat(12)}
                </span>
              ) : null}
              {source.kind === "stack" && entry.service ? (
                <span className="log-service">{entry.service}</span>
              ) : null}
              {entry.level ? (
                <span className="log-level" data-level={entry.level}>{entry.level}</span>
              ) : null}
              {entry.json ? <Braces size={10} className="log-json" aria-label="JSON log" /> : null}
              <span className="log-message">
                {deferredQuery.trim()
                  ? splitHighlights(entry.message, deferredQuery, regex).map((part, index) =>
                      part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
                    )
                  : entry.message}
              </span>
            </div>
          ))
        )}
      </div>

      <footer className="log-foot">
        <span>{visibleCountText} lines</span>
        <span aria-hidden="true">·</span>
        <span>{source.kind === "stack" ? "stack stream" : "container stream"}</span>
        {paused && pendingCount > 0 ? (
          <button type="button" className="log-new-lines" onClick={togglePause}>
            {pendingCount.toLocaleString()} new lines
          </button>
        ) : null}
        <div className="log-foot-actions">
          <label className="log-tail">
            Tail
            <select
              value={tail}
              onChange={(event) => setTail(Number(event.target.value))}
              aria-label="Initial log tail"
            >
              {[200, 500, 1_000, 5_000].map((value) => (
                <option key={value} value={value}>{value.toLocaleString()}</option>
              ))}
            </select>
          </label>
          {status === "ended" || status === "error" ? (
            <button type="button" className="log-reconnect" onClick={reconnect}>
              <RotateCw size={11} /> Reconnect
            </button>
          ) : null}
          <button type="button" className="log-clear" onClick={clearLogs} disabled={!entries.length}>
            <Trash2 size={11} /> Clear
          </button>
        </div>
      </footer>

      {!follow && visible.length > 0 ? (
        <button type="button" className="log-jump" onClick={() => {
          setFollow(true);
          const element = bodyRef.current;
          if (element) element.scrollTop = element.scrollHeight;
        }}>
          <ArrowDownToLine size={13} /> Jump to latest
        </button>
      ) : null}
    </section>
  );
}
