import { describe, expect, test } from "bun:test";
import { hasDigestUpdate } from "./updateCheck.ts";

const current = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const latest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("update digest comparison", () => {
  test("reports an update when the remote digest is not local", () => {
    expect(hasDigestUpdate([current], latest)).toBe(true);
  });

  test("stays current when any local repo digest matches the registry", () => {
    expect(hasDigestUpdate([current, latest], latest)).toBe(false);
  });

  test("does not guess when the registry or local digest is missing", () => {
    expect(hasDigestUpdate([], latest)).toBe(false);
    expect(hasDigestUpdate([current], null)).toBe(false);
  });
});
