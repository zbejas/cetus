import { describe, expect, test } from "bun:test";
import { ALL_SCOPES, ADMIN_SCOPES, OPERATOR_SCOPES, ROLE_SCOPES, hasAllScopes, hasAnyScope, hasScope } from "./scopes.ts";

describe("scopes", () => {
  test("admin has every scope", () => {
    for (const scope of ALL_SCOPES) expect(hasScope(ADMIN_SCOPES, scope)).toBe(true);
  });

  test("viewer cannot deploy", () => {
    expect(hasScope(ROLE_SCOPES.viewer, "stacks:read")).toBe(true);
    expect(hasScope(ROLE_SCOPES.viewer, "stacks:deploy")).toBe(false);
  });

  test("operator can deploy but cannot manage users", () => {
    expect(hasScope(OPERATOR_SCOPES, "stacks:deploy")).toBe(true);
    expect(hasScope(OPERATOR_SCOPES, "users:write")).toBe(false);
  });

  test("wildcard scope works", () => {
    expect(hasScope(["*"], "anything:at:all")).toBe(true);
    expect(hasAnyScope(["*"], ["stacks:read"])).toBe(true);
    expect(hasAllScopes(["*"], ["stacks:read", "keys:write"])).toBe(true);
  });
});
