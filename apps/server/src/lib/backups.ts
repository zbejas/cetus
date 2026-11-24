import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import type { BackupSummary } from "@shared/types.ts";
import { config } from "../config.ts";
import { db, sqlite } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { ApiError } from "./errors.ts";

let running = false;

function toSummary(row: typeof schema.backup.$inferSelect): BackupSummary {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    status: row.status,
    error: row.error,
    actorName: row.actorName,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function directorySize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function backupPath(record: BackupSummary) {
  const root = path.resolve(config.backupDir);
  const full = path.resolve(root, record.filename);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(500, "backup_path_invalid", "Backup path is outside the backup directory.");
  }
  return full;
}

export function readPendingRestore(): { backupId?: string; stagedDir?: string } | null {
  const marker = path.join(config.dataDir, ".restore-pending.json");
  if (!fs.existsSync(marker)) return null;
  try {
    return JSON.parse(fs.readFileSync(marker, "utf8")) as { backupId?: string; stagedDir?: string };
  } catch {
    return null;
  }
}

export function recoverInterruptedBackups() {
  const interrupted = db.select().from(schema.backup)
    .where(eq(schema.backup.status, "creating"))
    .all();
  for (const row of interrupted) {
    const dir = path.join(config.backupDir, row.filename);
    if (fs.existsSync(path.join(dir, "cetus.db")) && fs.existsSync(path.join(dir, "manifest.json"))) {
      db.update(schema.backup)
        .set({ status: "complete", size: directorySize(dir), completedAt: new Date(), error: null })
        .where(eq(schema.backup.id, row.id))
        .run();
      continue;
    }
    db.update(schema.backup)
      .set({ status: "failed", error: "The manager stopped while this backup was running.", completedAt: new Date() })
      .where(eq(schema.backup.id, row.id))
      .run();
  }
}

export function listBackups(): BackupSummary[] {
  return db.select().from(schema.backup)
    .orderBy(desc(schema.backup.createdAt))
    .all()
    .map(toSummary);
}

export function getBackup(id: string): BackupSummary | null {
  const row = db.select().from(schema.backup).where(eq(schema.backup.id, id)).get();
  return row ? toSummary(row) : null;
}

function pruneBackups() {
  const pending = readPendingRestore();
  const complete = listBackups().filter((entry) => entry.status === "complete");
  for (const record of complete.slice(config.backupKeep)) {
    if (pending?.backupId === record.id) continue;
    try {
      fs.rmSync(backupPath(record), { recursive: true, force: true });
      db.delete(schema.backup).where(eq(schema.backup.id, record.id)).run();
    } catch (error) {
      console.error("[cetus] could not prune backup", record.filename, error);
    }
  }
}

export async function createBackup(input: { actorName?: string; reason?: string } = {}): Promise<BackupSummary> {
  if (running) throw new ApiError(409, "backup_running", "A backup is already running.");
  running = true;
  const id = crypto.randomUUID();
  const reason = input.reason === "scheduled" ? "scheduled" : "manual";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}-${reason}`;
  const tempDir = path.join(config.backupDir, `.tmp-${id}`);
  const finalDir = path.join(config.backupDir, filename);
  const now = new Date();

  db.insert(schema.backup).values({
    id,
    filename,
    status: "creating",
    actorName: input.actorName ?? "system",
    createdAt: now,
  }).run();

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    const databaseCopy = path.join(tempDir, "cetus.db");
    sqlite.exec(`VACUUM INTO '${databaseCopy.replace(/'/g, "''")}'`);

    for (const name of ["master.key", "auth.secret"]) {
      const source = path.join(config.dataDir, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tempDir, name));
    }

    const stacksRoot = path.resolve(config.stacksDir);
    const dataRoot = path.resolve(config.dataDir);
    const backupRoot = path.resolve(config.backupDir);
    if (dataRoot === stacksRoot || dataRoot.startsWith(`${stacksRoot}${path.sep}`)) {
      throw new ApiError(500, "backup_path_invalid", "The stacks directory must not contain the data directory.");
    }
    const relative = path.relative(backupRoot, stacksRoot);
    const stacksInsideBackups = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    let includesStacks = false;
    if (!stacksInsideBackups && fs.existsSync(stacksRoot)) {
      fs.cpSync(stacksRoot, path.join(tempDir, "stacks"), { recursive: true });
      includesStacks = true;
    }

    fs.writeFileSync(path.join(tempDir, "manifest.json"), `${JSON.stringify({
      format: 1,
      appVersion: config.version,
      createdAt: new Date().toISOString(),
      reason,
      includesDatabase: true,
      includesStacks,
      includesKeys: ["master.key", "auth.secret"].filter((name) => fs.existsSync(path.join(tempDir, name))),
    }, null, 2)}\n`);

    fs.renameSync(tempDir, finalDir);
    const size = directorySize(finalDir);
    db.update(schema.backup)
      .set({ status: "complete", size, completedAt: new Date(), error: null })
      .where(eq(schema.backup.id, id))
      .run();
    pruneBackups();
    return getBackup(id)!;
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    db.update(schema.backup)
      .set({ status: "failed", error: error instanceof Error ? error.message : "Backup failed.", completedAt: new Date() })
      .where(eq(schema.backup.id, id))
      .run();
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "backup_failed", error instanceof Error ? error.message : "Backup failed.");
  } finally {
    running = false;
  }
}

export function deleteBackup(id: string) {
  const record = getBackup(id);
  if (!record) throw new ApiError(404, "backup_not_found", "Backup not found.");
  if (readPendingRestore()?.backupId === id) {
    throw new ApiError(409, "backup_pending_restore", "This backup is staged for restore. Restart the manager or cancel the restore first.");
  }
  fs.rmSync(backupPath(record), { recursive: true, force: true });
  db.delete(schema.backup).where(eq(schema.backup.id, id)).run();
}

export function stageRestore(id: string) {
  const record = getBackup(id);
  if (!record) throw new ApiError(404, "backup_not_found", "Backup not found.");
  if (record.status !== "complete") throw new ApiError(422, "backup_incomplete", "Only a complete backup can be restored.");
  const source = backupPath(record);
  if (!fs.existsSync(path.join(source, "cetus.db"))) {
    throw new ApiError(422, "backup_invalid", "The backup does not contain a Cetus database.");
  }
  if (running) throw new ApiError(409, "backup_running", "Wait for the running backup to finish.");
  const restoreRoot = path.join(config.dataDir, ".restore");
  const stagedDir = path.join(restoreRoot, id);
  fs.rmSync(stagedDir, { recursive: true, force: true });
  fs.mkdirSync(restoreRoot, { recursive: true });
  fs.cpSync(source, stagedDir, { recursive: true });
  const markerPath = path.join(config.dataDir, ".restore-pending.json");
  const marker = {
    backupId: id,
    stagedDir,
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    stacksDir: config.stacksDir,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${markerPath}.tmp`, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${markerPath}.tmp`, markerPath);
  return marker;
}
