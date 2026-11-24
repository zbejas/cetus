# Updates - registry checks, schedules, and rollback

## Overview

Cetus owns the update loop for every stack. A registry digest sweep compares each running image with its remote manifest, and a schedule pulls new tags, recreates services, waits for a health gate, and rolls back when the new containers do not stay healthy. One global schedule can cover the fleet, and each stack can override it or exclude individual services. No Watchtower container is installed or required.

## Key files

| File | Purpose |
|---|---|
| `apps/server/src/lib/composeConfig.ts` | Resolved `docker compose config` service definitions with raw YAML fallback |
| `apps/server/src/lib/updateCheck.ts` | Local and remote digest lookup, digest comparison, worker-callable check |
| `apps/server/src/lib/registries.ts` | Registry normalization, sealed credentials, per-host Docker config, cache invalidation |
| `apps/server/src/lib/selfInfo.ts` | Manager container identity, Compose project, and image for self-update |
| `apps/server/src/lib/updateCheckState.ts` | SQLite cache, previous-result merge, manager orchestration, applied-update bookkeeping |
| `apps/server/src/lib/autoUpdateConfig.ts` | Global and per-stack validation, inheritance, and service selection rules |
| `apps/server/src/lib/globalAutoUpdate.ts` | `settings.autoUpdate` read, write, and next-run refresh |
| `apps/server/src/lib/autoUpdateRunner.ts` | Pull, `compose up`, health gate, compose and image rollback |
| `apps/server/src/lib/autoUpdateState.ts` | Next-run and last-run rows in `setting` |
| `apps/server/src/lib/scheduler.ts` | 30-second cron tick, six-hour registry sweep, running-operation guard |
| `apps/server/src/lib/operations.ts` | Operation creation, worker dispatch, snapshots, applied-update handling |
| `apps/server/src/lib/cron.ts` | Five-field cron parser, timezone matching, next-run calculation |
| `apps/server/src/worker.ts` | Worker-side auto-update, update-check, compose write, and container action handlers |
| `apps/server/src/lib/remote.ts` | Worker request correlation for writes, checks, actions, and logs |
| `apps/server/src/http/app.ts` | Update check routes, bulk apply, metadata routes, dashboard queue, worker messages |
| `apps/web/src/components/GlobalAutoUpdateDialog.tsx` | Fleet default schedule, health gate, and rollback |
| `apps/web/src/components/AutoUpdateDialog.tsx` | Per-stack inherit, custom schedule, and service exclusions |
| `apps/web/src/pages/Dashboard.tsx` | Fleet update queue, Update all, and Schedule controls |
| `apps/web/src/pages/Settings.tsx` | Updates tab with the global schedule |
| `apps/web/src/pages/StackDetail.tsx` | Stack update status, direct Update button, and per-stack check |
| `packages/shared/src/types.ts` | `StackMetadata.autoUpdate`, `UpdateCheckResult`, `AutoUpdateState`, `BulkUpdateResult` |

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
- Authenticated lookups use the Docker config from Settings > Registries. The manager points `DOCKER_CONFIG` at `<data>/docker`, and each worker keeps its own `0600` config under its data directory. A credential change clears the remote cache and pushes a fresh config to connected workers.
- A service pinned as `repo@sha256:...` is always current. A service with a `build:` key skips registry comparison because there is no registry tag to compare.
- Results are stored as JSON under `updatecheck:<stackId>` in the `setting` table. On a registry error the previous digests are merged back, so a transient failure does not erase the last known state.
- The manager sweeps stacks 15 seconds after start and every six hours. A stack with a cached check newer than one hour is skipped so restarts do not hammer registries. A failed stack check does not abort the sweep.
- Cetus worker stacks are hidden from the fleet list, dashboard, registry sweep, and bulk update. Their direct stack URL still works.

### Schedule and inheritance

- The fleet default lives in `settings.autoUpdate`: `enabled`, `cron`, `timezone`, optional `services`, optional `excludeServices`, `healthCheck`, `rollback`, and `healthGraceSeconds`. It defaults to disabled, `0 4 * * *`, and the server timezone.
- A stack with its own `autoUpdate` metadata uses that config and ignores the fleet default. An explicit `enabled: false` turns the stack off even when the fleet default is on.
- A stack without `autoUpdate` metadata inherits the fleet default. The stack detail response reports `autoUpdateSource` as `global`, `custom`, or `off`, plus the resolved `effectiveAutoUpdate`.
- `validateAutoUpdateConfig` rejects an invalid cron, an unknown timezone, non-string service names, and a health grace outside 10 to 600 seconds. The metadata validator applies the same rules to a stack override.
- Saving the fleet default refreshes the next run for every stack. Saving a stack override refreshes that stack. The scheduler also refreshes all next runs at boot.
- The scheduler ticks every 30 seconds. A matching cron starts `startAutoUpdateOperation`, unless the stack already has a running operation. A 60-second last-run guard prevents duplicate starts in the same minute.
- The scheduler records `autoupdate.next:<stackId>` after every save and run, and `autoupdate.last:<stackId>` with the last status and operation ID.
- A scheduled run uses the `Auto-update` system actor. A manual or bulk run uses the signed-in actor. All three create an `update` operation and an audit row.

