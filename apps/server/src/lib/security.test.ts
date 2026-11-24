import { describe, expect, test } from "bun:test";
import type { Actor } from "@shared/types.ts";
import { actorCanTarget } from "./security.ts";

const user: Actor = { type: "user", id: "user-1", name: "Admin", role: "admin", scopes: ["*"] };
const key: Actor = { type: "key", id: "key-1", name: "CI", role: "key", scopes: ["stacks:read"], keyId: "key-1" };
const none = { hostIds: [], stackIds: [] };

describe("api key targets", () => {
  test("user actors are never narrowed", () => {
    expect(actorCanTarget(user, { hostId: "host-a", stackId: null }, none)).toBe(true);
  });

  test("keys without targets see every target", () => {
    expect(actorCanTarget(key, { hostId: "host-a", stackId: "stack-a" }, none)).toBe(true);
    expect(actorCanTarget(key, { hostId: null, stackId: null }, none)).toBe(true);
  });

  test("host targets require the host", () => {
    const restrictions = { hostIds: ["host-a"], stackIds: [] };
    expect(actorCanTarget(key, { hostId: "host-a", stackId: null }, restrictions)).toBe(true);
    expect(actorCanTarget(key, { hostId: "host-b", stackId: null }, restrictions)).toBe(false);
    expect(actorCanTarget(key, { hostId: null, stackId: null }, restrictions)).toBe(false);
  });

  test("stack targets require the stack", () => {
    const restrictions = { hostIds: [], stackIds: ["stack-a"] };
    expect(actorCanTarget(key, { hostId: "host-a", stackId: "stack-a" }, restrictions)).toBe(true);
    expect(actorCanTarget(key, { hostId: "host-a", stackId: "stack-b" }, restrictions)).toBe(false);
    expect(actorCanTarget(key, { hostId: "host-a", stackId: null }, restrictions)).toBe(false);
  });

  test("both targets must match", () => {
    const restrictions = { hostIds: ["host-a"], stackIds: ["stack-a"] };
    expect(actorCanTarget(key, { hostId: "host-a", stackId: "stack-a" }, restrictions)).toBe(true);
    expect(actorCanTarget(key, { hostId: "host-b", stackId: "stack-a" }, restrictions)).toBe(false);
    expect(actorCanTarget(key, { hostId: "host-a", stackId: "stack-b" }, restrictions)).toBe(false);
  });
});
