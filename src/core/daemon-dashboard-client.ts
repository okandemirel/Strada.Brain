/**
 * Read-only client for a running Strada runtime's dashboard HTTP API (COR-13).
 *
 * `strada daemon status` runs in a fresh CLI process; the daemon lives in the
 * runtime process, so an in-process handle is never available to it. The
 * dashboard API is the channel both processes already share, so the CLI reads
 * the daemon's state from there — with the same port, bind address and bearer
 * token the runtime itself was configured with.
 *
 * Every outcome names what was actually observed. A refused connection means
 * "the dashboard did not answer", never "the daemon is not running": the
 * dashboard can be disabled, bound elsewhere, or still starting.
 */

import type { Config } from "../config/config-types.js";

export type DashboardReadResult =
  | { kind: "ok"; body: unknown }
  /** No HTTP answer at all: connection refused, reset, timed out. */
  | { kind: "unreachable"; message: string }
  /** An HTTP answer that is not a usable JSON success. */
  | { kind: "refused"; status: number; message: string };

export interface DaemonDashboardClient {
  /** Base URL requests go to, for messages. */
  readonly baseUrl: string;
  getJson(path: string): Promise<DashboardReadResult>;
}

export type DashboardClientResolution =
  | { kind: "ok"; client: DaemonDashboardClient }
  | { kind: "unavailable"; message: string };

type FetchLike = (input: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface DaemonDashboardClientOptions {
  baseUrl: string;
  /** The dashboard bearer token (WEBSOCKET_DASHBOARD_AUTH_TOKEN), when one is set. */
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The URL a local client reaches the dashboard at. A wildcard bind address
 * accepts connections on loopback, but is not an address to connect to.
 */
export function dashboardBaseUrl(bindHost: string, port: number): string {
  let host = bindHost.trim();
  if (host === "" || host === "0.0.0.0") host = "127.0.0.1";
  else if (host === "::" || host === "[::]") host = "::1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${port}`;
}

function describeNetworkError(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : undefined;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "no answer in time";
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

function errorFromBody(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === "string") return value;
    }
  } catch {
    // Not JSON — fall through to the status line.
  }
  return undefined;
}

export function createDaemonDashboardClient(options: DaemonDashboardClientOptions): DaemonDashboardClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    baseUrl,
    async getJson(path: string): Promise<DashboardReadResult> {
      const headers: Record<string, string> = { Accept: "application/json" };
      // The dashboard gates every /api/ route on this bearer when a token is set.
      if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        return {
          kind: "unreachable",
          message: `could not reach the daemon dashboard at ${baseUrl} (${describeNetworkError(error)}); is Strada running with the dashboard enabled?`,
        };
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return { kind: "unreachable", message: `the dashboard at ${baseUrl} dropped the response (${describeNetworkError(error)})` };
      }

      if (!response.ok) {
        const detail = errorFromBody(text) ?? `HTTP ${response.status}`;
        const hint = response.status === 401 || response.status === 403
          ? " — set WEBSOCKET_DASHBOARD_AUTH_TOKEN to the token the running Strada uses"
          : "";
        return { kind: "refused", status: response.status, message: `the dashboard at ${baseUrl} refused ${path}: ${detail}${hint}` };
      }

      try {
        return { kind: "ok", body: JSON.parse(text) as unknown };
      } catch {
        return { kind: "refused", status: response.status, message: `the dashboard at ${baseUrl} answered ${path} with something that is not JSON` };
      }
    },
  };
}

/** A client for the dashboard this install's configuration describes. */
export function resolveDaemonDashboardClient(
  config: Pick<Config, "bindHost" | "dashboard" | "websocketDashboard">,
  options: Pick<DaemonDashboardClientOptions, "timeoutMs" | "fetchImpl"> = {},
): DashboardClientResolution {
  if (!config.dashboard.enabled) {
    return {
      kind: "unavailable",
      message: "the dashboard is disabled in this install's configuration (DASHBOARD_ENABLED), so the CLI has no way to reach the running daemon",
    };
  }
  return {
    kind: "ok",
    client: createDaemonDashboardClient({
      baseUrl: dashboardBaseUrl(config.bindHost, config.dashboard.port),
      token: config.websocketDashboard.authToken || undefined,
      ...options,
    }),
  };
}
