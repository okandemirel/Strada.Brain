/**
 * Telegram Flow Integration Test
 * 
 * Tests the complete flow:
 * 1. Telegram'dan mesaj gelir (mock)
 * 2. Orchestrator işler
 * 3. Tool çağrısı yapar (örn: file_read)
 * 4. LLM yanıt verir
 * 5. Telegram'a yanıt gider (mock)
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { Orchestrator } from "../../agents/orchestrator.js";
import { FileReadTool } from "../../agents/tools/file-read.js";
import { FileWriteTool } from "../../agents/tools/file-write.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import { createMockTelegramChannel } from "../helpers/mock-channel.js";
import { createMockProvider, createMockToolCall } from "../helpers/mock-provider.js";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Initialize logger before all tests
beforeAll(() => {
  createLogger("error", "/tmp/strada-test.log");
});

describe("Telegram Flow Integration", () => {
  let tempDir: string;
  let orchestrator: Orchestrator;
  let telegramChannel: ReturnType<typeof createMockTelegramChannel>;
  let mockProvider: ReturnType<typeof createMockProvider>;
  let tools: ITool[];

  beforeEach(async () => {
    // Create temp project directory
    tempDir = await mkdtemp(join(tmpdir(), "strada-telegram-test-"));

    // Create mock channel
    telegramChannel = createMockTelegramChannel();

    // Create mock provider
    mockProvider = createMockProvider();

    // Create tools
    tools = [new FileReadTool(), new FileWriteTool()];

    // Create orchestrator
    orchestrator = new Orchestrator({
      providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
      tools,
      channel: telegramChannel,
      projectPath: tempDir,
      readOnly: false,
      requireConfirmation: false,
      streamingEnabled: false,
    });

    // Connect channel
    await telegramChannel.connect();
    telegramChannel.onMessage((msg) => orchestrator.handleMessage(msg));
  });

  describe("Basic Message Flow", () => {
    it("should receive message and send response", async () => {
      // Arrange: Configure provider to return a simple response
      mockProvider.queueResponse({
        text: "Hello! I received your message.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      });

      // Act: Simulate incoming Telegram message
      await telegramChannel.simulateIncomingMessage(
        "chat-123",
        "Hello bot!",
        "user-456"
      );

      // Assert: Verify response was sent
      expect(telegramChannel.sentMarkdowns.length).toBeGreaterThan(0);
      expect(telegramChannel.hasMarkdownContaining("Hello! I received your message.")).toBe(true);
    });

    it("should handle messages with markdown formatting", async () => {
      mockProvider.queueResponse({
        text: "Here's some **bold** and `code` formatting.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      });

      await telegramChannel.simulateIncomingMessage("chat-456", "Show me formatting");

      const lastMarkdown = telegramChannel.getLastMarkdown("chat-456");
      expect(lastMarkdown).toBeDefined();
      expect(lastMarkdown!.text).toContain("**bold**");
      expect(lastMarkdown!.text).toContain("`code`");
    });
  });

  describe("Tool Call Flow - file_read", () => {
    it("should execute file_read tool when LLM requests it", async () => {
      // Arrange: Create a test file
      const testContent = "public class PlayerController : MonoBehaviour { }";
      const scriptsDir = join(tempDir, "Assets", "Scripts");
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(join(scriptsDir, "PlayerController.cs"), testContent);

      // Configure provider: first request file_read, then respond with result
      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "file_read", {
            path: "Assets/Scripts/PlayerController.cs",
          }),
        ],
        "I found the PlayerController. It extends MonoBehaviour as expected."
      );

      // Act
      await telegramChannel.simulateIncomingMessage(
        "chat-789",
        "Read the PlayerController file"
      );

      // Assert: Verify tool was called
      mockProvider.assertToolCalled("file_read");

      // Assert: Verify file content was processed
      const interactions = mockProvider.interactions;
      expect(interactions.length).toBeGreaterThanOrEqual(2);

      // Second interaction should contain tool results
      const secondInteraction = interactions[1];
      expect(secondInteraction.messages.some((m) => m.role === "user")).toBe(true);

      // Assert: Verify final response was sent to Telegram
      expect(telegramChannel.hasMarkdownContaining("PlayerController")).toBe(true);
      expect(telegramChannel.hasMarkdownContaining("MonoBehaviour")).toBe(true);
    });

    it("should handle file not found error gracefully", async () => {
      // Configure provider to request a non-existent file
      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "file_read", {
            path: "Assets/Scripts/NonExistent.cs",
          }),
        ],
        "I couldn't find that file. Please check the path."
      );

      await telegramChannel.simulateIncomingMessage(
        "chat-error",
        "Read NonExistent.cs"
      );

      // Assert: Error should be handled and response sent
      expect(telegramChannel.sentMarkdowns.length).toBeGreaterThan(0);
      
      // The tool result should contain error information
      const toolCallInteractions = mockProvider.getToolCallInteractions();
      expect(toolCallInteractions.length).toBeGreaterThan(0);
    });

    it("should handle multiple file reads in sequence", async () => {
      // Create multiple test files
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "PlayerController.cs"),
        "public class PlayerController { }"
      );
      await writeFile(
        join(tempDir, "Assets", "Scripts", "EnemyAI.cs"),
        "public class EnemyAI { }"
      );

      // Configure provider for multi-file sequence
      mockProvider.simulateMultiToolSequence(
        [
          {
            toolCalls: [
              createMockToolCall("tool-1", "file_read", {
                path: "Assets/Scripts/PlayerController.cs",
              }),
            ],
            responseText: "Let me check the player controller first...",
          },
          {
            toolCalls: [
              createMockToolCall("tool-2", "file_read", {
                path: "Assets/Scripts/EnemyAI.cs",
              }),
            ],
            responseText: "Now let me check the enemy AI...",
          },
        ],
        "I've reviewed both files. PlayerController handles movement, EnemyAI handles behavior."
      );

      await telegramChannel.simulateIncomingMessage("chat-multi", "Review both files");

      // Assert: Both files should have been read
      const toolCalls = mockProvider.getAllToolCalls();
      expect(toolCalls.some((tc) => tc.input.path === "Assets/Scripts/PlayerController.cs")).toBe(true);
      expect(toolCalls.some((tc) => tc.input.path === "Assets/Scripts/EnemyAI.cs")).toBe(true);

      // Assert: Final response should summarize both
      expect(telegramChannel.hasMarkdownContaining("PlayerController")).toBe(true);
      expect(telegramChannel.hasMarkdownContaining("EnemyAI")).toBe(true);
    });
  });

  describe("Tool Call Flow - file_write", () => {
    it("should write file when LLM requests it", async () => {
      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "file_write", {
            path: "Assets/Scripts/NewScript.cs",
            content: "public class NewScript : MonoBehaviour { }",
          }),
        ],
        "I've created the NewScript.cs file for you."
      );

      await telegramChannel.simulateIncomingMessage(
        "chat-write",
        "Create a new script called NewScript"
      );

      // Assert: Tool was called with correct parameters
      mockProvider.assertToolCalled("file_write");
      const toolCalls = mockProvider.getAllToolCalls();
      const writeCall = toolCalls.find((tc) => tc.name === "file_write");
      expect(writeCall).toBeDefined();
      expect(writeCall!.input.path).toBe("Assets/Scripts/NewScript.cs");
      expect(writeCall!.input.content).toContain("NewScript");
    });
  });

  describe("Session Management", () => {
    it("should maintain conversation context within a session", async () => {
      // First message
      mockProvider.queueResponse({
        text: "I understand you're asking about PlayerController.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      });

      await telegramChannel.simulateIncomingMessage("chat-session", "Tell me about PlayerController");

      // Second message (should have context from first)
      mockProvider.registerResponseHandler("context-check", ({ messages }) => {
        // Check if previous context is present
        const hasContext = messages.some(
          (m) => m.role === "assistant" && m.content?.includes("PlayerController")
        );
        if (hasContext) {
          return {
            text: "Yes, I remember we were discussing PlayerController.",
            toolCalls: [],
            stopReason: "end_turn",
            usage: { inputTokens: 150, outputTokens: 40, totalTokens: 190 },
          };
        }
        return undefined;
      });

      await telegramChannel.simulateIncomingMessage("chat-session", "What were we talking about?");

      // Assert: Context was maintained
      expect(telegramChannel.hasMarkdownContaining("remember")).toBe(true);
      expect(telegramChannel.hasMarkdownContaining("PlayerController")).toBe(true);
    });

    it("should isolate sessions between different chats", async () => {
      mockProvider.queueResponses([
        { text: "Response for chat A", toolCalls: [], stopReason: "end_turn" },
        { text: "Response for chat B", toolCalls: [], stopReason: "end_turn" },
      ]);

      // Send messages to different chats
      await telegramChannel.simulateIncomingMessage("chat-A", "Message A");
      await telegramChannel.simulateIncomingMessage("chat-B", "Message B");

      // Assert: Each chat got its own response
      expect(telegramChannel.getMarkdownsForChat("chat-A").length).toBeGreaterThan(0);
      expect(telegramChannel.getMarkdownsForChat("chat-B").length).toBeGreaterThan(0);
      expect(telegramChannel.hasMarkdownContaining("Response for chat A", "chat-A")).toBe(true);
      expect(telegramChannel.hasMarkdownContaining("Response for chat B", "chat-B")).toBe(true);
    });
  });

  describe("Rate Limiting and Safety", () => {
    it("should process messages with proper channel integration", async () => {
      mockProvider.queueResponse({
        text: "Here's your answer...",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      });

      await telegramChannel.simulateIncomingMessage("chat-typing", "Quick question");

      // Assert: Response was processed through the channel
      expect(telegramChannel.sentMarkdowns.length).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle provider errors gracefully", async () => {
      // Simulate repeated provider errors to trigger abort with user notification
      for (let i = 0; i < 5; i++) {
        mockProvider.chatSpy.mockRejectedValueOnce(new Error("Provider API error"));
      }

      await telegramChannel.simulateIncomingMessage("chat-error", "Trigger error");

      // Assert: Error message sent to user (not internal details)
      expect(telegramChannel.sentMessages.length).toBeGreaterThan(0);
      const lastMessage = telegramChannel.getLastMessage("chat-error");
      // Error message should be user-friendly (no raw stack traces or API keys)
      expect(lastMessage?.text).toBeDefined();
      expect(lastMessage?.text).not.toContain("stack");
      expect(lastMessage?.text).not.toContain("at Object");
    });
  });
});
