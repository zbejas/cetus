import { describe, expect, test } from "bun:test";
import { computeStatus, isOneShot, safeStackName, validateComposeText } from "./stacks.ts";
import type { ServiceState } from "@shared/types.ts";

function service(overrides: Partial<ServiceState>): ServiceState {
  return {
    name: "web",
    image: "nginx:alpine",
    state: "running",
    health: "none",
    status: "Up",
    ports: [],
    containerId: "abc",
    containerName: "web-1",
    cpu: 0,
    memoryUsed: 0,
    memoryLimit: 0,
    uptime: "1m",
    oneShot: false,
    ...overrides,
  };
}

describe("stack validation", () => {
  test("accepts a minimal compose file", () => {
    expect(validateComposeText("services:\n  web:\n    image: nginx:alpine\n").ok).toBe(true);
  });

  test("rejects empty or missing services", () => {
    expect(validateComposeText("").ok).toBe(false);
    expect(validateComposeText("name: test\n").ok).toBe(false);
    expect(validateComposeText("services: {}\n").ok).toBe(false);
  });

  test("rejects syntax errors", () => {
    const result = validateComposeText("services:\n  web:\n    image: [\n");
    expect(result.ok).toBe(false);
    expect(result.errors[0].length).toBeGreaterThan(0);
  });

  test("stack names are path safe", () => {
    expect(safeStackName("hello-cetus")).toBe(true);
    expect(safeStackName("hello_cetus")).toBe(true);
    expect(safeStackName("Hello")).toBe(false);
    expect(safeStackName("../escape")).toBe(false);
    expect(safeStackName("with space")).toBe(false);
  });
});

describe("stack health", () => {
  test("one-shot exits do not mark the stack failed", () => {
    const services = [
      service({ name: "web", state: "running" }),
      service({ name: "init", state: "exited", oneShot: true }),
    ];
    expect(computeStatus(services)).toBe("running");
  });

  test("partial running services are degraded", () => {
    const services = [
      service({ name: "web", state: "running" }),
      service({ name: "worker", state: "exited" }),
    ];
    expect(computeStatus(services)).toBe("partial");
  });

  test("running but unhealthy services degrade the stack", () => {
    const services = [
      service({ name: "web", state: "running", health: "unhealthy" }),
      service({ name: "init", state: "exited", oneShot: true }),
    ];
    expect(computeStatus(services)).toBe("partial");
  });

  test("healthy services keep the stack running", () => {
    const services = [service({ name: "web", state: "running", health: "healthy" })];
    expect(computeStatus(services)).toBe("running");
  });

  test("all expected services exited is stopped", () => {
    const services = [
      service({ name: "web", state: "exited" }),
      service({ name: "worker", state: "exited" }),
    ];
    expect(computeStatus(services)).toBe("stopped");
  });

  test("explicit one-shot extension is respected", () => {
    expect(isOneShot("migrate", { "x-cetus-one-shot": true })).toBe(true);
    expect(isOneShot("init", { restart: "no" })).toBe(true);
    expect(isOneShot("web", { restart: "unless-stopped" })).toBe(false);
  });
});
