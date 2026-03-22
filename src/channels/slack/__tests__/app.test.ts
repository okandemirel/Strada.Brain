import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { createLogger } from "../../../utils/logger.js";
import { SlackChannel } from "../app.js";

// Initialize logger before any tests run
beforeAll(() => {
  createLogger("error", "/dev/null");
});

// Mock logger first (before any imports)
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock commands module (it also uses logger)
vi.mock("../commands.js", () => ({
  registerSlashCommands: vi.fn(),
}));

// Mock @slack/bolt
vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    message: vi.fn(),
    action: vi.fn(),
    event: vi.fn(),
    error: vi.fn(),
    command: vi.fn(),
    client: {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: "U123" }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "1234567890.123456" }),
        postEphemeral: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      views: {
        open: vi.fn().mockResolvedValue({}),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({}),
      },
    },
  })),
  directMention: vi.fn().mockReturnValue("directMention"),
}));

// Mock media-processor — downloadMedia returns data by default; bypass security validation
const mockDownloadMedia = vi.fn().mockResolvedValue({
  data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  mimeType: "image/png",
  size: 4,
});
vi.mock("../../../utils/media-processor.js", () => ({
  downloadMedia: (...args: unknown[]) => mockDownloadMedia(...args),
  mimeToAttachmentType: (mime: string | undefined | null) => {
    if (!mime) return "document";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  },
  validateMediaAttachment: () => ({ valid: true }),
  validateMagicBytes: () => true,
}));

