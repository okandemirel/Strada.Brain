import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { join } from "node:path";
import { createTempDirTracker } from "../test-helpers.js";
import { SqliteVaultStore } from "./sqlite-vault-store.js";
import type { VaultFile, VaultChunk, VaultSymbol, VaultEdge, VaultWikilink } from "./vault.interface.js";

// =============================================================================
// HELPERS
// =============================================================================

const tmp = createTempDirTracker("sqlite-vault-test-");
afterAll(() => tmp.cleanup());

function makeDbPath(): string {
  return join(tmp.makeDir(), "vault.db");
}

function makeFile(overrides: Partial<VaultFile> = {}): VaultFile {
  return {
    path: "src/Foo.cs",
    blobHash: "abc123",
    mtimeMs: 1_700_000_000_000,
    size: 512,
    lang: "csharp",
    kind: "source",
    indexedAt: 1_700_000_001_000,
    ...overrides,
  };
}

function makeChunk(overrides: Partial<VaultChunk> = {}): VaultChunk {
  return {
    chunkId: "chunk-001",
    path: "src/Foo.cs",
    startLine: 1,
    endLine: 20,
    content: "public class Foo implements IBar zortblax",
    tokenCount: 42,
    ...overrides,
  };
}

function makeSymbol(overrides: Partial<VaultSymbol> = {}): VaultSymbol {
  return {
    symbolId: "sym-001",
    path: "src/Foo.cs",
    kind: "class",
    name: "Foo",
    display: "Foo (class)",
    startLine: 1,
    endLine: 100,
    doc: "The Foo class.",
    ...overrides,
  };
}

function makeEdge(overrides: Partial<VaultEdge> = {}): VaultEdge {
  return {
    fromSymbol: "sym-001",
    toSymbol: "sym-002",
    kind: "calls",
    atLine: 42,
    ...overrides,
  };
}

function makeWikilink(overrides: Partial<VaultWikilink> = {}): VaultWikilink {
  return {
    fromNote: "notes/A.md",
    target: "notes/B.md",
    resolved: false,
    ...overrides,
  };
}

// =============================================================================
// TESTS — migrate
// =============================================================================

describe("SqliteVaultStore — migrate", () => {
  it("runs without throwing on a fresh DB", () => {
    const store = new SqliteVaultStore(makeDbPath());
    expect(() => store.migrate()).not.toThrow();
    store.close();
  });

  it("is idempotent: calling migrate() twice on the same instance does not throw", () => {
    const store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    expect(() => store.migrate()).not.toThrow();
    store.close();
  });

  it("creates the expected tables", () => {
    const store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    const tables = store.listTableNamesForTest();
    expect(tables).toContain("vault_files");
    expect(tables).toContain("vault_chunks");
    expect(tables).toContain("vault_symbols");
    expect(tables).toContain("vault_edges");
    expect(tables).toContain("vault_wikilinks");
    expect(tables).toContain("vault_frontmatter");
    expect(tables).toContain("vault_tags");
    expect(tables).toContain("vault_meta");
    store.close();
  });

  it("seeds vault_meta with indexer_version", () => {
    const store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    expect(store.getMeta("indexer_version")).toBe("phase2.v1");
    store.close();
  });
});

// =============================================================================
// TESTS — upsertFile / getFile / listFiles / deleteFile
// =============================================================================

