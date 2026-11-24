# Settings and configuration

Cetus keeps the process environment small. Runtime settings live in SQLite and are edited at `/settings` by an admin with `settings:write`.

## Bootstrap environment

These are the only values that must be set outside the database:

| Variable | Default | Purpose |
|---|---|---|
| `CETUS_PORT` | `3000` | API and web listen port |
| `CETUS_HOST` | `0.0.0.0` | Bind address |
| `CETUS_DATA_DIR` | `./data` | SQLite, auth material, operation logs, trash, backups |
| `CETUS_DB_PATH` | `<data>/cetus.db` | SQLite file override |
| `CETUS_AUTH_SECRET` | generated file | Optional better-auth secret override |
| `CETUS_MASTER_KEY` | generated file | Optional master key override |
| `CETUS_MASTER_KEY_FILE` | `<data>/master.key` | Master key file path |
| `CETUS_ADMIN_EMAIL` | none | Required to seed the first admin when the user table is empty |
| `CETUS_ADMIN_PASSWORD` | none | Required to seed the first admin when the user table is empty |
| `CETUS_MODE` | `manager` | `manager` or `worker` |
| `CETUS_ALLOW_STACKS_DIR_CHANGE` | `false` | Set `true` to unlock the stacks directory when Docker is detected |
| `CETUS_BACKUP_ENABLED` | `true` | Set `false` to disable the daily local backup |
| `CETUS_BACKUP_CRON` | `0 3 * * *` | Five-field backup schedule |
| `CETUS_BACKUP_TIMEZONE` | server timezone | Timezone for the backup cron |
| `CETUS_BACKUP_KEEP` | `11` | Complete backups to retain |
| `CETUS_UPDATE_CHECK_ENABLED` | `true` | Set `false` to disable registry update sweeps |
| `CETUS_AUDIT_RETENTION_DAYS` | `90` | Audit rows older than this are pruned daily |
| `CETUS_NOTIFICATION_RETENTION_DAYS` | `30` | Notification delivery rows older than this are pruned daily |

`CETUS_PUBLIC_URL`, `CETUS_STACKS_DIR`, and `CETUS_TRUST_PROXY` are first-boot fallbacks. Once saved in Settings, the database value wins.

## Database settings

| Setting | Key | Effect |
|---|---|---|
| Public URL | `settings.publicUrl` | Links, worker enrollment URL, auth issuer on next start |
| Stacks directory | `settings.stacksDir` | Local Compose scan root |
| Allowed origins | `settings.allowedOrigins` | Extra CORS and auth origins |
| Trust proxy | `settings.trustProxy` | Honors forwarding headers for audit IPs |

## Users and access

User provisioning is handled at `/settings` on the Access tab by an admin with `users:write`. The page can:

- Create an account with a name, email, role, and temporary password.
- Create a one-time invite link. Cetus stores only a SHA-256 hash of the invite token; the link is shown once and expires after seven days. It opens at `/invite/:token`, where the invitee sets a name and password. No email service is required, so the admin copies the link into chat or email.
- Change a user's name and role, reset a password, and remove an account.
- Revoke a pending invite.

The API enforces the same rules:

| Method | Path | Scope | Behavior |
|---|---|---|---|
| `GET` | `/api/users` | `users:read` | List accounts |
| `POST` | `/api/users` | `users:write` | Create an account with a password |
| `PATCH` | `/api/users/:id` | `users:write` | Update name, role, or password |
| `DELETE` | `/api/users/:id` | `users:write` | Remove an account |
| `GET` | `/api/invites` | `users:read` | List pending invites |
| `POST` | `/api/invites` | `users:write` | Create a one-time invite link |
| `DELETE` | `/api/invites/:id` | `users:write` | Revoke an invite |
| `GET` | `/api/invites/:token` | public | Validate an invite |
| `POST` | `/api/invites/:token/accept` | public | Create the invited account |

Cetus refuses to remove the last admin or let an admin remove their own account. Admins cannot change their own role from the Access tab; another admin must do it. Resetting another user's password signs out their active sessions.

## Appearance

Glacier is the built-in palette. The Appearance tab stores an optional per-user override in `user_preference.palette`, so each account can choose Abyss, Iris, Kelp, Glacier, Bloom, or Ember independently. Clearing the choice returns the account to Glacier.

The login and invite pages apply the last palette used in that browser so the pre-auth screens do not flash the wrong accent. `PUT /api/preferences` updates the signed-in user's choice.

## Authentication

The Authentication tab configures one generic OpenID Connect provider. Password sign-in always remains available as the local break-glass path.

| Setting | Behavior |
|---|---|
| Enable OIDC | Shows the single sign-on button on the login page |
| Button name | Label for the provider button |
| Discovery URL | OpenID configuration document, for example `https://id.example.com/.well-known/openid-configuration` |
| Client ID / secret | OAuth client credentials. The secret is sealed with AES-256-GCM using the instance master key and is never returned to the browser |
| Scopes | Defaults to `openid profile email` |
| Auto-provision | Creates a local account on first successful OIDC sign-in |
| Default role | Role for newly provisioned OIDC accounts |
| Allowed email domains | Optional allowlist for new OIDC accounts |

