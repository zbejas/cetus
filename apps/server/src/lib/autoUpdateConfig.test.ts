import { describe, expect, test } from "bun:test";
import type { AutoUpdateConfig, StackMetadata } from "@shared/types.ts";
import {
  DEFAULT_AUTO_UPDATE_CONFIG,
  manualAutoUpdateConfig,
  normalizeAutoUpdateConfig,
  resolveAutoUpdate,
  validateAutoUpdateConfig,
} from "./autoUpdateConfig.ts";

const custom: AutoUpdateConfig = {
  enabled: true,
  cron: "0 3 * * *",
  timezone: "Europe/Ljubljana",
  healthCheck: true,
  rollback: true,
};

const globalOn: AutoUpdateConfig = {
  ...DEFAULT_AUTO_UPDATE_CONFIG,
  enabled: true,
  cron: "0 4 * * *",
  timezone: "UTC",
};

describe("auto-update config", () => {
  test("fills missing fields from the default", () => {
    const config = normalizeAutoUpdateConfig({ enabled: true });
    expect(config.enabled).toBe(true);
    expect(config.cron).toBe(DEFAULT_AUTO_UPDATE_CONFIG.cron);
    expect(config.timezone).toBe(DEFAULT_AUTO_UPDATE_CONFIG.timezone);
    expect(config.excludeServices).toBeUndefined();
  });

  test("rejects an invalid cron and timezone", () => {
    expect(() => validateAutoUpdateConfig({ ...custom, cron: "not a cron" })).toThrow();
    expect(() => validateAutoUpdateConfig({ ...custom, timezone: "Mars/Olympus" })).toThrow();
  });

  test("per-stack config wins over the global default", () => {
    const metadata: StackMetadata = { autoUpdate: custom };
    expect(resolveAutoUpdate(metadata, globalOn)).toEqual({ config: normalizeAutoUpdateConfig(custom), source: "custom" });
  });

  test("an explicit per-stack off wins over the global default", () => {
    const metadata: StackMetadata = { autoUpdate: { ...custom, enabled: false } };
    expect(resolveAutoUpdate(metadata, globalOn)).toEqual({ config: null, source: "off" });
  });

  test("stacks without an override inherit the global default", () => {
    expect(resolveAutoUpdate({}, globalOn)).toEqual({ config: globalOn, source: "global" });
    expect(resolveAutoUpdate({}, DEFAULT_AUTO_UPDATE_CONFIG)).toEqual({ config: null, source: "off" });
  });

  test("manual runs fall back to the global settings even when the schedule is off", () => {
    const manual = manualAutoUpdateConfig({}, DEFAULT_AUTO_UPDATE_CONFIG);
    expect(manual.enabled).toBe(true);
    expect(manual.cron).toBe(DEFAULT_AUTO_UPDATE_CONFIG.cron);
  });

  test("manual runs keep explicit service exclusions", () => {
    const metadata: StackMetadata = {
      autoUpdate: { ...custom, enabled: false, excludeServices: ["gluetun"] },
    };
    const manual = manualAutoUpdateConfig(metadata, globalOn);
    expect(manual.enabled).toBe(false);
    expect(manual.excludeServices).toEqual(["gluetun"]);
  });
});
