/**
 * Depth-2 expansion under the total node cap.
 *
 * audited 2026-09-02: when a flagged sub-goal decomposed into more children
 * than the remaining slots, the loop wrote the first few and silently dropped
 * the rest. `buildNodesFromLLM` remaps `dependsOn` over ALL children before
 * that truncation, so a survivor could point at a node that never entered the
 * tree — and `computeWaves` treats an unknown dep as already satisfied. Two
 * silent caps plus that assumption produced an undetectable partial plan.
 *
 * Expansion is now all-or-nothing and audible: if the children do not fit,
 * none are written (the flagged parent stays a single coherent schedulable
 * node) and a warning names the parent, how many were wanted and how many
 * slots were left.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalDecomposer } from "./goal-decomposer.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { ProviderResponse } from "../agents/providers/provider-core.interface.js";

const warn = vi.fn();
const info = vi.fn();

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ debug: vi.fn(), info, warn, error: vi.fn() }),
}));

function createMockProvider(responses: string[]): IAIProvider {
  let callIndex = 0;
  return {
    name: "mock",
    capabilities: { streaming: false, vision: false, functionCalling: true },
    chat: vi.fn(async (): Promise<ProviderResponse> => {
      const text = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return { text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, stopReason: "end" };
    }),
  };
}

/** Root + five plain depth-1 nodes + one flagged = 7 of 8 slots used. */
const DEPTH1_SIX_ONE_FLAGGED = JSON.stringify({
  nodes: [
    { id: "s1", task: "Setup infrastructure", dependsOn: [], needsFurtherDecomposition: true },
    { id: "s2", task: "Write models", dependsOn: ["s1"] },
    { id: "s3", task: "Write controllers", dependsOn: ["s2"] },
    { id: "s4", task: "Write views", dependsOn: ["s2"] },
    { id: "s5", task: "Write tests", dependsOn: ["s3", "s4"] },
    { id: "s6", task: "Write docs", dependsOn: ["s5"] },
  ],
});

/** Three children; c1 forward-references c3 (validateDAG allows any array order). */
const SUB_THREE_WITH_FORWARD_DEP = JSON.stringify({
  nodes: [
    { id: "c1", task: "Wire the connection pool", dependsOn: ["c3"] },
    { id: "c2", task: "Seed reference data", dependsOn: ["c3"] },
    { id: "c3", task: "Create the database", dependsOn: [] },
  ],
});

beforeEach(() => {
  warn.mockClear();
  info.mockClear();
});

describe("depth-2 expansion at the node cap", () => {
  it("never writes a child whose dependsOn points at a node that was not written", async () => {
    const provider = createMockProvider([DEPTH1_SIX_ONE_FLAGGED, SUB_THREE_WITH_FORWARD_DEP]);
    const decomposer = new GoalDecomposer(provider, 3);
    decomposer.setDecompositionContext({ providerCount: 1, maxTotalNodes: 8 });

    const tree = await decomposer.decomposeProactive("s", "Build the whole service with infrastructure, models, controllers, views, tests and docs");

    expect(tree.nodes.size).toBeLessThanOrEqual(8);
    for (const node of tree.nodes.values()) {
      for (const dep of node.dependsOn) {
        expect(tree.nodes.has(dep), `node "${node.task}" depends on ${dep}, which is not in the tree`).toBe(true);
      }
    }
  });

  it("skips the expansion entirely (all-or-nothing) when the children do not fit", async () => {
    const provider = createMockProvider([DEPTH1_SIX_ONE_FLAGGED, SUB_THREE_WITH_FORWARD_DEP]);
    const decomposer = new GoalDecomposer(provider, 3);
    decomposer.setDecompositionContext({ providerCount: 1, maxTotalNodes: 8 });

    const tree = await decomposer.decomposeProactive("s", "Build the whole service with infrastructure, models, controllers, views, tests and docs");

    const depth2 = [...tree.nodes.values()].filter((n) => n.depth === 2);
    expect(depth2).toHaveLength(0);
    // The flagged parent remains a single, schedulable node carrying the work.
    const parent = [...tree.nodes.values()].find((n) => n.task === "Setup infrastructure");
    expect(parent?.status).toBe("pending");
  });

  it("warns, naming the parent, how many children were wanted and how many slots remained", async () => {
    const provider = createMockProvider([DEPTH1_SIX_ONE_FLAGGED, SUB_THREE_WITH_FORWARD_DEP]);
    const decomposer = new GoalDecomposer(provider, 3);
    decomposer.setDecompositionContext({ providerCount: 1, maxTotalNodes: 8 });

    await decomposer.decomposeProactive("s", "Build the whole service with infrastructure, models, controllers, views, tests and docs");

    const capWarn = warn.mock.calls.find(([msg]) => String(msg).includes("node cap"));
    expect(capWarn).toBeDefined();
    const meta = capWarn![1] as Record<string, unknown>;
    expect(meta.parentTask).toBe("Setup infrastructure");
    expect(meta.wanted).toBe(3);
    expect(meta.remainingSlots).toBe(1);
    expect(meta.maxTotalNodes).toBe(8);
  });

  it("still expands fully when the children fit under the cap", async () => {
    const provider = createMockProvider([DEPTH1_SIX_ONE_FLAGGED, SUB_THREE_WITH_FORWARD_DEP]);
    const decomposer = new GoalDecomposer(provider, 3);
    decomposer.setDecompositionContext({ providerCount: 1, maxTotalNodes: 12 });

    const tree = await decomposer.decomposeProactive("s", "Build the whole service with infrastructure, models, controllers, views, tests and docs");

    const depth2 = [...tree.nodes.values()].filter((n) => n.depth === 2);
    expect(depth2).toHaveLength(3);
    expect(tree.nodes.size).toBe(10);
    expect(warn.mock.calls.find(([msg]) => String(msg).includes("node cap"))).toBeUndefined();
  });

  it("warns when flagged parents are left unexpanded because the cap is already full", async () => {
    const depth1TwoFlagged = JSON.stringify({
      nodes: [
        { id: "s1", task: "Part A", dependsOn: [], needsFurtherDecomposition: true },
        { id: "s2", task: "Part B", dependsOn: [], needsFurtherDecomposition: true },
      ],
    });
    const twoChildren = JSON.stringify({
      nodes: [
        { id: "a1", task: "A step 1", dependsOn: [] },
        { id: "a2", task: "A step 2", dependsOn: ["a1"] },
      ],
    });
    // root + 2 + 2 = 5 = cap; Part B can never be expanded.
    const provider = createMockProvider([depth1TwoFlagged, twoChildren]);
    const decomposer = new GoalDecomposer(provider, 3);
    decomposer.setDecompositionContext({ providerCount: 1, maxTotalNodes: 5 });

    const tree = await decomposer.decomposeProactive("s", "Do part A and part B, each of which is a multi-step piece of work");

    expect(tree.nodes.size).toBe(5);
    const capWarn = warn.mock.calls.find(([msg]) => String(msg).includes("left unexpanded"));
    expect(capWarn).toBeDefined();
    const meta = capWarn![1] as Record<string, unknown>;
    expect(meta.unexpandedTasks).toEqual(["Part B"]);
    expect(meta.maxTotalNodes).toBe(5);
  });
});
