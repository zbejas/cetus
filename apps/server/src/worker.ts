import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { HostInventory, HostSummary, ServiceState, StackMetadata, StackStatus } from "@shared/types.ts";
import {
  composePs,
  docker,
  getDiskUsage,
  getDockerInfo,
  getStats,
  getSystemDf,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  refreshStats,
  startStatsSampler,
} from "./lib/docker.ts";
import { runAutoUpdate } from "./lib/autoUpdateRunner.ts";
import { checkComposeUpdates, clearRemoteDigestCache } from "./lib/updateCheck.ts";
import { config } from "./config.ts";
import { getSelfContainerInfo, type SelfContainerInfo } from "./lib/selfContainer.ts";
import { mergeDockerConfig, readAmbientDockerConfig, writeDockerConfig } from "./lib/dockerConfig.ts";
import {
  buildSelfUpdateScript,
  removeSelfUpdateTag,
  selfUpdateBackupTag,
  startSelfUpdateHelper,
} from "./lib/selfUpdate.ts";

const managerUrl = process.env.CETUS_MANAGER_URL ?? "ws://127.0.0.1:3000/api/ws/worker";
const enrollToken = process.env.CETUS_ENROLL_TOKEN;
const workerName = process.env.CETUS_WORKER_NAME ?? `worker-${crypto.randomUUID().slice(0, 6)}`;
const stacksDir = path.resolve(process.env.CETUS_WORKER_STACKS_DIR ?? "/opt/stacks");
const dataDir = path.resolve(process.env.CETUS_WORKER_DATA_DIR ?? "./data-worker");
const trashDir = path.join(dataDir, "trash");
const dockerConfigDir = path.join(dataDir, "docker");
const credentialFile = path.join(dataDir, "worker.json");
const composeNames = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

