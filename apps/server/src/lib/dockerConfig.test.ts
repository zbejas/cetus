import { describe, expect, test } from "bun:test";
import { mergeDockerConfig } from "./dockerConfig.ts";

describe("docker config merge", () => {
  test("keeps host logins and lets Cetus credentials win", () => {
    const merged = mergeDockerConfig(
      {
        auths: {
          "https://index.docker.io/v1/": { auth: "host" },
          "ghcr.io": { auth: "host-ghcr" },
        },
        credsStore: "desktop",
        credHelpers: { "registry.example.com": "osxkeychain" },
      },
      {
        auths: { "ghcr.io": { auth: "cetus-ghcr" } },
      },
    );
    expect(merged.auths).toEqual({
      "https://index.docker.io/v1/": { auth: "host" },
      "ghcr.io": { auth: "cetus-ghcr" },
    });
    expect(merged.credsStore).toBe("desktop");
    expect(merged.credHelpers).toEqual({ "registry.example.com": "osxkeychain" });
  });

  test("handles missing configs", () => {
    expect(mergeDockerConfig({}, {})).toEqual({ auths: {} });
  });
});