describe("SqliteVaultStore — file CRUD", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
  });

  afterAll(() => {
    // Individual stores are closed per-test via a separate afterEach-style guard;
    // the tmp tracker handles dir removal in the suite-level afterAll above.
  });

  it("upsertFile + getFile round-trips all fields", () => {
    const f = makeFile();
    store.upsertFile(f);
    const got = store.getFile(f.path);
    expect(got).toEqual(f);
    store.close();
  });

  it("getFile returns null for an unknown path", () => {
    expect(store.getFile("does/not/exist.cs")).toBeNull();
    store.close();
  });

  it("upsertFile is idempotent: second call updates the row", () => {
    store.upsertFile(makeFile({ blobHash: "old" }));
    store.upsertFile(makeFile({ blobHash: "new" }));
    expect(store.getFile("src/Foo.cs")!.blobHash).toBe("new");
    store.close();
  });

  it("listFiles returns all files ordered by path when no filter", () => {
    store.upsertFile(makeFile({ path: "src/Z.ts", lang: "typescript", kind: "source" }));
    store.upsertFile(makeFile({ path: "src/A.cs" }));
    const list = store.listFiles();
    expect(list.map((f) => f.path)).toEqual(["src/A.cs", "src/Z.ts"]);
    store.close();
  });

  it("listFiles filters by lang correctly", () => {
    store.upsertFile(makeFile({ path: "src/Foo.cs", lang: "csharp" }));
    store.upsertFile(makeFile({ path: "src/Bar.ts", lang: "typescript", kind: "source" }));
    store.upsertFile(makeFile({ path: "README.md", lang: "markdown", kind: "doc" }));

    const cs = store.listFiles({ lang: ["csharp"] });
    expect(cs).toHaveLength(1);
    expect(cs[0]!.lang).toBe("csharp");

    const multi = store.listFiles({ lang: ["csharp", "typescript"] });
    expect(multi).toHaveLength(2);
    store.close();
  });

  it("deleteFile removes the file row", () => {
    store.upsertFile(makeFile());
    store.deleteFile("src/Foo.cs");
    expect(store.getFile("src/Foo.cs")).toBeNull();
    store.close();
  });
});

// =============================================================================
// TESTS — upsertChunk / getChunk / chunkCount
// =============================================================================

describe("SqliteVaultStore — chunks", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    store.upsertFile(makeFile());
  });

  it("upsertChunk + getChunk round-trips all fields", () => {
    const c = makeChunk();
    store.upsertChunk(c);
    const got = store.getChunk(c.chunkId);
    expect(got).toEqual(c);
    store.close();
  });

  it("getChunk returns null for an unknown chunkId", () => {
    expect(store.getChunk("no-such-chunk")).toBeNull();
    store.close();
  });

  it("chunkCount reflects the number of stored chunks", () => {
    expect(store.chunkCount()).toBe(0);
    store.upsertChunk(makeChunk({ chunkId: "c1" }));
    expect(store.chunkCount()).toBe(1);
    store.upsertChunk(makeChunk({ chunkId: "c2", startLine: 21, endLine: 40 }));
    expect(store.chunkCount()).toBe(2);
    store.close();
  });

  it("upsertChunk is idempotent: second call with same chunkId replaces the row", () => {
    store.upsertChunk(makeChunk({ content: "old content" }));
    store.upsertChunk(makeChunk({ content: "new content" }));
    expect(store.getChunk("chunk-001")!.content).toBe("new content");
    expect(store.chunkCount()).toBe(1);
    store.close();
  });
});

// =============================================================================
// TESTS — searchFts
// =============================================================================

describe("SqliteVaultStore — FTS search", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    store.upsertFile(makeFile());
    store.upsertChunk(makeChunk({
      chunkId: "fts-chunk",
      content: "public class Foo implements IBar zortblax",
    }));
  });

  it("returns a hit for a word present in the indexed content", () => {
    const hits = store.searchFts("zortblax", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunkId).toBe("fts-chunk");
  });

  it("returns a positive score for the hit (negated BM25)", () => {
    const hits = store.searchFts("zortblax", 5);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("returns [] for a word not present in the index", () => {
    const hits = store.searchFts("absolutely-missing-word-xyz", 5);
    expect(hits).toHaveLength(0);
    store.close();
  });

  it("returns [] (no throw) for a malformed FTS5 query", () => {
    // FTS5 would throw on bare operators like AND at the start.
    expect(() => store.searchFts("AND OR", 5)).not.toThrow();
    const hits = store.searchFts("AND OR", 5);
    expect(Array.isArray(hits)).toBe(true);
    store.close();
  });

  it("respects the topK limit", () => {
    store.upsertFile(makeFile({ path: "src/B.cs" }));
    store.upsertChunk(makeChunk({ chunkId: "c2", path: "src/B.cs", content: "zortblax second" }));
    const hits = store.searchFts("zortblax", 1);
    expect(hits).toHaveLength(1);
    store.close();
  });
});

// =============================================================================
// TESTS — persistence (re-open same DB)
// =============================================================================

