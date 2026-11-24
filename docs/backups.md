# Backups and restore

## Overview

Cetus writes local backups under `CETUS_DATA_DIR/backups`. A backup contains a consistent copy of the SQLite database, the master key, the auth secret, and the manager's stack directory. Backups run manually from Settings or on a daily schedule. Restore is staged and applied on the next manager start so the running SQLite handle is never replaced underneath the process.

## Key files

| File | Purpose |
|---|---|
| `apps/server/src/lib/backups.ts` | Create, list, prune, download, delete, and stage restores |
| `apps/server/src/lib/restore.ts` | Apply a staged restore before SQLite opens |
| `apps/server/src/index.ts` | Applies a pending restore before importing config or the app |
| `apps/server/src/lib/scheduler.ts` | Daily backup schedule |
| `apps/server/src/db/schema.ts` | `backup` table |
| `apps/server/src/http/app.ts` | `/api/backups` routes |
| `apps/web/src/pages/Settings.tsx` | Backup tab and restore confirmation |

## How it works

### What a backup contains

```text
data/backups/<timestamp>-<reason>/
  cetus.db
  master.key
  auth.secret
  manifest.json
  stacks/
    <stack>/
      compose.yaml
      .env
      cetus.json
      .cetus/snapshots/
```

The database copy uses SQLite `VACUUM INTO`, so it is consistent while the manager keeps running. Stack files are copied from `CETUS_STACKS_DIR`. The manifest records the app version, creation time, reason, and whether the database, keys, and stacks were included.

Backups do not include remote worker stack files. Workers keep their own files and re-send a snapshot when they reconnect. Back up worker hosts separately if their local files matter.

### Schedule and retention

| Variable | Default | Purpose |
|---|---|---|
| `CETUS_BACKUP_ENABLED` | `true` | Set `false` to disable the daily backup |
| `CETUS_BACKUP_CRON` | `0 3 * * *` | Five-field cron expression |
| `CETUS_BACKUP_TIMEZONE` | server timezone | Timezone used to evaluate the cron expression |
| `CETUS_BACKUP_KEEP` | `11` | Number of complete backups to keep |

The scheduler checks once a minute and runs at most one scheduled backup per 50 minutes. A manual backup waits for the archive to finish before the API responds. Older complete backups are pruned after a new one succeeds. A backup referenced by a staged restore is not pruned.

### API

| Method | Path | Scope | Behavior |
|---|---|---|---|
| `GET` | `/api/backups` | `backup:read` | List backups, newest first |
| `POST` | `/api/backups` | `backup:write` | Run a backup now |
| `GET` | `/api/backups/:id/download` | `backup:read` | Download a `.tar.gz` archive |
| `POST` | `/api/backups/:id/restore` | `backup:write` | Stage a restore; body `{ "confirm": true }` |
| `DELETE` | `/api/backups/:id?confirm=true` | `backup:write` | Remove a backup from disk and the index |

A restore is refused while a running operation exists. The API copies the backup to `data/.restore/<id>` and writes `data/.restore-pending.json`. On the next manager start, `applyPendingRestore`:

1. Copies the current database, keys, and stack directory to `data/restore-previous/<timestamp>` and `data/trash/restore-<timestamp>-stacks`.
2. Replaces the database and, when present, `master.key` and `auth.secret`.
3. Replaces the local stack directory.
4. Removes the staging directory and marker.

The manager serves the SPA and API only after the restore completes. A failed restore stops startup with the marker intact so the operator can inspect the staging directory.

### Settings

The Backup tab shows the archive list, size, status, and actions to download, restore, or delete. Restore requires typing `restore` in the dialog. The tab is visible with `backup:read`; actions need `backup:write`. An API key with host or stack targets is denied because a backup spans the whole instance.

## Gotchas & invariants

- A backup contains the instance master key and auth secret. Treat the archive like a root credential.
- If `CETUS_MASTER_KEY` or `CETUS_AUTH_SECRET` is set in the environment, those values are not in the archive. Keep them in your deployment secrets.
- Backup routes are instance-wide. They reject API keys that carry host or stack targets, even when the key has `backup:read` or `backup:write`.
- Restore replaces the entire local stack directory. The previous directory is moved to `data/trash`, not deleted.
- A restored database reflects the moment of the backup. Changes made after that backup are not replayed, including audit rows and operations.
- The backup row for the archive that was restored is marked complete on the next start when its directory and manifest exist. A crash during backup marks the row failed.
- The scheduler does not catch up missed runs. A manager that is offline at the cron time waits for the next matching minute.
- The stacks directory must not contain the data directory. A backup refuses that layout to avoid copying its own output recursively.
- Backups grow with stack snapshots. Watch disk space on small hosts and lower `CETUS_BACKUP_KEEP` if needed.
- Do not restore across incompatible schema versions without a manager image that can open the old database. The release notes own upgrade compatibility.

## Related docs

- [Settings and configuration](settings.md) - bootstrap environment and restart boundaries
- [Architecture](architecture.md) - data ownership and boot sequence
- [API and MCP](api.md) - scopes and route conventions
- [Releases](releases.md) - image upgrades and rollback context
- [Docs index](README.md) - documentation map
