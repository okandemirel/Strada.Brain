import { describe, it, expect, beforeEach, vi } from "vitest";
import { ThreadChannel } from "discord.js";
import { DiscordChannel } from "./bot.js";
import { AuthManager } from "../../security/auth.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock media-processor — bypass security validation in channel-level tests
vi.mock("../../utils/media-processor.js", () => ({
  validateMediaAttachment: () => ({ valid: true }),
  validateMagicBytes: () => true,
  mimeToAttachmentType: (mime: string | undefined | null) => {
    if (!mime) return "document";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  },
}));

// Mock discord.js
vi.mock("discord.js", async () => {
  const actual = await vi.importActual("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(function () {
      return {
        login: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn().mockReturnValue(true),
        user: { tag: "TestBot#1234", id: "123456789" },
        ws: { ping: 50 },
        on: vi.fn(),
        once: vi.fn(),
        channels: {
          fetch: vi.fn().mockResolvedValue({
            isTextBased: () => true,
            send: vi.fn().mockResolvedValue({ id: "msg123", edit: vi.fn() }),
            sendTyping: vi.fn(),
            threads: {
              create: vi.fn().mockResolvedValue({ id: "thread123" }),
            },
          }),
        },
      };
    }),
  };
});

// Mock logger
vi.mock("../../utils/logger.js", () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("DiscordChannel", () => {
  let channel: DiscordChannel;
  let auth: AuthManager;

  beforeEach(() => {
    auth = new AuthManager([], {
      allowedUserIds: new Set(["allowed123"]),
      allowedRoleIds: new Set(["role123"]),
    });
    channel = new DiscordChannel("fake-token", auth, {
      guildId: "guild123",
    });
  });

  describe("constructor", () => {
    it("should create instance with required params", () => {
      expect(channel).toBeDefined();
      expect(channel.name).toBe("discord");
    });

    it("should create instance with slash commands", () => {
      const withCommands = new DiscordChannel("fake-token", auth, {
        guildId: "guild123",
        slashCommands: [],
      });
      expect(withCommands).toBeDefined();
    });
  });

  describe("connect", () => {
    it("should connect and set isConnected", async () => {
      await channel.connect();
      expect(channel.isHealthy()).toBe(true);
    });
  });

  describe("disconnect", () => {
    it("should disconnect and set isConnected to false", async () => {
      await channel.connect();
      await channel.disconnect();
      expect(channel.isHealthy()).toBe(false);
    });

    // Regression (H7): a message still in the queue when the processor stops
    // must be rejected, or its awaiting caller hangs forever.
    it("rejects queued messages on disconnect", async () => {
      const pending = (channel as unknown as {
        enqueueMessage: (m: { type: string; chatId: string; content: string }) => Promise<unknown>;
      }).enqueueMessage({ type: "text", chatId: "c1", content: "hi" });

      await channel.disconnect();

      await expect(pending).rejects.toThrow("Discord channel disconnected");
      expect((channel as unknown as { messageQueue: unknown[] }).messageQueue).toHaveLength(0);
    });

    // Regression (M6): a retry-backoff timer pending at disconnect must be
    // cleared and its message rejected — not left to re-push onto a dead queue.
    it("rejects retry-pending messages and clears their timers on disconnect", async () => {
      const reject = vi.fn();
      let firedOntoDeadQueue = false;
      const timer = setTimeout(() => {
        firedOntoDeadQueue = true;
      }, 10_000);
      (channel as unknown as {
        retryTimers: Map<ReturnType<typeof setTimeout>, { reject: (e: Error) => void }>;
      }).retryTimers.set(timer, { reject });

      await channel.disconnect();

      expect(reject).toHaveBeenCalledTimes(1);
      expect(reject.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect((channel as unknown as { retryTimers: Map<unknown, unknown> }).retryTimers.size).toBe(0);
      await new Promise((r) => setTimeout(r, 30));
      expect(firedOntoDeadQueue).toBe(false);
    });
  });

  describe("sendText", () => {
    it("should send text message", async () => {
      await channel.connect();
      await expect(
        channel.sendText("channel123", "Hello World")
      ).resolves.not.toThrow();
    });
  });

  describe("long message splitting", () => {
    // Regression (HIGH/message-length): long messages must be split into chunks
    // and every chunk sent, not truncated to 2000 chars (which dropped content).
    it("splits a >2000-char text message into multiple chunks instead of truncating", async () => {
      await channel.connect();

      const client = channel.getClient();
      const channelObj = await client.channels.fetch("channel123");
      const sendMock = (channelObj as unknown as { send: ReturnType<typeof vi.fn> }).send;
      sendMock.mockClear();

      // 5000 single-line chars (no newlines) forces hard word/length splitting.
      const long = "x".repeat(5000);
      await channel.sendText("channel123", long);

      expect(sendMock.mock.calls.length).toBeGreaterThan(1);

      let total = 0;
      for (const call of sendMock.mock.calls) {
        const sent = call[0] as string;
        expect(typeof sent).toBe("string");
        expect(sent.length).toBeLessThanOrEqual(2000);
        total += sent.length;
      }
      // No content dropped: the concatenated chunks reconstruct the full input.
      expect(total).toBe(long.length);
    });
  });

  describe("sendMarkdown", () => {
    it("should send markdown message", async () => {
      await channel.connect();
      await expect(
        channel.sendMarkdown("channel123", "**Bold** text")
      ).resolves.not.toThrow();
    });
  });

  describe("sendRichEmbed", () => {
    it("should send rich embed", async () => {
      await channel.connect();
      await expect(
        channel.sendRichEmbed("channel123", {
          title: "Test Embed",
          description: "Test Description",
          color: 0xff0000,
          fields: [{ name: "Field", value: "Value", inline: true }],
        })
      ).resolves.not.toThrow();
    });
  });

  describe("sendTypingIndicator", () => {
    it("should send typing indicator", async () => {
      await channel.connect();
      await expect(
        channel.sendTypingIndicator("channel123")
      ).resolves.not.toThrow();
    });
  });

  describe("requestConfirmation", () => {
    it("should send confirmation request", async () => {
      await channel.connect();
      
      // This will timeout since we're not mocking the interaction
      const promise = channel.requestConfirmation({
        chatId: "channel123",
        question: "Confirm?",
        options: ["Yes", "No"],
        details: "Additional details",
      });
      
      // Should not throw immediately
      expect(promise).toBeInstanceOf(Promise);
    });

    it("binds confirmation buttons to the original requester when userId is provided", async () => {
      const permissiveAuth = new AuthManager([], {
        allowedDiscordIds: new Set(["allowed123", "allowed456"]),
        allowedDiscordRoles: new Set<string>(),
      });
      const boundChannel = new DiscordChannel("fake-token", permissiveAuth, {
        guildId: "guild123",
      });

      await boundChannel.connect();

      // requestConfirmation now decouples the long-lived response promise from
      // the send queue: the pending confirmation is registered immediately and
      // only the embed+buttons are dispatched through the queue.
      const promise = boundChannel.requestConfirmation({
        chatId: "channel123",
        userId: "allowed123",
        question: "Confirm?",
        options: ["Yes", "No"],
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(
        (boundChannel as unknown as {
          pendingConfirmations: Map<string, unknown>;
        }).pendingConfirmations.size,
      ).toBe(1);

      const [confirmId] = Array.from(
        (boundChannel as unknown as {
          pendingConfirmations: Map<string, unknown>;
        }).pendingConfirmations.keys(),
      );

      const interaction = {
        user: { id: "allowed456" },
        channelId: "channel123",
        customId: `${confirmId}:Yes`,
        reply: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (boundChannel as unknown as {
        handleButtonInteraction: (interaction: unknown) => Promise<void>;
      }).handleButtonInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "Only the original requester can respond to this confirmation.",
        ephemeral: true,
      });
      expect(
        (boundChannel as unknown as {
          pendingConfirmations: Map<string, unknown>;
        }).pendingConfirmations.has(confirmId!),
      ).toBe(true);

      await boundChannel.disconnect();
      await expect(promise).resolves.toBe("cancelled");
    });
  });

  describe("streaming messages", () => {
    it("should start streaming message", async () => {
      await channel.connect();
      const streamId = await channel.startStreamingMessage("channel123");
      expect(streamId).toBeDefined();
    });

    it("should update streaming message", async () => {
      await channel.connect();
      const streamId = await channel.startStreamingMessage("channel123");
      if (streamId) {
        await expect(
          channel.updateStreamingMessage("channel123", streamId, "Updated text")
        ).resolves.not.toThrow();
      }
    });

    it("should finalize streaming message", async () => {
      await channel.connect();
      const streamId = await channel.startStreamingMessage("channel123");
      if (streamId) {
        await expect(
          channel.finalizeStreamingMessage("channel123", streamId, "Final text")
        ).resolves.not.toThrow();
      }
    });
  });

  describe("thread operations", () => {
    it("should create thread", async () => {
      await channel.connect();
      const threadId = await channel.createThread("channel123", "Test Thread");
      expect(threadId).toBe("thread123");
    });

    it("should create thread with options", async () => {
      await channel.connect();
      const threadId = await channel.createThread("channel123", "Test Thread", {
        autoArchiveDuration: 1440,
        reason: "Test reason",
      });
      expect(threadId).toBeDefined();
    });

    // sendInThread() rejects anything that is not a ThreadChannel instance, so
    // these resolve the thread id to a ThreadChannel-prototyped mock (real
    // ThreadChannel from the partially-mocked discord.js) just for this test.
    function stubThreadFetch(): { send: ReturnType<typeof vi.fn> } {
      const thread = Object.assign(Object.create(ThreadChannel.prototype) as object, {
        id: "thread123",
        send: vi.fn().mockResolvedValue({ id: "threadmsg123" }),
      }) as { send: ReturnType<typeof vi.fn> };
      (channel as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);
      return thread;
    }

    it("should send in thread", async () => {
      await channel.connect();
      const thread = stubThreadFetch();
      await expect(
        channel.sendInThread("thread123", "Thread message")
      ).resolves.not.toThrow();
      expect(thread.send).toHaveBeenCalledWith("Thread message");
    });

    it("should send markdown in thread", async () => {
      await channel.connect();
      const thread = stubThreadFetch();
      await expect(
        channel.sendInThread("thread123", "**Bold**", { markdown: true })
      ).resolves.not.toThrow();
      expect(thread.send).toHaveBeenCalled();
    });
  });

  describe("onMessage", () => {
    it("should set message handler", () => {
      const handler = vi.fn();
      channel.onMessage(handler);
      // Handler is set internally, just verify it doesn't throw
      expect(() => channel.onMessage(handler)).not.toThrow();
    });
  });

  describe("getClient", () => {
    it("should return the Discord client", () => {
      const client = channel.getClient();
      expect(client).toBeDefined();
    });
  });
});

describe("DiscordChannel attachment extraction", () => {
  let channel: DiscordChannel;
  let auth: AuthManager;
  let messageCreateHandler: (message: Record<string, unknown>) => Promise<void>;

  beforeEach(() => {
    auth = new AuthManager([], {
      allowedDiscordIds: new Set(["allowed123"]),
      allowedDiscordRoles: new Set(),
    });

    // Create channel — capture the MessageCreate handler
    channel = new DiscordChannel("fake-token", auth, {
      guildId: "guild123",
    });

    const client = channel.getClient();
    const onCalls = (client.on as ReturnType<typeof vi.fn>).mock.calls;
    const mcEntry = onCalls.find(
      (c: unknown[]) => c[0] === "messageCreate"
    );
    messageCreateHandler = mcEntry![1] as (message: Record<string, unknown>) => Promise<void>;
  });

  function makeMessage(overrides: Record<string, unknown> = {}) {
    return {
      author: { bot: false, id: "allowed123" },
      channelId: "ch1",
      content: "hello",
      reference: null,
      createdAt: new Date(),
      attachments: new Map(),
      channel: { isTextBased: () => true, sendTyping: vi.fn() },
      reply: vi.fn(),
      ...overrides,
    };
  }

  it("should pass attachments=undefined when message has no attachments", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    await messageCreateHandler(makeMessage());

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0];
    expect(msg.attachments).toBeUndefined();
  });

  it("should authorize regular messages via allowed Discord role IDs", async () => {
    const roleBasedAuth = new AuthManager([], {
      allowedDiscordIds: new Set(),
      allowedDiscordRoles: new Set(["role123"]),
    });
    const roleBasedChannel = new DiscordChannel("fake-token", roleBasedAuth, {
      guildId: "guild123",
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    roleBasedChannel.onMessage(handler);

    const client = roleBasedChannel.getClient();
    const onCalls = (client.on as ReturnType<typeof vi.fn>).mock.calls;
    const mcEntry = onCalls.find(
      (c: unknown[]) => c[0] === "messageCreate"
    );
    const roleMessageCreateHandler = mcEntry![1] as (message: Record<string, unknown>) => Promise<void>;

    await roleMessageCreateHandler(
      makeMessage({
        author: { bot: false, id: "unlisted-user" },
        member: {
          roles: {
            cache: new Map([["role123", { id: "role123" }]]),
          },
        },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should extract image attachment", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    const attachments = new Map([
      ["1", {
        name: "photo.png",
        url: "https://cdn.discord.com/photo.png",
        contentType: "image/png",
        size: 12345,
      }],
    ]);

    await messageCreateHandler(makeMessage({ attachments }));

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0];
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toEqual({
      type: "image",
      name: "photo.png",
      url: "https://cdn.discord.com/photo.png",
      mimeType: "image/png",
      size: 12345,
    });
  });

  it("should extract video attachment", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    const attachments = new Map([
      ["1", {
        name: "clip.mp4",
        url: "https://cdn.discord.com/clip.mp4",
        contentType: "video/mp4",
        size: 999999,
      }],
    ]);

    await messageCreateHandler(makeMessage({ attachments }));

    const msg = handler.mock.calls[0][0];
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].type).toBe("video");
  });

  it("should extract audio attachment", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    const attachments = new Map([
      ["1", {
        name: "voice.ogg",
        url: "https://cdn.discord.com/voice.ogg",
        contentType: "audio/ogg",
        size: 5000,
      }],
    ]);

    await messageCreateHandler(makeMessage({ attachments }));

    const msg = handler.mock.calls[0][0];
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].type).toBe("audio");
  });

  it("should default to document type for unknown content types", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    const attachments = new Map([
      ["1", {
        name: "data.zip",
        url: "https://cdn.discord.com/data.zip",
        contentType: "application/zip",
        size: 50000,
      }],
    ]);

    await messageCreateHandler(makeMessage({ attachments }));

    const msg = handler.mock.calls[0][0];
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].type).toBe("document");
  });

  it("should handle null contentType as document", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    const attachments = new Map([
      ["1", {
        name: null,
        url: "https://cdn.discord.com/unknown",
        contentType: null,
        size: 100,
      }],
    ]);

    await messageCreateHandler(makeMessage({ attachments }));

    const msg = handler.mock.calls[0][0];
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toEqual({
      type: "document",
      name: "attachment",
      url: "https://cdn.discord.com/unknown",
      mimeType: undefined,
      size: 100,
    });
  });

  it("should extract multiple attachments of mixed types", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    const attachments = new Map([
      ["1", {
        name: "photo.jpg",
        url: "https://cdn.discord.com/photo.jpg",
        contentType: "image/jpeg",
        size: 1000,
      }],
      ["2", {
        name: "readme.txt",
        url: "https://cdn.discord.com/readme.txt",
        contentType: "text/plain",
        size: 200,
      }],
      ["3", {
        name: "song.mp3",
        url: "https://cdn.discord.com/song.mp3",
        contentType: "audio/mpeg",
        size: 3000,
      }],
    ]);

    await messageCreateHandler(makeMessage({ attachments }));

    const msg = handler.mock.calls[0][0];
    expect(msg.attachments).toHaveLength(3);
    expect(msg.attachments[0].type).toBe("image");
    expect(msg.attachments[1].type).toBe("document");
    expect(msg.attachments[2].type).toBe("audio");
  });
});

