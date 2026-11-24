import { DEFAULT_PALETTE, isPaletteId, type PaletteId } from "@shared/palettes";

const STORAGE_KEY = "cetus-palette-v2";

export function readStoredPalette(): PaletteId {
  if (typeof window === "undefined") return DEFAULT_PALETTE;
  const stored = localStorage.getItem(STORAGE_KEY);
  return isPaletteId(stored) ? stored : DEFAULT_PALETTE;
}

export function applyPalette(palette: PaletteId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.palette = palette;
  localStorage.setItem(STORAGE_KEY, palette);
}

export function applyStoredPalette() {
  applyPalette(readStoredPalette());
}
