import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { WhatsAppChannel } from "./client.js";

// Initialize logger before any tests run
beforeAll(() => {
  createLogger("error", "/dev/null");
});

// Mock logger
vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createLogger: vi.fn(),
}));

// Mock media-processor — bypass security validation in channel-level tests
vi.mock("../../utils/media-processor.js", () => ({
  downloadMedia: vi.fn().mockResolvedValue(null),
  validateMediaAttachment: () => ({ valid: true }),
  validateMagicBytes: () => true,
}));

describe("WhatsAppChannel", () => {
  let channel: WhatsAppChannel;

  beforeEach(() => {
    channel = new WhatsAppChannel(".test-session", ["5511999990000"]);
  });

  afterEach(async () => {
    if (channel) {
      await channel.disconnect();
    }
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe("constructor", () => {
    it("should set channel name to whatsapp", () => {
      expect(channel.name).toBe("whatsapp");
    });

    it("should use default session path when none provided", () => {
      const defaultChannel = new WhatsAppChannel();
      expect(defaultChannel.name).toBe("whatsapp");
    });

    it("should start as not healthy", () => {
      expect(channel.isHealthy()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // isHealthy
  // ---------------------------------------------------------------------------

  describe("isHealthy", () => {
    it("should return false when not connected", () => {
      expect(channel.isHealthy()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // sendText
  // ---------------------------------------------------------------------------

  describe("sendText", () => {
    it("should throw when not connected", async () => {
      await expect(channel.sendText("123@s.whatsapp.net", "hello"))
        .rejects.toThrow("WhatsApp not connected");
    });
  });

  // ---------------------------------------------------------------------------
  // sendMarkdown
  // ---------------------------------------------------------------------------

  describe("sendMarkdown", () => {
    it("should convert **bold** to *bold*", async () => {
      // We need to intercept the sendText call inside sendMarkdown.
      // Monkey-patch sendText to capture the formatted text.
      let capturedText = "";
      const originalSendText = channel.sendText.bind(channel);
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      await channel.sendMarkdown("chat1", "This is **bold** text");
      expect(capturedText).toBe("This is *bold* text");
    });

    it("should leave inline `code` as-is (not force a fenced block)", async () => {
      let capturedText = "";
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      await channel.sendMarkdown("chat1", "Run `npm install` now");
      // Inline single-backtick code must NOT become a ```fenced``` multiline block.
      expect(capturedText).toBe("Run `npm install` now");
    });

    it("should preserve existing fenced code blocks without malformed nesting", async () => {
      let capturedText = "";
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      const fenced = "```\nconst x = 1;\n```";
      await channel.sendMarkdown("chat1", fenced);
      expect(capturedText).toBe(fenced);
    });

    it("should convert # headers to *Header*", async () => {
      let capturedText = "";
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      await channel.sendMarkdown("chat1", "# My Title");
      expect(capturedText).toBe("*My Title*");
    });

    it("should convert ## headers to *Header*", async () => {
      let capturedText = "";
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      await channel.sendMarkdown("chat1", "## Section");
      expect(capturedText).toBe("*Section*");
    });

    it("should handle multiple conversions in one message", async () => {
      let capturedText = "";
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      await channel.sendMarkdown("chat1", "# Title\nThis is **bold** and `code`.");
      expect(capturedText).toContain("*Title*");
      expect(capturedText).toContain("*bold*");
      expect(capturedText).toContain("`code`");
      expect(capturedText).not.toContain("```code```");
    });
  });

  // ---------------------------------------------------------------------------
  // onMessage
  // ---------------------------------------------------------------------------

  describe("onMessage", () => {
    it("should register message handler", () => {
      const handler = vi.fn();
      channel.onMessage(handler);
      // Handler is stored internally; we confirm no error is thrown
      expect(channel).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // requestConfirmation
  // ---------------------------------------------------------------------------

  describe("requestConfirmation", () => {
    it("should format the confirmation message with numbered options", async () => {
      let capturedText = "";
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      // Start the confirmation but don't await the promise resolution
      // (it will resolve on timeout or response)
      const confirmPromise = channel.requestConfirmation({
        chatId: "chat1",
        question: "Deploy to production?",
        options: ["Yes", "No", "Cancel"],
      });

      // Check the message that was sent
      expect(capturedText).toContain("Deploy to production?");
      expect(capturedText).toContain("1. Yes");
      expect(capturedText).toContain("2. No");
      expect(capturedText).toContain("3. Cancel");
      expect(capturedText).toContain("Reply with the number of your choice.");

      // Clean up - let the timeout handle it or disconnect
      confirmPromise.catch(() => {});
    });

    it("should include details when provided", async () => {
      let capturedText = "";
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      const confirmPromise = channel.requestConfirmation({
        chatId: "chat1",
        question: "Run migration?",
        options: ["Yes", "No"],
        details: "This will modify 50 tables.",
      });

      expect(capturedText).toContain("Run migration?");
      expect(capturedText).toContain("This will modify 50 tables.");

      confirmPromise.catch(() => {});
    });

    it("should resolve timeout instead of auto-selecting the first option", async () => {
      vi.useFakeTimers();
      channel.sendText = vi.fn().mockResolvedValue(undefined);

      const confirmPromise = channel.requestConfirmation({
        chatId: "chat1",
        question: "Deploy?",
        options: ["Yes", "No"],
      });

      await vi.advanceTimersByTimeAsync(120_000);
      await expect(confirmPromise).resolves.toBe("timeout");
      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // disconnect
  // ---------------------------------------------------------------------------

  describe("disconnect", () => {
    it("should set healthy to false", async () => {
      await channel.disconnect();
      expect(channel.isHealthy()).toBe(false);
    });

    it("should handle disconnect when never connected", async () => {
      await expect(channel.disconnect()).resolves.not.toThrow();
    });

    it("should clear pending confirmations on disconnect", async () => {
      channel.sendText = vi.fn().mockResolvedValue(undefined);

      const confirmPromise = channel.requestConfirmation({
        chatId: "chat1",
        question: "Confirm?",
        options: ["Yes", "No"],
      });

      await channel.disconnect();

      // The promise should eventually resolve (timeout or cleanup)
      // We verify disconnect itself didn't throw
      expect(channel.isHealthy()).toBe(false);

      confirmPromise.catch(() => {});
    });

    // Regression (H5): a reconnect timer scheduled before shutdown must not
    // resurrect a deliberately disconnected channel.
    it("cancels a pending reconnect timer on disconnect", async () => {
      vi.useFakeTimers();
      try {
        const connectSpy = vi.spyOn(channel, "connect").mockResolvedValue(undefined);
        (channel as unknown as { scheduleReconnect: (d: number) => void }).scheduleReconnect(1000);
        expect((channel as unknown as { reconnectTimer: unknown }).reconnectTimer).not.toBeNull();

        await channel.disconnect();

        expect((channel as unknown as { stopped: boolean }).stopped).toBe(true);
        expect((channel as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
        vi.advanceTimersByTime(5000);
        expect(connectSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not reconnect when stopped even if a scheduled reconnect timer fires", () => {
      vi.useFakeTimers();
      try {
        const connectSpy = vi.spyOn(channel, "connect").mockResolvedValue(undefined);
        (channel as unknown as { scheduleReconnect: (d: number) => void }).scheduleReconnect(1000);
        (channel as unknown as { stopped: boolean }).stopped = true;

        vi.advanceTimersByTime(1000);

        expect(connectSpy).not.toHaveBeenCalled();
        expect((channel as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Allowed numbers filtering
  // ---------------------------------------------------------------------------

  describe("allowed numbers filtering", () => {
    it("should store allowed numbers from constructor", () => {
      const channelWithNumbers = new WhatsAppChannel(".session", [
        "5511999990000",
        "5511888880000",
      ]);
      // Channel is created successfully with allowed numbers
      expect(channelWithNumbers.name).toBe("whatsapp");
    });

    it("should create channel with empty allowed numbers (allow all)", () => {
      const openChannel = new WhatsAppChannel(".session", []);
      expect(openChannel.name).toBe("whatsapp");
    });
  });

  // ---------------------------------------------------------------------------
  // sendTypingIndicator
  // ---------------------------------------------------------------------------

  describe("sendTypingIndicator", () => {
    it("should not throw when not connected", async () => {
      // sendTypingIndicator returns early if no sock
      await expect(channel.sendTypingIndicator("chat1")).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Media attachment detection (via mocked baileys connect)
  // ---------------------------------------------------------------------------

  describe("media attachment detection", () => {
    let eventHandlers: Record<string, (...args: unknown[]) => void>;
    let connectedChannel: WhatsAppChannel;
    let mockSock: {
      ev: { on: ReturnType<typeof vi.fn> };
      sendMessage: ReturnType<typeof vi.fn>;
      sendPresenceUpdate: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };

    beforeEach(async () => {
      eventHandlers = {};

      mockSock = {
        ev: {
          on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
            eventHandlers[event] = handler;
          }),
        },
        sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg1" } }),
        sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
        end: vi.fn(),
      };

      // Mock baileys dynamic import. Includes the JID utilities the allowlist
      // normalization uses so LID/device-suffix handling can be exercised; they
      // mirror Baileys' real behavior closely enough for these tests.
      vi.doMock("@whiskeysockets/baileys", () => ({
        default: () => mockSock,
        useMultiFileAuthState: vi.fn().mockResolvedValue({
          state: {},
          saveCreds: vi.fn(),
        }),
        DisconnectReason: { loggedOut: 401 },
        jidNormalizedUser: (jid: string) => {
          // Collapse '<user>:<device>@<server>' -> '<user>@<server>'.
          const at = jid.indexOf("@");
          if (at === -1) return jid;
          const user = jid.slice(0, at).split(":")[0];
          return `${user}@${jid.slice(at + 1)}`;
        },
        jidDecode: (jid: string) => {
          const at = jid.indexOf("@");
          if (at === -1) return undefined;
          return {
            user: jid.slice(0, at).split(":")[0],
            server: jid.slice(at + 1),
          };
        },
      }));

      // Create a channel with the test sender number allowed
      connectedChannel = new WhatsAppChannel(".test-session", ["chat1", "5511999990000", "5511888880000"]);
      await connectedChannel.connect();

      // Simulate connection open
      if (eventHandlers["connection.update"]) {
        eventHandlers["connection.update"]({ connection: "open" });
      }
    });

    afterEach(async () => {
      await connectedChannel.disconnect();
      vi.doUnmock("@whiskeysockets/baileys");
    });

    it("should detect video message attachment", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", fromMe: false },
            message: {
              videoMessage: {
                url: "https://example.com/video.mp4",
                caption: "Check this out",
                mimetype: "video/mp4",
              },
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      const incoming = handler.mock.calls[0]![0];
      expect(incoming.text).toBe("Check this out");
      expect(incoming.attachments).toHaveLength(1);
      expect(incoming.attachments[0]).toMatchObject({
        type: "video",
        name: "video.mp4",
        mimeType: "video/mp4",
        url: "https://example.com/video.mp4",
      });
    });

    it("should detect audio message attachment", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", fromMe: false },
            message: {
              audioMessage: {
                url: "https://example.com/audio.ogg",
                mimetype: "audio/ogg",
              },
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      const incoming = handler.mock.calls[0]![0];
      expect(incoming.attachments).toHaveLength(1);
      expect(incoming.attachments[0]).toMatchObject({
        type: "audio",
        name: "audio.ogg",
        mimeType: "audio/ogg",
        url: "https://example.com/audio.ogg",
      });
    });

    it("allows inbound messages when no WhatsApp allowlist is configured", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const openChannel = new WhatsAppChannel(".test-session", []);
      await openChannel.connect();
      openChannel.onMessage(handler);

      if (eventHandlers["connection.update"]) {
        eventHandlers["connection.update"]({ connection: "open" });
      }

      const upsert = {
        messages: [
          {
            key: {
              remoteJid: "chat1@s.whatsapp.net",
              participant: "558877665544@s.whatsapp.net",
              fromMe: false,
            },
            message: {
              conversation: "hello from unrestricted sender",
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toMatchObject({
        chatId: "chat1@s.whatsapp.net",
        userId: "558877665544@s.whatsapp.net",
        text: "hello from unrestricted sender",
      });

      await openChannel.disconnect();
    });

    // Regression: a device-suffixed sender JID
    // ('5511999990000:12@s.whatsapp.net') must normalize to the bare number the
    // allowlist is keyed by ('5511999990000') and be authorized.
    it("authorizes a device-suffixed sender JID against a bare-number allowlist", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        type: "notify",
        messages: [
          {
            key: {
              remoteJid: "chat1@s.whatsapp.net",
              participant: "5511999990000:12@s.whatsapp.net",
              id: "dev-suffix-1",
              fromMe: false,
            },
            message: { conversation: "hi from a second device" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toMatchObject({
        text: "hi from a second device",
      });
    });

    // A raw LID-addressed sender ('<lid>@lid') must be authorized when the LID
    // (bare or full) is stored in the allowlist, using Baileys' JID utilities.
    it("authorizes a LID-format sender JID stored in the allowlist", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      // Allowlist keyed by the bare LID local-part.
      const lidChannel = new WhatsAppChannel(".test-session", ["123456789"]);
      await lidChannel.connect();
      lidChannel.onMessage(handler);

      if (eventHandlers["connection.update"]) {
        eventHandlers["connection.update"]({ connection: "open" });
      }

      const upsert = {
        type: "notify",
        messages: [
          {
            key: {
              remoteJid: "chat1@s.whatsapp.net",
              participant: "123456789@lid",
              id: "lid-1",
              fromMe: false,
            },
            message: { conversation: "hello from a lid sender" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toMatchObject({
        text: "hello from a lid sender",
      });

      await lidChannel.disconnect();
    });

    // A verbatim '<lid>@lid' allowlist entry must also match the raw sender JID.
    it("authorizes a sender when the raw LID JID is stored verbatim", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const lidChannel = new WhatsAppChannel(".test-session", ["987654321@lid"]);
      await lidChannel.connect();
      lidChannel.onMessage(handler);

      if (eventHandlers["connection.update"]) {
        eventHandlers["connection.update"]({ connection: "open" });
      }

      const upsert = {
        type: "notify",
        messages: [
          {
            key: {
              remoteJid: "chat1@s.whatsapp.net",
              participant: "987654321@lid",
              id: "lid-verbatim-1",
              fromMe: false,
            },
            message: { conversation: "verbatim lid match" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      await lidChannel.disconnect();
    });

    // A LID-addressed sender NOT in the allowlist must be rejected.
    it("rejects a LID-format sender absent from the allowlist", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      // connectedChannel allows chat1 / 5511999990000 / 5511888880000 only.
      connectedChannel.sendText = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        type: "notify",
        messages: [
          {
            key: {
              remoteJid: "chat1@s.whatsapp.net",
              participant: "555000111@lid",
              id: "lid-denied-1",
              fromMe: false,
            },
            message: { conversation: "unauthorized lid sender" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).not.toHaveBeenCalled();
      expect(connectedChannel.sendText).toHaveBeenCalledWith(
        "chat1@s.whatsapp.net",
        "Unauthorized. Contact the admin.",
      );
    });

    it("should use default mimeType for video without mimetype", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", fromMe: false },
            message: {
              videoMessage: {
                url: "https://example.com/video",
              },
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      const incoming = handler.mock.calls[0]![0];
      expect(incoming.attachments![0].mimeType).toBe("video/mp4");
    });

    it("should use default mimeType for audio without mimetype", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", fromMe: false },
            message: {
              audioMessage: {
                url: "https://example.com/audio",
              },
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      const incoming = handler.mock.calls[0]![0];
      expect(incoming.attachments![0].mimeType).toBe("audio/ogg");
    });

    it("should attempt to download image data when URL is present", async () => {
      const { downloadMedia } = await import("../../utils/media-processor.js");
      const mockDownload = vi.mocked(downloadMedia);
      mockDownload.mockResolvedValueOnce({
        data: Buffer.from("fake-image-data"),
        mimeType: "image/jpeg",
        size: 15,
      });

      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", fromMe: false },
            message: {
              imageMessage: {
                url: "https://example.com/photo.jpg",
                mimetype: "image/jpeg",
              },
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(mockDownload).toHaveBeenCalledWith("https://example.com/photo.jpg");
      expect(handler).toHaveBeenCalledTimes(1);
      const incoming = handler.mock.calls[0]![0];
      expect(incoming.attachments).toHaveLength(1);
      expect(incoming.attachments[0].type).toBe("image");
      expect(incoming.attachments[0].data).toEqual(Buffer.from("fake-image-data"));
    });

    it("should proceed with URL only when image download fails", async () => {
      const { downloadMedia } = await import("../../utils/media-processor.js");
      const mockDownload = vi.mocked(downloadMedia);
      mockDownload.mockRejectedValueOnce(new Error("Network error"));

      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", fromMe: false },
            message: {
              imageMessage: {
                url: "https://example.com/photo.jpg",
                mimetype: "image/jpeg",
              },
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
      const incoming = handler.mock.calls[0]![0];
      expect(incoming.attachments).toHaveLength(1);
      expect(incoming.attachments[0].url).toBe("https://example.com/photo.jpg");
      expect(incoming.attachments[0].data).toBeUndefined();
    });

    it("should keep confirmation pending on invalid numeric reply", async () => {
      vi.useFakeTimers();
      connectedChannel.sendText = vi.fn().mockResolvedValue(undefined);

      let resolved: string | undefined;
      const confirmPromise = connectedChannel.requestConfirmation({
        chatId: "chat1@s.whatsapp.net",
        question: "Confirm?",
        options: ["Yes", "No"],
      });
      void confirmPromise.then((value) => {
        resolved = value;
      });
      await Promise.resolve();

      const upsert = {
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", fromMe: false },
            message: { conversation: "9" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);
      await Promise.resolve();

      expect(resolved).toBeUndefined();
      expect(connectedChannel.sendText).toHaveBeenCalledWith(
        "chat1@s.whatsapp.net",
        "Invalid choice. Reply with a number between 1 and 2.",
      );

      await vi.advanceTimersByTimeAsync(120_000);
      await expect(confirmPromise).resolves.toBe("timeout");
      vi.useRealTimers();
    });

    it("should only accept confirmation replies from the original requester", async () => {
      vi.useFakeTimers();
      connectedChannel.sendText = vi.fn().mockResolvedValue(undefined);

      let resolved: string | undefined;
      const confirmPromise = connectedChannel.requestConfirmation({
        chatId: "chat1@s.whatsapp.net",
        userId: "5511999990000@s.whatsapp.net",
        question: "Confirm?",
        options: ["Yes", "No"],
      });
      void confirmPromise.then((value) => {
        resolved = value;
      });
      await Promise.resolve();

      const upsert = {
        messages: [
          {
            key: {
              remoteJid: "chat1@s.whatsapp.net",
              participant: "5511888880000@s.whatsapp.net",
              fromMe: false,
            },
            message: { conversation: "1" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);
      await Promise.resolve();

      expect(resolved).toBeUndefined();
      expect(connectedChannel.sendText).toHaveBeenCalledWith(
        "chat1@s.whatsapp.net",
        "Only the original requester can respond to this confirmation.",
      );

      await connectedChannel.disconnect();
      await expect(confirmPromise).resolves.toBe("cancelled");
      vi.useRealTimers();
    });

    // Regression: long outbound text must be split into multiple messages
    // (chunked, never truncated/dropped).
    it("splits an oversize outbound message into multiple chunks", async () => {
      mockSock.sendMessage.mockClear();
      // Two lines, each well over the 4096-char cap, so they cannot share a chunk.
      const longLine = "a".repeat(5000);
      await connectedChannel.sendText("chat1@s.whatsapp.net", `${longLine}\n${longLine}`);

      expect(mockSock.sendMessage.mock.calls.length).toBeGreaterThan(1);
      // No single chunk may exceed the cap, and concatenation must lose no content.
      let total = 0;
      for (const call of mockSock.sendMessage.mock.calls) {
        const sent = (call[1] as { text: string }).text;
        expect(sent.length).toBeLessThanOrEqual(4096);
        total += sent.length;
      }
      // 10000 content chars survive (newlines/boundary spaces may be reflowed).
      expect(total).toBeGreaterThanOrEqual(10000);
    });

    it("sends a normal-length message as a single chunk", async () => {
      mockSock.sendMessage.mockClear();
      await connectedChannel.sendText("chat1@s.whatsapp.net", "hello world");
      expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        "chat1@s.whatsapp.net",
        { text: "hello world" },
      );
    });

    // Regression: finalizing a streaming message whose final text exceeds the
    // 4096-char cap must chunk it — edit the placeholder with the first chunk and
    // send the rest as follow-up messages — rather than ship one oversize edit
    // (which the server silently truncates, dropping the tail of long answers).
    it("chunks an oversize streaming finalize across edit + follow-up messages", async () => {
      const streamId = await connectedChannel.startStreamingMessage("chat1@s.whatsapp.net");
      expect(streamId).toBeDefined();
      mockSock.sendMessage.mockClear();

      // Two lines each over the cap, so they cannot share a single chunk.
      const longLine = "a".repeat(5000);
      await connectedChannel.finalizeStreamingMessage(
        "chat1@s.whatsapp.net",
        streamId!,
        `${longLine}\n${longLine}`,
      );

      const calls = mockSock.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      // First call edits the placeholder in-place.
      expect(calls[0]![1]).toMatchObject({ edit: { id: "msg1" } });
      // No chunk may exceed the cap, and concatenation must lose no content.
      let total = 0;
      for (const call of calls) {
        const sent = (call[1] as { text: string }).text;
        expect(sent.length).toBeLessThanOrEqual(4096);
        total += sent.length;
      }
      // Follow-up chunks are plain messages (no edit key) so the tail survives.
      for (const call of calls.slice(1)) {
        expect((call[1] as { edit?: unknown }).edit).toBeUndefined();
      }
      expect(total).toBeGreaterThanOrEqual(10000);
    });

    // Regression: if the placeholder edit lands but a later overflow chunk send fails,
    // the catch must NOT re-send the whole message via sendMarkdown (that would duplicate
    // everything already delivered) — it should only log the dropped tail.
    it("does not re-send the whole message when an overflow chunk fails after the edit landed", async () => {
      const streamId = await connectedChannel.startStreamingMessage("chat1@s.whatsapp.net");
      expect(streamId).toBeDefined();
      mockSock.sendMessage.mockClear();
      // Chunk 0 (the placeholder edit) succeeds; the first overflow chunk send fails.
      mockSock.sendMessage
        .mockResolvedValueOnce({ key: { id: "msg1" } })
        .mockRejectedValueOnce(new Error("socket dropped"));

      const longLine = "a".repeat(5000);
      await connectedChannel.finalizeStreamingMessage(
        "chat1@s.whatsapp.net",
        streamId!,
        `${longLine}\n${longLine}`,
      );

      // Exactly the edit + the one failed overflow attempt. A whole-message sendMarkdown
      // fallback would add >=1 more call, duplicating the already-delivered first chunk.
      expect(mockSock.sendMessage).toHaveBeenCalledTimes(2);
      expect(mockSock.sendMessage.mock.calls[0]![1]).toMatchObject({ edit: { id: "msg1" } });
    });

    // Regression: a duplicate inbound id (e.g. history-sync replay) is routed once.
    it("dedupes inbound messages with a repeated key id", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        type: "notify",
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", id: "dup-1", fromMe: false },
            message: { conversation: "hello once" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);
      // Same id redelivered (history-sync / retransmit) — must be ignored.
      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    // Regression: history-sync 'append' batches must not be re-routed.
    it("ignores 'append' upsert batches (history-sync replays)", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      connectedChannel.onMessage(handler);

      const upsert = {
        type: "append",
        messages: [
          {
            key: { remoteJid: "chat1@s.whatsapp.net", id: "old-1", fromMe: false },
            message: { conversation: "an old offline message" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await eventHandlers["messages.upsert"]!(upsert);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