Register the callback URL shown in the tab with the provider. It is `<publicUrl>/api/auth/callback/oidc`. OIDC provider configuration is read when better-auth starts, so changing these values requires a manager restart. The tab shows a restart banner until the saved values are active. Existing local accounts can link to the provider when the email matches.

`GET /api/auth-config` is public and returns only whether password sign-in is available and the active OIDC button name. The client secret is never exposed.

## Mail

The Mail tab configures outgoing SMTP for invite emails, email notification channels, and test messages.

- Host, port, implicit TLS, username, and password.
- Sender name and sender email.
- The SMTP password is sealed with the instance master key.
- Send test sends a message to the signed-in admin's email.

SMTP changes apply immediately. Failed tests return the transport error in the API response. `POST /api/settings/smtp/test` sends the test to the signed-in admin and requires `settings:write`.

## Notifications

The Notifications tab manages delivery channels and shows the last 30 delivery attempts.

| Channel | Configuration |
|---|---|
| Email | One or more recipients. Uses the Mail tab SMTP transport |
| ntfy | Server URL, topic, and optional access token |
| Webhook | URL and optional bearer token. Cetus posts JSON with `event`, `title`, `message`, `stackId`, `stackName`, and `hostId` |

Each channel can subscribe to `operation.failed`, `operation.success`, and `operation.cancelled`. Leaving every event unchecked subscribes the channel to all events. Access tokens are sealed with the instance master key.

Cetus sends an alert when a deploy, update, lifecycle, or worker operation finishes. The test button sends a sample through the same delivery path. Every attempt is written to `notification_delivery` with `sent` or `failed` and the transport error.

The notification API uses `notifications:read` and `notifications:write`:

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/notifications/channels` | List channels |
| `POST` | `/api/notifications/channels` | Create a channel |
| `PATCH` | `/api/notifications/channels/:id` | Update a channel |
| `DELETE` | `/api/notifications/channels/:id` | Remove a channel |
| `POST` | `/api/notifications/channels/:id/test` | Send a test |
| `GET` | `/api/notifications/deliveries` | Recent delivery log |

## Backups

The Backup tab lists local backups, runs one on demand, downloads an archive, and stages a restore. The schedule and retention are bootstrap values, not Settings fields. See [Backups](backups.md) for archive contents, the restore flow, and the restart boundary.

## Docker path lock

When Docker is detected, the stacks directory is locked to its boot value. This prevents a saved path from pointing outside the mounted `/opt/stacks` tree. Set `CETUS_ALLOW_STACKS_DIR_CHANGE=true` to unlock it. Settings are read before auth is created, so a public URL saved in the UI is the auth issuer after the next restart even when `CETUS_PUBLIC_URL` is absent. On a brand-new database with no saved public URL, Cetus accepts the request's own origin so you can sign in on a LAN address and set the public URL. That bootstrap exception ends as soon as the setting is saved.

## API

`GET /api/settings` requires `settings:read`. `PUT /api/settings` requires `settings:write` and accepts any subset of:

```json
{
  "publicUrl": "https://cetus.example.com",
  "stacksDir": "/opt/stacks",
  "allowedOrigins": ["https://cetus.example.com"],
  "trustProxy": true,
  "oidc": {
    "enabled": true,
    "name": "Sign in with Pocket ID",
    "discoveryUrl": "https://id.example.com/.well-known/openid-configuration",
    "clientId": "cetus",
    "scopes": ["openid", "profile", "email"],
    "autoProvision": true,
    "defaultRole": "viewer",
    "allowedDomains": ["example.com"]
  },
  "smtp": {
    "enabled": true,
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "username": "cetus@example.com",
    "fromName": "Cetus",
    "fromEmail": "cetus@example.com"
  }
}
```

The response includes `changed`, `reindexRequired`, and the normalized settings object. A stacks-directory change does not delete existing rows until a folder scan reindexes them.

## Restart boundaries

- Changing the public URL updates links immediately, but the better-auth issuer is fixed at process start. Restart to apply it.
- OIDC provider configuration is fixed at process start. Save the form, then restart the manager to apply it.
- SMTP and notification channel changes apply immediately.
- Allowed origins update Cetus origin checks immediately. Restart if a proxy or auth provider still rejects a new origin.
- Port, bind address, data directory, database path, and secret files are bootstrap-only.
- User passwords, API keys, hosts, stacks, operations, and audit rows already live in SQLite.

## Related docs

- [Architecture](architecture.md) - request flow, auth, and data ownership
- [API and MCP](api.md) - REST conventions, OpenAPI, and scopes
- [Backups](backups.md) - backup contents and restore
- [Development](development.md) - local setup and test gates
- [Worker mode](worker.md) - worker enrollment and remote hosts
- [Releases](releases.md) - versioning and publishing
- [Docs index](README.md) - documentation map
