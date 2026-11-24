import { describe, expect, test } from "bun:test";
import { normalizeRegistry } from "./registries.ts";

describe("registry normalization", () => {
  test("keeps a plain registry hostname", () => {
    expect(normalizeRegistry("ghcr.io")).toEqual({ label: "ghcr.io", key: "ghcr.io" });
    expect(normalizeRegistry("registry.example.com:5000")).toEqual({
      label: "registry.example.com:5000",
      key: "registry.example.com:5000",
    });
  });

  test("strips scheme, trailing slash, and host casing", () => {
    expect(normalizeRegistry("https://GHCR.io/")).toEqual({ label: "ghcr.io", key: "ghcr.io" });
  });

  test("maps Docker Hub aliases to the index endpoint", () => {
    const index = { label: "docker.io", key: "https://index.docker.io/v1/" };
    expect(normalizeRegistry("docker.io")).toEqual(index);
    expect(normalizeRegistry("index.docker.io")).toEqual(index);
    expect(normalizeRegistry("registry-1.docker.io")).toEqual(index);
    expect(normalizeRegistry("https://index.docker.io/v1/")).toEqual(index);
    expect(normalizeRegistry("https://docker.io")).toEqual(index);
  });

  test("rejects empty hosts, paths, and embedded credentials", () => {
    expect(() => normalizeRegistry("")).toThrow("Registry is required.");
    expect(() => normalizeRegistry("ghcr.io/some/path")).toThrow("Registry must be a hostname");
    expect(() => normalizeRegistry("https://user:pass@ghcr.io")).toThrow("Registry must be a hostname");
  });
});
