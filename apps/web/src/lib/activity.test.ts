import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "@shared/types";
import { groupRepeatedActivity } from "./activity.ts";

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: crypto.randomUUID(),
    actorType: "user",
    actorName: "Zbejas",
    action: "delete",
    resourceType: "stack",
    resourceId: null,
    hostId: null,
    stackId: null,
    metadata: null,
    ip: null,
    createdAt: "2026-01-01T04:00:00.000Z",
    ...overrides,
  };
}

describe("activity grouping", () => {
  test("collapses consecutive matching entries inside the window", () => {
    const groups = groupRepeatedActivity([
      entry({ createdAt: "2026-01-01T04:00:30.000Z" }),
      entry({ createdAt: "2026-01-01T04:00:20.000Z" }),
      entry({ createdAt: "2026-01-01T04:00:10.000Z" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].latestAt).toBe("2026-01-01T04:00:30.000Z");
  });

  test("collapses matching entries even when another event is interleaved", () => {
    const groups = groupRepeatedActivity([
      entry({ createdAt: "2026-01-01T04:00:30.000Z" }),
      entry({ action: "instance.ready", resourceType: "instance", createdAt: "2026-01-01T04:00:25.000Z" }),
      entry({ createdAt: "2026-01-01T04:00:20.000Z" }),
      entry({ createdAt: "2026-01-01T04:00:10.000Z" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].count).toBe(3);
    expect(groups[1].entry.action).toBe("instance.ready");
  });

  test("starts a new group outside the window", () => {
    const groups = groupRepeatedActivity([
      entry({ createdAt: "2026-01-01T04:10:00.000Z" }),
      entry({ createdAt: "2026-01-01T04:00:00.000Z" }),
    ], 60_000);
    expect(groups).toHaveLength(2);
  });

  test("does not group across a different action, actor, or resource", () => {
    const groups = groupRepeatedActivity([
      entry({ action: "delete" }),
      entry({ action: "save" }),
      entry({ actorName: "Someone else" }),
      entry({ resourceType: "instance" }),
    ]);
    expect(groups.map((group) => group.count)).toEqual([1, 1, 1, 1]);
  });
});