fs.mkdirSync(stacksDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(trashDir, { recursive: true });
fs.mkdirSync(dockerConfigDir, { recursive: true, mode: 0o700 });
process.env.DOCKER_CONFIG = dockerConfigDir;

const selfInfo: SelfContainerInfo | null = await getSelfContainerInfo();
const selfUpdateFile = path.join(dataDir, "self-update.json");
let latestRegistryAuth: { auths?: Record<string, unknown> } = { auths: {} };
await refreshStats();
startStatsSampler();

interface PendingSelfUpdate {
  operationId: string;
  helperName: string;
  backupTag: string;
  statusFile: string;
  logFile: string;
  startedAt: number;
  deadline: number;
}

interface StoredCredential {
  hostId: string;
  secret: string;
}

function readCredential(): StoredCredential | null {
  try {
    return JSON.parse(fs.readFileSync(credentialFile, "utf8")) as StoredCredential;
  } catch {
    return null;
  }
}

function saveCredential(credential: StoredCredential) {
  fs.writeFileSync(credentialFile, JSON.stringify(credential, null, 2), { mode: 0o600 });
}

function findCompose(dir: string) {
  for (const name of composeNames) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

function oneShot(name: string, service: Record<string, any>) {
  return service?.["x-cetus-one-shot"] === true || (name.startsWith("init") && service?.restart === "no");
}

function computeStatus(services: ServiceState[]): StackStatus {
  if (services.length === 0) return "created";
  const expected = services.filter((service) => !service.oneShot);
  const relevant = expected.length > 0 ? expected : services;
  const running = relevant.filter((service) => service.state === "running" || service.state === "restarting").length;
  const unhealthy = relevant.some((service) => (service.state === "running" || service.state === "restarting") && service.health === "unhealthy");
  if (running === relevant.length) return unhealthy ? "partial" : "running";
  if (running > 0) return "partial";
  if (relevant.every((service) => service.state === "exited" || service.state === "dead")) return "stopped";
  return "created";
}

function portsFromPs(ps: Record<string, any> | undefined): ServiceState["ports"] {
  const publishers = ps?.Publishers;
  if (!Array.isArray(publishers)) return [];
  const seen = new Set<string>();
  return publishers
    .filter((publisher: any) => Number(publisher.PublishedPort) > 0)
    .filter((publisher: any) => {
      const key = `${publisher.PublishedPort}:${publisher.TargetPort}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((publisher: any) => ({
      published: String(publisher.PublishedPort),
      target: String(publisher.TargetPort),
      protocol: publisher.Protocol ?? "tcp",
      url: `http://localhost:${publisher.PublishedPort}`,
    }));
}

async function scanStacks() {
  const stacks = [];
  for (const entry of fs.readdirSync(stacksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(stacksDir, entry.name);
    const composeFile = findCompose(dir);
    if (!composeFile) continue;
    const compose = fs.readFileSync(path.join(dir, composeFile), "utf8");
    let parsed: any = {};
    try { parsed = YAML.parse(compose) ?? {}; } catch { parsed = {}; }
    const metadata: StackMetadata = fs.existsSync(path.join(dir, "cetus.json"))
      ? JSON.parse(fs.readFileSync(path.join(dir, "cetus.json"), "utf8"))
      : {};
    const projectName = metadata.projectName ?? entry.name;
    const psRows = await composePs(dir, projectName);
    const byService = new Map<string, Record<string, any>>();
    for (const ps of psRows) byService.set(String(ps.Service ?? ""), ps);
    const stats = await getStats();
    const services: ServiceState[] = Object.entries(parsed.services ?? {}).map(([name, definition]: [string, any]) => {
      const ps = byService.get(name);
      const containerName = String(ps?.Names ?? "");
      const stat = stats.get(containerName);
      const health = String(ps?.Health ?? "").toLowerCase();
      return {
        name,
        image: String(definition?.image ?? ps?.Image ?? "unknown"),
        state: (String(ps?.State ?? "created").toLowerCase() as ServiceState["state"]) ?? "unknown",
        health: health === "healthy" || health === "unhealthy" || health === "starting" ? health : "none",
        status: String(ps?.Status ?? "Not created"),
        ports: portsFromPs(ps),
        containerId: ps?.ID ? String(ps.ID) : null,
        containerName: containerName || null,
        cpu: stat?.cpu ?? null,
        memoryUsed: stat?.memoryUsed ?? null,
        memoryLimit: stat?.memoryLimit ?? null,
        uptime: ps?.RunningFor ? String(ps.RunningFor) : null,
        oneShot: oneShot(name, definition ?? {}),
      };
    });
    stacks.push({
      name: entry.name,
      dir,
      composeFile,
      projectName,
      status: computeStatus(services),
      displayName: metadata.displayName,
      description: metadata.description,
      tags: metadata.tags,
      metadata,
      compose,
      env: fs.existsSync(path.join(dir, ".env")) ? fs.readFileSync(path.join(dir, ".env"), "utf8") : "",
      services,
      profiles: [...new Set(Object.values(parsed.services ?? {}).flatMap((service: any) => service?.profiles ?? []).map(String))],
    });
  }
  return stacks;
}

async function buildInventory(stacks: Awaited<ReturnType<typeof scanStacks>>): Promise<HostInventory> {
  const [info, containers, images, volumes, networks, df, disk, stats] = await Promise.all([
    getDockerInfo(),
    listContainers(),
    listImages(),
    listVolumes(),
    listNetworks(),
    getSystemDf(),
    getDiskUsage(),
    getStats(),
  ]);
  let cpu = 0;
  let memoryUsed = 0;
  for (const sample of stats.values()) {
    cpu += sample.cpu;
    memoryUsed += sample.memoryUsed;
  }
  const host: HostSummary = {
    id: "worker",
    name: workerName,
    slug: workerName,
    kind: "worker",
    status: "online",
    cetusVersion: config.version,
    workerUpdateAvailable: false,
    workerUpdateSupported: Boolean(selfInfo),
    dockerVersion: info?.serverVersion ?? null,
    os: info?.os ?? null,
    arch: info?.architecture ?? null,
    cpus: info?.cpus ?? null,
    memory: info?.memory ?? null,
    lastSeenAt: new Date().toISOString(),
    stackCount: stacks.length,
    runningStacks: stacks.filter((stack) => stack.status === "running").length,
    containerCount: containers.length,
    imageCount: images.length,
    cpuUsage: info?.cpus ? Math.min(100, cpu / info.cpus) : null,
    memoryUsed,
    diskUsed: disk?.used ?? null,
    diskTotal: disk?.total ?? null,
  };
  return { host, info, containers, images, volumes, networks, df, disk };
}

let socket: WebSocket | null = null;
let enrolled = false;
let hostId: string | null = null;
let secret: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function send(payload: Record<string, unknown>) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

async function sendSnapshot() {
  if (!enrolled) return;
  try {
    const info = await getDockerInfo();
    const stacks = await scanStacks();
    const inventory = await buildInventory(stacks);
    send({
      type: "snapshot",
      name: workerName,
      info: {
        dockerVersion: info?.serverVersion ?? null,
        os: info?.os ?? null,
        arch: info?.architecture ?? null,
        cpus: info?.cpus ?? null,
        memory: info?.memory ?? null,
        cetusVersion: config.version,
        selfUpdateSupported: Boolean(selfInfo),
      },
      stacks,
      inventory,
    });
  } catch (error) {
    console.error("[cetus-worker] snapshot failed", error);
  }
}

async function runCompose(projectName: string, stackName: string, operationId: string, args: string[]) {
  const dir = path.join(stacksDir, stackName);
  const proc = Bun.spawn(["docker", "compose", "-p", projectName, ...args], {
    cwd: dir,
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
      send({ type: "operation.output", operationId, text: prefix + decoder.decode(value, { stream: true }) });
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr, "[stderr] ")]);
  return proc.exited;
}

function snapshotStackFiles(stackName: string) {
  const dir = path.join(stacksDir, stackName);
  const composeFile = findCompose(dir);
  if (!composeFile) return;
  const snapshotDir = path.join(dir, ".cetus", "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(
    path.join(dir, composeFile),
    path.join(snapshotDir, `${stamp}-${composeFile}`),
  );
}

function moveStackToTrash(stackName: string) {
  const source = path.join(stacksDir, stackName);
  const target = path.join(trashDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${stackName}`);
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
  return target;
}

async function handleCommand(message: any) {
  const operationId = String(message.operationId);
  const stackName = String(message.stackName);
  const projectName = String(message.projectName ?? message.stackName);
  const appendLog = (text: string) => send({ type: "operation.output", operationId, text });
  try {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(stackName)) {
      throw new Error("Stack name is not valid.");
    }
    const args = Array.isArray(message.args) ? message.args.map(String) : [];
    if (message.action === "delete") snapshotStackFiles(stackName);
    appendLog(`[cetus] $ docker compose -p ${projectName} ${args.join(" ")}\n`);
    let exitCode = await runCompose(projectName, stackName, operationId, args);
    if (exitCode === 0 && Array.isArray(message.argsAfter) && message.argsAfter.length > 0) {
      appendLog(`[cetus] $ docker compose -p ${projectName} ${message.argsAfter.join(" ")}\n`);
      exitCode = await runCompose(projectName, stackName, operationId, message.argsAfter.map(String));
    }
    if (exitCode === 0 && message.action === "delete") {
      const target = moveStackToTrash(stackName);
      appendLog(`\n[cetus] Moved stack to ${target}\n`);
    }
    send({
      type: "operation.finished",
      operationId,
      status: exitCode === 0 ? "success" : "failed",
      exitCode,
      deployed: message.action === "deploy" || message.action === "update" || message.action === "start",
    });
    await sendSnapshot();
  } catch (error) {
    appendLog(`[cetus] ${error instanceof Error ? error.message : String(error)}\n`);
    send({ type: "operation.finished", operationId, status: "failed", exitCode: 1 });
  }
}

async function handleContainerAction(message: any) {
  const requestId = String(message.requestId);
  const containerId = String(message.containerId ?? "");
  const action = String(message.action ?? "");
  const allowed = new Set(["start", "stop", "restart", "pause", "unpause", "remove"]);
  try {
    if (!containerId || !allowed.has(action)) {
      throw new Error("Unsupported container action.");
    }
    const inspect = await docker([
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      containerId,
    ], { timeoutMs: 15_000 });
    if (inspect.exitCode !== 0) throw new Error(inspect.stderr || "Container was not found.");
    let labels: Record<string, string> = {};
    try {
      labels = JSON.parse(inspect.stdout.trim() || "{}");
    } catch {
      labels = {};
    }
    if (!labels["com.docker.compose.project"]) {
      send({
        type: "container.actioned",
        requestId,
        error: "Standalone containers outside Compose stacks are read-only.",
        code: "unmanaged",
      });
      return;
    }
    const result = await docker(action === "remove" ? ["rm", "-f", containerId] : [action, containerId], {
      timeoutMs: 45_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Docker action failed.");
    await sendSnapshot();
    send({
      type: "container.actioned",
      requestId,
      output: `${result.stdout}${result.stderr}`,
    });
  } catch (error) {
    send({
      type: "container.actioned",
      requestId,
      error: error instanceof Error ? error.message : "Container action failed.",
      code: "action_failed",
    });
  }
}

function hashText(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function atomicWrite(file: string, content: string) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function handleComposeWrite(message: any) {
  const requestId = String(message.requestId);
  try {
    const stackName = String(message.stackName ?? "");
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(stackName)) {
      throw new Error("Stack name is not valid.");
    }
    const dir = path.join(stacksDir, stackName);
    if (!dir.startsWith(`${stacksDir}${path.sep}`)) {
      throw new Error("Stack path is outside the stacks directory.");
    }
    fs.mkdirSync(dir, { recursive: true });
    const composeFile = findCompose(dir) ?? "compose.yaml";
    const composePath = path.join(dir, composeFile);
    const envPath = path.join(dir, ".env");
    const currentCompose = fs.existsSync(composePath) ? fs.readFileSync(composePath, "utf8") : "";
    const currentEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

    if (message.baseHash && hashText(currentCompose) !== String(message.baseHash)) {
      send({
        type: "compose.written",
        requestId,
        error: "The compose file changed on disk. Review the difference and save again.",
        code: "conflict",
      });
      return;
    }

    const nextCompose = message.compose !== undefined ? String(message.compose) : currentCompose;
    const nextEnv = message.env !== undefined ? String(message.env) : currentEnv;

    if (message.compose !== undefined) {
      let parsed: any;
      try {
        parsed = YAML.parse(nextCompose);
      } catch {
        throw new Error("Compose is not valid YAML.");
      }
      if (!parsed || typeof parsed !== "object" || !parsed.services || typeof parsed.services !== "object") {
        throw new Error("Compose must define services.");
      }
      const snapshotDir = path.join(dir, ".cetus", "snapshots");
      fs.mkdirSync(snapshotDir, { recursive: true });
      if (fs.existsSync(composePath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(path.join(snapshotDir, `${stamp}-${composeFile}`), currentCompose);
      }
      atomicWrite(composePath, nextCompose);
    }

    if (message.env !== undefined) {
      atomicWrite(envPath, nextEnv);
    }

    send({
      type: "compose.written",
      requestId,
      compose: nextCompose,
      env: nextEnv,
      composeHash: hashText(nextCompose),
      envHash: hashText(nextEnv),
    });
    void sendSnapshot();
  } catch (error) {
    send({
      type: "compose.written",
      requestId,
      error: error instanceof Error ? error.message : "Compose write failed.",
      code: "write_failed",
    });
  }
}

function applyRegistryAuth(message: any) {
  try {
    latestRegistryAuth = message.config && typeof message.config === "object"
      ? message.config as { auths?: Record<string, unknown> }
      : { auths: {} };
    refreshRegistryAuth();
    clearRemoteDigestCache();
  } catch (error) {
    console.error("[cetus-worker] could not apply registry credentials", error);
  }
}

function refreshRegistryAuth() {
  writeDockerConfig(
    dockerConfigDir,
    mergeDockerConfig(readAmbientDockerConfig(dockerConfigDir), latestRegistryAuth),
  );
}

function handleMetadataWrite(message: any) {
  const requestId = String(message.requestId);
  try {
    const dir = path.join(stacksDir, String(message.stackName));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cetus.json"), `${JSON.stringify(message.metadata ?? {}, null, 2)}\n`);
    send({ type: "metadata.written", requestId });
    void sendSnapshot();
  } catch (error) {
    send({
      type: "metadata.written",
      requestId,
      error: error instanceof Error ? error.message : "Metadata write failed",
    });
  }
}

async function handleUpdateCheck(message: any) {
  const requestId = String(message.requestId);
  refreshRegistryAuth();
  try {
    const results = [];
    for (const entry of message.stacks ?? []) {
      const name = String(entry.name);
      const result = await checkComposeUpdates({
        dir: path.join(stacksDir, name),
        projectName: String(entry.projectName ?? name),
        composeFile: String(entry.composeFile ?? "compose.yaml"),
      });
      results.push({ stackName: name, result });
    }
    send({ type: "update-check.result", requestId, results });
  } catch (error) {
    send({
      type: "update-check.result",
      requestId,
      error: error instanceof Error ? error.message : "Update check failed.",
    });
  }
}

async function handleAutoUpdateCommand(message: any) {
  const operationId = String(message.operationId);
  const stackName = String(message.stackName);
  const projectName = String(message.projectName ?? stackName);
  const dir = path.join(stacksDir, stackName);
  refreshRegistryAuth();
  try {
    const result = await runAutoUpdate(
      {
        dir,
        projectName,
        composeFile: String(message.composeFile ?? "compose.yaml"),
      },
      message.config ?? {},
      (text) => send({ type: "operation.output", operationId, text }),
    );
    send({
      type: "operation.finished",
      operationId,
      status: result.status === "success" ? "success" : "failed",
      exitCode: result.status === "success" ? 0 : 1,
      deployed: result.status === "success",
      autoUpdateStatus: result.status,
      rateLimited: result.rateLimited === true,
    });
    await sendSnapshot();
  } catch (error) {
    send({ type: "operation.output", operationId, text: `[cetus] ${error instanceof Error ? error.message : String(error)}\n` });
    send({ type: "operation.finished", operationId, status: "failed", exitCode: 1, autoUpdateStatus: "failed" });
  }
}

function readPendingSelfUpdate(): PendingSelfUpdate | null {
  try {
    return JSON.parse(fs.readFileSync(selfUpdateFile, "utf8")) as PendingSelfUpdate;
  } catch {
    return null;
  }
}

function writePendingSelfUpdate(pending: PendingSelfUpdate) {
  const temp = `${selfUpdateFile}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, selfUpdateFile);
}

function clearPendingSelfUpdate(pending: PendingSelfUpdate) {
  removeSelfUpdateTag(pending.backupTag);
  fs.rmSync(selfUpdateFile, { force: true });
  fs.rmSync(pending.statusFile, { force: true });
  fs.rmSync(pending.logFile, { force: true });
}

function finishWorkerSelfUpdate(pending: PendingSelfUpdate, status: "success" | "failed", exitCode: number) {
  if (socket?.readyState !== WebSocket.OPEN || !enrolled) return false;
  try {
    const log = fs.existsSync(pending.logFile) ? fs.readFileSync(pending.logFile, "utf8") : "";
    if (log) {
      send({
        type: "operation.output",
        operationId: pending.operationId,
        text: log.length > 300_000 ? log.slice(log.length - 300_000) : log,
      });
    }
  } catch {
    // The status is still useful even when the helper log is unavailable.
  }
  send({
    type: "operation.finished",
    operationId: pending.operationId,
    status,
    exitCode,
    deployed: status === "success",
    autoUpdateStatus: status,
  });
  clearPendingSelfUpdate(pending);
  void sendSnapshot();
  return true;
}

async function reconcileWorkerSelfUpdate() {
  const pending = readPendingSelfUpdate();
  if (!pending) return;
  while (Date.now() < pending.deadline) {
    if (fs.existsSync(pending.statusFile)) {
      let result: { status?: string; exitCode?: number } = {};
      try {
        result = JSON.parse(fs.readFileSync(pending.statusFile, "utf8"));
      } catch {
        result = {};
      }
      if (result.status === "success" || result.status === "failed") {
        finishWorkerSelfUpdate(
          pending,
          result.status === "success" ? "success" : "failed",
          typeof result.exitCode === "number" ? result.exitCode : result.status === "success" ? 0 : 1,
        );
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  finishWorkerSelfUpdate(pending, "failed", 1);
}

function handleWorkerSelfUpdate(message: any) {
  const operationId = String(message.operationId ?? "");
  const stackName = String(message.stackName ?? "");
  const projectName = String(message.projectName ?? stackName);
  const composeFile = String(message.composeFile ?? "compose.yaml");
  if (!operationId || !stackName || !selfInfo) {
    send({ type: "operation.finished", operationId, status: "failed", exitCode: 1, autoUpdateStatus: "failed" });
    return;
  }
  const existing = readPendingSelfUpdate();
  if (existing) {
    send({ type: "operation.output", operationId, text: "[cetus] Another worker self-update is already in progress.\n" });
    send({ type: "operation.finished", operationId, status: "failed", exitCode: 1, autoUpdateStatus: "failed" });
    return;
  }
  const dir = path.join(stacksDir, stackName);
  if (!fs.existsSync(path.join(dir, composeFile))) {
    send({ type: "operation.output", operationId, text: `[cetus] Worker compose file is missing: ${dir}/${composeFile}\n` });
    send({ type: "operation.finished", operationId, status: "failed", exitCode: 1, autoUpdateStatus: "failed" });
    return;
  }

  const healthGraceSeconds = Math.max(10, Math.min(600, Number(message.config?.healthGraceSeconds ?? 90) || 90));
  const statusFile = path.join(dataDir, `self-update-${operationId}.json`);
  const logFile = path.join(dataDir, `self-update-${operationId}.log`);
  const helperName = `cetus-worker-self-update-${operationId}`;
  const backupTag = selfUpdateBackupTag(operationId);
  const pending: PendingSelfUpdate = {
    operationId,
    helperName,
    backupTag,
    statusFile,
    logFile,
    startedAt: Date.now(),
    deadline: Date.now() + (healthGraceSeconds + 180) * 1_000,
  };
  writePendingSelfUpdate(pending);

  const composeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => key.startsWith("CETUS_") && value !== undefined) as Array<[string, string]>,
  );
  const result = startSelfUpdateHelper({
    helperName,
    containerId: selfInfo.containerId,
    imageRef: selfInfo.imageRef,
    dockerConfig: dockerConfigDir,
    env: composeEnv,
    script: buildSelfUpdateScript({
      operationId,
      containerId: selfInfo.containerId,
      dir,
      projectName,
      serviceName: selfInfo.service,
      imageRef: selfInfo.imageRef,
      backupTag,
      statusFile,
      logFile,
      services: Array.isArray(message.config?.services) ? message.config.services.map(String) : undefined,
      healthGraceSeconds,
    }),
  });

  if (!result.ok) {
    send({ type: "operation.output", operationId, text: `[cetus] Worker self-update helper failed to start: ${result.error}\n` });
    send({ type: "operation.finished", operationId, status: "failed", exitCode: 1, autoUpdateStatus: "failed" });
    clearPendingSelfUpdate(pending);
    return;
  }
  send({
    type: "operation.output",
    operationId,
    text: "[cetus] Worker update continues in a detached helper container. The worker will reconnect when the new container is healthy.\n",
  });
  void reconcileWorkerSelfUpdate();
}

async function handleLogsRequest(message: any) {
  try {
    const tail = String(message.tail ?? 200);
    const timestampArgs = message.timestamps ? ["--timestamps"] : [];
    if (message.containerId) {
      const result = await docker(["logs", "--tail", tail, ...timestampArgs, String(message.containerId)], { timeoutMs: 15_000 });
      send({ type: "logs.response", requestId: message.requestId, text: `${result.stdout}${result.stderr}` });
      return;
    }
    const dir = path.join(stacksDir, String(message.stackName));
    const result = await docker(["compose", "-p", String(message.projectName ?? message.stackName), "logs", "--no-color", "--tail", tail, ...timestampArgs], {
      cwd: dir,
      timeoutMs: 15_000,
    });
    send({ type: "logs.response", requestId: message.requestId, text: `${result.stdout}${result.stderr}` });
  } catch (error) {
    send({ type: "logs.response", requestId: message.requestId, error: error instanceof Error ? error.message : "Log request failed" });
  }
}

const logStreams = new Map<string, ReturnType<typeof Bun.spawn>>();

function stopLogStream(requestId: string) {
  const proc = logStreams.get(requestId);
  if (!proc) return;
  logStreams.delete(requestId);
  try { proc.kill(); } catch { /* already gone */ }
}

function startLogStream(requestId: string, proc: ReturnType<typeof Bun.spawn>, kind: "container" | "stack") {
  logStreams.set(requestId, proc);

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        send({ type: `${kind}.logs.chunk`, requestId, text: decoder.decode(value, { stream: true }) });
      }
    }
  };

  Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array>),
    pump(proc.stderr as ReadableStream<Uint8Array>),
  ])
    .then(() => {
      logStreams.delete(requestId);
      send({ type: `${kind}.logs.end`, requestId });
    })
    .catch((error) => {
      logStreams.delete(requestId);
      send({
        type: `${kind}.logs.error`,
        requestId,
        error: error instanceof Error ? error.message : `${kind === "stack" ? "Stack" : "Container"} log stream failed`,
      });
    });
}

