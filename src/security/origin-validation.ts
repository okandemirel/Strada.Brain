/**
 * Shared Origin/Referer validation for the portal, the dashboard and their
 * WebSocket servers.
 *
 * Audit 13F6 / plan 4.8 — the check used to compare only the HOSTNAME, so every
 * page served by any other process on the loopback interface
 * (`http://localhost:<any other port>`) counted as the protected server's own
 * origin: it could POST to the portal's `/api/*` proxy and open a chat
 * WebSocket. The browser's same-origin rule is scheme + host + PORT, and the
 * port is what names the ONE server that is allowed to talk to itself, so the
 * port is now part of the comparison and `selfPort` is a REQUIRED input — a
 * caller cannot forget it and silently fall back to the port-blind rule.
 *
 * What is deliberately still accepted:
 *   - an absent Origin header (a non-browser client: curl, a probe, a
 *     server-to-server read). A browser always sends Origin on the requests
 *     this guards (POST/PUT/DELETE and the WebSocket handshake), so absence is
 *     not a browser cross-origin request. CSRF amplification is what this
 *     check exists for; an arbitrary local process is a different threat and a
 *     different control (see the identity-bound proxy token, 4.8's second half).
 *   - operator-configured `allowedHosts`, matched as a bare hostname or as
 *     `host:port` — an explicit deployment decision, not an inference.
 *   - additional loopback ports named by `extraPorts`: the dashboard HTTP
 *     server has to trust the portal's port, because the portal proxies
 *     browser requests to it and forwards their Origin.
 *   - operator-configured `trustedOrigins`: COMPLETE origins
 *     (scheme + host + port), which is what round 10 #19 needed. Trusting only
 *     the bound port refused the project's own supported topologies: the portal
 *     served through its Vite dev proxy (`http://localhost:5173`, proxying to
 *     the backend on 3000 — the browser keeps origin 5173 on the WebSocket
 *     handshake and on every mutation) and an HTTPS reverse proxy in front of
 *     the daemon (`https://portal.example` on 443). Neither is an inference the
 *     code can make on its own, and neither may be guessed: an UNRELATED
 *     loopback port stays refused, so the configured list is the only way in.
 */

const LOCALHOST_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** The port a scheme implies when the origin carries none. */
const DEFAULT_SCHEME_PORTS: Record<string, string> = {
  "http:": "80",
  "ws:": "80",
  "https:": "443",
  "wss:": "443",
};

export interface OriginCheckOptions {
  /**
   * The port the server being protected listens on. A loopback origin is
   * accepted only on this port (or one of `extraPorts`). Required: the whole
   * point of 13F6 is that a hostname alone does not identify the origin.
   */
  selfPort: number;
  /**
   * Further loopback ports whose pages are trusted. Used by the dashboard HTTP
   * server for the portal's port (the portal forwards the browser's Origin when
   * it proxies), not as a general escape hatch.
   */
  extraPorts?: readonly number[];
  /**
   * Operator-configured hosts. Matched against the origin's bare hostname AND
   * its `host:port`, so `["myapp.local"]` trusts every port on that host while
   * `["myapp.local:3100"]` trusts exactly one — the operator's choice.
   */
  allowedHosts?: readonly string[];
  /**
   * Operator-configured COMPLETE origins: scheme, host and port must all match
   * (round 10 #19). `http://localhost:5173` trusts exactly the Vite dev server's
   * page — not `https://localhost:5173`, not `http://localhost:5174`, and not
   * `http://localhost` on port 80. An entry that carries no explicit port means
   * its scheme's default port (`https://portal.example` = port 443), which is
   * what a browser sends. A malformed entry is ignored rather than widened.
   */
  trustedOrigins?: readonly string[];
}

/** The origin's effective port: explicit, else the scheme's default. */
export function effectiveOriginPort(url: URL): string {
  return url.port || DEFAULT_SCHEME_PORTS[url.protocol] || "";
}

/**
 * An origin in the one form both sides of a comparison can agree on:
 * `scheme://host:port` with the scheme's default port made explicit, lowercased
 * by `URL`. A value that is not a URL at all — or a Referer whose path is
 * dropped here — yields undefined and can therefore never match.
 */
export function normalizeOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const port = effectiveOriginPort(parsed);
  if (port === "") return undefined;
  return `${parsed.protocol}//${parsed.hostname}:${port}`;
}

/**
 * Validates an Origin (or Referer) header against the protected server's own
 * origin.
 *
 * @param origin - The header value (undefined when the header is absent)
 * @param options - The server's own port, plus any explicitly trusted ports/hosts
 * @returns true if the request should be accepted
 */
export function isAllowedOrigin(
  origin: string | undefined,
  options: OriginCheckOptions,
): boolean {
  if (origin === undefined) return true; // Non-browser clients (truly absent header)
  if (origin === "" || origin === "null") return false; // Suspicious browser origins

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // Malformed Origin
  }

  const { hostname, host } = parsed;

  // Operator-configured COMPLETE origins first (round 10 #19): the deployment's
  // own public or dev origin, matched on scheme + host + port together.
  const trustedOrigins = options.trustedOrigins;
  if (trustedOrigins && trustedOrigins.length > 0) {
    const normalized = normalizeOrigin(origin);
    if (normalized !== undefined) {
      for (const trusted of trustedOrigins) {
        if (normalizeOrigin(trusted) === normalized) return true;
      }
    }
  }

  // Operator-configured hosts first: an explicit deployment decision may name a
  // non-loopback host, with or without a port.
  const allowedHosts = options.allowedHosts;
  if (allowedHosts && allowedHosts.length > 0) {
    if (allowedHosts.includes(hostname) || allowedHosts.includes(host)) return true;
  }

  // Otherwise the origin must be THIS server's own page: a loopback host on a
  // port we serve. A loopback host on any other port is another process.
  if (!LOCALHOST_HOSTNAMES.includes(hostname)) return false;

  const port = effectiveOriginPort(parsed);
  if (port === String(options.selfPort)) return true;
  return (options.extraPorts ?? []).some((extra) => String(extra) === port);
}
