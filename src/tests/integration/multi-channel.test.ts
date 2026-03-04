/**
 * Multi-Channel Flow Integration Test
 * 
 * Tests the complete flow:
 * 1. Telegram'dan komut gelir
 * 2. Discord'dan status sorgusu gelir (aynı anda)
 * 3. Her iki kanal da doğru yanıt alır
 * 4. Session isolation test edilir
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { FileWriteTool } from "../../agents/tools/file-write.js";
import { Orchestrator } from "../../agents/orchestrator.js";
import { FileReadTool } from "../../agents/tools/file-read.js";
import { CodeSearchTool } from "../../agents/tools/code-search.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import {
  createMockTelegramChannel,
  createMockDiscordChannel,
} from "../helpers/mock-channel.js";
import { createMockProvider, createMockToolCall } from "../helpers/mock-provider.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRAGPipeline, RAGSearchResult } from "../../rag/rag.interface.js";

// Initialize logger before all tests
beforeAll(() => {
  createLogger("error", "/tmp/strada-test.log");
});

describe("Multi-Channel Flow Integration", () => {
  let tempDir: string;
  let telegramChannel: ReturnType<typeof createMockTelegramChannel>;
  let discordChannel: ReturnType<typeof createMockDiscordChannel>;
  let telegramOrchestrator: Orchestrator;
  let discordOrchestrator: Orchestrator;
  let mockProvider: ReturnType<typeof createMockProvider>;
  let mockRagPipeline: IRAGPipeline;

  beforeEach(async () => {
    // Create temp project
    tempDir = await mkdtemp(join(tmpdir(), "strata-multi-channel-test-"));

    // Create channels
    telegramChannel = createMockTelegramChannel();
    discordChannel = createMockDiscordChannel();

    // Create shared provider
    mockProvider = createMockProvider();

    // Create mock RAG pipeline
    mockRagPipeline = {
      initialize: async () => ({ success: true, value: undefined }),
      shutdown: async () => ({ success: true, value: undefined }),
      indexFile: async () => ({ success: true, value: 1 }),
      removeFile: async () => ({ success: true, value: undefined }),
      indexProject: async () => ({
        success: true,
        value: {
          totalFiles: 10,
          totalChunks: 50,
          indexedAt: new Date().toISOString(),
          durationMs: 100,
          changedFiles: 10,
          errors: [],
        },
      }),
      search: async () => ({ success: true, value: [] }),
      formatContext: () => ({
        text: "",
        sources: [],
        tokenCount: 0,
        budgetUsed: 0,
      }),
      getStats: () => ({
        totalFilesIndexed: 10,
        totalChunks: 50,
        vectorStoreStats: {
          totalVectors: 50,
          dimensions: 384,
          indexType: "hnsw",
          memoryUsedBytes: 10000,
          averageSearchTimeMs: 10,
        },
        averageQueryTimeMs: 10,
      }),
    };

    // Create tools
    const tools: ITool[] = [
      new FileReadTool(),
      new CodeSearchTool(mockRagPipeline),
    ];

    // Create separate orchestrators for each channel (but sharing provider)
    telegramOrchestrator = new Orchestrator({
      providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
      tools,
      channel: telegramChannel,
      projectPath: tempDir,
      readOnly: false,
      requireConfirmation: false,
      streamingEnabled: false,
    });

    discordOrchestrator = new Orchestrator({
      providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
      tools,
      channel: discordChannel,
      projectPath: tempDir,
      readOnly: false,
      requireConfirmation: false,
      streamingEnabled: false,
    });

    // Connect channels
    await telegramChannel.connect();
    await discordChannel.connect();
    telegramChannel.onMessage((msg) => telegramOrchestrator.handleMessage(msg));
    discordChannel.onMessage((msg) => discordOrchestrator.handleMessage(msg));
  });

  describe("Concurrent Message Handling", () => {
    it("should handle messages from Telegram and Discord simultaneously", async () => {
      // Configure provider with responses for both channels
      mockProvider.queueResponses([
        {
          text: "Telegram response: I received your command!",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
        },
        {
          text: "Discord response: Status check complete!",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
        },
      ]);

      // Act: Send messages to both channels concurrently
      await Promise.all([
        telegramChannel.simulateIncomingMessage("tg-chat-1", "/command execute"),
        discordChannel.simulateIncomingMessage("discord-chat-1", "!status"),
      ]);

      // Assert: Both channels received their respective responses
      expect(telegramChannel.hasMarkdownContaining("Telegram response")).toBe(true);
      expect(discordChannel.hasMarkdownContaining("Discord response")).toBe(true);

      // Assert: Responses went to correct channels
      expect(telegramChannel.hasMarkdownContaining("Discord response")).toBe(false);
      expect(discordChannel.hasMarkdownContaining("Telegram response")).toBe(false);
    });

    it("should handle tool calls from both channels", async () => {
      // Create test file
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "GameManager.cs"),
        "public class GameManager { }"
      );

      // Configure provider with sequential responses for each channel
      mockProvider.queueResponse({
        text: "I'll read that file from Telegram...",
        toolCalls: [
          createMockToolCall("tool-tg-1", "file_read", {
            path: "Assets/Scripts/GameManager.cs",
          }),
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      });

      // Telegram message first
      await telegramChannel.simulateIncomingMessage("tg-chat-tool", "Read GameManager file");

      // Queue final response for Telegram
      mockProvider.queueResponse({
        text: "Telegram result: GameManager found!",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
      });

      // Second message to get final response
      await telegramChannel.simulateIncomingMessage("tg-chat-tool-2", "What did you find?");

      // Now Discord
      mockProvider.queueResponse({
        text: "I'll search from Discord...",
        toolCalls: [
          createMockToolCall("tool-disc-1", "code_search", {
            query: "game manager",
          }),
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      });

      await discordChannel.simulateIncomingMessage("discord-chat-tool", "Search for game manager");

      // Final Discord response
      mockProvider.queueResponse({
        text: "Discord result: Found GameManager class!",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
      });

      await discordChannel.simulateIncomingMessage("discord-chat-tool-2", "Show results");

      // Assert: Both channels got responses
      expect(telegramChannel.sentMarkdowns.length).toBeGreaterThan(0);
      expect(discordChannel.sentMarkdowns.length).toBeGreaterThan(0);

      // Assert: Tools were called
      const toolCalls = mockProvider.getAllToolCalls();
      expect(toolCalls.some((tc) => tc.name === "file_read")).toBe(true);
      expect(toolCalls.some((tc) => tc.name === "code_search")).toBe(true);
    });
  });

  describe("Session Isolation", () => {
    it("should maintain separate sessions for different channels", async () => {
      // Telegram: First message about PlayerController
      mockProvider.queueResponse({
        text: "I understand you're asking about PlayerController on Telegram.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      });

      await telegramChannel.simulateIncomingMessage(
        "tg-session-test",
        "Tell me about PlayerController"
      );

      // Discord: First message about EnemyAI
      mockProvider.queueResponse({
        text: "I understand you're asking about EnemyAI on Discord.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      });

      await discordChannel.simulateIncomingMessage(
        "discord-session-test",
        "Tell me about EnemyAI"
      );

      // Second message on both: check context isolation
      mockProvider.registerResponseHandler("context-check", ({ messages }) => {
        const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
        
        if (content.includes("Telegram") && content.includes("PlayerController")) {
          return {
            text: "Yes, on Telegram we were discussing PlayerController.",
            toolCalls: [],
            stopReason: "end_turn",
            usage: { inputTokens: 150, outputTokens: 40, totalTokens: 190 },
          };
        }
        if (content.includes("Discord") && content.includes("EnemyAI")) {
          return {
            text: "Yes, on Discord we were discussing EnemyAI.",
            toolCalls: [],
            stopReason: "end_turn",
            usage: { inputTokens: 150, outputTokens: 40, totalTokens: 190 },
          };
        }
        return undefined;
      });

      await Promise.all([
        telegramChannel.simulateIncomingMessage("tg-session-test", "What were we talking about?"),
        discordChannel.simulateIncomingMessage("discord-session-test", "What were we talking about?"),
      ]);

      // Assert: Each channel maintained its own context
      expect(telegramChannel.hasMarkdownContaining("Telegram we were discussing PlayerController")).toBe(true);
      expect(discordChannel.hasMarkdownContaining("Discord we were discussing EnemyAI")).toBe(true);

      // Assert: No cross-contamination
      expect(telegramChannel.hasMarkdownContaining("EnemyAI")).toBe(false);
      expect(discordChannel.hasMarkdownContaining("PlayerController")).toBe(false);
    });

    it("should maintain separate sessions for different chats on the same channel", async () => {
      // Chat A on Telegram
      mockProvider.queueResponse({
        text: "Context for Chat A: discussing Topic A",
        toolCalls: [],
        stopReason: "end_turn",
      });

      await telegramChannel.simulateIncomingMessage("tg-chat-a", "Let's talk about Topic A");

      // Chat B on Telegram
      mockProvider.queueResponse({
        text: "Context for Chat B: discussing Topic B",
        toolCalls: [],
        stopReason: "end_turn",
      });

      await telegramChannel.simulateIncomingMessage("tg-chat-b", "Let's talk about Topic B");

      // Check isolation
      mockProvider.registerResponseHandler("multi-chat-check", ({ messages }) => {
        const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
        
        if (content.includes("Topic A")) {
          return {
            text: "We're discussing Topic A in this chat.",
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        if (content.includes("Topic B")) {
          return {
            text: "We're discussing Topic B in this chat.",
            toolCalls: [],
            stopReason: "end_turn",
          };
        }
        return undefined;
      });

      await Promise.all([
        telegramChannel.simulateIncomingMessage("tg-chat-a", "What are we discussing?"),
        telegramChannel.simulateIncomingMessage("tg-chat-b", "What are we discussing?"),
      ]);

      // Assert: Each chat has its own context
      expect(telegramChannel.hasMarkdownContaining("Topic A", "tg-chat-a")).toBe(true);
      expect(telegramChannel.hasMarkdownContaining("Topic B", "tg-chat-b")).toBe(true);
      expect(telegramChannel.hasMarkdownContaining("Topic B", "tg-chat-a")).toBe(false);
      expect(telegramChannel.hasMarkdownContaining("Topic A", "tg-chat-b")).toBe(false);
    });
  });

  describe("Channel-Specific Features", () => {
    it("should use streaming for Discord if enabled", async () => {
      // Create new orchestrator with streaming
      const streamingDiscordChannel = createMockDiscordChannel({ supportsStreaming: true });
      const streamingOrchestrator = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
        tools: [],
        channel: streamingDiscordChannel,
        projectPath: tempDir,
        readOnly: false,
        requireConfirmation: false,
        streamingEnabled: true,
      });

      await streamingDiscordChannel.connect();
      streamingDiscordChannel.onMessage((msg) => streamingOrchestrator.handleMessage(msg));

      mockProvider.queueResponse({
        text: "Streaming response for Discord",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      });

      await streamingDiscordChannel.simulateIncomingMessage("discord-stream", "Test streaming");

      // Assert: Streaming methods were called
      expect(streamingDiscordChannel.startStreamingSpy).toHaveBeenCalled();
      expect(streamingDiscordChannel.finalizeStreamingSpy).toHaveBeenCalled();
    });

    it("should use confirmation dialogs appropriately per channel", async () => {
      // Test that both channels support confirmation functionality
      const confirmTelegram = createMockTelegramChannel({ autoConfirm: false });
      const confirmDiscord = createMockDiscordChannel({ autoConfirm: false });

      // Setup spies to track confirmation requests
      const tgConfirmSpy = vi.fn().mockResolvedValue("Yes");
      const discordConfirmSpy = vi.fn().mockResolvedValue("Yes");
      
      // Override the requestConfirmation method on both channels
      confirmTelegram.requestConfirmation = tgConfirmSpy;
      confirmDiscord.requestConfirmation = discordConfirmSpy;

      // Create orchestrators
      const tgOrchestrator = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
        tools: [new FileReadTool(), new FileWriteTool()],
        channel: confirmTelegram,
        projectPath: tempDir,
        readOnly: false,
        requireConfirmation: true,
        streamingEnabled: false,
      });

      const discordOrchestrator = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
        tools: [new FileReadTool(), new FileWriteTool()],
        channel: confirmDiscord,
        projectPath: tempDir,
        readOnly: false,
        requireConfirmation: true,
        streamingEnabled: false,
      });

      await confirmTelegram.connect();
      await confirmDiscord.connect();
      confirmTelegram.onMessage((msg) => tgOrchestrator.handleMessage(msg));
      confirmDiscord.onMessage((msg) => discordOrchestrator.handleMessage(msg));

      // Configure provider responses for Telegram first
      mockProvider.queueResponse({
        text: "I'll create that file...",
        toolCalls: [
          createMockToolCall("tool-tg", "file_write", {
            path: "Assets/TestTG.cs",
            content: "class TestTG {}",
          }),
        ],
        stopReason: "tool_use",
      });

      await confirmTelegram.simulateIncomingMessage("tg-confirm", "Create Test.cs file");

      // Then configure for Discord
      mockProvider.queueResponse({
        text: "I'll create that file...",
        toolCalls: [
          createMockToolCall("tool-disc", "file_write", {
            path: "Assets/TestDiscord.cs",
            content: "class TestDiscord {}",
          }),
        ],
        stopReason: "tool_use",
      });

      await confirmDiscord.simulateIncomingMessage("discord-confirm", "Create Test.cs file");

      // Assert: Both channels have confirmation capability
      expect(tgConfirmSpy).toHaveBeenCalled();
      expect(discordConfirmSpy).toHaveBeenCalled();
    });
  });

  describe("Load Handling", () => {
    it("should handle rapid messages from multiple channels", async () => {
      const messages: Promise<void>[] = [];
      
      // Queue many responses
      for (let i = 0; i < 10; i++) {
        mockProvider.queueResponse({
          text: `Response ${i}`,
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });
      }

      // Send rapid messages alternating between channels
      for (let i = 0; i < 5; i++) {
        messages.push(
          telegramChannel.simulateIncomingMessage(`tg-load-${i}`, `Message ${i} from Telegram`)
        );
        messages.push(
          discordChannel.simulateIncomingMessage(`discord-load-${i}`, `Message ${i} from Discord`)
        );
      }

      await Promise.all(messages);

      // Assert: All messages got responses
      expect(telegramChannel.sentMarkdowns.length).toBeGreaterThanOrEqual(5);
      expect(discordChannel.sentMarkdowns.length).toBeGreaterThanOrEqual(5);
    });
  });
});