describe("SqliteVaultStore — persistence across re-open", () => {
  it("data written by one instance is readable by a new instance on the same path", () => {
    const dbPath = makeDbPath();

    const s1 = new SqliteVaultStore(dbPath);
    s1.migrate();
    s1.upsertFile(makeFile({ path: "persist/Test.cs", blobHash: "hash-persist" }));
    s1.close();

    const s2 = new SqliteVaultStore(dbPath);
    s2.migrate();
    const got = s2.getFile("persist/Test.cs");
    expect(got).not.toBeNull();
    expect(got!.blobHash).toBe("hash-persist");
    s2.close();
  });
});

// =============================================================================
// TESTS — symbols
// =============================================================================

describe("SqliteVaultStore — symbols", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    store.upsertFile(makeFile());
  });

  it("upsertSymbol + listSymbolsForPath round-trips all fields", () => {
    const s = makeSymbol();
    store.upsertSymbol(s);
    const list = store.listSymbolsForPath("src/Foo.cs");
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(s);
    store.close();
  });

  it("listSymbolsForPath returns [] for a path with no symbols", () => {
    expect(store.listSymbolsForPath("src/NoSymbols.cs")).toEqual([]);
    store.close();
  });

  it("findSymbolsByName finds the symbol by exact name", () => {
    store.upsertSymbol(makeSymbol({ symbolId: "sym-001", name: "Foo" }));
    store.upsertSymbol(makeSymbol({ symbolId: "sym-002", name: "Bar" }));
    const found = store.findSymbolsByName("Foo");
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("Foo");
    store.close();
  });

  it("findSymbolsByName returns [] when no symbol matches", () => {
    expect(store.findSymbolsByName("NoSuchSymbol")).toEqual([]);
    store.close();
  });

  it("upsertSymbol is idempotent: second call updates the row", () => {
    store.upsertSymbol(makeSymbol({ doc: "old doc" }));
    store.upsertSymbol(makeSymbol({ doc: "new doc" }));
    expect(store.listSymbolsForPath("src/Foo.cs")[0]!.doc).toBe("new doc");
    store.close();
  });

  it("symbolCount tracks the number of stored symbols", () => {
    expect(store.symbolCount()).toBe(0);
    store.upsertSymbol(makeSymbol());
    expect(store.symbolCount()).toBe(1);
    store.close();
  });

  it("symbol with null doc round-trips correctly", () => {
    store.upsertSymbol(makeSymbol({ doc: null }));
    expect(store.listSymbolsForPath("src/Foo.cs")[0]!.doc).toBeNull();
    store.close();
  });
});

// =============================================================================
// TESTS — edges
// =============================================================================

describe("SqliteVaultStore — edges", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    store.upsertFile(makeFile());
    store.upsertFile(makeFile({ path: "src/Bar.cs" }));
    // sym-001 in Foo.cs, sym-002 in Bar.cs
    store.upsertSymbol(makeSymbol({ symbolId: "sym-001", path: "src/Foo.cs" }));
    store.upsertSymbol(makeSymbol({ symbolId: "sym-002", path: "src/Bar.cs", name: "Bar", display: "Bar (class)" }));
  });

  it("upsertEdge + findCallersOf returns the edge", () => {
    store.upsertEdge(makeEdge());
    const callers = store.findCallersOf("sym-002");
    expect(callers).toHaveLength(1);
    expect(callers[0]).toEqual(makeEdge());
    store.close();
  });

  it("findCallersOf returns [] when there are no callers", () => {
    expect(store.findCallersOf("sym-999")).toEqual([]);
    store.close();
  });

  it("listEdges returns all edges", () => {
    store.upsertEdge(makeEdge({ fromSymbol: "sym-001", toSymbol: "sym-002", kind: "calls", atLine: 10 }));
    store.upsertEdge(makeEdge({ fromSymbol: "sym-001", toSymbol: "sym-002", kind: "calls", atLine: 20 }));
    expect(store.listEdges()).toHaveLength(2);
    store.close();
  });

  it("upsertEdge is idempotent for the same (from, to, kind, atLine) composite key", () => {
    store.upsertEdge(makeEdge());
    store.upsertEdge(makeEdge()); // exact same key — ON CONFLICT DO NOTHING
    expect(store.listEdges()).toHaveLength(1);
    store.close();
  });
});

// =============================================================================
// TESTS — wikilinks
// =============================================================================

