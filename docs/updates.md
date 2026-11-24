# Updates - registry checks, schedules, and rollback

## Overview

Cetus owns the update loop for every stack. A registry digest sweep compares each running image with its remote manifest, and a per-stack cron schedule pulls new tags, recreates services, waits for a health gate, and rolls back when the new containers do not stay healthy. No Watchtower container is installed or required.

## Key files

| File | Purpose |
|---|---|
| `apps/server/src/lib/composeConfig.ts` | Resolved `docker compose config` service definitions with raw YAML fallback |
| `apps/server/src/lib/updateCheck.ts` | Local and remote digest lookup, digest comparison, worker-callable check |
| `apps/server/src/lib/updateCheckState.ts` | SQLite cache, previous-result merge, manager orchestration, applied-update bookkeeping |
| `apps/server/src/lib/autoUpdateRunner.ts` | Pull, `compose up`, health gate, compose and image rollback |
| `apps/server/src/lib/autoUpdateState.ts` | Next-run and last-run rows in `setting` |
| `apps/server/src/lib/scheduler.ts` | 30-second cron tick, six-hour registry sweep, running-operation guard |
| `apps/server/src/lib/operations.ts` | Operation creation, worker dispatch, snapshots, applied-update handling |
| `apps/server/src/lib/cron.ts` | Five-field cron parser, timezone matching, next-run calculation |
| `apps/server/src/worker.ts` | Worker-side auto-update and update-check handlers |
| `apps/server/src/lib/remote.ts` | Worker request correlation for metadata writes and update checks |
| `apps/server/src/http/app.ts` | Update check routes, metadata routes, dashboard queue, worker message handling |
| `apps/web/src/components/AutoUpdateDialog.tsx` | Per-stack schedule, health gate, rollback, and run-now controls |
| `apps/web/src/pages/Dashboard.tsx` | Fleet update queue and manual sweep |
| `apps/web/src/pages/StackDetail.tsx` | Stack update status and per-stack check |
| `packages/shared/src/types.ts` | `StackMetadata.autoUpdate`, `UpdateCheckResult`, `AutoUpdateState` |

## How it works

### Registry sweeps

```text
compose services -> running container image -> local RepoDigests
                 -> docker buildx imagetools inspect -> remote manifest digest
                 -> compare -> setting updatecheck:<stackId>
```

- `checkComposeUpdates` resolves services with `docker compose config`, maps them to containers with `docker compose ps`, and reads the image ID from the running container when one exists. A stopped service falls back to the tagged image.
- Local digests come from `docker image inspect --format '{{json .RepoDigests}}'`. The registry digest comes from `docker buildx imagetools inspect <image> --format '{{json .Manifest}}'`.
- `hasDigestUpdate` reports an update only when a remote digest exists, a local digest exists, and no local digest matches. Missing data is never treated as an update.
- Remote lookups are cached in-process for 10 minutes per image, so several stacks sharing an image produce one registry call.
- A service pinned as `repo@sha256:...` is always current. A service with a `build:` key skips registry comparison because there is no registry tag to compare.
- Results are stored as JSON under `updatecheck:<stackId>` in the `setting` table. On a registry error the previous digests are merged back, so a transient failure does not erase the last known state.
- The manager sweeps stacks 15 seconds after start and every six hours. A stack with a cached check newer than one hour is skipped so restarts do not hammer registries. A failed stack check does not abort the sweep.

### Schedule and run

- Configuration lives in stack metadata under `autoUpdate`: `enabled`, `cron`, `timezone`, optional `services`, `healthCheck`, `rollback`, and `healthGraceSeconds`.
- `validateStackMetadata` rejects an invalid cron, an unknown timezone, non-string service names, and a health grace outside 10 to 600 seconds.
- The scheduler ticks every 30 seconds. A matching cron starts `startAutoUpdateOperation`, unless the stack already has a running operation. A 60-second last-run guard prevents duplicate starts in the same minute.
- The scheduler records `autoupdate.next:<stackId>` after every save and run, and `autoupdate.last:<stackId>` with the last status and operation ID.
- A scheduled run uses the `Auto-update` system actor. A manual run uses the signed-in actor. Both create an `update` operation and an audit row.

### Health gate and rollback

```text
snapshot -> pull selected services -> compose up -d
         -> health gate -> success
                        -> failure -> restore compose file
                                   -> retag previous image IDs
                                   -> compose up -d --force-recreate
```

- The compose file is snapshotted to `.cetus/snapshots` before the pull.
- The health gate reads `docker compose ps`. It fails on a missing container, `exited` or `dead` state, or an `unhealthy` health check. It passes after every selected service reports `running` and no service reports `starting` for 5 seconds.
- One-shot services marked with `x-cetus-one-shot: true`, or `init*` services with `restart: no`, are excluded from the health gate.
- Rollback restores the previous compose text and retags the previous image IDs before recreating containers. It does not restore volumes, named volumes, or external state.
- `healthCheck: false` reports success after a clean `compose up`. `rollback: false` leaves the failed update in place and marks the operation failed.

### Worker path

- The manager sends `auto-update` with project name, compose file, and update config. The worker runs the same `runAutoUpdate` code and returns `operation.finished` with `autoUpdateStatus`.
- The manager sends `update-check` with a batch of stacks. The worker returns `update-check.result` with one result per stack.
- The manager sends `metadata.write` when stack metadata changes, so `cetus.json` on the worker stays authoritative. The worker acknowledges with `metadata.written`.
- Worker results and operation status are stored in the manager's SQLite database, not on the worker.

### API

| Route | Scope | Behavior |
|---|---|---|
| `POST /api/stacks/:id/updates/check` | `stacks:read` | Check one stack and return `UpdateCheckResult` |
| `POST /api/updates/check` | `stacks:read` | Sweep every visible stack and return counts plus per-stack results |
| `PUT /api/stacks/:id/metadata` | `stacks:write` | Validate and save metadata, including `autoUpdate` |
| `POST /api/stacks/:id/auto-update/run` | `stacks:deploy` | Start an update operation from the saved config |

`GET /api/dashboard` returns cached update entries in `updates`, plus `updatesCheckedAt` and `updatesFailed`.

## Gotchas & invariants

- `docker buildx` is required for registry digests. Without the plugin the check reports `Registry digest lookup requires the Docker buildx plugin`, and Cetus does not guess an update. The manager and worker images install `docker-cli-buildx` next to the Compose plugin.
- Docker Hub limits unauthenticated manifest requests per IP. Remote results are cached for 10 minutes and errors preserve the previous digest. An update check can still return an error during a rate limit; the UI shows the failed count instead of claiming the image is current. Run `docker login` on the host to let buildx use registry credentials and raise the limit.
- A manual `Run now` saves the dialog state first. If the schedule switch is off, the run still executes and the schedule stays off.
- The auto-update scheduler only reads saved metadata. Editing `cetus.json` on disk requires a stack scan or a metadata save before the new schedule is visible.
- Rollback restores files and images, not application data. A database migration that runs on start is not reversed.
- The health gate polls for at most `healthGraceSeconds`. A service that needs longer to become healthy is treated as failed and rolled back.
- Auto-update skips services with a `build:` key because they have no registry tag to pull. Build and publish those images outside Cetus.
- `compose up` is not given the selected service list during an auto-update, so dependencies and sidecars outside `services` are reconciled too. Only the selected services are pulled and health-checked.
- There is no global auto-update toggle. Each stack opts in through its own metadata.

## Related docs

- [Settings and configuration](settings.md) - bootstrap environment and SQLite settings
- [Worker mode](worker.md) - enrollment and worker protocol
- [Docs index](README.md)