describe("DiscordChannel with auth checks", () => {
  it("should check user authorization", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["user123"]),
      allowedDiscordRoles: new Set(),
    });
    
    expect(auth.isDiscordUserAllowed("user123")).toBe(true);
    expect(auth.isDiscordUserAllowed("user456")).toBe(false);
  });

  it("should check role authorization", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(),
      allowedDiscordRoles: new Set(["admin"]),
    });
    
    expect(auth.isDiscordUserAllowed("any", ["admin", "user"])).toBe(true);
    expect(auth.isDiscordUserAllowed("any", ["user"])).toBe(false);
  });

  it("should allow if user ID matches regardless of roles", () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["special"]),
      allowedDiscordRoles: new Set(["admin"]),
    });
    
    expect(auth.isDiscordUserAllowed("special", ["user"])).toBe(true);
  });

  it("authorizes slash commands via Discord role IDs carried on the interaction member", async () => {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(),
      allowedDiscordRoles: new Set(["role123"]),
    });
    const channel = new DiscordChannel("fake-token", auth, {
      guildId: "guild123",
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    const interaction = {
      user: { id: "unlisted-user" },
      member: { roles: ["role123"] },
      commandName: "ask",
      channelId: "channel123",
      options: {
        getString: vi.fn().mockReturnValue("Role gated question"),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await (channel as unknown as {
      handleSlashCommand: (interaction: unknown) => Promise<void>;
    }).handleSlashCommand(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      chatId: "channel123",
      userId: "unlisted-user",
      text: "Role gated question",
    });
  });
});

