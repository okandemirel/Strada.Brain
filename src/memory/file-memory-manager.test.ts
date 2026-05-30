import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileMemoryManager } from "./file-memory-manager.js";
import { withTempDir } from "../test-helpers.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StradaProjectAnalysis } from "../intelligence/strada-analyzer.js";
import { unwrap, isOk, isSome, isNone, unwrapOption } from "../types/index.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockAnalysis(): StradaProjectAnalysis {
  return {
    modules: [
      {
        name: "Combat",
        className: "CombatModuleConfig",
        filePath: "Assets/Modules/Combat/CombatModuleConfig.cs",
        namespace: "Game.Combat",
        systems: ["DamageSystem"],
        services: ["ICombatService"],
        dependencies: [],
        lineNumber: 5,
      },
    ],
    systems: [
      {
        name: "DamageSystem",
        filePath: "Assets/Modules/Combat/Systems/DamageSystem.cs",
        namespace: "Game.Combat",
        baseClass: "SystemBase",
        lineNumber: 8,
      },
    ],
    components: [
      {
        name: "Health",
        filePath: "Assets/Modules/Combat/Components/Health.cs",
        namespace: "Game.Combat",
        isReadonly: false,
        lineNumber: 3,
      },
    ],
    services: [],
    mediators: [],
    controllers: [],
    events: [],
    csFileCount: 10,
    analyzedAt: new Date(),
  };
}

