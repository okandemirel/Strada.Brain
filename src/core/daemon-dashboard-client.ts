/**
 * Client for a running Strada runtime's dashboard HTTP API (COR-13).
 *
 * `strada daemon status` runs in a fresh CLI process; the daemon lives in the
 * runtime process, so an in-process handle is never available to it. The
 * dashboard API is the channel both processes already share, so the CLI reads
 * the daemon's state from there — with the same port, bind address and bearer
 * token the runtime itself was configured with. The commands that change state
 * post with the runtime's local operator credential (operator-credential.ts).
 *
 * Every outcome names what was actually observed. A refused connection means
 * "the dashboard did not answer", never "the daemon is not running": the
 * dashboard can be disabled, bound elsewhere, or still starting.
 */

import type { Config } from "../config/config-types.js";
import { OPERATOR_TOKEN_HEADER, readOperatorCredential } from "./operator-credential.js";

export type DashboardReadResult =
  | { kind: "ok"; body: unknown }
  /** No HTTP answer at all: connection refused, reset, timed out. */
  | { kind: "unreachable"; message: string }
  /**
   * An HTTP answer that is not a usable JSON success. `body` is its JSON, when
   * it had one: a refusal can say more than its error line (the gate that
   * refused a trigger fire).
   */
  | { kind: "refused"; status: number; message: string; body?: unknown };

export interface DaemonDashboardClient {
  /** Base URL requests go to, for messages. */
  readonly baseUrl: string;
  getJson(path: string): Promise<DashboardReadResult>;
}

export type DashboardClientResolution =
  | { kind: "ok"; client: DaemonDashboardClient }
  | { kind: "unavailable"; message: string };

/** Posts the commands that change the running daemon, as the local operator. */
export interface DaemonOperatorClient {
  /** Base URL requests go to, for messages. */
  readonly baseUrl: string;
  postJson(path: string, body: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<DashboardReadResult>;
}

export type OperatorClientResolution =
  | { kind: "ok"; client: DaemonOperatorClient }
  | { kind: "unavailable"; message: string };

type FetchLike = (input: string, init: {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}) => Promise<{
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
/** A state change can wait on the runtime (a digest send, an agent stop). */
const DEFAULT_POST_TIMEOUT_MS = 30_000;

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

const NO_ANSWER_IN_TIME = "no answer in time";

function describeNetworkError(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : undefined;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return NO_ANSWER_IN_TIME;
  // Node's fetch gives up on its own after 300 s without response headers.
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return NO_ANSWER_IN_TIME;
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorFromBody(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const value = (parsed as { error: unknown }).error;
    if (typeof value === "string") return value;
  }
  // Not a JSON error — fall through to the status line.
  return undefined;
}

interface SendOptions {
  baseUrl: string;
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
  /** The message for no answer at all, given what the network reported. */
  unreachable: (detail: string) => string;
  /** Appended to a 401/403 refusal: which credential to fix. */
  authHint: string;
}

async function send(options: SendOptions): Promise<DashboardReadResult> {
  const { baseUrl, method, path } = options;
  const what = method === "GET" ? path : `${method} ${path}`;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await options.fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: options.headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    return { kind: "unreachable", message: options.unreachable(describeNetworkError(error)) };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { kind: "unreachable", message: `the dashboard at ${baseUrl} dropped the response (${describeNetworkError(error)})` };
  }

  if (!response.ok) {
    const body = jsonOrUndefined(text);
    const detail = errorFromBody(body) ?? `HTTP ${response.status}`;
    const hint = response.status === 401 || response.status === 403 ? options.authHint : "";
    return {
      kind: "refused",
      status: response.status,
      message: `the dashboard at ${baseUrl} refused ${what}: ${detail}${hint}`,
      ...(body !== undefined ? { body } : {}),
    };
  }

  try {
    return { kind: "ok", body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "refused", status: response.status, message: `the dashboard at ${baseUrl} answered ${what} with something that is not JSON` };
  }
}

function fetchOrDefault(fetchImpl: FetchLike | undefined): FetchLike {
  return fetchImpl ?? ((input, init) => fetch(input, init));
}

export function createDaemonDashboardClient(options: DaemonDashboardClientOptions): DaemonDashboardClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = fetchOrDefault(options.fetchImpl);

