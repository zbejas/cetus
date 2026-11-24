import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import {
  getDiskUsage,
  getDockerInfo,
  getStats,
  getSystemDf,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
} from "./docker.ts";
import type { HostInventory, HostSummary } from "@shared/types.ts";
import { config } from "../config.ts";
import { getRemoteHost, getRemoteInventory } from "./remote.ts";

export const LOCAL_HOST_ID = "host-local";

type HostRow = typeof schema.host.$inferSelect;

export function hostRowToSummary(row: HostRow, counts?: {
  stacks?: number;
  running?: number;
  containers?: number;
  images?: number;
  cpuUsage?: number | null;
  memoryUsed?: number | null;
  diskUsed?: number | null;
  diskTotal?: number | null;
}): HostSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    dockerVersion: row.dockerVersion,
    os: row.os,
    arch: row.arch,
    cpus: row.cpus,
    memory: row.memory,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    stackCount: counts?.stacks ?? 0,
    runningStacks: counts?.running ?? 0,
    containerCount: counts?.containers ?? 0,
    imageCount: counts?.images ?? 0,
    cpuUsage: counts?.cpuUsage ?? null,
    memoryUsed: counts?.memoryUsed ?? null,
    diskUsed: counts?.diskUsed ?? null,
    diskTotal: counts?.diskTotal ?? null,
  };
}

async function localMetrics() {
  const [stats, disk] = await Promise.all([getStats(), getDiskUsage()]);
  let cpu = 0;
  let memoryUsed = 0;
  for (const sample of stats.values()) {
    cpu += sample.cpu;
    memoryUsed += sample.memoryUsed;
  }
  return {
    cpuUsage: cpu,
    memoryUsed,
    diskUsed: disk?.used ?? null,
    diskTotal: disk?.total ?? null,
  };
}

export async function ensureLocalHost(): Promise<HostRow> {
  const info = await getDockerInfo();
  config.dockerDetected = Boolean(info);
  const now = new Date();
  const values = {
    name: "core",
    slug: "core",
    kind: "local" as const,
    status: (info ? "online" : "offline") as "online" | "offline",
    dockerVersion: info?.serverVersion ?? null,
    os: info?.os ?? null,
    arch: info?.architecture ?? null,
    cpus: info?.cpus ?? null,
    memory: info?.memory ?? null,
    info: info ? JSON.stringify(info) : null,
    lastSeenAt: now,
  };

  const existing = db.select().from(schema.host).where(eq(schema.host.id, LOCAL_HOST_ID)).get();
  if (existing) {
    db.update(schema.host).set(values).where(eq(schema.host.id, LOCAL_HOST_ID)).run();
    return { ...existing, ...values };
  }

  db.insert(schema.host).values({
    id: LOCAL_HOST_ID,
    ...values,
    labels: "{}",
    createdAt: now,
  }).run();

  return db.select().from(schema.host).where(eq(schema.host.id, LOCAL_HOST_ID)).get()!;
}

export function getHostRow(id: string): HostRow | null {
  return db.select().from(schema.host).where(eq(schema.host.id, id)).get() ?? null;
}

export function listHostRows(): HostRow[] {
  return db.select().from(schema.host).all();
}

export function getHostCounts(hostId: string) {
  const stackCount = Number(
    db.select({ count: sql<number>`count(*)` }).from(schema.stack).where(eq(schema.stack.hostId, hostId)).get()?.count ?? 0,
  );
  const running = Number(
    db.select({ count: sql<number>`count(*)` }).from(schema.stack)
      .where(sql`${schema.stack.hostId} = ${hostId} AND ${schema.stack.status} = 'running'`)
      .get()?.count ?? 0,
  );
  return { stacks: stackCount, running };
}

export async function listHosts(): Promise<HostSummary[]> {
  const rows = listHostRows();
  const containers = await listContainers();
  const images = await listImages();
  const metrics = rows.some((row) => row.kind === "local") ? await localMetrics() : null;
  return rows.map((row) => {
    const counts = getHostCounts(row.id);
    const isLocal = row.kind === "local";
    const cpuCount = row.cpus ?? 1;
    const remote = !isLocal ? getRemoteHost(row.id) : null;
    return hostRowToSummary(row, {
      ...counts,
      containers: isLocal ? containers.length : remote?.inventory?.containers.length ?? 0,
      images: isLocal ? images.length : remote?.inventory?.images.length ?? 0,
      cpuUsage: isLocal && metrics ? Math.min(100, metrics.cpuUsage / cpuCount) : remote?.inventory?.host.cpuUsage ?? null,
      memoryUsed: isLocal ? metrics?.memoryUsed ?? null : remote?.inventory?.host.memoryUsed ?? null,
      diskUsed: isLocal ? metrics?.diskUsed ?? null : remote?.inventory?.host.diskUsed ?? null,
      diskTotal: isLocal ? metrics?.diskTotal ?? null : remote?.inventory?.host.diskTotal ?? null,
    });
  });
}

export async function getHostSummary(id: string): Promise<HostSummary | null> {
  const row = getHostRow(id);
  if (!row) return null;
  const counts = getHostCounts(id);
  if (row.kind === "local") {
    const [containers, images, metrics] = await Promise.all([listContainers(), listImages(), localMetrics()]);
    return hostRowToSummary(row, {
      ...counts,
      containers: containers.length,
      images: images.length,
      cpuUsage: Math.min(100, metrics.cpuUsage / (row.cpus ?? 1)),
      memoryUsed: metrics.memoryUsed,
      diskUsed: metrics.diskUsed,
      diskTotal: metrics.diskTotal,
    });
  }
  const remote = getRemoteHost(id);
  return hostRowToSummary(row, {
    ...counts,
    containers: remote?.inventory?.containers.length ?? 0,
    images: remote?.inventory?.images.length ?? 0,
    cpuUsage: remote?.inventory?.host.cpuUsage ?? null,
    memoryUsed: remote?.inventory?.host.memoryUsed ?? null,
    diskUsed: remote?.inventory?.host.diskUsed ?? null,
    diskTotal: remote?.inventory?.host.diskTotal ?? null,
  });
}

export async function getHostInventory(id: string): Promise<HostInventory | null> {
  const row = getHostRow(id);
  if (!row) return null;
  const summary = await getHostSummary(id);
  if (!summary) return null;

  if (row.kind !== "local") {
    return getRemoteInventory(row.id) ?? {
      host: summary,
      info: null,
      containers: [],
      images: [],
      volumes: [],
      networks: [],
      df: [],
      disk: null,
    };
  }

  const [info, containers, images, volumes, networks, df, disk] = await Promise.all([
    getDockerInfo(),
    listContainers(),
    listImages(),
    listVolumes(),
    listNetworks(),
    getSystemDf(),
    getDiskUsage(),
  ]);

  return { host: summary, info, containers, images, volumes, networks, df, disk };
}