describe("FileMemoryManager", () => {
  describe("initialization", () => {
    it("creates db directory on initialize", async () => {
      await withTempDir(async (dir) => {
        const dbPath = join(dir, "memory-db");
        const mm = new FileMemoryManager(dbPath);
        await mm.initialize();
        await mm.shutdown();

        // Directory should exist
        const { stat } = await import("node:fs/promises");
        const stats = await stat(dbPath);
        expect(stats.isDirectory()).toBe(true);
      });
    });

    it("starts with empty state", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        const stats = mm.getStats();
        expect(stats.totalEntries).toBe(0);
        expect(stats.conversationCount).toBe(0);
        expect(stats.noteCount).toBe(0);
        expect(stats.hasAnalysisCache).toBe(false);

        await mm.shutdown();
      });
    });

    it("persists and restores entries across restarts", async () => {
      await withTempDir(async (dir) => {
        const dbPath = join(dir, "db");

        // First instance: store data
        const mm1 = new FileMemoryManager(dbPath);
        await mm1.initialize();
        await mm1.storeConversation("chat1", "Discussed combat system design");
        await mm1.storeNote("Important: use SystemBase for ECS systems");
        await mm1.shutdown();

        // Second instance: verify data restored
        const mm2 = new FileMemoryManager(dbPath);
        await mm2.initialize();

        const stats = mm2.getStats();
        expect(stats.totalEntries).toBe(2);
        expect(stats.conversationCount).toBe(1);
        expect(stats.noteCount).toBe(1);

        await mm2.shutdown();
      });
    });
  });

  describe("conversation memory", () => {
    it("stores and retrieves conversation entries", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        await mm.storeConversation("chat1", "Created combat module with DamageSystem");
        await mm.storeConversation("chat1", "Added Health component with MaxHealth field");
        await mm.storeConversation("chat2", "Discussed inventory system design");

        const result = await mm.getChatHistory("chat1");
        expect(isOk(result)).toBe(true);
        const history = unwrap(result);
        expect(history).toHaveLength(2);
        expect(history[0]!.content).toContain("combat module");

        await mm.shutdown();
      });
    });

    it("limits chat history results", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        for (let i = 0; i < 5; i++) {
          await mm.storeConversation("chat1", `Message ${i}`);
        }

        const result = await mm.getChatHistory("chat1", { limit: 2 });
        expect(isOk(result)).toBe(true);
        const limited = unwrap(result);
        expect(limited).toHaveLength(2);
        // Should return the last 2 (newest first in the loop, unshift adds to front)
        expect(limited[0]!.content).toBe("Message 3");
        expect(limited[1]!.content).toBe("Message 4");

        await mm.shutdown();
      });
    });
  });

  describe("note memory", () => {
    it("stores notes with tags", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        await mm.storeNote("Use EntityMediator for ECS-View bridge", ["architecture", "ecs"]);

        const stats = mm.getStats();
        expect(stats.noteCount).toBe(1);

        await mm.shutdown();
      });
    });
  });

  describe("retrieval (TF-IDF)", () => {
    it("finds relevant entries by query", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        await mm.storeConversation("c1", "Created DamageSystem using SystemBase for combat calculations");
        await mm.storeConversation("c1", "Added Health component with MaxHealth and CurrentHealth fields");
        await mm.storeNote("Inventory system uses ItemData ScriptableObjects");

        const result = await mm.retrieve({ mode: "text", query: "damage system combat" });
        expect(isOk(result)).toBe(true);
        const results = unwrap(result);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]!.entry.content).toContain("DamageSystem");
        expect(results[0]!.score).toBeGreaterThan(0);

        await mm.shutdown();
      });
    });

    it("filters by type", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        await mm.storeConversation("c1", "Combat module discussion");
        await mm.storeNote("Combat architecture note");

        const result = await mm.retrieve({ mode: "type", types: ["note"], query: "combat" });
        expect(isOk(result)).toBe(true);
        const results = unwrap(result);
        expect(results.every((r) => r.entry.type === "note")).toBe(true);

        await mm.shutdown();
      });
    });

    it("filters by chatId", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        await mm.storeConversation("chat-a", "Combat design chat A");
        await mm.storeConversation("chat-b", "Combat design chat B");

        const result = await mm.retrieve({ mode: "chat", chatId: "chat-a", query: "combat design" });
        expect(isOk(result)).toBe(true);
        const results = unwrap(result);
        expect(results.every((r) => r.entry.type === "conversation" && r.entry.chatId === "chat-a")).toBe(true);

        await mm.shutdown();
      });
    });

    it("respects limit", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        for (let i = 0; i < 10; i++) {
          await mm.storeNote(`Combat note variant ${i} with system and component`);
        }

        const result = await mm.retrieve({ mode: "text", query: "combat system component", limit: 3 });
        expect(isOk(result)).toBe(true);
        const results = unwrap(result);
        expect(results.length).toBeLessThanOrEqual(3);

        await mm.shutdown();
      });
    });

    it("returns empty for unrelated query", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        await mm.storeNote("Combat system with DamageDealer component");

        const result = await mm.retrieve({ mode: "text", query: "inventory crafting recipe", minScore: 0.3 });
        expect(isOk(result)).toBe(true);
        const results = unwrap(result);
        expect(results).toHaveLength(0);

        await mm.shutdown();
      });
    });

    it("returns empty for empty query", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        await mm.storeNote("Something");
        const result = await mm.retrieve({ mode: "text", query: "" });
        expect(isOk(result)).toBe(true);
        const results = unwrap(result);
        expect(results).toHaveLength(0);

        await mm.shutdown();
      });
    });
  });

  describe("entry-vector cache (IDF-version-gated)", () => {
    const TEXT = (query: string) =>
      ({ mode: "text", query, minScore: 0, limit: 100 }) as const;

    // Adding a document shifts every term's IDF, so every previously-cached
    // entry vector must be recomputed. Warming the cache before the mutation
    // must yield the SAME scores as a manager built fresh on the final corpus;
    // a non-version-gated cache would score the older entries against stale IDF.
    it("invalidates cached entry vectors when the corpus grows", async () => {
      await withTempDir(async (dir) => {
        const docs = [
          "DamageSystem applies combat damage to Health components",
          "Inventory system stores ItemData ScriptableObjects",
          "PathfindingSystem computes navigation for combat units",
        ];
        const extra = "Combat tuning notes for the damage system pipeline";

        const incremental = new FileMemoryManager(join(dir, "inc"));
        await incremental.initialize();
        for (const d of docs) await incremental.storeNote(d);
        await incremental.retrieve(TEXT("combat damage system")); // warm @ old IDF
        await incremental.storeNote(extra); // mutates IDF for every term
        const incResults = unwrap(await incremental.retrieve(TEXT("combat damage system")));
        await incremental.shutdown();

        const fresh = new FileMemoryManager(join(dir, "fresh"));
        await fresh.initialize();
        for (const d of [...docs, extra]) await fresh.storeNote(d);
        const freshResults = unwrap(await fresh.retrieve(TEXT("combat damage system")));
        await fresh.shutdown();

        const incMap = new Map(incResults.map((r) => [r.entry.content, r.score]));
        const freshMap = new Map(freshResults.map((r) => [r.entry.content, r.score]));
        expect(incMap.size).toBe(freshMap.size);
        for (const [content, score] of freshMap) {
          expect(incMap.has(content)).toBe(true);
          expect(incMap.get(content)!).toBeCloseTo(score, 10);
        }
      });
    });

    // Same guarantee for the removeDocument path (deletion also shifts IDF).
    it("invalidates cached entry vectors when an entry is deleted", async () => {
      await withTempDir(async (dir) => {
        const a = "DamageSystem applies combat damage to units";
        const b = "Inventory system stores ItemData ScriptableObjects";
        const c = "Pathfinding navigation for combat squads";

        const incremental = new FileMemoryManager(join(dir, "inc"));
        await incremental.initialize();
        await incremental.storeNote(a);
        const bId = unwrap(await incremental.storeNote(b));
        await incremental.storeNote(c);
        await incremental.retrieve(TEXT("combat damage")); // warm @ old IDF
        await incremental.deleteEntry(bId); // mutates IDF for every term
        const incResults = unwrap(await incremental.retrieve(TEXT("combat damage")));
        await incremental.shutdown();

        const fresh = new FileMemoryManager(join(dir, "fresh"));
        await fresh.initialize();
        await fresh.storeNote(a);
        await fresh.storeNote(c);
        const freshResults = unwrap(await fresh.retrieve(TEXT("combat damage")));
        await fresh.shutdown();

        const incMap = new Map(incResults.map((r) => [r.entry.content, r.score]));
        const freshMap = new Map(freshResults.map((r) => [r.entry.content, r.score]));
        expect(incMap.size).toBe(freshMap.size); // deleted entry is gone
        for (const [content, score] of freshMap) {
          expect(incMap.get(content)).toBeCloseTo(score, 10);
        }
      });
    });

    // A cache hit (repeated query, no corpus change) must not alter results.
    it("returns identical results on repeated queries without corpus change", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();
        await mm.storeNote("DamageSystem combat note with Health component");
        await mm.storeNote("Inventory ItemData ScriptableObject note");

        const first = unwrap(await mm.retrieve(TEXT("combat damage")));
        const second = unwrap(await mm.retrieve(TEXT("combat damage"))); // partly cached
        expect(second.map((r) => [r.entry.content, r.score])).toEqual(
          first.map((r) => [r.entry.content, r.score]),
        );

        await mm.shutdown();
      });
    });
  });

  describe("analysis cache", () => {
    it("caches and retrieves analysis", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        const analysis = createMockAnalysis();
        await mm.cacheAnalysis(analysis, "/test/project");

        const result = await mm.getCachedAnalysis("/test/project");
        expect(isOk(result)).toBe(true);
        const option = unwrap(result);
        expect(isSome(option)).toBe(true);
        const cached = unwrapOption(option);
        expect(cached.modules).toHaveLength(1);
        expect(cached.modules[0]!.name).toBe("Combat");
        expect(cached.systems).toHaveLength(1);
        expect(cached.csFileCount).toBe(10);

        await mm.shutdown();
      });
    });

    it("returns none for different project path", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        await mm.cacheAnalysis(createMockAnalysis(), "/project-a");
        const result = await mm.getCachedAnalysis("/project-b");
        expect(isOk(result)).toBe(true);
        const option = unwrap(result);
        expect(isNone(option)).toBe(true);

        await mm.shutdown();
      });
    });

    it("returns none when cache is expired", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"));
        await mm.initialize();

        const analysis = createMockAnalysis();
        analysis.analyzedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
        await mm.cacheAnalysis(analysis, "/test");

        // Max age 1 hour — should be expired
        const result = await mm.getCachedAnalysis("/test", 60 * 60 * 1000);
        expect(isOk(result)).toBe(true);
        const option = unwrap(result);
        expect(isNone(option)).toBe(true);

        await mm.shutdown();
      });
    });

    it("persists analysis cache to disk", async () => {
      await withTempDir(async (dir) => {
        const dbPath = join(dir, "db");
        const mm = new FileMemoryManager(dbPath);
        await mm.initialize();

        await mm.cacheAnalysis(createMockAnalysis(), "/test");
        await mm.shutdown();

        // Verify file exists
        const raw = await readFile(join(dbPath, "analysis.json"), "utf-8");
        const data = JSON.parse(raw);
        expect(data.projectPath).toBe("/test");
        expect(data.analysis.modules).toHaveLength(1);
      });
    });

    it("restores analysis cache across restarts", async () => {
      await withTempDir(async (dir) => {
        const dbPath = join(dir, "db");

        const mm1 = new FileMemoryManager(dbPath);
        await mm1.initialize();
        await mm1.cacheAnalysis(createMockAnalysis(), "/test");
        await mm1.shutdown();

        const mm2 = new FileMemoryManager(dbPath);
        await mm2.initialize();
        expect(mm2.getStats().hasAnalysisCache).toBe(true);

        const result = await mm2.getCachedAnalysis("/test");
        expect(isOk(result)).toBe(true);
        const option = unwrap(result);
        expect(isSome(option)).toBe(true);
        const cached = unwrapOption(option);
        expect(cached.modules[0]!.name).toBe("Combat");

        await mm2.shutdown();
      });
    });
  });

  describe("eviction", () => {
    it("evicts oldest entries when exceeding capacity", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"), 5);
        await mm.initialize();

        for (let i = 0; i < 8; i++) {
          await mm.storeNote(`Entry ${i}`);
        }

        const stats = mm.getStats();
        expect(stats.totalEntries).toBe(5);

        // Should have entries 3-7 (oldest evicted)
        const result = await mm.retrieve({ mode: "text", query: "entry", limit: 10, minScore: 0 });
        expect(isOk(result)).toBe(true);
        const results = unwrap(result);
        const contents = results.map((r) => r.entry.content);
        expect(contents).not.toContain("Entry 0");
        expect(contents).not.toContain("Entry 1");
        expect(contents).not.toContain("Entry 2");

        await mm.shutdown();
      });
    });

    it("keeps a high-importance entry over older low-importance ones", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"), 2);
        await mm.initialize();

        // The critical entry is the OLDEST — a pure-LRU eviction (the old bug)
        // would drop it. The fix evicts by importance first, so it survives.
        await mm.storeNote("keep this critical note", { importance: "critical" });
        await mm.storeNote("drop one low note");
        await mm.storeNote("drop two low note"); // capacity 2 → one eviction

        expect(mm.getStats().totalEntries).toBe(2);

        const result = await mm.retrieve({ mode: "text", query: "keep drop critical low note", limit: 10, minScore: 0 });
        const contents = unwrap(result).map((r) => r.entry.content);
        expect(contents).toContain("keep this critical note");

        await mm.shutdown();
      });
    });

    it("evicts an archived entry before a live one (even if the live one is older)", async () => {
      await withTempDir(async (dir) => {
        const mm = new FileMemoryManager(join(dir, "db"), 2);
        await mm.initialize();

        await mm.storeNote("alpha live oldest note");
        await mm.storeNote("beta note");
        // Archive the NEWER entry directly (mirrors archiveOldEntries' own cast).
        // Pure-LRU would evict the older "alpha"; the fix evicts archived first.
        const entries = (mm as unknown as { entries: Array<{ content: string; archived: boolean }> }).entries;
        const beta = entries.find((e) => e.content === "beta note");
        if (beta) beta.archived = true;

        await mm.storeNote("gamma note"); // capacity 2 → one eviction

        // retrieve includes archived entries by default, so absence == evicted.
        const result = await mm.retrieve({ mode: "text", query: "alpha beta gamma note", limit: 10, minScore: 0 });
        const contents = unwrap(result).map((r) => r.entry.content);
        expect(contents).toContain("alpha live oldest note");
        expect(contents).not.toContain("beta note");

        await mm.shutdown();
      });
    });
  });
});

describe("FileMemoryManager tokenization cache", () => {
  it("retrieve is consistent across calls and reflects newly stored content (no stale cache)", async () => {
    await withTempDir(async (dir) => {
      const mm = new FileMemoryManager(join(dir, "db"));
      await mm.initialize();
      await mm.storeNote("alpha combat system note");
      const r1 = unwrap(await mm.retrieve({ mode: "text", query: "combat system", limit: 10, minScore: 0 }));
      const r2 = unwrap(await mm.retrieve({ mode: "text", query: "combat system", limit: 10, minScore: 0 }));
      expect(r1.map((x) => x.entry.content)).toEqual(r2.map((x) => x.entry.content));
      await mm.storeNote("beta combat system note");
      const r3 = unwrap(await mm.retrieve({ mode: "text", query: "combat system", limit: 10, minScore: 0 }));
      expect(r3.some((x) => x.entry.content === "beta combat system note")).toBe(true);
      await mm.shutdown();
    });
  });
});
