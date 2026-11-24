import { describe, expect, test } from "bun:test";
import { applyCheckServices, hasDigestUpdate, pruneCheckServices } from "./updateCheck.ts";
import type { UpdateCheckResult } from "@shared/types.ts";

const current = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const latest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const sample: UpdateCheckResult = {
  checkedAt: "2026-01-01T00:00:00.000Z",
  available: true,
  services: [
    { service: "web", image: "nginx:alpine", currentDigest: current, latestDigest: latest, updateAvailable: true },
    { service: "worker", image: "redis:7-alpine", currentDigest: current, latestDigest: latest, updateAvailable: true },
    { service: "build", image: "local/app:latest", currentDigest: null, latestDigest: null, updateAvailable: false },
  ],
};

describe("update digest comparison", () => {
  test("reports an update when the remote digest is not local", () => {
    expect(hasDigestUpdate([current], latest)).toBe(true);
  });

  test("stays current when any local repo digest matches the registry", () => {
    expect(hasDigestUpdate([current, latest], latest)).toBe(false);
  });

  test("does not guess when the registry or local digest is missing", () => {
    expect(hasDigestUpdate([], latest)).toBe(false);
    expect(hasDigestUpdate([current], null)).toBe(false);
  });
});

describe("update check state transitions", () => {
  test("marks pulled services applied and leaves the rest pending", () => {
    const next = applyCheckServices(sample, ["web"]);
    expect(next.services.map((service) => [service.service, service.updateAvailable])).toEqual([
      ["web", false],
      ["worker", true],
      ["build", false],
    ]);
    expect(next.available).toBe(true);
    expect(next.services[0]?.currentDigest).toBe(latest);
  });

  test("marks every pulled service applied when no selection is given", () => {
    const next = applyCheckServices(sample);
    expect(next.available).toBe(false);
    expect(next.services.every((service) => !service.updateAvailable)).toBe(true);
  });

  test("drops services that no longer exist in the stack", () => {
    const next = pruneCheckServices(sample, ["web", "build"]);
    expect(next.services.map((service) => service.service)).toEqual(["web", "build"]);
    expect(next.available).toBe(true);
  });

  test("recomputes availability after pruning", () => {
    const next = pruneCheckServices(sample, ["worker"]);
    expect(next.available).toBe(true);
    const none = pruneCheckServices(sample, []);
    expect(none.services).toEqual([]);
    expect(none.available).toBe(false);
  });
});
