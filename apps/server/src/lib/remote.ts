import type { HostInventory, ServiceState, StackMetadata, StackStatus } from "@shared/types.ts";

export interface RemoteStackSnapshot {
  name: string;
  dir: string;
  composeFile: string;
  projectName: string;
  status: StackStatus;
  displayName?: string;
  description?: string;
  tags?: string[];
  metadata?: StackMetadata;
  compose: string;
  env: string;
  services: ServiceState[];
  profiles: string[];
}

export interface RemoteHostSnapshot {
  hostId: string;
  name: string;
  info: {
    dockerVersion: string | null;
    os: string | null;
    arch: string | null;
    cpus: number | null;
    memory: number | null;
  };
  stacks: RemoteStackSnapshot[];
  inventory: HostInventory | null;
  lastSeen: number;
  ws: any;
}

const workers = new Map<string, RemoteHostSnapshot>();
const pendingWorkers = new Map<string, any>();
const logRequests = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const metadataRequests = new Map<string, {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
const updateCheckRequests = new Map<string, {
  resolve: (results: Record<string, unknown>[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

export interface RemoteLogStream {
  hostId: string;
  push: (text: string) => void;
  close: () => void;
  fail: (message: string) => void;
}

const remoteLogStreams = new Map<string, RemoteLogStream>();

export function registerRemoteLogStream(requestId: string, stream: RemoteLogStream) {
  remoteLogStreams.set(requestId, stream);
}

export function removeRemoteLogStream(requestId: string) {
  remoteLogStreams.delete(requestId);
}

export function pushRemoteLogChunk(requestId: string, text: string) {
  remoteLogStreams.get(requestId)?.push(text);
}

export function endRemoteLogStream(requestId: string) {
  const stream = remoteLogStreams.get(requestId);
  if (!stream) return;
  remoteLogStreams.delete(requestId);
  stream.close();
}

export function failRemoteLogStream(requestId: string, message: string) {
  const stream = remoteLogStreams.get(requestId);
  if (!stream) return;
  remoteLogStreams.delete(requestId);
  stream.fail(message);
}

export function failRemoteLogStreamsForHost(hostId: string, message: string) {
  for (const [requestId, stream] of remoteLogStreams) {
    if (stream.hostId !== hostId) continue;
    remoteLogStreams.delete(requestId);
    stream.fail(message);
  }
}

export function addPendingWorker(id: string, ws: any) {
  pendingWorkers.set(id, ws);
}

export function getPendingWorker(id: string) {
  return pendingWorkers.get(id) ?? null;
}

export function removePendingWorker(id: string) {
  pendingWorkers.delete(id);
}

export function registerWorker(snapshot: RemoteHostSnapshot) {
  workers.set(snapshot.hostId, snapshot);
}

export function unregisterWorker(hostId: string) {
  workers.delete(hostId);
}

export function getRemoteHost(hostId: string) {
  return workers.get(hostId) ?? null;
}

export function getRemoteStack(hostId: string, name: string) {
  return workers.get(hostId)?.stacks.find((stack) => stack.name === name) ?? null;
}

export function getRemoteInventory(hostId: string) {
  return workers.get(hostId)?.inventory ?? null;
}

export function listRemoteHosts() {
  return [...workers.values()];
}

export function sendToWorker(hostId: string, payload: Record<string, unknown>) {
  const worker = workers.get(hostId);
  if (!worker?.ws) return false;
  try {
    worker.ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function requestWorkerLogs(
  hostId: string,
  stackName: string,
  tail = 200,
  projectName = stackName,
  timestamps = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      logRequests.delete(requestId);
      reject(new Error("Worker did not answer the log request in time."));
    }, 15_000);
    logRequests.set(requestId, { resolve, reject, timer });
    const sent = sendToWorker(hostId, { type: "logs.request", requestId, stackName, projectName, tail, timestamps });
    if (!sent) {
      clearTimeout(timer);
      logRequests.delete(requestId);
      reject(new Error("Worker is not connected."));
    }
  });
}

export function requestWorkerContainerLogs(
  hostId: string,
  containerId: string,
  tail = 200,
  timestamps = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      logRequests.delete(requestId);
      reject(new Error("Worker did not answer the log request in time."));
    }, 15_000);
    logRequests.set(requestId, { resolve, reject, timer });
    const sent = sendToWorker(hostId, { type: "logs.request", requestId, containerId, tail, timestamps });
    if (!sent) {
      clearTimeout(timer);
      logRequests.delete(requestId);
      reject(new Error("Worker is not connected."));
    }
  });
}

export function requestWorkerMetadataWrite(
  hostId: string,
  stackName: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      metadataRequests.delete(requestId);
      reject(new Error("Worker did not acknowledge the metadata write in time."));
    }, 10_000);
    metadataRequests.set(requestId, { resolve, reject, timer });
    const sent = sendToWorker(hostId, { type: "metadata.write", requestId, stackName, metadata });
    if (!sent) {
      clearTimeout(timer);
      metadataRequests.delete(requestId);
      reject(new Error("Worker is not connected."));
    }
  });
}

export function requestWorkerUpdateCheck(
  hostId: string,
  stacks: { name: string; composeFile: string; projectName: string }[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      updateCheckRequests.delete(requestId);
      reject(new Error("Worker did not return update check results in time."));
    }, 5 * 60_000);
    updateCheckRequests.set(requestId, { resolve, reject, timer });
    const sent = sendToWorker(hostId, { type: "update-check", requestId, stacks });
    if (!sent) {
      clearTimeout(timer);
      updateCheckRequests.delete(requestId);
      reject(new Error("Worker is not connected."));
    }
  });
}

export function resolveUpdateCheck(requestId: string, results: Record<string, unknown>[] | null, error: string | null) {
  const request = updateCheckRequests.get(requestId);
  if (!request) return;
  clearTimeout(request.timer);
  updateCheckRequests.delete(requestId);
  if (error || !results) request.reject(new Error(error ?? "Worker update check failed."));
  else request.resolve(results);
}

export function resolveMetadataWrite(requestId: string, error: string | null) {
  const request = metadataRequests.get(requestId);
  if (!request) return;
  clearTimeout(request.timer);
  metadataRequests.delete(requestId);
  if (error) request.reject(new Error(error));
  else request.resolve();
}

export function updateRemoteStackMetadata(hostId: string, stackName: string, metadata: StackMetadata) {
  const stack = workers.get(hostId)?.stacks.find((entry) => entry.name === stackName);
  if (stack) stack.metadata = metadata;
}

export function resolveLogResponse(requestId: string, text: string) {
  const request = logRequests.get(requestId);
  if (!request) return;
  clearTimeout(request.timer);
  logRequests.delete(requestId);
  request.resolve(text);
}

export function rejectLogResponse(requestId: string, error: string) {
  const request = logRequests.get(requestId);
  if (!request) return;
  clearTimeout(request.timer);
  logRequests.delete(requestId);
  request.reject(new Error(error));
}
