# AGENTS.md - Cetus

Guidance for agents and humans working in this repository. Cetus is a compose-native fleet control plane: one Bun manager, one React SPA, file-owned Compose stacks, and Docker hosts managed from a single UI and scoped API.

Read the subsystem doc for the area you are touching. The knowledge base starts at [`docs/README.md`](docs/README.md).

## Documentation map

| Doc | Covers | Read when |
|---|---|---|
| [`docs/README.md`](docs/README.md) | Documentation index, reading paths, writing rules | Finding the right doc |
| [`docs/architecture.md`](docs/architecture.md) | Topology, request flow, data ownership, auth, schedulers, frontend routes | Starting any broad work or tracing a request |
| [`docs/development.md`](docs/development.md) | Local setup, commands, test gates, change workflow, common change map | Setting up the repo or running verification |
| [`docs/api.md`](docs/api.md) | REST, OpenAPI, the API explorer, MCP tools, scopes, errors | Calling the API or changing routes and tools |
| [`docs/backups.md`](docs/backups.md) | Backup contents, schedule, retention, download, restore | Changing backup or restore behavior |
| [`docs/settings.md`](docs/settings.md) | Bootstrap environment, SQLite settings, users, invites, OIDC, SMTP, notifications, palettes, restart boundaries | Changing settings or authentication |
| [`docs/logs.md`](docs/logs.md) | Fleet log viewer, split panes, streaming, retries, limits | Changing logs or log transport |
| [`docs/worker.md`](docs/worker.md) | Worker enrollment, outbound WebSocket, remote capabilities | Changing remote hosts or worker mode |
| [`docs/updates.md`](docs/updates.md) | Registry digest checks, schedules, health gates, rollback | Changing update checks or auto-update |
| [`docs/releases.md`](docs/releases.md) | Version bumps, CI, release workflow, GHCR tags, manual rebuilds | Shipping or changing release automation |
| [`docs/decisions.md`](docs/decisions.md) | Locked product, architecture, security, and delivery decisions | Checking why a choice was made |
| [`docs/competitive.md`](docs/competitive.md) | Dockge, Dokploy, Portainer, and Cetus compared | Product positioning |
| [`README.md`](README.md) | Install, run, feature overview, docs front door | New to the project |

## Stack

- Runtime: Bun 1.4.2. Pinned in the Dockerfile, CI workflow, and release verification.
- Server: Elysia, Bun SQLite, Drizzle ORM, better-auth, Docker CLI and Compose plugin.
- Web: React 19, Vite 8, TanStack Router and Query, CodeMirror, Tailwind CSS 4.
- Tests: `bun test` for unit tests, Playwright for browser flows, screenshots, and accessibility checks.
- Packaging: one root version, one GHCR image, one GitHub Release.

## Repository layout

```text
apps/
  server/
    src/index.ts             HTTP server entry
    src/http/app.ts          Elysia routes, auth bridge, worker socket, static SPA
    src/auth.ts              better-auth, OIDC provider, seed users
    src/config.ts            Bootstrap config, stored settings, package version
    src/db/                  Schema, CREATE SQL, SQLite handle
    src/lib/                 Docker, stacks, operations, settings, invites, mail, notifications
  web/
    src/                     React SPA
    public/                  Favicon, app icons, manifest
packages/shared/src/         Shared types, scopes, palettes
assets/                      README banner, logo, and screenshots
compose/                     Manager and worker compose files
docs/                        Engineering knowledge base
e2e/                         Playwright smoke coverage
.github/workflows/           CI, release, and container publishing
Dockerfile                   Production image
```

Runtime data is written to `data/` locally and `/data` in the container. `dist/`, `data/`, `data-worker/`, `.playwright-mcp/`, `test-results/`, and logs are ignored.

## Commands

Full command and test reference: [`docs/development.md`](docs/development.md).

Before claiming a change is done:

```bash
bun run typecheck
bun run test
bun run build:web
```

Add `bun run test:e2e` when Docker and local test stacks are available. Run `bun run test:visual` after UI changes. Report exactly which gates ran and which did not.

## Architecture at a glance

The manager is the only public HTTP surface. It serves the SPA, REST API, MCP, and the worker WebSocket. Workers dial out; no inbound worker ports. Stack files stay on disk under the stacks directory. SQLite stores the index, users, settings, operations, audit, and sealed secrets.

```text
Browser -> Bun :3000 -> /api/*, /mcp, /api/ws/worker, dist/web
Worker  -> outbound WebSocket -> manager
```

See [`docs/architecture.md`](docs/architecture.md) for the full flow.

## Release and versioning

- One version source: the `version` field in the root [`package.json`](package.json). The server imports it in `apps/server/src/config.ts`.
- User-visible behavior changes bump the version in the same PR. Patch by default; minor for a feature.
- `.github/workflows/ci.yml` verifies pull requests and `master`: typecheck, unit tests, web build, container build without push.
- `.github/workflows/release.yml` triggers on `master` when `package.json` or a release workflow changes. It skips when release `v<version>` already exists.
- Verification runs before publishing. The multi-arch image publishes to GHCR before the GitHub Release is created.
- Image tags: `<version>`, `<major>.<minor>`, `<major>` when the major is not `0`, and `latest` for stable normal releases.
- Manual `workflow_dispatch` with `force` rebuilds an already-released image without creating a second release and without moving `latest`.
- Do not create release tags by hand. The workflow owns tags and release creation.

See [`docs/releases.md`](docs/releases.md) for the full flow.

## Rules

1. **Read the owning doc first.** Code wins over docs. If they disagree, fix the doc in the same change.
2. **Update docs with behavior.** Routes, schema, settings, commands, deployment, or releases change the owning doc and the index in the same change.
3. **Keep user UI free of operator documentation.** Settings shows controls and short field help, not deployment essays or environment reference tables.
4. **One canonical fact.** Put paths, ports, env vars, and schemas in one doc, then link to it.
5. **Bump the release version when behavior ships.** Do not add a second version in `apps/` or `packages/`.
6. **Never commit runtime state or secrets.** `data/`, `data-worker/`, `dist/`, `.playwright-mcp/`, `test-results/`, logs, API keys, OIDC secrets, SMTP passwords, and worker credentials stay out of git.
7. **Secrets at rest use the master key.** OIDC client secrets, SMTP passwords, and notification tokens are sealed with AES-256-GCM. Never return them to the browser.
8. **OIDC changes need a restart.** better-auth reads the OIDC provider at process start. SMTP and notification channel changes apply live.
9. **SQLite schema changes are idempotent.** Add `CREATE TABLE IF NOT EXISTS` or `CREATE INDEX IF NOT EXISTS` to `apps/server/src/db/sql.ts` and update Drizzle schema together.
10. **Keep the existing visual system.** Deep-ocean palette, Glacier default, native `<dialog>`, shared UI primitives, no nested cards.
11. **No private deployment details in public docs or artifacts.** Do not add hostnames, credentials, internal ports, or data paths beyond what the repo already documents.
12. **One manager per database.** The schedulers and worker registry are in-process. Workers dial out; never publish an inbound worker port.
13. **No destructive git unless asked.** Do not rewrite history, force-push, or delete branches.

## Docs authoring

- New docs follow the five-section shape: Overview, Key files, How it works, Gotchas & invariants, Related docs.
- Add every new doc to [`docs/README.md`](docs/README.md) and to the documentation map above.
- Keep links relative and resolvable. No absolute local paths.
- Use code fences with a language tag. Tables for mappings. Current behavior only; history belongs in the decision log or release notes.
- Use plain ASCII diagrams and punctuation. No em dashes.
- User-facing install and feature content belongs in the root README, not in the engineering docs tree.
