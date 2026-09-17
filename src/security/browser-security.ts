/**
 * Browser security utilities for URL validation and rate limiting.
 *
 * Provides:
 * - URL validation with configurable allow/block lists
 * - Domain blocking (localhost, private IPs, file://)
 * - Resolved-target SSRF policy (`assertPublicTarget`, `isForbiddenAddress`):
 *   classifies the addresses a hostname actually resolves to, not the
 *   hostname string (plan 0-B.6 / audit 13F1 / D63, 4.6 / 13F2 / D64)
 * - The ONE address-pinned HTTP transport (`fetchWithPolicy`): every hop of a
 *   redirect chain is vetted by the policy and its TCP connection goes to the
 *   vetted addresses only (Codex round 6 #11/#12: shared by web_fetch_url, the
 *   browser's document requests and its fallback downloads)
 * - Rate limiting for browser operations
 * - Security configuration management
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { getLogger } from "../utils/logger.js";

// ---------- Types ----------

export interface BrowserSecurityConfig {
  /** Allowed URL patterns (regex strings). Empty = allow all (except blocked). */
  allowedUrlPatterns: string[];
  /** Blocked URL patterns (regex strings). Takes precedence over allowed. */
  blockedUrlPatterns: string[];
  /** Block localhost/private network access. */
  blockLocalhost: boolean;
  /** Block file:// protocol. */
  blockFileProtocol: boolean;
  /** Block data:// protocol. */
  blockDataProtocol: boolean;
  /** Block javascript:// protocol. */
  blockJavascriptProtocol: boolean;
  /** Max page navigation time in ms. */
  maxNavigationTimeMs: number;
  /** Max screenshot size in MB. */
  maxScreenshotSizeMb: number;
  /** Max download size in MB. */
  maxDownloadSizeMb: number;
  /** Max concurrent browser sessions. */
  maxConcurrentSessions: number;
  /** Max operations per minute per session. */
  maxOperationsPerMinute: number;
}

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

// ---------- Default Configuration ----------

export const DEFAULT_SECURITY_CONFIG: BrowserSecurityConfig = {
  allowedUrlPatterns: [],
  blockedUrlPatterns: [
    // Common admin panels
    "\\/admin",
    "\\/wp-admin",
    "\\/phpmyadmin",
    "\\/server-status",
    // Internal paths
    "\\.git\\/",
    "\\.env",
    "\\.ssh\\/",
    "\\/etc\\/",
    "\\/proc\\/",
    "\\/sys\\/",
  ],
  blockLocalhost: true,
  blockFileProtocol: true,
  blockDataProtocol: true,
  blockJavascriptProtocol: true,
  maxNavigationTimeMs: 30000,
  maxScreenshotSizeMb: 10,
  maxDownloadSizeMb: 50,
  maxConcurrentSessions: 5,
  maxOperationsPerMinute: 60,
};

const REBINDING_HOST_SUFFIXES = [
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "localhost.direct",
];

// ---------- URL Validation ----------

/**
 * Validates a URL against security configuration.
 */
