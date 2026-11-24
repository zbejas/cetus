import fs from "node:fs";
import path from "node:path";
import type { UpdateCheckResult, UpdateCheckService } from "@shared/types.ts";
import { composePs, docker } from "./docker.ts";
import { loadComposeServices } from "./composeConfig.ts";

export interface UpdateCheckTarget {
  dir: string;
  projectName: string;
  composeFile: string;
}

function extractDigests(text: string): string[] {
  const matches = text.match(/sha256:[a-f0-9]{64}/gi) ?? [];
  return [...new Set(matches.map((value) => value.toLowerCase()))];
}

export function hasDigestUpdate(local: string[], remote: string | null): boolean {
  return Boolean(remote && local.length > 0 && !local.includes(remote));
}

function shortError(text: string | undefined): string {
  if (!text) return "Registry lookup failed.";
  const line = text.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "Registry lookup failed.";
  return line.length > 240 ? `${line.slice(0, 240)}...` : line;
}

async function localDigests(imageRef: string, containerId: string | null): Promise<string[]> {
  if (containerId) {
    const inspected = await docker(["inspect", "--format", "{{.Image}}", containerId], { timeoutMs: 10_000 });
    const imageId = inspected.stdout.trim();
    if (inspected.exitCode === 0 && imageId) {
      const byId = await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", imageId], { timeoutMs: 10_000 });
      if (byId.exitCode === 0) return extractDigests(byId.stdout);
    }
  }
  const byRef = await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", imageRef], { timeoutMs: 10_000 });
  if (byRef.exitCode !== 0) return [];
  return extractDigests(byRef.stdout);
}

const remoteCache = new Map<string, { at: number; value: { digest: string | null; error?: string } }>();
const REMOTE_CACHE_TTL_MS = 10 * 60 * 1_000;

async function remoteDigest(imageRef: string): Promise<{ digest: string | null; error?: string }> {
  const cached = remoteCache.get(imageRef);
  if (cached && Date.now() - cached.at < REMOTE_CACHE_TTL_MS) return cached.value;

  const result = await docker(
    ["buildx", "imagetools", "inspect", imageRef, "--format", "{{json .Manifest}}"],
    { timeoutMs: 30_000 },
  );
  let value: { digest: string | null; error?: string };
  if (result.exitCode !== 0) {
    const message = shortError(result.stderr || result.stdout);
    if (/unknown command|not a docker command|buildx/i.test(message)) {
      value = { digest: null, error: "Registry digest lookup requires the Docker buildx plugin." };
    } else if (/429|too many requests/i.test(message)) {
      value = { digest: null, error: "Registry rate limit reached. Authenticate the Docker CLI or retry later." };
    } else {
      value = { digest: null, error: message };
    }
  } else {
    try {
      const manifest = JSON.parse(result.stdout) as { digest?: string };
      const digest = typeof manifest.digest === "string" ? manifest.digest.toLowerCase() : null;
      value = { digest, error: digest ? undefined : "Registry returned no manifest digest." };
    } catch {
      value = { digest: null, error: "Could not parse the registry manifest response." };
    }
  }
  remoteCache.set(imageRef, { at: Date.now(), value });
  return value;
}

export async function checkComposeUpdates(target: UpdateCheckTarget): Promise<UpdateCheckResult> {
  const composePath = path.join(target.dir, target.composeFile);
  const checkedAt = new Date().toISOString();
  if (!fs.existsSync(composePath)) {
    return {
      checkedAt,
      available: false,
      services: [{
        service: "compose",
        image: target.composeFile,
        currentDigest: null,
        latestDigest: null,
        updateAvailable: false,
        error: "Compose file is missing on the host.",
      }],
    };
  }

  const services = await loadComposeServices(target.dir, target.projectName, target.composeFile);
  const psRows = await composePs(target.dir, target.projectName);
  const psByService = new Map<string, Record<string, any>>();
  for (const row of psRows) {
    const name = String(row.Service ?? "");
    if (name) psByService.set(name, row);
  }

  const results: UpdateCheckService[] = [];
  for (const [name, definition] of Object.entries(services)) {
    const imageRef = String(definition?.image ?? "").trim();
    if (!imageRef) {
      if (definition?.build) continue;
      results.push({
        service: name,
        image: "unknown",
        currentDigest: null,
        latestDigest: null,
        updateAvailable: false,
        error: "Service does not define an image.",
      });
      continue;
    }

    const pinned = imageRef.match(/@(sha256:[a-f0-9]{64})$/i);
    if (pinned) {
      results.push({
        service: name,
        image: imageRef,
        currentDigest: pinned[1].toLowerCase(),
        latestDigest: pinned[1].toLowerCase(),
        updateAvailable: false,
      });
      continue;
    }

    if (definition?.build) {
      results.push({
        service: name,
        image: imageRef,
        currentDigest: null,
        latestDigest: null,
        updateAvailable: false,
        error: "Image is built from a local Dockerfile. Registry checks are skipped.",
      });
      continue;
    }

    const psRow = psByService.get(name);
    const containerId = psRow?.ID ? String(psRow.ID) : null;
    const local = await localDigests(imageRef, containerId);
    const remote = await remoteDigest(imageRef);
    const currentDigest = local[0] ?? null;
    const hasLocal = local.length > 0;
    const updateAvailable = hasDigestUpdate(local, remote.digest);
    let error = remote.error;
    if (!error && !hasLocal) error = "Image is not present on the host yet.";

    results.push({
      service: name,
      image: imageRef,
      currentDigest,
      latestDigest: remote.digest,
      updateAvailable,
      ...(error ? { error } : {}),
    });
  }

  return {
    checkedAt,
    available: results.some((service) => service.updateAvailable),
    services: results,
  };
}

export function summarizeUpdateCheck(result: UpdateCheckResult): string {
  if (!result.available) return "All checked images are current.";
  const count = result.services.filter((service) => service.updateAvailable).length;
  return `${count} image${count === 1 ? "" : "s"} behind the registry.`;
}