function handleContainerLogStart(message: any) {
  const requestId = String(message.requestId);
  if (!requestId || logStreams.has(requestId)) return;
  const containerId = String(message.containerId ?? "");
  if (!containerId) {
    send({ type: "container.logs.end", requestId });
    return;
  }
  const tail = String(Math.max(0, Math.min(Number(message.tail ?? 500), 5_000)));
  const timestampArgs = message.timestamps === false ? [] : ["--timestamps"];
  const proc = Bun.spawn(["docker", "logs", "-f", "--tail", tail, ...timestampArgs, containerId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  startLogStream(requestId, proc, "container");
}

function handleStackLogStart(message: any) {
  const requestId = String(message.requestId);
  if (!requestId || logStreams.has(requestId)) return;
  const stackName = String(message.stackName ?? "");
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(stackName)) {
    send({ type: "stack.logs.error", requestId, error: "Stack name is not valid." });
    return;
  }
  const projectName = String(message.projectName ?? stackName);
  const tail = String(Math.max(0, Math.min(Number(message.tail ?? 500), 5_000)));
  const timestampArgs = message.timestamps === false ? [] : ["--timestamps"];
  const proc = Bun.spawn([
    "docker",
    "compose",
    "-p",
    projectName,
    "logs",
    "-f",
    "--tail",
    tail,
    "--no-color",
    ...timestampArgs,
  ], {
    cwd: path.join(stacksDir, stackName),
    stdout: "pipe",
    stderr: "pipe",
  });
  startLogStream(requestId, proc, "stack");
}

function stopAllLogStreams() {
  for (const requestId of [...logStreams.keys()]) stopLogStream(requestId);
}

function connect() {
  const stored = readCredential();
  if (stored) {
    hostId = stored.hostId;
    secret = stored.secret;
  }

  const ws = new WebSocket(managerUrl);
  socket = ws;

  ws.addEventListener("open", () => {
    console.log(`[cetus-worker] connected to ${managerUrl}`);
    send({
      type: "hello",
      token: hostId && secret ? undefined : enrollToken,
      hostId,
      secret,
      name: workerName,
      info: {},
    });
  });

  ws.addEventListener("message", (event) => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type === "enrolled") {
      enrolled = true;
      hostId = message.hostId;
      if (message.secret) {
        secret = message.secret;
        saveCredential({ hostId: message.hostId, secret: message.secret });
      }
      console.log(`[cetus-worker] enrolled as ${message.hostId}`);
      void sendSnapshot();
      void reconcileWorkerSelfUpdate();
      return;
    }
    if (message.type === "command") {
      void handleCommand(message);
      return;
    }
    if (message.type === "auto-update") {
      void handleAutoUpdateCommand(message);
      return;
    }
    if (message.type === "compose.write") {
      handleComposeWrite(message);
      return;
    }
    if (message.type === "container.action") {
      void handleContainerAction(message);
      return;
    }
    if (message.type === "registry.auth") {
      applyRegistryAuth(message);
      return;
    }
    if (message.type === "worker.self-update") {
      handleWorkerSelfUpdate(message);
      return;
    }
    if (message.type === "metadata.write") {
      handleMetadataWrite(message);
      return;
    }
    if (message.type === "update-check") {
      void handleUpdateCheck(message);
      return;
    }
    if (message.type === "logs.request") {
      void handleLogsRequest(message);
      return;
    }
    if (message.type === "container.logs.start") {
      handleContainerLogStart(message);
      return;
    }
    if (message.type === "container.logs.stop") {
      stopLogStream(String(message.requestId));
      return;
    }
    if (message.type === "stack.logs.start") {
      handleStackLogStart(message);
      return;
    }
    if (message.type === "stack.logs.stop") {
      stopLogStream(String(message.requestId));
      return;
    }
    if (message.type === "snapshot.request") {
      void sendSnapshot();
      return;
    }
    if (message.type === "error") {
      console.error("[cetus-worker] manager error:", message.message);
    }
  });

  ws.addEventListener("close", () => {
    enrolled = false;
    stopAllLogStreams();
    console.log("[cetus-worker] disconnected; reconnecting in 5s");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5_000);
  });

  ws.addEventListener("error", (error) => {
    console.error("[cetus-worker] socket error", error);
  });
}

setInterval(() => {
  if (enrolled) {
    send({ type: "heartbeat" });
    void sendSnapshot();
  }
}, 15_000);

connect();
