/**
 * CHN-2 — the portal answers only for Host names it can vouch for.
 *
 * Loopback binding keeps other machines out, not other origins: a page whose
 * hostname resolves to this machine talks to the portal as "same-origin", sends
 * no Origin on a GET, and the proxy used to add the dashboard token to what it
 * forwarded. The Host header still names that page's hostname, so it is checked
 * before any route — HTTP and the WebSocket handshake alike.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebChannel } from "./channel.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

interface Reply {
  status: number;
  body: string;
}

function send(port: number, path: string, host: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Whether a chat WebSocket handshake presenting `host` is accepted. */
function wsAccepted(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { host } });
    ws.on("open", () => { ws.terminate(); resolve(true); });
    ws.on("unexpected-response", () => resolve(false));
    ws.on("error", () => resolve(false));
  });
}

const dashboardReply = () =>
  vi.fn().mockImplementation(async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

describe("WebChannel Host validation (CHN-2)", () => {
  let channel: WebChannel | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await channel?.disconnect();
    channel = null;
  });

  async function start(options: ConstructorParameters<typeof WebChannel>[2] = {}): Promise<number> {
    channel = new WebChannel(0, 3100, { dashboardAuthToken: "dash-secret", allowedHosts: [], trustedOrigins: [], ...options });
    await channel.connect();
    const addr = (channel as unknown as { server: { address: () => { port: number } } }).server.address();
    return addr.port;
  }

  it("refuses a foreign Host before the proxy — the dashboard token is never used", async () => {
    const fetchMock = dashboardReply();
    vi.stubGlobal("fetch", fetchMock);
    const port = await start();

    const reply = await send(port, "/api/config", `evil.test:${port}`);

    expect(reply.status).toBe(403);
    expect(reply.body).toContain("HTTP_ALLOWED_HOSTS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a foreign Host on the static routes too", async () => {
    const port = await start();
    expect((await send(port, "/", `evil.test:${port}`)).status).toBe(403);
    expect((await send(port, "/health", `evil.test:${port}`)).status).toBe(403);
  });

  it("still proxies the portal's own loopback request, token included", async () => {
    const fetchMock = dashboardReply();
    vi.stubGlobal("fetch", fetchMock);
    const port = await start();

    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      fetchMock.mockClear();
      const reply = await send(port, "/api/config", host);
      expect(reply.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
      expect(init.headers["Authorization"]).toBe("Bearer dash-secret");
    }
  });

  it("serves an operator-configured host and a trusted origin's hostname", async () => {
    vi.stubGlobal("fetch", dashboardReply());
    const port = await start({ allowedHosts: ["strada.example"], trustedOrigins: ["https://portal.example"] });

    expect((await send(port, "/api/config", "strada.example")).status).toBe(200);
    expect((await send(port, "/api/config", "portal.example")).status).toBe(200);
    expect((await send(port, "/api/config", "evil.example")).status).toBe(403);
  });

  it("refuses the chat WebSocket handshake for a foreign Host", async () => {
    const port = await start();
    expect(await wsAccepted(port, `evil.test:${port}`)).toBe(false);
    expect(await wsAccepted(port, `127.0.0.1:${port}`)).toBe(true);
  });

  it("never adds the dashboard token to a request whose Host is not verified", async () => {
    // Defense in depth at the injection site itself, independent of the
    // handler-level gate above.
    const fetchMock = dashboardReply();
    vi.stubGlobal("fetch", fetchMock);
    channel = new WebChannel(3000, 3100, { dashboardAuthToken: "dash-secret", allowedHosts: [], trustedOrigins: [] });
    const res = { statusCode: 0, headersSent: false, writeHead(status: number) { this.statusCode = status; return this; }, end() { return this; } };
    const req = { method: "GET", url: "/api/config", headers: { host: "evil.test:3000" }, on() { return this; } };

    await (channel as unknown as {
      proxyToDashboard: (r: unknown, s: unknown, u: string) => Promise<void>;
    }).proxyToDashboard(req, res, "/api/config");

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> } | undefined;
    expect(init?.headers["Authorization"]).toBeUndefined();
  });
});