  return {
    baseUrl,
    getJson(path: string): Promise<DashboardReadResult> {
      const headers: Record<string, string> = { Accept: "application/json" };
      // The dashboard gates every /api/ route on this bearer when a token is set.
      if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
      return send({
        baseUrl,
        method: "GET",
        path,
        headers,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchImpl,
        unreachable: (detail) =>
          `could not reach the daemon dashboard at ${baseUrl} (${detail}); is Strada running with the dashboard enabled?`,
        authHint: " — set WEBSOCKET_DASHBOARD_AUTH_TOKEN to the token the running Strada uses",
      });
    },
  };
}

export interface DaemonOperatorClientOptions {
  /** The dashboard URL the credential file names. */
  baseUrl: string;
  /** This run's operator token, from the credential file. */
  operatorToken: string;
  /** The credential file, for messages. */
  credentialPath: string;
  /** The dashboard bearer token (WEBSOCKET_DASHBOARD_AUTH_TOKEN), when the install has one. */
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export function createDaemonOperatorClient(options: DaemonOperatorClientOptions): DaemonOperatorClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = fetchOrDefault(options.fetchImpl);

  return {
    baseUrl,
    postJson(path, body, postOptions = {}): Promise<DashboardReadResult> {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        // Only ever a header: the dashboard never reads it from a URL.
        [OPERATOR_TOKEN_HEADER]: options.operatorToken,
      };
      if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
      return send({
        baseUrl,
        method: "POST",
        path,
        headers,
        body: JSON.stringify(body),
        timeoutMs: postOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS,
        fetchImpl,
        unreachable: (detail) => detail === NO_ANSWER_IN_TIME
          // It was reached and is working on it: say so, not "gone".
          ? `the dashboard at ${baseUrl} did not answer POST ${path} in time; the running Strada may still be carrying it out`
          : `could not reach the dashboard at ${baseUrl} named in ${options.credentialPath} (${detail}); ` +
            "that file may be left from a Strada run that has ended",
        authHint:
          ` — the operator credential in ${options.credentialPath} was not accepted ` +
          "(left from an earlier run, or another Strada now answers on that port)",
      });
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

/**
 * A client for the runtime whose operator credential sits at `credentialPath`
 * (operatorCredentialPath(configRoot, installRoot)). The file says where that
 * runtime's dashboard listens; it is published only while the dashboard runs.
 */
export async function resolveDaemonOperatorClient(
  credentialPath: string,
  config: Pick<Config, "dashboard" | "websocketDashboard">,
  options: Pick<DaemonOperatorClientOptions, "timeoutMs" | "fetchImpl"> = {},
): Promise<OperatorClientResolution> {
  const read = await readOperatorCredential(credentialPath);
  switch (read.kind) {
    case "missing":
      return {
        kind: "unavailable",
        message: config.dashboard.enabled
          ? `no running Strada has published an operator credential at ${credentialPath}: ` +
            "Strada is not running from this install, runs as another OS user, or uses a different config root (STRADA_HOME)"
          : `no operator credential at ${credentialPath}, and the dashboard is disabled in this install's configuration ` +
            "(DASHBOARD_ENABLED): the CLI reaches the running daemon only through its dashboard",
      };
    case "unreadable":
      return {
        kind: "unavailable",
        message: `cannot read the operator credential at ${credentialPath} (${read.code})` +
          (read.code === "EACCES" || read.code === "EPERM"
            ? ": it belongs to another OS user; run this command as the user that runs Strada"
            : ""),
      };
    case "invalid":
      return {
        kind: "unavailable",
        message: `the operator credential at ${credentialPath} is not one this version can use; restarting Strada rewrites it`,
      };
    case "ok":
      return {
        kind: "ok",
        client: createDaemonOperatorClient({
          baseUrl: read.credential.baseUrl,
          operatorToken: read.credential.token,
          credentialPath,
          token: config.websocketDashboard.authToken || undefined,
          ...options,
        }),
      };
  }
}
