import http, { createServer, type Server } from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch, setGlobalDispatcher, type Dispatcher } from "undici";
import {
  LOOPBACK_NO_PROXY,
  describeProxy,
  envProxyAgent,
  envProxySettings,
  installEnvProxy,
  reportEnvProxy,
} from "./env-proxy.js";

describe("envProxySettings", () => {
  it("does nothing when no proxy variable is set", () => {
    expect(envProxySettings({})).toEqual({ kind: "none" });
    expect(envProxySettings({ HTTPS_PROXY: "  ", NO_PROXY: "corp.local" })).toEqual({ kind: "none" });
  });

  it("reads the upper- and lower-case spellings, and always keeps loopback direct", () => {
    expect(envProxySettings({ https_proxy: "http://proxy:3128" })).toEqual({
      kind: "installed",
      httpsProxy: "http://proxy:3128",
      noProxy: LOOPBACK_NO_PROXY.join(","),
    });
    expect(envProxySettings({ HTTP_PROXY: "http://proxy:3128", NO_PROXY: "corp.local, .internal,localhost" })).toEqual({
      kind: "installed",
      httpProxy: "http://proxy:3128",
      noProxy: "corp.local,.internal,localhost,127.0.0.1,[::1]",
    });
  });

  it("brackets IPv6 entries, the only form undici's NO_PROXY matching recognises", () => {
    // undici compares the URL's bracketed host and reads a bare "::1" as host ":" port 1.
    expect(LOOPBACK_NO_PROXY).toContain("[::1]");
    expect(envProxySettings({ HTTP_PROXY: "http://proxy:3128", NO_PROXY: "::1,fd00::5,[fe80::1]:8080" })).toMatchObject({
      noProxy: "[::1],[fd00::5],[fe80::1]:8080,localhost,127.0.0.1",
    });
  });

  it("reads a proxy given without a scheme as a plain-http proxy, as curl does", () => {
    expect(envProxySettings({ HTTPS_PROXY: "10.0.0.1:3128", http_proxy: "proxy.corp" })).toMatchObject({
      httpsProxy: "http://10.0.0.1:3128",
      httpProxy: "http://proxy.corp",
    });
    expect(envProxySettings({ HTTPS_PROXY: "https://proxy:443" })).toMatchObject({ httpsProxy: "https://proxy:443" });
  });

  it("leaves it to Node when NODE_USE_ENV_PROXY is set", () => {
    expect(envProxySettings({ HTTPS_PROXY: "http://proxy:3128", NODE_USE_ENV_PROXY: "1" })).toEqual({ kind: "node" });
  });

  it("installs a dispatcher only when a proxy is configured", () => {
    const installed: Dispatcher[] = [];
    expect(installEnvProxy({}, (d) => installed.push(d)).kind).toBe("none");
    expect(installEnvProxy({ HTTPS_PROXY: "http://p:1", NODE_USE_ENV_PROXY: "1" }, (d) => installed.push(d)).kind).toBe("node");
    expect(installed).toHaveLength(0);
    installEnvProxy({ HTTPS_PROXY: "http://p:1" }, (d) => installed.push(d));
    expect(installed).toHaveLength(1);
  });

  it("never reports installed when the dispatcher did not reach the key fetch reads", () => {
    // Handed the dispatcher, this installer put it nowhere: fetch still goes direct.
    const setup = installEnvProxy({ HTTPS_PROXY: "http://user:pw@p:1" }, () => {});
    expect(setup.kind).toBe("unrouted");
    expect(setup).toMatchObject({ httpsProxy: "http://user:pw@p:1", noProxy: LOOPBACK_NO_PROXY.join(",") });
  });

  it("reports a proxy value no installer accepts instead of throwing, and installs nothing", () => {
    const installed: Dispatcher[] = [];
    let setup: ReturnType<typeof installEnvProxy> | undefined;
    expect(() => {
      setup = installEnvProxy({ HTTPS_PROXY: "http://[not-an-address" }, (d) => installed.push(d));
    }).not.toThrow();
    expect(setup).toMatchObject({ kind: "invalid", httpsProxy: "http://[not-an-address" });
    expect(installed).toHaveLength(0);
  });

  it("describes a proxy without its credentials", () => {
    expect(describeProxy("http://user:s3cret@proxy.corp:8080/path")).toBe("http://proxy.corp:8080");
    expect(describeProxy("not a url")).toBe("(unparseable proxy URL)");
  });
});

