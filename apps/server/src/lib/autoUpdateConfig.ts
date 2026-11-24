import type { AutoUpdateConfig, AutoUpdateSource, StackMetadata } from "@shared/types.ts";
import { isValidCron } from "./cron.ts";
import { ApiError } from "./errors.ts";

const SERVER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const DEFAULT_AUTO_UPDATE_CONFIG: AutoUpdateConfig = {
  enabled: false,
  cron: "0 4 * * *",
  timezone: SERVER_TIMEZONE,
  healthCheck: true,
  rollback: true,
  healthGraceSeconds: 90,
};

export function normalizeAutoUpdateConfig(input: Partial<AutoUpdateConfig> | null | undefined): AutoUpdateConfig {
  const value = input ?? {};
  const grace = Number(value.healthGraceSeconds);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_AUTO_UPDATE_CONFIG.enabled,
    cron: typeof value.cron === "string" && value.cron.trim() ? value.cron.trim() : DEFAULT_AUTO_UPDATE_CONFIG.cron,
    timezone: typeof value.timezone === "string" && value.timezone.trim() ? value.timezone.trim() : DEFAULT_AUTO_UPDATE_CONFIG.timezone,
    services: Array.isArray(value.services)
      ? value.services.map(String).map((name) => name.trim()).filter(Boolean)
      : undefined,
    excludeServices: Array.isArray(value.excludeServices)
      ? value.excludeServices.map(String).map((name) => name.trim()).filter(Boolean)
      : undefined,
    healthCheck: typeof value.healthCheck === "boolean" ? value.healthCheck : DEFAULT_AUTO_UPDATE_CONFIG.healthCheck,
    rollback: typeof value.rollback === "boolean" ? value.rollback : DEFAULT_AUTO_UPDATE_CONFIG.rollback,
    healthGraceSeconds: Number.isFinite(grace) ? grace : DEFAULT_AUTO_UPDATE_CONFIG.healthGraceSeconds,
  };
}

export function validateAutoUpdateConfig(config: AutoUpdateConfig) {
  if (!config.cron || !isValidCron(config.cron)) {
    throw new ApiError(422, "auto_update_cron_invalid", "Auto-update cron must be a valid five-field expression.");
  }
  if (!config.timezone) {
    throw new ApiError(422, "auto_update_timezone_invalid", "Auto-update timezone is required.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone }).format(new Date());
  } catch {
    throw new ApiError(422, "auto_update_timezone_invalid", `Unknown timezone: ${config.timezone}`);
  }
  if (config.services !== undefined) {
    if (!Array.isArray(config.services) || config.services.some((name) => typeof name !== "string" || !name.trim())) {
      throw new ApiError(422, "auto_update_services_invalid", "Auto-update services must be a list of service names.");
    }
  }
  if (config.excludeServices !== undefined) {
    if (!Array.isArray(config.excludeServices) || config.excludeServices.some((name) => typeof name !== "string" || !name.trim())) {
      throw new ApiError(422, "auto_update_exclude_invalid", "Excluded services must be a list of service names.");
    }
  }
  if (config.healthGraceSeconds !== undefined) {
    const grace = Number(config.healthGraceSeconds);
    if (!Number.isFinite(grace) || grace < 10 || grace > 600) {
      throw new ApiError(422, "auto_update_grace_invalid", "Health grace must be between 10 and 600 seconds.");
    }
  }
}

export function resolveAutoUpdate(
  metadata: StackMetadata | null | undefined,
  global: AutoUpdateConfig,
): { config: AutoUpdateConfig | null; source: AutoUpdateSource } {
  if (metadata?.autoUpdate) {
    const config = normalizeAutoUpdateConfig(metadata.autoUpdate);
    return config.enabled ? { config, source: "custom" } : { config: null, source: "off" };
  }
  return global.enabled ? { config: global, source: "global" } : { config: null, source: "off" };
}

export function manualAutoUpdateConfig(
  metadata: StackMetadata | null | undefined,
  global: AutoUpdateConfig,
): AutoUpdateConfig {
  if (metadata?.autoUpdate) return normalizeAutoUpdateConfig(metadata.autoUpdate);
  return { ...global, enabled: true };
}
