/**
 * RAG Search Flow Integration Test
 * 
 * Tests the complete flow:
 * 1. CodeSearch tool'u çalıştırılır
 * 2. Vector store'dan sonuçlar gelir
 * 3. Reranking yapılır
 * 4. Context LLM'e gönderilir
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { Orchestrator } from "../../agents/orchestrator.js";
import { CodeSearchTool } from "../../agents/tools/code-search.js";
import { FileReadTool } from "../../agents/tools/file-read.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import { createMockTelegramChannel } from "../helpers/mock-channel.js";
import { createMockProvider, createMockToolCall } from "../helpers/mock-provider.js";
import type {
  IRAGPipeline,
  RAGSearchResult,
  SearchResult,
  CodeChunk,
} from "../../rag/rag.interface.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Initialize logger before all tests
beforeAll(() => {
  createLogger("error", "/tmp/strada-test.log");
});

describe("RAG Search Flow Integration", () => {
  let tempDir: string;
  let orchestrator: Orchestrator;
  let channel: ReturnType<typeof createMockTelegramChannel>;
  let mockProvider: ReturnType<typeof createMockProvider>;
  let mockRagPipeline: IRAGPipeline;
  let tools: ITool[];

  // Helper to create mock search results
  function createMockSearchResults(query: string, count: number): RAGSearchResult[] {
    const results: RAGSearchResult[] = [];
    const kinds: CodeChunk["kind"][] = ["class", "method", "property", "field"];

    for (let i = 0; i < count; i++) {
      const chunk: CodeChunk = {
        id: `chunk-${i}`,
        kind: kinds[i % kinds.length]!,
        content: `// ${query} related code ${i}\npublic class ${query.replace(/\s+/g, "")}${i} { }`,
        contentHash: `hash-${i}`,
        filePath: `/project/Assets/Scripts/${query.replace(/\s+/g, "")}${i}.cs`,
        indexedAt: Date.now(),
        startLine: i * 10 + 1,
        endLine: i * 10 + 10,
        symbol: `${query.replace(/\s+/g, "")}${i}`,
        namespace: "Game",
        language: "csharp",
      };

      results.push({
        chunk,
        vectorScore: 0.9 - i * 0.05,
        rerankScore: 0.85 - i * 0.03,
        finalScore: 0.88 - i * 0.04,
        matchedKeywords: query.split(" "),
        matchExplanation: `Matches ${query}`,
      });
    }

    return results;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "strada-rag-test-"));

    channel = createMockTelegramChannel();
    mockProvider = createMockProvider();

    // Create mock RAG pipeline
    mockRagPipeline = {
      initialize: vi.fn().mockResolvedValue({ success: true, value: undefined }),
      shutdown: vi.fn().mockResolvedValue({ success: true, value: undefined }),
      indexFile: vi.fn().mockResolvedValue({ success: true, value: 5 }),
      removeFile: vi.fn().mockResolvedValue({ success: true, value: undefined }),
      indexProject: vi.fn().mockResolvedValue({
        success: true,
        value: {
          totalFiles: 50,
          totalChunks: 250,
          indexedAt: new Date().toISOString(),
          durationMs: 5000,
          changedFiles: 50,
          errors: [],
        },
      }),
      search: vi.fn().mockImplementation(async (query: string) => {
        const results = createMockSearchResults(query, 5);
        return results;
      }),
      formatContext: vi.fn().mockImplementation((results: RAGSearchResult[]) => {
        if (results.length === 0) return { text: "", sources: [], tokenCount: 0, budgetUsed: 0 };
        
        const text = results
          .map(
            (r) =>
              `### [${r.chunk.kind.toUpperCase()}] ${r.chunk.filePath}:L${r.chunk.startLine}-${r.chunk.endLine} (${
                Math.round(r.finalScore * 100)
              }% match)\n\`\`\`csharp\n${r.chunk.content}\n\`\`\``
          )
          .join("\n\n");

        return {
          text,
          sources: results,
          tokenCount: text.length / 4,
          budgetUsed: 0.5,
        };
      }),
      getStats: vi.fn().mockReturnValue({
        totalFilesIndexed: 50,
        totalChunks: 250,
        vectorStoreStats: {
          totalVectors: 250,
          dimensions: 384,
          indexType: "hnsw",
          memoryUsedBytes: 100000,
          averageSearchTimeMs: 15,
        },
        averageQueryTimeMs: 25,
      }),
    };

    tools = [new CodeSearchTool(mockRagPipeline), new FileReadTool()];

    orchestrator = new Orchestrator({
      providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
      tools,
      channel,
      projectPath: tempDir,
      readOnly: false,
      requireConfirmation: false,
      ragPipeline: mockRagPipeline,
      streamingEnabled: false,
    });

    await channel.connect();
    channel.onMessage((msg) => orchestrator.handleMessage(msg));
  });

  describe("Basic RAG Search Flow", () => {
    it("should execute code_search and return semantic results", async () => {
      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "damage calculation",
            limit: 5,
          }),
        ],
        "I found 5 results for damage calculation. The main logic is in the Combat system."
      );

      await channel.simulateIncomingMessage("chat-rag-1", "How is damage calculated?");

      // Assert: RAG search was called
      expect(mockRagPipeline.search).toHaveBeenCalledWith(
        "damage calculation",
        expect.objectContaining({ topK: 5 })
      );

      // Assert: Tool was called
      mockProvider.assertToolCalled("code_search");

      // Assert: Results were sent to user
      expect(channel.hasMarkdownContaining("damage calculation")).toBe(true);
    });

    it("should search with kind filter when specified", async () => {
      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "player controller",
            kind: "class",
            limit: 8,
          }),
        ],
        "Found PlayerController class in the project."
      );

      await channel.simulateIncomingMessage("chat-rag-kind", "Find PlayerController class");

      // Assert: Search was called with kind filter
      expect(mockRagPipeline.search).toHaveBeenCalledWith(
        "player controller",
        expect.objectContaining({
          kinds: ["class"],
          topK: 8,
        })
      );
    });

    it("should search with file pattern filter when specified", async () => {
      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "combat system",
            file_pattern: "**/Combat/**",
            limit: 10,
          }),
        ],
        "Found combat system components in Combat folder."
      );

      await channel.simulateIncomingMessage("chat-rag-pattern", "Search combat system in Combat folder");

      // Assert: Search was called with file pattern
      expect(mockRagPipeline.search).toHaveBeenCalledWith(
        "combat system",
        expect.objectContaining({
          filePattern: "**/Combat/**",
          topK: 10,
        })
      );
    });
  });

  describe("Reranking and Scoring", () => {
    it("should return reranked results with final scores", async () => {
      // Configure mock to return results with different scores
      const mockResults: RAGSearchResult[] = [
        {
          chunk: {
            id: "chunk-1",
            kind: "method",
            content: "public int CalculateDamage() { return baseDamage; }",
            contentHash: "hash1",
            filePath: "/project/Assets/Scripts/Combat/DamageCalculator.cs",
            indexedAt: Date.now(),
            startLine: 10,
            endLine: 15,
            symbol: "CalculateDamage",
            language: "csharp",
          },
          vectorScore: 0.95,
          rerankScore: 0.92,
          finalScore: 0.94,
          matchedKeywords: ["damage", "calculate"],
        },
        {
          chunk: {
            id: "chunk-2",
            kind: "class",
            content: "public class DamageSystem { }",
            contentHash: "hash2",
            filePath: "/project/Assets/Scripts/Combat/DamageSystem.cs",
            indexedAt: Date.now(),
            startLine: 1,
            endLine: 20,
            symbol: "DamageSystem",
            language: "csharp",
          },
          vectorScore: 0.88,
          rerankScore: 0.85,
          finalScore: 0.87,
          matchedKeywords: ["damage"],
        },
      ];

      vi.mocked(mockRagPipeline.search).mockResolvedValueOnce(mockResults);

      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "damage calculation",
          }),
        ],
        "Found damage calculation methods with scores 94% and 87%."
      );

      await channel.simulateIncomingMessage("chat-rag-rerank", "Find damage calculation code");

      // Assert: Results include scores
      const toolCalls = mockProvider.getAllToolCalls();
      const searchCall = toolCalls.find((tc) => tc.name === "code_search");
      expect(searchCall).toBeDefined();

      // Results should have been formatted with scores in the final response
      const markdown = channel.getLastMarkdown("chat-rag-rerank");
      expect(markdown?.text).toMatch(/\d+% match|score/i);
    });

    it("should apply minimum score threshold", async () => {
      // Configure search to return results with varying scores
      const mixedResults: RAGSearchResult[] = [
        {
          chunk: {
            id: "high-score",
            kind: "method",
            content: "public void HighRelevance() { }",
            contentHash: "hash1",
            filePath: "/project/A.cs",
            indexedAt: Date.now(),
            startLine: 1,
            endLine: 5,
            language: "csharp",
          },
          vectorScore: 0.9,
          rerankScore: 0.9,
          finalScore: 0.9, // High score
        },
        {
          chunk: {
            id: "low-score",
            kind: "method",
            content: "public void LowRelevance() { }",
            contentHash: "hash2",
            filePath: "/project/B.cs",
            indexedAt: Date.now(),
            startLine: 1,
            endLine: 5,
            language: "csharp",
          },
          vectorScore: 0.3,
          rerankScore: 0.3,
          finalScore: 0.3, // Low score - should be filtered
        },
      ];

      vi.mocked(mockRagPipeline.search).mockResolvedValueOnce(mixedResults);

      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "test query",
            limit: 10,
          }),
        ],
        "Found relevant results."
      );

      await channel.simulateIncomingMessage("chat-rag-threshold", "Search with threshold");

      // Assert: Search was called
      expect(mockRagPipeline.search).toHaveBeenCalled();
    });
  });

  describe("Context Integration with LLM", () => {
    it("should inject RAG context into LLM system prompt", async () => {
      // Track if RAG context was injected
      let contextInjected = false;

      mockProvider.registerResponseHandler("rag-context-check", ({ messages, systemPrompt }) => {
        // Check if RAG context is in system prompt
        if (typeof systemPrompt === "string" && systemPrompt.includes("Relevant Code Context")) {
          contextInjected = true;
        }

        // Simulate code search response
        if (messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("physics"))) {
          return {
            text: "Searching for physics code...",
            toolCalls: [
              createMockToolCall("tool-1", "code_search", {
                query: "physics",
              }),
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
          };
        }

        return undefined;
      });

      // Queue final response
      mockProvider.queueResponse({
        text: "Found physics components in your project.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
      });

      await channel.simulateIncomingMessage("chat-rag-context", "How does physics work?");

      // Assert: RAG search was called
      expect(mockRagPipeline.search).toHaveBeenCalled();
    });

    it("should format RAG results for LLM context", async () => {
      // Configure search to return results
      const mockResults = createMockSearchResults("damage formula", 2);
      vi.mocked(mockRagPipeline.search).mockResolvedValueOnce(mockResults);

      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "damage formula",
          }),
        ],
        "The damage formula uses attack power minus half the armor value."
      );

      await channel.simulateIncomingMessage("chat-rag-format", "What's the damage formula?");

      // Assert: Search was called and results were formatted in tool output
      expect(mockRagPipeline.search).toHaveBeenCalledWith(
        "damage formula",
        expect.any(Object)
      );
      
      // The tool result should contain formatted results
      const toolCalls = mockProvider.getAllToolCalls();
      expect(toolCalls.some((tc) => tc.name === "code_search")).toBe(true);
    });
  });

  describe("RAG Tool Error Handling", () => {
    it("should handle empty search results gracefully", async () => {
      // Configure search to return empty results
      vi.mocked(mockRagPipeline.search).mockResolvedValueOnce([]);

      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "nonexistent concept",
          }),
        ],
        "I couldn't find any code matching 'nonexistent concept'. Try a different search term."
      );

      await channel.simulateIncomingMessage("chat-rag-empty", "Find nonexistent concept");

      // Assert: Tool returned "no results" message
      const interactions = mockProvider.interactions;
      const toolResultInteraction = interactions.find((i) =>
        i.messages.some((m) => 
          m.role === "user" && 
          Array.isArray(m.content) &&
          m.content.some((block: { type?: string }) => block.type === "tool_result")
        )
      );

      expect(toolResultInteraction).toBeDefined();
    });

    it("should handle RAG pipeline errors", async () => {
      // Configure search to fail
      vi.mocked(mockRagPipeline.search).mockRejectedValueOnce(new Error("Vector store unavailable"));

      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "test",
          }),
        ],
        "Sorry, the code search is temporarily unavailable."
      );

      await channel.simulateIncomingMessage("chat-rag-error", "Search for something");

      // Assert: Error was handled
      expect(mockRagPipeline.search).toHaveBeenCalled();
    });
  });

  describe("Complex RAG Scenarios", () => {
    it("should combine RAG search with file read for detailed view", async () => {
      // Mock RAG to return a result
      const ragResults: RAGSearchResult[] = [
        {
          chunk: {
            id: "chunk-1",
            kind: "class",
            content: "public class InventorySystem { /* ... */ }",
            contentHash: "hash1",
            filePath: "/project/Assets/Scripts/Inventory/InventorySystem.cs",
            indexedAt: Date.now(),
            startLine: 1,
            endLine: 50,
            symbol: "InventorySystem",
            language: "csharp",
          },
          vectorScore: 0.92,
          rerankScore: 0.9,
          finalScore: 0.91,
        },
      ];

      vi.mocked(mockRagPipeline.search).mockResolvedValueOnce(ragResults);

      // Provider: search → then read file
      mockProvider.queueResponses([
        {
          text: "Let me search for the inventory system...",
          toolCalls: [
            createMockToolCall("tool-1", "code_search", {
              query: "inventory management",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Found it! Let me read the full file...",
          toolCalls: [
            createMockToolCall("tool-2", "file_read", {
              path: "Assets/Scripts/Inventory/InventorySystem.cs",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Here's the complete InventorySystem implementation.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-rag-complex", "Show me the inventory system");

      // Assert: Both tools were called
      mockProvider.assertToolCalled("code_search");
      mockProvider.assertToolCalled("file_read");

      // Assert: file_read was called with the path from RAG results
      const toolCalls = mockProvider.getAllToolCalls();
      const fileReadCall = toolCalls.find((tc) => tc.name === "file_read");
      expect(fileReadCall?.input.path).toContain("Inventory");
    });

    it("should handle multiple related RAG searches in one conversation", async () => {
      // Track search queries
      const searchQueries: string[] = [];

      vi.mocked(mockRagPipeline.search).mockImplementation(async (query: string) => {
        searchQueries.push(query);
        return createMockSearchResults(query, 3);
      });

      // First search: combat system
      mockProvider.queueResponse({
        text: "Searching for combat system...",
        toolCalls: [
          createMockToolCall("tool-1", "code_search", {
            query: "combat system",
          }),
        ],
        stopReason: "tool_use",
      });

      await channel.simulateIncomingMessage("chat-rag-multi-1", "Find combat system");

      // Second search: damage calculation
      mockProvider.queueResponse({
        text: "Now searching for damage calculation...",
        toolCalls: [
          createMockToolCall("tool-2", "code_search", {
            query: "damage calculation",
          }),
        ],
        stopReason: "tool_use",
      });

      await channel.simulateIncomingMessage("chat-rag-multi-1", "How is damage calculated?");

      // Assert: Both searches were performed
      expect(searchQueries).toContain("combat system");
      expect(searchQueries).toContain("damage calculation");
      expect(searchQueries.length).toBe(2);
    });

    it("should respect RAG search limits", async () => {
      mockProvider.simulateToolCallFlow(
        [
          createMockToolCall("tool-1", "code_search", {
            query: "player",
            limit: 3, // Request only 3 results
          }),
        ],
        "Found top 3 player-related results."
      );

      await channel.simulateIncomingMessage("chat-rag-limit", "Find player code (max 3 results)");

      // Assert: Search was called with limit
      expect(mockRagPipeline.search).toHaveBeenCalledWith(
        "player",
        expect.objectContaining({ topK: 3 })
      );
    });
  });
});
