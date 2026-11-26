# Architecture - manager, workers, and data ownership

## Overview

Cetus is a compose-native fleet control plane. One Bun process is the manager: it serves the React SPA, the scoped REST API, MCP, and the worker WebSocket. Workers dial out to the manager and run Docker commands on their own hosts. Compose files stay on disk under the stacks directory. SQLite stores the index, operations, audit entries, users, settings, API keys, notifications, and sealed secrets.

Run one manager per SQLite database. The schedulers and worker registry are in-process, so a second manager against the same database would duplicate background work.

## Key files

| File | Purpose |
|---|---|
| `apps/server/src/index.ts` | Process entry. Selects manager or worker mode and starts the HTTP listener |
| `apps/server/src/http/app.ts` | Elysia app, origin checks, auth bridge, REST routes, MCP route, worker socket, static SPA |
| `apps/server/src/auth.ts` | better-auth setup, generic OIDC provider, session rules, first-boot seed users |
| `apps/server/src/config.ts` | Bootstrap environment, stored settings, master key, auth secret, package version |
| `apps/server/src/db/index.ts` | SQLite handle, WAL and foreign-key pragmas, schema bootstrap |
| `apps/server/src/db/sql.ts` | Idempotent `CREATE TABLE` and `CREATE INDEX` statements |
| `apps/server/src/db/schema.ts` | Drizzle table definitions used by the server |
| `apps/server/src/lib/docker.ts` | Docker CLI and Compose helpers, inventory, stats, log reads |
| `apps/server/src/lib/stacks.ts` | Stack scan, compose and metadata reads and writes, validation, snapshots |
| `apps/server/src/lib/operations.ts` | Operation lifecycle, compose actions, output capture, notification dispatch |
| `apps/server/src/lib/selfContainer.ts` | Container identity lookup used by manager and worker self-update |
| `apps/server/src/lib/selfUpdate.ts` | Detached self-update helper script, rollback tag, and helper launch |
| `apps/server/src/lib/updateQueue.ts` | Persistent manual update queue and serial manager |
| `apps/server/src/lib/operationEvents.ts` | Operation-finished events used to advance the update queue |
| `apps/server/src/lib/registries.ts` | Per-host registry credentials and Docker config generation |
| `apps/server/src/lib/remote.ts` | Worker registry, command correlation, remote logs, remote update checks |
| `apps/server/src/lib/hosts.ts` | Local and remote host summaries, inventory merge |
| `apps/server/src/lib/security.ts` | Actor resolution, API key verification, scope checks, audit writes |
| `apps/server/src/lib/settings.ts` | Runtime settings validation, OIDC and SMTP persistence, settings view |
| `apps/server/src/lib/apiDocs.ts` | OpenAPI explorer shell and client asset |
| `apps/server/src/lib/backups.ts` | Backup creation, retention, download, delete, and restore staging |
| `apps/server/src/lib/restore.ts` | Pending restore applied before SQLite opens |
| `apps/server/src/lib/scheduler.ts` | Auto-update tick and six-hour registry sweep |
| `apps/server/src/lib/updateCheck.ts` | Registry digest checks and update state |
| `apps/server/src/lib/autoUpdateRunner.ts` | Health-gated auto-update and rollback |
| `apps/server/src/lib/notifications.ts` | Email, ntfy, and webhook delivery and delivery log |
| `apps/server/src/lib/mailer.ts` | SMTP transport and test messages |
| `apps/server/src/lib/autoUpdateState.ts` | Auto-update schedule state and next-run refresh |
| `apps/server/src/lib/updateCheckState.ts` | Update-check cache and per-stack results |
| `apps/server/src/lib/composeConfig.ts` | Compose parsing and normalization helpers |
| `apps/server/src/lib/cron.ts` | Cron expression matching with timezone support |
| `apps/server/src/lib/invites.ts` | Invite creation, hashing, lookup, revocation |
| `apps/server/src/lib/preferences.ts` | Per-user palette preference |
| `apps/server/src/lib/logSources.ts` | Flattened container log source list |
| `apps/server/src/lib/secrets.ts` | AES-256-GCM seal and open helpers |
| `apps/server/src/lib/errors.ts` | API error type and JSON error responses |
| `apps/server/src/worker.ts` | Worker entrypoint, outbound WebSocket, snapshot loop, command executor |
| `packages/shared/src/index.ts` | Shared barrel exports |
| `packages/shared/src/types.ts` | Shared API and domain types |
| `packages/shared/src/scopes.ts` | Scope list, role mapping, scope helpers |
| `packages/shared/src/palettes.ts` | Palette ids and the Glacier default |
| `apps/web/src/main.tsx` | SPA entry and providers |
| `apps/web/src/router.tsx` | SPA route tree |
| `apps/web/src/pages/` | Route pages for dashboard, stacks, hosts, logs, activity, and settings |
| `apps/web/src/lib/api.ts` | Typed API client and request helpers |
| `apps/web/src/lib/queries.ts` | TanStack Query definitions |
| `apps/web/src/components/AppShell.tsx` | Session gate, navigation, command palette host |
| `apps/web/public/` | Favicon, maskable icons, manifest, and the monochrome Safari icon |
| `compose/manager.yaml` | Manager container definition |
| `compose/worker.yaml` | Worker container definition |
| `Dockerfile` | Production image build |

