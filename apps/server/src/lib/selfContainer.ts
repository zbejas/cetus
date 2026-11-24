import os from "node:os";
import { docker } from "./docker.ts";

export interface SelfContainerInfo {
  containerId: string;
  imageRef: string;
  project: string;
  service: string;
}

export async function getSelfContainerInfo(): Promise<SelfContainerInfo | null> {
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
  return {
    containerId,
    imageRef,
    project,
    service,
  };
}