describe("SlackChannel", () => {
  let channel: SlackChannel;
  const mockConfig = {
    botToken: "xoxb-test-token",
    signingSecret: "test-secret",
    appToken: "xapp-test-token",
    socketMode: true,
  };

  beforeEach(() => {
    channel = new SlackChannel(mockConfig);
  });

  afterEach(async () => {
    if (channel) {
      await channel.disconnect();
    }
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create channel with config", () => {
      expect(channel.name).toBe("slack");
    });
  });

  describe("connect", () => {
    it("should connect successfully", async () => {
      await expect(channel.connect()).resolves.not.toThrow();
      expect(channel.isHealthy()).toBe(true);
    });

    it("should handle connection errors", async () => {
      const { App } = await import("@slack/bolt");
      vi.mocked(App).mockImplementationOnce(() => {
        throw new Error("Connection failed");
      });

      const badChannel = new SlackChannel(mockConfig);
      await expect(badChannel.connect()).rejects.toThrow("Connection failed");
    });
  });

  describe("disconnect", () => {
    it("should disconnect cleanly", async () => {
      await channel.connect();
      await expect(channel.disconnect()).resolves.not.toThrow();
      expect(channel.isHealthy()).toBe(false);
    });

    it("should handle disconnect without connection", async () => {
      await expect(channel.disconnect()).resolves.not.toThrow();
    });
  });

  describe("onMessage", () => {
    it("should register message handler", () => {
      const handler = vi.fn();
      channel.onMessage(handler);
      // Handler is stored internally, can't directly test
      expect(channel).toBeDefined();
    });
  });

  describe("sendText", () => {
    it("should throw if not connected", async () => {
      await expect(channel.sendText("C123", "Hello")).rejects.toThrow(
        "Slack client not initialized"
      );
    });

    it("should send text message when connected", async () => {
      await channel.connect();
      await expect(channel.sendText("C123", "Hello")).resolves.not.toThrow();
    });

    it("should truncate long messages", async () => {
      await channel.connect();
      const longText = "x".repeat(50000);
      await expect(channel.sendText("C123", longText)).resolves.not.toThrow();
    });
  });

  describe("sendMarkdown", () => {
    it("should throw if not connected", async () => {
      await expect(channel.sendMarkdown("C123", "**bold**")).rejects.toThrow(
        "Slack client not initialized"
      );
    });

    it("should send markdown message when connected", async () => {
      await channel.connect();
      await expect(channel.sendMarkdown("C123", "**bold**")).resolves.not.toThrow();
    });
  });

  describe("sendBlockMessage", () => {
    it("should throw if not connected", async () => {
      await expect(
        channel.sendBlockMessage("C123", [{ type: "divider" }])
      ).rejects.toThrow("Slack client not initialized");
    });

    it("should send block message when connected", async () => {
      await channel.connect();
      await expect(
        channel.sendBlockMessage("C123", [{ type: "divider" }])
      ).resolves.not.toThrow();
    });
  });

  describe("sendEphemeral", () => {
    it("should throw if not connected", async () => {
      await expect(
        channel.sendEphemeral("C123", "U123", "Private message")
      ).rejects.toThrow("Slack client not initialized");
    });

    it("should send ephemeral message when connected", async () => {
      await channel.connect();
      await expect(
        channel.sendEphemeral("C123", "U123", "Private message")
      ).resolves.not.toThrow();
    });
  });

  describe("sendThreadReply", () => {
    it("should throw if not connected", async () => {
      await expect(
        channel.sendThreadReply("C123", "1234567890.123456", "Reply")
      ).rejects.toThrow("Slack client not initialized");
    });

    it("should send thread reply when connected", async () => {
      await channel.connect();
      await expect(
        channel.sendThreadReply("C123", "1234567890.123456", "Reply")
      ).resolves.not.toThrow();
    });
  });

  describe("sendTypingIndicator", () => {
    it("should send typing indicator", async () => {
      await channel.connect();
      await expect(channel.sendTypingIndicator("C123")).resolves.not.toThrow();
    });
  });

  describe("openModal", () => {
    it("should throw if not connected", async () => {
      await expect(
        channel.openModal("trigger_123", {
          type: "modal",
          callback_id: "test",
          title: { type: "plain_text", text: "Test" },
          blocks: [],
        })
      ).rejects.toThrow("Slack client not initialized");
    });

    it("should open modal when connected", async () => {
      await channel.connect();
      await expect(
        channel.openModal("trigger_123", {
          type: "modal",
          callback_id: "test",
          title: { type: "plain_text", text: "Test" },
          blocks: [],
        })
      ).resolves.not.toThrow();
    });
  });

  describe("uploadFile", () => {
    it("should throw if not connected", async () => {
      const buffer = Buffer.from("test");
      await expect(
        channel.uploadFile("C123", buffer, "test.txt")
      ).rejects.toThrow("Slack client not initialized");
    });

    it("should upload file when connected", async () => {
      await channel.connect();
      const buffer = Buffer.from("test content");
      await expect(
        channel.uploadFile("C123", buffer, "test.txt")
      ).resolves.not.toThrow();
    });
  });

  describe("streaming messages", () => {
    it("should start streaming message", async () => {
      await channel.connect();
      const streamId = await channel.startStreamingMessage("C123");
      expect(typeof streamId).toBe("string");
      expect(streamId).toContain("stream_");
    });

    it("should throw when starting stream if not connected", async () => {
      await expect(channel.startStreamingMessage("C123")).rejects.toThrow(
        "Slack client not initialized"
      );
    });

    it("should update streaming message", async () => {
      await channel.connect();
      const streamId = await channel.startStreamingMessage("C123");
      await expect(
        channel.updateStreamingMessage("C123", streamId, "Updated text")
      ).resolves.not.toThrow();
    });

    it("should finalize streaming message", async () => {
      await channel.connect();
      const streamId = await channel.startStreamingMessage("C123");
      await expect(
        channel.finalizeStreamingMessage("C123", streamId, "Final text")
      ).resolves.not.toThrow();
    });
  });

  describe("requestConfirmation", () => {
    it("should throw if not connected", async () => {
      await expect(
        channel.requestConfirmation({
          chatId: "C123",
          question: "Confirm?",
          options: ["Yes", "No"],
        })
      ).rejects.toThrow("Slack client not initialized");
    });

    it("should send confirmation request when connected", async () => {
      await channel.connect();
      
      // Start the confirmation request - it will eventually timeout
      // since no button is pressed, but we verify it starts without error
      const promise = channel.requestConfirmation({
        chatId: "C123",
        question: "Confirm?",
        options: ["Yes", "No"],
      });

      // Verify it returns a promise (doesn't throw synchronously)
      expect(promise).toBeInstanceOf(Promise);
      
      // Attach a catch handler to prevent unhandled rejection warning
      // The promise will be rejected by disconnect() in afterEach
      promise.catch(() => {});
    });

    it("binds confirmation buttons to the original requester when userId is provided", async () => {
      await channel.connect();

      const promise = channel.requestConfirmation({
        chatId: "C123",
        userId: "U123",
        question: "Confirm?",
        options: ["Yes", "No"],
      });
      const guardedPromise = promise.catch((error) => error);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(
        (channel as unknown as {
          pendingConfirmations: Map<string, unknown>;
        }).pendingConfirmations.size,
      ).toBe(1);

      const app = (channel as unknown as {
        app: {
          action: ReturnType<typeof vi.fn>;
          client: {
            chat: {
              postEphemeral: ReturnType<typeof vi.fn>;
            };
          };
        };
        pendingConfirmations: Map<string, unknown>;
      }).app;
      const actionHandler = app.action.mock.calls[0]?.[1] as ((payload: unknown) => Promise<void>) | undefined;
      const [confirmId] = Array.from(
        (channel as unknown as {
          pendingConfirmations: Map<string, unknown>;
        }).pendingConfirmations.keys(),
      );

      expect(actionHandler).toBeDefined();

      await actionHandler!({
        ack: vi.fn().mockResolvedValue(undefined),
        body: {
          channel: { id: "C123" },
          user: { id: "U999" },
          message: { ts: "1234567890.123456" },
        },
        action: {
          action_id: `${confirmId}_approve`,
          value: "approve",
        },
      });

      expect(app.client.chat.postEphemeral).toHaveBeenCalledWith({
        channel: "C123",
        user: "U999",
        text: "Only the original requester can respond to this confirmation.",
      });
      expect(
        (channel as unknown as {
          pendingConfirmations: Map<string, unknown>;
        }).pendingConfirmations.has(confirmId!),
      ).toBe(true);

      await channel.disconnect();
      await expect(guardedPromise).resolves.toBeInstanceOf(Error);
    });
  });

  describe("isHealthy", () => {
    it("should return false when not connected", () => {
      expect(channel.isHealthy()).toBe(false);
    });

    it("should return true when connected", async () => {
      await channel.connect();
      expect(channel.isHealthy()).toBe(true);
    });

    it("should return false after disconnect", async () => {
      await channel.connect();
      await channel.disconnect();
      expect(channel.isHealthy()).toBe(false);
    });
  });

  describe("authorization", () => {
    it("should check workspace authorization", async () => {
      const restrictedChannel = new SlackChannel({
        ...mockConfig,
        allowedWorkspaces: ["T123"],
      });
      expect(restrictedChannel).toBeDefined();
    });

    it("should check user authorization", async () => {
      const restrictedChannel = new SlackChannel({
        ...mockConfig,
        allowedUserIds: ["U123"],
      });
      expect(restrictedChannel).toBeDefined();
    });

    it("allows inbound Slack messages when no workspace or user allowlists are configured", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);

      await (channel as unknown as {
        handleIncomingMessage: (message: Record<string, unknown>, say: ReturnType<typeof vi.fn>) => Promise<void>;
      }).handleIncomingMessage(
        {
          type: "message",
          user: "U-open",
          team: "T-open",
          channel: "C123",
          text: "hello",
          ts: "123.456",
        },
        vi.fn(),
      );

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("rejects Slack messages from unauthorized workspaces", async () => {
      const restrictedChannel = new SlackChannel({
        ...mockConfig,
        allowedWorkspaces: ["T-allowed"],
      });
      const say = vi.fn().mockResolvedValue(undefined);

      await (restrictedChannel as unknown as {
        handleIncomingMessage: (message: Record<string, unknown>, say: ReturnType<typeof vi.fn>) => Promise<void>;
      }).handleIncomingMessage(
        {
          type: "message",
          user: "U123",
          team: "T-blocked",
          channel: "C123",
          text: "hello",
          ts: "123.456",
        },
        say,
      );

      expect(say).toHaveBeenCalledWith("❌ This workspace is not authorized to use Strada Brain.");
    });
  });
});

