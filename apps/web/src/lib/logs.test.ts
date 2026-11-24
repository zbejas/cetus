import { describe, expect, test } from "bun:test";
import {
  compileSearch,
  formatLogLine,
  fuzzyScore,
  parseLogLine,
  splitHighlights,
} from "./logs";

describe("log parsing", () => {
  test("reads docker timestamps and JSON levels", () => {
    const line = parseLogLine(
      '2026-11-24T03:04:05.123456789Z {"level":"error","msg":"database offline"}',
      1,
    );
    expect(line.timestamp).toBe("2026-11-24T03:04:05.123456789Z");
    expect(line.level).toBe("error");
    expect(line.json).not.toBeNull();
    expect(line.message).toContain("database offline");
  });

  test("reads compose service prefixes and timestamps", () => {
    const line = parseLogLine(
      "web-1   | 2026-11-24T03:04:05.000000000Z 2026/11/24 03:04:05 [error] upstream failed",
      2,
      { stack: true },
    );
    expect(line.service).toBe("web-1");
    expect(line.timestamp).toBe("2026-11-24T03:04:05.000000000Z");
    expect(line.level).toBe("error");
  });

  test("strips ANSI escapes and detects notice levels", () => {
    const line = parseLogLine("\u001b[32m[notice] ready\u001b[0m", 3);
    expect(line.message).toBe("[notice] ready");
    expect(line.level).toBe("info");
  });

  test("finds inline bracketed levels", () => {
    const line = parseLogLine("2026/11/24 02:14:00 [notice] start worker process", 4);
    expect(line.timestamp).toBeNull();
    expect(line.level).toBe("info");
  });

  test("formats timestamps only when requested", () => {
    const line = parseLogLine("2026-11-24T03:04:05.000000000Z hello", 5, { stack: true });
    expect(formatLogLine(line, false)).toBe("hello");
    expect(formatLogLine(line, true)).toContain("2026-11-24T03:04:05.000000000Z");
  });
});

describe("log search", () => {
  test("supports literal and regex matching", () => {
    expect(compileSearch("50%", false)?.test("usage 50% of disk")).toBe(true);
    expect(compileSearch("err(or)?", true)?.test("error")).toBe(true);
    expect(compileSearch("(", true)?.error).not.toBeNull();
  });

  test("splits literal matches without regex injection", () => {
    const parts = splitHighlights("a.b aXb", "a.b", false);
    expect(parts.filter((part) => part.match)).toHaveLength(1);
  });

  test("fuzzy search favors contiguous matches", () => {
    expect(fuzzyScore("hello-cetus", "hello")).not.toBeNull();
    expect(fuzzyScore("hello-cetus", "hct")).not.toBeNull();
    expect(fuzzyScore("hello-cetus", "zzz")).toBeNull();
  });
});
