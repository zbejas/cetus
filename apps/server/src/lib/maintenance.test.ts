import { describe, expect, test } from "bun:test";
import { maintenanceArgs, maintenanceScope, parseMaintenanceInput } from "./maintenance.ts";

describe("docker maintenance", () => {
  test("builds prune arguments", () => {
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "image", action: "prune" })))
      .toEqual(["image", "prune", "-f"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "image", action: "prune", all: true })))
      .toEqual(["image", "prune", "-f", "-a"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "volume", action: "prune", all: true })))
      .toEqual(["volume", "prune", "-f", "-a"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "network", action: "prune" })))
      .toEqual(["network", "prune", "-f"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "container", action: "prune" })))
      .toEqual(["container", "prune", "-f"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "builder", action: "prune" })))
      .toEqual(["builder", "prune", "-f"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "system", action: "prune", all: true, volumes: true })))
      .toEqual(["system", "prune", "-f", "-a", "--volumes"]);
  });

  test("builds remove arguments", () => {
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "image", action: "remove", target: "sha256:abc123" })))
      .toEqual(["image", "rm", "sha256:abc123"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "image", action: "remove", target: "ghcr.io/zbejas/cetus:latest" })))
      .toEqual(["image", "rm", "ghcr.io/zbejas/cetus:latest"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "volume", action: "remove", target: "cetus_data" })))
      .toEqual(["volume", "rm", "cetus_data"]);
    expect(maintenanceArgs(parseMaintenanceInput({ resource: "network", action: "remove", target: "app_default" })))
      .toEqual(["network", "rm", "app_default"]);
  });

  test("maps actions to scopes", () => {
    expect(maintenanceScope(parseMaintenanceInput({ resource: "image", action: "prune" }))).toBe("images:prune");
    expect(maintenanceScope(parseMaintenanceInput({ resource: "image", action: "remove", target: "abc" }))).toBe("images:write");
    expect(maintenanceScope(parseMaintenanceInput({ resource: "volume", action: "prune" }))).toBe("volumes:prune");
    expect(maintenanceScope(parseMaintenanceInput({ resource: "volume", action: "remove", target: "data" }))).toBe("volumes:write");
    expect(maintenanceScope(parseMaintenanceInput({ resource: "network", action: "prune" }))).toBe("networks:prune");
    expect(maintenanceScope(parseMaintenanceInput({ resource: "network", action: "remove", target: "app" }))).toBe("networks:write");
    expect(maintenanceScope(parseMaintenanceInput({ resource: "system", action: "prune" }))).toBe("system:prune");
  });

  test("rejects invalid requests", () => {
    expect(() => parseMaintenanceInput({ resource: "system", action: "remove" })).toThrow();
    expect(() => parseMaintenanceInput({ resource: "image", action: "remove" })).toThrow();
    expect(() => parseMaintenanceInput({ resource: "image", action: "remove", target: "-f" })).toThrow();
    expect(() => parseMaintenanceInput({ resource: "image", action: "remove", target: "bad image" })).toThrow();
    expect(() => parseMaintenanceInput({ resource: "volume", action: "remove", target: "bad/name" })).toThrow();
    expect(() => parseMaintenanceInput({ resource: "bogus", action: "prune" } as never)).toThrow();
    expect(() => parseMaintenanceInput({ resource: "image", action: "bogus" } as never)).toThrow();
  });
});
