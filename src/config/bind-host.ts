/**
 * The address the HTTP listeners bind to (14F2 / D71).
 *
 * Every listener used to pass the literal "127.0.0.1" to `listen()`. That is
 * the right default for a workstation — nothing on the network can reach the
 * dashboard or the web channel unless the operator says so — but inside a
 * container it is a dead end: 127.0.0.1 is the container's own loopback, so
 * `docker run -p 3100:3100` publishes a port that nothing answers on. There
 * was no configuration that could change it.
 *
 * `BIND_HOST` is that configuration. It defaults to the same loopback, so a
 * local run behaves exactly as before, and it is validated rather than passed
 * through: the value reaches `server.listen()`, and a string like
 * "0.0.0.0 && …" or a URL has no business getting that far.
 */

import { z } from "zod";

/** Today's behaviour, and the default when BIND_HOST is unset. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * A bare host: an IPv4 address, an IPv6 address, or a DNS label.
 *
 * Deliberately NOT a URL and deliberately without a port — `listen()` takes a
 * host, and accepting "http://host:3100" would bind something nobody intended.
 */
export const bindHostSchema = z
  .string()
  .trim()
  .min(1, "BIND_HOST must not be empty")
  .refine(
    (value) =>
      z.ipv4().safeParse(value).success ||
      z.ipv6().safeParse(value).success ||
      /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(value),
    { message: "BIND_HOST must be an IP address or a hostname (no scheme, no port)" },
  );

/**
 * Resolve the bind address from an environment.
 *
 * Throws on an invalid value — a listener that silently falls back to loopback
 * after the operator asked for 0.0.0.0 is the failure this defect was about.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["BIND_HOST"];
  if (raw === undefined) return DEFAULT_BIND_HOST;
  const parsed = bindHostSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid BIND_HOST ${JSON.stringify(raw)}: ${parsed.error.issues[0]?.message ?? "not a host"}`,
    );
  }
  return parsed.data;
}
