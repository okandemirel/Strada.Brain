import { describe, expect, it, vi, afterEach } from "vitest";
import { WebChannel } from "./channel.js";
import { MAX_INCOMING_TEXT_LENGTH } from "../channel-messages.interface.js";

type WsHandler = (payload?: Buffer) => void;

function createMockSocket() {
  const handlers = new Map<string, WsHandler>();
  const sent: Array<Record<string, unknown>> = [];

  return {
    readyState: 1,
    send(payload: string) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
    on(event: string, handler: WsHandler) {
      handlers.set(event, handler);
    },
    emit(event: string, payload?: Buffer) {
      handlers.get(event)?.(payload);
    },
    getSentMessages() {
      return sent;
    },
  };
}

function createMockRequest(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const handlers = new Map<string, Array<(payload?: Buffer) => void>>();

  return {
    method: opts.method ?? "GET",
    url: opts.url ?? "/api/metrics",
    headers: opts.headers ?? {},
    on(event: string, handler: (payload?: Buffer) => void) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return this;
    },
    emit(event: string, payload?: Buffer) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
    emitBody() {
      if (opts.body) {
        this.emit("data", Buffer.from(opts.body));
      }
      this.emit("end");
    },
    destroy() {},
  };
}

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? "";
      return this;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WebChannel reconnect security", () => {
  it("requires the reconnect token to reclaim a recently disconnected chatId", () => {
    const channel = new WebChannel();
    const firstSocket = createMockSocket();

    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(firstSocket);

    const firstConnected = firstSocket.getSentMessages()[0]!;
    const originalChatId = String(firstConnected.chatId);
    const originalReconnectToken = String(firstConnected.reconnectToken);

    firstSocket.emit("close");

    const secondSocket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(secondSocket);

    secondSocket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "reconnect",
        chatId: originalChatId,
        reconnectToken: originalReconnectToken,
      })),
    );

    const sent = secondSocket.getSentMessages();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.chatId).toBe(originalChatId);
    expect(sent[1]?.reconnectToken).not.toBe(originalReconnectToken);
  });

  it("rejects reconnect attempts with the wrong token even if the chatId is known", () => {
    const channel = new WebChannel();
    const firstSocket = createMockSocket();

    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(firstSocket);

    const firstConnected = firstSocket.getSentMessages()[0]!;
    const originalChatId = String(firstConnected.chatId);

    firstSocket.emit("close");

    const secondSocket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(secondSocket);

    secondSocket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "reconnect",
        chatId: originalChatId,
        reconnectToken: "wrong-token",
      })),
    );

    const sent = secondSocket.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).not.toBe(originalChatId);
  });
});

describe("WebChannel dashboard proxy", () => {
  it("injects the configured dashboard bearer token for proxied requests", async () => {
    const channel = new WebChannel(3000, 3100, { dashboardAuthToken: "proxy-secret" });
    const req = createMockRequest({
      method: "GET",
      url: "/api/metrics",
    });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, "/api/metrics");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer proxy-secret",
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects mutable proxy requests from untrusted origins", async () => {
    const channel = new WebChannel();
    const req = createMockRequest({
      method: "POST",
      url: "/api/routing/preset",
      headers: {
        origin: "https://evil.example",
      },
      body: JSON.stringify({ preset: "balanced" }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    await (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, "/api/routing/preset");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
  });
});

describe("WebChannel inbound message limits", () => {
  it("truncates oversized websocket text before routing it", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    const handler = vi.fn().mockResolvedValue(undefined);

    channel.onMessage(handler);
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "message",
        text: "b".repeat(MAX_INCOMING_TEXT_LENGTH + 25),
      })),
    );

    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "b".repeat(MAX_INCOMING_TEXT_LENGTH),
      }),
    );
  });
});
