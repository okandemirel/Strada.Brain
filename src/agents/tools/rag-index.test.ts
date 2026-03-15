import { describe, it, expect, vi, beforeEach } from "vitest";
import { RAGIndexTool } from "./rag-index.js";
import { createToolContext } from "../../test-helpers.js";
import type { IRAGPipeline, IndexingStats, RAGSearchResult } from "../../rag/rag.interface.js";

vi.mock("../../security/path-guard.js", () => ({
  validatePath: vi.fn().mockResolvedValue({ valid: true, fullPath: "/test/project" }),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("public class Foo {}"),
}));

import { readFile } from "node:fs/promises";

function createMockRAG(overrides?: Partial<IRAGPipeline>): IRAGPipeline {
  return {
    initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    indexFile: vi.fn<() => Promise<number>>().mockResolvedValue(3),
    removeFile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    indexProject: vi.fn<() => Promise<IndexingStats>>().mockResolvedValue({
      totalFiles: 42,
      totalChunks: 210,
      indexedAt: new Date().toISOString(),
      durationMs: 1500,
      changedFiles: 7,
    }),
    search: vi.fn<() => Promise<RAGSearchResult[]>>().mockResolvedValue([]),
    formatContext: vi.fn<() => string>().mockReturnValue(""),
    getStats: vi.fn<() => IndexingStats>().mockReturnValue({
      totalFiles: 42,
      totalChunks: 210,
      indexedAt: new Date().toISOString(),
      durationMs: 1500,
    }),
    ...overrides,
  };
}

describe("RAGIndexTool", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockResolvedValue("public class Foo {}" as any);
  });

  it("full project indexing returns stats", async () => {
    const rag = createMockRAG();
    const tool = new RAGIndexTool(rag);
    const result = await tool.execute({}, createToolContext());

    expect(result.isError).toBeUndefined();
    expect(rag.indexProject).toHaveBeenCalledWith("/test/project");
    expect(result.content).toContain("42 file(s)");
    expect(result.content).toContain("7 changed");
    expect(result.content).toContain("210 chunk(s)");
    expect(result.content).toContain("1.5s");
  });

  it("single file indexing returns chunk count", async () => {
    const rag = createMockRAG({
      indexFile: vi.fn().mockResolvedValue(5),
    });
    const tool = new RAGIndexTool(rag);
    const ctx = createToolContext();
    const result = await tool.execute({ file_path: "Assets/Player.cs" }, ctx);

    expect(result.isError).toBeUndefined();
    expect(rag.indexFile).toHaveBeenCalledWith(
      "/test/project/Assets/Player.cs",
      "public class Foo {}"
    );
    expect(result.content).toContain("5 chunk(s)");
    expect(result.content).toContain("Assets/Player.cs");
  });

  it("single file unchanged returns 'skipped' message", async () => {
    const rag = createMockRAG({
      indexFile: vi.fn().mockResolvedValue(0),
    });
    const tool = new RAGIndexTool(rag);
    const result = await tool.execute({ file_path: "Assets/Unchanged.cs" }, createToolContext());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Skipped");
    expect(result.content).toContain("no changes");
  });

  it("returns error on missing file", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );
    const rag = createMockRAG();
    const tool = new RAGIndexTool(rag);
    const result = await tool.execute({ file_path: "Assets/Missing.cs" }, createToolContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    expect(result.content).toContain("Assets/Missing.cs");
  });

  it("propagates indexFile errors", async () => {
    const rag = createMockRAG({
      indexFile: vi.fn().mockRejectedValue(new Error("embedding quota exceeded")),
    });
    const tool = new RAGIndexTool(rag);
    const result = await tool.execute({ file_path: "Assets/Player.cs" }, createToolContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed to index");
    expect(result.content).toContain("embedding quota exceeded");
  });

  it("propagates indexProject errors", async () => {
    const rag = createMockRAG({
      indexProject: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    const tool = new RAGIndexTool(rag);
    const result = await tool.execute({}, createToolContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("project indexing failed");
    expect(result.content).toContain("disk full");
  });
});