describe("SqliteVaultStore — wikilinks", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
  });

  it("upsertWikilink + listWikilinks round-trips an unresolved link", () => {
    const w = makeWikilink();
    store.upsertWikilink(w);
    const list = store.listWikilinks();
    expect(list).toHaveLength(1);
    expect(list[0]!.fromNote).toBe("notes/A.md");
    expect(list[0]!.target).toBe("notes/B.md");
    expect(list[0]!.resolved).toBe(false);
    expect(list[0]!.originalTarget).toBeNull();
    store.close();
  });

  it("listWikilinksTo returns only links pointing to the given target", () => {
    store.upsertWikilink(makeWikilink({ fromNote: "notes/A.md", target: "notes/B.md" }));
    store.upsertWikilink(makeWikilink({ fromNote: "notes/C.md", target: "notes/B.md" }));
    store.upsertWikilink(makeWikilink({ fromNote: "notes/A.md", target: "notes/D.md" }));
    const to = store.listWikilinksTo("notes/B.md");
    expect(to).toHaveLength(2);
    expect(to.map((w) => w.fromNote).sort()).toEqual(["notes/A.md", "notes/C.md"]);
    store.close();
  });

  it("updateWikilinkTarget re-keys the row with the resolved path and stores the original token", () => {
    store.upsertWikilink(makeWikilink({ fromNote: "notes/A.md", target: "B" }));
    store.updateWikilinkTarget("notes/A.md", "B", "notes/B.md", "B");

    // Old unresolved row should be gone.
    expect(store.listWikilinksTo("B")).toHaveLength(0);

    // New resolved row should exist under the new target.
    const newRows = store.listWikilinksTo("notes/B.md");
    expect(newRows).toHaveLength(1);
    expect(newRows[0]!.resolved).toBe(true);
    expect(newRows[0]!.originalTarget).toBe("B");
    store.close();
  });

  it("upsertWikilink is idempotent: second call with same (fromNote, target) updates resolved", () => {
    store.upsertWikilink(makeWikilink({ resolved: false }));
    store.upsertWikilink(makeWikilink({ resolved: true }));
    const list = store.listWikilinks();
    expect(list).toHaveLength(1);
    expect(list[0]!.resolved).toBe(true);
    store.close();
  });
});

// =============================================================================
// TESTS — tags
// =============================================================================

describe("SqliteVaultStore — tags", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    store.upsertFile(makeFile());
  });

  it("upsertTag + listTagsByPath returns the stored tags", () => {
    store.upsertTag("src/Foo.cs", "unity");
    store.upsertTag("src/Foo.cs", "gameplay");
    const tags = store.listTagsByPath("src/Foo.cs");
    expect(tags.sort()).toEqual(["gameplay", "unity"]);
    store.close();
  });

  it("listTagsByPath returns [] for a path with no tags", () => {
    expect(store.listTagsByPath("src/Foo.cs")).toEqual([]);
    store.close();
  });

  it("upsertTag is idempotent: duplicate (path, tag) is silently ignored", () => {
    store.upsertTag("src/Foo.cs", "unity");
    store.upsertTag("src/Foo.cs", "unity");
    expect(store.listTagsByPath("src/Foo.cs")).toHaveLength(1);
    store.close();
  });

  it("findPathsByTag returns paths that have the given tag", () => {
    store.upsertFile(makeFile({ path: "src/Bar.cs" }));
    store.upsertTag("src/Foo.cs", "unity");
    store.upsertTag("src/Bar.cs", "unity");
    store.upsertTag("src/Bar.cs", "gameplay");
    const paths = store.findPathsByTag("unity").sort();
    expect(paths).toEqual(["src/Bar.cs", "src/Foo.cs"]);
    store.close();
  });

  it("deleteTagsByPath removes all tags for the given path", () => {
    store.upsertTag("src/Foo.cs", "unity");
    store.upsertTag("src/Foo.cs", "gameplay");
    store.deleteTagsByPath("src/Foo.cs");
    expect(store.listTagsByPath("src/Foo.cs")).toEqual([]);
    store.close();
  });
});

// =============================================================================
// TESTS — frontmatter
// =============================================================================

