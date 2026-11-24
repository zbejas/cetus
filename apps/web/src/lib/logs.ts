export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface LogEntry {
  id: number;
  raw: string;
  message: string;
  timestamp: string | null;
  service: string | null;
  stream: "stdout" | "stderr";
  level: LogLevel | null;
  json: Record<string, unknown> | null;
  continuation: boolean;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const COMPOSE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s+\|\s?(.*)$/;
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s?(.*)$/;
const BRACKET_LEVEL = /^\s*\[(trace|debug|info|notice|warn(?:ing)?|error|err|fatal|panic|critical)\]/i;
const PREFIX_LEVEL = /^\s*(trace|debug|info|notice|warn(?:ing)?|error|err|fatal|panic|critical)\s*[:\-]/i;
const INLINE_BRACKET_LEVEL = /\[(trace|debug|info|notice|warn(?:ing)?|error|err|fatal|panic|critical)\]/i;
const LEVEL_ASSIGNMENT = /\b(?:level|severity|loglevel)\s*[=:]\s*["']?(trace|debug|info|notice|warn(?:ing)?|error|err|fatal|panic|critical)\b/i;

function normalizeLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") return null;
  const level = value.trim().toLowerCase();
  if (level === "trace") return "trace";
  if (level === "debug") return "debug";
  if (level === "info" || level === "notice" || level === "information") return "info";
  if (level === "warn" || level === "warning") return "warn";
  if (["error", "err", "fatal", "panic", "critical", "crit", "alert", "emergency"].includes(level)) return "error";
  return null;
}

function levelFromJson(json: Record<string, unknown> | null): LogLevel | null {
  if (!json) return null;
  return normalizeLevel(json.level)
    ?? normalizeLevel(json.severity)
    ?? normalizeLevel(json.loglevel)
    ?? normalizeLevel(json.levelname)
    ?? normalizeLevel(json["log.level"]);
}

function levelFromText(text: string): LogLevel | null {
  const bracketed = text.match(BRACKET_LEVEL)?.[1] ?? text.match(INLINE_BRACKET_LEVEL)?.[1];
  if (bracketed) return normalizeLevel(bracketed);
  const prefixed = text.match(PREFIX_LEVEL)?.[1];
  if (prefixed) return normalizeLevel(prefixed);
  const assigned = text.match(LEVEL_ASSIGNMENT)?.[1];
  if (assigned) return normalizeLevel(assigned);
  return null;
}

function parseJsonMessage(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseLogLine(rawLine: string, id: number, options: { stack?: boolean } = {}): LogEntry {
  let text = rawLine.replace(ANSI_PATTERN, "");
  let service: string | null = null;

  if (options.stack) {
    const match = text.match(COMPOSE_PATTERN);
    if (match) {
      service = match[1];
      text = match[2];
    }
  }

  let timestamp: string | null = null;
  const timestampMatch = text.match(TIMESTAMP_PATTERN);
  if (timestampMatch) {
    timestamp = timestampMatch[1];
    text = timestampMatch[2];
  }

  const json = parseJsonMessage(text);
  const level = levelFromJson(json) ?? levelFromText(text);
  const continuation = /^\s+(?:at\s|\.\.\.|\w+\s*\()/.test(text) || /^\s{4,}\S/.test(text);

  return {
    id,
    raw: rawLine,
    message: text,
    timestamp,
    service,
    stream: "stdout",
    level,
    json,
    continuation,
  };
}

export function formatLogTime(timestamp: string | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

export function formatLogDate(timestamp: string | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString();
}

export function formatLogLine(entry: LogEntry, timestamps: boolean) {
  const service = entry.service ? `${entry.service} | ` : "";
  const timestamp = timestamps && entry.timestamp ? `${entry.timestamp} ` : "";
  return `${service}${timestamp}${entry.message}`;
}

export interface CompiledSearch {
  test: (text: string) => boolean;
  error: string | null;
}

export function compileSearch(query: string, regex: boolean): CompiledSearch | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (!regex) {
    const needle = trimmed.toLowerCase();
    return { test: (text) => text.toLowerCase().includes(needle), error: null };
  }
  try {
    const pattern = new RegExp(trimmed, "i");
    return { test: (text) => pattern.test(text), error: null };
  } catch (error) {
    return { test: () => false, error: error instanceof Error ? error.message : "Invalid regular expression" };
  }
}

export function logEntryText(entry: LogEntry) {
  return `${entry.service ? `${entry.service} ` : ""}${entry.message}`;
}

export function matchesLevel(entry: LogEntry, levels: Set<LogLevel>) {
  if (levels.size === 0) return true;
  if (!entry.level) return levels.has("info");
  return levels.has(entry.level);
}

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export function levelRank(level: LogLevel | null) {
  return level ? LEVEL_RANK[level] : 5;
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

export function splitHighlights(text: string, query: string, regex: boolean): HighlightPart[] {
  const trimmed = query.trim();
  if (!trimmed) return [{ text, match: false }];
  let pattern: RegExp;
  try {
    pattern = regex
      ? new RegExp(trimmed, "gi")
      : new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return [{ text, match: false }];
  }
  const parts: HighlightPart[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > last) parts.push({ text: text.slice(last, match.index), match: false });
    parts.push({ text: match[0], match: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

export function fuzzyScore(text: string, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let index = 0;
  let score = 0;
  let streak = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, index);
    if (found < 0) return null;
    if (found === index) {
      streak += 1;
      score += 4 + streak;
    } else {
      streak = 0;
      score += 1 - Math.min(0.5, (found - index) / 100);
    }
    index = found + 1;
  }
  return score;
}
