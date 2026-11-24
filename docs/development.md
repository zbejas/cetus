# Development - local setup, commands, and test gates

## Overview

Cetus is a Bun application with a server and a React SPA. The server owns the API, SQLite, Docker and Compose calls, MCP, backups, and the worker socket. Vite serves the SPA in development and writes `dist/web` for the production server. Docker and Compose are only needed for real stack operations and stack/log E2E coverage; typecheck, unit tests, and the visual suite run without Docker.

## Key files

| File | Purpose |
|---|---|
| `package.json` | Workspace scripts, dependencies, and the release version |
| `tsconfig.json` | Strict TypeScript config for `apps/` and `packages/` |
| `apps/server/src/index.ts` | Server entry and manager or worker mode switch |
| `apps/server/src/config.ts` | Bootstrap environment, stored settings, secrets, version |
| `apps/web/vite.config.ts` | Vite root, `@shared` and `@` aliases, API proxy, `dist/web` output |
| `playwright.config.ts` | E2E base URL, Chrome path, serial workers, `dev:all` web server |
| `playwright.visual.config.ts` | Visual base URL, fixture stacks, built SPA, screenshot thresholds |
| `e2e/smoke.spec.ts` | Browser smoke coverage for sign-in, logs, MCP keys, backups, invites, and auth rejection |
| `e2e/visual.spec.ts` | Desktop, light, and mobile screenshots plus accessibility checks |
| `e2e/visual.setup.ts` | One-time visual sign-in and saved storage state |
| `e2e/fixtures/stacks/` | Stable Compose fixtures for the visual server |
| `Dockerfile` | Production image build |
| `compose/manager.yaml` | Manager container recipe |
| `compose/worker.yaml` | Worker container recipe |
| `.github/workflows/ci.yml` | Pull request and master verification |
| `.github/workflows/release.yml` | Release version check, verification, and publishing |

## How it works

### Prerequisites

- Bun 1.4.2. The Dockerfile and GitHub workflows pin the same version.
- Docker with the Compose plugin for real stack operations.
- Docker buildx for registry digest checks.
- Google Chrome at `/usr/bin/google-chrome`, or `CHROME_PATH` pointing at a Chrome binary, for Playwright.

### Install and run

```bash
bun install
bun run build:web
bun run start
```

Open `http://localhost:3000`. The first boot seeds the admin configured by `CETUS_ADMIN_EMAIL` and `CETUS_ADMIN_PASSWORD` when the user table is empty. Set both before first boot; no default accounts are created.

Development with hot reload:

```bash
bun run dev:all
```

The API listens on `:3000`, Vite on `:5173`, and Vite proxies `/api` and `/mcp` to the API. Use `bun run dev` for the API alone or `bun run dev:web` for Vite alone.

### Local state

| Path | Contents |
|---|---|
| `data/cetus.db` | SQLite database |
| `data/auth.secret` | better-auth secret, generated on first boot |
| `data/master.key` | Master key for sealed settings, generated on first boot |
| `data/operations/` | Operation output logs |
| `data/trash/` | Deleted stack files |
| `data/backups/`, `data/restore-previous/` | Local backups and pre-restore copies |
| `data-worker/worker.json` | Worker host id and reconnect secret |
| `dist/web/` | Production SPA build |
| `.playwright-visual/` | Visual test database, auth state, and server scratch data |

`CETUS_DATA_DIR`, `CETUS_DB_PATH`, `CETUS_AUTH_SECRET`, `CETUS_MASTER_KEY`, and `CETUS_MASTER_KEY_FILE` override the defaults. The full bootstrap table is in [Settings](settings.md).

The stacks directory defaults to `/opt/stacks`. When Docker is detected, the directory is locked to the mounted path; `CETUS_ALLOW_STACKS_DIR_CHANGE=true` unlocks it.

### Test gates

| Gate | Command | Notes |
|---|---|---|
| Typecheck | `bun run typecheck` | `tsc --noEmit` across apps and packages |
| Unit tests | `bun run test` | `bun test apps packages`; no Docker required |
| Web build | `bun run build:web` | Writes `dist/web`; catches Vite and bundle errors |
| E2E | `bun run test:e2e` | Playwright; needs Chrome. Docker adds stack and log coverage |
| Visual | `bun run test:visual` | Playwright screenshots and axe checks; needs Chrome, no Docker |

Playwright starts `bun run dev:all` on port 5173 unless a server is already listening there. The suite runs serially with one worker. Set `CETUS_E2E_EMAIL` and `CETUS_E2E_PASSWORD` to match an existing admin. A fresh database is seeded from the Playwright web server environment. Stack and log assertions run when the instance has stacks; the suite does not seed stacks.

