import http, { createServer, type Server } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalDispatcher, type Dispatcher } from "undici";
import { LOOPBACK_NO_PROXY, describeProxy, envProxySettings, installEnvProxy } from "./env-proxy.js";

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
      noProxy: "corp.local,.internal,localhost,127.0.0.1,::1",
    });
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
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  /**
   * Node's bundled undici and the npm one keep their dispatchers under
   * different versioned keys on globalThis, so restoring through either one's
   * setGlobalDispatcher would leave the other's proxy in place for later tests.
   */
  function saveGlobals(): () => void {
    void globalThis.Headers; // loads Node's bundled undici, so its key is saved too
    const slots = globalThis as unknown as Record<symbol, unknown>;
    const saved = Object.getOwnPropertySymbols(globalThis)
      .filter((key) => /^undici\.globalDispatcher\.\d+$/u.test(key.description ?? ""))
      .map((key) => [key, slots[key]] as const);
    const agents = { http: http.globalAgent, https: https.globalAgent };
    return () => {
      for (const [key, dispatcher] of saved) slots[key] = dispatcher;
      http.globalAgent = agents.http;
      https.globalAgent = agents.https;
    };
  }

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

  it("routes fetch only: the http and https global agents stay as they were", () => {
    restoreGlobals = saveGlobals();
    const before = { http: http.globalAgent, https: https.globalAgent };
    installEnvProxy({ HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" });
    expect(http.globalAgent).toBe(before.http);
    expect(https.globalAgent).toBe(before.https);
  });
});
