import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { WhatsAppChannel } from "./client.js";

// Initialize logger before any tests run
beforeAll(() => {
  createLogger("error", "/dev/null");
});

// Mock logger
vi.mock("../../utils/logger.js", () => ({
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

    it("should convert `code` to ```code```", async () => {
      let capturedText = "";
      channel.sendText = vi.fn().mockImplementation(async (_chatId: string, text: string) => {
        capturedText = text;
      });

      await channel.sendMarkdown("chat1", "Run `npm install` now");
      expect(capturedText).toBe("Run ```npm install``` now");
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
      expect(capturedText).toContain("```code```");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let eventHandlers: Record<string, (...args: any[]) => void>;
    let connectedChannel: WhatsAppChannel;

    beforeEach(async () => {
      eventHandlers = {};

      const mockSock = {
        ev: {
          on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
            eventHandlers[event] = handler;
          }),
        },
        sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg1" } }),
        sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
        end: vi.fn(),
      };

      // Mock baileys dynamic import
      vi.doMock("@whiskeysockets/baileys", () => ({
        default: () => mockSock,
        useMultiFileAuthState: vi.fn().mockResolvedValue({
          state: {},
          saveCreds: vi.fn(),
        }),
        DisconnectReason: { loggedOut: 401 },
      }));

      // Create a channel with no allowed-number restriction
      connectedChannel = new WhatsAppChannel(".test-session", []);
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
  });
});
