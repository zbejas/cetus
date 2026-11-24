import fs from "node:fs";
import path from "node:path";
import { composePs, docker } from "./docker.ts";
import { loadComposeServices } from "./composeConfig.ts";

export interface AutoUpdateRunConfig {
  services?: string[];
  excludeServices?: string[];
  healthCheck?: boolean;
  rollback?: boolean;
  healthGraceSeconds?: number;
}

export interface AutoUpdateTarget {
  dir: string;
  projectName: string;
  composeFile: string;
}

export interface AutoUpdateResult {
  status: "success" | "failed" | "rolled-back";
  message: string;
}

function isOneShot(name: string, service: Record<string, any>) {
  if (service?.["x-cetus-one-shot"] === true) return true;
  return name.startsWith("init") && service?.restart === "no";
}

function atomicWrite(file: string, content: string) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function snapshotCompose(target: AutoUpdateTarget, content: string) {
  const dir = path.join(target.dir, ".cetus", "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `${stamp}-${target.composeFile}`), content);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAutoUpdate(
  target: AutoUpdateTarget,
  config: AutoUpdateRunConfig,
  emit: (text: string) => void,
): Promise<AutoUpdateResult> {
  const composePath = path.join(target.dir, target.composeFile);
  if (!fs.existsSync(composePath)) {
    emit(`[cetus] Compose file missing: ${composePath}\n`);
    return { status: "failed", message: "Compose file missing." };
  }

  const previousCompose = fs.readFileSync(composePath, "utf8");
  snapshotCompose(target, previousCompose);
  const services = await loadComposeServices(target.dir, target.projectName, target.composeFile);
  const excluded = new Set(config.excludeServices ?? []);
  const selected = (config.services?.length
    ? config.services.filter((name) => services[name])
    : Object.keys(services)
  ).filter((name) => !services[name]?.build && !excluded.has(name));
  if (!selected.length) {
    emit("[cetus] No pullable services selected for auto-update. Locally built images need an external build step.\n");
    return { status: "failed", message: "No pullable services selected." };
  }

  const previousImages = new Map<string, { imageRef: string; imageId: string }>();
  try {
    const rows = await composePs(target.dir, target.projectName);
    for (const serviceName of selected) {
      const row = rows.find((entry) => entry.Service === serviceName);
      const imageRef = row?.Image
        ? String(row.Image)
        : services[serviceName]?.image
          ? String(services[serviceName].image)
          : null;
      if (!row?.ID || !imageRef || imageRef.includes("@sha256:")) continue;
      const inspected = await docker(["inspect", "--format", "{{.Image}}", String(row.ID)], { timeoutMs: 10_000 });
      if (inspected.exitCode === 0) {
        const imageId = inspected.stdout.trim();
        if (imageId) previousImages.set(serviceName, { imageRef, imageId });
      }
    }
  } catch (error) {
    emit(`[cetus] Could not record current images: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const run = async (args: string[], label: string) => {
    emit(`[cetus] $ docker compose -p ${target.projectName} ${args.join(" ")}\n`);
    const proc = Bun.spawn(["docker", "compose", "-p", target.projectName, ...args], {
      cwd: target.dir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const pump = async (stream: ReadableStream<Uint8Array>, prefix = "") => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        emit(prefix + decoder.decode(value, { stream: true }));
      }
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr, "[stderr] ")]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) emit(`[cetus] ${label} exited with code ${exitCode}\n`);
    return exitCode;
  };

  const pullExit = await run(["pull", ...selected], "pull");
  if (pullExit !== 0) {
    return { status: "failed", message: "Image pull failed. Nothing was recreated." };
  }

  const upExit = await run(["up", "-d", "--remove-orphans"], "up");
  if (upExit !== 0) {
    if (config.rollback === false) return { status: "failed", message: "Compose up failed." };
    return rollback(target, previousCompose, previousImages, selected, emit);
  }

  if (config.healthCheck === false) {
    return { status: "success", message: "Images updated and containers recreated." };
  }

  const healthy = await waitForHealth(target, services, selected, config, emit);
  if (healthy) {
    return { status: "success", message: "Images updated and health checks passed." };
  }

  emit("[cetus] Health gate failed after update.\n");
  if (config.rollback === false) {
    return { status: "failed", message: "Health gate failed. Rollback is disabled." };
  }
  return rollback(target, previousCompose, previousImages, selected, emit);
}

async function waitForHealth(
  target: AutoUpdateTarget,
  services: Record<string, any>,
  selected: string[],
  config: AutoUpdateRunConfig,
  emit: (text: string) => void,
) {
  const expected = selected.filter((name) => !isOneShot(name, services[name] ?? {}));
  if (!expected.length) return true;
  const graceMs = Math.max(10, Math.min(600, config.healthGraceSeconds ?? 90)) * 1_000;
  const deadline = Date.now() + graceMs;
  let stableSince = 0;
  emit(`[cetus] Health gate: watching ${expected.join(", ")} for ${Math.round(graceMs / 1000)}s\n`);

  while (Date.now() < deadline) {
    const rows = await composePs(target.dir, target.projectName);
    const states = expected.map((name) => rows.find((row) => row.Service === name));
    const failed = states.find((row) => !row || ["exited", "dead"].includes(String(row.State ?? "").toLowerCase()));
    if (failed) {
      emit(`[cetus] Service failed health gate: ${failed?.Service ?? "unknown"}\n`);
      return false;
    }
    const unhealthy = states.find((row) => String(row?.Health ?? "").toLowerCase() === "unhealthy");
    if (unhealthy) {
      emit(`[cetus] Service reported unhealthy: ${unhealthy.Service}\n`);
      return false;
    }
    const starting = states.some((row) => String(row?.Health ?? "").toLowerCase() === "starting");
    const running = states.every((row) => String(row?.State ?? "").toLowerCase() === "running");
    if (running && !starting) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 5_000) {
        emit("[cetus] Health gate passed.\n");
        return true;
      }
    } else {
      stableSince = 0;
    }
    await sleep(2_000);
  }

  emit("[cetus] Health gate timed out.\n");
  return false;
}

async function rollback(
  target: AutoUpdateTarget,
  previousCompose: string,
  previousImages: Map<string, { imageRef: string; imageId: string }>,
  selected: string[],
  emit: (text: string) => void,
): Promise<AutoUpdateResult> {
  emit("[cetus] Rolling back to the previous compose file and image IDs.\n");
  atomicWrite(path.join(target.dir, target.composeFile), previousCompose);

  for (const [service, image] of previousImages) {
    if (!selected.includes(service)) continue;
    const tagged = await docker(["tag", image.imageId, image.imageRef], { timeoutMs: 15_000 });
    if (tagged.exitCode === 0) {
      emit(`[cetus] Restored ${image.imageRef} for ${service}.\n`);
    } else {
      emit(`[cetus] Could not restore ${image.imageRef}: ${tagged.stderr.trim()}\n`);
    }
  }

  const proc = Bun.spawn(["docker", "compose", "-p", target.projectName, "up", "-d", "--remove-orphans", "--force-recreate"], {
    cwd: target.dir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const pump = async (stream: ReadableStream<Uint8Array>, prefix = "") => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      emit(prefix + decoder.decode(value, { stream: true }));
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr, "[stderr] ")]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    emit("[cetus] Rollback failed.\n");
    return { status: "failed", message: "Update failed and rollback did not complete." };
  }
  emit("[cetus] Rollback completed. The previous compose file is running again.\n");
  return { status: "rolled-back", message: "Health gate failed. Rolled back to the previous compose and image IDs." };
}
