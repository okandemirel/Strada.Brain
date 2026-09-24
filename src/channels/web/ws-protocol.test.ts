import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebChannel } from "./channel.js";
import { WS_CHAT_PATH } from "./ws-protocol.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

// WEB-14: the portal connects on WS_CHAT_PATH (the path `vite dev` proxies);
// the built portal is served by this channel, which must accept it there.
describe("WebChannel chat socket path (WEB-14)", () => {
  let channel: WebChannel | null = null;

  afterEach(async () => {
    await channel?.disconnect();
    channel = null;
  });

  it("accepts the chat socket on the portal's path and answers session_init", async () => {
    channel = new WebChannel(0, 3100, { allowedHosts: [], trustedOrigins: [] });
    await channel.connect();
    const { port } = (channel as unknown as { server: { address: () => { port: number } } }).server.address();

    const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_CHAT_PATH}`, { headers: { host: `127.0.0.1:${port}` } });
      ws.on("open", () => ws.send(JSON.stringify({ type: "session_init" })));
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.type !== "connected") return;
        ws.terminate();
        resolve(frame);
      });
      ws.on("error", reject);
      ws.on("unexpected-response", () => reject(new Error("handshake refused")));
    });

    expect(first.type).toBe("connected");
    expect(typeof first.chatId).toBe("string");
  });
});
