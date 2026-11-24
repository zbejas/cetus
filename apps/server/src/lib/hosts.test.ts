import { describe, expect, test } from "bun:test";
import { compareVersions } from "./hosts.ts";

describe("version comparison", () => {
  test("orders patch versions", () => {
    expect(compareVersions("0.1.3", "0.1.4")).toBeLessThan(0);
    expect(compareVersions("0.1.4", "0.1.3")).toBeGreaterThan(0);
    expect(compareVersions("0.1.4", "0.1.4")).toBe(0);
  });

  test("accepts a v prefix and ignores non-numeric suffixes", () => {
    expect(compareVersions("v0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(0);
  });

  test("treats missing segments as zero", () => {
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("1", "0.9.9")).toBeGreaterThan(0);
  });
});
