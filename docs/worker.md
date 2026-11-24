# Worker mode - current slice

Cetus workers are headless processes that dial out to one manager. This slice covers enrollment, live inventory, stack snapshots, deploy and lifecycle commands, and log reads. Remote compose editing, remote delete, and host shell are not enabled.

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
| Manager to worker | `update-check` | Request ID and a batch of stack names and compose files |
| Worker to manager | `update-check.result` | Request ID and one registry result per stack |
| Manager to worker | `logs.request` | Stack name or container ID, tail count, timestamps, request ID |
| Worker to manager | `logs.response` | Log text or error, request ID |
| Manager to worker | `container.logs.start` | Container ID, tail count, timestamps, request ID |
| Worker to manager | `container.logs.chunk` | Streamed log text for the request ID |
| Manager to worker | `container.logs.stop` | Stop a live container log process |
| Worker to manager | `container.logs.end` | Stream finished |
| Manager to worker | `snapshot.request` | Force a fresh snapshot |

## What works

- Enrollment with a 15-minute single-use token.
- Reconnect with a stored worker secret.
- Host status and inventory in the manager.
- Remote stack list, services, health, CPU and memory samples.
- Deploy, start, stop, restart, down, and update through the manager.
- Per-service start, stop, and restart through the manager.
- Log reads through the manager, including live container log streams over `container.logs.start`, `container.logs.chunk`, and `container.logs.stop`.
- Remote stack metadata writes, including auto-update schedules, through `metadata.write` and `metadata.written`.
- Remote registry digest checks and scheduled auto-updates through `update-check` and `auto-update`.
- Remote stacks appear in the dashboard, stacks table, host page, and MCP list tools.

## What is not in this slice

- Remote compose editing and snapshots. `PUT /api/stacks/:id/compose` returns `501 remote_edit_unsupported`.
- Remote delete. Use `down` to stop a remote stack.
- Remote container actions and remote stack exec. The API returns `501` and the UI disables those controls.
- Remote interactive terminals and host shell are not shipped.
- Remote stack-wide live logs. Worker container logs stream live; a whole-stack request returns a one-shot `SNAPSHOT` because the worker protocol does not follow Compose logs yet.
- Worker TLS fingerprint pinning. Use `wss://` and a trusted certificate. The enrollment token and worker secret are the only auth factors today.

## Gotchas

- The manager stores a worker stack's compose and env text from the last snapshot. The worker is the source of truth on disk.
- A worker command is not idempotent if the WebSocket drops after the command starts. The operation row keeps the error, and the worker sends a fresh snapshot on reconnect.
- The manager filters host and stack results for API keys with host or stack targets. Keep `keyRestrictions` and `filterHostsForActor` / `filterStacksForActor` in sync when adding routes.
- The worker shares the Docker socket with its own Cetus container. Do not mount a remote Docker socket over a network.

## Related docs

- [Updates](updates.md)
- [Decision log](decisions.md)
- [Docs index](README.md)
