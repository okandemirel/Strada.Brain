/**
 * Route this process's fetch() through the proxy the environment names.
 *
 * Node's built-in fetch ignores HTTPS_PROXY / HTTP_PROXY unless the process
 * was started with NODE_USE_ENV_PROXY=1 on Node >= 22.21, and the Windows
 * launcher pins an older Node. Behind a network that only lets traffic out
 * through a proxy, every provider call therefore failed at connect time while
 * curl on the same machine worked. When a proxy variable is set, the global
 * dispatcher (the one fetch uses) becomes undici's EnvHttpProxyAgent: https
 * requests go through HTTPS_PROXY, http requests through HTTP_PROXY, and
 * NO_PROXY is honoured. Loopback is always direct, so a local Ollama, the
 * dashboard and the CLI's own calls to it never go through the proxy.
 *
 * Clients with their own connection pool (the Telegram and Discord SDKs, and
 * the address-pinned web fetch) are not affected; axios-based ones (Slack)
 * already read the proxy variables themselves.
 *
 * fetch reads its dispatcher from the undici Node bundles, which keeps it on
 * globalThis under a key numbered by undici generation. The npm undici this
 * module used to install through writes only its own generation's key, and
 * Node 26's bundled undici reads a newer one: the proxy was "installed" while
 * every call still went direct. Where node:http offers setGlobalProxyFromEnv
 * (Node 26, and Node 24's later releases) the dispatcher goes in through it,
 * into the undici fetch reads; npm undici is the route on older Node. Either
 * way the result is checked against the key fetch reads, and a miss is
 * reported as "unrouted".
 */
import http from "node:http";
import https from "node:https";
import { isIPv6 } from "node:net";
import { EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import type { LoggerLike } from "../utils/logger.js";

/**
 * Always reached directly, whatever NO_PROXY says. IPv6 in brackets: undici
 * matches the URL's bracketed host, and reads a bare "::1" as host ":" port 1.
 */
export const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "[::1]"] as const;

interface EnvProxyRoute {
  readonly httpsProxy?: string;
  readonly httpProxy?: string;
  readonly noProxy: string;
}

/** A proxy variable the installer refused while it took the other one. */
export interface RefusedProxy {
  readonly variable: "HTTPS_PROXY" | "HTTP_PROXY";
  readonly proxy: string;
  /** The installer's error code. */
  readonly reason: string;
}

/**
 * Requests the refused variable would carry go as though it were unset: http
 * connects directly, and https goes through HTTP_PROXY, as undici does when
 * HTTPS_PROXY is unset.
 */
type SetAside = { readonly refused?: RefusedProxy };

export type EnvProxySetup =
  /** No proxy variable is set: fetch connects directly, as before. */
  | { readonly kind: "none" }
  /** NODE_USE_ENV_PROXY is set: Node's own proxy support is in charge. */
  | { readonly kind: "node" }
  | ({ readonly kind: "installed" } & EnvProxyRoute & SetAside)
  /** A proxy is named, but fetch does not read the dispatcher: it still connects directly. */
  | ({ readonly kind: "unrouted" } & EnvProxyRoute & SetAside)
  /** Every proxy value named was refused (`reason`, its error code): fetch connects directly. */
  | ({ readonly kind: "invalid"; readonly reason: string } & EnvProxyRoute);

function value(upper: string | undefined, lower?: string): string | undefined {
  const raw = (upper ?? lower ?? "").trim();
  return raw === "" ? undefined : raw;
}

/** A bare host:port, as curl and Go read it: a plain-http proxy. */
function withScheme(proxy: string | undefined): string | undefined {
  return proxy === undefined || /^[a-z][a-z\d+.-]*:\/\//iu.test(proxy) ? proxy : `http://${proxy}`;
}

/** What the environment asks for, without changing anything. */
export function envProxySettings(env: NodeJS.ProcessEnv = process.env): EnvProxySetup {
  const httpsProxy = withScheme(value(env["HTTPS_PROXY"], env["https_proxy"]));
  const httpProxy = withScheme(value(env["HTTP_PROXY"], env["http_proxy"]));
  if (httpsProxy === undefined && httpProxy === undefined) return { kind: "none" };
  if (value(env["NODE_USE_ENV_PROXY"]) !== undefined) return { kind: "node" };
  const configured = (value(env["NO_PROXY"], env["no_proxy"]) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => (isIPv6(entry) ? `[${entry}]` : entry));
  const noProxy = [...new Set([...configured, ...LOOPBACK_NO_PROXY])].join(",");
  return {
    kind: "installed",
    ...(httpsProxy !== undefined ? { httpsProxy } : {}),
    ...(httpProxy !== undefined ? { httpProxy } : {}),
    noProxy,
  };
}

/**
 * The dispatcher Node's own fetch() uses. Its bundled undici reads
 * undici.globalDispatcher.1 up to 7.x and .2 from 8.x (Node 26); both write
 * the other key too, so which keys are present says nothing about which one
 * is read (Node 24's undici 7.29 holds both and reads .1).
 */
function fetchDispatcher(): unknown {
  const major = Number.parseInt(process.versions.undici ?? "", 10);
  const key = Symbol.for(major >= 8 ? "undici.globalDispatcher.2" : "undici.globalDispatcher.1");
  return (globalThis as unknown as Record<symbol, unknown>)[key];
}

type SetGlobalProxyFromEnv = (env: NodeJS.ProcessEnv) => () => void;

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

/**
 * undici's EnvHttpProxyAgent reads process.env for a proxy it is not handed,
 * and node:http hands it none for a variable left out: a value set aside came
 * back from there and was refused again. The installer is synchronous, so
 * nothing else sees the variables gone.
 */