describe("fetch through the environment's proxy", () => {
  const servers: Server[] = [];
  let restoreGlobals: (() => void) | undefined;

  afterEach(async () => {
    restoreGlobals?.();
    restoreGlobals = undefined;
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  const slots = globalThis as unknown as Record<symbol, unknown>;

  /** Every undici generation's global dispatcher, as it stands now. */
  function dispatcherSlots(): Array<readonly [symbol, unknown]> {
    void globalThis.Headers; // loads Node's bundled undici, so its key is there too
    return Object.getOwnPropertySymbols(globalThis)
      .filter((key) => /^undici\.globalDispatcher\.\d+$/u.test(key.description ?? ""))
      .map((key) => [key, slots[key]] as const);
  }

  /**
   * Node's bundled undici and the npm one keep their dispatchers under
   * different versioned keys on globalThis, so restoring through either one's
   * setGlobalDispatcher would leave the other's proxy in place for later tests.
   */
  function saveGlobals(): () => void {
    const saved = dispatcherSlots();
    const agents = { http: http.globalAgent, https: https.globalAgent };
    return () => {
      for (const [key, dispatcher] of saved) slots[key] = dispatcher;
      http.globalAgent = agents.http;
      https.globalAgent = agents.https;
    };
  }

  /**
   * The process environment, as index.ts hands it to installEnvProxy: undici
   * falls back to process.env for a proxy it is not given, so a test that
   * passes its own object would not see a value set aside coming back.
   */
  function stubProxyEnv(vars: Record<string, string>): void {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"]) {
      vi.stubEnv(name, undefined);
    }
    for (const [name, proxy] of Object.entries(vars)) vi.stubEnv(name, proxy);
  }

  async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    return (server.address() as AddressInfo).port;
  }

  /** A proxy that answers "via-proxy" for whatever it is asked to reach; it never resolves the name. */
  async function startProxy(): Promise<{ url: string; tunnelled: string[] }> {
    const tunnelled: string[] = [];
    const proxy = createServer((req, res) => {
      tunnelled.push(`absolute ${req.url ?? ""}`);
      res.end("via-proxy");
    });
    proxy.on("connect", (req, socket) => {
      tunnelled.push(`connect ${req.url ?? ""}`);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia-proxy");
      });
    });
    return { url: `http://127.0.0.1:${await listen(proxy)}`, tunnelled };
  }

  it("sends an outside host through the proxy and loopback directly", async () => {
    // A reply of "via-proxy" proves the request went through the proxy.
    const { url: proxyUrl, tunnelled } = await startProxy();
    const direct = createServer((_req, res) => res.end("direct"));
    const directPort = await listen(direct);

    restoreGlobals = saveGlobals();
    const setup = installEnvProxy({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl });
    expect(setup.kind).toBe("installed");

    // Node's own fetch, as every provider uses it.
    const outside = await fetch("http://upstream.example.test/ping");
    expect(await outside.text()).toBe("via-proxy");
    expect(tunnelled.join("\n")).toContain("upstream.example.test");

    const before = tunnelled.length;
    expect(await (await fetch(`http://127.0.0.1:${directPort}/`)).text()).toBe("direct");
    expect(await (await fetch(`http://localhost:${directPort}/`)).text()).toBe("direct");
    expect(tunnelled).toHaveLength(before);
  });

  it("reports installed exactly when Node's own fetch goes through the proxy", async () => {
    // npm undici's setGlobalDispatcher writes the key its own generation reads;
    // whether this Node's fetch reads that key depends on the undici Node
    // bundles (Node 26's does not). The verdict must match what fetch does.
    const { url: proxyUrl, tunnelled } = await startProxy();
    restoreGlobals = saveGlobals();
    const setup = installEnvProxy({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }, setGlobalDispatcher);

    const reply = await fetch("http://upstream.example.test/ping").then((r) => r.text(), (err: unknown) => err);
    const viaProxy = reply === "via-proxy" && tunnelled.join("\n").includes("upstream.example.test");
    expect({ kind: setup.kind, viaProxy }).toEqual({ kind: viaProxy ? "installed" : "unrouted", viaProxy });
  });

  it("keeps IPv6 loopback direct, where the CLI posts its operator token", async () => {
    const { url: proxyUrl, tunnelled } = await startProxy();
    const directPort = await listen(createServer((_req, res) => res.end("direct")), "::1");

    restoreGlobals = saveGlobals();
    expect(installEnvProxy({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }).kind).toBe("installed");

    const reply = await fetch(`http://[::1]:${directPort}/`).then((r) => r.text(), (err: unknown) => String(err));
    expect({ reply, tunnelled }).toEqual({ reply: "direct", tunnelled: [] });
  });

  it("starts with a proxy given as host:port rather than crashing at startup", async () => {
    const { url: proxyUrl, tunnelled } = await startProxy();
    restoreGlobals = saveGlobals();
    const hostPort = proxyUrl.replace(/^http:\/\//u, "");
    const setup = installEnvProxy({ HTTP_PROXY: hostPort, HTTPS_PROXY: hostPort });
    expect(setup).toMatchObject({ kind: "installed", httpProxy: proxyUrl, httpsProxy: proxyUrl });
    expect(await (await fetch("http://upstream.example.test/ping")).text()).toBe("via-proxy");
    expect(tunnelled.join("\n")).toContain("upstream.example.test");
  });

  it("leaves fetch and the global agents as they were when the proxy value is unusable", async () => {
    const directPort = await listen(createServer((_req, res) => res.end("direct")));
    restoreGlobals = saveGlobals();
    const before = { http: http.globalAgent, https: https.globalAgent, dispatchers: dispatcherSlots() };
    const setup = installEnvProxy({ HTTP_PROXY: "http://[not-an-address", HTTPS_PROXY: "http://[not-an-address" });
    expect(setup.kind).toBe("invalid");
    expect(http.globalAgent).toBe(before.http);
    expect(https.globalAgent).toBe(before.https);
    expect(dispatcherSlots().map(([key]) => key)).toEqual(before.dispatchers.map(([key]) => key));
    for (const [key, dispatcher] of before.dispatchers) expect(slots[key], key.description).toBe(dispatcher);
    // Loopback is direct even through an installed proxy; an address the
    // no-proxy list does not name is not, so a proxy left in place shows here.
    expect(await (await fetch(`http://[::ffff:127.0.0.1]:${directPort}/`)).text()).toBe("direct");
  });

  it("installs the usable proxy when the other variable is unusable, and names the one set aside", async () => {
    // A typo in HTTP_PROXY used to drop a valid HTTPS_PROXY with it: every
    // provider call went direct on a network that only lets the proxy out.
    const { url: proxyUrl, tunnelled } = await startProxy();
    restoreGlobals = saveGlobals();
    stubProxyEnv({ HTTP_PROXY: "http://[not-an-address", HTTPS_PROXY: proxyUrl });
    const setup = installEnvProxy();
    expect(setup).toMatchObject({
      kind: "installed",
      httpsProxy: proxyUrl,
      refused: { variable: "HTTP_PROXY", proxy: "http://[not-an-address" },
    });
    expect(setup).not.toHaveProperty("httpProxy");
    // The stand-in proxy speaks no TLS, so the request fails after the CONNECT it records.
    await fetch("https://upstream.example.test/ping").catch(() => undefined);
    expect(tunnelled).toContain("connect upstream.example.test:443");
  });

  it("installs HTTP_PROXY when HTTPS_PROXY is the unusable one, and https goes through it", async () => {
    const { url: proxyUrl, tunnelled } = await startProxy();
    restoreGlobals = saveGlobals();
    stubProxyEnv({ HTTPS_PROXY: "http://[not-an-address", HTTP_PROXY: proxyUrl });
    const setup = installEnvProxy();
    expect(setup).toMatchObject({
      kind: "installed",
      httpProxy: proxyUrl,
      refused: { variable: "HTTPS_PROXY", proxy: "http://[not-an-address" },
    });
    expect(await (await fetch("http://upstream.example.test/ping")).text()).toBe("via-proxy");
    expect(tunnelled.join("\n")).toContain("upstream.example.test");
    // As with HTTPS_PROXY unset: the warning says so.
    await fetch("https://upstream.example.test/ping").catch(() => undefined);
    expect(tunnelled).toContain("connect upstream.example.test:443");
  });

  it("sets aside a scheme npm undici does not speak, and keeps the proxy it does", async () => {
    // Node 22's route: npm undici's ProxyAgent refuses socks5://.
    const { url: proxyUrl, tunnelled } = await startProxy();
    stubProxyEnv({ HTTP_PROXY: "socks5://user:s3cret@127.0.0.1:1080", HTTPS_PROXY: proxyUrl });
    const installed: Dispatcher[] = [];
    const setup = installEnvProxy(process.env, (d) => installed.push(d));
    expect(setup).toMatchObject({
      httpsProxy: proxyUrl,
      refused: { variable: "HTTP_PROXY", reason: "UND_ERR_INVALID_ARG" },
    });
    expect(installed).toHaveLength(1);
    try {
      await undiciFetch("https://upstream.example.test/ping", { dispatcher: installed[0] }).catch(() => undefined);
    } finally {
      await installed[0]!.close();
    }
    expect(tunnelled).toContain("connect upstream.example.test:443");
  });

  it("reports unrouted when node:http's installer leaves the dispatcher fetch reads as it was", () => {
    // Stands in for a Node whose setGlobalProxyFromEnv writes where this
    // Node's fetch does not read: the verdict must not take the call on trust.
    restoreGlobals = saveGlobals();
    const node = http as { setGlobalProxyFromEnv?: unknown };
    const had = Object.prototype.hasOwnProperty.call(node, "setGlobalProxyFromEnv");
    const original = node.setGlobalProxyFromEnv;
    const inert = vi.fn(() => () => {});
    node.setGlobalProxyFromEnv = inert;
    try {
      const setup = installEnvProxy({ HTTPS_PROXY: "http://127.0.0.1:9" });
      expect(inert).toHaveBeenCalledTimes(1);
      expect(setup).toMatchObject({ kind: "unrouted", httpsProxy: "http://127.0.0.1:9" });
    } finally {
      if (had) node.setGlobalProxyFromEnv = original;
      else delete node.setGlobalProxyFromEnv;
    }
  });

  it("hides the proxy variables from node:http's installer for that call only, whether it takes the route or refuses it", () => {
    // Slack's envProxyAgent() and the processes this one spawns read them from
    // process.env after startup: left deleted, they would connect directly.
    restoreGlobals = saveGlobals();
    stubProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:8" });
    const names = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
    const snapshot = () => Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const before = snapshot();
    const node = http as { setGlobalProxyFromEnv?: unknown };
    const had = Object.prototype.hasOwnProperty.call(node, "setGlobalProxyFromEnv");
    const original = node.setGlobalProxyFromEnv;
    const seen: Array<Record<string, string | undefined>> = [];
    try {
      for (const refuse of [false, true]) {
        node.setGlobalProxyFromEnv = vi.fn(() => {
          seen.push(snapshot());
          if (refuse) throw Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" });
          return () => {};
        });
        const setup = installEnvProxy();
        expect(setup.kind).toBe(refuse ? "invalid" : "unrouted");
        expect(snapshot(), refuse ? "after a refusal" : "after the install").toEqual(before);
      }
    } finally {
      if (had) node.setGlobalProxyFromEnv = original;
      else delete node.setGlobalProxyFromEnv;
    }
    // Once for the route, then the route and each variable alone when refused.
    expect(seen).toHaveLength(4);
    for (const during of seen) expect(Object.values(during).filter((v) => v !== undefined)).toEqual([]);
  });

  it("routes fetch only: the http and https global agents stay as they were", () => {
    restoreGlobals = saveGlobals();
    const before = { http: http.globalAgent, https: https.globalAgent };
    installEnvProxy({ HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" });
    expect(http.globalAgent).toBe(before.http);
    expect(https.globalAgent).toBe(before.https);
  });
});

// Slack's WebClient and Socket Mode build axios with proxy:false, so they reach
// a proxy only through the agent they are handed.
describe("envProxyAgent", () => {
  const servers: Array<Server | net.Server> = [];
  const agents: https.Agent[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.destroy();
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  async function listen(server: Server | net.Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  interface Tunnel {
    authority: string;
    proxyAuthorization?: string;
    /** What the client sent first inside the tunnel. */
    firstBytes?: Buffer;
  }

  /** A proxy that logs every CONNECT and the first bytes sent through it, then hangs up; it never resolves a name. */
  async function startTunnelProxy(status = 200): Promise<{ url: string; tunnels: Tunnel[] }> {
    const tunnels: Tunnel[] = [];
    const proxy = createServer((_req, res) => res.writeHead(405).end());
    proxy.on("connect", (req, socket) => {
      const tunnel: Tunnel = { authority: req.url ?? "", proxyAuthorization: req.headers["proxy-authorization"] };
      tunnels.push(tunnel);
      if (status !== 200) {
        socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", (chunk: Buffer) => {
        tunnel.firstBytes = chunk;
        socket.destroy();
      });
    });
    return { url: `http://127.0.0.1:${await listen(proxy)}`, tunnels };
  }

  /** A plain TCP server standing in for an origin reached directly: it logs the first bytes, then hangs up. */
  async function startOrigin(): Promise<{ port: number; firstBytes: Buffer[] }> {
    const firstBytes: Buffer[] = [];
    const origin = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        firstBytes.push(chunk);
        socket.destroy();
      });
    });
    return { port: await listen(origin), firstBytes };
  }

  function agentFor(env: NodeJS.ProcessEnv): https.Agent {
    const agent = envProxyAgent(env);
    if (agent === undefined) throw new Error("expected an agent");
    agents.push(agent);
    return agent;
  }

  /** One https GET; resolves with how it ended, since none of these servers speaks TLS back. */
  function attempt(url: string, options: https.RequestOptions): Promise<string> {
    return new Promise((resolve) => {
      const req = https.get(url, options, (res) => {
        res.resume();
        resolve(`status ${res.statusCode}`);
      });
      req.on("error", (error: NodeJS.ErrnoException) => resolve(`error ${error.code ?? ""} ${error.message}`));
    });
  }

  /** Whatever the name, the address is loopback: a direct connection lands on the local origin. */
  const toLoopback = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  }) as unknown as net.LookupFunction;

  /** A TLS handshake record (0x16) whose ClientHello names `host`: TLS started for that origin. */
  function isClientHelloFor(bytes: Buffer | undefined, host: string): boolean {
    return bytes !== undefined && bytes[0] === 0x16 && bytes.includes(Buffer.from(host));
  }

  it("is not built when no proxy is named", () => {
    expect(envProxyAgent({})).toBeUndefined();
    expect(envProxyAgent({ NODE_USE_ENV_PROXY: "1" })).toBeUndefined();
  });

  it("is built under NODE_USE_ENV_PROXY too, which proxies Node's global agents but not a client that takes none", async () => {
    // ws (Slack's Socket Mode) opens its own connection when handed no agent.
    const { url: proxyUrl, tunnels } = await startTunnelProxy();
    const agent = agentFor({ HTTPS_PROXY: proxyUrl, NODE_USE_ENV_PROXY: "1" });

    await attempt("https://wss-primary.slack.example.test/link", { agent });

    expect(tunnels.map((t) => t.authority)).toEqual(["wss-primary.slack.example.test:443"]);
    expect(isClientHelloFor(tunnels[0]!.firstBytes, "wss-primary.slack.example.test")).toBe(true);
  });

  it("tunnels https through HTTPS_PROXY and starts TLS with the origin inside the tunnel", async () => {
    const { url: proxyUrl, tunnels } = await startTunnelProxy();
    const agent = agentFor({ HTTPS_PROXY: proxyUrl.replace("http://", "http://bot:p%40ss@") });

    await attempt("https://slack.example.test/api/auth.test", { agent });

    expect(tunnels.map((t) => t.authority)).toEqual(["slack.example.test:443"]);
    expect(tunnels[0]!.proxyAuthorization).toBe(`Basic ${Buffer.from("bot:p@ss").toString("base64")}`);
    expect(isClientHelloFor(tunnels[0]!.firstBytes, "slack.example.test")).toBe(true);
  });

  it("uses HTTP_PROXY for https when HTTPS_PROXY is unset, as fetch's undici does", async () => {
    const { url: proxyUrl, tunnels } = await startTunnelProxy();
    const agent = agentFor({ HTTP_PROXY: proxyUrl });

    await attempt("https://files.example.test:8443/f", { agent });

    expect(tunnels.map((t) => t.authority)).toEqual(["files.example.test:8443"]);
  });

  it("connects directly to NO_PROXY hosts and to loopback", async () => {
    const { url: proxyUrl, tunnels } = await startTunnelProxy();
    const origin = await startOrigin();
    const agent = agentFor({ HTTPS_PROXY: proxyUrl, NO_PROXY: `.corp.test, pinned.test:${origin.port}` });

    await attempt(`https://api.corp.test:${origin.port}/`, { agent, lookup: toLoopback });
    await attempt(`https://pinned.test:${origin.port}/`, { agent, lookup: toLoopback });
    await attempt(`https://127.0.0.1:${origin.port}/`, { agent });
    expect(tunnels).toEqual([]);
    expect(origin.firstBytes).toHaveLength(3);
    expect(isClientHelloFor(origin.firstBytes[0], "api.corp.test")).toBe(true);

    // A port-pinned entry spares only that port, and a suffix entry only names under it.
    await attempt("https://pinned.test/", { agent });
    await attempt("https://notcorp.test/", { agent });
    expect(tunnels.map((t) => t.authority)).toEqual(["pinned.test:443", "notcorp.test:443"]);
  });

  it("fails the request when the proxy refuses the tunnel, naming the status but not the credentials", async () => {
    const { url: proxyUrl, tunnels } = await startTunnelProxy(407);
    const agent = agentFor({ HTTPS_PROXY: proxyUrl.replace("http://", "http://bot:s3cret@") });

    const outcome = await attempt("https://slack.example.test/api/auth.test", { agent });

    expect(tunnels).toHaveLength(1);
    expect(outcome).toMatch(/407/u);
    expect(outcome).not.toContain("s3cret");
  });
});

