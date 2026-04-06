/**
 * Shared Origin header validation for WebSocket servers.
 * Used by both the web channel and the dashboard WebSocket server.
 */

const LOCALHOST_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Validates a WebSocket Origin header against allowed hostnames.
 *
 * @param origin - The Origin header value from the request (undefined if absent)
 * @param allowedHostnames - Optional list of additional allowed hostnames/host:port values.
 *   When empty/undefined, only localhost and 127.0.0.1 are allowed.
 * @returns true if the connection should be accepted
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowedHostnames?: string[],
): boolean {
  if (origin === undefined) return true; // Non-browser clients (truly absent header)
  if (origin === "" || origin === "null") return false; // Suspicious browser origins

  try {
    const { hostname, host } = new URL(origin);

    if (allowedHostnames && allowedHostnames.length > 0) {
      // Accept both bare hostnames ("myapp.local") and host:port ("myapp.local:3100")
      return allowedHostnames.includes(hostname) || allowedHostnames.includes(host);
    }

    return LOCALHOST_HOSTNAMES.includes(hostname);
  } catch {
    return false; // Malformed Origin
  }
}