function withoutProcessProxyEnv<T>(run: () => T): T {
  const saved = PROXY_VARIABLES.map((name) => [name, process.env[name]] as const);
  for (const name of PROXY_VARIABLES) delete process.env[name];
  try {
    return run();
  } finally {
    for (const [name, proxy] of saved) if (proxy !== undefined) process.env[name] = proxy;
  }
}

/**
 * Point fetch at the environment's proxy when one is set. Returns what was
 * decided, and "installed" only when fetch reads the new dispatcher. `install`
 * is a seam for tests: it is handed an npm-undici dispatcher in place of
 * setGlobalDispatcher, and the verdict still checks where it landed.
 */
export function installEnvProxy(
  env: NodeJS.ProcessEnv = process.env,
  install?: (dispatcher: Dispatcher) => void,
): EnvProxySetup {
  const setup = envProxySettings(env);
  if (setup.kind !== "installed") return setup;
  const before = fetchDispatcher();
  const viaNode = (http as { setGlobalProxyFromEnv?: SetGlobalProxyFromEnv }).setGlobalProxyFromEnv;
  /** Whether fetch now reads the route's dispatcher; throws, having installed nothing, on a refused value. */
  const attempt = (route: EnvProxyRoute): boolean => {
    if (install === undefined && typeof viaNode === "function") {
      // It also points http/https.globalAgent at the proxy; this module routes
      // fetch only, and the SDKs on those agents keep their own proxy handling.
      const agents = { http: http.globalAgent, https: https.globalAgent };
      try {
        withoutProcessProxyEnv(() => viaNode({
          ...(route.httpsProxy !== undefined ? { HTTPS_PROXY: route.httpsProxy } : {}),
          ...(route.httpProxy !== undefined ? { HTTP_PROXY: route.httpProxy } : {}),
          NO_PROXY: route.noProxy,
        }));
      } finally {
        http.globalAgent = agents.http;
        https.globalAgent = agents.https;
      }
      const after = fetchDispatcher();
      return after !== undefined && after !== before;
    }
    // "" and not left out, or undici would read the variable from process.env.
    const dispatcher = new EnvHttpProxyAgent({
      httpsProxy: route.httpsProxy ?? "",
      httpProxy: route.httpProxy ?? "",
      noProxy: route.noProxy,
    });
    (install ?? setGlobalDispatcher)(dispatcher);
    return fetchDispatcher() === dispatcher;
  };
  const settle = (route: EnvProxyRoute & SetAside, reached: boolean): EnvProxySetup =>
    reached ? { ...route, kind: "installed" } : { ...route, kind: "unrouted" };
  // This runs at index.ts's top level, so a value an installer refuses (no
  // valid URL, a scheme it does not speak) used to stop startup. Both refuse
  // before they install anything: run direct and say why instead.
  try {
    return settle(setup, attempt(setup));
  } catch (error) {
    const reason = errorCode(error);
    // One refused variable used to take the other down with it, so a typo in
    // HTTP_PROXY sent every https provider call direct. Only the refused one
    // can have thrown: install the other alone, https first.
    const { httpsProxy, httpProxy, noProxy } = setup;
    if (httpsProxy !== undefined && httpProxy !== undefined) {
      const alone: ReadonlyArray<readonly [EnvProxyRoute, RefusedProxy]> = [
        [{ httpsProxy, noProxy }, { variable: "HTTP_PROXY", proxy: httpProxy, reason }],
        [{ httpProxy, noProxy }, { variable: "HTTPS_PROXY", proxy: httpsProxy, reason }],
      ];
      for (const [route, refused] of alone) {
        try {
          return settle({ ...route, refused }, attempt(route));
        } catch {
          // Refused too; the other one may still go in.
        }
      }
    }
    return { ...setup, kind: "invalid", reason };
  }
}

/** The error's code, never its message: the installers echo the proxy URL, credentials included. */
function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (error instanceof Error) return error.name;
  }
  return "unknown";
}

type ProxyLogger = Pick<LoggerLike, "info" | "warn">;

/** The startup log line for what installEnvProxy decided; nothing when no proxy is in play. */
export function reportEnvProxy(setup: EnvProxySetup, logger: ProxyLogger): void {
  if (setup.kind === "none" || setup.kind === "node") return;
  // Scheme, host and port only: a proxy URL can carry credentials.
  const proxyFields = {
    httpsProxy: setup.httpsProxy !== undefined ? describeProxy(setup.httpsProxy) : undefined,
    httpProxy: setup.httpProxy !== undefined ? describeProxy(setup.httpProxy) : undefined,
    noProxy: setup.noProxy,
  };
  switch (setup.kind) {
    case "installed":
      logger.info("Outbound HTTP(S) goes through the proxy the environment names", proxyFields);
      break;
    case "unrouted":
      logger.warn("The environment names a proxy, but this Node's fetch does not read the dispatcher; outbound HTTP(S) connects directly (NODE_USE_ENV_PROXY=1 hands it to Node)", {
        ...proxyFields,
        node: process.version,
      });
      break;
    case "invalid":
      logger.warn("The environment names a proxy this process cannot use; outbound HTTP(S) connects directly. Set HTTPS_PROXY/HTTP_PROXY to a URL such as http://host:port", {
        ...proxyFields,
        reason: setup.reason,
      });
      return;
  }
  if (setup.refused !== undefined) {
    const { variable, proxy, reason } = setup.refused;
    const effect = variable === "HTTP_PROXY" ? "http requests connect directly" : "https requests go through HTTP_PROXY";
    logger.warn(`${variable} names a proxy this process cannot use and was set aside: ${effect}`, {
      variable,
      proxy: describeProxy(proxy),
      reason,
    });
  }
}

/** A proxy URL for a log line: scheme, host and port only, never credentials. */
export function describeProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "(unparseable proxy URL)";
  }
}
