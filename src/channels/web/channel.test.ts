import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebChannel, getCanonicalWebRedirectTarget } from "./channel.js";
import { MAX_INCOMING_TEXT_LENGTH } from "../channel-messages.interface.js";

type WsHandler = (payload?: Buffer) => void;

function createMockSocket() {
  const handlers = new Map<string, WsHandler>();
  const sent: Array<Record<string, unknown>> = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  let readyState = 1;

  return {
    get readyState() {
      return readyState;
    },
    send(payload: string) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
      readyState = 3;
      handlers.get("close")?.();
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
    getCloseCalls() {
      return closeCalls;
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
    expect(sent).toHaveLength(2);
    expect(sent[1]?.chatId).not.toBe(originalChatId);
  });

  it("reclaims the live session during a refresh race when the active token matches", () => {
    const channel = new WebChannel();
    const firstSocket = createMockSocket();

    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(firstSocket);

    const firstConnected = firstSocket.getSentMessages()[0]!;
    const originalChatId = String(firstConnected.chatId);
    const originalReconnectToken = String(firstConnected.reconnectToken);

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
    expect(firstSocket.getCloseCalls()).toEqual([
      { code: 1000, reason: "Session resumed elsewhere" },
    ]);
  });
});

describe("WebChannel post-setup bootstrap", () => {
  it("waits for the resolved session before emitting the post-setup welcome", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();

    channel.setPostSetupBootstrapHandler?.(async ({ chatId }) => {
      await channel.sendText(chatId, "Hi, I'm Strada. What should I call you?");
    });

    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    expect(
      socket.getSentMessages().filter((message) => message.type === "text"),
    ).toHaveLength(0);

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "session_init",
      })),
    );

    const welcomeMessages = socket.getSentMessages()
      .filter((message) => message.type === "text" && message.text === "Hi, I'm Strada. What should I call you?");

    expect(welcomeMessages).toHaveLength(1);
  });

  it("emits exactly one Strada welcome across duplicate session_init handshakes", async () => {
    const channel = new WebChannel();
    const firstSocket = createMockSocket();
    const secondSocket = createMockSocket();

    channel.setPostSetupBootstrapHandler?.(async ({ chatId }) => {
      await channel.sendText(chatId, "Hi, I'm Strada. What should I call you?");
    });

    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(firstSocket);
    firstSocket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "session_init",
      })),
    );

    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(secondSocket);
    secondSocket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "session_init",
      })),
    );

    const welcomeMessages = [
      ...firstSocket.getSentMessages(),
      ...secondSocket.getSentMessages(),
    ].filter((message) => message.type === "text" && message.text === "Hi, I'm Strada. What should I call you?");

    expect(welcomeMessages).toHaveLength(1);
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

  it("forwards trusted origin metadata for mutable proxied requests", async () => {
    const channel = new WebChannel();
    const req = createMockRequest({
      method: "POST",
      url: "/api/user/autonomous",
      headers: {
        origin: "http://127.0.0.1:3000",
        referer: "http://127.0.0.1:3000/settings",
      },
      body: JSON.stringify({ chatId: "default", enabled: true, hours: 4 }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const promise = (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, "/api/user/autonomous");
    req.emitBody();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Origin: "http://127.0.0.1:3000",
        Referer: "http://127.0.0.1:3000/settings",
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("proxies POST /api/vaults (register) for trusted origins", async () => {
    const channel = new WebChannel();
    const req = createMockRequest({
      method: "POST",
      url: "/api/vaults",
      headers: {
        origin: "http://127.0.0.1:3000",
        referer: "http://127.0.0.1:3000/vaults",
      },
      body: JSON.stringify({
        name: "demo",
        rootPath: "/tmp/demo",
        kind: "generic",
      }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "generic:abc", status: "indexing" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const promise = (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, "/api/vaults");
    req.emitBody();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(res.statusCode).toBe(201);
  });

  it("proxies DELETE /api/vaults/:id (unregister) for trusted origins", async () => {
    const channel = new WebChannel();
    const req = createMockRequest({
      method: "DELETE",
      url: "/api/vaults/generic:abc",
      headers: {
        origin: "http://127.0.0.1:3000",
      },
    });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, id: "generic:abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const promise = (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, "/api/vaults/generic:abc");
    req.emitBody();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects POST /api/vaults from untrusted origins", async () => {
    const channel = new WebChannel();
    const req = createMockRequest({
      method: "POST",
      url: "/api/vaults",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ name: "demo", rootPath: "/tmp/demo" }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    await (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, "/api/vaults");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe("WebChannel inbound message limits", () => {
  it("uses the verified web profile identity as the message user id", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    const handler = vi.fn().mockResolvedValue(undefined);

    channel.onMessage(handler);
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "session_init",
      })),
    );

    const profileId = String(socket.getSentMessages()[1]?.profileId);
    const profileToken = String(socket.getSentMessages()[1]?.profileToken);

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "message",
        text: "hello",
        profileId,
        profileToken,
      })),
    );

    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "web",
        userId: profileId,
      }),
    );
  });

  it("acknowledges inbound websocket messages as soon as they are accepted", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    const handler = vi.fn().mockResolvedValue(undefined);

    channel.onMessage(handler);
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "message",
        clientMessageId: "client-msg-1",
        text: "hello",
      })),
    );

    await Promise.resolve();

    expect(socket.getSentMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message_received",
          clientMessageId: "client-msg-1",
        }),
      ]),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
      }),
    );
  });

  it("restores the same durable web identity after a process restart", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "strada-web-channel-"));
    const dbPath = join(tempDir, "web-identities.db");
    let firstChannel: WebChannel | undefined;
    let secondChannel: WebChannel | undefined;
    try {
      firstChannel = new WebChannel(3000, 3100, { identityDbPath: dbPath });
      const firstSocket = createMockSocket();
      (firstChannel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(firstSocket);

      firstSocket.emit(
        "message",
        Buffer.from(JSON.stringify({
          type: "session_init",
        })),
      );

      const firstIdentity = firstSocket.getSentMessages()[1]!;
      const profileId = String(firstIdentity.profileId);
      const profileToken = String(firstIdentity.profileToken);

      secondChannel = new WebChannel(3000, 3100, { identityDbPath: dbPath });
      const secondSocket = createMockSocket();
      const handler = vi.fn().mockResolvedValue(undefined);
      secondChannel.onMessage(handler);
      (secondChannel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(secondSocket);

      secondSocket.emit(
        "message",
        Buffer.from(JSON.stringify({
          type: "session_init",
          profileId,
          profileToken,
        })),
      );
      secondSocket.emit(
        "message",
        Buffer.from(JSON.stringify({
          type: "message",
          text: "hello again",
        })),
      );

      await Promise.resolve();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "web",
          userId: profileId,
        }),
      );
    } finally {
      await firstChannel?.disconnect();
      await secondChannel?.disconnect();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

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

  it("accepts codec-qualified recorder audio and normalizes the MIME type", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    const handler = vi.fn().mockResolvedValue(undefined);

    channel.onMessage(handler);
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "message",
        text: "(voice message)",
        attachments: [
          {
            name: "voice.webm",
            type: "audio/webm;codecs=opus",
            data: Buffer.from("voice").toString("base64"),
          },
        ],
      })),
    );

    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "(voice message)",
        attachments: [
          expect.objectContaining({
            type: "audio",
            mimeType: "audio/webm",
            name: "voice.webm",
          }),
        ],
      }),
    );
  });

  it("does not route placeholder-only messages when every attachment is rejected", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    const handler = vi.fn().mockResolvedValue(undefined);

    channel.onMessage(handler);
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "message",
        clientMessageId: "client-msg-voice",
        text: "(voice message)",
        attachments: [
          {
            name: "voice.wma",
            type: "audio/x-ms-wma",
            data: Buffer.from("voice").toString("base64"),
          },
        ],
      })),
    );

    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(socket.getSentMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message_received",
          clientMessageId: "client-msg-voice",
        }),
        expect.objectContaining({
          type: "text",
          text: 'File "voice.wma" was rejected: unsupported format or invalid content.',
        }),
      ]),
    );
  });
});

describe("WebChannel HTTP surface", () => {
  it("serves /health without requiring the static app or dashboard proxy", async () => {
    const channel = new WebChannel();
    const req = createMockRequest({ method: "GET", url: "/health" });
    const res = createMockResponse();

    await (channel as unknown as {
      handleHttp: (req: unknown, res: unknown) => Promise<void>;
    }).handleHttp(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(
      expect.objectContaining({
        status: "degraded",
        channel: "web",
      }),
    );
  });

  it("strips stale setup handoff query params from the root URL", () => {
    expect(getCanonicalWebRedirectTarget("/?strada-setup=1&t=12345")).toBe("/");
  });

  it("preserves unrelated query params and hashes when removing stale setup mode", () => {
    expect(getCanonicalWebRedirectTarget("/dashboard?foo=bar&strada-setup=1&t=99#memory")).toBe("/dashboard?foo=bar#memory");
  });

  it("returns null when no stale setup query is present", () => {
    expect(getCanonicalWebRedirectTarget("/dashboard?foo=bar")).toBeNull();
  });
});
