export const PALETTES = [
  {
    id: "abyss",
    name: "Abyss",
    note: "Deep teal",
    colors: ["#2dd4bf", "#5eead4", "#0b6b63"],
  },
  {
    id: "iris",
    name: "Iris",
    note: "Violet dusk",
    colors: ["#a78bfa", "#c4b5fd", "#5b21b6"],
  },
  {
    id: "kelp",
    name: "Kelp",
    note: "Seaweed green",
    colors: ["#4ade80", "#86efac", "#166534"],
  },
  {
    id: "glacier",
    name: "Glacier",
    note: "Polar blue",
    colors: ["#38bdf8", "#7dd3fc", "#075985"],
  },
  {
    id: "bloom",
    name: "Bloom",
    note: "Soft coral pink",
    colors: ["#f472b6", "#f9a8d4", "#9d174d"],
  },
  {
    id: "ember",
    name: "Ember",
    note: "Warm orange",
    colors: ["#fb923c", "#fdba74", "#9a3412"],
  },
] as const;

export type PaletteId = (typeof PALETTES)[number]["id"];

export const DEFAULT_PALETTE: PaletteId = "glacier";

const PALETTE_IDS = new Set<string>(PALETTES.map((palette) => palette.id));

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && PALETTE_IDS.has(value);
}

export function paletteName(id: string | null | undefined): string {
  return PALETTES.find((palette) => palette.id === id)?.name ?? "Abyss";
}
