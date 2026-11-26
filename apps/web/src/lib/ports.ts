import type { HostSummary } from "@shared/types";

export interface ParsedPort {
  raw: string;
  bind: string | null;
  published: string;
  target: string;
  protocol: string;
}

const WILDCARD_BINDS = new Set(["", "0.0.0.0", "::", ":::", "[::]", "*"]);
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function parsePortTokens(raw: string): ParsedPort[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(.*?)(\d+)->(\d+)\/([a-z]+)$/i);
      if (!match) return { raw: token, bind: null, published: "", target: "", protocol: "" };
      return {
        raw: token,
        bind: match[1].replace(/:$/, "").trim() || null,
        published: match[2],
        target: match[3],
        protocol: match[4].toLowerCase(),
      };
    });
}

export function publishedPortHref(
  port: { published: string; protocol: string; bind?: string | null },
  host: Pick<HostSummary, "kind" | "localAddress">,
  pageHostname: string,
): string | null {
  if (port.protocol !== "tcp" || !/^\d+$/.test(port.published)) return null;
  const published = Number(port.published);
  if (!Number.isInteger(published) || published < 1 || published > 65535) return null;

  const bind = (port.bind ?? "").trim().replace(/:$/, "");
  if (LOOPBACK_BINDS.has(bind)) return null;
  const address = bind && !WILDCARD_BINDS.has(bind)
    ? bind
    : host.localAddress?.trim() || (host.kind === "local" ? pageHostname : "");
  if (!address) return null;

  return httpUrl(address, published);
}

function httpUrl(address: string, port: number): string | null {
  let host = address.trim();
  if (!host) return null;
  if (/^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\/.*$/, "").replace(/^\[/, "").replace(/\]$/, "");
  if (!host || /[\s/@?#]/.test(host)) return null;

  const formatted = host.includes(":") ? `[${host}]` : host;
  try {
    const url = new URL(`http://${formatted}:${port}`);
    if (url.protocol !== "http:" || !url.hostname || url.port !== String(port)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