describe("SqliteVaultStore — frontmatter", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    store.upsertFile(makeFile());
  });

  it("upsertFrontmatter + listFrontmatterByPath returns the stored key/value pairs", () => {
    store.upsertFrontmatter("src/Foo.cs", "title", "Foo Module");
    store.upsertFrontmatter("src/Foo.cs", "author", "Alice");
    const fm = store.listFrontmatterByPath("src/Foo.cs");
    expect(fm).toEqual({ title: "Foo Module", author: "Alice" });
    store.close();
  });

  it("listFrontmatterByPath returns {} for a path with no frontmatter", () => {
    expect(store.listFrontmatterByPath("src/Foo.cs")).toEqual({});
    store.close();
  });

  it("upsertFrontmatter is idempotent: second call with same key updates the value", () => {
    store.upsertFrontmatter("src/Foo.cs", "title", "Old");
    store.upsertFrontmatter("src/Foo.cs", "title", "New");
    expect(store.listFrontmatterByPath("src/Foo.cs")).toEqual({ title: "New" });
    store.close();
  });

  it("deleteFrontmatterByPath removes all frontmatter for the path", () => {
    store.upsertFrontmatter("src/Foo.cs", "title", "Foo Module");
    store.deleteFrontmatterByPath("src/Foo.cs");
    expect(store.listFrontmatterByPath("src/Foo.cs")).toEqual({});
    store.close();
  });
});

// =============================================================================
// TESTS — deleteFile cascade
// =============================================================================

describe("SqliteVaultStore — deleteFile cascades child data", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();

    store.upsertFile(makeFile({ path: "src/Foo.cs" }));
    store.upsertFile(makeFile({ path: "src/Bar.cs" }));

    store.upsertChunk(makeChunk({ chunkId: "c1", path: "src/Foo.cs" }));
    store.upsertSymbol(makeSymbol({ symbolId: "sym-foo", path: "src/Foo.cs", name: "Foo" }));
    store.upsertSymbol(makeSymbol({ symbolId: "sym-bar", path: "src/Bar.cs", name: "Bar" }));
    store.upsertEdge(makeEdge({ fromSymbol: "sym-foo", toSymbol: "sym-bar", kind: "calls", atLine: 10 }));
    store.upsertWikilink(makeWikilink({ fromNote: "src/Foo.cs", target: "notes/B.md" }));
    store.upsertFrontmatter("src/Foo.cs", "title", "Foo");
    store.upsertTag("src/Foo.cs", "unity");
  });

  it("removes the chunk after the file is deleted", () => {
    store.deleteFile("src/Foo.cs");
    expect(store.chunkCount()).toBe(0);
    expect(store.getChunk("c1")).toBeNull();
    store.close();
  });

  it("removes symbols belonging to the deleted file", () => {
    store.deleteFile("src/Foo.cs");
    expect(store.listSymbolsForPath("src/Foo.cs")).toHaveLength(0);
    store.close();
  });

  it("removes edges whose fromSymbol belongs to the deleted file", () => {
    store.deleteFile("src/Foo.cs");
    expect(store.listEdges()).toHaveLength(0);
    store.close();
  });

  it("removes wikilinks originating from the deleted file", () => {
    store.deleteFile("src/Foo.cs");
    expect(store.listWikilinks()).toHaveLength(0);
    store.close();
  });

  it("chunkCount returns 0 after the only file is deleted", () => {
    store.deleteFile("src/Foo.cs");
    expect(store.chunkCount()).toBe(0);
    store.close();
  });

  it("deleteFile is a no-op for a path that does not exist", () => {
    expect(() => store.deleteFile("nonexistent/path.cs")).not.toThrow();
    store.close();
  });
});

// =============================================================================
// TESTS — runReindexTxn
// =============================================================================

