import { describe, expect, test } from "bun:test";
import { autoUpdateDisabledByLabel } from "./updateLabels.ts";

describe("auto-update labels", () => {
  test("honors the Cetus label in map and list form", () => {
    expect(autoUpdateDisabledByLabel({ labels: { "io.zbejas.cetus.update": "false" } })).toBe(true);
    expect(autoUpdateDisabledByLabel({ labels: ["io.zbejas.cetus.update=false"] })).toBe(true);
    expect(autoUpdateDisabledByLabel({ labels: { "io.zbejas.cetus.update": true } })).toBe(false);
  });

  test("falls back to the Watchtower label", () => {
    expect(autoUpdateDisabledByLabel({ labels: { "com.centurylinklabs.watchtower.enable": "false" } })).toBe(true);
    expect(autoUpdateDisabledByLabel({ labels: { "com.centurylinklabs.watchtower.enable": "true" } })).toBe(false);
  });

  test("the Cetus label wins when both are present", () => {
    expect(autoUpdateDisabledByLabel({
      labels: {
        "io.zbejas.cetus.update": "true",
        "com.centurylinklabs.watchtower.enable": "false",
      },
    })).toBe(false);
  });

  test("missing labels leave auto-update on", () => {
    expect(autoUpdateDisabledByLabel({})).toBe(false);
    expect(autoUpdateDisabledByLabel(null)).toBe(false);
  });
});
