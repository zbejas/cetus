# Fleet logs

Cetus logs are a clean-room take on the log-viewer category, with Dozzle as the product reference. Dozzle is not installed or embedded. No Dozzle code is copied; Cetus reads Docker logs directly and renders them inside the existing fleet shell.

## What the viewer does

- Tails every local and worker-hosted container over one workspace.
- Switches the default pane in one click, or opens up to four containers in a split view with the per-row new-panel button.
- Searches with plain text or a regular expression, highlights matches, and counts visible lines.
- Filters by detected level: error, warn, info, debug.
- Detects Docker timestamps, strips ANSI escapes, parses Compose service prefixes, and recognizes JSON `level` or `severity` fields.
- Toggles timestamps and line wrapping, pauses without dropping output, jumps back to the live edge, copies, downloads, and clears.
- Uses the full application width on `/logs` and lets any pane fill the workspace with one click. `Show all panes` restores the split view.
- Keeps page actions (`Containers`, `Clear all`) in the shared top bar, so the log workspace starts directly under the app header.
- Keeps a 5,000-line ring buffer per pane. Logs are not written to disk by the viewer.
- Clicking a container replaces the default pane. Hover a container row and use the new-panel button to add another pane. Close panes from the pane header.
- Reconnects a live stream automatically after a network error or clean server close, preserving the lines already on screen.

## Where it appears

| Surface | Behavior |
|---|---|
| `/logs` | Fleet workspace with container picker, split panes, search, and level filters |
| Stack detail | All-service stream or a single service container, with a link to the full workspace |
| Host detail | A container log dialog with a link to the full workspace |
| Dashboard | "Open logs" quick action |
| Command palette | "Logs" navigation entry |

Deep links use `/logs?container=<container-id>&host=<host-id>`. The page accepts short Docker IDs and promotes them to the full ID in the URL.

## Streaming path

| Source | Path |
|---|---|
| Local container | `GET /api/containers/:id/logs/stream` spawns `docker logs -f --tail N --timestamps` and aborts the process when the client disconnects |
| Worker container | Manager sends `container.logs.start` over the worker WebSocket; the worker runs the same Docker command and streams `container.logs.chunk` messages until `container.logs.end` or the manager sends `container.logs.stop` |
| Local stack | `GET /api/stacks/:id/logs/stream` follows `docker compose logs` |
| Worker stack, all services | Manager sends `stack.logs.start`; the worker follows `docker compose logs` and streams `stack.logs.chunk` messages until `stack.logs.end` or the manager sends `stack.logs.stop` |
| Worker stack, one service | Live container stream for that service |

`GET /api/logs/sources` returns the flattened container list with host, stack, service, state, and image. `logs:read` is required. API-key host and stack targets are enforced on the source list and on every stream.

## Deliberate limits

- Logs are not persisted, indexed, or searchable after the pane is closed. There is no SQL engine, alerting, or webhook matching.
- The viewer has no terminal. Stack exec remains a separate, non-interactive console.
- A stopped container ends its stream after the tail and stays on `ENDED`. Live container and stack streams retry network errors up to eight times with backoff, and retry a clean close up to three times while the source still reports running. Each retry re-reads a small tail and drops already-seen timestamps.
- The log workspace is one page per browser session. Split panes are not saved to the server.
- The `/logs` page removes the shared `1680px` content cap so the source list and log panes use the whole window. Other pages keep the cap.
- Pane focus is a layout state, not browser fullscreen. `Show all panes` or closing the focused pane returns to the split view.

## Related docs

- [Worker mode](worker.md)
- [Decision log](decisions.md)
