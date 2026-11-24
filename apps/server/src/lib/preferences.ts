import { eq } from "drizzle-orm";
import type { PaletteId } from "@shared/palettes.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";

export function getUserPalette(userId: string): PaletteId | null {
  const row = db.select().from(schema.userPreference).where(eq(schema.userPreference.userId, userId)).get();
  return (row?.palette as PaletteId | null | undefined) ?? null;
}

export function setUserPalette(userId: string, palette: PaletteId | null) {
  if (!palette) {
    db.delete(schema.userPreference).where(eq(schema.userPreference.userId, userId)).run();
    return;
  }
  const now = new Date();
  db.insert(schema.userPreference)
    .values({ userId, palette, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.userPreference.userId,
      set: { palette, updatedAt: now },
    })
    .run();
}