export function validateUrlWithConfig(
  url: string,
  config: Partial<BrowserSecurityConfig> = {}
): UrlValidationResult {
  const mergedConfig = { ...DEFAULT_SECURITY_CONFIG, ...config };
  const logger = getLogger();

  try {
    const parsedUrl = new URL(url);

    // Check protocol restrictions
    if (mergedConfig.blockFileProtocol && parsedUrl.protocol === "file:") {
      return { valid: false, reason: "file:// protocol is blocked" };
    }

    if (mergedConfig.blockDataProtocol && parsedUrl.protocol === "data:") {
      return { valid: false, reason: "data:// protocol is blocked" };
    }

    if (mergedConfig.blockJavascriptProtocol && parsedUrl.protocol === "javascript:") {
      return { valid: false, reason: "javascript:// protocol is blocked" };
    }

    // Only allow http/https for navigation (unless file is explicitly allowed)
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      if (parsedUrl.protocol === "file:" && !mergedConfig.blockFileProtocol) {
        // file:// allowed via config
      } else {
        return { valid: false, reason: `Protocol "${parsedUrl.protocol}" is not allowed` };
      }
    }

    // Check localhost/private network
    if (mergedConfig.blockLocalhost) {
      const hostname = parsedUrl.hostname.toLowerCase();
      const normalizedHostname = hostname.replace(/^\[|\]$/g, "");

      // Block localhost variants
      if (
        normalizedHostname === "localhost" ||
        normalizedHostname === "127.0.0.1" ||
        normalizedHostname === "0.0.0.0" ||
        normalizedHostname === "::1" ||
        normalizedHostname.endsWith(".localhost") ||
        normalizedHostname.endsWith(".local")
      ) {
        return { valid: false, reason: "Localhost access is blocked" };
      }

      if (REBINDING_HOST_SUFFIXES.some((suffix) =>
        normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`))) {
        return { valid: false, reason: "DNS rebinding host is blocked" };
      }

      // Block private IP ranges
      if (isPrivateIp(normalizedHostname)) {
        return { valid: false, reason: "Private IP range access is blocked" };
      }
    }

    // Check blocked patterns
    for (const pattern of mergedConfig.blockedUrlPatterns) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(url)) {
          return { valid: false, reason: `URL matches blocked pattern: ${pattern}` };
        }
      } catch {
        logger.warn(`Invalid blocked URL pattern: ${pattern}`);
      }
    }

    // Check allowed patterns (if any defined)
    if (mergedConfig.allowedUrlPatterns.length > 0) {
      let matched = false;
      for (const pattern of mergedConfig.allowedUrlPatterns) {
        try {
          const regex = new RegExp(pattern, "i");
          if (regex.test(url)) {
            matched = true;
            break;
          }
        } catch {
          logger.warn(`Invalid allowed URL pattern: ${pattern}`);
        }
      }
      if (!matched) {
        return { valid: false, reason: "URL does not match any allowed pattern" };
      }
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `Invalid URL: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Check if a hostname is an IP literal that lands in a forbidden range.
 * Plain hostnames (not literals) return false here — they are handled by the
 * resolved-target policy (`assertPublicTarget`), which classifies what the
 * name actually resolves to.
 */
function isPrivateIp(host: string): boolean {
  const literal = normalizeIpLiteral(host);
  return literal !== null && isForbiddenAddress(literal);
}

// ---------- Resolved-target policy (plan 0-B.6 / 13F1 / D63, 4.6 / 13F2 / D64) ----------
//
// The hostname string is not the connection target. A public-looking name can
// resolve to 127.0.0.1 / 10.0.0.1 / 169.254.169.254 / fd00::1, a rebinding host
// can answer differently on the second lookup, a redirect can point inside, and
// IPv4 has decimal / hex / octal / short spellings. The ONE policy below parses
// the URL, normalises every literal spelling, resolves the name, and refuses if
// ANY resolved address is in a forbidden class. Callers apply it to the initial
// URL, to every redirect hop, and (browser) to every request and navigation.

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable resolver (tests); defaults to `dns.lookup({ all: true })`. */
export type TargetResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PublicTargetOptions {
  resolver?: TargetResolver;
}

export interface ResolvedTarget {
  /** Parsed URL (WHATWG-normalised). */
  url: URL;
  /** Lowercased hostname without IPv6 brackets. */
  hostname: string;
  /** Every address the hostname resolved to (or the literal itself). All are public. */
  addresses: ResolvedAddress[];
}

export class ForbiddenTargetError extends Error {
  readonly code = "FORBIDDEN_TARGET";
  readonly url: string;
  readonly address: string | undefined;

  constructor(message: string, url: string, address?: string) {
    super(message);
    this.name = "ForbiddenTargetError";
    this.url = url;
    this.address = address;
  }
}

export const defaultTargetResolver: TargetResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * Parse one IPv4 "part" the way the WHATWG URL parser does: `0x..` hex,
 * leading-zero octal, otherwise decimal. Returns null on garbage.
 */
function parseIpv4Part(part: string): number | null {
  if (part === "") return null;
  let radix = 10;
  let digits = part;
  if (/^0[xX]/.test(part)) {
    radix = 16;
    digits = part.slice(2);
    if (digits === "") return null;
    if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  } else if (part.length > 1 && part.startsWith("0")) {
    radix = 8;
    digits = part.slice(1);
    if (!/^[0-7]+$/.test(digits)) return null;
  } else if (!/^[0-9]+$/.test(part)) {
    return null;
  }
  const value = parseInt(digits, radix);
  return Number.isFinite(value) ? value : null;
}

/**
 * Normalise every IPv4 spelling (dotted decimal, hex `0x7f000001`, octal
 * `0177.0.0.1`, decimal `2130706433`, short `127.1` / `127.0.1`) to a
 * canonical dotted quad. Returns null if the input is not an IPv4 literal.
 */
export function parseIpv4Literal(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    const v = parseIpv4Part(part);
    if (v === null) return null;
    values.push(v);
  }
  // All but the last part must fit in one octet; the last fills the rest.
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i]! > 255) return null;
  }
  const last = values[values.length - 1]!;
  const remaining = 4 - (values.length - 1);
  if (last >= 256 ** remaining) return null;
  let n = 0;
  for (let i = 0; i < values.length - 1; i++) {
    n = n * 256 + values[i]!;
  }
  n = n * 256 ** remaining + last;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Parse an IPv6 literal into 8 hextets. Handles `::` compression, embedded IPv4 tails and zone ids. */
function parseIpv6(host: string): number[] | null {
  let text = host;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return null;

  const doubleColon = text.indexOf("::");
  if (doubleColon !== -1 && text.indexOf("::", doubleColon + 1) !== -1) return null;

  const toGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const raw = segment.split(":");
    const groups: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const g = raw[i]!;
      if (g.includes(".")) {
        // Embedded IPv4 must be the final group.
        if (i !== raw.length - 1) return null;
        const v4 = parseIpv4Literal(g);
        if (v4 === null || g.split(".").length !== 4) return null;
        const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  if (doubleColon === -1) {
    const groups = toGroups(text);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = toGroups(text.slice(0, doubleColon));
  const tail = toGroups(text.slice(doubleColon + 2));
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function formatIpv6(groups: number[]): string {
  return groups.map((g) => g.toString(16)).join(":");
}

/**
 * Normalise an IP literal (any IPv4 spelling, IPv6 with or without brackets /
 * zone id) to a canonical string. Returns null for non-literal hostnames.
 */
export function normalizeIpLiteral(host: string): string | null {
  const trimmed = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (trimmed === "") return null;
  if (trimmed.includes(":")) {
    const groups = parseIpv6(trimmed);
    return groups ? formatIpv6(groups) : null;
  }
  return parseIpv4Literal(trimmed);
}

function ipv4ToNumber(quad: string): number {
  const [a, b, c, d] = quad.split(".").map(Number) as [number, number, number, number];
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

function inCidr4(n: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((ipv4ToNumber(base) & mask) >>> 0);
}

/** Reason an IPv4 address (canonical dotted quad) is forbidden, or null if public. */
function classifyIpv4(quad: string): string | null {
  const n = ipv4ToNumber(quad);
  if (inCidr4(n, "0.0.0.0", 8)) return "unspecified (0.0.0.0/8)";
  if (inCidr4(n, "10.0.0.0", 8)) return "private (10.0.0.0/8)";
  if (inCidr4(n, "100.64.0.0", 10)) return "carrier-grade NAT (100.64.0.0/10)";
  if (inCidr4(n, "127.0.0.0", 8)) return "loopback (127.0.0.0/8)";
  if (inCidr4(n, "169.254.0.0", 16)) return "link-local (169.254.0.0/16)";
  if (inCidr4(n, "172.16.0.0", 12)) return "private (172.16.0.0/12)";
  if (inCidr4(n, "192.0.0.0", 24)) return "reserved (192.0.0.0/24)";
  if (inCidr4(n, "192.0.2.0", 24)) return "documentation (192.0.2.0/24)";
  if (inCidr4(n, "192.168.0.0", 16)) return "private (192.168.0.0/16)";
  if (inCidr4(n, "198.18.0.0", 15)) return "benchmark (198.18.0.0/15)";
  if (inCidr4(n, "198.51.100.0", 24)) return "documentation (198.51.100.0/24)";
  if (inCidr4(n, "203.0.113.0", 24)) return "documentation (203.0.113.0/24)";
  if (inCidr4(n, "224.0.0.0", 4)) return "multicast (224.0.0.0/4)";
  if (inCidr4(n, "240.0.0.0", 4)) return "reserved / broadcast (240.0.0.0/4)";
  return null;
}

/** Reason an IPv6 address (8 hextets) is forbidden, or null if public. */
function classifyIpv6(g: number[]): string | null {
  const embeddedV4 = (hi: number, lo: number): string =>
    [hi >>> 8, hi & 255, lo >>> 8, lo & 255].join(".");
  const allZeroUpTo = (count: number): boolean => g.slice(0, count).every((x) => x === 0);

  if (allZeroUpTo(8)) return "unspecified (::)";
  if (allZeroUpTo(7) && g[7] === 1) return "loopback (::1)";
  // IPv4-mapped ::ffff:a.b.c.d — classify the embedded IPv4.
  if (allZeroUpTo(5) && g[5] === 0xffff) {
    const v4 = embeddedV4(g[6]!, g[7]!);
    const reason = classifyIpv4(v4);
    return reason ? `IPv4-mapped ${v4}: ${reason}` : null;
  }
  // IPv4-compatible ::a.b.c.d (deprecated) — classify the embedded IPv4.
  if (allZeroUpTo(6)) {
    const v4 = embeddedV4(g[6]!, g[7]!);
    const reason = classifyIpv4(v4);
    return reason ? `IPv4-compatible ${v4}: ${reason}` : null;
  }
  // NAT64 64:ff9b::/96 — classify the embedded IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const v4 = embeddedV4(g[6]!, g[7]!);
    const reason = classifyIpv4(v4);
    return reason ? `NAT64 ${v4}: ${reason}` : null;
  }
  // 6to4 2002:a.b.c.d::/48 — classify the embedded IPv4.
  if (g[0] === 0x2002) {
    const v4 = embeddedV4(g[1]!, g[2]!);
    const reason = classifyIpv4(v4);
    return reason ? `6to4 ${v4}: ${reason}` : null;
  }
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g[0]! & 0xffc0) === 0xfec0) return "site-local (fec0::/10)";
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique-local (fc00::/7)";
  if ((g[0]! & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation (2001:db8::/32)";
  return null;
}

/**
 * Why `ip` must not be connected to, or null if it is a public unicast address.
 * Pure: no DNS. Accepts any IPv4 spelling and IPv6 with/without brackets.
 * Non-literals (hostnames) and unparsable strings are refused ("not an IP literal").
 */
export function classifyForbiddenAddress(ip: string): string | null {
  const literal = normalizeIpLiteral(ip);
  if (literal === null) return "not an IP literal";
  if (literal.includes(":")) {
    const groups = parseIpv6(literal);
    return groups ? classifyIpv6(groups) : "unparsable IPv6";
  }
  return classifyIpv4(literal);
}

/**
 * True if `ip` is loopback, link-local, private (RFC 1918), CGNAT, multicast,
 * unspecified, reserved, unique-local / link-local / site-local IPv6, or an
 * IPv4-mapped / -compatible / NAT64 / 6to4 form of any of those. Strings that
 * are not IP literals are also forbidden (they must go through resolution).
 */
export function isForbiddenAddress(ip: string): boolean {
  return classifyForbiddenAddress(ip) !== null;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** True for HTTP statuses whose Location header a client would follow. */
export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUS.has(status);
}

/**
 * The resolved-target policy. Parses `url`, rejects non-http(s) schemes,
 * normalises literal spellings, resolves the hostname (every address) and
 * throws `ForbiddenTargetError` if ANY address is in a forbidden class or the
 * name cannot be resolved. Returns the parsed URL and the vetted address list
 * so the caller can pin its connection to exactly those addresses.
 *
 * Call it immediately before every request and again for every redirect hop —
 * a rebinding host that answered public once is re-resolved, not trusted.
 */
export async function assertPublicTarget(
  url: string | URL,
  options: PublicTargetOptions = {},
): Promise<ResolvedTarget> {
  const raw = typeof url === "string" ? url : url.toString();
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch (error) {
    throw new ForbiddenTargetError(
      `Invalid URL: ${error instanceof Error ? error.message : String(error)}`,
      raw,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ForbiddenTargetError(`Protocol "${parsed.protocol}" is not allowed (http/https only)`, raw);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "") {
    throw new ForbiddenTargetError("URL has no hostname", raw);
  }
  // RFC 6761: "localhost" and every name under it resolve to loopback by definition.
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new ForbiddenTargetError(`Host "${hostname}" is loopback (localhost)`, raw, hostname);
  }

  let addresses: ResolvedAddress[];
  const literal = normalizeIpLiteral(hostname);
  if (literal !== null) {
    addresses = [{ address: literal, family: literal.includes(":") ? 6 : 4 }];
  } else {
    const resolver = options.resolver ?? defaultTargetResolver;
    try {
      addresses = await resolver(hostname);
    } catch (error) {
      throw new ForbiddenTargetError(
        `Host "${hostname}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        raw,
        hostname,
      );
    }
    if (addresses.length === 0) {
      throw new ForbiddenTargetError(`Host "${hostname}" resolved to no addresses`, raw, hostname);
    }
  }

  for (const entry of addresses) {
    const reason = classifyForbiddenAddress(entry.address);
    if (reason !== null) {
      throw new ForbiddenTargetError(
        `Host "${hostname}" resolves to ${entry.address} — ${reason}; access to internal/private network addresses is blocked`,
        raw,
        entry.address,
      );
    }
  }

  return { url: parsed, hostname, addresses };
}

// ---------- Address-pinned transport (Codex round 6 #11 / #12 / #14) ----------
//
// The policy above decides; this section is the only transport that can honour
// the decision. It is shared: web_fetch_url, the browser's document requests
// (route.fulfill) and the browser's fallback download all go through it, so a
// redirect into the network is refused at the hop everywhere, and the socket
// connects to the address the policy vetted rather than resolving again.

/** Redirect hops fetchWithPolicy will follow (each hop re-checked by the policy). */
export const POLICY_MAX_REDIRECTS = 5;

/**
 * How long `dispose()` lets an undici Agent drain gracefully before it is
 * destroyed. `Agent.close()` waits for in-flight requests, and a response body
 * nobody read keeps its request in flight forever (Codex round 6 #14) — callers
 * cancel unread bodies, and this bound is the backstop.
 */
export const AGENT_CLOSE_GRACE_MS = 1000;

export interface FetchWithPolicyOptions {
  signal?: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | null;
  /** Injectable resolver (tests); defaults to dns.lookup. */
  resolver?: TargetResolver;
  /** Redirect hop bound; defaults to POLICY_MAX_REDIRECTS. */
  maxRedirects?: number;
  /**
   * Called with every hop URL (initial and each Location) BEFORE it is resolved.
   * Throw to refuse the hop (e.g. a caller's block-pattern list).
   */
  onHop?: (url: string) => void;
  /**
   * Headers for ONE hop, merged over `headers` after the cross-origin strip
   * (Codex round 7 #14: the browser supplies the cookies its jar holds for
   * exactly this hop's URL). Never carried to the next hop.
   *
   * `hop` describes the request as it will actually be sent (round 9 #13): a
   * 303 — and a 301/302 on a POST — rewrites the method to GET, and the
   * SameSite=Lax rule is about the CURRENT hop's method, not the one the
   * navigation started with (RFC 6265bis §5.6.7.1).
   */
  hopHeaders?: (
    url: string,
    hop: { method: string; redirectCount: number },
  ) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined;
  /**
   * Called with every hop's Set-Cookie headers (each one separately, undici's
   * `getSetCookie`) and the URL that set them, redirect hops included, before
   * the next hop is requested (Codex round 7 #15).
   */
  onSetCookie?: (url: string, setCookies: string[]) => Promise<void> | void;
}

export interface PolicyFetchResult {
  /** The final (non-redirect, or hop-bound) response. */
  response: Response;
  /** URL the final response came from (differs from the request when redirected). */
  finalUrl: string;
  /** Close every per-hop Agent. Safe to call more than once. */
  dispose: () => Promise<void>;
}

/**
 * Cancel a response body that will not be read. Safe on a missing body or on
 * one that was already consumed/cancelled — the intent is only that the
 * Agent's request finishes so `close()` can return (Codex round 6 #14).
 */
export async function discardBody(response: { body?: { cancel(): Promise<void> } | null } | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // already consumed, already cancelled, or a body-less mock — nothing to release
  }
}

/**
 * An undici Agent whose socket connect uses ONLY the addresses the policy just
 * vetted, instead of resolving the hostname a second time. This closes the
 * check-then-connect (DNS rebinding) window: the address we classified is the
 * address the TCP connection goes to. TLS still verifies against the hostname
 * (servername is derived from the URL, not from the pinned address).
 *
 * Node's global fetch cannot pin: its RequestInit has no lookup hook and mixing
 * an npm undici Agent into the bundled fetch is version-fragile, so requests go
 * through the npm `undici` fetch with this dispatcher.
 */
export function pinnedDispatcher(target: ResolvedTarget): Agent {
  const pinned = target.addresses.map((a) => ({ address: a.address, family: a.family }));
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname.toLowerCase() !== target.hostname) {
      const err: NodeJS.ErrnoException = new Error(`Refusing to connect to unvetted host "${hostname}"`);
      err.code = "ENOTFOUND";
      callback(err, options.all ? [] : "");
      return;
    }
    const family =
      options.family === 4 || options.family === "IPv4" ? 4
      : options.family === 6 || options.family === "IPv6" ? 6
      : undefined;
    const candidates = family ? pinned.filter((a) => a.family === family) : pinned;
    if (candidates.length === 0) {
      const err: NodeJS.ErrnoException = new Error(`No vetted address of family ${family ?? "any"} for "${hostname}"`);
      err.code = "ENOTFOUND";
      callback(err, options.all ? [] : "");
      return;
    }
    if (options.all) {
      callback(null, candidates);
    } else {
      callback(null, candidates[0]!.address, candidates[0]!.family);
    }
  };
  return new Agent({ connect: { lookup } });
}

/**
 * Close an Agent without letting it hang: graceful `close()` first, and if that
 * has not returned within AGENT_CLOSE_GRACE_MS (an unread body is keeping a
 * request in flight) fall back to `destroy()`, which aborts the sockets.
 */
async function closeAgent(agent: Agent): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), AGENT_CLOSE_GRACE_MS);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([agent.close().then(() => "closed" as const), grace]);
    if (outcome === "timeout") {
      await agent.destroy();
    }
  } catch {
    await agent.destroy().catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Request headers that carry credentials for ONE origin. RFC 9110 §15.4 lets a
 * client keep them on a same-origin redirect and expects them dropped when the
 * redirect changes origin (a trusted host must not be able to bounce the
 * caller's bearer token or session cookie to a third party). Codex round 7 #16.
 */
export const CROSS_ORIGIN_STRIPPED_HEADERS: ReadonlySet<string> = new Set(["authorization", "proxy-authorization", "cookie"]);

/** `headers` without the credential headers, matched case-insensitively. */
export function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CROSS_ORIGIN_STRIPPED_HEADERS.has(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

/** Every Set-Cookie header of a response, one entry each (undici / WHATWG `getSetCookie`). */
export function setCookiesOf(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") return withGetter.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Request `initialUrl`, following redirects by hand: every hop (the initial URL
 * and each Location) is passed through `assertPublicTarget` immediately before
 * its request and the connection is pinned to the vetted addresses. A hop that
 * lands on a forbidden address throws ForbiddenTargetError; redirect bodies are
 * cancelled so their Agents can close. The caller reads (or discards) the final
 * body and then calls `dispose()`.
 *
 * Credentials (Authorization, Proxy-Authorization, Cookie) are forwarded on
 * same-origin hops only: the first hop whose origin differs from the previous
 * one drops them and they do not come back on a later hop (RFC 9110 §15.4;
 * Codex round 7 #16). `hopHeaders` may add per-hop headers on top.
 */
export async function fetchWithPolicy(
  initialUrl: string,
  options: FetchWithPolicyOptions = {},
): Promise<PolicyFetchResult> {
  const agents: Agent[] = [];
  const dispose = async (): Promise<void> => {
    await Promise.all(agents.splice(0).map((a) => closeAgent(a).catch(() => undefined)));
  };
  const policyOptions: PublicTargetOptions = options.resolver ? { resolver: options.resolver } : {};
  const maxRedirects = options.maxRedirects ?? POLICY_MAX_REDIRECTS;

  let currentUrl = initialUrl;
  let method = options.method ?? "GET";
  let body = options.body ?? null;
  let carriedHeaders: Record<string, string> = { ...(options.headers ?? {}) };
  let previousOrigin: string | undefined;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      options.onHop?.(currentUrl);
      // Re-resolve right before the request: a rebinding host that was public a
      // moment ago is re-checked, and the agent below connects only to what
      // this call vetted.
      const target = await assertPublicTarget(currentUrl, policyOptions);
      const agent = pinnedDispatcher(target);
      agents.push(agent);

      // #16: an origin change drops the caller's credentials for good.
      const origin = new URL(currentUrl).origin;
      if (previousOrigin !== undefined && origin !== previousOrigin) {
        carriedHeaders = stripCredentialHeaders(carriedHeaders);
      }
      previousOrigin = origin;
      const perHop = await options.hopHeaders?.(currentUrl, { method, redirectCount: hop });
      const headers = perHop ? { ...carriedHeaders, ...perHop } : carriedHeaders;

      const response = (await undiciFetch(currentUrl, {
        signal: options.signal,
        method,
        headers,
        body: body ?? undefined,
        redirect: "manual",
        dispatcher: agent,
      })) as unknown as Response;

      // #15: every hop's cookies reach the caller's jar, scoped to this hop's URL.
      if (options.onSetCookie) {
        const setCookies = setCookiesOf(response.headers);
        if (setCookies.length > 0) await options.onSetCookie(currentUrl, setCookies);
      }

      if (!isRedirectStatus(response.status)) {
        return { response, finalUrl: currentUrl, dispose };
      }
      const location = response.headers.get("location");
      if (!location) {
        return { response, finalUrl: currentUrl, dispose };
      }
      await discardBody(response);
      currentUrl = new URL(location, currentUrl).toString();
      // 303, and 301/302 on POST, become GET without a body (RFC 9110 §15.4).
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = null;
      }
    }
    throw new Error(`Too many redirects (more than ${maxRedirects}).`);
  } catch (error) {
    await dispose();
    throw error;
  }
}

// ---------- Rate Limiter ----------

interface RateLimitEntry {
  timestamps: number[];
}

export class BrowserRateLimiter {
  private readonly maxOperationsPerMinute: number;
  private readonly sessions = new Map<string, RateLimitEntry>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(maxOperationsPerMinute: number = 60) {
    this.maxOperationsPerMinute = maxOperationsPerMinute;
    this.startCleanupInterval();
  }

  /**
   * Check if an operation is allowed for the given session.
   */
  checkLimit(sessionId: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { timestamps: [] };
      this.sessions.set(sessionId, entry);
    }

    // Clean old timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > oneMinuteAgo);

    // Check limit
    if (entry.timestamps.length >= this.maxOperationsPerMinute) {
      const oldest = entry.timestamps[0]!;
      const retryAfterMs = oldest + 60_000 - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    // Record operation
    entry.timestamps.push(now);
    return { allowed: true };
  }

  /**
   * Get current operation count for a session.
   */
  getOperationCount(sessionId: string): number {
    const oneMinuteAgo = Date.now() - 60_000;
    const entry = this.sessions.get(sessionId);
    if (!entry) return 0;
    return entry.timestamps.filter((t) => t > oneMinuteAgo).length;
  }

  /**
   * Reset rate limit for a session.
   */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Dispose of the rate limiter.
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }

  private startCleanupInterval(): void {
    // Clean up empty sessions every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const oneHourAgo = Date.now() - 3_600_000;
      for (const [sessionId, entry] of Array.from(this.sessions.entries())) {
        entry.timestamps = entry.timestamps.filter((t) => t > oneHourAgo);
        if (entry.timestamps.length === 0) {
          this.sessions.delete(sessionId);
        }
      }
    }, 300_000);
    this.cleanupInterval.unref();
  }
}

// ---------- Session Manager ----------

export class BrowserSessionManager {
  private readonly maxConcurrentSessions: number;
  private activeSessions = new Set<string>();
  private readonly logger = getLogger();

  constructor(maxConcurrentSessions: number = 5) {
    this.maxConcurrentSessions = maxConcurrentSessions;
  }

  /**
   * Try to acquire a session slot.
   */
  acquireSession(sessionId: string): boolean {
    if (this.activeSessions.has(sessionId)) {
      return true; // Already acquired
    }

    if (this.activeSessions.size >= this.maxConcurrentSessions) {
      this.logger.warn("Max concurrent browser sessions reached", {
        max: this.maxConcurrentSessions,
        current: this.activeSessions.size,
      });
      return false;
    }

    this.activeSessions.add(sessionId);
    return true;
  }

  /**
   * Release a session slot.
   */
  releaseSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  /**
   * Check if a session is active.
   */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /**
   * Get current active session count.
   */
  getActiveCount(): number {
    return this.activeSessions.size;
  }
}
