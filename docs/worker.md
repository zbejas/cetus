# Worker mode - current slice

Cetus workers are headless processes that dial out to one manager. This slice covers enrollment, live inventory, stack snapshots, compose edits, deploy and lifecycle commands, delete to trash, managed container actions, and live container and stack logs. Remote stack exec, snapshot restore, interactive terminals, and host shell are not enabled.

## Key files

| File | Purpose |
|---|---|
| `apps/server/src/worker.ts` | Worker entrypoint, WebSocket client, snapshot loop, command executor |
| `apps/server/src/lib/remote.ts` | Manager-side worker registry, command send, log request correlation |
| `apps/server/src/lib/hosts.ts` | Host summaries and inventory, including remote snapshots |
| `apps/server/src/lib/stacks.ts` | `syncRemoteStacks` and remote stack detail reads |
| `apps/server/src/http/app.ts` | `/api/hosts/enroll` and `/api/ws/worker` |
| `compose/worker.yaml` | Worker container recipe |

## Enroll a worker

1. Create a one-time token as an admin:

```bash
curl -X POST https://cetus.example/api/hosts/enroll \
  -H 'Content-Type: application/json' \
  --cookie 'better-auth.session_token=...' \
  -d '{"name":"lxc-media"}'
```

Response:

```json
{
  "token": "one-time-token",
  "managerUrl": "wss://cetus.example/api/ws/worker",
  "expiresAt": "2026-11-24T02:45:00.000Z"
}
```

2. Start the worker with the token:

```bash
CETUS_MANAGER_URL=wss://cetus.example/api/ws/worker \
CETUS_ENROLL_TOKEN=one-time-token \
CETUS_WORKER_NAME=lxc-media \
CETUS_WORKER_STACKS_DIR=/opt/stacks \
CETUS_WORKER_DATA_DIR=/data \
bun apps/server/src/worker.ts
```

The manager stores only a hash of the enrollment token. The worker consumes the token, receives a host ID and a worker secret, and stores the secret in `CETUS_WORKER_DATA_DIR/worker.json` with mode `0600`. Reconnects use that credential, not the token. Worker secrets are compared in constant time.

3. The host appears in `/api/hosts` and in the unified stacks view. Remote stacks are indexed under the worker host.

### Update a worker

The worker reports its Cetus version in the host list. When the version is older than the manager and the worker supports self-update, the Hosts page and host detail page show an update button. The worker starts a detached helper, recreates its own container, and reports the result after reconnecting. Global auto-update applies to the hidden worker stack on the same schedule once the worker supports self-update.

A worker running a build before the self-update protocol cannot update itself safely. Update it once from its stack directory:

```bash
cd /opt/stacks/cetus-worker
docker compose pull
docker compose up -d
```

After it reconnects on the new build, panel updates and the global schedule manage it.

## Protocol

The socket carries JSON messages. Elysia parses JSON before the handler, so the handler accepts either a parsed object or a raw string or byte buffer.

| Direction | Message | Meaning |
|---|---|---|
| Worker to manager | `hello` | Token or host ID plus secret, worker name, host info |
| Manager to worker | `enrolled` | Host ID, optional one-time secret, manager version |
| Worker to manager | `snapshot` | Host info, stacks, compose and env text, services, inventory |
| Worker to manager | `heartbeat` | Liveness |
| Manager to worker | `command` | Operation ID, stack name, Compose args, optional second command |
| Manager to worker | `auto-update` | Operation ID, compose file, project name, and update config |
| Worker to manager | `operation.output` | Streamed command output |
| Worker to manager | `operation.finished` | Exit code, status, deployed flag, optional `autoUpdateStatus` |
| Manager to worker | `metadata.write` | Request ID, stack name, and the full `cetus.json` object |
| Worker to manager | `metadata.written` | Request ID or error |
| Manager to worker | `compose.write` | Request ID, stack name, optional compose text, optional env text, optional base hash |
| Worker to manager | `compose.written` | Request ID, new compose and env text, hashes, or a conflict error |
| Manager to worker | `container.action` | Request ID, container ID, and a start, stop, restart, pause, unpause, or remove action |
| Worker to manager | `container.actioned` | Request ID, command output, or an error |
| Manager to worker | `update-check` | Request ID and a batch of stack names and compose files |
| Worker to manager | `update-check.result` | Request ID and one registry result per stack |
| Manager to worker | `logs.request` | Stack name or container ID, tail count, timestamps, request ID |
| Worker to manager | `logs.response` | Log text or error, request ID |
| Manager to worker | `container.logs.start` | Container ID, tail count, timestamps, request ID |
| Worker to manager | `container.logs.chunk` | Streamed log text for the request ID |
| Manager to worker | `container.logs.stop` | Stop a live container log process |
| Worker to manager | `container.logs.end` | Stream finished |
| Manager to worker | `stack.logs.start` | Stack name, project name, tail count, timestamps, request ID |
| Worker to manager | `stack.logs.chunk` | Streamed Compose log text for the request ID |
| Manager to worker | `stack.logs.stop` | Stop a live stack log process |
| Worker to manager | `stack.logs.end` | Stream finished |
| Manager to worker | `snapshot.request` | Force a fresh snapshot |
| Manager to worker | `registry.auth` | Docker `auths` object for the credentials that target this worker |
| Manager to worker | `worker.self-update` | Operation ID, worker stack, Compose file, and config for a detached self-update |

