import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { UpdateCheckResult } from "@shared/types.ts";
import { checkComposeUpdates } from "./updateCheck.ts";
import { requestWorkerUpdateCheck } from "./remote.ts";

type StackRow = typeof schema.stack.$inferSelect;
type HostRow = typeof schema.host.$inferSelect;

function keyFor(stackId: string) {
  return `updatecheck:${stackId}`;
}

export function readUpdateCheck(stackId: string): UpdateCheckResult | null {
  const raw = db.select().from(schema.setting).where(eq(schema.setting.key, keyFor(stackId))).get()?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UpdateCheckResult;
  } catch {
    return null;
  }
}

const UPDATE_CHECK_PREFIX = "updatecheck:";

export function listUpdateChecks(): Map<string, UpdateCheckResult> {
  const map = new Map<string, UpdateCheckResult>();
  const rows = db.select().from(schema.setting)
    .where(and(
      gte(schema.setting.key, UPDATE_CHECK_PREFIX),
      lt(schema.setting.key, `${UPDATE_CHECK_PREFIX};`),
    ))
    .all();
  for (const row of rows) {
    try {
      map.set(row.key.slice(UPDATE_CHECK_PREFIX.length), JSON.parse(row.value) as UpdateCheckResult);
    } catch {
      // Ignore a corrupt cached check; the next check replaces it.
    }
  }
  return map;
}

function mergeWithPrevious(stackId: string, next: UpdateCheckResult): UpdateCheckResult {
  const previous = readUpdateCheck(stackId);
  if (!previous) return next;
  return {
    ...next,
    services: next.services.map((service) => {
      if (!service.error) return service;
      const prior = previous.services.find((entry) => entry.service === service.service);
      if (!prior) return service;
      return {
        ...service,
        currentDigest: service.currentDigest ?? prior.currentDigest,
        latestDigest: service.latestDigest ?? prior.latestDigest,
        updateAvailable: service.latestDigest ? service.updateAvailable : prior.updateAvailable,
      };
    }),
  };
}

export function writeUpdateCheck(stackId: string, result: UpdateCheckResult) {
  const now = new Date();
  db.insert(schema.setting)
    .values({ key: keyFor(stackId), value: JSON.stringify(result), updatedAt: now })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: JSON.stringify(result), updatedAt: now } })
    .run();
}

export function clearUpdateCheck(stackId: string) {
  db.delete(schema.setting).where(eq(schema.setting.key, keyFor(stackId))).run();
}

export function pendingUpdateServices(
  stackId: string,
  config?: { services?: string[]; excludeServices?: string[] } | null,
): string[] | null {
  const check = readUpdateCheck(stackId);
  if (!check) return null;
  const selected = config?.services?.length ? new Set(config.services) : null;
  const excluded = new Set(config?.excludeServices ?? []);
  const names = new Set<string>();
  for (const service of check.services) {
    if (!service.updateAvailable || !service.latestDigest || service.error) continue;
    if (selected && !selected.has(service.service)) continue;
    if (excluded.has(service.service)) continue;
    names.add(service.service);
  }
  return [...names];
}

export function markAutoUpdateApplied(stackId: string, services?: string[], excludeServices?: string[]) {
  const check = readUpdateCheck(stackId);
  if (!check) return;
  const selected = services?.length ? new Set(services) : null;
  const excluded = new Set(excludeServices ?? []);
  const next: UpdateCheckResult = {
    ...check,
    checkedAt: new Date().toISOString(),
    services: check.services.map((service) => {
      if (selected && !selected.has(service.service)) return service;
      if (excluded.has(service.service)) return service;
      if (!service.latestDigest) return service;
      return {
        ...service,
        currentDigest: service.latestDigest,
        updateAvailable: false,
        error: undefined,
      };
    }),
  };
  next.available = next.services.some((service) => service.updateAvailable);
  writeUpdateCheck(stackId, next);
}

export interface StackUpdateCheckOutcome {
  stackId: string;
  stackName: string;
  result: UpdateCheckResult | null;
  error?: string;
}

function hostFor(stack: StackRow): HostRow | null {
  return db.select().from(schema.host).where(eq(schema.host.id, stack.hostId)).get() ?? null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function checkStacksForUpdates(stacks: StackRow[]): Promise<StackUpdateCheckOutcome[]> {
  const local: StackRow[] = [];
  const byWorker = new Map<string, StackRow[]>();
  const outcomes: StackUpdateCheckOutcome[] = [];

  for (const stack of stacks) {
    const host = hostFor(stack);
    if (host?.kind === "worker") {
      const list = byWorker.get(stack.hostId) ?? [];
      list.push(stack);
      byWorker.set(stack.hostId, list);
    } else {
      local.push(stack);
    }
  }

  const localOutcomes = await mapLimit(local, 4, async (stack): Promise<StackUpdateCheckOutcome> => {
    try {
      const result = await checkComposeUpdates({
        dir: stack.dir,
        projectName: stack.projectName,
        composeFile: stack.composeFile,
      });
      const merged = mergeWithPrevious(stack.id, result);
      writeUpdateCheck(stack.id, merged);
      return { stackId: stack.id, stackName: stack.name, result: merged };
    } catch (error) {
      return {
        stackId: stack.id,
        stackName: stack.name,
        result: null,
        error: error instanceof Error ? error.message : "Update check failed.",
      };
    }
  });
  outcomes.push(...localOutcomes);

  await Promise.all([...byWorker.entries()].map(async ([hostId, workerStacks]) => {
    try {
      const results = await requestWorkerUpdateCheck(hostId, workerStacks.map((stack) => ({
        name: stack.name,
        composeFile: stack.composeFile,
        projectName: stack.projectName,
      })));
      const byName = new Map(results.map((entry) => [String(entry.stackName ?? ""), entry]));
      for (const stack of workerStacks) {
        const entry = byName.get(stack.name);
        if (!entry) {
          outcomes.push({ stackId: stack.id, stackName: stack.name, result: null, error: "Worker did not return a result for this stack." });
          continue;
        }
        const result = entry.result as UpdateCheckResult | undefined;
        if (!result || !Array.isArray(result.services)) {
          outcomes.push({ stackId: stack.id, stackName: stack.name, result: null, error: "Worker returned an invalid result." });
          continue;
        }
        const merged = mergeWithPrevious(stack.id, result);
        writeUpdateCheck(stack.id, merged);
        outcomes.push({ stackId: stack.id, stackName: stack.name, result: merged });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker update check failed.";
      for (const stack of workerStacks) {
        outcomes.push({ stackId: stack.id, stackName: stack.name, result: null, error: message });
      }
    }
  }));

  return outcomes;
}

export async function checkStackForUpdates(stack: StackRow): Promise<UpdateCheckResult> {
  const [outcome] = await checkStacksForUpdates([stack]);
  if (!outcome?.result) throw new Error(outcome?.error ?? "Update check failed.");
  return outcome.result;
}
