import { eq } from "drizzle-orm";
import type { AutoUpdateConfig } from "@shared/types.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import {
  DEFAULT_AUTO_UPDATE_CONFIG,
  normalizeAutoUpdateConfig,
  validateAutoUpdateConfig,
} from "./autoUpdateConfig.ts";
import { refreshAllAutoUpdateNextRuns } from "./autoUpdateState.ts";

const SETTING_KEY = "settings.autoUpdate";

export function readGlobalAutoUpdate(): AutoUpdateConfig {
  const raw = db.select().from(schema.setting).where(eq(schema.setting.key, SETTING_KEY)).get()?.value;
  if (!raw) return { ...DEFAULT_AUTO_UPDATE_CONFIG };
  try {
    return normalizeAutoUpdateConfig(JSON.parse(raw) as Partial<AutoUpdateConfig>);
  } catch {
    return { ...DEFAULT_AUTO_UPDATE_CONFIG };
  }
}

export function writeGlobalAutoUpdate(input: AutoUpdateConfig): AutoUpdateConfig {
  const config = normalizeAutoUpdateConfig(input);
  validateAutoUpdateConfig(config);
  const now = new Date();
  db.insert(schema.setting)
    .values({ key: SETTING_KEY, value: JSON.stringify(config), updatedAt: now })
    .onConflictDoUpdate({
      target: schema.setting.key,
      set: { value: JSON.stringify(config), updatedAt: now },
    })
    .run();
  refreshAllAutoUpdateNextRuns(config);
  return config;
}
