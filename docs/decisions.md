# Cetus decision log

- **As of:** 2026-11-24
- **Scope:** product, architecture, security, and delivery decisions locked during planning
- **Status:** decisions are binding for v1 unless a later entry supersedes them

## Product

| # | Decision | Rationale |
|---|---|---|
| P1 | Name is Cetus | Whale-adjacent, short, fits Docker without copying Dockge. |
| P2 | Target user is a homelab operator with 2 to 20 Docker hosts | The first deployment is five LXCs, one manager and four workers. |
| P3 | Compose is the product's center of gravity | The operator wants simple Compose files, not a PaaS or a Kubernetes console. |
| P4 | Compose files live at `/opt/stacks/<stack>/` and must work without Cetus | No lock-in. Files are the source of truth. |
| P5 | Metadata lives in an optional `cetus.json` sidecar | Portable, visible, and never required to run a stack. |
| P6 | Snapshots live in `.cetus/snapshots` inside the stack | History travels with the stack and survives Cetus removal. |
| P7 | Stacks are organized by a flat list with tags, favorites, host chips, and filters | Matches the unified fleet view. No nested folder hierarchy in v1. |
| P8 | The stack page is an overview-first cockpit with editor takeover | Runtime work is daily. Editing is periodic and needs full width. |
| P9 | The stack page keeps one bottom dock for logs, terminal, events, and stats | One visual context, no top-level tab routes. |
| P10 | Multi-host is a unified list with host chips, not a host switcher | The operator wants one fleet view. |
| P11 | Vocabulary is hosts, stacks, services | Docker-native and familiar. |
| P12 | Mobile gets full parity, using sheets and full-screen editors | Operator requested it explicitly. |
| P13 | English only in v1, with strings externalized | Avoids translation workflow scope while keeping the door open. |

## Architecture

| # | Decision | Rationale |
|---|---|---|
| A1 | Bun runtime | Native SQLite, fast startup, built-in PTY, single toolchain. |
| A2 | Elysia backend | Typed routes, OpenAPI, WebSocket, Eden client. |
| A3 | React 19, Vite, TanStack Router and Query, Tailwind v4 | Best ecosystem for the editor, terminal, charts, and complex UI states. |
| A4 | SQLite only, Drizzle ORM, WAL mode | One file, no external service, enough for the target scale. |
| A5 | One image, `manager` and `worker` modes | Simple packaging and version alignment. |
| A6 | Manager also manages its own Docker through a local host adapter | One uniform inventory. The manager host is also a managed host. |
| A7 | Workers dial out over WebSocket | No inbound ports on managed hosts. |
| A8 | Manager is single, no HA in v1 | Avoids distributed coordination and split-brain scope. |
| A9 | Docker Engine API for inventory, events, stats, and df | Efficient and streaming. |
| A10 | `docker compose` CLI for Compose actions | Correct profiles, includes, extends, build, and removal semantics. |
| A11 | Bun.Terminal for PTY sessions | No native `node-pty` build dependency. Verified on Bun 1.4.2 at planning time. |
| A12 | Operations are first-class rows with phases and logs | Progress, retries, audit, and idempotency. |
| A13 | Browser realtime uses a single-use WebSocket ticket | Works with cookie auth and avoids long-lived tokens in URLs. |
| A14 | Monorepo with `apps/web`, `apps/server`, and shared packages | Clear ownership and shared protocol types. |

## Security and access

| # | Decision | Rationale |
|---|---|---|
| S1 | better-auth for users, sessions, and OIDC; passkeys and TOTP are post-v1 | Mature plugin set, fewer custom auth bugs. |
| S2 | Invite-only accounts, no public signup | Self-hosted control plane, small trusted user set. |
| S3 | Roles are admin, operator, viewer | Simple baseline that covers the use case. |
| S4 | Grants narrow a user to specific hosts and stacks | Needed for scoped operators and clients. |
| S5 | API keys are resource + action + optional target | Matches the operator's request and MCP needs. |
| S6 | MCP keys are API keys with an `mcp` audience and MCP scopes | One key system, one audit trail. |
| S7 | MCP exposes the shipped API surface through scopes, including container exec when granted | The operator asked for everything, but scoped. Destructive actions still require confirm. |
| S8 | Full mutation audit with CSV and JSON export and configurable retention | Required for RBAC and shared access to be trustworthy. |
| S9 | Master key file at `data/master.key` with env override | Works in containers and supports orchestrated secrets. |
| S10 | AES-256-GCM for secrets at rest | Standard authenticated encryption. |
| S11 | Worker enrollment uses a short-lived one-time token plus pinned TLS | No inbound ports, no shared long-lived password. |
| S12 | Host shell is not shipped | It requires a privileged worker and is a real host boundary. |
| S13 | Docker rootful only in v1, detect and warn on rootless and Podman | Keeps the support matrix honest. |
| S14 | Destructive stack delete moves the directory to trash | File safety and recoverability. |

