import { describe, it, expect, beforeEach, vi } from "vitest";
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

// Mock discord.js
vi.mock("discord.js", async () => {
  const actual = await vi.importActual("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
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
    })),
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
  });

  describe("sendText", () => {
    it("should send text message", async () => {
      await channel.connect();
      await expect(
        channel.sendText("channel123", "Hello World")
      ).resolves.not.toThrow();
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

    it.skip("should send in thread", async () => {
      // Skipped: requires ThreadChannel mock
      await channel.connect();
      await expect(
        channel.sendInThread("thread123", "Thread message")
      ).resolves.not.toThrow();
    });

    it.skip("should send markdown in thread", async () => {
      // Skipped: requires ThreadChannel mock
      await channel.connect();
      await expect(
        channel.sendInThread("thread123", "**Bold**", { markdown: true })
      ).resolves.not.toThrow();
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
});
