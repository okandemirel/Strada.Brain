/**
 * Slack behind a proxy-only network. @slack/web-api and Bolt build their
 * axios clients with `proxy: false`, so HTTPS_PROXY reaches them only as the
 * `agent` they are handed; without one every Slack call connected directly.
 *
 * This runs the real Bolt App, Socket Mode client and WebClient. The App is
 * pointed at a name that never resolves and told not to retry, so what the
 * local logging proxy records is exactly what SlackChannel's clients send.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const bolt = vi.hoisted(() => ({ constructed: [] as Array<Record<string, unknown>> }));

vi.mock("@slack/bolt", async (importOriginal) => {
  const real = await importOriginal<typeof import("@slack/bolt")>();
  const silent = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    setLevel: () => {},
    getLevel: () => real.LogLevel.ERROR,
    setName: () => {},
  };
  class App extends real.App {
    constructor(options: ConstructorParameters<typeof real.App>[0] = {}) {
      bolt.constructed.push({ ...options });
      super({
        ...options,
        logger: silent,
        // Bolt's own auth.test at construction would reject unobserved here.
        tokenVerificationEnabled: false,
        clientOptions: { slackApiUrl: "https://slack.example.test/api/", retryConfig: { retries: 0 } },
      });
    }
  }
  return { ...real, App };
});

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

import { SlackChannel } from "./app.js";

describe("SlackChannel behind HTTPS_PROXY", () => {
  const servers: Server[] = [];
  let channel: SlackChannel | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await channel?.disconnect();
    channel = null;
    bolt.constructed.length = 0;
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  /** A proxy that logs every CONNECT and the first bytes sent through it, then hangs up; it never resolves a name. */
  async function startTunnelProxy(): Promise<{ url: string; tunnels: Array<{ authority: string; firstBytes?: Buffer }> }> {
    const tunnels: Array<{ authority: string; firstBytes?: Buffer }> = [];
    const proxy = createServer((_req, res) => res.writeHead(405).end());
    proxy.on("connect", (req, socket) => {
      const tunnel: { authority: string; firstBytes?: Buffer } = { authority: req.url ?? "" };
      tunnels.push(tunnel);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", (chunk: Buffer) => {
        tunnel.firstBytes = chunk;
        socket.destroy();
      });
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, tunnels };
  }

  function stubProxyEnv(proxyUrl: string | undefined): void {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"]) {
      vi.stubEnv(name, undefined);
    }
    if (proxyUrl !== undefined) vi.stubEnv("HTTPS_PROXY", proxyUrl);
  }

  it("sends the Socket Mode handshake and the bot's API calls through the proxy", async () => {
    const proxy = await startTunnelProxy();
    stubProxyEnv(proxy.url);
    channel = new SlackChannel({ botToken: "xoxb-test", signingSecret: "s", appToken: "xapp-test", socketMode: true });

    // apps.connections.open (the app token's client) gets no answer through this proxy.
    await expect(channel.connect()).rejects.toThrow();
    // chat.postMessage on the bot token's client.
    await expect(channel.requestConfirmation({ chatId: "C123", question: "Proceed?" })).rejects.toThrow();

    expect(proxy.tunnels.map((t) => t.authority)).toEqual(["slack.example.test:443", "slack.example.test:443"]);
    for (const tunnel of proxy.tunnels) {
      // A TLS ClientHello for Slack's host: the request itself went inside the tunnel.
      expect(tunnel.firstBytes?.[0]).toBe(0x16);
      expect(tunnel.firstBytes?.includes(Buffer.from("slack.example.test"))).toBe(true);
    }
  });

  it("hands Bolt no agent when no proxy is named, so Slack connects as it always has", async () => {
    stubProxyEnv(undefined);
    channel = new SlackChannel({ botToken: "xoxb-test", signingSecret: "s", appToken: "xapp-test", socketMode: true });
    await expect(channel.connect()).rejects.toThrow();

    expect(bolt.constructed).toHaveLength(1);
    expect(bolt.constructed[0]?.["agent"]).toBeUndefined();
  });
});
