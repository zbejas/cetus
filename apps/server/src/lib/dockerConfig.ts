import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DockerConfigFile {
  auths?: Record<string, unknown>;
  credsStore?: string;
  credHelpers?: Record<string, string>;
}

const cache = new Map<string, { mtimeMs: number; config: DockerConfigFile }>();

export function ambientDockerConfigPath(managedDir: string) {
  const explicit = process.env.CETUS_HOST_DOCKER_CONFIG;
  if (explicit) return explicit;
  const envDir = process.env.DOCKER_CONFIG;
  if (envDir && path.resolve(envDir) !== path.resolve(managedDir)) return path.join(envDir, "config.json");
  return path.join(os.homedir(), ".docker", "config.json");
}

export function readAmbientDockerConfig(managedDir: string): DockerConfigFile {
  const file = ambientDockerConfigPath(managedDir);
  try {
    const stat = fs.statSync(file);
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.config;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DockerConfigFile;
    const config: DockerConfigFile = {
      auths: parsed.auths && typeof parsed.auths === "object" ? parsed.auths : undefined,
      credsStore: typeof parsed.credsStore === "string" ? parsed.credsStore : undefined,
      credHelpers: parsed.credHelpers && typeof parsed.credHelpers === "object" ? parsed.credHelpers : undefined,
    };
    cache.set(file, { mtimeMs: stat.mtimeMs, config });
    return config;
  } catch {
    return {};
  }
}

export function mergeDockerConfig(ambient: DockerConfigFile, managed: DockerConfigFile): DockerConfigFile {
  const merged: DockerConfigFile = {
    auths: { ...(ambient.auths ?? {}), ...(managed.auths ?? {}) },
  };
  if (ambient.credsStore) merged.credsStore = ambient.credsStore;
  if (ambient.credHelpers || managed.credHelpers) {
    merged.credHelpers = { ...(ambient.credHelpers ?? {}), ...(managed.credHelpers ?? {}) };
  }
  return merged;
}

export function writeDockerConfig(dir: string, config: DockerConfigFile) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "config.json");
  const temp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  process.env.DOCKER_CONFIG = dir;
}
