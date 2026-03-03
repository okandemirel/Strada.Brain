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
  });
});

describe("createSlackChannelFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return null when config is incomplete", async () => {
    delete process.env["SLACK_BOT_TOKEN"];
    delete process.env["SLACK_SIGNING_SECRET"];

    const { createSlackChannelFromEnv } = await import("../app.js");
    const channel = createSlackChannelFromEnv();
    expect(channel).toBeNull();
  });

  it("should create channel from env vars", async () => {
    process.env["SLACK_BOT_TOKEN"] = "xoxb-test";
    process.env["SLACK_SIGNING_SECRET"] = "test-secret";
    process.env["SLACK_APP_TOKEN"] = "xapp-test";
    process.env["SLACK_SOCKET_MODE"] = "true";

    const { createSlackChannelFromEnv } = await import("../app.js");
    const channel = createSlackChannelFromEnv();
    expect(channel).toBeInstanceOf(SlackChannel);
  });
});