The visual suite builds the SPA and starts a separate manager on port 3204 with a temporary database under `.playwright-visual/` and the fixture stacks in `e2e/fixtures/stacks`. It signs in once, saves the browser state, and captures desktop, light, and mobile screenshots. Snapshots live in `e2e/visual.spec.ts-snapshots/`. Use `bun run test:visual:update` after an intentional UI change, then review the new images before committing them. The same suite runs axe accessibility checks on the stacks and settings screens and asserts the mobile pages do not overflow horizontally.

CI runs typecheck, unit tests, the web build, and a container build without pushing. The release workflow runs the same gates before publishing. E2E and visual tests are local-only because they depend on Chrome and local rendering.

### Change workflow

1. Read the owning doc in the [docs index](README.md).
2. Implement the change in the owning server or web module.
3. Update the owning doc, the root README when the front door changes, and this doc when commands or gates change.
4. Run the affected gates and report which ones ran.
5. Bump the root `package.json` version for user-visible behavior. Patch for fixes, minor for features. Do not add a second version.
6. Open a PR. See [Releases](releases.md) for the publishing flow.

### Common changes

| Change | Start here |
|---|---|
| REST route or scope check | `apps/server/src/http/app.ts`, then `apps/server/src/lib/security.ts` |
| Stack or Compose behavior | `apps/server/src/lib/stacks.ts`, `apps/server/src/lib/operations.ts`, `apps/server/src/lib/composeConfig.ts` |
| Worker command or message | `apps/server/src/worker.ts`, `apps/server/src/lib/remote.ts`, then [Worker mode](worker.md) |
| Runtime setting | `apps/server/src/lib/settings.ts`, `apps/web/src/pages/Settings.tsx`, then [Settings](settings.md) |
| Database table or index | `apps/server/src/db/sql.ts` and `apps/server/src/db/schema.ts` together |
| API route, OpenAPI spec, or MCP tool | `apps/server/src/http/app.ts`, then [API and MCP](api.md) |
| Backup or restore | `apps/server/src/lib/backups.ts`, `apps/server/src/lib/restore.ts`, then [Backups](backups.md) |
| SPA page | `apps/web/src/router.tsx`, `apps/web/src/pages/`, `apps/web/src/lib/api.ts` |
| Log behavior | `apps/server/src/lib/logSources.ts`, `apps/web/src/components/LogViewer.tsx`, then [Fleet logs](logs.md) |
| Release or CI | `.github/workflows/`, then [Releases](releases.md) |

## Gotchas & invariants

- `bun run dev` alone does not serve the SPA unless `dist/web` already exists. Use `bun run dev:all` or open Vite on `:5173`.
- Vite has `strictPort: true`. A stale process on `:5173` blocks the dev server; stop it before starting a new one.
- Playwright reuses an existing server on `:5173`. A stale Vite process can make E2E run old code, so restart it after frontend changes.
- The Playwright config defaults to `/usr/bin/google-chrome`. Set `CHROME_PATH` when Chrome is installed elsewhere.
- `bun run start` serves `dist/web`. Run `bun run build:web` after web changes or the browser gets the previous bundle.
- The E2E suite is serial. Stack and log coverage depends on the local stacks; it is not part of CI or the release gate.
- The visual suite wipes `.playwright-visual/` on every run. Do not point it at a real data directory.
- Screenshot baselines are tied to the Chrome build and font rendering. Regenerate them on the same platform used for review.
- `data/`, `data-worker/`, `dist/`, `.playwright-visual/`, logs, and generated secrets are runtime state. Never commit them.
- Replacing `data/master.key` makes sealed OIDC secrets, SMTP passwords, and notification tokens unreadable. Replacing `data/auth.secret` invalidates sessions.
- Schema changes need an idempotent statement in `apps/server/src/db/sql.ts` and a matching Drizzle definition. The server applies `CREATE_SQL` at startup.
- The manager and worker use the same image. `CETUS_MODE` selects the entrypoint; the worker still needs the Docker socket and its own stacks path.

## Related docs

- [Architecture](architecture.md) - topology, request flow, data ownership
- [API and MCP](api.md) - REST conventions, OpenAPI, and MCP tools
- [Backups](backups.md) - backup and restore
- [Settings and configuration](settings.md) - bootstrap environment and runtime settings
- [Releases](releases.md) - version bump, CI, and publishing
- [Worker mode](worker.md) - worker enrollment and protocol
- [Fleet logs](logs.md) - log workspace and streaming limits
- [Updates](updates.md) - update checks and auto-update
- [Docs index](README.md) - documentation map
