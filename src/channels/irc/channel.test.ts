import { describe, expect, it, vi, afterEach } from "vitest";
import { IRCChannel } from "./channel.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("IRCChannel", () => {
  it("denies inbound users by default when no allowlist is configured", () => {
    const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);

    expect((channel as any).isAllowedInboundUser("alice")).toBe(false);
  });

  it("supports explicit open access when configured", () => {
    const channel = new IRCChannel("irc.example.org", "strada", ["#general"], [], true);

    expect((channel as any).isAllowedInboundUser("alice")).toBe(true);
  });

  it("restricts inbound users to the configured allowlist", () => {
    const channel = new IRCChannel("irc.example.org", "strada", ["#general"], ["alice", "bob"]);

    expect((channel as any).isAllowedInboundUser("alice")).toBe(true);
    expect((channel as any).isAllowedInboundUser("mallory")).toBe(false);
  });

  // IRC nicks are case-insensitive (RFC 2812); the allowlist must match
  // regardless of the case the server reports the nick in.
  it("matches the allowlist case-insensitively", () => {
    const channel = new IRCChannel("irc.example.org", "strada", ["#general"], ["Alice", "BOB"]);

    expect((channel as any).isAllowedInboundUser("alice")).toBe(true);
    expect((channel as any).isAllowedInboundUser("ALICE")).toBe(true);
    expect((channel as any).isAllowedInboundUser("bob")).toBe(true);
    expect((channel as any).isAllowedInboundUser("Bob")).toBe(true);
    expect((channel as any).isAllowedInboundUser("mallory")).toBe(false);
  });

  describe("health state", () => {
    afterEach(() => {
      vi.doUnmock("irc");
      vi.resetModules();
    });

    it("marks unhealthy on error/netError/abort and recovers on re-registration", async () => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const fakeClient = {
        addListener: (event: string, handler: (...args: unknown[]) => void) => {
          listeners.set(event, handler);
        },
        say: vi.fn(),
        disconnect: (_msg: string, cb: () => void) => cb(),
      };
      // Plain function (not arrow) so `new irc.Client(...)` returns fakeClient.
      function MockClient(): unknown {
        return fakeClient;
      }
      vi.doMock("irc", () => ({ Client: MockClient }));

      const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);
      await channel.connect();

      // Not registered yet → unhealthy.
      expect(channel.isHealthy()).toBe(false);

      listeners.get("registered")?.();
      expect(channel.isHealthy()).toBe(true);

      // A server/protocol error drops the link.
      listeners.get("error")?.(new Error("boom"));
      expect(channel.isHealthy()).toBe(false);

      // Reconnect re-emits "registered" → self-heals.
      listeners.get("registered")?.();
      expect(channel.isHealthy()).toBe(true);

      // Socket error also drops it.
      listeners.get("netError")?.(new Error("socket reset"));
      expect(channel.isHealthy()).toBe(false);

      listeners.get("registered")?.();
      expect(channel.isHealthy()).toBe(true);

      // Exhausted reconnect retries.
      listeners.get("abort")?.();
      expect(channel.isHealthy()).toBe(false);
    });
  });

  // Regression (H6): long lines must be split across multiple say() calls, not
  // truncated at 450 chars (which silently dropped content).
  describe("sendText long-line splitting", () => {
    function channelWithSay(): { channel: IRCChannel; say: ReturnType<typeof vi.fn> } {
      const say = vi.fn();
      const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);
      (channel as unknown as { client: { say: typeof say } }).client = { say };
      // sendText now gates on a live link; simulate a registered connection.
      (channel as unknown as { healthy: boolean }).healthy = true;
      return { channel, say };
    }

    it("splits an oversize line into multiple chunks and delivers it in full", async () => {
      const { channel, say } = channelWithSay();
      const long = "abcdefghij".repeat(120); // 1200 chars on one logical line

      await channel.sendText("#general", long);

      expect(say.mock.calls.length).toBeGreaterThan(1);
      for (const call of say.mock.calls) {
        expect(Buffer.byteLength(call[1] as string, "utf8")).toBeLessThanOrEqual(400);
      }
      expect(say.mock.calls.map((c) => c[1] as string).join("")).toBe(long);
    });

    it("never splits a multi-byte code point across chunks", async () => {
      const { channel, say } = channelWithSay();
      const long = "🚀".repeat(300); // 4 bytes each = 1200 bytes

      await channel.sendText("#general", long);

      for (const call of say.mock.calls) {
        expect(Buffer.byteLength(call[1] as string, "utf8")).toBeLessThanOrEqual(400);
      }
      // Intact reassembly proves no surrogate pair was broken mid-chunk.
      expect(say.mock.calls.map((c) => c[1] as string).join("")).toBe(long);
    });
  });

  // Outbound sends must not silently no-op when the link is down: node-irc's
  // say() drops the write without throwing, so sendText surfaces the failure.
  describe("sendText delivery guarantee", () => {
    it("rejects when there is no client", async () => {
      const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);
      await expect(channel.sendText("#general", "hi")).rejects.toThrow(/IRC link down/);
    });

    it("rejects when the link is not healthy", async () => {
      const say = vi.fn();
      const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);
      (channel as unknown as { client: { say: typeof say } }).client = { say };
      (channel as unknown as { healthy: boolean }).healthy = false;

      await expect(channel.sendText("#general", "hi")).rejects.toThrow(/IRC link down/);
      expect(say).not.toHaveBeenCalled();
    });
  });

  // Inbound routing: DM and mention detection are case-insensitive (IRC nicks
  // are case-insensitive per RFC 2812), and mentions accept ':'/','/' ' prefixes.
  describe("inbound message routing", () => {
    afterEach(() => {
      vi.doUnmock("irc");
      vi.resetModules();
    });

    async function connectWithFake(allowed: string[]): Promise<{
      emit: (from: string, to: string, text: string) => void;
      received: import("../channel-messages.interface.js").IncomingMessage[];
    }> {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const fakeClient = {
        addListener: (event: string, handler: (...args: unknown[]) => void) => {
          listeners.set(event, handler);
        },
        say: vi.fn(),
        disconnect: (_msg: string, cb: () => void) => cb(),
      };
      function MockClient(): unknown {
        return fakeClient;
      }
      vi.doMock("irc", () => ({ Client: MockClient }));

      const channel = new IRCChannel(
        "irc.example.org",
        "Strada",
        ["#general"],
        allowed,
        allowed.length === 0,
      );
      const received: import("../channel-messages.interface.js").IncomingMessage[] = [];
      channel.onMessage(async (m) => {
        received.push(m);
      });
      await channel.connect();
      listeners.get("registered")?.();
      return {
        emit: (from, to, text) => listeners.get("message")?.(from, to, text),
        received,
      };
    }

    it("treats a PM as a DM even when the nick case differs", async () => {
      const { emit, received } = await connectWithFake([]);
      // Server echoes the bot nick lowercased; still our DM.
      emit("alice", "strada", "hello there");
      await Promise.resolve();
      expect(received).toHaveLength(1);
      expect(received[0].text).toBe("hello there");
      expect(received[0].chatId).toBe("alice");
    });

    it("recognises case-insensitive mention prefixes with :/,/space separators", async () => {
      const { emit, received } = await connectWithFake([]);
      emit("alice", "#general", "strada: colon form");
      emit("bob", "#general", "STRADA, comma form");
      emit("carol", "#general", "Strada space form");
      await Promise.resolve();
      expect(received.map((m) => m.text)).toEqual([
        "colon form",
        "comma form",
        "space form",
      ]);
      // Channel mentions route to the channel as chatId.
      expect(received[0].chatId).toBe("#general");
    });

    it("ignores channel messages that do not address the bot", async () => {
      const { emit, received } = await connectWithFake([]);
      emit("alice", "#general", "just chatting");
      await Promise.resolve();
      expect(received).toHaveLength(0);
    });

    it("enforces the allowlist case-insensitively on inbound DMs", async () => {
      const { emit, received } = await connectWithFake(["Alice"]);
      emit("ALICE", "strada", "allowed");
      emit("mallory", "strada", "blocked");
      await Promise.resolve();
      expect(received).toHaveLength(1);
      expect(received[0].userId).toBe("ALICE");
    });
  });

  // requestConfirmation is a text flow on IRC: send question + numbered options,
  // correlate the next inbound reply from the same nick/chatId to resolve.
  describe("requestConfirmation text flow", () => {
    afterEach(() => {
      vi.doUnmock("irc");
      vi.resetModules();
    });

    async function connectWithFake(): Promise<{
      channel: IRCChannel;
      emit: (from: string, to: string, text: string) => void;
      say: ReturnType<typeof vi.fn>;
    }> {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const say = vi.fn();
      const fakeClient = {
        addListener: (event: string, handler: (...args: unknown[]) => void) => {
          listeners.set(event, handler);
        },
        say,
        disconnect: (_msg: string, cb: () => void) => cb(),
        removeAllListeners: vi.fn(),
      };
      function MockClient(): unknown {
        return fakeClient;
      }
      vi.doMock("irc", () => ({ Client: MockClient }));

      const channel = new IRCChannel("irc.example.org", "Strada", ["#general"], [], true);
      await channel.connect();
      listeners.get("registered")?.();
      return {
        channel,
        emit: (from, to, text) => listeners.get("message")?.(from, to, text),
        say,
      };
    }

    it("sends the question + numbered options and resolves with the picked number", async () => {
      const { channel, emit, say } = await connectWithFake();
      const pending = channel.requestConfirmation({
        chatId: "alice",
        userId: "alice",
        question: "Proceed?",
        options: ["Yes", "No"],
      });
      await Promise.resolve();

      // Question and both numbered options were sent.
      const sent = say.mock.calls.map((c) => c[1] as string);
      expect(sent).toContain("Proceed?");
      expect(sent).toContain("1) Yes");
      expect(sent).toContain("2) No");

      // Reply with the option number resolves to the option text.
      emit("alice", "strada", "2");
      await expect(pending).resolves.toBe("No");
    });

    it("accepts the literal option text case-insensitively", async () => {
      const { channel, emit } = await connectWithFake();
      const pending = channel.requestConfirmation({
        chatId: "alice",
        userId: "alice",
        question: "Proceed?",
        options: ["Yes", "No"],
      });
      await Promise.resolve();

      emit("alice", "strada", "yes");
      await expect(pending).resolves.toBe("Yes");
    });

    it("correlates the reply by nick case-insensitively and ignores other nicks", async () => {
      const { channel, emit, say } = await connectWithFake();
      const received: import("../channel-messages.interface.js").IncomingMessage[] = [];
      channel.onMessage(async (m) => {
        received.push(m);
      });
      const pending = channel.requestConfirmation({
        chatId: "alice",
        userId: "alice",
        question: "Proceed?",
        options: ["Yes", "No"],
      });
      await Promise.resolve();
      say.mockClear();

      // A different nick must NOT resolve the confirmation; it routes normally.
      emit("bob", "strada", "1");
      await Promise.resolve();
      expect(received).toHaveLength(1);
      expect(received[0].userId).toBe("bob");

      // The original nick (different case) resolves it and is consumed (not routed).
      emit("ALICE", "strada", "Yes");
      await expect(pending).resolves.toBe("Yes");
      expect(received).toHaveLength(1);
    });

    it("resolves 'timeout' on an unrecognised reply", async () => {
      const { channel, emit } = await connectWithFake();
      const pending = channel.requestConfirmation({
        chatId: "alice",
        userId: "alice",
        question: "Proceed?",
        options: ["Yes", "No"],
      });
      await Promise.resolve();

      emit("alice", "strada", "maybe");
      await expect(pending).resolves.toBe("timeout");
    });

    it("resolves 'timeout' when the no-reply timer fires", async () => {
      vi.useFakeTimers();
      try {
        const { channel } = await connectWithFake();
        const pending = channel.requestConfirmation({
          chatId: "alice",
          userId: "alice",
          question: "Proceed?",
          options: ["Yes", "No"],
        });
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toBe("timeout");
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns 'timeout' immediately when the link is down", async () => {
      const channel = new IRCChannel("irc.example.org", "Strada", ["#general"]);
      // No client / not healthy: cannot ask.
      await expect(
        channel.requestConfirmation({
          chatId: "alice",
          question: "Proceed?",
          options: ["Yes", "No"],
        }),
      ).resolves.toBe("timeout");
    });

    it("resolves an open confirmation as 'timeout' on disconnect", async () => {
      const { channel } = await connectWithFake();
      const pending = channel.requestConfirmation({
        chatId: "alice",
        userId: "alice",
        question: "Proceed?",
        options: ["Yes", "No"],
      });
      await Promise.resolve();
      await channel.disconnect();
      await expect(pending).resolves.toBe("timeout");
    });
  });

  // Capability honesty: sendTypingIndicator is a no-op (IRC has no typing
  // notification) but must exist so supportsRichMessaging() reports truthfully.
  describe("rich-messaging capability", () => {
    it("exposes a no-op sendTypingIndicator that does not throw", async () => {
      const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);
      await expect(channel.sendTypingIndicator("#general")).resolves.toBeUndefined();
    });
  });

  // Regression: blank lines were silently dropped, collapsing paragraph breaks.
  // sendText now emits a single space for whitespace-only lines.
  describe("sendText paragraph-break preservation", () => {
    function channelWithSay(): { channel: IRCChannel; say: ReturnType<typeof vi.fn> } {
      const say = vi.fn();
      const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);
      (channel as unknown as { client: { say: typeof say } }).client = { say };
      (channel as unknown as { healthy: boolean }).healthy = true;
      return { channel, say };
    }

    it("emits a single space for blank lines instead of dropping them", async () => {
      const { channel, say } = channelWithSay();
      await channel.sendText("#general", "para one\n\npara two");

      const sent = say.mock.calls.map((c) => c[1] as string);
      expect(sent).toEqual(["para one", " ", "para two"]);
    });
  });
});
