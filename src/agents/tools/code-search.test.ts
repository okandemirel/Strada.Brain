import { describe, it, expect, vi } from "vitest";
import { CodeSearchTool } from "./code-search.js";
import { createToolContext } from "../../test-helpers.js";
import type { IRAGPipeline, RAGSearchResult, IndexingStats } from "../../rag/rag.interface.js";

function createMockRAG(overrides?: Partial<IRAGPipeline>): IRAGPipeline {
  return {
    initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    indexFile: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    removeFile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    indexProject: vi.fn<() => Promise<IndexingStats>>().mockResolvedValue({
      totalFiles: 0,
      totalChunks: 0,
      indexedAt: new Date().toISOString(),
      durationMs: 0,
    }),
    search: vi.fn<() => Promise<RAGSearchResult[]>>().mockResolvedValue([]),
    formatContext: vi.fn<() => string>().mockReturnValue(""),
    getStats: vi.fn<() => IndexingStats>().mockReturnValue({
      totalFiles: 0,
      totalChunks: 0,
      indexedAt: new Date().toISOString(),
      durationMs: 0,
    }),
    ...overrides,
  };
}

function makeResult(overrides?: Partial<RAGSearchResult>): RAGSearchResult {
  return {
    chunk: {
      id: "chunk-1",
      filePath: "Assets/Combat/DamageSystem.cs",
      content: "public float CalculateDamage(float base, float multiplier) {\n  return base * multiplier;\n}",
      startLine: 42,
      endLine: 44,
      kind: "method",
      symbol: "CalculateDamage",
      parentSymbol: "DamageSystem",
      namespace: "Game.Combat",
      contentHash: "abc123",
      indexedAt: new Date().toISOString(),
    },
    vectorScore: 0.9,
    finalScore: 0.88,
    ...overrides,
  };
}

describe("CodeSearchTool", () => {
  it("returns formatted results with code blocks", async () => {
    const rag = createMockRAG({
      search: vi.fn().mockResolvedValue([makeResult()]),
    });
    const tool = new CodeSearchTool(rag);
    const result = await tool.execute({ query: "damage calculation" }, createToolContext());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Found 1 result(s)");
    expect(result.content).toContain("Assets/Combat/DamageSystem.cs");
    expect(result.content).toContain("L42–44");
    expect(result.content).toContain("CalculateDamage");
    expect(result.content).toContain("Game.Combat");
    expect(result.content).toContain("88.0% match");
    expect(result.content).toContain("```");
    expect(result.content).toContain("CalculateDamage(float base, float multiplier)");
  });

  it("returns 'no results' message when empty", async () => {
    const rag = createMockRAG({
      search: vi.fn().mockResolvedValue([]),
    });
    const tool = new CodeSearchTool(rag);
    const result = await tool.execute({ query: "nonexistent concept" }, createToolContext());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("No results found");
    expect(result.content).toContain("nonexistent concept");
  });

  it("returns error when query is empty", async () => {
    const rag = createMockRAG();
    const tool = new CodeSearchTool(rag);
    const result = await tool.execute({ query: "" }, createToolContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("'query' is required");
  });

  it("respects limit parameter clamped to 1–15", async () => {
    const rag = createMockRAG();
    const tool = new CodeSearchTool(rag);

    await tool.execute({ query: "test", limit: 0 }, createToolContext());
    expect(rag.search).toHaveBeenCalledWith("test", expect.objectContaining({ topK: 1 }));

    vi.mocked(rag.search).mockClear();

    await tool.execute({ query: "test", limit: 100 }, createToolContext());
    expect(rag.search).toHaveBeenCalledWith("test", expect.objectContaining({ topK: 15 }));
  });

  it("passes kind filter to search", async () => {
    const rag = createMockRAG();
    const tool = new CodeSearchTool(rag);

    await tool.execute({ query: "health", kind: "method" }, createToolContext());

    expect(rag.search).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ kinds: ["method"] })
    );
  });

  it("handles search error gracefully", async () => {
    const rag = createMockRAG({
      search: vi.fn().mockRejectedValue(new Error("embedding service unavailable")),
    });
    const tool = new CodeSearchTool(rag);
    const result = await tool.execute({ query: "player logic" }, createToolContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("code search failed");
  });
});
