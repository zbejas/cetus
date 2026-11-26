import { describe, expect, test } from "bun:test";
import { parsePortTokens, publishedPortHref } from "./ports.ts";

const worker = { kind: "worker" as const, localAddress: "misc.lan" };
const local = { kind: "local" as const, localAddress: null };

describe("port links", () => {
  test("parses docker port bindings", () => {
    const ports = parsePortTokens("0.0.0.0:8092->8080/tcp, [::]:8092->8080/tcp, 3000/tcp");
    expect(ports).toHaveLength(3);
    expect(ports[0]).toMatchObject({ bind: "0.0.0.0", published: "8092", target: "8080", protocol: "tcp" });
    expect(ports[1]).toMatchObject({ bind: "[::]", published: "8092", target: "8080", protocol: "tcp" });
    expect(ports[2]).toMatchObject({ raw: "3000/tcp", published: "", protocol: "" });
  });

  test("uses the worker local address for wildcard bindings", () => {
    expect(publishedPortHref({ published: "8092", protocol: "tcp", bind: "0.0.0.0" }, worker, "cetus.example"))
      .toBe("http://misc.lan:8092/");
    expect(publishedPortHref({ published: "8092", protocol: "tcp", bind: "[::]" }, worker, "cetus.example"))
      .toBe("http://misc.lan:8092/");
  });

  test("does not invent a worker address", () => {
    expect(publishedPortHref({ published: "8092", protocol: "tcp" }, { kind: "worker", localAddress: null }, "cetus.example"))
      .toBeNull();
  });

  test("falls back to the page hostname for local hosts", () => {
    expect(publishedPortHref({ published: "8092", protocol: "tcp" }, local, "cetus.example"))
      .toBe("http://cetus.example:8092/");
  });

  test("does not link loopback, UDP, or invalid ports", () => {
    expect(publishedPortHref({ published: "8092", protocol: "tcp", bind: "127.0.0.1" }, worker, "cetus.example"))
      .toBeNull();
    expect(publishedPortHref({ published: "8092", protocol: "udp", bind: "0.0.0.0" }, worker, "cetus.example"))
      .toBeNull();
    expect(publishedPortHref({ published: "70000", protocol: "tcp" }, worker, "cetus.example"))
      .toBeNull();
  });

  test("uses a specific interface binding", () => {
    expect(publishedPortHref({ published: "8092", protocol: "tcp", bind: "192.168.1.5" }, worker, "cetus.example"))
      .toBe("http://192.168.1.5:8092/");
  });

  test("normalizes schemes and IPv6 addresses", () => {
    expect(publishedPortHref(
      { published: "8092", protocol: "tcp" },
      { kind: "worker", localAddress: "https://misc.lan" },
      "cetus.example",
    )).toBe("http://misc.lan:8092/");
    expect(publishedPortHref(
      { published: "8092", protocol: "tcp" },
      { kind: "worker", localAddress: "fe80::1" },
      "cetus.example",
    )).toBe("http://[fe80::1]:8092/");
  });

  test("rejects a local address that includes a port", () => {
    expect(publishedPortHref(
      { published: "8092", protocol: "tcp" },
      { kind: "worker", localAddress: "misc.lan:8080" },
      "cetus.example",
    )).toBeNull();
  });
});
