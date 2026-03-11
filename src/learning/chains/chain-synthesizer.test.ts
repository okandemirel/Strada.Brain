/**
 * ChainSynthesizer Tests
 *
 * Tests for LLM-based chain metadata generation, instinct storage,
 * tool registration, budget caps, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChainSynthesizer } from "./chain-synthesizer.js";
import type { CandidateChain, ToolChainConfig } from "./chain-types.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { IEventBus, LearningEventMap, ChainDetectedEvent } from "../../core/event-bus.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { Instinct } from "../types.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeConfig(overrides: Partial<ToolChainConfig> = {}): ToolChainConfig {
  return {
    enabled: true,
    minOccurrences: 3,
    successRateThreshold: 0.8,
    maxActive: 10,
    maxAgeDays: 30,
    llmBudgetPerCycle: 5,
    minChainLength: 2,
    maxChainLength: 5,
    detectionIntervalMs: 60000,
    resilience: {
      rollbackEnabled: true,
      parallelEnabled: true,
      maxParallelBranches: 4,
      compensationTimeoutMs: 30000,
    },
    ...overrides,
  };
}

function makeCandidate(
  toolNames: string[],
  occurrences: number,
  successCount?: number,
): CandidateChain {
  return {
    toolNames,
    occurrences,
    successCount: successCount ?? occurrences,
    sampleSteps: [],
    key: toolNames.join(","),
  };
}

function makeLLMResponse(name: string, description: string): string {
  return JSON.stringify({
    name,
    description,
    parameterMappings: [],
    inputSchema: { type: "object" },
  });
}

function makeProvider(responses: string[]): IAIProvider {
  let callIdx = 0;
  return {
    name: "mock",
    capabilities: {},
    chat: vi.fn(async () => {
      const text = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      return { text, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
    }),
  } as unknown as IAIProvider;
}

function makeMockStorage(activeChainCount = 0): LearningStorage {
  const instincts: Instinct[] = [];
  for (let i = 0; i < activeChainCount; i++) {
    instincts.push({ id: `instinct_${i}`, type: "tool_chain", status: "active" } as Instinct);
  }
  return {
    getInstincts: vi.fn().mockReturnValue(instincts),
    createInstinct: vi.fn(),
  } as unknown as LearningStorage;
}

function makeToolRegistry(existingTools: string[]): ToolRegistry {
  const toolSet = new Set(existingTools);
  return {
    has: vi.fn((name: string) => toolSet.has(name)),
    getMetadata: vi.fn().mockReturnValue(undefined),
    registerOrUpdate: vi.fn(),
  } as unknown as ToolRegistry;
}

function makeEventBus(): IEventBus<LearningEventMap> & { emitCalls: Array<{ event: string; payload: unknown }> } {
  const emitCalls: Array<{ event: string; payload: unknown }> = [];
  return {
    emit: vi.fn((event: string, payload: unknown) => {
      emitCalls.push({ event, payload });
    }),
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn(),
    emitCalls,
  } as unknown as IEventBus<LearningEventMap> & { emitCalls: Array<{ event: string; payload: unknown }> };
}

// =============================================================================
// TESTS
// =============================================================================

describe("ChainSynthesizer", () => {
  let config: ToolChainConfig;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    config = makeConfig();
    eventBus = makeEventBus();
  });

  describe("synthesize()", () => {
    it("should create instinct, register tool, and emit event for successful synthesis", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"]);
      const provider = makeProvider([makeLLMResponse("read_then_write", "Reads a file then writes it")]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("read_then_write");
      expect(storage.createInstinct).toHaveBeenCalledTimes(1);
      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      expect(createdInstinct.type).toBe("tool_chain");
      expect(registry.registerOrUpdate).toHaveBeenCalledTimes(1);

      const chainEvent = eventBus.emitCalls.find((c) => c.event === "chain:detected");
      expect(chainEvent).toBeDefined();
      const payload = chainEvent!.payload as ChainDetectedEvent;
      expect(payload.chainName).toBe("read_then_write");
      expect(payload.toolSequence).toEqual(["tool_a", "tool_b"]);
    });

    it("should respect LLM budget cap (3 candidates, budget 2 -> only 2 processed)", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["a", "b", "c", "d"]);
      const provider = makeProvider([
        makeLLMResponse("chain_one", "First chain description"),
        makeLLMResponse("chain_two", "Second chain description"),
        makeLLMResponse("chain_three", "Third chain description"),
      ]);
      config = makeConfig({ llmBudgetPerCycle: 2 });
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [
        makeCandidate(["a", "b"], 5),
        makeCandidate(["b", "c"], 4),
        makeCandidate(["c", "d"], 3),
      ];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(2);
      expect(provider.chat).toHaveBeenCalledTimes(2);
    });

    it("should respect maxActive cap and prevent over-registration", async () => {
      // 9 active chains, maxActive=10, so only 1 more allowed
      const storage = makeMockStorage(9);
      const registry = makeToolRegistry(["a", "b", "c", "d"]);
      const provider = makeProvider([
        makeLLMResponse("chain_one", "First chain description"),
        makeLLMResponse("chain_two", "Second chain description"),
      ]);
      config = makeConfig({ maxActive: 10 });
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [
        makeCandidate(["a", "b"], 5),
        makeCandidate(["c", "d"], 4),
      ];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
    });

    it("should skip candidate if any tool in sequence is missing", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a"]); // tool_b missing
      const provider = makeProvider([makeLLMResponse("chain_one", "Test chain")]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(0);
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("should skip candidate on LLM parse failure and continue to others", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["a", "b", "c", "d"]);
      const provider = makeProvider([
        "this is not valid json at all!!!",
        makeLLMResponse("valid_chain", "A valid chain description"),
      ]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [
        makeCandidate(["a", "b"], 5),
        makeCandidate(["c", "d"], 4),
      ];
      const tools = await synthesizer.synthesize(candidates);

      // First candidate fails LLM parse, second succeeds
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("valid_chain");
    });

    it("should create instinct with correct type and action JSON", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"]);
      const provider = makeProvider([makeLLMResponse("test_chain", "Test chain description")]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5, 4)];
      await synthesizer.synthesize(candidates);

      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      expect(createdInstinct.type).toBe("tool_chain");
      expect(createdInstinct.name).toBe("test_chain");
      expect(createdInstinct.triggerPattern).toBe("tool_a,tool_b");

      // Action should be valid JSON containing ChainMetadata
      const action = JSON.parse(createdInstinct.action);
      expect(action.toolSequence).toEqual(["tool_a", "tool_b"]);
      expect(action.successRate).toBe(0.8); // 4/5
      expect(action.occurrences).toBe(5);
    });

    it("should cap initial confidence at MAX_INITIAL (0.5)", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"]);
      const provider = makeProvider([makeLLMResponse("test_chain", "Test chain description")]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 10, 10)]; // 100% success
      await synthesizer.synthesize(candidates);

      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      // Success rate is 1.0 but confidence should be capped at 0.5
      expect(createdInstinct.confidence).toBeLessThanOrEqual(0.5);
    });

    it("should return empty array if no provider is set", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      // No provider set

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(0);
    });
  });
});
