import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
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
    expect(installEnvProxy({ HTTPS_PROXY: "http://p:1" }, (d) => installed.push(d)).kind).toBe("installed");
    expect(installed).toHaveLength(1);
  });

  it("describes a proxy without its credentials", () => {
    expect(describeProxy("http://user:s3cret@proxy.corp:8080/path")).toBe("http://proxy.corp:8080");
    expect(describeProxy("not a url")).toBe("(unparseable proxy URL)");
  });
});

describe("fetch through the environment's proxy", () => {
  const servers: Server[] = [];
  let previous: Dispatcher | undefined;

  afterEach(async () => {
    if (previous) setGlobalDispatcher(previous);
    previous = undefined;
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("sends an outside host through the proxy and loopback directly", async () => {
    // The proxy answers for whatever it tunnels to, so a reply of "via-proxy"
    // proves the request went through it; it never resolves the name.
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
    const proxyPort = await listen(proxy);
    const direct = createServer((_req, res) => res.end("direct"));
    const directPort = await listen(direct);

    previous = getGlobalDispatcher();
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
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
});
