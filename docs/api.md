# API and MCP

## Overview

Cetus exposes one scoped API to the browser, scripts, and AI clients. The REST routes live under `/api`, the OpenAPI document is generated from the route schemas, and MCP runs at `/mcp` over the same API keys and permission checks. Remote capabilities that the worker protocol does not implement return `501` instead of silently targeting the manager.

## Key files

| File | Purpose |
|---|---|
| `apps/server/src/http/app.ts` | REST routes, MCP tools, request validation, audit calls |
| `apps/server/src/lib/apiDocs.ts` | API reference shell and client asset |
| `apps/server/src/lib/apiDocsClient.js` | Self-contained OpenAPI explorer |
| `apps/server/src/lib/security.ts` | Actor resolution, API key verification, scope checks, audit writes |
| `packages/shared/src/scopes.ts` | Scope list and role mappings |
| `packages/shared/src/types.ts` | Shared request and response types |
| `apps/web/src/lib/api.ts` | Typed browser client |

## How it works

### Authentication

Browser requests use the better-auth session cookie. Scripts and MCP clients send an API key:

```http
Authorization: Bearer cetus_<prefix>.<secret>
```

Cetus stores only a SHA-256 hash of the secret and shows the full key once. Keys carry explicit scopes and optional host and stack targets. A key restricted to one target is filtered in list results and denied on actions outside it.

Public routes are limited to `/api/health`, `/api/auth-config`, `/api/auth/*`, and the invite validation and acceptance routes.

### OpenAPI and the explorer

The OpenAPI document is generated from the Elysia route schemas at runtime:

| Path | Behavior |
|---|---|
| `/api/openapi.json` | OpenAPI 3.1 document with paths, path parameters, and request body schemas |
| `/api/docs` | API reference with endpoint search, schema detail, and a request runner |
| `/api/docs/client.js` | Explorer client, served locally so the CSP can stay `script-src 'self'` |

The explorer accepts a bearer key in the top bar or uses the current browser session. It sends same-origin requests with cookies. The request runner is a convenience, not a sandbox; the route still applies the same scope and target checks.

Response schemas are not declared on most routes, so the OpenAPI document focuses on paths, parameters, and request bodies. Add an Elysia response schema when a response contract needs to be public.

### MCP

MCP uses Streamable HTTP at `POST /mcp` with JSON-RPC 2.0. Supported methods are `initialize`, `tools/list`, `tools/call`, `ping`, and the standard initialized and cancelled notifications.

An MCP key needs `mcp:read` or `mcp:write` plus the resource scope for each tool. Write tools also need `mcp:write`. Destructive tools require `confirm: true` and the exact target name.

| Tool | Scope | Behavior |
|---|---|---|
| `list_hosts`, `get_host`, `get_host_inventory` | `hosts:read` | Host summaries, Docker info, and inventory |
| `list_containers`, `get_container_logs` | `containers:read`, `logs:read` | Inventory and recent container logs |
| `list_stacks`, `get_stack`, `get_stack_compose`, `list_services`, `get_stack_logs` | `stacks:read`, `logs:read` | Stack detail, compose, services, and logs |
| `get_updates`, `check_updates` | `updates:read` | Cached and live registry checks |
| `get_activity`, `list_operations` | `audit:read`, `stacks:read` | Audit and operation history |
| `create_stack`, `edit_stack_compose` | `mcp:write`, `stacks:write` | Local or worker stack files |
| `delete_stack` | `mcp:write`, `stacks:delete` | Stack to trash after confirmation |
| `deploy_stack`, `stack_lifecycle`, `service_action` | `mcp:write`, `stacks:deploy` | Compose operations |
| `stack_exec` | `mcp:write`, `containers:exec` | Non-interactive command in a local service container |
| `container_action` | `mcp:write`, `containers:write` | Start, stop, restart, pause, unpause, or remove a managed Compose container |
| `apply_update` | `mcp:write`, `updates:apply` | Health-gated auto-update for one stack |
| `apply_all_updates` | `mcp:write`, `updates:apply` | Queue every visible stack with an available image update |

MCP and REST mutations write an audit entry with the actor, target, action, and a short command or argument summary. Local and worker stacks support compose, env, and metadata edits, delete to trash, lifecycle actions, and managed container actions. Remote stack exec, remote snapshot restore, and remote interactive terminals are not implemented; the API returns `501` and the UI disables those controls. Standalone containers without a Compose project are read-only.

### Audit export

`GET /api/audit/export?format=csv|json` requires `audit:export` and returns up to 20,000 recent entries. The Settings Audit tab downloads the currently filtered rows through the same endpoint. Exports are audited.

### Errors

Errors use a JSON body with a stable code:

```json
{
  "code": "forbidden",
  "detail": "Missing scope: stacks:deploy"
}
```

`401` means no valid session or key. `403` means the actor lacks a scope or target. `422` means validation or a required confirmation failed. `501` means the capability is not implemented for that host kind.

## Gotchas & invariants

- Scope checks happen before the service call. A new route must call `actorForScope` or `requireScope`.
- API key target checks are separate from scopes. Call `assertTarget` or use a filtered list helper.
- The API is not version-prefixed in this release. The OpenAPI path is the stable contract for scripts.
- MCP tools are filtered in `tools/list` by the key's scopes. A tool that is missing from the list cannot be called.
- The explorer can send destructive requests if the signed-in actor has the scopes. Treat it like the rest of the admin UI.
- Remote workers remain the source of truth for their files. The manager may hold stale compose text until the next snapshot.
- A worker stack edit goes over `compose.write` and returns the new hashes. A stale `baseHash` returns `409`, and the worker snapshot remains the authority for a later resync.
- A worker delete runs `compose down` on the worker and moves the stack folder to the worker's `data/trash` directory. The manager removes the index row when the operation succeeds.

## Related docs

- [Architecture](architecture.md) - request flow, auth, and data ownership
- [Settings and configuration](settings.md) - API keys, OIDC, SMTP, notifications
- [Worker mode](worker.md) - remote capability limits
- [Backups](backups.md) - backup API and restore flow
- [Docs index](README.md) - documentation map
