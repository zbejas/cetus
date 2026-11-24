import { describe, expect, test } from "bun:test";
import { queueOrderError } from "./updateQueue.ts";

describe("update queue order", () => {
  test("accepts a complete permutation", () => {
    expect(queueOrderError(["b", "a", "c"], ["a", "b", "c"])).toBeNull();
  });

  test("rejects a missing entry", () => {
    expect(queueOrderError(["a", "b"], ["a", "b", "c"])).toContain("changed");
  });

  test("rejects duplicates and unknown ids", () => {
    expect(queueOrderError(["a", "a", "b"], ["a", "b", "c"])).toContain("does not match");
    expect(queueOrderError(["a", "b", "d"], ["a", "b", "c"])).toContain("does not match");
  });
});
