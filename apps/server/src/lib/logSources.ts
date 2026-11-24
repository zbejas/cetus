import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { listContainers } from "./docker.ts";
import { getRemoteInventory } from "./remote.ts";
import type { HostSummary, LogSource } from "@shared/types.ts";

function containerName(names: string) {
  return names.split(",")[0]?.trim().replace(/^\//, "") || "container";
}

export async function listLogSources(hosts: HostSummary[]): Promise<LogSource[]> {
  const stacks = db.select({
    id: schema.stack.id,
    hostId: schema.stack.hostId,
    name: schema.stack.name,
    projectName: schema.stack.projectName,
  }).from(schema.stack).all();
  const stackByProject = new Map(stacks.map((stack) => [`${stack.hostId}:${stack.projectName}`, stack]));

  const sources: LogSource[] = [];
  for (const host of hosts) {
    const containers = host.kind === "local"
      ? await listContainers()
      : getRemoteInventory(host.id)?.containers ?? [];
    for (const container of containers) {
      if (!container.id) continue;
      const stack = container.project ? stackByProject.get(`${host.id}:${container.project}`) : undefined;
      sources.push({
        id: container.id,
        name: containerName(container.names),
        names: container.names,
        image: container.image,
        state: container.state,
        status: container.status,
        project: container.project,
        service: container.service,
        unmanaged: container.unmanaged,
        hostId: host.id,
        hostName: host.name,
        hostKind: host.kind,
        stackId: stack?.id ?? null,
        stackName: stack?.name ?? container.project,
        running: container.state === "running",
      });
    }
  }

  return sources.sort((a, b) => {
    if (a.hostName !== b.hostName) return a.hostName.localeCompare(b.hostName);
    if (a.running !== b.running) return a.running ? -1 : 1;
    if ((a.project ?? "") !== (b.project ?? "")) return (a.project ?? "").localeCompare(b.project ?? "");
    return a.name.localeCompare(b.name);
  });
}
