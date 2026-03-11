/**
 * CompositeTool Tests
 *
 * Tests for sequential chain execution with parameter mapping.
 * Covers success, failure, parameter flow, validation, and events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CompositeTool } from "./composite-tool.js";
import type {
  ChainMetadata,
  ChainMetadataV2,
  ChainStepMapping,
  ChainStepNode,
  ChainResilienceConfig,
  RollbackReport,
} from "./chain-types.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { IEventEmitter, LearningEventMap, ChainExecutionEvent } from "../../core/event-bus.js";
import type { ToolContext, ToolExecutionResult } from "../../agents/tools/tool.interface.js";

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

function makeMappings(mappings: ChainStepMapping[]): ChainStepMapping[] {
  return mappings;
}

function makeChainMetadata(
  toolSequence: string[],
  parameterMappings: ChainStepMapping[] = [],
): ChainMetadata {
  return {
    toolSequence,
    parameterMappings,
    successRate: 0.9,
    occurrences: 5,
  };
}

function makeToolRegistry(toolResults: Record<string, ToolExecutionResult>): ToolRegistry {
  const existingTools = new Set(Object.keys(toolResults));
  return {
    has: vi.fn((name: string) => existingTools.has(name)),
    execute: vi.fn(async (name: string, _input: Record<string, unknown>, _context: ToolContext) => {
      return toolResults[name] ?? { content: `Error: Tool '${name}' not found`, isError: true };
    }),
  } as unknown as ToolRegistry;
}

function makeEventBus(): IEventEmitter<LearningEventMap> & { emitCalls: Array<{ event: string; payload: unknown }> } {
  const emitCalls: Array<{ event: string; payload: unknown }> = [];
  return {
    emit: vi.fn((event: string, payload: unknown) => {
      emitCalls.push({ event, payload });
    }),
    emitCalls,
  } as unknown as IEventEmitter<LearningEventMap> & { emitCalls: Array<{ event: string; payload: unknown }> };
}

// =============================================================================
// TESTS
// =============================================================================

describe("CompositeTool", () => {
  let context: ToolContext;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    context = makeContext();
    eventBus = makeEventBus();
  });

  describe("properties", () => {
    it("should implement ITool interface with name, description, inputSchema", () => {
      const registry = makeToolRegistry({ tool_a: { content: "ok" }, tool_b: { content: "ok" } });
      const tool = new CompositeTool(
        {
          name: "my_chain",
          description: "A test chain",
          inputSchema: { type: "object" },
          chainMetadata: makeChainMetadata(["tool_a", "tool_b"]),
        },
        registry,
        eventBus,
      );

      expect(tool.name).toBe("my_chain");
      expect(tool.description).toBe("A test chain");
      expect(tool.inputSchema).toEqual({ type: "object" });
    });
  });

  describe("execute()", () => {
    it("should execute a 2-step chain and return combined output", async () => {
      const registry = makeToolRegistry({
        tool_a: { content: '{"result": "step1_output"}' },
        tool_b: { content: '{"final": "done"}' },
      });
      const tool = new CompositeTool(
        {
          name: "test_chain",
          description: "Test 2-step chain",
          inputSchema: {},
          chainMetadata: makeChainMetadata(["tool_a", "tool_b"]),
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("tool_a");
      expect(result.content).toContain("tool_b");
    });

    it("should pass mapped output from step 1 to step 2 (previousOutput source)", async () => {
      const registry = makeToolRegistry({
        tool_a: { content: '{"filePath": "/test/file.ts"}' },
        tool_b: { content: '{"written": true}' },
      });
      const mappings = makeMappings([
        {
          stepIndex: 1,
          parameterName: "path",
          source: "previousOutput",
          sourceKey: "filePath",
        },
      ]);
      const tool = new CompositeTool(
        {
          name: "test_chain",
          description: "Chain with mapping",
          inputSchema: {},
          chainMetadata: makeChainMetadata(["tool_a", "tool_b"], mappings),
        },
        registry,
        eventBus,
      );

      await tool.execute({}, context);

      // tool_b should have received path=/test/file.ts
      const executeCall = vi.mocked(registry.execute).mock.calls[1];
      expect(executeCall[0]).toBe("tool_b");
      expect(executeCall[1]).toEqual(expect.objectContaining({ path: "/test/file.ts" }));
    });

    it("should make original user input available to all steps (userInput source)", async () => {
      const registry = makeToolRegistry({
        tool_a: { content: "ok" },
        tool_b: { content: "ok" },
      });
      const mappings = makeMappings([
        {
          stepIndex: 0,
          parameterName: "query",
          source: "userInput",
          sourceKey: "searchTerm",
        },
        {
          stepIndex: 1,
          parameterName: "query",
          source: "userInput",
          sourceKey: "searchTerm",
        },
      ]);
      const tool = new CompositeTool(
        {
          name: "test_chain",
          description: "Chain with user input",
          inputSchema: {},
          chainMetadata: makeChainMetadata(["tool_a", "tool_b"], mappings),
        },
        registry,
        eventBus,
      );

      await tool.execute({ searchTerm: "hello" }, context);

      // Both steps should receive query=hello from user input
      expect(vi.mocked(registry.execute).mock.calls[0][1]).toEqual(
        expect.objectContaining({ query: "hello" }),
      );
      expect(vi.mocked(registry.execute).mock.calls[1][1]).toEqual(
        expect.objectContaining({ query: "hello" }),
      );
    });

    it("should handle constant parameter mapping", async () => {
      const registry = makeToolRegistry({
        tool_a: { content: "ok" },
      });
      const mappings = makeMappings([
        {
          stepIndex: 0,
          parameterName: "format",
          source: "constant",
          defaultValue: "json",
        },
      ]);
      const tool = new CompositeTool(
        {
          name: "test_chain",
          description: "Chain with constant",
          inputSchema: {},
          chainMetadata: makeChainMetadata(["tool_a"], []),
        },
        registry,
        eventBus,
      );
      // Override the metadata to use single-tool chain for simplicity
      // Actually, chain must be 2+ tools per schema. Let's use 2.
      const tool2 = new CompositeTool(
        {
          name: "test_chain",
          description: "Chain with constant",
          inputSchema: {},
          chainMetadata: {
            toolSequence: ["tool_a", "tool_a"],
            parameterMappings: [
              {
                stepIndex: 0,
                parameterName: "format",
                source: "constant",
                defaultValue: "json",
              },
            ],
            successRate: 0.9,
            occurrences: 5,
          },
        },
        makeToolRegistry({ tool_a: { content: "ok" } }),
        eventBus,
      );

      await tool2.execute({}, context);

      expect(vi.mocked(tool2["toolRegistry"].execute).mock.calls[0][1]).toEqual(
        expect.objectContaining({ format: "json" }),
      );
    });

    it("should return error if a tool is missing at execution time (TOOL-05)", async () => {
      const registry = {
        has: vi.fn((name: string) => name === "tool_a"), // tool_b missing
        execute: vi.fn(),
      } as unknown as ToolRegistry;
      const tool = new CompositeTool(
        {
          name: "test_chain",
          description: "Chain with missing tool",
          inputSchema: {},
          chainMetadata: makeChainMetadata(["tool_a", "tool_b"]),
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("tool_b");
      expect(result.content.toLowerCase()).toContain("no longer exists");
    });

    it("should fail immediately if any step fails and return step info", async () => {
      const registry = {
        has: vi.fn().mockReturnValue(true),
        execute: vi
          .fn()
          .mockResolvedValueOnce({ content: "ok" })
          .mockResolvedValueOnce({ content: "Something went wrong", isError: true }),
      } as unknown as ToolRegistry;
      const tool = new CompositeTool(
        {
          name: "test_chain",
          description: "Chain with failing step",
          inputSchema: {},
          chainMetadata: makeChainMetadata(["tool_a", "tool_b"]),
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("tool_b");
      // Should not have called a 3rd tool
      expect(registry.execute).toHaveBeenCalledTimes(2);
    });

    it("should emit chain:executed event on success", async () => {
      const registry = makeToolRegistry({
        tool_a: { content: "ok" },
        tool_b: { content: "ok" },
      });
      const tool = new CompositeTool(
        {
          name: "test_chain",
          description: "Success chain",
          inputSchema: {},
          chainMetadata: makeChainMetadata(["tool_a", "tool_b"]),
        },
        registry,
        eventBus,
      );

      await tool.execute({}, context);

      const chainEvent = eventBus.emitCalls.find((c) => c.event === "chain:executed");
      expect(chainEvent).toBeDefined();
      const payload = chainEvent!.payload as ChainExecutionEvent;
      expect(payload.chainName).toBe("test_chain");
      expect(payload.success).toBe(true);
      expect(payload.stepResults).toHaveLength(2);
    });

    it("should emit chain:executed event with success=false on failure", async () => {
      const registry = {
        has: vi.fn().mockReturnValue(true),
        execute: vi
          .fn()
          .mockResolvedValueOnce({ content: "ok" })
          .mockResolvedValueOnce({ content: "fail", isError: true }),
      } as unknown as ToolRegistry;
      const tool = new CompositeTool(
        {
          name: "test_chain",
          description: "Failing chain",
          inputSchema: {},
          chainMetadata: makeChainMetadata(["tool_a", "tool_b"]),
        },
        registry,
        eventBus,
      );

      await tool.execute({}, context);

      const chainEvent = eventBus.emitCalls.find((c) => c.event === "chain:executed");
      expect(chainEvent).toBeDefined();
      const payload = chainEvent!.payload as ChainExecutionEvent;
      expect(payload.success).toBe(false);
    });
  });

  // ===========================================================================
  // V2 CHAIN TESTS (Phase 22 -- DAG Parallel + Saga Rollback)
  // ===========================================================================

  describe("V2 chain execution", () => {
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

    it("should execute V2 chain with 2 sequential steps successfully", async () => {
      const steps: ChainStepNode[] = [
        { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: false },
        { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: false },
      ];
      const registry = makeToolRegistry({
        tool_a: { content: '{"result": "a_out"}' },
        tool_b: { content: '{"result": "b_out"}' },
      });
      const tool = new CompositeTool(
        {
          name: "v2_chain",
          description: "V2 sequential chain",
          inputSchema: {},
          chainMetadata: makeV2Metadata(steps),
          resilienceConfig: defaultResilience,
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("tool_a");
      expect(result.content).toContain("tool_b");
    });

    it("should trigger rollback on failure when isFullyReversible=true", async () => {
      const steps: ChainStepNode[] = [
        {
          stepId: "step_0",
          toolName: "tool_a",
          dependsOn: [],
          reversible: true,
          compensatingAction: { toolName: "undo_a", inputMappings: {} },
        },
        { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
      ];
      const registry = {
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue({ content: "undone" }),
        }),
        execute: vi
          .fn()
          .mockResolvedValueOnce({ content: '{"result": "a_out"}' })
          .mockResolvedValueOnce({ content: "fail", isError: true }),
      } as unknown as ToolRegistry;

      const tool = new CompositeTool(
        {
          name: "v2_rollback_chain",
          description: "V2 chain with rollback [rollback-capable]",
          inputSchema: {},
          chainMetadata: makeV2Metadata(steps, { isFullyReversible: true }),
          resilienceConfig: defaultResilience,
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      // Should emit chain:executed with rollbackReport
      const chainEvent = eventBus.emitCalls.find((c) => c.event === "chain:executed");
      expect(chainEvent).toBeDefined();
      const payload = chainEvent!.payload as ChainExecutionEvent;
      expect(payload.rollbackReport).toBeDefined();
    });

    it("should emit forwardRecovery when isFullyReversible=false", async () => {
      const steps: ChainStepNode[] = [
        { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: false },
        { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: false },
      ];
      const registry = {
        has: vi.fn().mockReturnValue(true),
        execute: vi
          .fn()
          .mockResolvedValueOnce({ content: '{"result": "a_out"}' })
          .mockResolvedValueOnce({ content: "fail", isError: true }),
      } as unknown as ToolRegistry;

      const tool = new CompositeTool(
        {
          name: "v2_fwd_chain",
          description: "V2 chain non-reversible",
          inputSchema: {},
          chainMetadata: makeV2Metadata(steps, { isFullyReversible: false }),
          resilienceConfig: defaultResilience,
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      const chainEvent = eventBus.emitCalls.find((c) => c.event === "chain:executed");
      expect(chainEvent).toBeDefined();
      const payload = chainEvent!.payload as ChainExecutionEvent;
      expect(payload.forwardRecovery).toBe(true);
      expect(payload.rollbackReport).toBeUndefined();
    });

    it("should use sequential V1 path when chain has no steps array", async () => {
      const v1Meta = makeChainMetadata(["tool_a", "tool_b"]);
      const registry = makeToolRegistry({
        tool_a: { content: '{"result": "a_out"}' },
        tool_b: { content: '{"result": "b_out"}' },
      });
      const tool = new CompositeTool(
        {
          name: "v1_compat_chain",
          description: "V1 chain backward compat",
          inputSchema: {},
          chainMetadata: v1Meta,
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("tool_a");
      expect(result.content).toContain("tool_b");
    });

    it("should skip rollback when CHAIN_ROLLBACK_ENABLED=false even if isFullyReversible", async () => {
      const steps: ChainStepNode[] = [
        {
          stepId: "step_0",
          toolName: "tool_a",
          dependsOn: [],
          reversible: true,
          compensatingAction: { toolName: "undo_a", inputMappings: {} },
        },
        { stepId: "step_1", toolName: "tool_b", dependsOn: ["step_0"], reversible: true },
      ];
      const registry = {
        has: vi.fn().mockReturnValue(true),
        execute: vi
          .fn()
          .mockResolvedValueOnce({ content: '{"result": "a_out"}' })
          .mockResolvedValueOnce({ content: "fail", isError: true }),
      } as unknown as ToolRegistry;

      const tool = new CompositeTool(
        {
          name: "v2_no_rollback",
          description: "V2 chain rollback disabled",
          inputSchema: {},
          chainMetadata: makeV2Metadata(steps, { isFullyReversible: true }),
          resilienceConfig: { ...defaultResilience, rollbackEnabled: false },
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBe(true);
      const chainEvent = eventBus.emitCalls.find((c) => c.event === "chain:executed");
      const payload = chainEvent!.payload as ChainExecutionEvent;
      expect(payload.forwardRecovery).toBe(true);
      expect(payload.rollbackReport).toBeUndefined();
    });

    it("should run V2 steps sequentially when CHAIN_PARALLEL_ENABLED=false", async () => {
      const steps: ChainStepNode[] = [
        { stepId: "step_0", toolName: "tool_a", dependsOn: [], reversible: false },
        { stepId: "step_1", toolName: "tool_b", dependsOn: [], reversible: false },
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
          name: "v2_seq_chain",
          description: "V2 chain sequential mode",
          inputSchema: {},
          chainMetadata: makeV2Metadata(steps),
          resilienceConfig: { ...defaultResilience, parallelEnabled: false },
        },
        registry,
        eventBus,
      );

      const result = await tool.execute({}, context);

      expect(result.isError).toBeFalsy();
      // Both tools executed
      expect(executionOrder).toContain("tool_a");
      expect(executionOrder).toContain("tool_b");
    });
  });
});
