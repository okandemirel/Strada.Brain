/**
 * Host-header validation shared by every HTTP listener (CHN-2 / COR-11).
 *
 * Binding loopback keeps other MACHINES out, but it does not keep other
 * ORIGINS out: DNS rebinding lets a page served under a foreign hostname reach
 * a loopback listener while the browser still treats the exchange as
 * same-origin — so the page can read the answers, and a same-origin GET carries
 * no Origin header for the origin checks to refuse. What such a request cannot
 * change is its `Host` header, which names the foreign hostname. Every listener
 * therefore checks Host first and serves only names it can vouch for:
 *
 *   - `localhost` and IP literals (IPv4, bracketed IPv6), on ANY port. A page
 *     can only be rebound through a DNS name, so an IP literal is never one; and
 *     the port is deliberately not compared, because port mappings
 *     (`-p 4000:3100`), the Vite dev proxy and reverse proxies that forward
 *     `$host` all legitimately present a port other than the bound one.
 *   - operator-configured names: `HTTP_ALLOWED_HOSTS` (comma-separated; a bare
 *     hostname trusts every port, `host:port` exactly one, a full origin its
 *     hostname) plus whatever complete origins the listener already trusts
 *     (`WEB_TRUSTED_ORIGINS`, `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS`). A
 *     container behind a reverse proxy names its public hostname here.
 *   - an ABSENT Host header: every browser sends one, so its absence is a
 *     non-browser client, which reaches the socket directly anyway.
 */

import { isIP } from "node:net";
import type { ServerResponse } from "node:http";

/** The environment variable naming extra hostnames every listener serves. */
export const HTTP_ALLOWED_HOSTS_ENV = "HTTP_ALLOWED_HOSTS";

export interface HostCheckOptions {
  /**
   * Operator-configured hosts: a bare hostname (any port), `host:port` (that
   * port only), or a complete origin (its hostname, any port).
   */
  allowedHosts?: readonly string[];
  /** Complete origins the listener already trusts; their hostnames are served. */
  trustedOrigins?: readonly string[];
}

interface ParsedHost {
  /** Lowercased; an IPv6 literal keeps its brackets. */
  hostname: string;
  /** The explicit port, when the value carried one. */
  port?: string;
}

/**
 * `host[:port]` in the strict shape a browser sends, or undefined. Anything
 * else — userinfo, a path, whitespace inside, an unbracketed IPv6 — is not a
 * Host a legitimate client produces and is refused rather than guessed at.
 */
function parseHost(value: string): ParsedHost | undefined {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i.exec(value.trim());
  if (!match) return undefined;
  const hostname = match[1]!.toLowerCase();
  if (hostname.startsWith("[") && isIP(hostname.slice(1, -1)) !== 6) return undefined;
  return match[2] === undefined ? { hostname } : { hostname, port: match[2] };
}

/** A configured entry: a complete origin names its hostname only. */
function parseConfiguredHost(entry: string): ParsedHost | undefined {
  const trimmed = entry.trim();
  if (trimmed.includes("://")) {
    try {
      const hostname = new URL(trimmed).hostname.toLowerCase();
      return hostname ? { hostname } : undefined;
    } catch {
      return undefined;
    }
  }
  return parseHost(trimmed);
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[")) return isIP(hostname.slice(1, -1)) === 6;
  return isIP(hostname) === 4;
}

/**
 * The comma-separated `HTTP_ALLOWED_HOSTS` list, with malformed entries DROPPED
 * — a typo narrows what is served, it never widens it. A `BIND_HOST` that is a
 * hostname is included too: the operator already named this machine by it.
 */
export function resolveAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...(env[HTTP_ALLOWED_HOSTS_ENV] ?? "").split(","), env["BIND_HOST"] ?? ""]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && parseConfiguredHost(entry) !== undefined);
}

/**
 * Whether a request's Host header names this deployment (see the module
 * comment for the rules). `host` is `req.headers.host`.
 */
export function isAllowedHostHeader(
  host: string | undefined,
  options: HostCheckOptions = {},
): boolean {
  if (host === undefined) return true;
  const parsed = parseHost(host);
  if (!parsed) return false;
  if (parsed.hostname === "localhost" || isIpLiteral(parsed.hostname)) return true;

  for (const entry of options.allowedHosts ?? []) {
    const allowed = parseConfiguredHost(entry);
    if (!allowed || allowed.hostname !== parsed.hostname) continue;
    if (allowed.port === undefined || allowed.port === parsed.port) return true;
  }
  for (const origin of options.trustedOrigins ?? []) {
    if (!origin.includes("://")) continue;
    if (parseConfiguredHost(origin)?.hostname === parsed.hostname) return true;
  }
  return false;
}

/** The refusal every listener sends for a Host it does not serve. */
export function rejectDisallowedHost(
  res: ServerResponse,
  headers: Record<string, string> = {},
): void {
  res.writeHead(403, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: "Host not allowed",
    hint: `This server does not answer for that hostname. If it is legitimate, add it to ${HTTP_ALLOWED_HOSTS_ENV}.`,
  }));
}
