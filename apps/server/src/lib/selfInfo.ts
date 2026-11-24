import os from "node:os";
import { docker } from "./docker.ts";
import { LOCAL_HOST_ID } from "./hosts.ts";

export interface SelfContainerInfo {
  containerId: string;
  imageRef: string;
  project: string;
  service: string;
}

let selfInfo: SelfContainerInfo | null = null;
let initialized = false;

export async function initializeSelfInfo() {
  if (initialized) return selfInfo;
  initialized = true;
  const containerId = os.hostname();
  const inspect = await docker(
    ["inspect", "--format", "{{json .Config.Labels}}\n{{.Config.Image}}", containerId],
    { timeoutMs: 10_000 },
  );
  if (inspect.exitCode !== 0) return null;
  const [rawLabels, rawImageRef] = inspect.stdout.trim().split("\n");
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(rawLabels || "{}");
  } catch {
    return null;
  }
  const project = labels["com.docker.compose.project"];
  const service = labels["com.docker.compose.service"];
  const imageRef = (rawImageRef ?? "").trim();
  if (!project || !service || !imageRef) return null;
  selfInfo = {
    containerId,
    imageRef,
    project,
    service,
  };
  return selfInfo;
}

export function getSelfInfo() {
  return selfInfo;
}

export function isSelfUpdateTarget(row: { hostId: string; projectName: string }) {
  return row.hostId === LOCAL_HOST_ID && Boolean(selfInfo && selfInfo.project === row.projectName);
}
