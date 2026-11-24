export const CETUS_UPDATE_LABEL = "io.zbejas.cetus.update";
export const WATCHTOWER_ENABLE_LABEL = "com.centurylinklabs.watchtower.enable";

function labelMap(labels: unknown): Record<string, string> {
  if (!labels) return {};
  if (Array.isArray(labels)) {
    const result: Record<string, string> = {};
    for (const entry of labels) {
      const text = String(entry);
      const index = text.indexOf("=");
      if (index === -1) result[text] = "";
      else result[text.slice(0, index)] = text.slice(index + 1);
    }
    return result;
  }
  if (typeof labels === "object") {
    return Object.fromEntries(
      Object.entries(labels as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }
  return {};
}

function isFalse(value: string | undefined) {
  if (value === undefined) return false;
  return ["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

export function autoUpdateDisabledByLabel(service: Record<string, any> | null | undefined) {
  const labels = labelMap(service?.labels);
  if (CETUS_UPDATE_LABEL in labels) return isFalse(labels[CETUS_UPDATE_LABEL]);
  if (WATCHTOWER_ENABLE_LABEL in labels) return isFalse(labels[WATCHTOWER_ENABLE_LABEL]);
  return false;
}
