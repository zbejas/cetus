import type {
  DockerContainer,
  DockerDfRow,
  DockerImage,
  DockerInfo,
  DockerNetwork,
  DockerVolume,
} from "@shared/types.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs ?? 20_000);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  if (timedOut) {
    return {
      stdout,
      stderr: `${stderr}\nCommand timed out after ${options.timeoutMs ?? 20_000}ms`,
      exitCode: exitCode || 124,
    };
  }

  return { stdout, stderr, exitCode };
}

export async function docker(args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
  return runCommand(["docker", ...args], options);
}

export function parseJsonLines<T = Record<string, unknown>>(text: string): T[] {
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        rows.push(...parsed);
      } else {
        rows.push(parsed);
      }
    } catch {
      // ignore non-JSON compose warnings
    }
  }
  return rows;
}

export function parseJsonArray<T = Record<string, unknown>>(text: string): T[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return parseJsonLines<T>(text);
  }
}

export function parseLabels(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  const result: Record<string, string> = {};
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index)] = part.slice(index + 1);
  }
  return result;
}

export async function getDockerInfo(): Promise<DockerInfo | null> {
  const [result, versionResult] = await Promise.all([
    docker(["info", "--format", "{{json .}}"], { timeoutMs: 15_000 }),
    docker(["version", "--format", "{{.Server.APIVersion}}"], { timeoutMs: 10_000 }),
  ]);
  if (result.exitCode !== 0) return null;
  try {
    const raw = JSON.parse(result.stdout);
    return {
      serverVersion: raw.ServerVersion ?? "unknown",
      apiVersion: versionResult.stdout.trim() || raw.APIVersion || "unknown",
      os: raw.OperatingSystem ?? "unknown",
      kernel: raw.KernelVersion ?? "unknown",
      architecture: raw.Architecture ?? "unknown",
      cpus: raw.NCPU ?? 0,
      memory: raw.MemTotal ?? 0,
      dockerRootDir: raw.DockerRootDir ?? "",
      driver: raw.Driver ?? "",
      containers: raw.Containers ?? 0,
      containersRunning: raw.ContainersRunning ?? 0,
      containersPaused: raw.ContainersPaused ?? 0,
      containersStopped: raw.ContainersStopped ?? 0,
      images: raw.Images ?? 0,
      warnings: raw.Warnings ?? null,
    };
  } catch {
    return null;
  }
}

let containersCache: { at: number; value: Promise<DockerContainer[]> } | null = null;

export function invalidateContainerCache() {
  containersCache = null;
}

export async function listContainers(force = false): Promise<DockerContainer[]> {
  if (!force && containersCache && Date.now() - containersCache.at < 1_500) {
    return containersCache.value;
  }
  const value = (async () => {
    const result = await docker(["ps", "-a", "--no-trunc", "--format", "{{json .}}"], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) return [];
    return parseJsonLines<Record<string, any>>(result.stdout).map((row) => {
      const labels = parseLabels(row.Labels);
      return {
        id: row.ID ?? "",
        names: row.Names ?? "",
        image: row.Image ?? "",
        state: row.State ?? "unknown",
        status: row.Status ?? "",
        ports: row.Ports ?? "",
        createdAt: row.CreatedAt ?? "",
        runningFor: row.RunningFor ?? "",
        labels,
        project: labels["com.docker.compose.project"] ?? null,
        service: labels["com.docker.compose.service"] ?? null,
        unmanaged: !labels["com.docker.compose.project"],
      };
    });
  })();
  containersCache = { at: Date.now(), value };
  return value;
}

