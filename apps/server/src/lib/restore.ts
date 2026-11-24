import fs from "node:fs";
import path from "node:path";

interface RestoreMarker {
  backupId?: string;
  stagedDir?: string;
  dataDir?: string;
  dbPath?: string;
  stacksDir?: string;
  createdAt?: string;
}

function movePath(source: string, target: string) {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function copyFileAtomic(source: string, target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.restore-${process.pid}`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, target);
}

export async function applyPendingRestore() {
  const dataDir = path.resolve(process.env.CETUS_DATA_DIR ?? path.join(process.cwd(), "data"));
  const markerPath = path.join(dataDir, ".restore-pending.json");
  if (!fs.existsSync(markerPath)) return;

  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as RestoreMarker;
  const stagedDir = path.resolve(String(marker.stagedDir ?? ""));
  const restoreRoot = path.join(dataDir, ".restore");
  if (!stagedDir.startsWith(`${restoreRoot}${path.sep}`)) {
    throw new Error("Pending restore points outside the restore staging directory.");
  }
  const stagedDatabase = path.join(stagedDir, "cetus.db");
  if (!fs.existsSync(stagedDatabase)) {
    throw new Error("Pending restore does not contain cetus.db.");
  }
  const targetDatabase = path.resolve(String(marker.dbPath ?? path.join(dataDir, "cetus.db")));
  if (!path.isAbsolute(targetDatabase)) throw new Error("Pending restore has an invalid database path.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const previousDir = path.join(dataDir, "restore-previous", stamp);
  fs.mkdirSync(previousDir, { recursive: true });
  for (const file of ["cetus.db", "cetus.db-wal", "cetus.db-shm", "master.key", "auth.secret"]) {
    const source = file.startsWith("cetus.db") ? path.join(path.dirname(targetDatabase), file) : path.join(dataDir, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(previousDir, file));
    }
  }

  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${targetDatabase}${suffix}`, { force: true });
  }
  copyFileAtomic(stagedDatabase, targetDatabase);

  for (const file of ["master.key", "auth.secret"]) {
    const source = path.join(stagedDir, file);
    if (fs.existsSync(source)) copyFileAtomic(source, path.join(dataDir, file));
  }

  const stagedStacks = path.join(stagedDir, "stacks");
  const targetStacks = marker.stacksDir ? path.resolve(marker.stacksDir) : null;
  if (fs.existsSync(stagedStacks) && targetStacks) {
    const trash = path.join(dataDir, "trash", `restore-${stamp}-stacks`);
    if (fs.existsSync(targetStacks)) {
      fs.mkdirSync(path.dirname(trash), { recursive: true });
      movePath(targetStacks, trash);
    }
    const staging = `${targetStacks}.restore-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetStacks), { recursive: true });
    fs.cpSync(stagedStacks, staging, { recursive: true, preserveTimestamps: true });
    fs.renameSync(staging, targetStacks);
  }

  fs.rmSync(stagedDir, { recursive: true, force: true });
  fs.rmSync(markerPath, { force: true });
  console.log(`[cetus] restored backup ${marker.backupId ?? "unknown"}; previous database is in ${previousDir}`);
}
