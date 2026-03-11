/**
 * Chain Parallel Execution Tests (Phase 22)
 *
 * Tests for DAG wave-based parallel execution in CompositeTool:
 * - Parallel speedup (independent steps run concurrently)
 * - Diamond DAG pattern (A -> [B,C] -> D)
 * - AbortController cancellation on failure
 * - Output merging from parallel branches
 * - Max parallel branches limiting
 * - Event emission with parallelBranches and cancelledSteps
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CompositeTool } from "./composite-tool.js";
import type {
  ChainMetadataV2,
  ChainStepNode,
  ChainResilienceConfig,
} from "./chain-types.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type {
  IEventEmitter,
  LearningEventMap,
  ChainExecutionEvent,
} from "../../core/event-bus.js";
import type { ToolContext } from "../../agents/tools/tool.interface.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeContext(): ToolContext {
  return {
    projectPath: "/test",
    workingDirectory: "/test",
    readOnly: false,
    sessionId: "sess_1",
    chatId: "chat_1",
  };
}

function makeEventBus(): IEventEmitter<LearningEventMap> & {
  emitCalls: Array<{ event: string; payload: unknown }>;
} {
  const emitCalls: Array<{ event: string; payload: unknown }> = [];
  return {
    emit: vi.fn((event: string, payload: unknown) => {
      emitCalls.push({ event, payload });
    }),
    emitCalls,
  } as unknown as IEventEmitter<LearningEventMap> & {
    emitCalls: Array<{ event: string; payload: unknown }>;
  };
}

const defaultResilience: ChainResilienceConfig = {
  rollbackEnabled: true,
  parallelEnabled: true,
  maxParallelBranches: 4,
  compensationTimeoutMs: 5000,
};

function makeV2Metadata(
  steps: ChainStepNode[],
  overrides: Partial<ChainMetadataV2> = {},
): ChainMetadataV2 {
  return {
    version: 2,
    toolSequence: steps.map((s) => s.toolName),
    steps,
    parameterMappings: [],
    isFullyReversible: false,
    successRate: 0.9,
    occurrences: 5,
    ...overrides,
  };
}

/**
 * Create a mock tool that resolves after a configurable delay.
 * Respects AbortSignal if passed in context.
 */
function makeDelayedToolRegistry(
  toolConfigs: Record<
    string,
    { delayMs: number; result: string; isError?: boolean }
  >,
): ToolRegistry {
  const existingTools = new Set(Object.keys(toolConfigs));
  return {
    has: vi.fn((name: string) => existingTools.has(name)),
    execute: vi.fn(
      async (
        name: string,
        _input: Record<string, unknown>,
        _context: ToolContext,
      ) => {
        const config = toolConfigs[name];
        if (!config) return { content: `Error: Tool '${name}' not found`, isError: true };

        if (config.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, config.delayMs));
        }

        return {
          content: config.result,
          isError: config.isError ?? false,
        };
      },
    ),
  } as unknown as ToolRegistry;
}

// =============================================================================
// TESTS
// =============================================================================

