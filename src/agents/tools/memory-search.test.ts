import { describe, it, expect, vi } from "vitest";
import { MemorySearchTool } from "./memory-search.js";
import { createToolContext } from "../../test-helpers.js";
import type { IMemoryManager, MemoryEntry } from "../../memory/memory.interface.js";
import type { Result } from "../../types/index.js";

function createMockMemoryManager(overrides?: Partial<IMemoryManager>): IMemoryManager {
  return {
    initialize: vi.fn<() => Promise<Result<void, Error>>>().mockResolvedValue({ kind: "ok", value: undefined }),
    shutdown: vi.fn<() => Promise<Result<void, Error>>>().mockResolvedValue({ kind: "ok", value: undefined }),
    cacheAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
    getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
    storeConversation: vi.fn().mockResolvedValue({ kind: "ok", value: "mem_123" }),
    storeNote: vi.fn().mockResolvedValue({ kind: "ok", value: "mem_123" }),
    retrieve: vi.fn<() => Promise<Result<{ entry: MemoryEntry; score: number }[], Error>>>().mockResolvedValue({ kind: "ok", value: [] }),
    getChatHistory: vi.fn().mockResolvedValue({ kind: "ok", value: [] }),
    getStats: vi.fn().mockReturnValue({
      totalEntries: 0,
      entriesByType: {
        conversation: 0,
        analysis: 0,
        note: 0,
        command: 0,
        error: 0,
        insight: 0,
        task: 0,
      },
      entriesByImportance: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      },
      conversationCount: 0,
      noteCount: 0,
      errorCount: 0,
      archivedCount: 0,
      hasAnalysisCache: false,
      storageSizeBytes: 0,
      averageQueryTimeMs: 0,
    }),
    invalidateAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
    storeError: vi.fn().mockResolvedValue({ kind: "ok", value: "mem_123" }),
    resolveError: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
    storeEntry: vi.fn().mockResolvedValue({ kind: "ok", value: {} as MemoryEntry }),
    getEntry: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
    updateEntry: vi.fn().mockResolvedValue({ kind: "ok", value: {} as MemoryEntry }),
    deleteEntry: vi.fn().mockResolvedValue({ kind: "ok", value: true }),
    retrievePaginated: vi.fn().mockResolvedValue({ kind: "ok", value: { results: [], totalCount: 0, page: 1, pageSize: 10, hasMore: false } }),
    retrieveSemantic: vi.fn().mockResolvedValue({ kind: "ok", value: [] }),
    retrieveFromChat: vi.fn().mockResolvedValue({ kind: "ok", value: [] }),
    archiveOldEntries: vi.fn().mockResolvedValue({ kind: "ok", value: 0 }),
    compact: vi.fn().mockResolvedValue({ kind: "ok", value: { freedBytes: 0 } }),
    getHealth: vi.fn().mockReturnValue({ healthy: true, issues: [], storageUsagePercent: 0, indexHealth: "healthy" }),
    export: vi.fn().mockResolvedValue({ kind: "ok", value: {} }),
    import: vi.fn().mockResolvedValue({ kind: "ok", value: 0 }),
    ...overrides,
  };
}

describe("MemorySearchTool", () => {
  it("returns error when query is empty", async () => {
    const mm = createMockMemoryManager();
    const tool = new MemorySearchTool(mm);
    const result = await tool.execute({ query: "" }, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("'query' is required");
  });

  it("returns no-results message when nothing found", async () => {
    const mm = createMockMemoryManager({
      retrieve: vi.fn().mockResolvedValue({ kind: "ok", value: [] }),
      getStats: vi.fn().mockReturnValue({
        totalEntries: 5,
        entriesByType: { conversation: 3, analysis: 0, note: 2, command: 0, error: 0, insight: 0, task: 0 },
        entriesByImportance: { low: 2, medium: 2, high: 1, critical: 0 },
        conversationCount: 3,
        noteCount: 2,
        errorCount: 0,
        archivedCount: 0,
        hasAnalysisCache: false,
        storageSizeBytes: 0,
        averageQueryTimeMs: 0,
      }),
    });
    const tool = new MemorySearchTool(mm);
    const result = await tool.execute({ query: "combat system" }, createToolContext());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("No relevant memories found");
    expect(result.content).toContain("5 total entries");
  });

  it("returns formatted results when memories found", async () => {
    const mockEntry: MemoryEntry = {
      id: "mem_test-id",
      type: "conversation",
      chatId: "chat1",
      content: "Created DamageSystem for combat module",
      createdAt: Date.now(),
      termVector: {},
      tags: ["combat"],
      accessCount: 1,
      importance: "medium",
      archived: false,
      metadata: {},
      userMessage: "",
    };

    const mm = createMockMemoryManager({
      retrieve: vi.fn().mockResolvedValue({
        kind: "ok",
        value: [{ entry: mockEntry, score: 0.85 }],
      }),
    });

    const tool = new MemorySearchTool(mm);
    const result = await tool.execute({ query: "damage system" }, createToolContext());

    expect(result.content).toContain("Found 1 relevant memory");
    expect(result.content).toContain("CONVERSATION");
    expect(result.content).toContain("85.0% match");
    expect(result.content).toContain("DamageSystem");
    expect(result.content).toContain("chat1");
    expect(result.content).toContain("combat");
  });

  it("passes type filter to memory manager", async () => {
    const mm = createMockMemoryManager();
    const tool = new MemorySearchTool(mm);

    await tool.execute({ query: "test", type: "note" }, createToolContext());

    expect(mm.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      mode: "text",
      query: "test",
      types: ["note"],
    }));
  });

  it("clamps limit to max 10", async () => {
    const mm = createMockMemoryManager();
    const tool = new MemorySearchTool(mm);

    await tool.execute({ query: "test", limit: 50 }, createToolContext());
    expect(mm.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      query: "test",
      limit: 10,
    }));
  });

  it("clamps limit to min 1", async () => {
    const mm = createMockMemoryManager();
    const tool = new MemorySearchTool(mm);

    await tool.execute({ query: "test", limit: 0 }, createToolContext());
    expect(mm.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      query: "test",
      limit: 1,
    }));
  });

  it("handles memory search failure gracefully", async () => {
    const mm = createMockMemoryManager({
      retrieve: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const tool = new MemorySearchTool(mm);
    const result = await tool.execute({ query: "test" }, createToolContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("memory search failed");
  });
});
