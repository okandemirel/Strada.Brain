/**
 * Model Intelligence Service Tests
 *
 * Tests the hardcoded model registry, ModelInfo types, and the full
 * ModelIntelligenceService lifecycle: initialize, query, refresh, shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../memory/unified/sqlite-pragmas.js", () => ({
  configureSqlitePragmas: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  HARDCODED_MODELS,
  ModelIntelligenceService,
  type ModelInfo,
  type RefreshResult,
} from "./model-intelligence.js";

// ============================================================================
// 1. HARDCODED_MODELS — static model registry
// ============================================================================

describe("HARDCODED_MODELS", () => {
  const expectedModels = [
    "claude-sonnet-4-6-20250514",
    "claude-opus-4-6-20250514",
    "claude-haiku-4-5-20251001",
    "gpt-5.4",
    "gpt-5.2",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "deepseek-chat",
    "kimi-for-coding",
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "qwen3.5-plus",
    "mistral-large-3",
    "llama3.3",
  ];

  it("has all 16 default model entries", () => {
    expect(HARDCODED_MODELS.size).toBe(16);
    for (const model of expectedModels) {
      expect(HARDCODED_MODELS.has(model), `missing: ${model}`).toBe(true);
    }
  });

  it("every entry has valid contextWindow > 0 and maxOutputTokens > 0", () => {
    for (const [id, info] of HARDCODED_MODELS) {
      expect(info.contextWindow, `${id} contextWindow`).toBeGreaterThan(0);
      expect(info.maxOutputTokens, `${id} maxOutputTokens`).toBeGreaterThan(0);
    }
  });

  it("each entry has the expected provider name", () => {
    const providerMap: Record<string, string> = {
      "claude-sonnet-4-6-20250514": "claude",
      "claude-opus-4-6-20250514": "claude",
      "claude-haiku-4-5-20251001": "claude",
      "gpt-5.4": "openai",
      "gpt-5.2": "openai",
      "gemini-3.1-pro-preview": "gemini",
      "gemini-3-flash-preview": "gemini",
      "deepseek-chat": "deepseek",
      "kimi-for-coding": "kimi",
      "MiniMax-M2.7": "minimax",
      "MiniMax-M2.7-highspeed": "minimax",
      "MiniMax-M2.5": "minimax",
      "MiniMax-M2.5-highspeed": "minimax",
      "qwen3.5-plus": "qwen",
      "mistral-large-3": "mistral",
      "llama3.3": "ollama",
    };

    for (const [id, expectedProvider] of Object.entries(providerMap)) {
      const info = HARDCODED_MODELS.get(id);
      expect(info?.provider, `provider for ${id}`).toBe(expectedProvider);
    }
  });
});

// ============================================================================
// 2. ModelInfo and RefreshResult type structure
// ============================================================================

describe("ModelInfo and RefreshResult types", () => {
  it("ModelInfo from HARDCODED_MODELS has all required fields", () => {
    const info = HARDCODED_MODELS.get("gpt-5.4")!;
    expect(info).toBeDefined();

    expect(typeof info.id).toBe("string");
    expect(typeof info.provider).toBe("string");
    expect(typeof info.contextWindow).toBe("number");
    expect(typeof info.maxOutputTokens).toBe("number");
    expect(typeof info.inputPricePerMillion).toBe("number");
    expect(typeof info.outputPricePerMillion).toBe("number");
    expect(typeof info.supportsVision).toBe("boolean");
    expect(typeof info.supportsThinking).toBe("boolean");
    expect(typeof info.supportsToolCalling).toBe("boolean");
    expect(typeof info.supportsStreaming).toBe("boolean");
    expect(typeof info.lastUpdated).toBe("number");
  });

  it("RefreshResult has expected shape", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));

    const service = new ModelIntelligenceService();
    const result: RefreshResult = await service.refresh();

    expect(typeof result.modelsUpdated).toBe("number");
    expect(typeof result.source).toBe("string");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(["litellm", "models.dev", "cache", "hardcoded"]).toContain(result.source);

    service.shutdown();
  });
});

// ============================================================================
// 3. ModelIntelligenceService
// ============================================================================

describe("ModelIntelligenceService", () => {
  let service: ModelIntelligenceService;
  let tempRegistryPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempRegistryPath = undefined;
    service = new ModelIntelligenceService({
      providerSourcesPath: "/tmp/strada-test-missing-provider-sources.json",
    });
  });

  afterEach(() => {
    service.shutdown();
    if (tempRegistryPath) {
      try {
        unlinkSync(tempRegistryPath);
      } catch {
        // ignore temp cleanup failures
      }
    }
  });

  it("initialize creates DB tables without error", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    await expect(service.initialize(":memory:")).resolves.not.toThrow();
  });

  it("getModelInfo returns undefined for unknown model", () => {
    expect(service.getModelInfo("nonexistent-model-xyz")).toBeUndefined();
  });

  it("getModelInfo returns hardcoded fallback for known models", () => {
    // Before initialize, models map is empty, but getModelInfo falls back to HARDCODED_MODELS
    const info = service.getModelInfo("claude-sonnet-4-6-20250514");
    expect(info).toBeDefined();
    expect(info!.id).toBe("claude-sonnet-4-6-20250514");
    expect(info!.provider).toBe("claude");
    expect(info!.contextWindow).toBe(1_000_000);
  });

  it("getProviderModels returns correct models for claude after initialize", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    await service.initialize(":memory:");
    const models = service.getProviderModels("claude");
    expect(models.length).toBeGreaterThanOrEqual(3);
    for (const m of models) {
      expect(m.provider).toBe("claude");
    }
  });

  it("getProviderModels returns empty array for unknown provider", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    await service.initialize(":memory:");
    const models = service.getProviderModels("nonexistent-provider");
    expect(models).toEqual([]);
  });

  it("isStale returns true before any refresh", () => {
    expect(service.isStale()).toBe(true);
  });

  it("refresh handles fetch failure gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));

    const result = await service.refresh();
    expect(result.source).toBe("hardcoded");
    expect(result.modelsUpdated).toBe(HARDCODED_MODELS.size);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("refresh returns hardcoded fallback when all fetches fail", async () => {
    mockFetch.mockRejectedValue(new Error("timeout"));

    const result = await service.refresh();
    expect(result.source).toBe("hardcoded");
    expect(result.modelsUpdated).toBe(HARDCODED_MODELS.size);
  });

  it("shutdown can be called multiple times safely", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    await service.initialize(":memory:");
    service.shutdown();
    service.shutdown();
    service.shutdown();
    // No error thrown
  });

  it("refresh integrates LiteLLM data when fetch succeeds", async () => {
    const litellmData = {
      "test-model-abc": {
        max_tokens: 4096,
        max_input_tokens: 32000,
        max_output_tokens: 4096,
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        supports_vision: true,
        supports_function_calling: true,
      },
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => litellmData,
      })
      .mockRejectedValueOnce(new Error("models.dev offline"));

    const result = await service.refresh();
    expect(result.source).toBe("litellm");
    expect(result.modelsUpdated).toBeGreaterThan(0);

    const info = service.getModelInfo("test-model-abc");
    expect(info).toBeDefined();
    expect(info!.contextWindow).toBe(32000);
  });

  it("refresh integrates models.dev data when LiteLLM fails", async () => {
    const modelsDevData = {
      "exotic-model-xyz": {
        name: "exotic-model-xyz",
        provider: "testprovider",
        context_length: 16384,
        max_output: 4096,
        vision: true,
      },
    };

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 }) // LiteLLM fails
      .mockResolvedValueOnce({
        ok: true,
        json: async () => modelsDevData,
      });

    const result = await service.refresh();
    expect(result.source).toBe("models.dev");
    expect(result.modelsUpdated).toBeGreaterThan(0);
  });

  it("LiteLLM data overrides hardcoded entries via merge", async () => {
    const litellmData = {
      "claude-sonnet-4-6-20250514": {
        max_tokens: 64000,
        max_input_tokens: 2_000_000,
        max_output_tokens: 64000,
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.00002,
        supports_vision: true,
        supports_function_calling: true,
      },
    };

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => litellmData })
      .mockRejectedValueOnce(new Error("models.dev offline"));

    await service.refresh();
    const info = service.getModelInfo("claude-sonnet-4-6-20250514");
    expect(info).toBeDefined();
    // LiteLLM value should be used
    expect(info!.contextWindow).toBe(2_000_000);
    expect(info!.inputPricePerMillion).toBe(4);
  });

  it("context window values are reasonable for all known models", () => {
    for (const [id, info] of HARDCODED_MODELS) {
      expect(info.contextWindow, `${id}`).toBeGreaterThanOrEqual(4000);
      expect(info.contextWindow, `${id}`).toBeLessThanOrEqual(2_000_000);
    }
  });

  it("provider filtering works correctly across multiple providers", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    await service.initialize(":memory:");

    const claudeModels = service.getProviderModels("claude");
    const openaiModels = service.getProviderModels("openai");
    const geminiModels = service.getProviderModels("gemini");

    expect(claudeModels.length).toBe(3);
    expect(openaiModels.length).toBe(2);
    expect(geminiModels.length).toBe(2);
  });

  it("handles LiteLLM returning non-object JSON gracefully", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => "not an object" })
      .mockRejectedValueOnce(new Error("offline"));

    // Should not throw
    const result = await service.refresh();
    expect(result).toBeDefined();
  });

  it("handles models.dev returning array format", async () => {
    const arrayData = [
      { name: "array-model-1", context_length: 8192, max_output: 2048 },
      { name: "array-model-2", context_length: 16384, max_output: 4096 },
    ];

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 }) // LiteLLM fails
      .mockResolvedValueOnce({ ok: true, json: async () => arrayData });

    const result = await service.refresh();
    expect(result.source).toBe("models.dev");

    const info = service.getModelInfo("array-model-1");
    expect(info).toBeDefined();
    expect(info!.contextWindow).toBe(8192);
  });

  it("reports HTTP errors with status code", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 429 });

    const result = await service.refresh();
    expect(result.source).toBe("hardcoded");
  });

  it("size property returns model count", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    await service.initialize(":memory:");
    expect(service.size).toBeGreaterThanOrEqual(12);
  });

  it("extracts official provider signals from configured official sources", async () => {
    tempRegistryPath = join(process.cwd(), ".tmp-provider-sources.test.json");
    writeFileSync(tempRegistryPath, JSON.stringify({
      version: 1,
      providers: {
        gemini: [
          {
            url: "https://official.example/gemini",
            label: "Gemini official docs",
            kind: "html",
          },
        ],
      },
    }));

    service.shutdown();
    service = new ModelIntelligenceService({
      providerSourcesPath: tempRegistryPath,
    });

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("official.example/gemini")) {
        return {
          ok: true,
          text: async () => "<h1>/plan</h1><p>Grounding and tool calling support for coding workflows.</p><p>kimi-for-coding</p>",
          headers: { get: () => null },
        };
      }
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({}),
      };
    });

    await service.refresh();

    const snapshot = service.getProviderOfficialSnapshot("gemini");
    expect(snapshot).toBeDefined();
    expect(snapshot?.sourceUrls).toEqual(["https://official.example/gemini"]);
    expect(snapshot?.featureTags).toContain("tool-calling");
    expect(snapshot?.featureTags).toContain("search");
    expect(snapshot?.signals.some((signal) => signal.kind === "command" && signal.value === "/plan")).toBe(true);
    expect(snapshot?.signals.some((signal) => signal.value === "kimi-for-coding")).toBe(false);
  });

  it("persists official provider snapshots across initialize calls", async () => {
    tempRegistryPath = join(process.cwd(), ".tmp-provider-sources-persist.test.json");
    const tempDbPath = join(process.cwd(), ".tmp-model-intelligence-persist.test.db");
    writeFileSync(tempRegistryPath, JSON.stringify({
      version: 1,
      providers: {
        claude: [
          {
            url: "https://official.example/claude",
            label: "Claude official docs",
            kind: "html",
          },
        ],
      },
    }));

    service.shutdown();
    service = new ModelIntelligenceService({
      providerSourcesPath: tempRegistryPath,
    });

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("official.example/claude")) {
        return {
          ok: true,
          text: async () => "<p>/loop</p><p>Hooks and plan support.</p>",
          headers: { get: () => null },
        };
      }
      throw new Error("offline");
    });

    await service.initialize(tempDbPath);
    await service.refresh();
    service.shutdown();

    const reloaded = new ModelIntelligenceService({
      providerSourcesPath: tempRegistryPath,
    });
    await reloaded.initialize(tempDbPath);
    const snapshot = reloaded.getProviderOfficialSnapshot("claude");
    expect(snapshot).toBeDefined();
    expect(snapshot?.signals.some((signal) => signal.value === "/loop")).toBe(true);
    reloaded.shutdown();
    try {
      unlinkSync(tempDbPath);
    } catch {
      // ignore temp cleanup failures
    }
  });

  it("deferred initialize refreshes official snapshots even when model cache is fresh", async () => {
    tempRegistryPath = join(process.cwd(), ".tmp-provider-sources-deferred.test.json");
    writeFileSync(tempRegistryPath, JSON.stringify({
      version: 1,
      providers: {
        gemini: [
          {
            url: "https://official.example/gemini-deferred",
            label: "Gemini deferred docs",
            kind: "html",
          },
        ],
      },
    }));

    service.shutdown();
    service = new ModelIntelligenceService({
      providerSourcesPath: tempRegistryPath,
    });

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("official.example/gemini-deferred")) {
        return {
          ok: true,
          text: async () => "<p>/loop</p><p>Agent, grounding, and tool calling updates.</p>",
          headers: { get: () => null },
        };
      }
      throw new Error("offline");
    });

    await service.initialize(":memory:", { refreshOnInitialize: false });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshot = service.getProviderOfficialSnapshot("gemini");
    expect(snapshot).toBeDefined();
    expect(snapshot?.signals.some((signal) => signal.value === "/loop")).toBe(true);
  });

  it("reports provider catalog health with snapshot age and staleness", async () => {
    tempRegistryPath = join(process.cwd(), ".tmp-provider-sources-health.test.json");
    writeFileSync(tempRegistryPath, JSON.stringify({
      version: 1,
      providers: {
        gemini: [
          {
            url: "https://official.example/gemini-health",
            label: "Gemini health docs",
            kind: "html",
          },
        ],
      },
    }));

    service.shutdown();
    service = new ModelIntelligenceService({
      providerSourcesPath: tempRegistryPath,
      refreshHours: 1,
    });

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("official.example/gemini-health")) {
        return {
          ok: true,
          text: async () => "<p>/plan</p><p>Grounding and tool calling support.</p>",
          headers: { get: () => null },
        };
      }
      throw new Error("offline");
    });

    await service.refresh();

    const health = service.getCatalogHealth("gemini");
    expect(health).toBeDefined();
    expect(health?.refreshIntervalMs).toBe(60 * 60 * 1000);
    expect(health?.snapshotAgeMs).toBeGreaterThanOrEqual(0);
    expect(health?.stale).toBe(false);
  });

  it("clears stale official snapshots when a later successful refresh yields no relevant signals", async () => {
    tempRegistryPath = join(process.cwd(), ".tmp-provider-sources-clear.test.json");
    const tempDbPath = join(process.cwd(), ".tmp-model-intelligence-clear.test.db");
    writeFileSync(tempRegistryPath, JSON.stringify({
      version: 1,
      providers: {
        gemini: [
          {
            url: "https://official.example/gemini-clear",
            label: "Gemini clear docs",
            kind: "html",
          },
        ],
      },
    }));

    let phase: "seed" | "clear" = "seed";

    service.shutdown();
    service = new ModelIntelligenceService({
      providerSourcesPath: tempRegistryPath,
    });

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("official.example/gemini-clear")) {
        throw new Error("offline");
      }
      return {
        ok: true,
        text: async () => phase === "seed"
          ? "<p>/plan</p><p>Grounding and tool calling support.</p>"
          : "{\"object\":\"list\",\"data\":[{\"id\":\"kimi-for-coding\"}]}",
        headers: { get: () => null },
      };
    });

    await service.initialize(tempDbPath);
    await service.refresh();
    expect(service.getProviderOfficialSnapshot("gemini")).toBeDefined();

    phase = "clear";
    await service.refresh();
    expect(service.getProviderOfficialSnapshot("gemini")).toBeUndefined();

    service.shutdown();
    const reloaded = new ModelIntelligenceService({
      providerSourcesPath: tempRegistryPath,
    });
    await reloaded.initialize(tempDbPath);
    expect(reloaded.getProviderOfficialSnapshot("gemini")).toBeUndefined();
    reloaded.shutdown();

    try {
      unlinkSync(tempDbPath);
    } catch {
      // ignore temp cleanup failures
    }
  });
});