describe("SlackChannel file extraction", () => {
  let channel: SlackChannel;
  let messageHandlerFn: ((msg: any) => Promise<void>) | null = null;
  let capturedMessageCallback: ((args: { message: any; say: any }) => Promise<void>) | null = null;

  const mockConfig = {
    botToken: "xoxb-test-token",
    signingSecret: "test-secret",
    appToken: "xapp-test-token",
    socketMode: true,
  };

  beforeEach(async () => {
    // Reset captured callback
    capturedMessageCallback = null;

    // Re-mock App to capture the message handler
    const { App } = await import("@slack/bolt");
    vi.mocked(App).mockImplementation(() => {
      const messageHandlers: Array<(...args: any[]) => any> = [];
      return {
        start: vi.fn().mockResolvedValue(undefined),
        message: vi.fn().mockImplementation((...args: any[]) => {
          // The last argument is the handler function
          const handler = args[args.length - 1];
          if (typeof handler === "function") {
            messageHandlers.push(handler);
            // Capture the first message handler (the one without directMention)
            if (!capturedMessageCallback) {
              capturedMessageCallback = handler;
            }
          }
        }),
        action: vi.fn(),
        event: vi.fn(),
        error: vi.fn(),
        command: vi.fn(),
        client: {
          auth: {
            test: vi.fn().mockResolvedValue({ user_id: "U123" }),
          },
          chat: {
            postMessage: vi.fn().mockResolvedValue({ ts: "1234567890.123456" }),
            postEphemeral: vi.fn().mockResolvedValue({}),
            update: vi.fn().mockResolvedValue({}),
          },
          views: {
            open: vi.fn().mockResolvedValue({}),
          },
          files: {
            uploadV2: vi.fn().mockResolvedValue({}),
          },
        },
      } as any;
    });

    channel = new SlackChannel(mockConfig);
    messageHandlerFn = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(messageHandlerFn);
    await channel.connect();
  });

  afterEach(async () => {
    if (channel) {
      await channel.disconnect();
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("should extract image files from message events", async () => {
    mockDownloadMedia.mockResolvedValueOnce({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]),
      mimeType: "image/png",
      size: 8,
    });

    const message = {
      type: "message",
      user: "U456",
      channel: "C789",
      text: "Here is a file",
      ts: "1234567890.000001",
      team: "T001",
      files: [
        {
          id: "F001",
          name: "photo.png",
          mimetype: "image/png",
          size: 1024,
          url_private: "https://files.slack.com/files-pri/T001-F001/photo.png",
        },
      ],
    };

    const say = vi.fn();
    await capturedMessageCallback!({ message, say });

    expect(messageHandlerFn).toHaveBeenCalledOnce();
    const incoming = (messageHandlerFn as any).mock.calls[0][0];
    expect(incoming.attachments).toHaveLength(1);
    expect(incoming.attachments[0].type).toBe("image");
    expect(incoming.attachments[0].name).toBe("photo.png");
    expect(incoming.attachments[0].mimeType).toBe("image/png");
    // After download, size reflects the actual downloaded data length (8 bytes from mock)
    expect(incoming.attachments[0].size).toBe(8);
    expect(incoming.attachments[0].url).toBe(
      "https://files.slack.com/files-pri/T001-F001/photo.png"
    );
    expect(incoming.attachments[0].data).toBeInstanceOf(Buffer);
  });

  it("should classify video, audio, and document types correctly", async () => {
    mockDownloadMedia.mockResolvedValue({
      data: Buffer.from([0x00, 0x00, 0x00, 0x00]),
      mimeType: "application/octet-stream",
      size: 4,
    });

    const message = {
      type: "message",
      user: "U456",
      channel: "C789",
      text: "Multiple files",
      ts: "1234567890.000002",
      team: "T001",
      files: [
        { id: "F1", name: "clip.mp4", mimetype: "video/mp4", size: 2048, url_private: "https://files.slack.com/v1" },
        { id: "F2", name: "song.mp3", mimetype: "audio/mpeg", size: 512, url_private: "https://files.slack.com/a1" },
        { id: "F3", name: "doc.pdf", mimetype: "application/pdf", size: 256, url_private: "https://files.slack.com/d1" },
      ],
    };

    const say = vi.fn();
    await capturedMessageCallback!({ message, say });

    const incoming = (messageHandlerFn as any).mock.calls[0][0];
    expect(incoming.attachments).toHaveLength(3);
    expect(incoming.attachments[0].type).toBe("video");
    expect(incoming.attachments[1].type).toBe("audio");
    expect(incoming.attachments[2].type).toBe("document");
  });

  it("should use downloadMedia with Bearer token auth", async () => {
    mockDownloadMedia.mockResolvedValueOnce({
      data: Buffer.from("text-data"),
      mimeType: "text/plain",
      size: 9,
    });

    const message = {
      type: "message",
      user: "U456",
      channel: "C789",
      text: "File with auth",
      ts: "1234567890.000003",
      team: "T001",
      files: [
        { id: "F001", name: "secret.txt", mimetype: "text/plain", size: 100, url_private: "https://files.slack.com/secret" },
      ],
    };

    const say = vi.fn();
    await capturedMessageCallback!({ message, say });

    expect(mockDownloadMedia).toHaveBeenCalledWith("https://files.slack.com/secret", {
      headers: { Authorization: "Bearer xoxb-test-token" },
    });
  });

  it("should handle download failures gracefully", async () => {
    mockDownloadMedia.mockResolvedValueOnce(null); // simulate download failure

    const message = {
      type: "message",
      user: "U456",
      channel: "C789",
      text: "File that fails to download",
      ts: "1234567890.000004",
      team: "T001",
      files: [
        { id: "F001", name: "broken.png", mimetype: "image/png", size: 500, url_private: "https://files.slack.com/broken" },
      ],
    };

    const say = vi.fn();
    await capturedMessageCallback!({ message, say });

    expect(messageHandlerFn).toHaveBeenCalledOnce();
    const incoming = (messageHandlerFn as any).mock.calls[0][0];
    expect(incoming.attachments).toHaveLength(1);
    expect(incoming.attachments[0].type).toBe("image");
    expect(incoming.attachments[0].name).toBe("broken.png");
    expect(incoming.attachments[0].url).toBe("https://files.slack.com/broken");
    expect(incoming.attachments[0].data).toBeUndefined();
  });

  it("should skip files without name or mimetype", async () => {
    const message = {
      type: "message",
      user: "U456",
      channel: "C789",
      text: "Files with missing info",
      ts: "1234567890.000005",
      team: "T001",
      files: [
        { id: "F1", mimetype: "image/png", size: 100, url_private: "https://example.com/f1" },
        { id: "F2", name: "valid.png", mimetype: "image/png", size: 200, url_private: "https://example.com/f2" },
        { id: "F3", name: "no-mime.dat", size: 300, url_private: "https://example.com/f3" },
      ],
    };

    const say = vi.fn();
    await capturedMessageCallback!({ message, say });

    const incoming = (messageHandlerFn as any).mock.calls[0][0];
    // Only the second file (valid.png) has both name and mimetype
    expect(incoming.attachments).toHaveLength(1);
    expect(incoming.attachments[0].name).toBe("valid.png");
  });
});