// ---------------------------------------------------------------------------
// Characterization tests: verify queue behaviour preserved after any refactor.
// These tests create their own DiscordChannel instances so they are independent
// of the outer beforeEach that runs before each test in the parent describe.
// They use enqueueMessage() (a semi-private method) rather than direct array
// manipulation so they remain valid after the MessageQueue delegation refactor.
// ---------------------------------------------------------------------------
describe("DiscordChannel queue behaviour (characterization)", () => {
  function makeChannel(): DiscordChannel {
    const auth = new AuthManager([], {
      allowedDiscordIds: new Set(["u1"]),
      allowedDiscordRoles: new Set<string>(),
    });
    return new DiscordChannel("fake-token", auth);
  }

  type InternalChannel = {
    enqueueMessage: (m: { type: string; chatId: string; content?: string }) => Promise<unknown>;
    processMessageQueue: () => Promise<void>;
    processQueuedMessage: (m: unknown) => Promise<unknown>;
    messageQueue: unknown[];
    retryTimers: Map<unknown, unknown>;
  };

  it("FIFO: processQueuedMessage is called in enqueue order", async () => {
    const ch = makeChannel();
    const internal = ch as unknown as InternalChannel;
    const order: string[] = [];

    // Stub processQueuedMessage to record the chatId of each call and resolve
    // the message's own promise (required in the pre-delegation code path).
    internal.processQueuedMessage = async (m: unknown) => {
      const msg = m as { chatId: string; resolve?: (v: unknown) => void };
      order.push(msg.chatId);
      // In the pre-delegation layout, msg.resolve settles the enqueue promise.
      // In the post-delegation layout, MessageQueue settles it via entry.resolve.
      if (typeof msg.resolve === "function") msg.resolve(undefined);
      return undefined;
    };

    // Suppress unhandled rejections — these promises settle via the stub above.
    const pA = internal.enqueueMessage({ type: "text", chatId: "A", content: "a" });
    const pB = internal.enqueueMessage({ type: "text", chatId: "B", content: "b" });
    const pC = internal.enqueueMessage({ type: "text", chatId: "C", content: "c" });
    pA.catch(() => {});
    pB.catch(() => {});
    pC.catch(() => {});

    await internal.processMessageQueue();

    expect(order).toEqual(["A", "B", "C"]);
    expect(internal.messageQueue).toHaveLength(0);
  });

  it("timeout eviction: enqueued items are rejected when they exceed MESSAGE_TIMEOUT_MS", async () => {
    const ch = makeChannel();
    const internal = ch as unknown as InternalChannel;

    const p = internal.enqueueMessage({ type: "text", chatId: "ch1", content: "stale" });

    // Backdate the enqueuedAt timestamp by more than the 30 s timeout.
    // The queue exposes the backing array via the messageQueue accessor; we update
    // whatever field holds the timestamp regardless of the exact wrapper shape.
    const arr = internal.messageQueue as Array<Record<string, unknown>>;
    const entry = arr[0]!;
    // Support both the pre-refactor flat layout and the post-refactor QueueEntry layout.
    if ("enqueuedAt" in entry) {
      entry["enqueuedAt"] = Date.now() - 31_000;
    }

    await internal.processMessageQueue();

    await expect(p).rejects.toThrow(/timed out/i);
    expect(internal.messageQueue).toHaveLength(0);
  });

  it("disconnect-reject: pending enqueued item is rejected on disconnect", async () => {
    const ch = makeChannel();
    const internal = ch as unknown as InternalChannel;

    const pending = internal.enqueueMessage({ type: "text", chatId: "c1", content: "hi" });

    await ch.disconnect();

    await expect(pending).rejects.toThrow("Discord channel disconnected");
    expect(internal.messageQueue).toHaveLength(0);
  });

  it("retry counter: after a transient failure the item moves to a retry timer", async () => {
    const ch = makeChannel();
    const internal = ch as unknown as InternalChannel;

    // Make processQueuedMessage always fail.
    internal.processQueuedMessage = vi.fn().mockRejectedValue(new Error("transient"));

    const p = internal.enqueueMessage({ type: "text", chatId: "ch1", content: "x" });
    // Suppress unhandled rejection — will be settled after retries exhaust.
    p.catch(() => {});

    await internal.processMessageQueue();

    // After first failure: item removed from queue and a retry timer is set.
    expect(internal.messageQueue).toHaveLength(0);
    expect(internal.retryTimers.size).toBe(1);
  });
});
