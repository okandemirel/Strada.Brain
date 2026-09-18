import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WebChannel, getCanonicalWebRedirectTarget } from "./channel.js";
import { MAX_INCOMING_TEXT_LENGTH } from "../channel-messages.interface.js";
import { TypedEventBus } from "../../core/event-bus.js";
import { createMonitorBridge } from "../../dashboard/monitor-bridge.js";
import type { WorkspaceEventMap } from "../../dashboard/workspace-events.js";

type WsHandler = (payload?: Buffer) => void;

function createMockSocket() {
  const handlers = new Map<string, WsHandler>();
  const sent: Array<Record<string, unknown>> = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  let readyState = 1;
  let pingCount = 0;
  let terminated = false;

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
    ping() {
      pingCount++;
    },
    terminate() {
      terminated = true;
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
    getPingCount() {
      return pingCount;
    },
    isTerminated() {
      return terminated;
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
  // Regression (H4): an unauthenticated WS request supplying a known (public)
  // profileId via the legacy path must NOT overwrite that profile's auth token.
  it("does not let an unauthenticated legacy request take over an existing profile", () => {
    const channel = new WebChannel();
    const store = (channel as unknown as {
      identityStore: {
        issue: (id?: string) => { profileId: string; profileToken: string };
        verify: (id: string, token: string) => boolean;
      };
    }).identityStore;
    const victim = store.issue();

    const result = (channel as unknown as {
      resolveWebIdentity: (d: Record<string, unknown>) => { profileId: string };
    }).resolveWebIdentity({ legacyProfileChatId: victim.profileId });

    // Attacker gets a fresh identity, not the victim's profile…
    expect(result.profileId).not.toBe(victim.profileId);
    // …and the victim's original token still verifies (was not overwritten).
    expect(store.verify(victim.profileId, victim.profileToken)).toBe(true);
  });

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

// ── Audit 13F6 / plan 4.8: the portal's own origin is a host:port, and the
// proxy token alone is not an identity ──
//
// isAllowedOrigin compared only the HOSTNAME, so every page served by any other
// process on the loopback interface (`http://localhost:<other port>`) counted as
// the portal's own origin: it could POST to the /api/* proxy and open a chat
// WebSocket. The browser's same-origin rule is scheme+host+PORT; the port is what
// names the one server allowed to talk to itself.
// ── Audit 13F5 / plan 4.7: a profile's monitor traffic is its own ──
//
// broadcastRaw fanned every monitor frame out to every socket and
// replayMonitorState handed every retained root's board to whoever reconnected,
// so one portal profile saw another's DAG, Kanban cards and the request text
// those cards are labelled with. Frames now carry an origin and the transport
// filters on it.
describe("WebChannel monitor profile boundary (13F5 / 4.7)", () => {
  /** A client whose session_init claims `profileId`, with the token that proves it. */
  function connectProfile(channel: WebChannel, profileId?: string) {
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const init: Record<string, unknown> = { type: "session_init" };
    if (profileId) {
      const store = (channel as unknown as {
        identityStore: { issue: (id?: string) => { profileId: string; profileToken: string } };
      }).identityStore;
      const identity = store.issue(profileId);
      init.profileId = identity.profileId;
      init.profileToken = identity.profileToken;
    }
    socket.emit("message", Buffer.from(JSON.stringify(init)));
    const connected = socket.getSentMessages().filter((m) => m.type === "connected").at(-1)!;
    return { socket, connected, chatId: String(connected.chatId), reconnectToken: String(connected.reconnectToken) };
  }

  function frame(type: string, payload: Record<string, unknown>, origin?: string): string {
    return JSON.stringify({ type, payload, ...(origin ? { origin } : {}), timestamp: 1 });
  }

  function typesOf(socket: ReturnType<typeof createMockSocket>, type: string) {
    return socket.getSentMessages().filter((m) => m.type === type);
  }

  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("does not deliver one profile's monitor frame to another profile's socket", async () => {
    const channel = new WebChannel();
    const alice = connectProfile(channel, A);
    const bob = connectProfile(channel, B);

    channel.broadcastRaw(
      frame("monitor:dag_init", { rootId: "ep-A", nodes: [{ id: "n1", task: "alice's secret request" }] }, A),
    );

    expect(typesOf(alice.socket, "monitor:dag_init")).toHaveLength(1);
    expect(typesOf(bob.socket, "monitor:dag_init")).toHaveLength(0);

    await channel.disconnect();
  });

  it("does not replay another profile's retained board on reconnect", async () => {
    const channel = new WebChannel();
    const alice = connectProfile(channel, A);
    channel.broadcastRaw(frame("monitor:dag_init", { rootId: "ep-A", nodes: [{ id: "n1" }] }, A));
    channel.broadcastRaw(frame("monitor:task_update", { rootId: "ep-A", nodeId: "n1", status: "completed" }, A));
    alice.socket.close();

    // A DIFFERENT profile connects fresh — it must not inherit alice's board.
    const bob = connectProfile(channel, B);
    expect(typesOf(bob.socket, "monitor:dag_init")).toHaveLength(0);
    expect(typesOf(bob.socket, "monitor:task_update")).toHaveLength(0);

    await channel.disconnect();
  });

  // ── Guard: the traffic the filter must still carry ──

  it("replays the profile's OWN retained board on reconnect", async () => {
    const channel = new WebChannel();
    const alice = connectProfile(channel, A);
    channel.broadcastRaw(frame("monitor:dag_init", { rootId: "ep-A", nodes: [{ id: "n1" }] }, A));
    channel.broadcastRaw(frame("monitor:task_update", { rootId: "ep-A", nodeId: "n1", status: "completed" }, A));
    alice.socket.close();

    const again = connectProfile(channel, A);
    expect(typesOf(again.socket, "monitor:dag_init")).toHaveLength(1);
    expect(typesOf(again.socket, "monitor:task_update")).toHaveLength(1);

    await channel.disconnect();
  });

  it("still broadcasts a frame that carries no origin to every profile", async () => {
    const channel = new WebChannel();
    const alice = connectProfile(channel, A);
    const bob = connectProfile(channel, B);

    channel.broadcastRaw(frame("canvas:shapes_add", { shapes: [] }));
    channel.broadcastRaw(frame("budget:warning", { pct: 80 }));

    for (const [name, c] of [["alice", alice], ["bob", bob]] as const) {
      expect(typesOf(c.socket, "canvas:shapes_add"), name).toHaveLength(1);
      expect(typesOf(c.socket, "budget:warning"), name).toHaveLength(1);
    }

    await channel.disconnect();
  });

  // ── Round 10 #4, end to end: the bridge and the transport together ──
  //
  // Node ownership was a flat 200-entry LRU, so Alice's 201-node DAG evicted the
  // attribution of its OWN first nodes; their later progress:narrative — the
  // milestone wording derived from Alice's request — carried no origin and the
  // transport therefore fanned it out to Bob. This drives the real bridge into
  // the real channel, live delivery and reconnect replay.
  it("leaks nothing of a 201-node DAG to another profile, live or on replay", async () => {
    const channel = new WebChannel();
    const bus = new TypedEventBus<WorkspaceEventMap>();
    const bridge = createMonitorBridge(bus, (message) => channel.broadcastRaw(message));
    bridge.start();

    const alice = connectProfile(channel, A);
    const bob = connectProfile(channel, B);

    bus.emit("monitor:dag_init", {
      rootId: "ep-A",
      nodes: Array.from({ length: 201 }, (_, i) => ({ id: `n${i}` })),
      edges: [],
      conversationId: A,
    });
    // The FIRST node of the board — the entry the old bound dropped.
    bus.emit("progress:narrative", { nodeId: "n0", narrative: "Alice: the secret request", lang: "en" });
    bus.emit("monitor:substep", { rootId: "ep-A", nodeId: "n0", substep: "writing the secret" });

    expect(typesOf(alice.socket, "progress:narrative")).toHaveLength(1);
    expect(typesOf(alice.socket, "monitor:substep")).toHaveLength(1);
    expect(typesOf(bob.socket, "progress:narrative")).toHaveLength(0);
    expect(typesOf(bob.socket, "monitor:substep")).toHaveLength(0);
    expect(JSON.stringify(bob.socket.getSentMessages())).not.toContain("secret");

    // …and the replay a reconnecting Bob gets holds none of it either.
    bob.socket.close();
    const bobAgain = connectProfile(channel, B);
    expect(JSON.stringify(bobAgain.socket.getSentMessages())).not.toContain("secret");

    bridge.stop();
    await channel.disconnect();
  });

  it("still shows another CHANNEL's activity (an origin that is not a web profile)", async () => {
    const channel = new WebChannel();
    const alice = connectProfile(channel, A);
    const bob = connectProfile(channel, B);

    // A Telegram conversation scope: never issued by this channel's identity store.
    channel.broadcastRaw(frame("monitor:dag_init", { rootId: "ep-T", nodes: [] }, "telegram-chat-4711"));

    expect(typesOf(alice.socket, "monitor:dag_init")).toHaveLength(1);
    expect(typesOf(bob.socket, "monitor:dag_init")).toHaveLength(1);

    await channel.disconnect();
  });
});

describe("WebChannel origin boundary (13F6 / 4.8)", () => {
  function proxy(channel: WebChannel, req: unknown, res: unknown, url: string): Promise<void> {
    return (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, url);
  }

  function acceptsWsOrigin(channel: WebChannel, headers: Record<string, string>): boolean {
    return (channel as unknown as {
      acceptsWsOrigin: (req: { headers: Record<string, string | string[] | undefined> }) => boolean;
    }).acceptsWsOrigin({ headers });
  }

  it("refuses a mutable proxy request from another loopback PORT", async () => {
    const channel = new WebChannel(3000, 3100);
    const req = createMockRequest({
      method: "POST",
      url: "/api/user/autonomous",
      headers: { origin: "http://127.0.0.1:9999" },
      body: JSON.stringify({ enabled: true }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pending = proxy(channel, req, res, "/api/user/autonomous");
    req.emitBody();
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  /** A POST the origin gate would otherwise accept, so only the path decides. */
  async function trustedPost(url, method = "POST") {
    const channel = new WebChannel(3000, 3100);
    const req = createMockRequest({
      method,
      url,
      headers: { origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ decisions: [] }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pending = proxy(channel, req, res, url);
    req.emitBody();
    await pending;
    return { res, fetchMock };
  }

  it("round 12 #10 forwards a VERIFIED identity to the dashboard, and never a claimed one", async () => {
    // The routes behind this proxy decide per identity — a change-review
    // decision belongs to the instance owner — so an unattributed request is
    // refused on a shared instance. Everything but Authorization/Origin/Referer
    // used to be dropped here, so the identity never arrived.
    const channel = new WebChannel(3000, 3100);
    const store = (channel as unknown as {
      identityStore: { issue: (id?: string) => { profileId: string; profileToken: string } };
    }).identityStore;
    const identity = store.issue();
    const url = "/api/workspace/change-review/r1/decisions";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const req = createMockRequest({
      method: "POST",
      url,
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-strada-profile-id": identity.profileId,
        "x-strada-profile-token": identity.profileToken,
      },
      body: JSON.stringify({ decisions: [] }),
    });
    const pending = proxy(channel, req, createMockResponse(), url);
    req.emitBody();
    await pending;
    const forwarded = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(forwarded["x-strada-profile-id"]).toBe(identity.profileId);
    expect(forwarded["x-strada-profile-token"]).toBe(identity.profileToken);

    // A CLAIMED identity this store never issued is not forwarded at all, so
    // the dashboard sees an unattributed request rather than a borrowed one.
    fetchMock.mockClear();
    const liar = createMockRequest({
      method: "POST",
      url,
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-strada-profile-id": identity.profileId,
        "x-strada-profile-token": "not-the-token",
      },
      body: JSON.stringify({ decisions: [] }),
    });
    const second = proxy(channel, liar, createMockResponse(), url);
    liar.emitBody();
    await second;
    const claimed = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(claimed["x-strada-profile-id"]).toBeUndefined();
    expect(claimed["x-strada-profile-token"]).toBeUndefined();
  });

  it("round 12 #11 refuses a write whose path is not the path that would act", async () => {
    // `/api/workspace/change-review/../../update` matched the mutable prefix
    // and then became `/api/update` downstream: authorization and effect were
    // about two different routes.
    for (const url of [
      "/api/workspace/change-review/../../update",
      "/api/workspace/change-review/%2e%2e/%2e%2e/update",
      "/api/workspace/change-review//r1/decisions",
      "/api/workspace/change-review/r1%2fdecisions",
      "/api/workspace/change-review/r1/decisions/",
      // The bare prefix with its trailing slash is not a route either.
      "/api/workspace/change-review/",
      "/api/workspace/change-review/%",
    ]) {
      const { res, fetchMock } = await trustedPost(url);
      expect(fetchMock, url).not.toHaveBeenCalled();
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("round 12 #11 only the decisions route under change-review may be written", async () => {
    // The prefix made every descendant writable by POST, PUT and DELETE.
    for (const [url, method] of [
      ["/api/workspace/change-review/r1", "POST"],
      ["/api/workspace/change-review/r1/decisions", "DELETE"],
      ["/api/workspace/change-review/r1/decisions", "PUT"],
      ["/api/workspace/change-review/r1/anything-else", "POST"],
    ]) {
      const { res, fetchMock } = await trustedPost(url, method);
      expect(fetchMock, `${method} ${url}`).not.toHaveBeenCalled();
      expect(res.statusCode, `${method} ${url}`).toBe(405);
    }
    // …and the one route the portal actually calls still goes through.
    const { fetchMock } = await trustedPost("/api/workspace/change-review/r1/decisions");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("refuses a mutable proxy request whose only credential is a foreign-port Referer", async () => {
    const channel = new WebChannel(3000, 3100);
    const req = createMockRequest({
      method: "POST",
      url: "/api/user/autonomous",
      headers: { referer: "http://localhost:4321/index.html" },
      body: JSON.stringify({ enabled: true }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pending = proxy(channel, req, res, "/api/user/autonomous");
    req.emitBody();
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("refuses a read-only proxy GET from another loopback PORT", async () => {
    const channel = new WebChannel(3000, 3100);
    const req = createMockRequest({
      method: "GET",
      url: "/api/metrics",
      headers: { origin: "http://localhost:5173" },
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await proxy(channel, req, res, "/api/metrics");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("never forwards a foreign-port Origin/Referer to the dashboard", async () => {
    const channel = new WebChannel(3000, 3100);
    const req = createMockRequest({
      method: "GET",
      url: "/api/metrics",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await proxy(channel, req, res, "/api/metrics");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Origin");
    expect(headers).not.toHaveProperty("Referer");
  });

  it("refuses a chat WebSocket whose Origin is another loopback port", () => {
    const channel = new WebChannel(3000, 3100);
    expect(acceptsWsOrigin(channel, { origin: "http://localhost:9999" })).toBe(false);
    expect(acceptsWsOrigin(channel, { origin: "http://127.0.0.1:1234" })).toBe(false);
  });

  // The proxy's Authorization fallback used to trust ANY caller that held the
  // dashboard token. The token is now only half of the credential: the caller
  // must also present a profile identity THIS server issued.
  it("refuses a header-only mutable proxy request that has the token but no identity", async () => {
    const channel = new WebChannel(3000, 3100, { dashboardAuthToken: "proxy-secret" });
    const req = createMockRequest({
      method: "POST",
      url: "/api/user/autonomous",
      headers: { authorization: "Bearer proxy-secret" },
      body: JSON.stringify({ enabled: true }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pending = proxy(channel, req, res, "/api/user/autonomous");
    req.emitBody();
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  // ── Guard: the legitimate traffic a stricter rule must still carry ──

  it("still accepts the portal's own origin on its own port", async () => {
    const channel = new WebChannel(3000, 3100);
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      const req = createMockRequest({
        method: "POST",
        url: "/api/user/autonomous",
        headers: { origin },
        body: JSON.stringify({ enabled: true }),
      });
      const res = createMockResponse();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const pending = proxy(channel, req, res, "/api/user/autonomous");
      req.emitBody();
      await pending;
      expect(fetchMock, origin).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Origin).toBe(origin);
      expect(res.statusCode).toBe(200);
    }
  });

  it("still accepts a header-less non-browser GET and a same-port chat WebSocket", async () => {
    const channel = new WebChannel(3000, 3100);
    expect(acceptsWsOrigin(channel, {})).toBe(true);
    expect(acceptsWsOrigin(channel, { origin: "http://localhost:3000" })).toBe(true);

    const req = createMockRequest({ method: "GET", url: "/api/metrics", headers: {} });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await proxy(channel, req, res, "/api/metrics");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it("accepts the token path when it carries an identity this server issued", async () => {
    const channel = new WebChannel(3000, 3100, { dashboardAuthToken: "proxy-secret" });
    const identity = (channel as unknown as {
      identityStore: { issue: (id?: string) => { profileId: string; profileToken: string } };
    }).identityStore.issue();

    const req = createMockRequest({
      method: "POST",
      url: "/api/user/autonomous",
      headers: {
        authorization: "Bearer proxy-secret",
        "x-strada-profile-id": identity.profileId,
        "x-strada-profile-token": identity.profileToken,
      },
      body: JSON.stringify({ enabled: true }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = proxy(channel, req, res, "/api/user/autonomous");
    req.emitBody();
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it("refuses a forged identity on the token path", async () => {
    const channel = new WebChannel(3000, 3100, { dashboardAuthToken: "proxy-secret" });
    const identity = (channel as unknown as {
      identityStore: { issue: (id?: string) => { profileId: string; profileToken: string } };
    }).identityStore.issue();

    const req = createMockRequest({
      method: "POST",
      url: "/api/user/autonomous",
      headers: {
        authorization: "Bearer proxy-secret",
        "x-strada-profile-id": identity.profileId,
        "x-strada-profile-token": "not-the-token",
      },
      body: JSON.stringify({ enabled: true }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pending = proxy(channel, req, res, "/api/user/autonomous");
    req.emitBody();
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  // ── Round 11 #20: the portal's change-review decisions have to get through ──
  //
  // /api/workspace was read-only in the proxy, so the POST that carries an
  // accept/reject would have been answered 405 here and never reached
  // applyUndo — the transport would have looked wired and done nothing.
  it("forwards a same-origin POST of change-review decisions to the dashboard", async () => {
    const channel = new WebChannel(3000, 3100);
    const url = "/api/workspace/change-review/9f3a1c2d/decisions";
    const body = JSON.stringify({ decisions: [{ path: "Assets/Scripts/Existing.cs", decision: "undo" }] });
    const req = createMockRequest({
      method: "POST",
      url,
      headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body,
    });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ outcome: "undone", applied: ["Assets/Scripts/Existing.cs"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = proxy(channel, req, res, url);
    req.emitBody();
    await pending;

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [forwardedUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(forwardedUrl).toBe(`http://127.0.0.1:3100${url}`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
  });

  it("still refuses a change-review POST from another loopback port", async () => {
    const channel = new WebChannel(3000, 3100);
    const url = "/api/workspace/change-review/9f3a1c2d/decisions";
    const req = createMockRequest({
      method: "POST",
      url,
      headers: { origin: "http://127.0.0.1:9999" },
      body: JSON.stringify({ decisions: [] }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pending = proxy(channel, req, res, url);
    req.emitBody();
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  // The file-explorer routes under the same prefix stay read-only.
  it("keeps the rest of /api/workspace read-only", async () => {
    const channel = new WebChannel(3000, 3100);
    const url = "/api/workspace/file?path=Assets/Scripts/Existing.cs";
    const req = createMockRequest({
      method: "POST",
      url,
      headers: { origin: "http://127.0.0.1:3000" },
      body: "{}",
    });
    const res = createMockResponse();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pending = proxy(channel, req, res, url);
    req.emitBody();
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
  });
});

// ── Round 10 #19: the port-aware rule refused the project's OWN topologies ──
//
// Trusting only the bound port meant the portal could not be served through
// anything: run it behind its own Vite dev proxy (web-portal/vite.config.ts
// proxies /ws, /api and /health from :5173 to the backend on :3000) and the
// browser keeps origin http://localhost:5173 on the WebSocket handshake and on
// every mutation, so the portal refused its own pages. An HTTPS reverse proxy in
// front of the daemon had the same problem. Trusted origins are configured, as
// COMPLETE origins; the bound port is always trusted and an unrelated loopback
// port is still another process.
describe("WebChannel trusted proxy origins (round 10 #19)", () => {
  function proxy(channel: WebChannel, req: unknown, res: unknown, url: string): Promise<void> {
    return (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, url);
  }

  function acceptsWsOrigin(channel: WebChannel, headers: Record<string, string>): boolean {
    return (channel as unknown as {
      acceptsWsOrigin: (req: { headers: Record<string, string | string[] | undefined> }) => boolean;
    }).acceptsWsOrigin({ headers });
  }

  async function mutate(channel: WebChannel, headers: Record<string, string>) {
    const req = createMockRequest({
      method: "POST",
      url: "/api/user/autonomous",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = proxy(channel, req, res, "/api/user/autonomous");
    req.emitBody();
    await pending;
    return { res, fetchMock };
  }

  async function read(channel: WebChannel, headers: Record<string, string>) {
    const req = createMockRequest({ method: "GET", url: "/api/metrics", headers });
    const res = createMockResponse();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await proxy(channel, req, res, "/api/metrics");
    return { res, fetchMock };
  }

  const VITE = "http://localhost:5173";

  it("serves the portal through its documented Vite dev proxy origin", async () => {
    const channel = new WebChannel(3000, 3100, { trustedOrigins: [VITE] });

    // The WebSocket handshake the portal opens from the dev server's page.
    expect(acceptsWsOrigin(channel, { origin: VITE })).toBe(true);
    // A mutation (personality switch, autonomous toggle) from that page.
    const mutation = await mutate(channel, { origin: VITE });
    expect(mutation.res.statusCode).toBe(200);
    expect(mutation.fetchMock).toHaveBeenCalledTimes(1);
    // A read whose only header is the dev server's Referer.
    const readOnly = await read(channel, { referer: `${VITE}/monitor` });
    expect(readOnly.res.statusCode).toBe(200);

    await channel.disconnect();
  });

  it("serves an HTTPS reverse proxy origin on its own port", async () => {
    const channel = new WebChannel(3000, 3100, { trustedOrigins: ["https://portal.example"] });
    // 443 is implicit in the configured entry and absent from the browser's header.
    expect(acceptsWsOrigin(channel, { origin: "https://portal.example" })).toBe(true);
    expect((await mutate(channel, { origin: "https://portal.example" })).res.statusCode).toBe(200);
    await channel.disconnect();
  });

  it("reads the configured origins from WEB_TRUSTED_ORIGINS when the option is absent", async () => {
    const previous = process.env["WEB_TRUSTED_ORIGINS"];
    process.env["WEB_TRUSTED_ORIGINS"] = ` ${VITE} , https://portal.example `;
    try {
      const channel = new WebChannel(3000, 3100);
      expect(acceptsWsOrigin(channel, { origin: VITE })).toBe(true);
      expect(acceptsWsOrigin(channel, { origin: "https://portal.example" })).toBe(true);
      await channel.disconnect();
    } finally {
      if (previous === undefined) delete process.env["WEB_TRUSTED_ORIGINS"];
      else process.env["WEB_TRUSTED_ORIGINS"] = previous;
    }
  });

  // ── The other direction: what configuring a dev origin must NOT open up ──

  it("still refuses an unrelated loopback port, and the neighbours of the configured one", async () => {
    const channel = new WebChannel(3000, 3100, { trustedOrigins: [VITE] });
    for (const origin of [
      "http://localhost:9999",      // another process on the machine
      "http://127.0.0.1:5174",      // the next Vite instance, not the configured one
      "https://localhost:5173",     // same port, other scheme
      "http://localhost",           // port 80
      "http://evil.example:5173",   // same port, other host
    ]) {
      expect(acceptsWsOrigin(channel, { origin }), origin).toBe(false);
      expect((await mutate(channel, { origin })).res.statusCode, origin).toBe(403);
      expect((await read(channel, { origin })).res.statusCode, origin).toBe(403);
    }
    await channel.disconnect();
  });

  it("keeps the bound port trusted even with a configured list", async () => {
    const channel = new WebChannel(3000, 3100, { trustedOrigins: [VITE] });
    expect(acceptsWsOrigin(channel, { origin: "http://127.0.0.1:3000" })).toBe(true);
    expect((await mutate(channel, { origin: "http://localhost:3000" })).res.statusCode).toBe(200);
    await channel.disconnect();
  });

  it("drops a configured entry that is not a complete origin instead of widening the check", async () => {
    const channel = new WebChannel(3000, 3100, { trustedOrigins: ["localhost:5173", "", "not a url"] });
    expect(acceptsWsOrigin(channel, { origin: VITE })).toBe(false);
    expect(acceptsWsOrigin(channel, { origin: "http://localhost:3000" })).toBe(true);
    await channel.disconnect();
  });

  // The dashboard's own gate knows nothing about the portal's proxy origins, so
  // forwarding one would trade a 403 at the portal for a 403 one hop later.
  it("does not forward a trusted proxy origin to the dashboard", async () => {
    const channel = new WebChannel(3000, 3100, { trustedOrigins: [VITE] });
    const { fetchMock } = await mutate(channel, { origin: VITE, referer: `${VITE}/monitor` });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Origin");
    expect(headers).not.toHaveProperty("Referer");
    await channel.disconnect();
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

describe("WebChannel monitor command ownership", () => {
  async function sendMonitorMessage(channel: WebChannel, chatId: string, payload: Record<string, unknown>): Promise<void> {
    await (channel as unknown as {
      handleWsMessage: (chatId: string, data: Record<string, unknown>) => Promise<void>;
    }).handleWsMessage(chatId, payload);
  }

  it("rejects cross-chat monitor retry actions", async () => {
    const channel = new WebChannel();
    const emit = vi.fn();
    channel.setWorkspaceBusEmitter(emit);
    channel.setTaskOwnerResolver((taskId) => taskId === "task-1" ? "other-chat" : null);

    await sendMonitorMessage(channel, "chat-1", {
      type: "monitor:retry_task",
      taskId: "task-1",
      rootId: "root-1",
    });

    expect(emit).not.toHaveBeenCalled();
  });

  it("allows owned monitor retry actions", async () => {
    const channel = new WebChannel();
    const emit = vi.fn();
    channel.setWorkspaceBusEmitter(emit);
    channel.setTaskOwnerResolver((taskId) => taskId === "task-1" ? "chat-1" : null);
    // A frame that acts comes from a socket that identified itself (round 13 #9).
    (channel as unknown as { clients: Map<string, unknown> }).clients.set("chat-1", {
      ws: createMockSocket(),
      sessionInitialized: true,
    });

    await sendMonitorMessage(channel, "chat-1", {
      type: "monitor:retry_task",
      taskId: "task-1",
      rootId: "root-1",
    });

    expect(emit).toHaveBeenCalledWith("monitor:retry_task", expect.objectContaining({
      taskId: "task-1",
      rootId: "root-1",
    }));
  });

  it.each([
    "monitor:move_task",
    "monitor:resume_task",
    "monitor:cancel_task",
    "monitor:skip_task",
    "monitor:approve_gate",
    "monitor:reject_gate",
  ])("rejects cross-chat %s actions", async (type) => {
    const channel = new WebChannel();
    const emit = vi.fn();
    channel.setWorkspaceBusEmitter(emit);
    channel.setTaskOwnerResolver(() => "other-chat");

    await sendMonitorMessage(channel, "chat-1", {
      type,
      taskId: "task-1",
      rootId: "root-1",
      nodeId: "node-1",
      newStatus: "blocked",
    });

    expect(emit).not.toHaveBeenCalled();
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

    const routed = handler.mock.calls[0]?.[0] as { text: string };
    expect(routed.text.length).toBeLessThanOrEqual(MAX_INCOMING_TEXT_LENGTH);
    expect(routed.text.startsWith("bbbb")).toBe(true);
    // The cap must be self-disclosing: the routed text carries the marker (audited 2026-09-02).
    expect(routed.text).toContain("[TRUNCATED: ");
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
  /**
   * A response that is a REAL Writable (the static branch pipes a file stream
   * into it), recording status, headers and body so the wire result — not just
   * the buffered writeHead — can be asserted.
   */
  function createStreamResponse() {
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }) as Writable & {
      statusCode: number;
      headers: Record<string, string>;
      writeHead: (code: number, headers: Record<string, string>) => unknown;
      body: () => string;
    };
    res.statusCode = 0;
    res.headers = {};
    res.writeHead = (code, headers) => {
      res.statusCode = code;
      res.headers = headers;
      return res;
    };
    res.body = () => Buffer.concat(chunks).toString("utf8");
    return res;
  }

  async function serve(channel: WebChannel, url: string) {
    const req = createMockRequest({ method: "GET", url });
    const res = createStreamResponse();
    await (channel as unknown as {
      handleHttp: (req: unknown, res: unknown) => Promise<void>;
    }).handleHttp(req, res);
    return res;
  }

  it("falls back to index.html for a client-side route that has no file on disk (audited 2026-09-02)", async () => {
    // The portal is a BrowserRouter SPA: a refresh on /admin/dashboard must get
    // index.html, not a committed 200 whose body stream then fails on ENOENT.
    const staticDir = mkdtempSync(join(tmpdir(), "strada-web-static-"));
    try {
      writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>portal</title>");
      const channel = new WebChannel();
      (channel as unknown as { staticDir: string }).staticDir = staticDir;

      const res = await serve(channel, "/admin/dashboard");

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
      expect(res.body()).toBe("<!doctype html><title>portal</title>");
      // The stream ran to completion (autoDestroy then flags it destroyed — that is
      // normal Writable teardown, not the mid-body abort the bug produced).
      expect(res.writableEnded).toBe(true);
      expect(res.writableFinished).toBe(true);
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it("still serves a real static asset with its MIME type (audited 2026-09-02)", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "strada-web-static-"));
    try {
      writeFileSync(join(staticDir, "index.html"), "<!doctype html>");
      mkdirSync(join(staticDir, "assets"));
      writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1)");
      const channel = new WebChannel();
      (channel as unknown as { staticDir: string }).staticDir = staticDir;

      const res = await serve(channel, "/assets/app.js?v=1");

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toBe("application/javascript; charset=utf-8");
      expect(res.body()).toBe("console.log(1)");
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it("answers 404 when the portal build (index.html) is missing instead of tearing the socket (audited 2026-09-02)", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "strada-web-static-"));
    try {
      const channel = new WebChannel();
      (channel as unknown as { staticDir: string }).staticDir = staticDir;

      const res = await serve(channel, "/setup");

      expect(res.statusCode).toBe(404);
      expect(res.body()).toBe("Not Found");
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

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

describe("WebChannel WebSocket heartbeat", () => {
  it("pings live clients and terminates one that stops responding to pongs", () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    const tick = () =>
      (channel as unknown as { wsHeartbeatTick: () => void }).wsHeartbeatTick();

    // Tick 1: client is alive → it gets pinged and isAlive is cleared.
    tick();
    expect(socket.getPingCount()).toBe(1);
    expect(socket.isTerminated()).toBe(false);

    // Client responds with a pong → stays alive through the next tick.
    socket.emit("pong");
    tick();
    expect(socket.getPingCount()).toBe(2);
    expect(socket.isTerminated()).toBe(false);

    // No pong this round: the next tick finds isAlive=false and terminates it.
    tick();
    expect(socket.isTerminated()).toBe(true);
  });
});

describe("WebChannel confirmation send-failure", () => {
  it("resolves immediately as timeout when no live socket exists (does not block for 5 min)", async () => {
    const channel = new WebChannel();

    // No client was ever connected for this chatId, so the prompt cannot be
    // delivered. requestConfirmation must resolve with the non-approving
    // "timeout" sentinel right away instead of registering a 5-minute pending
    // entry that would block the awaiting orchestrator.
    const result = await channel.requestConfirmation({
      chatId: "ghost-chat",
      question: "Apply changes?",
      options: ["Yes", "No"],
    });

    expect(result).toBe("timeout");

    // No pending confirmation should have been registered.
    const pending = (channel as unknown as {
      pendingConfirmations: Map<string, unknown>;
    }).pendingConfirmations;
    expect(pending.size).toBe(0);
  });

  it("registers a pending confirmation when a live socket is present", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const chatId = String(socket.getSentMessages()[0]!.chatId);

    // Live socket → the prompt is delivered and a pending entry is registered
    // (the promise stays unresolved until the user answers or it times out).
    void channel.requestConfirmation({
      chatId,
      question: "Apply changes?",
      options: ["Yes", "No"],
    });

    await Promise.resolve();

    const pending = (channel as unknown as {
      pendingConfirmations: Map<string, unknown>;
    }).pendingConfirmations;
    expect(pending.size).toBe(1);
    expect(
      socket.getSentMessages().some((m) => m.type === "confirmation"),
    ).toBe(true);

    await channel.disconnect();
  });
});

describe("WebChannel confirmations survive a disconnect (Codex review of 0-A.26)", () => {
  const connect = (channel: WebChannel) => {
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const connected = socket.getSentMessages().find((m) => m.type === "connected")!;
    return { socket, chatId: String(connected.chatId), reconnectToken: String(connected.reconnectToken) };
  };
  const send = (socket: ReturnType<typeof createMockSocket>, data: Record<string, unknown>) =>
    socket.emit("message", Buffer.from(JSON.stringify(data)));

  it("keeps the pending confirmation through a disconnect and resolves it with the answer given after reconnect", async () => {
    const channel = new WebChannel();
    const first = connect(channel);
    const answer = channel.requestConfirmation({ chatId: first.chatId, question: "Deploy?", options: ["yes", "no"] });
    await Promise.resolve();
    const confirmId = String(first.socket.getSentMessages().find((m) => m.type === "confirmation")!.confirmId);

    first.socket.emit("close");
    // Not cancelled: the 5-minute window is the only thing that expires it.
    const pending = (channel as unknown as { pendingConfirmations: Map<string, unknown> }).pendingConfirmations;
    expect(pending.size).toBe(1);

    const second = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(second);
    send(second, { type: "reconnect", chatId: first.chatId, reconnectToken: first.reconnectToken });
    send(second, { type: "confirmation_response", confirmId, option: "yes" });

    await expect(answer).resolves.toBe("yes");
    expect(second.getSentMessages()).toContainEqual({ type: "confirmation_ack", confirmId, status: "accepted" });
    expect(pending.size).toBe(0);
    await channel.disconnect();
  });

  it("answers an unknown/expired confirmation id with an explicit 'unknown' ack instead of ignoring it", () => {
    const channel = new WebChannel();
    const { socket } = connect(channel);
    send(socket, { type: "confirmation_response", confirmId: "gone-1", option: "yes" });
    expect(socket.getSentMessages()).toContainEqual({ type: "confirmation_ack", confirmId: "gone-1", status: "unknown" });
  });

  it("still resolves 'timeout' when the 5-minute window expires with no answer (guard)", async () => {
    vi.useFakeTimers();
    try {
      const channel = new WebChannel();
      const { socket, chatId } = connect(channel);
      const answer = channel.requestConfirmation({ chatId, question: "Deploy?", options: ["yes", "no"] });
      await Promise.resolve();
      socket.emit("close");
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await expect(answer).resolves.toBe("timeout");
      expect((channel as unknown as { pendingConfirmations: Map<string, unknown> }).pendingConfirmations.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Codex wave 0-A review 2026-09-17 #6 (follow-up to 0ee86669): the portal
// re-sends a reply whose ack was lost to a socket drop. The server side must
// (d) ack that duplicate "accepted" rather than "unknown" (rendered as
// expired), and (c) send a terminal ack when the 5-minute window expires so
// a dialog still waiting on its ack is released — buffered for replay when
// the client is offline at that moment.
describe("WebChannel confirmation re-send and expiry acks (Codex wave 0-A 2026-09-17 #6)", () => {
  const connect = (channel: WebChannel) => {
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const connected = socket.getSentMessages().find((m) => m.type === "connected")!;
    return { socket, chatId: String(connected.chatId), reconnectToken: String(connected.reconnectToken) };
  };
  const send = (socket: ReturnType<typeof createMockSocket>, data: Record<string, unknown>) =>
    socket.emit("message", Buffer.from(JSON.stringify(data)));
  const acksFor = (socket: ReturnType<typeof createMockSocket>, confirmId: string) =>
    socket.getSentMessages().filter((m) => m.type === "confirmation_ack" && m.confirmId === confirmId).map((m) => m.status);

  it("acks a duplicate reply for an already-settled id as accepted and settles the promise once", async () => {
    const channel = new WebChannel();
    const c = connect(channel);
    const answer = channel.requestConfirmation({ chatId: c.chatId, question: "Deploy?", options: ["yes", "no"] });
    await Promise.resolve();
    const confirmId = String(c.socket.getSentMessages().find((m) => m.type === "confirmation")!.confirmId);

    send(c.socket, { type: "confirmation_response", confirmId, option: "yes" });
    await expect(answer).resolves.toBe("yes");
    // Replayed by the client after a lost ack.
    send(c.socket, { type: "confirmation_response", confirmId, option: "yes" });

    expect(acksFor(c.socket, confirmId)).toEqual(["accepted", "accepted"]);
    expect((channel as unknown as { pendingConfirmations: Map<string, unknown> }).pendingConfirmations.size).toBe(0);
    await channel.disconnect();
  });

  it("sends a terminal 'unknown' ack to the client when the 5-minute window expires", async () => {
    vi.useFakeTimers();
    try {
      const channel = new WebChannel();
      const c = connect(channel);
      const answer = channel.requestConfirmation({ chatId: c.chatId, question: "Deploy?", options: ["yes", "no"] });
      await Promise.resolve();
      const confirmId = String(c.socket.getSentMessages().find((m) => m.type === "confirmation")!.confirmId);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await expect(answer).resolves.toBe("timeout");
      expect(c.socket.getSentMessages()).toContainEqual({ type: "confirmation_ack", confirmId, status: "unknown" });
      await channel.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("buffers the expiry ack for an offline client and replays it on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const channel = new WebChannel();
      const first = connect(channel);
      const answer = channel.requestConfirmation({ chatId: first.chatId, question: "Deploy?", options: ["yes", "no"] });
      await Promise.resolve();
      const confirmId = String(first.socket.getSentMessages().find((m) => m.type === "confirmation")!.confirmId);

      // Drop the socket four minutes in: the confirmation expires a minute
      // later while the chat's reconnect lease (same 5-minute TTL) is still live.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      first.socket.emit("close");
      await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
      await expect(answer).resolves.toBe("timeout");
      expect(first.socket.getSentMessages().some((m) => m.type === "confirmation_ack")).toBe(false);

      const second = createMockSocket();
      (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(second);
      send(second, { type: "reconnect", chatId: first.chatId, reconnectToken: first.reconnectToken });
      expect(second.getSentMessages()).toContainEqual({ type: "confirmation_ack", confirmId, status: "unknown" });
      await channel.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a first reply still settles the confirmation normally with a single accepted ack (guard)", async () => {
    const channel = new WebChannel();
    const c = connect(channel);
    const answer = channel.requestConfirmation({ chatId: c.chatId, question: "Deploy?", options: ["yes", "no"] });
    await Promise.resolve();
    const confirmId = String(c.socket.getSentMessages().find((m) => m.type === "confirmation")!.confirmId);

    send(c.socket, { type: "confirmation_response", confirmId, option: "no" });
    await expect(answer).resolves.toBe("no");
    expect(acksFor(c.socket, confirmId)).toEqual(["accepted"]);
    // A never-issued id is still "unknown", not "accepted".
    send(c.socket, { type: "confirmation_response", confirmId: "never-issued", option: "yes" });
    expect(acksFor(c.socket, "never-issued")).toEqual(["unknown"]);
    await channel.disconnect();
  });

  // Codex 2026-09-17 round 3 #5: the settled record carries ownership and the
  // answer. Only the identical reply from the owning chat is a lost-ack
  // duplicate; a different option or another chat never reached the
  // orchestrator and is acked "unknown", not "accepted".
  it("acks the owner re-sending the same option as accepted, with one settlement (round 3 #5)", async () => {
    const channel = new WebChannel();
    const c = connect(channel);
    const answer = channel.requestConfirmation({ chatId: c.chatId, question: "Deploy?", options: ["yes", "no"] });
    await Promise.resolve();
    const confirmId = String(c.socket.getSentMessages().find((m) => m.type === "confirmation")!.confirmId);

    send(c.socket, { type: "confirmation_response", confirmId, option: "no" });
    await expect(answer).resolves.toBe("no");
    send(c.socket, { type: "confirmation_response", confirmId, option: "no" });

    expect(acksFor(c.socket, confirmId)).toEqual(["accepted", "accepted"]);
    const settled = (channel as unknown as { settledConfirmations: Map<string, { chatId: string; option: string }> }).settledConfirmations;
    expect(settled.size).toBe(1);
    expect(settled.get(confirmId)).toMatchObject({ chatId: c.chatId, option: "no" });
    await channel.disconnect();
  });

  it("acks the owner re-sending a different option as unknown and keeps the settlement (round 3 #5)", async () => {
    const channel = new WebChannel();
    const c = connect(channel);
    const answer = channel.requestConfirmation({ chatId: c.chatId, question: "Deploy?", options: ["yes", "no"] });
    await Promise.resolve();
    const confirmId = String(c.socket.getSentMessages().find((m) => m.type === "confirmation")!.confirmId);

    send(c.socket, { type: "confirmation_response", confirmId, option: "no" });
    await expect(answer).resolves.toBe("no");
    send(c.socket, { type: "confirmation_response", confirmId, option: "yes" });

    expect(acksFor(c.socket, confirmId)).toEqual(["accepted", "unknown"]);
    const settled = (channel as unknown as { settledConfirmations: Map<string, { chatId: string; option: string }> }).settledConfirmations;
    expect(settled.get(confirmId)).toMatchObject({ chatId: c.chatId, option: "no" });
    await channel.disconnect();
  });

  it("acks another chat replying to a settled id as unknown (round 3 #5)", async () => {
    const channel = new WebChannel();
    const a = connect(channel);
    const b = connect(channel);
    const answer = channel.requestConfirmation({ chatId: a.chatId, question: "Deploy?", options: ["yes", "no"] });
    await Promise.resolve();
    const confirmId = String(a.socket.getSentMessages().find((m) => m.type === "confirmation")!.confirmId);

    send(a.socket, { type: "confirmation_response", confirmId, option: "no" });
    await expect(answer).resolves.toBe("no");
    send(b.socket, { type: "confirmation_response", confirmId, option: "no" });
    send(b.socket, { type: "confirmation_response", confirmId, option: "yes" });

    expect(acksFor(a.socket, confirmId)).toEqual(["accepted"]);
    expect(acksFor(b.socket, confirmId)).toEqual(["unknown", "unknown"]);
    const settled = (channel as unknown as { settledConfirmations: Map<string, { chatId: string; option: string }> }).settledConfirmations;
    expect(settled.get(confirmId)).toMatchObject({ chatId: a.chatId, option: "no" });
    await channel.disconnect();
  });
});

describe("queued is not delivered (Codex 2026-09-13 AG#13)", () => {
  it("says whether the markdown actually LEFT, not merely that it was queued", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const chatId = String(socket.getSentMessages().find((m) => m.type === "connected")!.chatId);

    // Connected: it left.
    expect(await channel.sendMarkdownDelivered(chatId, "Delivered while you were here.")).toBe(true);

    // Offline: it is buffered for the next reconnect, and that is NOT delivery
    // — a restart or a reconnect expiry removes it with nobody having read it.
    socket.close();
    expect(await channel.sendMarkdownDelivered(chatId, "Your game is ready.")).toBe(false);
    const buffered = (channel as unknown as {
      pendingDelivery: Map<string, Array<Record<string, unknown>>>;
    }).pendingDelivery.get(chatId);
    expect(buffered).toHaveLength(1);
  });
});

describe("WebChannel offline final delivery (BUG#7 2b)", () => {
  it("buffers an answer frame dropped while offline and replays it on reconnect with the same messageId", async () => {
    const channel = new WebChannel();

    // Connect, capture the assigned chatId + reconnectToken, then disconnect so
    // there is no live socket when the background final arrives.
    const firstSocket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(firstSocket);
    const connected = firstSocket.getSentMessages().find((m) => m.type === "connected")!;
    const chatId = String(connected.chatId);
    const reconnectToken = String(connected.reconnectToken);
    firstSocket.close();

    // Background final delivered while offline → dropped from the socket but
    // buffered server-side.
    await channel.sendMarkdown(chatId, "Here is your answer.");

    const buffered = (channel as unknown as {
      pendingDelivery: Map<string, Array<Record<string, unknown>>>;
    }).pendingDelivery.get(chatId);
    expect(buffered).toHaveLength(1);
    const bufferedId = buffered![0]!.messageId;
    expect(typeof bufferedId).toBe("string");

    // Reconnect (reclaim the same chatId via the reconnectToken) → the buffered
    // final is flushed onto the new socket and the buffer is cleared.
    const secondSocket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(secondSocket);
    secondSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "session_init", chatId, reconnectToken })),
    );

    const replayed = secondSocket.getSentMessages().filter((m) => m.type === "markdown");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.text).toBe("Here is your answer.");
    // Same messageId → client dedups (no double-render) when it was also seen live.
    expect(replayed[0]!.messageId).toBe(bufferedId);
    expect(
      (channel as unknown as { pendingDelivery: Map<string, unknown> }).pendingDelivery.has(chatId),
    ).toBe(false);

    await channel.disconnect();
  });

  it("replays the supervisor's failure, escalation, wave and abort frames on reconnect — a replayed board is never greener than the live one (audited 2026-09-02)", async () => {
    const channel = new WebChannel();
    const firstSocket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(firstSocket);
    const connected = firstSocket.getSentMessages().find((m) => m.type === "connected")!;
    const chatId = String(connected.chatId);
    const reconnectToken = String(connected.reconnectToken);

    const frame = (type: string, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ type, payload: { rootId: "root-S", ...extra }, timestamp: 1 });
    channel.broadcastRaw(frame("monitor:dag_init", { nodes: [{ id: "n4" }] }));
    channel.broadcastRaw(frame("supervisor:activated", { taskId: "t1", nodeCount: 5 }));
    channel.broadcastRaw(frame("supervisor:node_start", { nodeId: "n4", provider: "p" }));
    // The negative/terminal frames: previously NOT cached, so a reconnect
    // replayed node_start and left n4 rendering "running" forever, with the
    // alert list empty and no abort summary.
    channel.broadcastRaw(frame("supervisor:node_failed", { nodeId: "n4", error: "boom", failureLevel: 2, nextAction: "escalate" }));
    channel.broadcastRaw(frame("supervisor:escalation", { nodeId: "n4", fromProvider: "a", toProvider: "b", reason: "boom" }));
    channel.broadcastRaw(frame("supervisor:wave_done", { waveIndex: 0, results: [{ nodeId: "n4", status: "failed" }] }));
    channel.broadcastRaw(frame("supervisor:verify_start", { nodeId: "n2" }));
    channel.broadcastRaw(frame("supervisor:verify_done", { nodeId: "n2", verdict: "pass" }));
    channel.broadcastRaw(frame("supervisor:aborted", { taskId: "t1", reason: "budget" }));

    firstSocket.close();

    const secondSocket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(secondSocket);
    secondSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "session_init", chatId, reconnectToken })),
    );

    const replayedTypes = secondSocket.getSentMessages().map((m) => m.type);
    for (const t of [
      "supervisor:node_start",
      "supervisor:node_failed",
      "supervisor:escalation",
      "supervisor:wave_done",
      "supervisor:verify_start",
      "supervisor:verify_done",
      "supervisor:aborted",
    ]) {
      expect(replayedTypes, `expected ${t} to be replayed`).toContain(t);
    }
    // Order within the root is preserved: the failure comes AFTER the start it supersedes.
    expect(replayedTypes.indexOf("supervisor:node_failed")).toBeGreaterThan(replayedTypes.indexOf("supervisor:node_start"));

    await channel.disconnect();
  });

  it("replays EVERY retained DAG root's board on reconnect (BUG#5 P1 — not just the newest)", async () => {
    const channel = new WebChannel();
    const firstSocket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(firstSocket);
    const connected = firstSocket.getSentMessages().find((m) => m.type === "connected")!;
    const chatId = String(connected.chatId);
    const reconnectToken = String(connected.reconnectToken);

    // Two distinct DAG roots, each with a dag_init + an incremental task_update. A single flat
    // snapshot let root-B's dag_init clobber root-A's — losing root-A's board on reconnect.
    const frame = (type: string, rootId: string, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ type, payload: { rootId, ...extra }, timestamp: 1 });
    channel.broadcastRaw(frame("monitor:dag_init", "root-A", { nodes: [{ id: "a1" }] }));
    channel.broadcastRaw(frame("monitor:task_update", "root-A", { updates: { status: "completed" } }));
    channel.broadcastRaw(frame("monitor:dag_init", "root-B", { nodes: [{ id: "b1" }] }));
    channel.broadcastRaw(frame("monitor:task_update", "root-B", { updates: { status: "executing" } }));

    firstSocket.close();

    // Reconnect (reclaim the chatId) → replayMonitorState runs. BOTH roots' boards must come back.
    const secondSocket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(secondSocket);
    secondSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "session_init", chatId, reconnectToken })),
    );

    const monitorFrames = secondSocket
      .getSentMessages()
      .filter((m) => m.type === "monitor:dag_init" || m.type === "monitor:task_update");
    const roots = new Set(
      monitorFrames.map((m) => (m.payload as { rootId?: string } | undefined)?.rootId),
    );
    expect(roots.has("root-A")).toBe(true);
    expect(roots.has("root-B")).toBe(true);
    // Each root replayed its dag_init + its task_update — nothing clobbered.
    expect(monitorFrames.filter((m) => m.type === "monitor:dag_init")).toHaveLength(2);
    expect(monitorFrames.filter((m) => m.type === "monitor:task_update")).toHaveLength(2);

    await channel.disconnect();
  });

  it("does NOT buffer when the frame is delivered to a live socket", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const chatId = String(socket.getSentMessages()[0]!.chatId);

    await channel.sendMarkdown(chatId, "Live answer.");

    expect(socket.getSentMessages().some((m) => m.type === "markdown" && m.text === "Live answer.")).toBe(true);
    expect(
      (channel as unknown as { pendingDelivery: Map<string, unknown> }).pendingDelivery.has(chatId),
    ).toBe(false);

    await channel.disconnect();
  });

  it("does NOT buffer transient frames (typing) for an offline chat", async () => {
    const channel = new WebChannel();

    await channel.sendTypingIndicator("ghost-chat");

    expect(
      (channel as unknown as { pendingDelivery: Map<string, unknown> }).pendingDelivery.has("ghost-chat"),
    ).toBe(false);

    await channel.disconnect();
  });

  it("bounds the per-chat buffer, evicting oldest frames beyond the cap", async () => {
    const channel = new WebChannel();
    const cap = (WebChannel as unknown as { MAX_PENDING_DELIVERY_FRAMES: number }).MAX_PENDING_DELIVERY_FRAMES;

    for (let i = 0; i < cap + 5; i++) {
      await channel.sendMarkdown("ghost-chat", `answer ${i}`);
    }

    const buffered = (channel as unknown as {
      pendingDelivery: Map<string, Array<Record<string, unknown>>>;
    }).pendingDelivery.get("ghost-chat")!;
    expect(buffered).toHaveLength(cap);
    // Oldest evicted: the surviving window is the LAST `cap` frames.
    expect(buffered[0]!.text).toBe("answer 5");
    expect(buffered[buffered.length - 1]!.text).toBe(`answer ${cap + 4}`);

    await channel.disconnect();
  });
});

describe("WebChannel verify:gate_decision enforcement", () => {
  async function sendGate(channel: WebChannel, chatId: string, payload: Record<string, unknown>): Promise<void> {
    await (channel as unknown as {
      handleWsMessage: (chatId: string, data: Record<string, unknown>) => Promise<void>;
    }).handleWsMessage(chatId, payload);
  }

  it("forwards an owned gate decision onto the workspace bus and acks it as enforced", async () => {
    const channel = new WebChannel();
    // The emitter reports that a consumer actually received the verdict.
    const emit = vi.fn().mockReturnValue(true);
    channel.setWorkspaceBusEmitter(emit);
    channel.setTaskOwnerResolver((taskId) => (taskId === "task-1" ? "chat-1" : null));

    const socket = createMockSocket();
    (channel as unknown as { clients: Map<string, unknown> }).clients.set("chat-1", {
      ws: socket,
      // A live session that identified itself: round 13 #9 refuses a frame that
      // ACTS from a socket which never completed session_init.
      sessionInitialized: true,
    });

    await sendGate(channel, "chat-1", {
      type: "verify:gate_decision",
      taskId: "task-1",
      verdict: "approve",
      note: "looks good",
    });

    expect(emit).toHaveBeenCalledWith(
      "verify:gate_decision",
      expect.objectContaining({ taskId: "task-1", verdict: "approve", note: "looks good" }),
    );
    const ack = socket.getSentMessages().find((m) => m.type === "verify:gate_ack");
    expect(ack).toMatchObject({ accepted: true, supervisorVerdict: "approve", enforced: true });
  });

  it("does not ack an approve as enforced when the bus has an emitter but no consumer (audited 2026-09-02)", async () => {
    const channel = new WebChannel();
    // An emitter is installed (as bootstrap always does) but it reports that
    // nothing subscribed to verify:gate_decision — the verdict went nowhere.
    const emit = vi.fn().mockReturnValue(false);
    channel.setWorkspaceBusEmitter(emit);
    channel.setTaskOwnerResolver((taskId) => (taskId === "task-1" ? "chat-1" : null));

    const socket = createMockSocket();
    (channel as unknown as { clients: Map<string, unknown> }).clients.set("chat-1", {
      ws: socket,
      // A live session that identified itself: round 13 #9 refuses a frame that
      // ACTS from a socket which never completed session_init.
      sessionInitialized: true,
    });

    await sendGate(channel, "chat-1", {
      type: "verify:gate_decision",
      taskId: "task-1",
      verdict: "approve",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const ack = socket.getSentMessages().find((m) => m.type === "verify:gate_ack");
    expect(ack).toMatchObject({ accepted: false, supervisorVerdict: "approve", enforced: false });
  });

  it("treats an emitter that does not report consumer delivery as not enforced (audited 2026-09-02)", async () => {
    const channel = new WebChannel();
    // Legacy void emitter: it cannot say whether anyone consumed the verdict,
    // so the ack must not claim enforcement.
    const emit = vi.fn();
    channel.setWorkspaceBusEmitter(emit);
    channel.setTaskOwnerResolver((taskId) => (taskId === "task-1" ? "chat-1" : null));

    const socket = createMockSocket();
    (channel as unknown as { clients: Map<string, unknown> }).clients.set("chat-1", {
      ws: socket,
      // A live session that identified itself: round 13 #9 refuses a frame that
      // ACTS from a socket which never completed session_init.
      sessionInitialized: true,
    });

    await sendGate(channel, "chat-1", {
      type: "verify:gate_decision",
      taskId: "task-1",
      verdict: "approve",
    });

    const ack = socket.getSentMessages().find((m) => m.type === "verify:gate_ack");
    expect(ack).toMatchObject({ accepted: false, enforced: false });
  });

  it("does not ack an approve as accepted when no bus consumer is wired (not yet enforced)", async () => {
    const channel = new WebChannel();
    channel.setTaskOwnerResolver((taskId) => (taskId === "task-1" ? "chat-1" : null));

    const socket = createMockSocket();
    (channel as unknown as { clients: Map<string, unknown> }).clients.set("chat-1", {
      ws: socket,
      // A live session that identified itself: round 13 #9 refuses a frame that
      // ACTS from a socket which never completed session_init.
      sessionInitialized: true,
    });

    await sendGate(channel, "chat-1", {
      type: "verify:gate_decision",
      taskId: "task-1",
      verdict: "approve",
    });

    const ack = socket.getSentMessages().find((m) => m.type === "verify:gate_ack");
    expect(ack).toMatchObject({ accepted: false, supervisorVerdict: "approve", enforced: false });
  });
});

describe("WebChannel attachment data validation", () => {
  it("rejects an attachment that declares mimeType/name but carries no data (no raw.size trust)", async () => {
    const channel = new WebChannel();
    const socket = createMockSocket();
    const handler = vi.fn().mockResolvedValue(undefined);

    channel.onMessage(handler);
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({
        type: "message",
        clientMessageId: "client-msg-nodata",
        text: "(voice message)",
        attachments: [
          {
            name: "fake.png",
            type: "image/png",
            // No `data` field; a tiny claimed size used to slip past validation.
            size: 1,
          },
        ],
      })),
    );

    await Promise.resolve();

    // Placeholder-only text plus a rejected attachment → nothing routed.
    expect(handler).not.toHaveBeenCalled();
    expect(socket.getSentMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: 'File "fake.png" was rejected: unsupported format or invalid content.',
        }),
      ]),
    );
  });
});

describe("WebChannel rate-limit cleanup (L8)", () => {
  it("runs per-chat cleanup (no appliedInstinctIds leak) when a rate-limited client closes", async () => {
    const channel = new WebChannel();

    // Socket whose close() does NOT synchronously fire the 'close' handler — this
    // matches production (ws 'close' is async), so the real ordering is exercised:
    // close() returns, the rate-limit branch runs, then 'close' fires later.
    const handlers = new Map<string, () => void>();
    const sent: Array<Record<string, unknown>> = [];
    const closeCalls: Array<{ code?: number; reason?: string }> = [];
    let readyState = 1;
    const socket = {
      get readyState() { return readyState; },
      send(p: string) { sent.push(JSON.parse(p) as Record<string, unknown>); },
      close(code?: number, reason?: string) { closeCalls.push({ code, reason }); readyState = 3; },
      ping() {},
      terminate() { readyState = 3; },
      on(event: string, handler: () => void) { handlers.set(event, handler); },
    };
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    const chatId = String(sent[0]!.chatId);
    channel.setAppliedInstinctIds(chatId, ["instinct-A", "instinct-B"]);

    const send21 = (data: Record<string, unknown>) =>
      (channel as unknown as {
        handleWsMessage: (c: string, d: Record<string, unknown>) => Promise<void>;
      }).handleWsMessage(chatId, data);
    // WS_RATE_LIMIT is 20; the 21st message trips the limit → ws.close(1008).
    for (let i = 0; i < 21; i++) {
      await send21({ type: "ping" });
    }
    expect(closeCalls).toContainEqual({ code: 1008, reason: "Rate limit exceeded" });

    // Now the async 'close' event arrives (after the rate-limit branch returned).
    handlers.get("close")?.();

    // TEETH: the manual clients.delete in the rate-limit branch ran BEFORE this
    // close event, so handleDisconnect's `clients.get(chatId) === ws` guard failed
    // and skipped cleanup, leaking appliedInstinctIds[chatId].
    const leaked = (channel as unknown as {
      appliedInstinctIds: Map<string, string[]>;
    }).appliedInstinctIds.has(chatId);
    expect(leaked).toBe(false);
  });
});

describe("WebChannel shutdown teardown", () => {
  it("does not repopulate recentlyDisconnected when an async ws 'close' fires after disconnect()", async () => {
    const channel = new WebChannel();

    // ws 'close' is async in production: close() does NOT synchronously fire the
    // 'close' handler. So disconnect() returns first, then the deferred close
    // event arrives and runs handleDisconnect.
    const handlers = new Map<string, () => void>();
    const sent: Array<Record<string, unknown>> = [];
    let readyState = 1;
    const socket = {
      get readyState() { return readyState; },
      send(p: string) { sent.push(JSON.parse(p) as Record<string, unknown>); },
      close() { readyState = 3; },
      ping() {},
      terminate() { readyState = 3; },
      on(event: string, handler: () => void) { handlers.set(event, handler); },
    };
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);

    await channel.disconnect();

    // Deferred async close event arrives AFTER disconnect() cleared the maps.
    handlers.get("close")?.();

    const recentlyDisconnected = (channel as unknown as {
      recentlyDisconnected: Map<string, unknown>;
    }).recentlyDisconnected;
    expect(recentlyDisconnected.size).toBe(0);
  });
});

describe("WebChannel CSP drift guard", () => {
  it("script-src contains the correct inline-script hash and no unsafe-inline", () => {
    // Resolve web-portal/index.html relative to this repo root.
    // __dirname is not available in ESM; use import.meta.url instead.
    const repoRoot = new URL("../../../", import.meta.url).pathname;
    const indexPath = join(repoRoot, "web-portal", "index.html");
    const html = readFileSync(indexPath, "utf8");

    // Extract the inner text of the single inline (non-src) <script> element.
    const match = /<script>([^<]+)<\/script>/.exec(html);
    expect(match, "Expected exactly one inline <script> in web-portal/index.html").not.toBeNull();
    const inlineText = match![1]!;

    // Compute sha256/base64 of the inline script's exact text.
    const hash = createHash("sha256").update(inlineText).digest("base64");
    const expectedDirective = `'sha256-${hash}'`;

    // The SECURITY_HEADERS constant is private; access it via the class's static
    // property through type coercion.
    const csp = (WebChannel as unknown as {
      SECURITY_HEADERS: Record<string, string>;
    }).SECURITY_HEADERS["Content-Security-Policy"];

    // Extract the script-src directive value.
    const scriptSrcMatch = /script-src ([^;]+)/.exec(csp);
    expect(scriptSrcMatch, "CSP must contain a script-src directive").not.toBeNull();
    const scriptSrc = scriptSrcMatch![1]!;

    expect(scriptSrc).toContain(expectedDirective);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});

describe("GET /api/campaign — measured build status served in-daemon", () => {
  async function serve(channel: WebChannel, url: string, method = "GET") {
    const req = createMockRequest({ method, url });
    const res = createMockResponse();
    await (channel as unknown as { handleHttp: (req: unknown, res: unknown) => Promise<void> }).handleHttp(req, res);
    return res;
  }

  it("answers 503 (not a proxy 403 or an empty object) when no provider is registered", async () => {
    const channel = new WebChannel();
    const res = await serve(channel, "/api/campaign");
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringMatching(/no campaign layer/) });
  });

  it("serves the provider's JSON and passes ?measure=1 through", async () => {
    const channel = new WebChannel();
    const provider = vi.fn(async ({ measure }: { measure: boolean }) => ({ campaign: { id: "camp_1" }, guardian: null, measurement: measure ? { measured: true } : null }));
    channel.setBuildStatusProvider(provider);

    const plain = await serve(channel, "/api/campaign");
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["Cache-Control"]).toMatch(/no-store|no-cache/);
    expect(JSON.parse(plain.body)).toEqual({ campaign: { id: "camp_1" }, guardian: null, measurement: null });
    expect(provider).toHaveBeenLastCalledWith({ measure: false });

    const measured = await serve(channel, "/api/campaign?measure=1");
    expect(JSON.parse(measured.body).measurement).toEqual({ measured: true });
    expect(provider).toHaveBeenLastCalledWith({ measure: true });

    expect((await serve(channel, "/api/campaign", "POST")).statusCode).toBe(405);
  });

  it("reports a provider failure as 500 with the cause", async () => {
    const channel = new WebChannel();
    channel.setBuildStatusProvider(async () => {
      throw new Error("campaigns.db locked");
    });
    const res = await serve(channel, "/api/campaign");
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain("campaigns.db locked");
  });

  it("broadcastBuildStatus pushes a campaign:status frame to connected clients", async () => {
    const channel = new WebChannel();
    channel.setBuildStatusProvider(async () => ({ campaign: { id: "camp_2" }, guardian: null, measurement: null }));
    const sent: string[] = [];
    (channel as unknown as { clients: Map<string, unknown> }).clients.set("c1", {
      ws: { readyState: 1, send: (m: string) => sent.push(m), OPEN: 1 },
      chatId: "c1",
    });
    await channel.broadcastBuildStatus();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: "campaign:status", payload: { campaign: { id: "camp_2" } } });
  });
});

describe("WebChannel.claimsChatId (hub routing)", () => {
  it("claims UUID-shaped ids and ids of live or recently disconnected clients", () => {
    const channel = new WebChannel();
    expect(channel.claimsChatId("6f9619ff-8b86-d011-b42d-00c04fc964ff")).toBe(true);
    expect(channel.claimsChatId("123456789")).toBe(false);
    (channel as unknown as { clients: Map<string, unknown> }).clients.set("custom-profile-id", {});
    expect(channel.claimsChatId("custom-profile-id")).toBe(true);
    (channel as unknown as { recentlyDisconnected: Map<string, unknown> }).recentlyDisconnected.set("gone-id", {});
    expect(channel.claimsChatId("gone-id")).toBe(true);
    expect(channel.claimsChatId("cli-local")).toBe(false);
  });
});

describe("WebChannel file delivery (2026-09-10)", () => {
  // Until now sendAttachment sent the text "[Attachment: name]" and nothing
  // else: a gameplay frame or a HOW_TO_RUN never reached the portal.
  function fakeRes() {
    const out: { status?: number; headers?: Record<string, string>; body: Buffer[] } = { body: [] };
    // A real Writable: the file branch streams through stream.pipeline, which
    // needs 'finish'/'close' events a hand-rolled object never emits.
    const res = new Writable({
      write(chunk, _enc, cb) { out.body.push(Buffer.from(chunk)); cb(); },
    }) as unknown as import("node:http").ServerResponse & { headersSent: boolean };
    Object.assign(res, {
      headersSent: false,
      writeHead: (status: number, headers: Record<string, string>) => { out.status = status; out.headers = headers; res.headersSent = true; return res; },
    });
    return { res, out };
  }
  const handle = async (channel: WebChannel, url: string) => {
    const { res, out } = fakeRes();
    await (channel as unknown as { handleHttp: (req: unknown, res: unknown) => Promise<void> })
      .handleHttp({ method: "GET", url, headers: {} }, res);
    if (!(res as unknown as Writable).writableFinished) await new Promise((r) => (res as unknown as Writable).once("finish", r));
    return out;
  };

  it("registers bytes under a token, tells the chat with a markdown image, and serves them once asked", async () => {
    const channel = new WebChannel();
    const sent: Array<Record<string, unknown>> = [];
    (channel as unknown as { sendToClient: (c: string, d: Record<string, unknown>) => boolean }).sendToClient = (_c, d) => { sent.push(d); return true; };
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await channel.sendAttachment("chat-1", { type: "image", name: "frame_00012.png", data: png, mimeType: "image/png", size: png.length });
    const text = String(sent[0]!.text);
    const token = /\/attachments\/([A-Za-z0-9_-]+)\)/.exec(text)![1]!;
    expect(text).toContain(`![frame_00012.png](/attachments/${token})`);
    expect(text).not.toContain("[Attachment:");
    // A STRUCTURED FRAME (plan 2.8): the fields say what arrived, and `text`
    // is the fallback rendering — audit 11.1 / D31 was the markdown form of
    // the same problem, a "text" frame reaching the user as literal markup.
    expect(sent[0]).toMatchObject({
      type: "attachment",
      name: "frame_00012.png",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: png.length,
      href: `/attachments/${token}`,
    });
    const out = await handle(channel, `/attachments/${token}`);
    expect(out.status).toBe(200);
    expect(out.headers!["Content-Type"]).toBe("image/png");
    expect(out.headers!["Content-Disposition"]).toContain("inline");
    expect(Buffer.concat(out.body)).toEqual(png);
    // An unknown token is 404, never a directory listing or an error page.
    expect((await handle(channel, "/attachments/nope")).status).toBe(404);
  });

  it("serves a local file by path and refuses a remote URL as a source", async () => {
    const channel = new WebChannel();
    const sent: Array<Record<string, unknown>> = [];
    (channel as unknown as { sendToClient: (c: string, d: Record<string, unknown>) => boolean }).sendToClient = (_c, d) => { sent.push(d); return true; };
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "web-attach-"));
    const file = join(dir, "HOW_TO_RUN.md");
    writeFileSync(file, "# How to run\nOpen Assets/Scenes/Main.unity");
    await channel.sendAttachment("chat-1", { type: "document", name: "HOW_TO_RUN.md", url: file });
    const token = /\/attachments\/([A-Za-z0-9_-]+)\)/.exec(String(sent[0]!.text))![1]!;
    expect(String(sent[0]!.text)).toContain("📎 [HOW_TO_RUN.md]");
    expect(sent[0]).toMatchObject({ type: "attachment", kind: "file", name: "HOW_TO_RUN.md" });
    const out = await handle(channel, `/attachments/${token}`);
    expect(out.status).toBe(200);
    expect(out.headers!["Content-Disposition"]).toContain('attachment; filename="HOW_TO_RUN.md"');
    expect(Buffer.concat(out.body).toString()).toContain("Open Assets/Scenes/Main.unity");

    await channel.sendAttachment("chat-1", { type: "document", name: "evil", url: "https://example.com/x" });
    expect(String(sent[1]!.text)).toContain("not deliverable");
    // Guard: the undeliverable notice carries no link syntax; it stays a plain
    // text frame rather than being promoted to markdown along with the links.
    expect(sent[1]!.type).toBe("text");
  });

  // ---------------------------------------------------------------------------
  // ROUND 9 #24 — what the link exposes cannot be changed under the recipient
  //
  // The token used to keep the PATH: after the message was sent, deleting the
  // file made the link 404, replacing it served the replacement, and pointing
  // it at a private file through a symlink served that, because the handler
  // followed whatever was there when the link was clicked.
  // ---------------------------------------------------------------------------
  it("serves the attachment it registered after the path is deleted, replaced, or symlinked (round 9 #24)", async () => {
    const channel = new WebChannel();
    const sent: Array<Record<string, unknown>> = [];
    (channel as unknown as { sendToClient: (c: string, d: Record<string, unknown>) => boolean }).sendToClient = (_c, d) => { sent.push(d); return true; };
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "web-attach-mutable-"));
    const file = join(dir, "report.md");
    const secret = join(dir, "id_rsa");
    writeFileSync(file, "the report the user was sent");
    writeFileSync(secret, "PRIVATE-KEY-MATERIAL");

    await channel.sendAttachment("chat-1", { type: "document", name: "report.md", url: file });
    const token = /\/attachments\/([A-Za-z0-9_-]+)\)/.exec(String(sent[0]!.text))![1]!;

    // 1. Deleted: the link still serves what was attached.
    rmSync(file);
    let out = await handle(channel, `/attachments/${token}`);
    expect(out.status).toBe(200);
    expect(Buffer.concat(out.body).toString()).toBe("the report the user was sent");

    // 2. Replaced by an unrelated file of the same name.
    writeFileSync(file, "a completely different document");
    out = await handle(channel, `/attachments/${token}`);
    expect(Buffer.concat(out.body).toString()).toBe("the report the user was sent");

    // 3. Swapped for a symlink to something private.
    rmSync(file);
    symlinkSync(secret, file);
    out = await handle(channel, `/attachments/${token}`);
    expect(Buffer.concat(out.body).toString()).toBe("the report the user was sent");
    expect(Buffer.concat(out.body).toString()).not.toContain("PRIVATE-KEY-MATERIAL");
    rmSync(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // ROUND 10 #2 — above the 8 MiB inline limit the record kept a mutable PATH
  //
  // A 9 MiB recording was registered by reference, so deleting its temp source —
  // which is what the pipeline that produced it does — 404'd a token that had not
  // expired, and a file replaced between verification and the stream was served
  // in place of the promised bytes. The record retains its own immutable copy.
  // ---------------------------------------------------------------------------
  it("serves a 9 MiB recording after its temp source is deleted (round 10 #2)", async () => {
    const channel = new WebChannel();
    const sent: Array<Record<string, unknown>> = [];
    (channel as unknown as { sendToClient: (c: string, d: Record<string, unknown>) => boolean }).sendToClient = (_c, d) => { sent.push(d); return true; };
    const dir = mkdtempSync(join(tmpdir(), "web-attach-large-"));
    const file = join(dir, "gameplay.mp4");
    // Above the 8 MiB inline limit: the by-reference branch.
    const bytes = Buffer.alloc(9 * 1024 * 1024, 0);
    bytes.write("RECORDING-HEAD", 0);
    bytes.write("RECORDING-TAIL", bytes.length - 14);
    writeFileSync(file, bytes);

    await channel.sendAttachment("chat-1", { type: "document", name: "gameplay.mp4", url: file, size: bytes.length });
    const token = /\/attachments\/([A-Za-z0-9_-]+)\)/.exec(String(sent[0]!.text))![1]!;

    // The pipeline cleans up its temp file the moment the message is out.
    rmSync(file);
    const out = await handle(channel, `/attachments/${token}`);
    expect(out.status).toBe(200);
    expect(out.headers!["Content-Length"]).toBe(String(bytes.length));
    const served = Buffer.concat(out.body);
    expect(served.length).toBe(bytes.length);
    expect(served.subarray(0, 14).toString()).toBe("RECORDING-HEAD");
    expect(served.subarray(-14).toString()).toBe("RECORDING-TAIL");
    // …and the same token serves the same bytes again, for as long as it lives.
    expect(Buffer.concat((await handle(channel, `/attachments/${token}`)).body).length).toBe(bytes.length);

    rmSync(dir, { recursive: true, force: true });
    await channel.disconnect();
  });

  it("serves the verified bytes when the file is replaced between verification and the stream (round 10 #2)", async () => {
    const channel = new WebChannel();
    const sent: Array<Record<string, unknown>> = [];
    (channel as unknown as { sendToClient: (c: string, d: Record<string, unknown>) => boolean }).sendToClient = (_c, d) => { sent.push(d); return true; };
    const dir = mkdtempSync(join(tmpdir(), "web-attach-race-"));
    const file = join(dir, "recording.mp4");
    const bytes = Buffer.alloc(9 * 1024 * 1024, 0x41); // "A"
    writeFileSync(file, bytes);
    await channel.sendAttachment("chat-1", { type: "document", name: "recording.mp4", url: file, size: bytes.length });
    const token = /\/attachments\/([A-Za-z0-9_-]+)\)/.exec(String(sent[0]!.text))![1]!;

    // Open the window deterministically: the instant the store says the file is
    // the registered one, something replaces it at that path. Both the check and
    // the open are patched, so the test does not care WHICH of them the serve
    // path uses — it only insists that the bytes leaving the server are the ones
    // that were verified.
    const store = (channel as unknown as {
      attachmentStore: {
        openStoredFile: (e: { path?: string }) => unknown;
        verifyStoredFile: (e: { path?: string }) => boolean;
      };
    }).attachmentStore;
    // A replacement is a NEW file at that path — rm + create, or a symlink swap:
    // what a process that owns the directory entry can do. (Rewriting the store's
    // own copy IN PLACE is not this: that needs write access to the 0700 spool,
    // i.e. the daemon itself.)
    const replace = (entry: { path?: string }) => {
      if (!entry.path) return;
      rmSync(entry.path);
      writeFileSync(entry.path, Buffer.alloc(bytes.length, 0x5a)); // "Z"
    };
    const realOpen = store.openStoredFile.bind(store);
    const realVerify = store.verifyStoredFile.bind(store);
    store.openStoredFile = (entry) => { const open = realOpen(entry); replace(entry); return open; };
    store.verifyStoredFile = (entry) => { const ok = realVerify(entry); replace(entry); return ok; };

    const out = await handle(channel, `/attachments/${token}`);
    expect(out.status).toBe(200);
    const served = Buffer.concat(out.body);
    expect(served.length).toBe(bytes.length);
    expect(served.includes(Buffer.from("Z".repeat(64)))).toBe(false);
    expect(served.subarray(0, 64).toString()).toBe("A".repeat(64));

    rmSync(dir, { recursive: true, force: true });
    await channel.disconnect();
  });
});

// ── Plan 6.14: the shared-instance management model, on ONE channel instance ──
//
// One daemon serves more than one person: the portal hands every browser its own
// profile identity and they all reach the SAME channel, the same workspace bus,
// the same dashboard proxy and the same .env. The model (src/channels/web/
// instance-access.ts): an identity sees and controls its own traffic; only the
// instance owner — the first identity this instance issued — configures or
// controls the instance; an unattributed request is granted only while the
// instance has a single identity.
//
// The exit criterion is this suite: TWO live identities on one instance.
describe("WebChannel shared instance: two identities (plan 6.14)", () => {
  const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const GUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  type IdentityStoreView = {
    issue: (id?: string) => { profileId: string; profileToken: string };
    ownerProfileId: () => string | undefined;
    isOwner: (id: string | undefined) => boolean;
    count: () => number;
  };

  function identityStore(channel: WebChannel): IdentityStoreView {
    return (channel as unknown as { identityStore: IdentityStoreView }).identityStore;
  }

  /** A live socket holding `profileId`, with the token that proves it. */
  function connect(channel: WebChannel, profileId: string) {
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const identity = identityStore(channel).issue(profileId);
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "session_init",
      profileId: identity.profileId,
      profileToken: identity.profileToken,
    })));
    const connected = socket.getSentMessages().filter((m) => m.type === "connected").at(-1)!;
    return {
      socket,
      profileId: identity.profileId,
      profileToken: identity.profileToken,
      chatId: String(connected.chatId),
      frames: (type: string) => socket.getSentMessages().filter((m) => m.type === type),
      dump: () => JSON.stringify(socket.getSentMessages()),
    };
  }

  /** Owner first (the first identity an instance issues owns it), guest second. */
  function twoIdentities(port = 3000) {
    const channel = new WebChannel(port, 3100);
    const owner = connect(channel, OWNER_ID);
    const guest = connect(channel, GUEST_ID);
    return { channel, owner, guest };
  }

  function ws(channel: WebChannel, chatId: string, payload: Record<string, unknown>): Promise<void> {
    return (channel as unknown as {
      handleWsMessage: (chatId: string, data: Record<string, unknown>) => Promise<void>;
    }).handleWsMessage(chatId, payload);
  }

  /** A real GET against handleHttp, with headers, collecting status + body. */
  async function httpGet(channel: WebChannel, url: string, headers: Record<string, string> = {}) {
    const out: { status?: number; headers?: Record<string, string>; body: Buffer[] } = { body: [] };
    const res = new Writable({ write(chunk, _enc, cb) { out.body.push(Buffer.from(chunk)); cb(); } }) as unknown as
      import("node:http").ServerResponse & { headersSent: boolean };
    Object.assign(res, {
      headersSent: false,
      writeHead: (status: number, h: Record<string, string>) => { out.status = status; out.headers = h; res.headersSent = true; return res; },
    });
    await (channel as unknown as { handleHttp: (req: unknown, res: unknown) => Promise<void> })
      .handleHttp({ method: "GET", url, headers }, res);
    if (!(res as unknown as Writable).writableFinished) await new Promise((r) => (res as unknown as Writable).once("finish", r));
    return { ...out, text: Buffer.concat(out.body).toString() };
  }

  it("makes the FIRST identity the instance owner and every later one a guest", async () => {
    const { channel, owner, guest } = twoIdentities();
    const store = identityStore(channel);
    expect(store.ownerProfileId()).toBe(owner.profileId);
    expect(store.isOwner(owner.profileId)).toBe(true);
    expect(store.isOwner(guest.profileId)).toBe(false);
    expect(store.count()).toBe(2);
    await channel.disconnect();
  });

  it("delivers each identity's monitor frames, chat frames and confirmations only to its own socket", async () => {
    const { channel, owner, guest } = twoIdentities();

    channel.broadcastRaw(JSON.stringify({
      type: "monitor:dag_init",
      payload: { rootId: "ep-owner", nodes: [{ id: "n1", task: "owner-secret-request" }] },
      origin: owner.profileId,
      timestamp: 1,
    }));
    await channel.sendText(owner.chatId, "owner-secret-answer");
    const confirmation = channel.requestConfirmation({
      chatId: owner.chatId,
      question: "owner-secret-question",
      options: ["yes", "no"],
    });

    expect(owner.frames("monitor:dag_init")).toHaveLength(1);
    expect(owner.frames("text").some((f) => f.text === "owner-secret-answer")).toBe(true);
    expect(owner.frames("confirmation")).toHaveLength(1);

    expect(guest.frames("monitor:dag_init")).toHaveLength(0);
    expect(guest.frames("confirmation")).toHaveLength(0);
    expect(guest.dump()).not.toContain("owner-secret");

    // …and the guest cannot answer the owner's confirmation either.
    const confirmId = String(owner.frames("confirmation")[0]!.confirmId);
    await ws(channel, guest.chatId, { type: "confirmation_response", confirmId, option: "yes" });
    expect(guest.frames("confirmation_ack")).toHaveLength(0);

    // The owner's own answer still settles it.
    await ws(channel, owner.chatId, { type: "confirmation_response", confirmId, option: "no" });
    expect(await confirmation).toBe("no");

    await channel.disconnect();
  });

  it("refuses a guest the owner's attachment, by bare token and with its own identity", async () => {
    const { channel, owner, guest } = twoIdentities();
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await channel.sendAttachment(owner.chatId, {
      type: "image", name: "owner-frame.png", data: png, mimeType: "image/png", size: png.length,
    });

    // The link only the owner's socket received carries its own proof.
    const delivered = owner.frames("attachment")[0]!;
    const href = String(delivered.href);
    expect(guest.frames("attachment")).toHaveLength(0);
    expect(href).toMatch(/^\/attachments\/[A-Za-z0-9_-]+\?v=[A-Za-z0-9_-]+$/);
    const token = href.slice("/attachments/".length).split("?")[0]!;

    // The owner's own link serves the bytes.
    const mine = await httpGet(channel, href);
    expect(mine.status).toBe(200);
    expect(Buffer.concat(mine.body)).toEqual(png);

    // The guest read the token off a shared screen: the bare link is refused,
    // and the refusal says who was refused and why.
    const bare = await httpGet(channel, `/attachments/${token}`);
    expect(bare.status).toBe(403);
    expect(bare.text).toContain(owner.profileId);
    expect(bare.text).toContain("attachment:read");

    // …and so is the signed link once the guest presents its OWN identity: a
    // leaked URL stops working for anyone who has an identity of their own.
    const asGuest = await httpGet(channel, href, {
      "x-strada-profile-id": guest.profileId,
      "x-strada-profile-token": guest.profileToken,
    });
    expect(asGuest.status).toBe(403);
    expect(asGuest.text).toContain(guest.profileId);
    expect(asGuest.text).toContain("guest");

    // The owner presenting its headers is still served.
    const asOwner = await httpGet(channel, href, {
      "x-strada-profile-id": owner.profileId,
      "x-strada-profile-token": owner.profileToken,
    });
    expect(asOwner.status).toBe(200);

    await channel.disconnect();
  });

  it("refuses a guest's setup write through the dashboard proxy and lets the owner's through", async () => {
    const { channel, owner, guest } = twoIdentities();
    const proxy = (req: unknown, res: unknown, url: string) => (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, url);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // An impeccable same-origin POST — but from the GUEST identity.
    const guestReq = createMockRequest({
      method: "POST",
      url: "/api/settings/env",
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-strada-profile-id": guest.profileId,
        "x-strada-profile-token": guest.profileToken,
      },
      body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-guest" }),
    });
    const guestRes = createMockResponse();
    const guestPending = proxy(guestReq, guestRes, "/api/settings/env");
    guestReq.emitBody();
    await guestPending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(guestRes.statusCode).toBe(403);
    expect(guestRes.body).toContain(guest.profileId);
    expect(guestRes.body).toContain("setup:write");
    expect(guestRes.body).toContain(owner.profileId);

    // The owner's identical write goes through.
    const ownerReq = createMockRequest({
      method: "POST",
      url: "/api/settings/env",
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-strada-profile-id": owner.profileId,
        "x-strada-profile-token": owner.profileToken,
      },
      body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-owner" }),
    });
    const ownerRes = createMockResponse();
    const ownerPending = proxy(ownerReq, ownerRes, "/api/settings/env");
    ownerReq.emitBody();
    await ownerPending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ownerRes.statusCode).toBe(200);

    // An unattributed write is refused too, once the instance IS shared: with
    // two identities here it can no longer be assumed to be the owner's.
    const anonReq = createMockRequest({
      method: "POST",
      url: "/api/settings/env",
      headers: { origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-anon" }),
    });
    const anonRes = createMockResponse();
    const anonPending = proxy(anonReq, anonRes, "/api/settings/env");
    anonReq.emitBody();
    await anonPending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(anonRes.statusCode).toBe(403);
    expect(anonRes.body).toContain("deny:unidentified");

    await channel.disconnect();
  });

  // ROUND 13 #7 + #9 CHANGED THIS CONTRACT, DELIBERATELY.
  //
  // It used to read "a single-identity instance needs no headers", and that was
  // the hole #9 walked through: an instance with one registered owner is not
  // `shared`, so anything unattributed was granted owner powers. The portal now
  // attaches the verified pair to its own API requests (round 13 #7), so the one
  // person's settings page keeps working — by identifying itself, not by being
  // alone. What survives untouched is the instance that has issued NO web
  // identity at all (no owner recorded): see the model's own tests.
  it("keeps the single OWNER working — with the pair the portal now attaches", async () => {
    const channel = new WebChannel(3000, 3100);
    const solo = connect(channel, OWNER_ID);
    expect(identityStore(channel).count()).toBe(1);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = createMockRequest({
      method: "POST",
      url: "/api/settings/env",
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-strada-profile-id": solo.profileId,
        "x-strada-profile-token": solo.profileToken,
      },
      body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-solo" }),
    });
    const res = createMockResponse();
    const pending = (channel as unknown as {
      proxyToDashboard: (req: unknown, res: unknown, url: string) => Promise<void>;
    }).proxyToDashboard(req, res, "/api/settings/env");
    req.emitBody();
    await pending;

    expect(solo.profileId).toBe(OWNER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    await channel.disconnect();
  });

  it("refuses a guest cancelling or inspecting the owner's task, and names it", async () => {
    const { channel, owner, guest } = twoIdentities();
    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text ?? ""); });
    channel.setTaskOwnerResolver((taskId) => (taskId === "task-owner" ? owner.chatId : null));

    // The chat-surface cancel: the shorter route to the same power.
    await ws(channel, guest.chatId, { type: "cancel_task", taskId: "task-owner" });
    expect(seen).not.toContain("/cancel task-owner");
    const refusal = guest.frames("text").map((f) => String(f.text)).join("\n");
    expect(refusal).toContain(guest.profileId);
    expect(refusal).toContain("task-owner");

    // Inspecting it (a verify run against the owner's task) is refused as well.
    await ws(channel, guest.chatId, {
      type: "verify:check_criterion", taskId: "task-owner", criterionId: "c1", checkType: "build",
    });
    const verdict = guest.frames("verify:check_result").at(-1)!;
    expect(verdict.status).toBe("fail");
    expect(String(verdict.error)).toContain(guest.profileId);

    // The owner still cancels its own task.
    await ws(channel, owner.chatId, { type: "cancel_task", taskId: "task-owner" });
    expect(seen).toContain("/cancel task-owner");

    await channel.disconnect();
  });

  it("refuses a guest instance control (pause the run, switch provider, autonomous mode)", async () => {
    const { channel, owner, guest } = twoIdentities();
    const emit = vi.fn();
    channel.setWorkspaceBusEmitter(emit);
    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text ?? ""); });

    await ws(channel, guest.chatId, { type: "monitor:pause" });
    await ws(channel, guest.chatId, { type: "provider_switch", provider: "openai", model: "gpt-5" });
    await ws(channel, guest.chatId, { type: "autonomous_toggle", enabled: true });

    expect(emit).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    const refusals = guest.frames("text").map((f) => String(f.text)).join("\n");
    expect(refusals).toContain(guest.profileId);
    expect(refusals).toContain(owner.profileId);
    expect(refusals.match(/Refused:/g)?.length).toBe(3);

    // The owner has all three powers.
    await ws(channel, owner.chatId, { type: "monitor:pause" });
    await ws(channel, owner.chatId, { type: "provider_switch", provider: "openai", model: "gpt-5" });
    await ws(channel, owner.chatId, { type: "autonomous_toggle", enabled: true });
    expect(emit).toHaveBeenCalledWith("monitor:pause", expect.objectContaining({ type: "monitor:pause" }));
    expect(seen).toEqual(["/model openai/gpt-5", "/autonomous on"]);

    await channel.disconnect();
  });

  // ── The legacy-adoption path (resolveLegacyProfileId), end to end ──
  //
  // profileId is a PUBLIC value: it is sent to the client and kept in
  // localStorage. An unauthenticated client that names an existing profileId
  // must get a fresh identity, never that profile's history.
  it("does not let an unauthenticated client claim an existing profileId and inherit its history", async () => {
    const channel = new WebChannel();
    const victim = connect(channel, OWNER_ID);
    channel.broadcastRaw(JSON.stringify({
      type: "monitor:dag_init",
      payload: { rootId: "ep-owner", nodes: [{ id: "n1", task: "owner-secret-request" }] },
      origin: victim.profileId,
      timestamp: 1,
    }));
    expect(victim.frames("monitor:dag_init")).toHaveLength(1);

    for (const claim of [{ legacyProfileChatId: OWNER_ID }, { profileChatId: OWNER_ID }, { profileId: OWNER_ID, profileToken: "guessed" }]) {
      const socket = createMockSocket();
      (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
      socket.emit("message", Buffer.from(JSON.stringify({ type: "session_init", ...claim })));
      const connected = socket.getSentMessages().filter((m) => m.type === "connected").at(-1)!;

      expect(connected.profileId, JSON.stringify(claim)).not.toBe(OWNER_ID);
      expect(JSON.stringify(socket.getSentMessages())).not.toContain("owner-secret");
      expect(socket.getSentMessages().filter((m) => m.type === "monitor:dag_init")).toHaveLength(0);
      // …and the claim did not overwrite the victim's token either.
      expect(identityStore(channel).isOwner(OWNER_ID)).toBe(true);
    }

    await channel.disconnect();
  });
  // A reconnect token is a CHAT credential; a profile token an IDENTITY one. A
  // chat's replayed board and its buffered answers belong to the identity that
  // owns the chat, so presenting one identity's chat token while authenticating
  // as another must not hand over that chat.
  it("does not hand one identity's chat to another identity that reconnects into it", async () => {
    const { channel, owner, guest } = twoIdentities();

    // An answer produced while the owner's browser is away is buffered for its chat.
    owner.socket.close();
    await channel.sendMarkdown(owner.chatId, "owner-secret-final");

    const ownerChatToken = String(
      (channel as unknown as { recentlyDisconnected: Map<string, { reconnectToken: string }> })
        .recentlyDisconnected.get(owner.chatId)!.reconnectToken,
    );

    // The guest holds the owner's CHAT token but authenticates as itself.
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "session_init",
      chatId: owner.chatId,
      reconnectToken: ownerChatToken,
      profileId: guest.profileId,
      profileToken: guest.profileToken,
    })));
    const connected = socket.getSentMessages().filter((m) => m.type === "connected").at(-1)!;

    expect(connected.chatId).not.toBe(owner.chatId);
    expect(connected.profileId).toBe(guest.profileId);
    expect(JSON.stringify(socket.getSentMessages())).not.toContain("owner-secret-final");

    // …while the owner's own reconnect into its own chat still gets it back.
    const again = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(again);
    again.emit("message", Buffer.from(JSON.stringify({
      type: "session_init",
      chatId: owner.chatId,
      reconnectToken: ownerChatToken,
      profileId: owner.profileId,
      profileToken: owner.profileToken,
    })));
    const back = again.getSentMessages().filter((m) => m.type === "connected").at(-1)!;
    expect(back.chatId).toBe(owner.chatId);
    expect(JSON.stringify(again.getSentMessages())).toContain("owner-secret-final");

    await channel.disconnect();
  });
});

// ── Plan 6.14, the durable half: an attachment's owner survives a restart ──
//
// The channel scoped each attachment link to the identity it was delivered to,
// but kept that binding in an in-process LRU and signed the link with a
// per-process key. After a restart the same link was unattributable: served on a
// single-identity instance, refused on a shared one — readable or not depending
// on when the daemon last booted, which is not an access model. The owner is now
// a column on the attachment store and the scoping key lives beside the rows.
describe("WebChannel attachment ownership survives a restart (plan 6.14)", () => {
  const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const GUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Two databases in a temp dir — never the real ~/.strada. */
  function paths() {
    const dir = mkdtempSync(join(tmpdir(), "web-instance-"));
    dirs.push(dir);
    return { identityDbPath: join(dir, "web-identities.db"), attachmentDbPath: join(dir, "web-attachments.db") };
  }

  function connect(channel: WebChannel, profileId: string) {
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const identity = (channel as unknown as {
      identityStore: { issue: (id?: string) => { profileId: string; profileToken: string } };
    }).identityStore.issue(profileId);
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "session_init", profileId: identity.profileId, profileToken: identity.profileToken,
    })));
    const connected = socket.getSentMessages().filter((m) => m.type === "connected").at(-1)!;
    return {
      socket,
      profileId: identity.profileId,
      profileToken: identity.profileToken,
      chatId: String(connected.chatId),
      frames: (type: string) => socket.getSentMessages().filter((m) => m.type === type),
    };
  }

  async function httpGet(channel: WebChannel, url: string, headers: Record<string, string> = {}) {
    const out: { status?: number; body: Buffer[] } = { body: [] };
    const res = new Writable({ write(chunk, _enc, cb) { out.body.push(Buffer.from(chunk)); cb(); } }) as unknown as
      import("node:http").ServerResponse & { headersSent: boolean };
    Object.assign(res, {
      headersSent: false,
      writeHead: (status: number, _h: Record<string, string>) => { out.status = status; res.headersSent = true; return res; },
    });
    await (channel as unknown as { handleHttp: (req: unknown, res: unknown) => Promise<void> })
      .handleHttp({ method: "GET", url, headers }, res);
    if (!(res as unknown as Writable).writableFinished) await new Promise((r) => (res as unknown as Writable).once("finish", r));
    return { status: out.status, bytes: Buffer.concat(out.body), text: Buffer.concat(out.body).toString() };
  }

  it("serves the owner's own link and refuses a second identity AFTER a restart", async () => {
    const dbs = paths();
    const png = Buffer.from("89504e470d0a1a0a", "hex");

    const before = new WebChannel(3000, 3100, dbs);
    const owner = connect(before, OWNER_ID);
    const guest = connect(before, GUEST_ID);
    await before.sendAttachment(owner.chatId, {
      type: "image", name: "owner-frame.png", data: png, mimeType: "image/png", size: png.length,
    });
    const href = String(owner.frames("attachment")[0]!.href);
    const token = href.slice("/attachments/".length).split("?")[0]!;
    expect(href).toContain("?v=");
    expect(guest.frames("attachment")).toHaveLength(0);
    await before.disconnect();

    // A NEW process on the same databases: the link in the chat history is the
    // same link, and it must mean the same thing.
    const after = new WebChannel(3000, 3100, dbs);
    const asOwnerLink = await httpGet(after, href);
    expect(asOwnerLink.status).toBe(200);
    expect(asOwnerLink.bytes).toEqual(png);

    const asOwnerHeaders = await httpGet(after, `/attachments/${token}`, {
      "x-strada-profile-id": owner.profileId,
      "x-strada-profile-token": owner.profileToken,
    });
    expect(asOwnerHeaders.status).toBe(200);

    // The guest — whose identity the reopened instance still knows — is refused,
    // with the bare token and with the owner's signed link.
    const bare = await httpGet(after, `/attachments/${token}`);
    expect(bare.status).toBe(403);
    expect(bare.text).toContain(owner.profileId);

    const asGuest = await httpGet(after, href, {
      "x-strada-profile-id": guest.profileId,
      "x-strada-profile-token": guest.profileToken,
    });
    expect(asGuest.status).toBe(403);
    expect(asGuest.text).toContain(guest.profileId);

    await after.disconnect();
  });

  // The conservative direction for a row written before the column existed (or
  // for a chat that has no identity at all): nobody can be shown to own it, so
  // on a shared instance it is served to NOBODY — never "anyone may read it".
  it("refuses an attachment nobody can be shown to own on a shared instance", async () => {
    const dbs = paths();
    const channel = new WebChannel(3000, 3100, dbs);
    const owner = connect(channel, OWNER_ID);
    const guest = connect(channel, GUEST_ID);

    // A chat with no identity: the daemon-side chat of a legacy row.
    await channel.sendAttachment("chat-with-no-identity", {
      type: "document", name: "old.md", data: Buffer.from("legacy bytes"), size: 12,
    });
    const store = (channel as unknown as {
      attachmentStore: { size: () => number };
    }).attachmentStore;
    expect(store.size()).toBe(1);
    const token = (channel as unknown as {
      attachmentStore: { get: (t: string) => unknown };
    }) && String(
      (channel as unknown as { attachmentStore: { lastToken?: string } }).attachmentStore.lastToken ?? "",
    );
    void token;

    // Reach the row's token the way a client would: the frame was buffered for a
    // chat with no socket, so read it out of the pending-delivery buffer.
    const buffered = (channel as unknown as {
      pendingDelivery: Map<string, Array<Record<string, unknown>>>;
    }).pendingDelivery.get("chat-with-no-identity")!;
    const frame = buffered.find((f) => f.type === "attachment")!;
    const href = String(frame.href);
    expect(href).not.toContain("?v=");

    for (const [who, headers] of [
      ["nobody", {}],
      ["the owner", { "x-strada-profile-id": owner.profileId, "x-strada-profile-token": owner.profileToken }],
      ["the guest", { "x-strada-profile-id": guest.profileId, "x-strada-profile-token": guest.profileToken }],
    ] as const) {
      const out = await httpGet(channel, href, headers);
      expect(out.status, who).toBe(403);
      expect(out.text, who).toContain("attachment:read");
    }

    await channel.disconnect();
  });

  // Guard: a one-person instance is untouched — its own unattributed links work.
  it("still serves an unowned attachment on a single-identity instance", async () => {
    const dbs = paths();
    const channel = new WebChannel(3000, 3100, dbs);
    const solo = connect(channel, OWNER_ID);
    await channel.sendAttachment(solo.chatId, {
      type: "document", name: "notes.md", data: Buffer.from("hello"), size: 5,
    });
    const href = String(solo.frames("attachment")[0]!.href);
    const token = href.slice("/attachments/".length).split("?")[0]!;
    expect((await httpGet(channel, href)).status).toBe(200);
    expect((await httpGet(channel, `/attachments/${token}`)).status).toBe(200);
    await channel.disconnect();
  });
});

// ── Codex round 13, the authorization cluster: the ways AROUND the owner check ──
//
// Plan 6.14 gave the instance an owner and gated the surfaces that were known.
// These are the entries that were not: a socket that never identified itself, a
// power typed as text instead of sent as a control frame, and a chat binding the
// LRU forgot while the session it belonged to was still alive.
describe("WebChannel shared instance: the ways around the owner check (round 13)", () => {
  const OWNER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const GUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  type StoreView = {
    issue: (id?: string) => { profileId: string; profileToken: string };
    ownerProfileId: () => string | undefined;
    count: () => number;
  };

  function store(channel: WebChannel): StoreView {
    return (channel as unknown as { identityStore: StoreView }).identityStore;
  }

  function open(channel: WebChannel) {
    const socket = createMockSocket();
    (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
    const first = socket.getSentMessages().find((m) => m.type === "connected")!;
    return {
      socket,
      chatId: String(first.chatId),
      reconnectToken: String(first.reconnectToken),
      send: (payload: Record<string, unknown>) => socket.emit("message", Buffer.from(JSON.stringify(payload))),
      frames: (type: string) => socket.getSentMessages().filter((m) => m.type === type),
      text: () => socket.getSentMessages().filter((m) => m.type === "text").map((m) => String(m.text)).join("\n"),
      connected: () => socket.getSentMessages().filter((m) => m.type === "connected").at(-1)!,
    };
  }

  /** Let the channel's own await chain (ownership lookups, handlers) run out. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** A socket that completed session_init as `profileId`. */
  function identify(channel: WebChannel, profileId: string) {
    const socket = open(channel);
    const identity = store(channel).issue(profileId);
    socket.send({ type: "session_init", profileId: identity.profileId, profileToken: identity.profileToken });
    const connected = socket.connected();
    return {
      ...socket,
      profileId: identity.profileId,
      profileToken: identity.profileToken,
      chatId: String(connected.chatId),
      reconnectToken: String(connected.reconnectToken),
    };
  }

  // ── #9: an unidentified second socket must not inherit owner powers ─────────
  //
  // THE DEFECT. `allow:sole-identity` hung on the identity COUNT, and a second
  // socket that simply never sent session_init does not raise the count: it
  // stays "unidentified", the instance stays "not shared", and the model said
  // yes. Pausing the run, switching the provider and flipping autonomous mode
  // were all available to any socket that declined to say who it was.
  it("refuses instance control to a socket that never completed session_init", async () => {
    const channel = new WebChannel(3000, 3100);
    const owner = identify(channel, OWNER_ID);
    expect(store(channel).ownerProfileId()).toBe(owner.profileId);
    expect(store(channel).count()).toBe(1);

    const emit = vi.fn();
    channel.setWorkspaceBusEmitter(emit);
    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text ?? ""); });

    const stranger = open(channel);
    stranger.send({ type: "monitor:pause" });
    stranger.send({ type: "provider_switch", provider: "openai", model: "gpt-5" });
    stranger.send({ type: "autonomous_toggle", enabled: true });
    await settle();

    expect(emit).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    // Still one identity: declining to identify must not be a way to be counted.
    expect(store(channel).count()).toBe(1);
    expect(stranger.text()).toContain("Refused");

    // The owner still has all three.
    await (channel as unknown as { handleWsMessage: (c: string, d: Record<string, unknown>) => Promise<void> })
      .handleWsMessage(owner.chatId, { type: "monitor:pause" });
    expect(emit).toHaveBeenCalledWith("monitor:pause", expect.objectContaining({ type: "monitor:pause" }));

    await channel.disconnect();
  });

  // The OTHER half of #9, isolated: on an instance that has issued no identity
  // at all the model still grants an unattributed owner-only action (the
  // CLI/dashboard-only deployment, nobody to be separated from) — so the
  // requirement that a frame which ACTS comes from an initialized session has to
  // stand on its own, or a pre-session_init socket walks in through that door.
  it("refuses a frame that acts before session_init even with no owner recorded yet", async () => {
    const channel = new WebChannel(3000, 3100);
    const emit = vi.fn();
    channel.setWorkspaceBusEmitter(emit);
    channel.setTaskOwnerResolver(() => null);
    expect(store(channel).ownerProfileId()).toBeUndefined();
    expect(store(channel).count()).toBe(0);

    const stranger = open(channel);
    stranger.send({ type: "monitor:pause" });
    stranger.send({ type: "monitor:cancel_task", taskId: "task-1" });
    await settle();

    expect(emit).not.toHaveBeenCalled();
    expect(stranger.text()).toContain("session_init");

    // …and a socket that identifies itself FIRST — which is what the portal
    // does, and the only order `session_init` is honoured in — is served.
    const proper = open(channel);
    proper.send({ type: "session_init" });
    proper.send({ type: "monitor:pause" });
    await settle();
    expect(emit).toHaveBeenCalledWith("monitor:pause", expect.objectContaining({ type: "monitor:pause" }));

    await channel.disconnect();
  });

  // ── Round 14 #4: a TYPED privileged command needs a session too ────────────
  //
  // THE DEFECT. Round 13 #9 required an initialized session for the control
  // FRAMES and round 13 #11 authorized the typed commands through the model — so
  // on an instance with no owner yet the model's own `allow:sole-identity` let a
  // pre-session_init socket type `/daemon stop` while the equivalent
  // `monitor:pause` frame from the same socket was refused. One power, two
  // answers, decided by which shape the caller happened to use.
  it("refuses /daemon stop typed before session_init, even with no owner recorded", async () => {
    const channel = new WebChannel(3000, 3100);
    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text ?? ""); });
    expect(store(channel).ownerProfileId()).toBeUndefined();

    const stranger = open(channel);
    stranger.send({ type: "message", text: "/daemon stop" });
    stranger.send({ type: "message", text: "/autonomous on" });
    stranger.send({ type: "message", text: "/run rm -rf build" });
    await settle();

    expect(seen).toEqual([]);
    expect(stranger.text()).toContain("session_init");

    // An ordinary request from the same socket still works: the requirement is on
    // the powers, not on talking.
    stranger.send({ type: "message", text: "build me a level" });
    await settle();
    expect(seen).toEqual(["build me a level"]);

    // …and a socket that identified itself first may type them.
    const proper = open(channel);
    proper.send({ type: "session_init" });
    proper.send({ type: "message", text: "/daemon stop" });
    await settle();
    expect(seen).toContain("/daemon stop");

    await channel.disconnect();
  });

  // ── Round 14 #3, through the channel: /goal cancel is /cancel ──────────────
  it("refuses a guest cancelling the owner's task through /goal cancel", async () => {
    const channel = new WebChannel(3000, 3100);
    const owner = identify(channel, OWNER_ID);
    const guest = identify(channel, GUEST_ID);
    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text ?? ""); });
    channel.setTaskOwnerResolver((taskId) => (taskId === "task-owner" ? owner.chatId : null));

    guest.send({ type: "message", text: "/goal cancel task-owner" });
    await settle();
    expect(seen).not.toContain("/goal cancel task-owner");
    expect(guest.text()).toContain("task-owner");

    // Reading it is refused too — inspecting another identity's task is the same
    // surface as controlling it.
    guest.send({ type: "message", text: "/detail task-owner" });
    guest.send({ type: "message", text: "/status task-owner" });
    await settle();
    expect(seen).not.toContain("/detail task-owner");
    expect(seen).not.toContain("/status task-owner");

    // The guest's own goals, lists and bare forms are untouched.
    guest.send({ type: "message", text: "/goal build me a level" });
    guest.send({ type: "message", text: "/goal list" });
    guest.send({ type: "message", text: "/status" });
    await settle();
    expect(seen).toEqual(["/goal build me a level", "/goal list", "/status"]);

    // …and the owner drives its own task by any of those routes.
    owner.send({ type: "message", text: "/goal cancel task-owner" });
    await settle();
    expect(seen).toContain("/goal cancel task-owner");

    await channel.disconnect();
  });

  it("refuses an unattributed settings write once an owner is recorded, even with one identity", async () => {
    const channel = new WebChannel(3000, 3100);
    const owner = identify(channel, OWNER_ID);
    expect(store(channel).count()).toBe(1);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const proxy = (req: unknown, res: unknown, url: string) =>
      (channel as unknown as { proxyToDashboard: (r: unknown, s: unknown, u: string) => Promise<void> })
        .proxyToDashboard(req, res, url);

    const anonReq = createMockRequest({
      method: "POST",
      url: "/api/settings/env",
      headers: { origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-anon" }),
    });
    const anonRes = createMockResponse();
    const anonPending = proxy(anonReq, anonRes, "/api/settings/env");
    anonReq.emitBody();
    await anonPending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(anonRes.statusCode).toBe(403);
    expect(anonRes.body).toContain("deny:unidentified");

    // …and the OWNER, presenting the pair the portal now attaches, is served.
    const ownerReq = createMockRequest({
      method: "POST",
      url: "/api/settings/env",
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-strada-profile-id": owner.profileId,
        "x-strada-profile-token": owner.profileToken,
      },
      body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-owner" }),
    });
    const ownerRes = createMockResponse();
    const ownerPending = proxy(ownerReq, ownerRes, "/api/settings/env");
    ownerReq.emitBody();
    await ownerPending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ownerRes.statusCode).toBe(200);

    await channel.disconnect();
  });

  // ── #11: the same powers, typed as chat text ────────────────────────────────
  //
  // THE DEFECT. `{type:"message",text:"/daemon stop"}` is not a control frame,
  // so none of the control-frame gates saw it. The channel-agnostic command
  // handler then dispatched it straight to heartbeatLoopRef.stop(). Every
  // owner-only power has a command like that, and the guest had all of them.
  it("refuses a guest the privileged chat commands and lets the owner type them", async () => {
    const channel = new WebChannel(3000, 3100);
    const owner = identify(channel, OWNER_ID);
    const guest = identify(channel, GUEST_ID);
    expect(store(channel).count()).toBe(2);

    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text ?? ""); });

    const privileged = [
      "/daemon stop",
      "/autonomous on",
      "/model pin openai/gpt-5",
      "/routing preset performance",
      "/token 1000000",
      "/persona switch mentor",
      "/vault init /tmp/whatever",
      "/run rm -rf build",
    ];
    for (const text of privileged) {
      guest.send({ type: "message", text });
    }
    await settle();

    expect(seen).toEqual([]);
    const refusals = guest.text();
    expect(refusals).toContain(guest.profileId);
    expect(refusals).toContain(owner.profileId);
    expect(refusals.match(/Refused:/g)?.length).toBe(privileged.length);

    // The guest can still USE the instance: an ordinary request, and the read
    // forms of the same commands, go through untouched.
    guest.send({ type: "message", text: "build me a level" });
    guest.send({ type: "message", text: "/daemon status" });
    guest.send({ type: "message", text: "/model list" });
    guest.send({ type: "message", text: "/status" });
    await settle();
    expect(seen).toEqual(["build me a level", "/daemon status", "/model list", "/status"]);

    // …and the owner types the privileged ones.
    owner.send({ type: "message", text: "/daemon stop" });
    await settle();
    expect(seen).toContain("/daemon stop");

    await channel.disconnect();
  });

  it("refuses a guest cancelling the owner's task by typing it", async () => {
    const channel = new WebChannel(3000, 3100);
    const owner = identify(channel, OWNER_ID);
    const guest = identify(channel, GUEST_ID);
    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text ?? ""); });
    channel.setTaskOwnerResolver((taskId) => (taskId === "task-owner" ? owner.chatId : null));

    guest.send({ type: "message", text: "/cancel task-owner" });
    await settle();

    expect(seen).not.toContain("/cancel task-owner");
    expect(guest.text()).toContain("task-owner");
    expect(guest.text()).toContain(guest.profileId);

    // The owner cancels its own task by typing, as before.
    owner.send({ type: "message", text: "/cancel task-owner" });
    await settle();
    expect(seen).toContain("/cancel task-owner");

    await channel.disconnect();
  });

  // ── #12: the chat binding may be forgotten; ownership may not ──────────────
  //
  // THE DEFECT. `profileByChat` is a 500-entry LRU and `mayReclaimChat` read a
  // MISSING entry as "belongs to nobody, help yourself". A busy instance evicts
  // the owner's binding while the owner's socket is still connected, and any
  // profile holding that chat's reconnect token then displaced the owner and
  // inherited the chat — its replayed boards and its buffered answers.
  it("does not let another identity reclaim a live chat whose binding was evicted", async () => {
    const channel = new WebChannel(3000, 3100);
    const owner = identify(channel, OWNER_ID);
    const guest = identify(channel, GUEST_ID);

    // 500 newer chats, each recording its own binding — the owner's is pushed out.
    for (let i = 0; i < 500; i++) {
      const filler = open(channel);
      filler.send({ type: "session_init" });
    }
    const bindings = (channel as unknown as { profileByChat: { get: (k: string) => string | undefined } }).profileByChat;
    expect(bindings.get(owner.chatId)).toBeUndefined();
    // The owner's session is still very much alive.
    expect((channel as unknown as { clients: Map<string, unknown> }).clients.has(owner.chatId)).toBe(true);

    // The guest, holding the owner's chat id and reconnect token, tries to take it.
    const thief = open(channel);
    thief.send({
      type: "session_init",
      profileId: guest.profileId,
      profileToken: guest.profileToken,
      chatId: owner.chatId,
      reconnectToken: owner.reconnectToken,
    });

    const landed = thief.connected();
    expect(landed.chatId).not.toBe(owner.chatId);
    expect(landed.profileId).toBe(guest.profileId);
    // The owner keeps its chat and its socket.
    expect(owner.socket.getCloseCalls()).toEqual([]);
    expect((channel as unknown as { clients: Map<string, WsClientView> }).clients.get(owner.chatId)?.profileId)
      .toBe(owner.profileId);

    // …and the owner's OWN reconnect still works: refusing the stranger must not
    // refuse the person whose chat it is.
    const again = open(channel);
    again.send({
      type: "session_init",
      profileId: owner.profileId,
      profileToken: owner.profileToken,
      chatId: owner.chatId,
      reconnectToken: owner.reconnectToken,
    });
    expect(String(again.connected().chatId)).toBe(owner.chatId);

    await channel.disconnect();
  });
});

type WsClientView = { profileId: string };
