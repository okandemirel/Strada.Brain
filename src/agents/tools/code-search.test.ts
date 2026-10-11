import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeSearchTool } from "./code-search.js";
import { GrepSearchTool } from "./search.js";
import { createToolContext } from "../../test-helpers.js";
import type {
  CodeChunk,
  IRAGPipeline,
  RAGSearchResult,
  IndexingStats,
  IEmbeddingProvider,
  IVectorStore,
  VectorSearchHit,
} from "../../rag/rag.interface.js";
import { RAGPipeline } from "../../rag/rag-pipeline.js";
import { FileVectorStore } from "../../rag/vector-store.js";
import { _simulateMissingHnswForTests } from "../../rag/hnsw/hnsw-vector-store.js";

// FileVectorStore logs through getLogger(), which throws until a logger exists.
vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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

  // Audit tools#4: file_pattern is offered as a glob ('**/Combat/**') but was
  // matched as a literal substring of a cwd-relative path, so the schema's own
  // example answered "No results found" about code that exists.
  describe("file_pattern", () => {
    const ctx = createToolContext({ projectPath: "/game" });

    function pipelineOver(hits: VectorSearchHit[]): RAGPipeline {
      const embedder: IEmbeddingProvider = {
        name: "stub",
        dimensions: 4,
        embed: vi.fn(async (texts: string[]) => ({
          embeddings: texts.map(() => [1, 0, 0, 0]),
          usage: { totalTokens: 1 },
        })),
      };
      const store = {
        initialize: vi.fn(),
        shutdown: vi.fn(),
        search: vi.fn(async (_v: number[], k: number) => hits.slice(0, k)),
        count: () => hits.length,
      } as unknown as IVectorStore;
      return new RAGPipeline(embedder, store, { useHNSW: false });
    }

    function hit(id: string, filePath: string, score: number): VectorSearchHit {
      return { score, chunk: { ...makeResult().chunk, id, filePath, content: `damage ${id}` } } as VectorSearchHit;
    }

    it("restricts a real search to the files the glob names, relative to the project", async () => {
      const tool = new CodeSearchTool(pipelineOver([
        hit("hud", "/game/Assets/Scripts/UI/Hud.cs", 0.9),
        hit("damage", "/game/Assets/Scripts/Combat/Damage.cs", 0.8),
      ]));

      const result = await tool.execute({ query: "damage calculation", file_pattern: "**/Combat/**" }, ctx);

      expect(result.content).toContain("Found 1 result(s)");
      expect(result.content).toContain("/game/Assets/Scripts/Combat/Damage.cs");
      expect(result.content).not.toContain("Hud.cs");
      expect(result.content).toContain("'**/Combat/**'");
    });

    it("passes the project root the glob is relative to", async () => {
      const rag = createMockRAG();
      await new CodeSearchTool(rag).execute({ query: "damage", file_pattern: "Assets/**" }, ctx);
      expect(rag.search).toHaveBeenCalledWith(
        "damage",
        expect.objectContaining({ filePattern: "Assets/**", filePatternRoot: "/game" }),
      );
    });

    it("a miss names the pattern and says files outside it were not searched", async () => {
      const tool = new CodeSearchTool(pipelineOver([hit("hud", "/game/Assets/Scripts/UI/Hud.cs", 0.9)]));

      const result = await tool.execute({ query: "damage calculation", file_pattern: "**/Combat/**" }, ctx);

      expect(result.content).toMatch(/^No results found for: "damage calculation" in files matching '\*\*\/Combat\/\*\*'/);
      expect(result.content).toMatch(/outside that pattern were NOT searched/);
    });

    // Without hnswlib-node the pipeline searches FileVectorStore, whose JS
    // HNSW graph took over past 100 chunks and reached 36 of 400 of them, so
    // the scoped search missed its exact nearest neighbour and answered "No
    // results found ... Files outside that pattern were NOT searched".
    it("finds the in-scope chunk through the FileVectorStore fallback past 100 chunks", async () => {
      const dir = await mkdtemp(join(tmpdir(), "code-search-file-store-"));
      _simulateMissingHnswForTests(true);
      try {
        const dims = 8;
        let seed = 11;
        const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
        const store = new FileVectorStore(dir, dims);
        const query = Array.from({ length: dims }, next);
        const embedder: IEmbeddingProvider = {
          name: "stub",
          dimensions: dims,
          embed: vi.fn(async (texts: string[]) => ({ embeddings: texts.map(() => query), usage: { totalTokens: 1 } })),
        };
        const rag = new RAGPipeline(embedder, store);
        await rag.initialize();
        const chunk = (id: string, filePath: string) =>
          ({ ...makeResult().chunk, id, filePath, content: `damage ${id}` }) as CodeChunk;
        await store.upsert([
          ...Array.from({ length: 399 }, (_, i) => ({
            id: `ui-${i}`,
            vector: Array.from({ length: dims }, next),
            chunk: chunk(`ui-${i}`, `/game/Assets/Scripts/UI/Panel${i}.cs`),
          })),
          { id: "damage", vector: query, chunk: chunk("damage", "/game/Assets/Scripts/Combat/Damage.cs") },
        ]);

        const result = await new CodeSearchTool(rag).execute(
          { query: "damage calculation", file_pattern: "**/Combat/**" },
          ctx,
        );

        expect(result.content).toContain("Found 1 result(s)");
        expect(result.content).toContain("/game/Assets/Scripts/Combat/Damage.cs");
        await rag.shutdown();
      } finally {
        _simulateMissingHnswForTests(null);
        await rm(dir, { recursive: true, force: true });
      }
    });

    // The schema says file_pattern works as in grep_search, whose glob is
    // case-insensitive on macOS and Windows; code_search's was case-sensitive
    // everywhere, so '**/combat/**' found Combat in one tool and not the other.
    it("matches a file_pattern with grep_search's case rule on this platform", async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "code-search-case-")));
      try {
        const file = join(dir, "Assets", "Combat", "Damage.cs");
        await mkdir(join(dir, "Assets", "Combat"), { recursive: true });
        await writeFile(file, "class Damage { int damage; }\n");
        const project = createToolContext({ projectPath: dir, workingDirectory: dir });

        const grep = await new GrepSearchTool().execute({ pattern: "damage", file_pattern: "**/combat/**" }, project);
        const code = await new CodeSearchTool(pipelineOver([hit("damage", file, 0.9)])).execute(
          { query: "damage", file_pattern: "**/combat/**" },
          project,
        );

        const grepFound = grep.content.includes("Damage.cs:1:");
        const codeFound = code.content.includes("Found 1 result(s)");
        expect(codeFound).toBe(grepFound);
        expect(grepFound).toBe(process.platform === "darwin" || process.platform === "win32");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses the file_pattern grep_search refuses, and one too costly to match, saying why", async () => {
      const rag = createMockRAG();
      const tool = new CodeSearchTool(rag);

      for (const pattern of ["../Secrets/**", "/Users/me/game/Assets/**"]) {
        const result = await tool.execute({ query: "damage", file_pattern: pattern }, ctx);
        expect(result.isError, pattern).toBe(true);
        expect(result.content).toContain("must not contain '..' or absolute paths");
      }
      const bomb = await tool.execute({ query: "damage", file_pattern: "{a,b}".repeat(12) }, ctx);
      expect(bomb.isError).toBe(true);
      expect(bomb.content).toMatch(/alternatives/);
      expect(rag.search).not.toHaveBeenCalled();
    });
  });
});
