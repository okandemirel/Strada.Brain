import { describe, it, expect, vi } from "vitest";
import { MemorySearchTool } from "./memory-search.js";
import { createToolContext } from "../../test-helpers.js";
import type { IMemoryManager, MemoryEntry, RetrievalResult } from "../../memory/memory.interface.js";

function createMockMemoryManager(overrides?: Partial<IMemoryManager>): IMemoryManager {
  return {
    initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    cacheAnalysis: vi.fn().mockResolvedValue(undefined),
    getCachedAnalysis: vi.fn().mockResolvedValue(null),
    storeConversation: vi.fn().mockResolvedValue(undefined),
    storeNote: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn<() => Promise<RetrievalResult[]>>().mockResolvedValue([]),
    getChatHistory: vi.fn<() => Promise<MemoryEntry[]>>().mockResolvedValue([]),
    getStats: vi.fn().mockReturnValue({
      totalEntries: 0,
      conversationCount: 0,
      noteCount: 0,
      hasAnalysisCache: false,
    }),
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
      retrieve: vi.fn().mockResolvedValue([]),
      getStats: vi.fn().mockReturnValue({
        totalEntries: 5,
        conversationCount: 3,
        noteCount: 2,
        hasAnalysisCache: false,
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
      id: "test-id",
      type: "conversation",
      chatId: "chat1",
      content: "Created DamageSystem for combat module",
      createdAt: new Date("2025-06-15"),
      termVector: {},
      tags: ["combat"],
    };

    const mm = createMockMemoryManager({
      retrieve: vi.fn().mockResolvedValue([
        { entry: mockEntry, score: 0.85 },
      ]),
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

    expect(mm.retrieve).toHaveBeenCalledWith("test", expect.objectContaining({
      type: "note",
    }));
  });

  it("clamps limit to max 10", async () => {
    const mm = createMockMemoryManager();
    const tool = new MemorySearchTool(mm);

    await tool.execute({ query: "test", limit: 50 }, createToolContext());
    expect(mm.retrieve).toHaveBeenCalledWith("test", expect.objectContaining({
      limit: 10,
    }));
  });

  it("clamps limit to min 1", async () => {
    const mm = createMockMemoryManager();
    const tool = new MemorySearchTool(mm);

    await tool.execute({ query: "test", limit: 0 }, createToolContext());
    expect(mm.retrieve).toHaveBeenCalledWith("test", expect.objectContaining({
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