## How it works

### Topology

```text
Browser
  |
  v
Manager Bun :3000
  |-- /api/*      -> Elysia -> SQLite + Docker/Compose + workers
  |-- /mcp        -> JSON-RPC tools over scoped API keys
  |-- /api/ws/*   -> worker and live-log WebSockets
  `-- /*          -> dist/web SPA
        ^
        | outbound WebSocket, no inbound worker port
        |
  Worker Bun + Docker CLI on a remote host
```

The manager is the only public HTTP surface. A worker opens one outbound WebSocket to `/api/ws/worker`, receives commands, runs them with the local Docker and Compose CLI, and streams results back.

### Boot sequence

1. `apps/server/src/index.ts` reads `CETUS_MODE`. `worker` imports `worker.ts`; every other value applies a pending restore, then starts the manager.
2. `config.ts` reads bootstrap environment variables, then overlays stored `settings.*` rows, and creates or reads the master key and auth secret.
3. `db/index.ts` opens SQLite, enables WAL, foreign keys, and a busy timeout, then applies `CREATE_SQL`.
4. `createApp()` seeds the first admin when the user table is empty and the bootstrap credentials are set, syncs the stacks directory, and starts the auto-update, update-check, and backup schedulers.
5. Elysia binds the routes and begins listening on `CETUS_PORT`.

### Request flow

| Request | Path |
|---|---|
| Public health and auth config | `/api/health`, `/api/auth-config` |
| better-auth endpoints | `/api/auth/*`; public sign-up is rejected before the handler |
| Invite flow | `/api/invites/:token`, `/api/invites/:token/accept`; public |
| Signed-in session | `/api/me`, `/api/preferences` |
| Fleet API | `/api/dashboard`, `/api/hosts*`, `/api/stacks*`, `/api/operations*`, `/api/audit*` |
| Logs | `/api/logs/sources`, `/api/containers/:id/logs*`, `/api/stacks/:id/logs*` |
| Access and settings | `/api/keys*`, `/api/users*`, `/api/invites*`, `/api/settings*`, `/api/notifications*`, `/api/backups*` |
| API reference | `/api/openapi.json`, `/api/docs`; public |
| MCP | `/mcp` |
| Worker socket | `/api/ws/worker` |
| SPA | `/*`, served from `dist/web` with an `index.html` fallback |

Most API requests resolve an actor from a session cookie or an API key, check the required scope, and then call the owning library. Public exceptions are `/api/health`, `/api/auth-config`, `/api/auth/*`, and the invite validation and acceptance routes. Mutating API requests with an `Origin` header must come from a trusted origin. In production the app also sets CSP, HSTS when the public URL is HTTPS, and standard browser hardening headers.

### Data ownership

| Store | Owns |
|---|---|
| Stack files under `CETUS_STACKS_DIR` | Compose YAML, optional `.env`, optional `cetus.json`, `.cetus/snapshots/` |
| SQLite `host`, `stack`, `snapshot` | Index and metadata for hosts and stacks |
| SQLite `operation`, `audit_log` | Operation output and audit history |
| SQLite `user`, `session`, `account`, `verification` | better-auth identity and sessions |
| SQLite `api_key` | Hashed API key secrets, scopes, host and stack targets, expiry, revocation |
| SQLite `setting`, `user_preference` | Runtime settings and per-user palette |
| SQLite `invite` | Hashed one-time invite tokens |
| SQLite `notification_channel`, `notification_delivery` | Channels and delivery attempts |
| `data/cetus.db` | The database itself |
| `data/master.key`, `data/auth.secret` | Secret material created on first boot |
| `data/operations/`, `data/trash/` | Operation logs and deleted stack trash |
| `data/backups/`, `data/.restore/`, `data/restore-previous/` | Local backups, staged restores, and pre-restore copies |
| `data-worker/worker.json` | Worker host id and reconnect secret, mode `0600` |

The Compose files are the source of truth for YAML. SQLite is an index and control-plane state, not a second copy of the files. A remote worker's disk is the source of truth for its stacks; the manager keeps the last snapshot.

### SQLite and hot paths

- WAL mode, `synchronous=NORMAL`, a 5-second busy timeout, a 32 MB page cache, a 128 MB mmap window, memory temp storage, and a 64 MB WAL size limit.
- `PRAGMA optimize` runs at startup and after the daily retention delete. `PRAGMA wal_checkpoint(PASSIVE)` follows the retention delete.
- Indexes cover the query shapes that grow with fleet size: stack host and status counts, operation stack/status and start time, audit stack and time, notification delivery time, session expiry, and verification identifiers.
- `listStacks` reads one `docker ps -a` snapshot and reuses it for every stack. It skips `docker stats`. Stack detail reads container stats only for the stack being viewed.
- Update-check rows are read with a primary-key range on the `setting` table instead of scanning every setting.
- The operations list is compact by default in the browser: it omits retained output, and the Activity dialog fetches the full output for the selected operation.
- The Activity page paginates the latest 60 operations and 100 audit events in the browser. Page changes do not issue new API requests.

### Auth and scopes

- Browser sessions use better-auth cookies. Public email sign-up is disabled; admins create users or one-time invites.
- API keys use `cetus_<prefix>.<secret>`. Cetus stores a SHA-256 hash of the secret and the prefix, compares the secret in constant time, and shows the full key once.
- Roles map to scopes: `viewer` is read-only, `operator` adds stack writes, deploys, container actions, exec, image writes, update applies, and container terminal, and `admin` has every scope.
- An API key can carry a narrower scope list plus host and stack targets. Target checks apply to both list results and actions.
- OIDC client secrets, SMTP passwords, and notification tokens are sealed with AES-256-GCM using the instance master key. The API never returns sealed values.

### Workers

The worker sends `hello` with either a one-time enrollment token or a stored host id and secret. The manager answers with `enrolled`, then accepts snapshots, heartbeats, log chunks, update-check results, compose write results, container action results, and operation output. Manager commands include compose actions, metadata and compose writes, container actions, update checks, auto-updates, and log requests.

Enrollment tokens expire after 15 minutes and are single use. Reconnects use the secret in `data-worker/worker.json`. The protocol and remote capability limits are owned by [Worker mode](worker.md).

### Background work

- The update-check sweep runs 15 seconds after boot and then every six hours. It skips stacks checked in the last hour and stacks currently updating.
- The auto-update scheduler ticks every 15 seconds, resolves the fleet default from `settings.autoUpdate` against each stack's override, evaluates the cron expression in its configured timezone, and queues due stacks. At most `CETUS_AUTO_UPDATE_CONCURRENCY` operations run at once. Scheduled runs skip stacks with no pending digest update and pull only changed services.
- A registry rate-limit failure pauses scheduled starts for `CETUS_PULL_RATE_LIMIT_BACKOFF_MINUTES` (default six hours).
- Manual fleet updates use the persistent `update_queue` table. The manager starts one entry at a time by default, advances when the operation finishes, and keeps the queue across restarts.
- Cetus worker stacks are hidden from fleet lists, update sweeps, and bulk updates, but the scheduler can send a detached `worker.self-update` when the worker supports it and its version is older than the manager.
- Auto-updates run the health gate and roll back to the previous compose file and image ids on failure. See [Updates](updates.md).
- The backup scheduler ticks every minute, runs a daily backup at `CETUS_BACKUP_CRON`, and prunes older archives to `CETUS_BACKUP_KEEP`. See [Backups](backups.md).
- The retention job runs daily and deletes audit rows older than `CETUS_AUDIT_RETENTION_DAYS` and notification deliveries older than `CETUS_NOTIFICATION_RETENTION_DAYS`.

### Frontend routes

| Route | Page |
|---|---|
| `/login` | Local and OIDC sign-in |
| `/invite/:token` | Invite acceptance |
| `/` | Dashboard |
| `/stacks` | Stack list and scan |
| `/stacks/:stackId` | Stack cockpit, compose editor, services, logs, snapshots |
| `/logs` | Fleet log workspace |
| `/hosts` | Host list |
| `/hosts/enroll` | Worker enrollment |
| `/hosts/:hostId` | Host detail and inventory |
| `/activity` | Operations and audit |
| `/settings` | Instance, appearance, updates, access, authentication, mail, notifications, API keys |

## Gotchas & invariants

- The manager is the only public HTTP surface. Never publish an inbound worker port; workers dial out.
- SQLite is not the source of YAML. Editing a compose file on disk without a scan leaves the index stale until `syncStacks` runs.
- Remote compose editing, delete, and managed container actions use explicit worker messages. Remote stack exec, snapshot restore, and remote PTY terminals are not implemented; the API returns `501` and the UI disables those controls instead of silently targeting the manager's Docker daemon.
- Standalone containers without a Compose project label are read-only in the UI and API. Add them to a Compose stack before managing their lifecycle.
- The public URL is the better-auth issuer and is fixed at process start. Changing it requires a manager restart.
- OIDC configuration is read when better-auth initializes. Save it, then restart the manager.
- When Docker is detected, the stacks directory is locked to the mounted path. Set `CETUS_ALLOW_STACKS_DIR_CHANGE=true` only when you intend to move it.
- Losing `data/master.key` makes every sealed OIDC secret, SMTP password, and notification token unreadable. Back it up with the database.
- MCP uses the same API keys and scopes as REST. A key restricted to one host or stack is filtered in list results and blocked on actions.
- The OpenAPI document is generated from Elysia route schemas. Response schemas are optional and currently missing on most routes; add one when a response contract must be public.
- A staged restore is applied before config and SQLite open. The manager does not listen until the replacement finishes. See [Backups](backups.md).
- The server serves `dist/web`. Without a web build, `/` returns `503` while the API stays available.
- The schedulers and worker registry are in-process. Do not run multiple managers against one database.
- `data/`, `data-worker/`, `dist/`, logs, and worker credentials are runtime state and must not be committed.

## Related docs

- [API and MCP](api.md) - REST conventions, OpenAPI explorer, MCP tools, scopes
- [Backups](backups.md) - backup contents, schedule, restore
- [Settings and configuration](settings.md) - bootstrap environment, settings keys, auth, mail, notifications
- [Worker mode](worker.md) - enrollment, protocol, remote capabilities
- [Fleet logs](logs.md) - log workspace and streaming path
- [Updates](updates.md) - registry checks, schedules, health gate, rollback
- [Releases](releases.md) - versioning and image publishing
- [Development](development.md) - local workflow and test gates
- [Decision log](decisions.md) - locked architecture and security decisions
- [Docs index](README.md) - documentation map