## Operations

| # | Decision | Rationale |
|---|---|---|
| O1 | Logs are live with a 2000-line ring per container, no persistence | Keeps the install light and avoids a log database. |
| O2 | Metrics are sampled every 10 seconds and kept for 24 hours, with 1-minute SQLite rollups | Useful history without a time-series database. |
| O3 | Docker events are kept in a 10,000-event ring per host and merged with audit | Useful activity feed without unbounded storage. |
| O4 | Health uses Docker health plus optional HTTP and TCP probes | Covers both container and application health. |
| O5 | Auto-update is opt-in with a fleet default plus per-stack cron, timezone, and service exclusions | Operator control. The default is off, and explicit stack metadata wins. |
| O6 | Failed updates roll back to previous image IDs and alert | Safer than leaving a broken stack running. |
| O7 | Update checks run every 6 hours with cache and jitter | Timely without hammering registries. |
| O8 | Private registries use host Docker config plus encrypted overrides | Works with existing credentials and supports exceptions. |
| O9 | Notifications are per-user with admin defaults | Multi-user routing without a single global firehose. |
| O10 | Channels are ntfy, SMTP, Discord, Slack, Telegram, and generic webhook | Covers the operator's requested set. |
| O11 | Backup is local scheduled plus download and restore | Simple, inspectable, no cloud dependency. |
| O12 | System df is included; guided prune is post-v1 | Prune needs its own preview and confirmation surface. |
| O13 | Standalone containers are inventoried and read-only | The operator wants edits limited to containers and stacks that Cetus owns. Keeps Compose primary and avoids lifecycle changes outside the stack directory. |
| O14 | The Cetus worker stack is hidden from fleet lists, sweeps, and bulk updates | Cetus must not update the process that runs Cetus. Direct stack URLs still work. |
| O15 | Remote stack files use explicit `compose.write` and delete messages with base hash checks | Worker remains the source of truth, and stale edits are rejected instead of overwriting. |

## Delivery

| # | Decision | Rationale |
|---|---|---|
| D1 | Build a working vertical slice first | Proves the core flow before breadth. |
| D2 | First slice is one local host: auth, stacks, editor, deploy, logs, Docker inventory, UI shell | End-to-end value with the least coordination. |
| D3 | Workers come after the local slice and platform security | The protocol needs stable operations and auth. |
| D4 | Updates, health, and alerts come after workers | They depend on fleet state. |
| D5 | MCP and public API polish come after the core flows | The same capability layer is reused. |
| D6 | Testing is unit, real Docker integration, Playwright E2E, and visual regression | Matches the requested quality bar. |
| D7 | CI gates: lint, typecheck, unit, integration, E2E, visual, build | No milestone closes on manual confidence alone. |
| D8 | License is MIT | Permissive, familiar, and compatible with the current dependency set. |
| D9 | No Dockge code is reused | Clean-room implementation. Dockge is product inspiration only. |
| D10 | Non-goals are enforced in v1: no Kubernetes, Swarm, PaaS builds, Postgres, or Traefik requirement | Protects the compose-first promise. |

> Current implementation: unit tests, Playwright E2E, and a local visual and accessibility suite are live. CI runs typecheck, unit tests, web build, and a container build. Lint, Docker integration, CI E2E, and CI visual gates are not implemented yet.

## Superseded decisions

None yet.

## Related docs

- [Competitive comparison](competitive.md)
- [Docs index](README.md)
