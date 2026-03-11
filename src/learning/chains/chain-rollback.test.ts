/**
 * Chain Rollback Executor Tests
 *
 * Tests for saga-pattern rollback with compensation actions,
 * timeout handling, and event emission.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeRollback } from "./chain-rollback.js";
import type { ChainMetadataV2, RollbackReport } from "./chain-types.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { IEventEmitter, LearningEventMap } from "../../core/event-bus.js";
import type { ToolContext } from "../../agents/tools/tool-core.interface.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeMetadata(overrides: Partial<ChainMetadataV2> = {}): ChainMetadataV2 {
  return {
    version: 2,
    toolSequence: ["tool_a", "tool_b", "tool_c"],
    steps: [
      {
        stepId: "step_0",
        toolName: "tool_a",
        dependsOn: [],
        reversible: true,
        compensatingAction: {
          toolName: "undo_a",
          inputMappings: { path: "outputPath" },
        },
      },
      {
        stepId: "step_1",
        toolName: "tool_b",
        dependsOn: ["step_0"],
        reversible: true,
        compensatingAction: {
          toolName: "undo_b",
          inputMappings: { id: "recordId" },
        },
      },
      {
        stepId: "step_2",
        toolName: "tool_c",
        dependsOn: ["step_1"],
        reversible: false,
      },
    ],
    parameterMappings: [],
    isFullyReversible: false,
    successRate: 0.9,
    occurrences: 10,
    ...overrides,
  };
}

function makeToolRegistry(executeFn?: (name: string) => Promise<{ content: string; isError?: boolean }>): ToolRegistry {
  const tools = new Map<string, { execute: ReturnType<typeof vi.fn> }>();

  return {
    get(name: string) {
      if (!tools.has(name)) {
        const execute = executeFn
          ? vi.fn((_input: unknown, _ctx: unknown) => executeFn(name))
          : vi.fn().mockResolvedValue({ content: "ok" });
        tools.set(name, { execute, name, description: `Mock ${name}`, inputSchema: {} } as never);
      }
      return tools.get(name);
    },
  } as unknown as ToolRegistry;
}

function makeContext(): ToolContext {
  return {
    projectPath: "/test",
    workingDirectory: "/test",
    readOnly: false,
    sessionId: "test-session",
  };
}

function makeEventBus(): IEventEmitter<LearningEventMap> & { calls: Array<{ event: string; payload: unknown }> } {
  const calls: Array<{ event: string; payload: unknown }> = [];
  return {
    emit: vi.fn((event: string, payload: unknown) => {
      calls.push({ event, payload });
    }),
    calls,
  } as unknown as IEventEmitter<LearningEventMap> & { calls: Array<{ event: string; payload: unknown }> };
}

// =============================================================================
// TESTS
// =============================================================================

describe("executeRollback", () => {
  let metadata: ChainMetadataV2;
  let registry: ToolRegistry;
  let context: ToolContext;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    metadata = makeMetadata();
    registry = makeToolRegistry();
    context = makeContext();
    eventBus = makeEventBus();
  });

  it("should rollback completed steps with valid compensation tools in reverse order", async () => {
    const stepOutputs = new Map<string, Record<string, unknown>>([
      ["step_0", { outputPath: "/tmp/file" }],
      ["step_1", { recordId: "rec_123" }],
    ]);

    const report = await executeRollback(
      "test_chain",
      ["step_0", "step_1"],
      stepOutputs,
      metadata,
      registry,
      context,
      30000,
      eventBus,
    );

    expect(report.finalState).toBe("fully_rolled_back");
    expect(report.stepsRolledBack).toHaveLength(2);
    // Reverse order: step_1 first, then step_0
    expect(report.stepsRolledBack[0].stepId).toBe("step_1");
    expect(report.stepsRolledBack[1].stepId).toBe("step_0");
    expect(report.rollbackFailures).toHaveLength(0);
  });

  it("should mark step as rollbackFailed on compensation tool error and continue", async () => {
    const failRegistry = makeToolRegistry(async (name: string) => {
      if (name === "undo_b") throw new Error("compensation failed");
      return { content: "ok" };
    });

    const stepOutputs = new Map<string, Record<string, unknown>>([
      ["step_0", { outputPath: "/tmp/file" }],
      ["step_1", { recordId: "rec_123" }],
    ]);

    const report = await executeRollback(
      "test_chain",
      ["step_0", "step_1"],
      stepOutputs,
      metadata,
      failRegistry,
      context,
      30000,
      eventBus,
    );

    expect(report.finalState).toBe("partially_rolled_back");
    expect(report.stepsRolledBack).toHaveLength(2);
    // step_1 rollback failed, step_0 succeeded
    expect(report.stepsRolledBack[0].stepId).toBe("step_1");
    expect(report.stepsRolledBack[0].success).toBe(false);
    expect(report.stepsRolledBack[0].state).toBe("rollbackFailed");
    expect(report.stepsRolledBack[1].stepId).toBe("step_0");
    expect(report.stepsRolledBack[1].success).toBe(true);
    expect(report.rollbackFailures).toContain("step_1");
  });

  it("should skip steps that have no compensating action defined", async () => {
    // step_2 has no compensatingAction
    const stepOutputs = new Map<string, Record<string, unknown>>([
      ["step_0", { outputPath: "/tmp/file" }],
      ["step_2", {}],
    ]);

    const report = await executeRollback(
      "test_chain",
      ["step_0", "step_2"],
      stepOutputs,
      metadata,
      registry,
      context,
      30000,
      eventBus,
    );

    // Only step_0 has compensation, step_2 is skipped
    expect(report.stepsRolledBack).toHaveLength(1);
    expect(report.stepsRolledBack[0].stepId).toBe("step_0");
  });

  it("should emit chain:rollback event with correct payload", async () => {
    const stepOutputs = new Map<string, Record<string, unknown>>([
      ["step_0", { outputPath: "/tmp/file" }],
    ]);

    await executeRollback(
      "test_chain",
      ["step_0"],
      stepOutputs,
      metadata,
      registry,
      context,
      30000,
      eventBus,
    );

    expect(eventBus.emit).toHaveBeenCalledOnce();
    const call = eventBus.calls[0];
    expect(call.event).toBe("chain:rollback");
    const payload = call.payload as Record<string, unknown>;
    expect(payload.chainName).toBe("test_chain");
    expect(payload.failedStep).toBeDefined();
    expect(payload.compensationResults).toBeDefined();
    expect(payload.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(payload.timestamp).toBeGreaterThan(0);
  });

  it("should return immediately with empty report for empty completedStepIds", async () => {
    const stepOutputs = new Map<string, Record<string, unknown>>();

    const report = await executeRollback(
      "test_chain",
      [],
      stepOutputs,
      metadata,
      registry,
      context,
      30000,
      eventBus,
    );

    expect(report.stepsCompleted).toHaveLength(0);
    expect(report.stepsRolledBack).toHaveLength(0);
    expect(report.rollbackFailures).toHaveLength(0);
    expect(report.finalState).toBe("fully_rolled_back");
  });

  it("should execute rollback in reverse completion order", async () => {
    const executionOrder: string[] = [];
    const trackingRegistry = makeToolRegistry(async (name: string) => {
      executionOrder.push(name);
      return { content: "ok" };
    });

    const stepOutputs = new Map<string, Record<string, unknown>>([
      ["step_0", { outputPath: "/tmp/file" }],
      ["step_1", { recordId: "rec_123" }],
    ]);

    await executeRollback(
      "test_chain",
      ["step_0", "step_1"],
      stepOutputs,
      metadata,
      trackingRegistry,
      context,
      30000,
      eventBus,
    );

    // Reverse order: step_1's undo_b first, then step_0's undo_a
    expect(executionOrder).toEqual(["undo_b", "undo_a"]);
  });

  it("should report rollback_failed when all compensations fail", async () => {
    const failAllRegistry = makeToolRegistry(async () => {
      throw new Error("all fail");
    });

    const stepOutputs = new Map<string, Record<string, unknown>>([
      ["step_0", { outputPath: "/tmp/file" }],
      ["step_1", { recordId: "rec_123" }],
    ]);

    const report = await executeRollback(
      "test_chain",
      ["step_0", "step_1"],
      stepOutputs,
      metadata,
      failAllRegistry,
      context,
      30000,
      eventBus,
    );

    expect(report.finalState).toBe("rollback_failed");
    expect(report.rollbackFailures).toHaveLength(2);
  });

  it("should handle compensation timeout by marking step as rollbackFailed", async () => {
    const slowRegistry = makeToolRegistry(async (name: string) => {
      if (name === "undo_b") {
        // Simulate a long-running operation that would exceed timeout
        await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), 50);
        });
      }
      return { content: "ok" };
    });

    const stepOutputs = new Map<string, Record<string, unknown>>([
      ["step_0", { outputPath: "/tmp/file" }],
      ["step_1", { recordId: "rec_123" }],
    ]);

    const report = await executeRollback(
      "test_chain",
      ["step_0", "step_1"],
      stepOutputs,
      metadata,
      slowRegistry,
      context,
      30000,
      eventBus,
    );

    // step_1 compensation timed out/failed, step_0 succeeded
    expect(report.stepsRolledBack[0].stepId).toBe("step_1");
    expect(report.stepsRolledBack[0].success).toBe(false);
    expect(report.stepsRolledBack[0].state).toBe("rollbackFailed");
    expect(report.finalState).toBe("partially_rolled_back");
  });
});