## What works

- Enrollment with a 15-minute single-use token.
- Reconnect with a stored worker secret.
- Host status and inventory in the manager.
- Remote stack list, services, health, CPU and memory samples.
- Deploy, start, stop, restart, down, and update through the manager.
- Per-service start, stop, and restart through the manager.
- Log reads through the manager, including live container log streams over `container.logs.start`, `container.logs.chunk`, and `container.logs.stop`.
- Live all-service stack logs through `stack.logs.start`, `stack.logs.chunk`, and `stack.logs.stop`. The worker follows `docker compose logs` and streams every service in the stack.
- Remote stack metadata writes, including auto-update schedules, through `metadata.write` and `metadata.written`.
- Remote compose and env edits through `compose.write` and `compose.written`. The worker validates YAML, snapshots the previous compose file under `.cetus/snapshots`, and writes atomically. A stale `baseHash` returns a conflict instead of overwriting.
- Remote stack delete. The worker runs `compose down`, snapshots the compose file, and moves the stack directory to `data/trash` on the worker. The manager removes the index row after the operation succeeds.
- Managed container start, stop, restart, pause, unpause, and remove through `container.action` and `container.actioned`. The worker rejects standalone containers without a Compose project label.
- Remote registry digest checks and scheduled auto-updates through `update-check` and `auto-update`.
- Per-host registry credentials through `registry.auth`. The worker writes `<data>/docker/config.json` with mode `0600`, merges a visible host `~/.docker/config.json` under the Cetus credentials, points `DOCKER_CONFIG` at that directory, and uses it for digest checks and image pulls. The manager sends the full Cetus replacement at enrollment and whenever a credential changes.
- Cetus version reporting. The worker sends `cetusVersion` and `selfUpdateSupported` in its snapshot info, so the host page and dashboard can flag an out-of-date worker.
- Safe worker self-update through `worker.self-update`. The worker identifies its own container, starts a detached helper with a rollback tag and health gate, and reports `operation.finished` after reconnecting.
- Global auto-update includes the hidden `cetus-worker` stack when the worker supports self-update and its version is older than the manager.
- Remote stacks appear in the dashboard, stacks table, host page, and MCP list tools, except the Cetus worker stack itself.

## What is not in this slice

- Remote snapshot listing and restore. `PUT /api/stacks/:id/snapshots/:file/restore` returns `501` for a worker stack, and the remote snapshot list stays empty. The worker still snapshots compose files on save and delete.
- Remote stack exec and remote interactive terminals. The API returns `501` and the UI disables those controls.
- Host shell is not shipped.
- Worker TLS fingerprint pinning. Use `wss://` and a trusted certificate. The enrollment token and worker secret are the only auth factors today.

## Gotchas

- The manager stores a worker stack's compose and env text from the last snapshot. The worker is the source of truth on disk. After a successful `compose.write`, the manager updates its cache from the acknowledgement.
- A worker compose write uses `baseHash` to detect an out-of-band change. A conflict leaves the worker file untouched and returns `409` to the editor.
- A worker delete moves the stack directory to `data/trash` on the worker, not on the manager. Back up the worker data directory if trash needs to survive a host loss.
- A worker command is not idempotent if the WebSocket drops after the command starts. The operation row keeps the error, and the worker sends a fresh snapshot on reconnect.
- The shared image healthcheck exits `0` when `CETUS_MODE=worker`. A worker does not serve HTTP, so probing `/api/health` would mark the container unhealthy and the stack degraded. Liveness over the worker socket is tracked separately with heartbeats.
- A stack whose name or Compose project is `cetus-worker` is hidden from fleet lists, registry sweeps, and bulk updates. Keep the `compose/worker.yaml` project name when changing the worker recipe.
- The manager filters host and stack results for API keys with host or stack targets. Keep `keyRestrictions` and `filterHostsForActor` / `filterStacksForActor` in sync when adding routes.
- The worker shares the Docker socket with its own Cetus container. Do not mount a remote Docker socket over a network.
- A worker running Cetus before the self-update protocol reports no Cetus version and `worker.selfUpdateSupported: false`. Update it once manually with its Compose file. After it reconnects on the new build, the host page offers the update button and the global schedule can update it.
- The worker self-update helper receives the worker's `CETUS_*` environment variables plus `DOCKER_CONFIG`. Keep required Compose interpolation values in the worker environment or its stack `.env` file.
- The worker Docker config contains base64 registry credentials, not sealed values. It can also include a merged host Docker login. Keep the worker data directory private and back it up as a secret.
- Registry auth travels over the worker WebSocket. Use `wss://` outside local development; the manager sends credentials only after the worker authenticates with its secret.

## Related docs

- [Updates](updates.md)
- [Decision log](decisions.md)
- [Docs index](README.md)
