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
 */
import { EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";

/** Always reached directly, whatever NO_PROXY says. */
export const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"] as const;

export type EnvProxySetup =
  /** No proxy variable is set: fetch connects directly, as before. */
  | { readonly kind: "none" }
  /** NODE_USE_ENV_PROXY is set: Node's own proxy support is in charge. */
  | { readonly kind: "node" }
  | {
      readonly kind: "installed";
      readonly httpsProxy?: string;
      readonly httpProxy?: string;
      readonly noProxy: string;
    };

function value(upper: string | undefined, lower?: string): string | undefined {
  const raw = (upper ?? lower ?? "").trim();
  return raw === "" ? undefined : raw;
}

/** What the environment asks for, without changing anything. */
export function envProxySettings(env: NodeJS.ProcessEnv = process.env): EnvProxySetup {
  const httpsProxy = value(env["HTTPS_PROXY"], env["https_proxy"]);
  const httpProxy = value(env["HTTP_PROXY"], env["http_proxy"]);
  if (httpsProxy === undefined && httpProxy === undefined) return { kind: "none" };
  if (value(env["NODE_USE_ENV_PROXY"]) !== undefined) return { kind: "node" };
  const configured = (value(env["NO_PROXY"], env["no_proxy"]) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const noProxy = [...new Set([...configured, ...LOOPBACK_NO_PROXY])].join(",");
  return {
    kind: "installed",
    ...(httpsProxy !== undefined ? { httpsProxy } : {}),
    ...(httpProxy !== undefined ? { httpProxy } : {}),
    noProxy,
  };
}

/**
 * Point fetch at the environment's proxy when one is set. Returns what was
 * decided; `install` is a seam for tests.
 */
export function installEnvProxy(
  env: NodeJS.ProcessEnv = process.env,
  install: (dispatcher: Dispatcher) => void = setGlobalDispatcher,
): EnvProxySetup {
  const setup = envProxySettings(env);
  if (setup.kind !== "installed") return setup;
  install(new EnvHttpProxyAgent({
    ...(setup.httpsProxy !== undefined ? { httpsProxy: setup.httpsProxy } : {}),
    ...(setup.httpProxy !== undefined ? { httpProxy: setup.httpProxy } : {}),
    noProxy: setup.noProxy,
  }));
  return setup;
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
