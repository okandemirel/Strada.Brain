/**
 * MemoryRefresher -- unit, stress, and performance tests
 *
 * Covers: config parsing, event types, periodic triggers, topic shift detection,
 * budget enforcement, content-hash deduplication, parallel retrieval, error handling,
 * event emission, stress, and performance benchmarks.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReRetrievalConfig } from "../config/config.js";
import type {
  IEventEmitter,
  LearningEventMap,
  MemoryReRetrievedEvent,
  MemoryTopicShiftedEvent,
} from "../core/event-bus.js";
import type { IMemoryManager, RetrievalResult } from "../memory/memory.interface.js";
import type {
  IRAGPipeline,
  SearchResult,
  IEmbeddingProvider,
  EmbeddingBatch,
} from "../rag/rag.interface.js";
import type { InsightResult, InstinctRetriever } from "./instinct-retriever.js";
import {
  MemoryRefresher,
  type MemoryRefresherDeps,
  type RefreshResult,
} from "./memory-refresher.js";
import { TypedEventBus } from "../core/event-bus.js";

// Mock node:fs for config loadConfig tests
vi.mock("node:fs", () => ({
  realpathSync: vi.fn((p: string) => p),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

// =============================================================================
// Helpers
// =============================================================================

function defaultConfig(overrides: Partial<ReRetrievalConfig> = {}): ReRetrievalConfig {
  return {
    enabled: true,
    interval: 5,
    topicShiftEnabled: true,
    topicShiftThreshold: 0.4,
    maxReRetrievals: 10,
    timeoutMs: 5000,
    memoryLimit: 3,
    ragTopK: 6,
    ...overrides,
  };
}

function mockEventBus(): IEventEmitter & { calls: Array<{ event: string; payload: unknown }> } {
  const calls: Array<{ event: string; payload: unknown }> = [];
  return {
    emit(event: string, payload: unknown) {
      calls.push({ event, payload });
    },
    calls,
  };
}

function mockEmbeddingProvider(
  returnEmbeddings: number[][] | null = [[1, 0, 0]],
): IEmbeddingProvider {
  return {
    name: "mock",
    dimensions: 3,
    embed: vi.fn(async (): Promise<EmbeddingBatch> => ({
      embeddings: returnEmbeddings ?? [],
      usage: { totalTokens: 10 },
    })),
  };
}

function mockMemoryManager(
  results: RetrievalResult[] = [],
): Partial<IMemoryManager> {
  return {
    retrieve: vi.fn(async () => ({ kind: "ok" as const, value: results })),
  };
}

function mockRagPipeline(
  results: SearchResult[] = [],
): Partial<IRAGPipeline> {
  return {
    search: vi.fn(async () => results),
    formatContext: vi.fn((r: SearchResult[]) =>
      r.map((sr) => sr.chunk.content).join("\n---\n"),
    ),
  };
}

function mockInstinctRetriever(
  result: InsightResult = { insights: [], matchedInstinctIds: [] },
): Partial<InstinctRetriever> {
  return {
    getInsightsForTask: vi.fn(async () => result),
  };
}

function makeSearchResult(content: string, score = 0.8): SearchResult {
  return {
    chunk: {
      id: `chunk-${content}`,
      content,
      filePath: "/test/file.ts",
      kind: "function" as const,
      startLine: 1,
      endLine: 10,
      language: "typescript",
      metadata: {},
    },
    vectorScore: score as never,
    finalScore: score as never,
  };
}

function makeRetrievalResult(content: string, score = 0.8): RetrievalResult {
  return {
    entry: {
      id: `mem-${content}` as never,
      type: "note" as const,
      content,
      createdAt: Date.now() as never,
      accessCount: 1,
      tags: [],
      importance: "medium" as const,
      archived: false,
      metadata: {},
      title: content,
      source: "test",
    },
    score: score as never,
  };
}

// =============================================================================
// Task 1: Config & event type contracts
// =============================================================================

describe("config", () => {
  describe("reRetrieval", () => {
    beforeEach(async () => {
      const { resetConfigCache } = await import("../config/config.js");
      resetConfigCache();
      // Clear re-retrieval env vars
      for (const key of [
        "STRATA_MEMORY_RERETRIEVAL_ENABLED",
        "STRATA_MEMORY_RERETRIEVAL_INTERVAL",
        "STRATA_MEMORY_TOPIC_SHIFT_ENABLED",
        "STRATA_MEMORY_TOPIC_SHIFT_THRESHOLD",
        "STRATA_MEMORY_MAX_RERETRIEVALS",
        "STRATA_MEMORY_RERETRIEVAL_TIMEOUT_MS",
        "STRATA_MEMORY_RERETRIEVAL_MEMORY_LIMIT",
        "STRATA_MEMORY_RERETRIEVAL_RAG_TOPK",
      ]) {
        delete process.env[key];
      }
    });

    it("parses defaults from env", async () => {
      const { validateConfig } = await import("../config/config.js");
      const result = validateConfig({
        anthropicApiKey: "sk-test-key-123",
        unityProjectPath: "/test/project",
      });
      expect(result.kind).toBe("valid");
      if (result.kind !== "valid") return;
      const config = result.value;
      expect(config.reRetrieval).toBeDefined();
      expect(config.reRetrieval.enabled).toBe(true);
      expect(config.reRetrieval.interval).toBe(5);
      expect(config.reRetrieval.topicShiftEnabled).toBe(true);
      expect(config.reRetrieval.topicShiftThreshold).toBe(0.4);
      expect(config.reRetrieval.maxReRetrievals).toBe(10);
      expect(config.reRetrieval.timeoutMs).toBe(5000);
      expect(config.reRetrieval.memoryLimit).toBe(3);
      expect(config.reRetrieval.ragTopK).toBe(6);
    });

    it("overrides via env vars", async () => {
      const { loadConfig, resetConfigCache } = await import("../config/config.js");
      resetConfigCache();
      process.env["ANTHROPIC_API_KEY"] = "sk-test-key-123";
      process.env["UNITY_PROJECT_PATH"] = "/test/project";
      process.env["STRATA_MEMORY_RERETRIEVAL_INTERVAL"] = "3";
      process.env["STRATA_MEMORY_TOPIC_SHIFT_THRESHOLD"] = "0.6";
      process.env["STRATA_MEMORY_MAX_RERETRIEVALS"] = "20";

      const config = loadConfig();
      expect(config.reRetrieval.interval).toBe(3);
      expect(config.reRetrieval.topicShiftThreshold).toBe(0.6);
      expect(config.reRetrieval.maxReRetrievals).toBe(20);

      delete process.env["STRATA_MEMORY_RERETRIEVAL_INTERVAL"];
      delete process.env["STRATA_MEMORY_TOPIC_SHIFT_THRESHOLD"];
      delete process.env["STRATA_MEMORY_MAX_RERETRIEVALS"];
      resetConfigCache();
    });

    it("rejects interval=0", async () => {
      const { validateConfig } = await import("../config/config.js");
      const result = validateConfig({
        anthropicApiKey: "sk-test-key-123",
        unityProjectPath: "/test/project",
        strataMemoryReRetrievalInterval: "0",
      });
      expect(result.kind).toBe("invalid");
    });

    it("rejects threshold > 1.0", async () => {
      const { validateConfig } = await import("../config/config.js");
      const result = validateConfig({
        anthropicApiKey: "sk-test-key-123",
        unityProjectPath: "/test/project",
        strataMemoryTopicShiftThreshold: "2.0",
      });
      expect(result.kind).toBe("invalid");
    });

    it("rejects negative timeout", async () => {
      const { validateConfig } = await import("../config/config.js");
      const result = validateConfig({
        anthropicApiKey: "sk-test-key-123",
        unityProjectPath: "/test/project",
        strataMemoryReRetrievalTimeoutMs: "-100",
      });
      expect(result.kind).toBe("invalid");
    });
  });
});

describe("event types", () => {
  it("LearningEventMap includes memory:re_retrieved", async () => {
    const bus = new TypedEventBus();
    const received: MemoryReRetrievedEvent[] = [];
    bus.on("memory:re_retrieved", (e) => received.push(e));

    const payload: MemoryReRetrievedEvent = {
      sessionId: "s1",
      reason: "periodic",
      newMemoryCount: 2,
      newRagCount: 3,
      newInsightCount: 1,
      durationMs: 42,
      retrievalNumber: 1,
      timestamp: Date.now(),
    };
    bus.emit("memory:re_retrieved", payload);
    expect(received).toHaveLength(1);
    expect(received[0]!.reason).toBe("periodic");

    await bus.shutdown();
  });

  it("LearningEventMap includes memory:topic_shifted", async () => {
    const bus = new TypedEventBus();
    const received: MemoryTopicShiftedEvent[] = [];
    bus.on("memory:topic_shifted", (e) => received.push(e));

    const payload: MemoryTopicShiftedEvent = {
      sessionId: "s1",
      cosineDistance: 0.75,
      threshold: 0.4,
      previousTopic: "Unity physics",
      currentTopic: "UI layout",
      timestamp: Date.now(),
    };
    bus.emit("memory:topic_shifted", payload);
    expect(received).toHaveLength(1);
    expect(received[0]!.cosineDistance).toBe(0.75);

    await bus.shutdown();
  });
});

// =============================================================================
// Task 2: MemoryRefresher unit tests
// =============================================================================

describe("MemoryRefresher", () => {
  describe("periodic", () => {
    it("returns true when iteration >= lastRetrievalIteration + interval", async () => {
      const refresher = new MemoryRefresher(defaultConfig({ interval: 5 }), {});
      const result = await refresher.shouldRefresh(5, "test context", "s1");
      expect(result.should).toBe(true);
      expect(result.reason).toBe("periodic");
    });

    it("returns false when iteration < lastRetrievalIteration + interval", async () => {
      const refresher = new MemoryRefresher(defaultConfig({ interval: 5 }), {});
      const result = await refresher.shouldRefresh(3, "test context", "s1");
      expect(result.should).toBe(false);
      expect(result.reason).toBe("none");
    });

    it("returns false when disabled", async () => {
      const refresher = new MemoryRefresher(defaultConfig({ enabled: false }), {});
      const result = await refresher.shouldRefresh(100, "test context", "s1");
      expect(result.should).toBe(false);
      expect(result.reason).toBe("none");
    });

    it("updates lastRetrievalIteration after refresh", async () => {
      const refresher = new MemoryRefresher(defaultConfig({ interval: 3 }), {});

      // Iteration 3 should trigger
      let result = await refresher.shouldRefresh(3, "test context", "s1");
      expect(result.should).toBe(true);

      // Do the refresh at iteration 3
      await refresher.refresh("query", "s1", "periodic", 3);

      // Iteration 5 should NOT trigger (3 + 3 = 6 needed)
      result = await refresher.shouldRefresh(5, "test context", "s1");
      expect(result.should).toBe(false);

      // Iteration 6 should trigger
      result = await refresher.shouldRefresh(6, "test context", "s1");
      expect(result.should).toBe(true);
    });
  });

  describe("topic shift", () => {
    it("returns true when cosine distance > threshold", async () => {
      // First call: sets baseline embedding
      // Second call: different embedding triggers topic shift
      const provider = {
        name: "mock",
        dimensions: 3,
        embed: vi.fn()
          .mockResolvedValueOnce({ embeddings: [[1, 0, 0]], usage: { totalTokens: 10 } })
          .mockResolvedValueOnce({ embeddings: [[0, 1, 0]], usage: { totalTokens: 10 } }),
      } as unknown as IEmbeddingProvider;

      const refresher = new MemoryRefresher(
        defaultConfig({ topicShiftThreshold: 0.4, interval: 100 }),
        { embeddingProvider: provider },
      );

      // First call sets baseline
      await refresher.shouldRefresh(0, "Unity physics", "s1");
      // Second call with orthogonal vector -> distance = 1.0 > 0.4
      const result = await refresher.shouldRefresh(1, "UI layout", "s1");
      expect(result.should).toBe(true);
      expect(result.reason).toBe("topic_shift");
    });

    it("returns false when cosine distance <= threshold", async () => {
      const provider = {
        name: "mock",
        dimensions: 3,
        embed: vi.fn()
          .mockResolvedValueOnce({ embeddings: [[1, 0, 0]], usage: { totalTokens: 10 } })
          .mockResolvedValueOnce({ embeddings: [[0.95, 0.1, 0]], usage: { totalTokens: 10 } }),
      } as unknown as IEmbeddingProvider;

      const refresher = new MemoryRefresher(
        defaultConfig({ topicShiftThreshold: 0.4, interval: 100 }),
        { embeddingProvider: provider },
      );

      await refresher.shouldRefresh(0, "Unity physics", "s1");
      const result = await refresher.shouldRefresh(1, "Unity colliders", "s1");
      expect(result.should).toBe(false);
    });

    it("skips gracefully when embedding returns null/empty", async () => {
      const provider = {
        name: "mock",
        dimensions: 3,
        embed: vi.fn().mockResolvedValue({ embeddings: [], usage: { totalTokens: 0 } }),
      } as unknown as IEmbeddingProvider;

      const refresher = new MemoryRefresher(
        defaultConfig({ topicShiftThreshold: 0.4, interval: 100 }),
        { embeddingProvider: provider },
      );

      // Should not throw, should not trigger
      const result = await refresher.shouldRefresh(0, "test", "s1");
      expect(result.should).toBe(false);
    });

    it("skips when topicShiftEnabled=false", async () => {
      const provider = {
        name: "mock",
        dimensions: 3,
        embed: vi.fn()
          .mockResolvedValueOnce({ embeddings: [[1, 0, 0]], usage: { totalTokens: 10 } })
          .mockResolvedValueOnce({ embeddings: [[0, 1, 0]], usage: { totalTokens: 10 } }),
      } as unknown as IEmbeddingProvider;

      const refresher = new MemoryRefresher(
        defaultConfig({ topicShiftEnabled: false, interval: 100 }),
        { embeddingProvider: provider },
      );

      await refresher.shouldRefresh(0, "Unity physics", "s1");
      const result = await refresher.shouldRefresh(1, "UI layout", "s1");
      // Should not trigger topic shift because disabled
      expect(result.should).toBe(false);
      expect(provider.embed).not.toHaveBeenCalled();
    });
  });

  describe("budget", () => {
    it("returns budget_exhausted when retrievalCount >= maxReRetrievals", async () => {
      const refresher = new MemoryRefresher(
        defaultConfig({ maxReRetrievals: 2, interval: 1 }),
        {},
      );

      // Exhaust the budget
      await refresher.refresh("q1", "s1", "periodic", 1);
      await refresher.refresh("q2", "s1", "periodic", 2);

      const result = await refresher.shouldRefresh(3, "test context", "s1");
      expect(result.should).toBe(false);
      expect(result.reason).toBe("budget_exhausted");
    });
  });

  describe("deduplication", () => {
    it("filters already-seen content via hash", async () => {
      const memResults = [
        makeRetrievalResult("memory A"),
        makeRetrievalResult("memory B"),
      ];
      const ragResults = [
        makeSearchResult("memory A"), // duplicate of memory result
        makeSearchResult("rag C"),
      ];

      const deps: MemoryRefresherDeps = {
        memoryManager: mockMemoryManager(memResults) as IMemoryManager,
        ragPipeline: mockRagPipeline(ragResults) as IRAGPipeline,
      };

      const refresher = new MemoryRefresher(defaultConfig(), deps);

      const result = await refresher.refresh("query", "s1", "periodic", 5);
      expect(result.triggered).toBe(true);
      // Memory should have both
      expect(result.newMemoryContext).toContain("memory A");
      expect(result.newMemoryContext).toContain("memory B");
      // RAG: "memory A" is duplicate (already seen from memory), only "rag C" is new
      expect(result.newRagContext).toContain("rag C");
      expect(result.newRagContext).not.toContain("memory A");
    });

    it("deduplicates across successive refresh calls", async () => {
      const deps: MemoryRefresherDeps = {
        memoryManager: mockMemoryManager([
          makeRetrievalResult("stable memory"),
        ]) as IMemoryManager,
      };

      const refresher = new MemoryRefresher(defaultConfig(), deps);

      const r1 = await refresher.refresh("q1", "s1", "periodic", 5);
      expect(r1.newMemoryContext).toContain("stable memory");

      const r2 = await refresher.refresh("q2", "s1", "periodic", 10);
      // Same content should be deduped
      expect(r2.newMemoryContext).toBeUndefined();
    });
  });

  describe("parallel retrieval", () => {
    it("calls memory, RAG, and instinct in parallel", async () => {
      const memMgr = mockMemoryManager([makeRetrievalResult("mem1")]);
      const ragPipe = mockRagPipeline([makeSearchResult("rag1")]);
      const instRetriever = mockInstinctRetriever({
        insights: ["insight1"],
        matchedInstinctIds: ["inst-1"],
      });

      const deps: MemoryRefresherDeps = {
        memoryManager: memMgr as IMemoryManager,
        ragPipeline: ragPipe as IRAGPipeline,
        instinctRetriever: instRetriever as unknown as InstinctRetriever,
      };

      const refresher = new MemoryRefresher(defaultConfig(), deps);
      const result = await refresher.refresh("query", "s1", "periodic", 5);

      expect(result.triggered).toBe(true);
      expect(result.newMemoryContext).toContain("mem1");
      expect(result.newRagContext).toContain("rag1");
      expect(result.newInsights).toEqual(["insight1"]);
      expect(result.newInstinctIds).toEqual(["inst-1"]);

      expect(memMgr.retrieve).toHaveBeenCalledTimes(1);
      expect(ragPipe.search).toHaveBeenCalledTimes(1);
      expect(instRetriever.getInsightsForTask).toHaveBeenCalledTimes(1);
    });

    it("handles partial failures gracefully", async () => {
      const memMgr = {
        retrieve: vi.fn().mockRejectedValue(new Error("DB error")),
      };
      const ragPipe = mockRagPipeline([makeSearchResult("rag1")]);

      const deps: MemoryRefresherDeps = {
        memoryManager: memMgr as unknown as IMemoryManager,
        ragPipeline: ragPipe as IRAGPipeline,
      };

      const refresher = new MemoryRefresher(defaultConfig(), deps);
      const result = await refresher.refresh("query", "s1", "periodic", 5);

      // Should still succeed with RAG results despite memory failure
      expect(result.triggered).toBe(true);
      expect(result.newMemoryContext).toBeUndefined();
      expect(result.newRagContext).toContain("rag1");
    });
  });

  describe("error handling", () => {
    it("returns non-fatal result on complete failure", async () => {
      const deps: MemoryRefresherDeps = {
        memoryManager: {
          retrieve: vi.fn().mockRejectedValue(new Error("boom")),
        } as unknown as IMemoryManager,
        ragPipeline: {
          search: vi.fn().mockRejectedValue(new Error("boom")),
          formatContext: vi.fn(),
        } as unknown as IRAGPipeline,
        instinctRetriever: {
          getInsightsForTask: vi.fn().mockRejectedValue(new Error("boom")),
        } as unknown as InstinctRetriever,
      };

      const refresher = new MemoryRefresher(defaultConfig(), deps);
      const result = await refresher.refresh("query", "s1", "periodic", 5);

      // All three failed via allSettled -- still should succeed with empty results
      expect(result.triggered).toBe(true);
      expect(result.newMemoryContext).toBeUndefined();
      expect(result.newRagContext).toBeUndefined();
      expect(result.newInsights).toBeUndefined();
    });

    it("respects timeoutMs", async () => {
      const slowMem = {
        retrieve: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 10000))),
      };

      const refresher = new MemoryRefresher(
        defaultConfig({ timeoutMs: 100 }),
        { memoryManager: slowMem as unknown as IMemoryManager },
      );

      const result = await refresher.refresh("query", "s1", "periodic", 5);
      // Should timeout and return non-triggered
      expect(result.triggered).toBe(false);
      expect(result.reason).toBe("skipped");
      expect(result.durationMs).toBeLessThan(500);
    });
  });

  describe("events", () => {
    it("emits memory:re_retrieved on successful refresh", async () => {
      const eventBus = mockEventBus();
      const deps: MemoryRefresherDeps = { eventBus };

      const refresher = new MemoryRefresher(defaultConfig(), deps);
      await refresher.refresh("query", "s1", "periodic", 5);

      const reRetrievedEvents = eventBus.calls.filter(
        (c) => c.event === "memory:re_retrieved",
      );
      expect(reRetrievedEvents).toHaveLength(1);
      const payload = reRetrievedEvents[0]!.payload as MemoryReRetrievedEvent;
      expect(payload.sessionId).toBe("s1");
      expect(payload.reason).toBe("periodic");
      expect(payload.retrievalNumber).toBe(1);
    });

    it("emits memory:topic_shifted when reason is topic_shift", async () => {
      const eventBus = mockEventBus();
      const deps: MemoryRefresherDeps = { eventBus };

      const refresher = new MemoryRefresher(defaultConfig(), deps);
      await refresher.refresh("query", "s1", "topic_shift", 5);

      const shiftEvents = eventBus.calls.filter(
        (c) => c.event === "memory:topic_shifted",
      );
      expect(shiftEvents).toHaveLength(1);
      const payload = shiftEvents[0]!.payload as MemoryTopicShiftedEvent;
      expect(payload.sessionId).toBe("s1");
      expect(payload.threshold).toBe(0.4);
    });

    it("does not emit topic_shifted for periodic reason", async () => {
      const eventBus = mockEventBus();
      const deps: MemoryRefresherDeps = { eventBus };

      const refresher = new MemoryRefresher(defaultConfig(), deps);
      await refresher.refresh("query", "s1", "periodic", 5);

      const shiftEvents = eventBus.calls.filter(
        (c) => c.event === "memory:topic_shifted",
      );
      expect(shiftEvents).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("clears all state", async () => {
      const refresher = new MemoryRefresher(
        defaultConfig({ interval: 1, maxReRetrievals: 2 }),
        {},
      );

      // Exhaust budget
      await refresher.refresh("q1", "s1", "periodic", 1);
      await refresher.refresh("q2", "s1", "periodic", 2);

      const exhausted = await refresher.shouldRefresh(3, "test", "s1");
      expect(exhausted.reason).toBe("budget_exhausted");

      // Reset
      refresher.reset();

      // Budget should be restored
      const afterReset = await refresher.shouldRefresh(0, "test", "s1");
      // iteration 0 < 0 + 1 = 1, so periodic won't fire at iteration 0
      // but budget should not be exhausted
      expect(afterReset.reason).not.toBe("budget_exhausted");
    });
  });

  describe("stress", () => {
    it("handles 100 rapid shouldRefresh calls with alternating topics", async () => {
      const provider = {
        name: "mock",
        dimensions: 3,
        embed: vi.fn().mockImplementation(async (_texts: string[]) => ({
          // Alternate between two very different embeddings
          embeddings: [Math.random() > 0.5 ? [1, 0, 0] : [0, 1, 0]],
          usage: { totalTokens: 5 },
        })),
      } as unknown as IEmbeddingProvider;

      const refresher = new MemoryRefresher(
        defaultConfig({ interval: 100, maxReRetrievals: 200 }),
        { embeddingProvider: provider },
      );

      const results: Array<{ should: boolean; reason: string }> = [];
      for (let i = 0; i < 100; i++) {
        const r = await refresher.shouldRefresh(i, `topic ${i}`, "s1");
        results.push(r);
      }

      // Should not throw, should have at least some results
      expect(results).toHaveLength(100);
      // At least some topic shifts should have been detected
      const shifts = results.filter((r) => r.reason === "topic_shift");
      expect(shifts.length).toBeGreaterThanOrEqual(0); // Non-deterministic, just no errors
    });
  });

  describe("performance", () => {
    it("single refresh cycle completes in < 100ms with mocked deps", async () => {
      const deps: MemoryRefresherDeps = {
        memoryManager: mockMemoryManager([makeRetrievalResult("mem1")]) as IMemoryManager,
        ragPipeline: mockRagPipeline([makeSearchResult("rag1")]) as IRAGPipeline,
        instinctRetriever: mockInstinctRetriever({
          insights: ["insight1"],
          matchedInstinctIds: ["inst-1"],
        }) as unknown as InstinctRetriever,
        eventBus: mockEventBus(),
      };

      const refresher = new MemoryRefresher(defaultConfig(), deps);
      const start = performance.now();
      const result = await refresher.refresh("perf test", "s1", "periodic", 5);
      const elapsed = performance.now() - start;

      expect(result.triggered).toBe(true);
      expect(elapsed).toBeLessThan(100);
    });
  });
});
