import type { Role } from "./types.ts";

export const ALL_SCOPES = [
  "hosts:read",
  "hosts:write",
  "hosts:enroll",
  "stacks:read",
  "stacks:write",
  "stacks:deploy",
  "stacks:delete",
  "containers:read",
  "containers:write",
  "containers:exec",
  "images:read",
  "images:write",
  "images:prune",
  "volumes:read",
  "volumes:write",
  "volumes:prune",
  "networks:read",
  "networks:write",
  "networks:prune",
  "events:read",
  "logs:read",
  "metrics:read",
  "system:prune",
  "terminal:container",
  "updates:read",
  "updates:apply",
  "notifications:read",
  "notifications:write",
  "users:read",
  "users:write",
  "keys:read",
  "keys:write",
  "grants:write",
  "audit:read",
  "audit:export",
  "settings:read",
  "settings:write",
  "secrets:reveal",
  "backup:read",
  "backup:write",
  "mcp:read",
  "mcp:write",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export const VIEWER_SCOPES: Scope[] = [
  "hosts:read",
  "stacks:read",
  "containers:read",
  "images:read",
  "volumes:read",
  "networks:read",
  "events:read",
  "logs:read",
  "metrics:read",
  "updates:read",
  "notifications:read",
];

export const OPERATOR_SCOPES: Scope[] = [
  ...VIEWER_SCOPES,
  "stacks:write",
  "stacks:deploy",
  "containers:write",
  "containers:exec",
  "secrets:reveal",
  "images:write",
  "updates:apply",
  "terminal:container",
];

export const ADMIN_SCOPES: Scope[] = [...ALL_SCOPES];

export const ROLE_SCOPES: Record<Role, Scope[]> = {
  viewer: VIEWER_SCOPES,
  operator: OPERATOR_SCOPES,
  admin: ADMIN_SCOPES,
};

export function hasScope(scopes: readonly string[], scope: string) {
  return scopes.includes("*") || scopes.includes(scope);
}

export function hasAnyScope(scopes: readonly string[], required: readonly string[]) {
  return required.some((scope) => hasScope(scopes, scope));
}

export function hasAllScopes(scopes: readonly string[], required: readonly string[]) {
  return required.every((scope) => hasScope(scopes, scope));
}
