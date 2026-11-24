import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { config } from "../config.ts";
import * as schema from "./schema.ts";
import { CREATE_SQL } from "./sql.ts";

const sqlite = new Database(config.dbPath, { create: true });
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -32768;
  PRAGMA mmap_size = 134217728;
  PRAGMA temp_store = MEMORY;
  PRAGMA wal_autocheckpoint = 1000;
  PRAGMA journal_size_limit = 67108864;
`);
sqlite.exec(CREATE_SQL);

export function runDatabaseMaintenance() {
  sqlite.exec("PRAGMA analysis_limit = 400; PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);");
}

runDatabaseMaintenance();

export const db = drizzle(sqlite, { schema });
export { sqlite };