describe("reportEnvProxy", () => {
  function capture() {
    const lines: Array<{ level: "info" | "warn"; message: string; meta?: Record<string, unknown> }> = [];
    return {
      lines,
      logger: {
        info: (message: string, meta?: Record<string, unknown>) => void lines.push({ level: "info", message, meta }),
        warn: (message: string, meta?: Record<string, unknown>) => void lines.push({ level: "warn", message, meta }),
      },
    };
  }

  it("says nothing when no proxy is in play or Node handles it", () => {
    const { lines, logger } = capture();
    reportEnvProxy({ kind: "none" }, logger);
    reportEnvProxy({ kind: "node" }, logger);
    expect(lines).toEqual([]);
  });

  it("logs an installed proxy at info, without its credentials", () => {
    const { lines, logger } = capture();
    reportEnvProxy({ kind: "installed", httpsProxy: "http://user:s3cret@proxy:3128", noProxy: "localhost" }, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", meta: { httpsProxy: "http://proxy:3128", noProxy: "localhost" } });
    expect(JSON.stringify(lines)).not.toContain("s3cret");
  });

  it("warns that traffic connects directly when fetch does not read the dispatcher", () => {
    const { lines, logger } = capture();
    reportEnvProxy({ kind: "unrouted", httpProxy: "http://user:s3cret@proxy:3128", noProxy: "localhost" }, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", meta: { httpProxy: "http://proxy:3128", node: process.version } });
    expect(lines[0]!.message).toMatch(/connects directly/u);
    expect(JSON.stringify(lines)).not.toContain("s3cret");
  });

  it("warns that an unusable proxy value was set aside, naming why but never the value", () => {
    const { lines, logger } = capture();
    reportEnvProxy({ kind: "invalid", httpsProxy: "http://user:s3cret@[bad", noProxy: "localhost", reason: "ERR_INVALID_URL" }, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", meta: { httpsProxy: "(unparseable proxy URL)", reason: "ERR_INVALID_URL" } });
    expect(lines[0]!.message).toMatch(/connects directly/u);
    expect(JSON.stringify(lines)).not.toContain("s3cret");
  });

  it("names the variable set aside next to the proxy installed, never its credentials", () => {
    const { lines, logger } = capture();
    reportEnvProxy({
      kind: "installed",
      httpsProxy: "http://proxy:3128",
      noProxy: "localhost",
      refused: { variable: "HTTP_PROXY", proxy: "socks5://user:s3cret@sock:1080", reason: "UND_ERR_INVALID_ARG" },
    }, logger);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: "info", meta: { httpsProxy: "http://proxy:3128" } });
    expect(lines[1]).toMatchObject({
      level: "warn",
      meta: { variable: "HTTP_PROXY", proxy: "socks5://sock:1080", reason: "UND_ERR_INVALID_ARG" },
    });
    expect(lines[1]!.message).toMatch(/^HTTP_PROXY .*http requests connect directly/u);
    expect(JSON.stringify(lines)).not.toContain("s3cret");
  });
});
