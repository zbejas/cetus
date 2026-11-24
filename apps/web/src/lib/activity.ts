import type { AuditEntry } from "@shared/types";

export const ACTIVITY_GROUP_WINDOW_MS = 5 * 60 * 1_000;

export interface ActivityGroup {
  entry: AuditEntry;
  count: number;
  latestAt: string;
}

function sameActivity(left: AuditEntry, right: AuditEntry) {
  return left.action === right.action
    && left.actorName === right.actorName
    && left.resourceType === right.resourceType;
}

export function groupRepeatedActivity(
  entries: AuditEntry[],
  windowMs = ACTIVITY_GROUP_WINDOW_MS,
): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const entry of entries) {
    const entryAt = Date.parse(entry.createdAt);
    const group = groups.find((candidate) => {
      if (!sameActivity(candidate.entry, entry)) return false;
      const newestAt = Date.parse(candidate.entry.createdAt);
      return Number.isFinite(newestAt) && Number.isFinite(entryAt) && newestAt - entryAt <= windowMs;
    });
    if (group) {
      group.count += 1;
      if (entryAt > Date.parse(group.latestAt)) group.latestAt = entry.createdAt;
      continue;
    }
    groups.push({ entry, count: 1, latestAt: entry.createdAt });
  }
  return groups;
}