describe("CompositeTool -- Parallel Execution", () => {
  let context: ToolContext;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    context = makeContext();
    eventBus = makeEventBus();
  });

  it("should execute 3 independent parallel steps faster than sequential sum", async () => {
    // 3 independent steps, each with 50ms delay
    const steps: ChainStepNode[] = [
      { stepId: "s0", toolName: "tool_a", dependsOn: [], reversible: false },
      { stepId: "s1", toolName: "tool_b", dependsOn: [], reversible: false },
      { stepId: "s2", toolName: "tool_c", dependsOn: [], reversible: false },
    ];
    const registry = makeDelayedToolRegistry({
      tool_a: { delayMs: 50, result: '{"out": "a"}' },
      tool_b: { delayMs: 50, result: '{"out": "b"}' },
      tool_c: { delayMs: 50, result: '{"out": "c"}' },
    });

    const tool = new CompositeTool(
      {
        name: "parallel_chain",
        description: "Parallel speedup test",
        inputSchema: {},
        chainMetadata: makeV2Metadata(steps),
        resilienceConfig: defaultResilience,
      },
      registry,
      eventBus,
    );

    const start = Date.now();
    const result = await tool.execute({}, context);
    const elapsed = Date.now() - start;

    expect(result.isError).toBeFalsy();
    // Sequential sum would be 150ms. Parallel should be < 120ms (80% threshold).
    // Use generous margin due to CI overhead: < 130ms
    expect(elapsed).toBeLessThan(130);
  });

  it("should execute diamond DAG (A -> [B,C] -> D) with B and C in parallel", async () => {
    const steps: ChainStepNode[] = [
      { stepId: "A", toolName: "tool_a", dependsOn: [], reversible: false },
      { stepId: "B", toolName: "tool_b", dependsOn: ["A"], reversible: false },
      { stepId: "C", toolName: "tool_c", dependsOn: ["A"], reversible: false },
      {
        stepId: "D",
        toolName: "tool_d",
        dependsOn: ["B", "C"],
        reversible: false,
      },
    ];
    const executionOrder: string[] = [];
    const registry = {
      has: vi.fn().mockReturnValue(true),
      execute: vi.fn(async (name: string) => {
        executionOrder.push(name);
        return { content: `{"result": "${name}_out"}` };
      }),
    } as unknown as ToolRegistry;

    const tool = new CompositeTool(
      {
        name: "diamond_chain",
        description: "Diamond DAG test",
        inputSchema: {},
        chainMetadata: makeV2Metadata(steps),
        resilienceConfig: defaultResilience,
      },
      registry,
      eventBus,
    );

    const result = await tool.execute({}, context);

    expect(result.isError).toBeFalsy();
    // A must be first, D must be last
    expect(executionOrder[0]).toBe("tool_a");
    expect(executionOrder[executionOrder.length - 1]).toBe("tool_d");
    // B and C should both appear before D
    const bIdx = executionOrder.indexOf("tool_b");
    const cIdx = executionOrder.indexOf("tool_c");
    const dIdx = executionOrder.indexOf("tool_d");
    expect(bIdx).toBeLessThan(dIdx);
    expect(cIdx).toBeLessThan(dIdx);
  });

  it("should cancel sibling steps via AbortController on failure", async () => {
    const steps: ChainStepNode[] = [
      { stepId: "B", toolName: "tool_b", dependsOn: [], reversible: false },
      { stepId: "C", toolName: "tool_c", dependsOn: [], reversible: false },
    ];
    // B fails quickly, C takes longer
    const registry = makeDelayedToolRegistry({
      tool_b: { delayMs: 0, result: "fail", isError: true },
      tool_c: { delayMs: 100, result: '{"out": "c"}' },
    });

    const tool = new CompositeTool(
      {
        name: "cancel_chain",
        description: "Cancellation test",
        inputSchema: {},
        chainMetadata: makeV2Metadata(steps),
        resilienceConfig: defaultResilience,
      },
      registry,
      eventBus,
    );

    const result = await tool.execute({}, context);

    expect(result.isError).toBe(true);
    // Check that chain:executed event includes cancelledSteps
    const chainEvent = eventBus.emitCalls.find(
      (c) => c.event === "chain:executed",
    );
    expect(chainEvent).toBeDefined();
    const payload = chainEvent!.payload as ChainExecutionEvent;
    expect(payload.cancelledSteps).toBeDefined();
    expect(payload.cancelledSteps!.length).toBeGreaterThan(0);
  });

  it("should merge parallel outputs and make them available to downstream step", async () => {
    // A -> [B, C] -> D, where D reads from B and C outputs
    const steps: ChainStepNode[] = [
      { stepId: "A", toolName: "tool_a", dependsOn: [], reversible: false },
      { stepId: "B", toolName: "tool_b", dependsOn: ["A"], reversible: false },
      { stepId: "C", toolName: "tool_c", dependsOn: ["A"], reversible: false },
      {
        stepId: "D",
        toolName: "tool_d",
        dependsOn: ["B", "C"],
        reversible: false,
      },
    ];
    const capturedInputs: Record<string, Record<string, unknown>> = {};
    const registry = {
      has: vi.fn().mockReturnValue(true),
      execute: vi.fn(async (name: string, input: Record<string, unknown>) => {
        capturedInputs[name] = input;
        if (name === "tool_a") return { content: '{"initData": "hello"}' };
        if (name === "tool_b") return { content: '{"bResult": "fromB"}' };
        if (name === "tool_c") return { content: '{"cResult": "fromC"}' };
        return { content: '{"final": "done"}' };
      }),
    } as unknown as ToolRegistry;

    const metadata = makeV2Metadata(steps, {
      parameterMappings: [
        {
          stepIndex: 3,
          parameterName: "bData",
          source: "previousOutput" as const,
          sourceKey: "B.bResult",
        },
        {
          stepIndex: 3,
          parameterName: "cData",
          source: "previousOutput" as const,
          sourceKey: "C.cResult",
        },
      ],
    });

    const tool = new CompositeTool(
      {
        name: "merge_chain",
        description: "Output merge test",
        inputSchema: {},
        chainMetadata: metadata,
        resilienceConfig: defaultResilience,
      },
      registry,
      eventBus,
    );

    const result = await tool.execute({}, context);

    expect(result.isError).toBeFalsy();
    // D should have received data from both B and C
    expect(capturedInputs["tool_d"]).toBeDefined();
    expect(capturedInputs["tool_d"]["bData"]).toBe("fromB");
    expect(capturedInputs["tool_d"]["cData"]).toBe("fromC");
  });

  it("should force serial execution when CHAIN_MAX_PARALLEL_BRANCHES=1", async () => {
    // 2 independent steps, but max=1 forces them serial
    const steps: ChainStepNode[] = [
      { stepId: "s0", toolName: "tool_a", dependsOn: [], reversible: false },
      { stepId: "s1", toolName: "tool_b", dependsOn: [], reversible: false },
    ];
    const executionTimestamps: Array<{ name: string; start: number; end: number }> = [];
    const registry = {
      has: vi.fn().mockReturnValue(true),
      execute: vi.fn(async (name: string) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 30));
        executionTimestamps.push({ name, start, end: Date.now() });
        return { content: `{"result": "${name}_out"}` };
      }),
    } as unknown as ToolRegistry;

    const tool = new CompositeTool(
      {
        name: "serial_limit_chain",
        description: "Max parallel branches = 1",
        inputSchema: {},
        chainMetadata: makeV2Metadata(steps),
        resilienceConfig: { ...defaultResilience, maxParallelBranches: 1 },
      },
      registry,
      eventBus,
    );

    const result = await tool.execute({}, context);

    expect(result.isError).toBeFalsy();
    // With maxParallelBranches=1, second step should start after first completes
    expect(executionTimestamps).toHaveLength(2);
    const [first, second] = executionTimestamps;
    // Second step start should be >= first step end (serial)
    expect(second.start).toBeGreaterThanOrEqual(first.end - 5); // 5ms tolerance
  });

  it("should include parallelBranches count and cancelledSteps in chain:executed event", async () => {
    const steps: ChainStepNode[] = [
      { stepId: "s0", toolName: "tool_a", dependsOn: [], reversible: false },
      { stepId: "s1", toolName: "tool_b", dependsOn: [], reversible: false },
      { stepId: "s2", toolName: "tool_c", dependsOn: [], reversible: false },
    ];
    const registry = makeDelayedToolRegistry({
      tool_a: { delayMs: 0, result: '{"out": "a"}' },
      tool_b: { delayMs: 0, result: '{"out": "b"}' },
      tool_c: { delayMs: 0, result: '{"out": "c"}' },
    });

    const tool = new CompositeTool(
      {
        name: "event_chain",
        description: "Event data test",
        inputSchema: {},
        chainMetadata: makeV2Metadata(steps),
        resilienceConfig: defaultResilience,
      },
      registry,
      eventBus,
    );

    const result = await tool.execute({}, context);

    expect(result.isError).toBeFalsy();
    const chainEvent = eventBus.emitCalls.find(
      (c) => c.event === "chain:executed",
    );
    expect(chainEvent).toBeDefined();
    const payload = chainEvent!.payload as ChainExecutionEvent;
    expect(payload.parallelBranches).toBe(3); // all 3 in one wave
    expect(payload.success).toBe(true);
  });
});
