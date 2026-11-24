import type { AutoUpdateConfig } from "@shared/types";

export function cronToTime(cron: string | undefined) {
  if (!cron) return null;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  if (!fields[2].includes("*") || !fields[3].includes("*") || !fields[4].includes("*")) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function timeToCron(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return `${Number.isFinite(minute) ? minute : 0} ${Number.isFinite(hour) ? hour : 4} * * *`;
}

export function scheduleLabel(config: AutoUpdateConfig | null | undefined) {
  if (!config?.enabled) return "Off";
  const time = cronToTime(config.cron);
  return time ? `Daily ${time} · ${config.timezone}` : `${config.cron} · ${config.timezone}`;
}