describe("SqliteVaultStore — runReindexTxn", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
  });

  function fullInput(pathOverride = "src/Foo.cs") {
    return {
      path: pathOverride,
      file: makeFile({ path: pathOverride }),
      chunks: [makeChunk({ chunkId: "r-c1", path: pathOverride })],
      symbols: [makeSymbol({ symbolId: "r-sym-1", path: pathOverride })],
      edges: [] as VaultEdge[],
      wikilinks: [makeWikilink({ fromNote: pathOverride, target: "notes/B.md" })],
      frontmatter: { title: "Reindexed" },
      tags: ["unity", "test"],
    };
  }

  it("returns { ok: true } on success", () => {
    const result = store.runReindexTxn(fullInput());
    expect(result).toEqual({ ok: true });
    store.close();
  });

  it("persists the file, chunk, symbol, wikilink, frontmatter, and tags", () => {
    store.runReindexTxn(fullInput());
    expect(store.getFile("src/Foo.cs")).not.toBeNull();
    expect(store.chunkCount()).toBe(1);
    expect(store.listSymbolsForPath("src/Foo.cs")).toHaveLength(1);
    expect(store.listWikilinks()).toHaveLength(1);
    expect(store.listFrontmatterByPath("src/Foo.cs")).toEqual({ title: "Reindexed" });
    expect(store.listTagsByPath("src/Foo.cs").sort()).toEqual(["test", "unity"]);
    store.close();
  });

  it("second call on the same path replaces all data cleanly", () => {
    store.runReindexTxn(fullInput());

    const second = {
      ...fullInput(),
      chunks: [makeChunk({ chunkId: "r-c2", path: "src/Foo.cs", content: "updated content" })],
      symbols: [makeSymbol({ symbolId: "r-sym-2", path: "src/Foo.cs", name: "FooV2" })],
      frontmatter: { description: "v2" },
      tags: ["v2"],
    };
    store.runReindexTxn(second);

    expect(store.chunkCount()).toBe(1);
    expect(store.getChunk("r-c2")).not.toBeNull();
    expect(store.getChunk("r-c1")).toBeNull();
    expect(store.listSymbolsForPath("src/Foo.cs")[0]!.name).toBe("FooV2");
    expect(store.listFrontmatterByPath("src/Foo.cs")).toEqual({ description: "v2" });
    expect(store.listTagsByPath("src/Foo.cs")).toEqual(["v2"]);
    store.close();
  });

  it("clears frontmatter and tags when their inputs are null (cascade from file delete)", () => {
    store.runReindexTxn(fullInput());
    store.runReindexTxn({
      ...fullInput(),
      frontmatter: null,
      tags: null,
    });
    // The transaction deletes and re-inserts the file row, which cascades to
    // frontmatter and tags. Passing null skips the re-insert step, so they are
    // empty after the second call — this is the actual characterised behaviour.
    expect(store.listTagsByPath("src/Foo.cs")).toEqual([]);
    expect(store.listFrontmatterByPath("src/Foo.cs")).toEqual({});
    store.close();
  });

  it("returns { ok: false } when a constraint is violated inside the transaction", () => {
    // Upsert an edge referencing a symbol that does NOT exist in vault_symbols
    // to trigger a FK violation inside the txn.
    const badEdge: VaultEdge = { fromSymbol: "ghost-sym", toSymbol: "ghost-sym2", kind: "calls", atLine: 1 };
    const result = store.runReindexTxn({ ...fullInput(), edges: [badEdge] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
    store.close();
  });
});

// =============================================================================
// TESTS — embeddings
// =============================================================================

describe("SqliteVaultStore — embeddings", () => {
  let store: SqliteVaultStore;

  beforeEach(() => {
    store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    store.upsertFile(makeFile());
    store.upsertChunk(makeChunk({ chunkId: "emb-chunk" }));
  });

  it("upsertEmbedding + listHnswIdsForPath round-trips the hnsw_id", () => {
    store.upsertEmbedding("emb-chunk", 7, 384, "text-embedding-3-small");
    const ids = store.listHnswIdsForPath("src/Foo.cs");
    expect(ids).toEqual([7]);
    store.close();
  });

  it("listHnswIdsForPath returns [] when no embeddings are stored", () => {
    expect(store.listHnswIdsForPath("src/Foo.cs")).toEqual([]);
    store.close();
  });

  it("upsertEmbedding is idempotent: second call updates the row", () => {
    store.upsertEmbedding("emb-chunk", 7, 384, "model-v1");
    store.upsertEmbedding("emb-chunk", 42, 768, "model-v2");
    expect(store.listHnswIdsForPath("src/Foo.cs")).toEqual([42]);
    store.close();
  });
});

// =============================================================================
// TESTS — close
// =============================================================================

describe("SqliteVaultStore — close", () => {
  it("close() is idempotent: calling it twice does not throw", () => {
    const store = new SqliteVaultStore(makeDbPath());
    store.migrate();
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
