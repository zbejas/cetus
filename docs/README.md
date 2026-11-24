# Cetus - Knowledge Base

Cetus is a compose-native fleet control plane for homelabs. This index maps the current engineering docs. Code is the source of truth; when a doc and the code disagree, fix the doc in the same change.

> **How to use this:** start at the root [agent guide](../AGENTS.md) for task routing; this index maps every doc.

## Layout

| Folder | Covers |
|---|---|
| `docs/*.md` | Current subsystem, operations, and contributor docs |

## Docs

| Doc | Covers | Read when |
|---|---|---|
| [architecture.md](architecture.md) | Manager and worker topology, request flow, data ownership, auth, schedulers, frontend routes | Starting any broad work or tracing a request |
| [development.md](development.md) | Local setup, commands, test gates, change workflow, common change map | Setting up the repo or running verification |
| [api.md](api.md) | REST conventions, OpenAPI and the API explorer, MCP tools, scopes, errors | Calling the API or changing routes and tools |
| [backups.md](backups.md) | Backup contents, schedule, retention, download, restore, restart boundary | Changing backup or restore behavior |
| [competitive.md](competitive.md) | Dockge, Dokploy, Portainer, and Cetus compared | You need product positioning or feature justification |
| [decisions.md](decisions.md) | Locked product, architecture, security, and delivery decisions | You need to know why a choice was made |
| [worker.md](worker.md) | Worker enrollment, protocol, current capabilities, and limits | You are connecting a remote Docker host |
| [logs.md](logs.md) | Fleet log viewer behavior, streaming path, and limits | You are working on logs or comparing Dozzle |
| [updates.md](updates.md) | Registry digest checks, auto-update schedules, health gate, rollback, and worker flow | You are working on update checks or scheduled rollouts |
| [settings.md](settings.md) | Bootstrap environment, database settings, users, invites, OIDC, SMTP, notifications, palettes, API, and restart boundaries | You are deploying or changing instance configuration |
| [releases.md](releases.md) | Version bumps, CI, release workflow, GHCR image tags, manual rebuilds | You are shipping or changing release automation |

## Reading paths

| If you are | Read in order |
|---|---|
| New to the project | Root [README](../README.md), then [architecture.md](architecture.md), then [development.md](development.md) |
| Building the backend | [architecture.md](architecture.md), then [api.md](api.md), then [decisions.md](decisions.md) |
| Building the UI | [architecture.md](architecture.md), then [development.md](development.md), then the page under `apps/web/src/pages/` |
| Operating a deployment | [settings.md](settings.md), then [backups.md](backups.md), then the manager and worker compose files |
| Connecting a worker | [worker.md](worker.md), then [architecture.md](architecture.md) |
| Shipping a release | [development.md](development.md), then [releases.md](releases.md) |
| Reviewing scope | [decisions.md](decisions.md), then [competitive.md](competitive.md) |

## Writing docs

- Code wins. Verify every claim against the source before writing it.
- New docs follow the five-section shape: Overview, Key files, How it works, Gotchas & invariants, Related docs.
- Add every new doc to this table and to the root [agent guide](../AGENTS.md) in the same change.
- Keep links relative and resolvable. No absolute local paths. Anchors must match real headings.
- State each cross-cutting fact once in its canonical doc, then link to it. Do not copy the environment or API tables into a second doc.
- Describe current behavior. History belongs in the decision log and release notes.
- Use plain ASCII diagrams and punctuation. No em dashes.
- Do not add private deployment details, real credentials, or internal hostnames beyond the documented local development defaults.

## Related docs

- [Root README](../README.md)
- [Agent guide](../AGENTS.md)
- [Architecture](architecture.md)
- [Development](development.md)
- [API and MCP](api.md)
- [Backups](backups.md)
- [Worker mode](worker.md)
- [Fleet logs](logs.md)
- [Updates](updates.md)
- [Settings](settings.md)
- [Releases](releases.md)
- [Decision log](decisions.md)
