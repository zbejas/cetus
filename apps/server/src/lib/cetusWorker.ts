export function isCetusWorkerStackName(name: string, projectName?: string | null) {
  return name === "cetus-worker" || projectName === "cetus-worker";
}
