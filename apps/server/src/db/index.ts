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
`);
sqlite.exec(CREATE_SQL);

export const db = drizzle(sqlite, { schema });
export { sqlite };
