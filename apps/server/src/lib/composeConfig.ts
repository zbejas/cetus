import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { docker } from "./docker.ts";

export async function loadComposeServices(
  dir: string,
  projectName: string,
  composeFile: string,
): Promise<Record<string, any>> {
  const resolved = await docker(
    ["compose", "-p", projectName, "config", "--format", "json"],
    { cwd: dir, timeoutMs: 20_000 },
  );
  if (resolved.exitCode === 0) {
    try {
      const parsed = JSON.parse(resolved.stdout) as { services?: Record<string, any> };
      if (parsed.services && typeof parsed.services === "object") return parsed.services;
    } catch {
      // Fall through to the raw YAML.
    }
  }

  try {
    const parsed = YAML.parse(fs.readFileSync(path.join(dir, composeFile), "utf8")) ?? {};
    return (parsed.services ?? {}) as Record<string, any>;
  } catch {
    return {};
  }
}