### Service selection

- Without `services`, an update selects every Compose service in the stack. With `services`, it selects only those names.
- `excludeServices` is removed after the allowlist is applied. This is how a stack keeps `gluetun`, a database, or another sidecar on its current image while the rest of the stack updates.
- Services with a `build:` key are always skipped because they have no registry tag to pull.
- A manual Run now and the fleet Update all use `manualAutoUpdateConfig`. If the stack has no override, they run with the fleet default forced to enabled, so a disabled schedule never blocks a deliberate action. Explicit stack overrides and exclusions still apply.

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
- The manager sends `compose.write` for compose and env edits. The worker validates YAML, snapshots the old compose file, writes atomically, and acknowledges with `compose.written`.
- Worker results and operation status are stored in the manager's SQLite database, not on the worker.

### Manager self-update

The manager stack is a normal stack, so the Update button and auto-update can target the container that runs Cetus. A direct `compose up` from inside that container would kill itself and lose the operation, so Cetus detects its own Compose project and uses a detached helper.

```text
manager detects self container -> writes selfupdate:<operationId> row
  -> docker run --rm -d --volumes-from <manager> <manager image> sh
  -> compose pull -> compose up -d --remove-orphans
  -> health gate -> status file
manager restarts -> reconcileSelfUpdates reads the status file -> operation finishes
```

- `initializeSelfInfo` reads the container hostname, Compose project, service, and image reference once at startup.
- Before starting the helper, Cetus tags the current image as `cetus-self-update:<operationId>`. Rollback retags that backup to the stack image, which also works when the registry manifest is multi-arch. The tag is removed after the operation is reconciled.
- The helper shares the manager's volumes, so the stack directory and data directory are available. It runs the same pull, `compose up`, health gate, and rollback sequence as a normal local update.
- The helper writes `{"status":"success"|"failed","exitCode":...}` under the operations directory. The new manager reconciles the row at startup and every 10 seconds.
- A failed helper start marks the operation failed immediately. A helper that exits without a status file also fails the operation.
- Self-update recreates the manager container. Open log streams and the current browser connection drop, then reconnect after the new container is healthy.

### API

| Route | Scope | Behavior |
|---|---|---|
| `POST /api/stacks/:id/updates/check` | `stacks:read` | Check one stack and return `UpdateCheckResult` |
| `POST /api/updates/check` | `stacks:read` | Sweep every visible stack and return counts plus per-stack results |
| `POST /api/updates/apply` | `updates:apply` | Start an update for every visible stack with an available image update |
| `PUT /api/stacks/:id/metadata` | `stacks:write` | Validate and save metadata, including `autoUpdate` |
| `POST /api/stacks/:id/auto-update/run` | `stacks:deploy` | Start an update operation from the saved config |
| `PUT /api/settings` | `settings:write` | Save the fleet default under `autoUpdate` |

`GET /api/dashboard` returns cached update entries in `updates`, `updatesCheckedAt`, `updatesFailed`, and the fleet default in `globalAutoUpdate`. The MCP tools `apply_update` and `apply_all_updates` use the same update operation path.

## Gotchas & invariants

- `docker buildx` is required for registry digests. Without the plugin the check reports `Registry digest lookup requires the Docker buildx plugin`, and Cetus does not guess an update. The manager and worker images install `docker-cli-buildx` next to the Compose plugin.
- Docker Hub and GHCR limit unauthenticated manifest requests. Remote results are cached for 10 minutes and errors preserve the previous digest. An update check can still return an error during a rate limit; the UI shows the failed count instead of claiming the image is current. Add a credential in Settings > Registries and target the host that runs the stack. A host `docker login` does not reach the Cetus container because `~/.docker` is not mounted.
- A manual Run now saves the dialog state first. The run uses the saved stack override, or the fleet defaults forced on when the stack inherits them.
- The auto-update scheduler only reads saved metadata. Editing `cetus.json` on disk requires a stack scan or a metadata save before the new schedule is visible.
- Rollback restores files and images, not application data. A database migration that runs on start is not reversed.
- The health gate polls for at most `healthGraceSeconds`. A service that needs longer to become healthy is treated as failed and rolled back.
- Auto-update skips services with a `build:` key because they have no registry tag to pull. Build and publish those images outside Cetus.
- `compose up` is not given the selected service list during an auto-update, so dependencies and sidecars outside `services` are reconciled too. Only the selected services are pulled and health-checked.
- An empty or absent `excludeServices` means no exclusions. Excluding every service is rejected by the dialog and leaves nothing to update.
- Bulk update skips stacks with a running operation, stacks the key cannot target, stacks with no pending digest update, and stacks whose only pending updates are excluded services. It reports both started and skipped stacks in `BulkUpdateResult`.
- Cetus worker stacks are filtered by the `cetus-worker` stack name or Compose project name. Keep that convention when changing the worker compose file.

## Related docs

- [Settings and configuration](settings.md) - bootstrap environment, SQLite settings, and the Updates tab
- [Worker mode](worker.md) - enrollment, worker protocol, and remote capabilities
- [Docs index](README.md)