export async function listImages(): Promise<DockerImage[]> {
  const result = await docker(["images", "--format", "{{json .}}"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) return [];
  return parseJsonLines<Record<string, any>>(result.stdout)
    .filter((row) => row.Repository !== "<none>")
    .map((row) => ({
      repository: row.Repository ?? "",
      tag: row.Tag ?? "",
      id: row.ID ?? "",
      digest: row.Digest && row.Digest !== "<none>" ? row.Digest : null,
      size: row.Size ?? "",
      createdSince: row.CreatedSince ?? "",
      createdAt: row.CreatedAt ?? "",
    }));
}

export async function listVolumes(): Promise<DockerVolume[]> {
  const result = await docker(["volume", "ls", "--format", "{{json .}}"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) return [];
  return parseJsonLines<Record<string, any>>(result.stdout).map((row) => ({
    name: row.Name ?? "",
    driver: row.Driver ?? "",
    mountpoint: row.Mountpoint ?? "",
    scope: row.Scope ?? "",
    createdAt: row.CreatedAt ?? "",
  }));
}

export async function listNetworks(): Promise<DockerNetwork[]> {
  const result = await docker(["network", "ls", "--format", "{{json .}}"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) return [];
  return parseJsonLines<Record<string, any>>(result.stdout).map((row) => ({
    id: row.ID ?? "",
    name: row.Name ?? "",
    driver: row.Driver ?? "",
    scope: row.Scope ?? "",
    ipv6: String(row.IPv6) === "true",
    internal: String(row.Internal) === "true",
    createdAt: row.CreatedAt ?? "",
  }));
}

export async function getSystemDf(): Promise<DockerDfRow[]> {
  const result = await docker(["system", "df", "--format", "{{json .}}"], { timeoutMs: 20_000 });
  if (result.exitCode !== 0) return [];
  return parseJsonLines<Record<string, any>>(result.stdout).map((row) => ({
    type: row.Type ?? "",
    totalCount: String(row.TotalCount ?? "0"),
    active: String(row.Active ?? "0"),
    size: row.Size ?? "",
    reclaimable: row.Reclaimable ?? "",
  }));
}

export async function getDiskUsage(): Promise<{ used: number; total: number; available: number } | null> {
  const result = await runCommand(["df", "-Pk", "/var/lib/docker"], { timeoutMs: 5_000 });
  if (result.exitCode !== 0) {
    const fallback = await runCommand(["df", "-Pk", "/"], { timeoutMs: 5_000 });
    if (fallback.exitCode !== 0) return null;
    return parseDf(fallback.stdout);
  }
  return parseDf(result.stdout);
}

function parseDf(output: string) {
  const line = output.trim().split("\n").at(-1);
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 4) return null;
  return {
    total: Number(parts[1]) * 1024,
    used: Number(parts[2]) * 1024,
    available: Number(parts[3]) * 1024,
  };
}

type StatsMap = Map<string, { cpu: number; memoryUsed: number; memoryLimit: number }>;

let statsCache: { at: number; map: StatsMap } | null = null;
let statsRefresh: Promise<void> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;

export async function refreshStats(): Promise<void> {
  if (statsRefresh) return statsRefresh;
  statsRefresh = (async () => {
    try {
      const result = await docker(["stats", "--no-stream", "--format", "{{json .}}"], { timeoutMs: 15_000 });
      if (result.exitCode !== 0) return;
      const map: StatsMap = new Map();
      for (const row of parseJsonLines<Record<string, any>>(result.stdout)) {
        const name = row.Name ?? row.Container ?? "";
        if (!name) continue;
        const cpu = Number.parseFloat(String(row.CPUPerc ?? "0").replace("%", "")) || 0;
        const [usedRaw, limitRaw] = String(row.MemUsage ?? "0B / 0B").split(" / ");
        map.set(name, {
          cpu,
          memoryUsed: parseBytes(usedRaw),
          memoryLimit: parseBytes(limitRaw),
        });
      }
      statsCache = { at: Date.now(), map };
    } finally {
      statsRefresh = null;
    }
  })();
  return statsRefresh;
}

export function startStatsSampler(intervalMs = 5_000) {
  if (statsTimer) return;
  void refreshStats();
  statsTimer = setInterval(() => {
    void refreshStats();
  }, intervalMs);
  statsTimer.unref?.();
}

export async function getStats(): Promise<StatsMap> {
  if (statsCache && Date.now() - statsCache.at < 15_000) return statsCache.map;
  void refreshStats();
  return statsCache?.map ?? new Map();
}

export function parseBytes(value: string | undefined): number {
  if (!value) return 0;
  const match = value.trim().match(/^([\d.]+)\s*([KMGTPE]?i?B)$/i);
  if (!match) return Number.parseFloat(value) || 0;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const powers: Record<string, number> = {
    B: 1,
    KB: 1000,
    KIB: 1024,
    MB: 1_000_000,
    MIB: 1024 ** 2,
    GB: 1_000_000_000,
    GIB: 1024 ** 3,
    TB: 1_000_000_000_000,
    TIB: 1024 ** 4,
  };
  return Math.round(amount * (powers[unit] ?? 1));
}

export async function composePs(cwd: string, project: string): Promise<Record<string, any>[]> {
  const result = await docker([
    "compose",
    "-p",
    project,
    "ps",
    "--all",
    "--format",
    "json",
  ], { cwd, timeoutMs: 20_000 });
  if (result.exitCode !== 0) return [];
  return parseJsonArray<Record<string, any>>(result.stdout);
}

export async function composeLogs(cwd: string, project: string, tail = 200, timestamps = false): Promise<string> {
  const result = await docker([
    "compose",
    "-p",
    project,
    "logs",
    "--no-color",
    "--tail",
    String(tail),
    ...(timestamps ? ["--timestamps"] : []),
  ], { cwd, timeoutMs: 20_000 });
  return `${result.stdout}${result.stderr}`;
}

export async function composeLs(): Promise<Record<string, any>[]> {
  const result = await docker(["compose", "ls", "--all", "--format", "json"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) return [];
  return parseJsonArray<Record<string, any>>(result.stdout);
}

export async function findContainerId(project: string, service: string): Promise<string | null> {
  const result = await docker([
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--format",
    "{{.ID}}",
  ], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim().split("\n").filter(Boolean)[0] ?? null;
}
