/**
 * ChainSynthesizer Tests
 *
 * Tests for LLM-based chain metadata generation, instinct storage,
 * tool registration, budget caps, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ChainSynthesizer } from "./chain-synthesizer.js";
import type { CandidateChain, ToolChainConfig, ChainMetadataV2 } from "./chain-types.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { ToolMetadata } from "../../core/tool-registry.js";
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

function makeToolRegistry(
  existingTools: string[],
  metadataMap?: Record<string, Partial<ToolMetadata>>,
): ToolRegistry {
  const toolSet = new Set(existingTools);
  return {
    has: vi.fn((name: string) => toolSet.has(name)),
    getMetadata: vi.fn((name: string) => {
      if (metadataMap && name in metadataMap) {
        return { name, description: name, category: "custom", dangerous: false, requiresConfirmation: false, readOnly: false, ...metadataMap[name] };
      }
      return undefined;
    }),
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

/**
 * Build a mock V2 LLM response with steps, compensation, and reversibility.
 */
function makeLLMV2Response(
  name: string,
  description: string,
  steps: Array<{ stepId: string; toolName: string; dependsOn?: string[]; reversible?: boolean; compensatingAction?: { toolName: string; inputMappings: Record<string, string> } }>,
  isFullyReversible: boolean,
): string {
  return JSON.stringify({
    name,
    description,
    parameterMappings: [],
    inputSchema: { type: "object" },
    steps,
    isFullyReversible,
  });
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

  describe("V2 synthesis", () => {
    it("V2 synthesis creates instinct with version:2 metadata", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"], {
        tool_a: { readOnly: true },
        tool_b: { readOnly: true },
      });
      const v2Response = makeLLMV2Response(
        "read_then_write",
        "Reads a file then writes it",
        [
          { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: true },
          { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
        ],
        true,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      const action: ChainMetadataV2 = JSON.parse(createdInstinct.action);
      expect(action.version).toBe(2);
      expect(action.steps).toHaveLength(2);
      expect(action.steps[0].stepId).toBe("step_0");
    });

    it("compensation referencing non-existent tool is stripped, chain registered without rollback", async () => {
      const storage = makeMockStorage(0);
      // tool_a and tool_b exist, but "undo_tool" does NOT exist
      const registry = makeToolRegistry(["tool_a", "tool_b"], {
        tool_a: { dangerous: false, readOnly: false },
        tool_b: { dangerous: false, readOnly: false },
      });
      const v2Response = makeLLMV2Response(
        "chain_with_bad_comp",
        "Chain with invalid compensation tool reference",
        [
          { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: true, compensatingAction: { toolName: "undo_tool", inputMappings: { key: "step_0.output" } } },
          { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
        ],
        true,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      const action: ChainMetadataV2 = JSON.parse(createdInstinct.action);
      // step_0 should have compensation stripped and reversible=false
      expect(action.steps[0].compensatingAction).toBeUndefined();
      expect(action.steps[0].reversible).toBe(false);
      // chain is NOT fully reversible since step_0 is irreversible
      expect(action.isFullyReversible).toBe(false);
    });

    it("readOnly tool forced reversible regardless of LLM classification", async () => {
      const storage = makeMockStorage(0);
      // tool_a is readOnly
      const registry = makeToolRegistry(["tool_a", "tool_b"], {
        tool_a: { readOnly: true, dangerous: false },
        tool_b: { readOnly: false, dangerous: false },
      });
      // LLM says tool_a reversible=false (wrong for readOnly)
      const v2Response = makeLLMV2Response(
        "read_chain",
        "Chain with read-only tool",
        [
          { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: false },
          { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
        ],
        false,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      await synthesizer.synthesize(candidates);

      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      const action: ChainMetadataV2 = JSON.parse(createdInstinct.action);
      // readOnly tool should be forced reversible
      expect(action.steps[0].reversible).toBe(true);
    });

    it("dangerous tool with no compensation forced irreversible", async () => {
      const storage = makeMockStorage(0);
      // tool_a is dangerous with no compensation
      const registry = makeToolRegistry(["tool_a", "tool_b"], {
        tool_a: { dangerous: true, readOnly: false },
        tool_b: { readOnly: false, dangerous: false },
      });
      // LLM says tool_a reversible=true but no compensation -- should be forced false
      const v2Response = makeLLMV2Response(
        "dangerous_chain",
        "Chain with dangerous tool",
        [
          { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: true },
          { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
        ],
        true,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      await synthesizer.synthesize(candidates);

      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      const action: ChainMetadataV2 = JSON.parse(createdInstinct.action);
      // dangerous tool with no compensation -> forced irreversible
      expect(action.steps[0].reversible).toBe(false);
      expect(action.isFullyReversible).toBe(false);
    });

    it("[rollback-capable] appended to description for fully reversible chains", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"], {
        tool_a: { readOnly: true },
        tool_b: { readOnly: true },
      });
      const v2Response = makeLLMV2Response(
        "reversible_chain",
        "A fully reversible chain",
        [
          { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: true },
          { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
        ],
        true,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
      expect(tools[0].description).toContain("[rollback-capable]");
    });

    it("cyclic DAG from LLM falls back to sequential", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"], {
        tool_a: { readOnly: false, dangerous: false },
        tool_b: { readOnly: false, dangerous: false },
      });
      // Cyclic: step_0 depends on step_1, step_1 depends on step_0
      const v2Response = makeLLMV2Response(
        "cyclic_chain",
        "Chain with cyclic DAG from LLM",
        [
          { stepId: "step_0", toolName: "tool_a", dependsOn: ["step_1"], reversible: true },
          { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
        ],
        true,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      const action: ChainMetadataV2 = JSON.parse(createdInstinct.action);
      // Should fallback to sequential: step_0 has no deps, step_1 depends on step_0
      expect(action.steps[0].dependsOn).toEqual([]);
      expect(action.steps[1].dependsOn).toEqual(["step_0"]);
    });

    it("V1 LLM output still works (backward compat)", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"]);
      // V1 response -- no steps or isFullyReversible fields
      const provider = makeProvider([makeLLMResponse("v1_chain", "A V1 chain description")]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("v1_chain");
      // V1 path should NOT have version:2 in action
      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      const action = JSON.parse(createdInstinct.action);
      expect(action.version).toBeUndefined();
      expect(action.toolSequence).toEqual(["tool_a", "tool_b"]);
    });

    it("V2 synthesis passes full V2 metadata to CompositeTool (not V1 compat)", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"], {
        tool_a: { readOnly: true },
        tool_b: { readOnly: true },
      });
      const v2Response = makeLLMV2Response(
        "v2_wiring_chain",
        "V2 wiring test chain",
        [
          { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: true },
          { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
        ],
        true,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
      // Verify the instinct.action stored has V2 format
      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      const action: ChainMetadataV2 = JSON.parse(createdInstinct.action);
      expect(action.version).toBe(2);
      expect(action.steps).toHaveLength(2);
      expect(action.steps[0].stepId).toBe("step_0");
      expect(action.isFullyReversible).toBe(true);
    });

    it("V1 synthesis passes V1 metadata to CompositeTool (no version field)", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"]);
      // V1 response -- no steps or isFullyReversible fields
      const provider = makeProvider([makeLLMResponse("v1_compat_chain", "V1 backward compat chain")]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      const tools = await synthesizer.synthesize(candidates);

      expect(tools).toHaveLength(1);
      const createdInstinct = vi.mocked(storage.createInstinct).mock.calls[0][0];
      const action = JSON.parse(createdInstinct.action);
      // V1 metadata should NOT have version or steps fields
      expect(action.version).toBeUndefined();
      expect(action.steps).toBeUndefined();
      expect(action.toolSequence).toEqual(["tool_a", "tool_b"]);
      expect(action.parameterMappings).toBeDefined();
    });

    it("tool names are sanitized in LLM prompt (prompt injection prevention)", async () => {
      const storage = makeMockStorage(0);
      // Register tools with injection-attempt names in the registry
      const injectionName = '"; DROP TABLE';
      const scriptName = "<script>alert</script>";
      const registry = makeToolRegistry([injectionName, scriptName], {
        [injectionName]: { dangerous: false, readOnly: false },
        [scriptName]: { dangerous: false, readOnly: false },
      });
      const v2Response = makeLLMV2Response(
        "sanitized_chain",
        "Chain with sanitized tool names",
        [
          { stepId: "step_0", toolName: injectionName, dependsOn: [], reversible: false },
          { stepId: "step_1", toolName: scriptName, dependsOn: ["step_0"], reversible: false },
        ],
        false,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate([injectionName, scriptName], 5)];
      await synthesizer.synthesize(candidates);

      // Verify the user message passed to LLM has sanitized names
      const chatCall = vi.mocked(provider.chat).mock.calls[0];
      const userMsg = chatCall[1][0].content;
      // Injection characters should be replaced with underscores
      expect(userMsg).not.toContain('"; DROP TABLE');
      expect(userMsg).not.toContain("<script>");
      // Sanitized forms should use underscores: [^\w.-] -> _
      expect(userMsg).toContain("___DROP_TABLE");
      expect(userMsg).toContain("_script_alert__script_");
    });

    it("LLM prompt includes tool registry context for compensation", async () => {
      const storage = makeMockStorage(0);
      const registry = makeToolRegistry(["tool_a", "tool_b"], {
        tool_a: { dangerous: true, readOnly: false },
        tool_b: { dangerous: false, readOnly: true },
      });
      const v2Response = makeLLMV2Response(
        "prompt_test_chain",
        "Test chain for prompt inspection",
        [
          { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: false },
          { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
        ],
        false,
      );
      const provider = makeProvider([v2Response]);
      const synthesizer = new ChainSynthesizer(storage, registry, eventBus, config);
      synthesizer.setProvider(provider);

      const candidates = [makeCandidate(["tool_a", "tool_b"], 5)];
      await synthesizer.synthesize(candidates);

      // Verify the user message passed to LLM includes tool registry context
      const chatCall = vi.mocked(provider.chat).mock.calls[0];
      const userMsg = chatCall[1][0].content;
      expect(userMsg).toContain("tool_a");
      expect(userMsg).toContain("dangerous");
      expect(userMsg).toContain("readOnly");
    });
  });
});
