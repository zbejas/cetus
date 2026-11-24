import { getSelfContainerInfo, type SelfContainerInfo } from "./selfContainer.ts";
import { LOCAL_HOST_ID } from "./hosts.ts";

export type { SelfContainerInfo } from "./selfContainer.ts";

let selfInfo: SelfContainerInfo | null = null;
let initialized = false;

export async function initializeSelfInfo() {
  if (initialized) return selfInfo;
  initialized = true;
  selfInfo = await getSelfContainerInfo();
  return selfInfo;
}

export function getSelfInfo() {
  return selfInfo;
}

export function isSelfUpdateTarget(row: { hostId: string; projectName: string }) {
  return row.hostId === LOCAL_HOST_ID && Boolean(selfInfo && selfInfo.project === row.projectName);
}
