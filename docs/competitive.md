# Competitive comparison - Dockge, Dokploy, Portainer, Cetus

- **As of:** 2026-11-24
- **Sources:** cloned repositories and GitHub API at the date above
- **Purpose:** decide what to learn, what to avoid, and where Cetus can win

## Snapshot

| | Dockge | Dokploy | Portainer CE | Cetus |
|---|---|---|---|---|
| Repository | [louislam/dockge](https://github.com/louislam/dockge) | [Dokploy/dokploy](https://github.com/Dokploy/dokploy) | [portainer/portainer](https://github.com/portainer/portainer) | new |
| Stars | 24.9k | 38.7k | 38.9k | new |
| License | MIT | Apache 2.0 plus source-available `/proprietary` | zlib | MIT |
| Core model | Folder-first Compose manager | PaaS on Docker and Traefik | Broad container management | Compose-native fleet control |
| Backend | Node, Express, Socket.IO | TypeScript, Next.js, tRPC, Drizzle, Postgres | Go | Bun, Elysia |
| Frontend | Vue 3, Bootstrap 5 | React, Tailwind | React | React 19, TanStack, Tailwind |
| Storage | SQLite | Postgres | BoltDB | SQLite |
| Multi-host | Agents log into another Dockge | Docker Swarm and SSH servers | Agents and Edge agents | Headless outbound workers |
| Install weight | One container | Postgres, Traefik, app, workers | One container or agent | One container per host |
| Activity | Low, last push 2026-10-23 | Very high, last push 2026-11-24 | High, last push 2026-11-23 | new |

## Feature matrix

Legend: Yes, No, Partial. The Cetus column reflects the current working slice and marks remaining gaps.

| Capability | Dockge | Dokploy | Portainer CE | Cetus |
|---|---|---|---|---|
| Compose files visible on disk | Yes | No, stored in Postgres | Partial, stack content in its own store | Yes |
| Compose files usable without the app | Yes | No | Partial | Yes |
| Folder per stack | Yes | No | No | Yes |
| Sidecar metadata | No | No | No | Yes, `cetus.json` |
| Compose editor | Yes | Yes | Yes | Yes, schema-aware |
| Compose validation | Syntax only | Partial | Yes | Schema plus `docker compose config` |
| Pre-deploy diff | No | Partial | Partial | Yes |
| Snapshots and restore | No | Deployment rollback | Partial | Yes, beside the stack |
| Profiles | No | Partial | Partial | Yes |
| Override files | Partial | Partial | Partial | Yes |
| Multi-host single pane | Partial | Yes, Swarm | Yes | Yes, unified plus host chips |
| Outbound-only workers | No, manager logs in | Partial, SSH | Partial, Edge with limits | Yes |
| No inbound ports on workers | No | No | Edge only | Yes |
| Email and password | Yes | Yes | Yes | Yes |
| Passkeys | No | Yes, better-auth | No | Post-v1 |
| TOTP 2FA | Yes | Yes | Yes | Post-v1 |
| OIDC or SSO | No | Yes | Partial, OAuth in CE, SSO in BE | Yes, generic OIDC |
| LDAP | No | Partial | Yes | Deferred |
| Multi-user | Partial | Yes | Yes | Yes |
| RBAC | No | Yes, organization roles | Business only | Yes, roles plus grants |
| Per-host and per-stack grants | No | Partial | Business only | Yes |
| Audit log | No | Yes | Business only | Yes, full and exportable |
| REST API | No, Socket.IO only | Yes, tRPC and OpenAPI | Yes | Yes, OpenAPI |
| API keys | No | Yes, better-auth | Yes | Yes, scoped |
| Scoped API keys with targets | No | Partial, metadata | No, user-level keys | Yes, resource, action, target |
| MCP server | No | Not found in cloned tree | No | Yes |
| Image update detection | No | Partial, Git and registry | Partial | Yes |
| Auto-update schedule | No | Yes | No | Yes, fleet default plus per-stack overrides |
| Health-gated rollback | No | Partial, deployment rollback | No | Yes |
| Docker container inventory | Partial | Yes | Yes | Yes |
| Standalone container management | No | Yes | Yes | Yes |
| Images, volumes, networks | No | Yes | Yes | Inventory |
| System df and prune | No | Partial | Yes | System df only |
| Docker events stream | No | Partial | Yes | Yes |
| Live logs | Yes | Yes | Yes | Yes |
| Metrics history | No, live stats only | External integrations | Live stats plus Prometheus | 24h local plus rollups |
| HTTP and TCP health probes | No | Partial | Partial | Yes |
| Notifications | No | Yes, many | Partial, webhooks | Email, ntfy, webhook |
| Scheduled backups | No | Yes | Yes | Yes |
| Themes | Dark and light | Dark and light | Dark and light | Dark, light, system |
| Mobile | Partial | Partial | Partial | Full parity |
| Paid feature gating | No | Proprietary directories | Yes, CE versus BE | No |
| Default install includes Postgres and Traefik | No | Yes | No | No |

## Dockge

### What it gets right

- The compose file is the product. Folder per stack, `.env` beside it, no lock-in.
- The stack page is immediately understandable: containers, actions, YAML, logs, terminal.
- Live output for pull, up, down, and restart.
- `docker run` to Compose conversion.
- Small codebase with a clear mental model.
- MIT license and a large audience.

### Where it falls short

- Everything is a Socket.IO event with callbacks. No REST, OpenAPI, API keys, or MCP.
- Authentication is a custom JWT with a single user model. No roles, grants, audit, or SSO.
- Agent mode stores the remote instance's username and password and logs in as a user. It requires the remote instance to expose the full UI.
- Status logic treats one exited one-shot container as an exited stack. This is the top user complaint.
- No images, volumes, networks, events, inspect, or registry update detection.
- Bootstrap UI with no component system, weak mobile, no command palette, no bulk actions.
- Low maintenance activity. The project is not archived, but it is not moving quickly.

### What Cetus takes

- File-first stack ownership.
- The simple stack page as a starting point, then improve it with the overview-first cockpit.
- Live operation output.
- The composerize import flow.
- The principle that compose files must survive the tool.

### What Cetus refuses

- Socket-only API.
- Stored remote user passwords.
- One-role auth with no audit.
- A permanent two-pane split that makes both the editor and runtime shallow.
- Treating a container exit as a stack failure without service intent.

## Dozzle

Dozzle is not a fleet manager. It is the reference for the live log surface: real-time tails, regex search, split screen, JSON detection, multi-host agents, and no log storage. Cetus borrows the product shape, not the code.

### What Cetus takes

- Grouped container picker by host and Compose project.
- Up to four live panes with independent controls.
- Plain-text and regex search with highlighting, level filters, timestamps, wrapping, pause/resume, copy, and download.
- Docker timestamp and ANSI parsing plus JSON level detection.
- Worker-hosted container streams over the existing outbound socket.
- A 5,000-line in-memory ring buffer per pane, no persistence.

### What Cetus refuses

- Installing or embedding Dozzle, or copying its Vue code.
- Dozzle's SQL engine, alerts/webhooks, Cloud service, app-icon catalog, and shell surface.
- A separate log product with its own auth and navigation. Logs are a first-class fleet surface.

## Dokploy

### What it gets right

- Very active and fast-moving.
- Deploy phases and clear deployment history.
- Better-auth with passkeys, API keys, SSO, and SCIM already wired.
- Audit log schema and organization roles.
- Notifications across many channels.
- Registry, backup, database, and template features.
- Real-time monitoring and external logs and metrics integrations.
- A strong PaaS workflow for application source deployments.

### Where it falls short for a Compose operator

- Compose is a feature inside a PaaS, not the organizing model. Compose content lives in Postgres, not in a user-visible folder.
- The default install bundles Postgres and Traefik. That is a lot of infrastructure for five LXCs that already run Compose.
- Multi-node is Docker Swarm, not per-host Compose files.
- The UI and data model are built around projects, environments, applications, databases, and domains. A pure Compose operator pays for concepts they do not use.
- The repository mixes Apache 2.0 code with a source-available `/proprietary` directory. That is a licensing boundary to watch.
- No MCP server references were found in the cloned tree on 2026-11-24, although the MCP SDK appears in dependency overrides.
- Large surface area means more upgrade risk and more settings to ignore.

### What Cetus takes

- Phase-based deploy progress.
- Audit log shape and event vocabulary.
- The better-auth plugin set as validation that passkeys, API keys, SSO, and SCIM are practical.
- Notification breadth.
- The idea of a deployment history with a clear from and to state.

### What Cetus refuses

- Compose in a database.
- A required Postgres and Traefik stack.
- Swarm as the multi-host answer.
- PaaS concepts as the primary navigation.
- Proprietary feature boundaries.

## Portainer CE

### What it gets right

- Broad Docker inventory: containers, images, volumes, networks, stacks, registries, events.
- Mature Go backend and a long operational history.
- Edge agents that dial out, which is the right shape for remote hosts.
- API keys, OAuth, LDAP, and a documented API.
- Templates, GitOps, and Kubernetes for users who need them.
- Strong host and environment model.

### Where it falls short for a Compose operator

- Compose is one section in a large management product. It is not the center of the UI.
- RBAC, audit, SSO, GitOps, and advanced edge management are Business Edition features. CE is explicitly positioned as non-production and unsupported.
- The UI is dense and enterprise-shaped. Simple Compose work takes more clicks.
- Stacks are stored by Portainer, not as a user-visible folder of compose files.
- No MCP server found in the cloned tree.
- Kubernetes, Swarm, and ACI concepts add navigation weight that a Compose-only homelab does not need.
- The CE versus BE boundary makes "free and complete" hard to trust.

### What Cetus takes

- Host inventory depth.
- Edge and worker concepts.
- API keys, registries, and audit.
- The lesson that operators want one place to see every container, not just Compose projects.
- The lesson that outbound agents are the right default for remote hosts.

### What Cetus refuses

- CE versus BE feature gating for security features.
- Menu sprawl.
- Compose as a second-class section.
- A database-owned stack model.
- Kubernetes and Swarm scope in v1.

## Where Cetus wins

1. **Compose-first, file-first.** The only product in this comparison where the compose folder is the product and the database is an index.
2. **Free platform features.** RBAC, audit, OIDC, scoped keys, backups, and MCP are not a paid tier.
3. **Outbound workers with no inbound ports.** Simpler than Dockge agents and lighter than Portainer Edge plus BE licensing.
4. **A focused stack cockpit.** Runtime first, editor one key away, one dock for logs, terminal, events, and stats.
5. **One capability model for UI, REST, and MCP.** The same scopes and targets everywhere.
6. **Health-gated auto-update with rollback.** A concrete operational win that neither Dockge nor Portainer CE offers.
7. **Small install.** One container, SQLite, no Postgres, no Traefik requirement.

## Where Cetus must be careful

- Dokploy is far more active and has more features. Cetus cannot win on breadth.
- Portainer has years of edge cases, registries, and enterprise trust. Cetus cannot win on maturity.
- Dockge has a loved simple UI. Cetus must not make the stack page harder to read in the name of modernization.
- Every added feature weakens the compose-first promise. The non-goals list is a product feature.

## Sources

- [Dockge repository](https://github.com/louislam/dockge)
- [Dokploy repository](https://github.com/Dokploy/dokploy)
- [Portainer repository](https://github.com/portainer/portainer)
- [Portainer CE versus BE](https://www.portainer.io/features)
- [Dokploy documentation](https://docs.dokploy.com)
- [Dozzle repository](https://github.com/amir20/dozzle)
- [Dozzle documentation](https://dozzle.dev/)

## Related docs

- [Decision log](decisions.md)
- [Docs index](README.md)
