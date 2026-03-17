/**
 * GoalDecomposer Tests
 *
 * Tests for:
 * - shouldDecompose: heuristic pre-check (length, simple patterns, complexity indicators)
 * - decomposeProactive: DAG generation, depth limit, retry/fallback, recursive decomposition
 * - decomposeReactive: failing node decomposition, depth guard, failure context
 * - Fallback: single-node tree when no provider or LLM fails
 * - Cycle detection: invalid LLM output rejected, falls back to flat sequential
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalDecomposer } from "./goal-decomposer.js";
import type { GoalTree, GoalNodeId } from "./types.js";
import { generateGoalNodeId } from "./types.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { ProviderResponse } from "../agents/providers/provider-core.interface.js";

// =============================================================================
// MOCK HELPERS
// =============================================================================

function createMockProvider(responses: string[]): IAIProvider {
  let callIndex = 0;
  return {
    name: "mock",
    capabilities: { streaming: false, vision: false, functionCalling: true },
    chat: vi.fn(async (): Promise<ProviderResponse> => {
      const text = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10 },
        stopReason: "end",
      };
    }),
  };
}

/** Build a minimal GoalTree for reactive decomposition tests */
function buildTestTree(overrides?: {
  nodeOverrides?: Array<{
    id: GoalNodeId;
    parentId: GoalNodeId | null;
    task: string;
    depth: number;
    status: "pending" | "executing" | "completed" | "failed" | "skipped";
    dependsOn?: readonly GoalNodeId[];
  }>;
}): GoalTree {
  const rootId = "goal_root" as GoalNodeId;
  const now = Date.now();
  const nodes = new Map<GoalNodeId, import("./types.js").GoalNode>();

  if (overrides?.nodeOverrides) {
    for (const n of overrides.nodeOverrides) {
      nodes.set(n.id, {
        id: n.id,
        parentId: n.parentId,
        task: n.task,
        depth: n.depth,
        status: n.status,
        dependsOn: n.dependsOn ?? [],
        createdAt: now,
        updatedAt: now,
      });
    }
  } else {
    nodes.set(rootId, {
      id: rootId,
      parentId: null,
      task: "Build a complete auth system",
      depth: 0,
      status: "executing",
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    rootId,
    sessionId: "test-session",
    taskDescription: "Build a complete auth system",
    nodes,
    createdAt: now,
  };
}

// =============================================================================
// shouldDecompose Tests
// =============================================================================

describe("GoalDecomposer", () => {
  describe("shouldDecompose", () => {
    const decomposer = new GoalDecomposer(undefined, 3);

    it("returns false for short prompts (< 30 chars)", () => {
      expect(decomposer.shouldDecompose("fix the bug")).toBe(false);
    });

    it("returns false for simple patterns (e.g., 'build the project')", () => {
      expect(decomposer.shouldDecompose("build the project and deploy to staging")).toBe(false);
    });

    it("returns true for complex patterns (e.g., 'create a module with tests and documentation')", () => {
      expect(
        decomposer.shouldDecompose("create a module with tests and documentation"),
      ).toBe(true);
    });
  });

  // ===========================================================================
  // decomposeProactive Tests
  // ===========================================================================

  describe("decomposeProactive", () => {
    it("produces a GoalTree with DAG structure (not flat list) for complex tasks", async () => {
      const provider = createMockProvider([
        JSON.stringify({
          nodes: [
            { id: "s1", task: "Setup database schema", dependsOn: [] },
            { id: "s2", task: "Create auth middleware", dependsOn: ["s1"] },
            { id: "s3", task: "Create login endpoint", dependsOn: ["s2"] },
            { id: "s4", task: "Add rate limiting", dependsOn: ["s2"] },
          ],
        }),
      ]);

      const decomposer = new GoalDecomposer(provider, 3);
      const tree = await decomposer.decomposeProactive("test-session", "Build auth with login and rate limiting");

      expect(tree).toBeDefined();
      expect(tree.nodes.size).toBeGreaterThan(1);

      // Verify DAG structure: at least one node has dependsOn referencing another node
      const childNodes = Array.from(tree.nodes.values()).filter((n) => n.depth === 1);
      const hasDependency = childNodes.some((n) => n.dependsOn.length > 0);
      expect(hasDependency).toBe(true);
    });

    it("with simple result produces linear DAG (sequential deps)", async () => {
      const provider = createMockProvider([
        JSON.stringify({
          nodes: [
            { id: "s1", task: "Step 1", dependsOn: [] },
            { id: "s2", task: "Step 2", dependsOn: ["s1"] },
            { id: "s3", task: "Step 3", dependsOn: ["s2"] },
          ],
        }),
      ]);

      const decomposer = new GoalDecomposer(provider, 3);
      const tree = await decomposer.decomposeProactive("test-session", "Do steps in order");

      const childNodes = Array.from(tree.nodes.values()).filter((n) => n.depth === 1);
      // Each subsequent node depends on the previous one (linear chain)
      expect(childNodes.length).toBe(3);
      // The second and third should have dependsOn referencing real GoalNodeIds
      const withDeps = childNodes.filter((n) => n.dependsOn.length > 0);
      expect(withDeps.length).toBe(2);
    });

    it("respects maxDepth (no nodes beyond depth limit)", async () => {
      const provider = createMockProvider([
        JSON.stringify({
          nodes: [
            { id: "s1", task: "Step 1", dependsOn: [], needsFurtherDecomposition: true },
            { id: "s2", task: "Step 2", dependsOn: ["s1"] },
          ],
        }),
        // Recursive call for s1 at depth 2 (should NOT recurse further at maxDepth=2)
        JSON.stringify({
          nodes: [
            { id: "s1a", task: "Sub step 1a", dependsOn: [] },
            { id: "s1b", task: "Sub step 1b", dependsOn: ["s1a"] },
          ],
        }),
      ]);

      const decomposer = new GoalDecomposer(provider, 2);
      const tree = await decomposer.decomposeProactive("test-session", "Complex multi-step task with sub-goals");

      // With maxDepth=2, depth-1 nodes can have children at depth 2 but not deeper
      const maxNodeDepth = Math.max(...Array.from(tree.nodes.values()).map((n) => n.depth));
      expect(maxNodeDepth).toBeLessThanOrEqual(2);
    });

    it("retries once on invalid LLM output, falls back to a single executable child on second failure", async () => {
      const provider = createMockProvider([
        "invalid json garbage",
        "still invalid {{{",
      ]);

      const decomposer = new GoalDecomposer(provider, 3);
      const tree = await decomposer.decomposeProactive("test-session", "Some complex task with multiple steps");

      // Should fall back to root + one executable child
      expect(tree.nodes.size).toBe(2);
      const root = tree.nodes.get(tree.rootId);
      expect(root).toBeDefined();
      expect(root!.depth).toBe(0);
      const childNodes = Array.from(tree.nodes.values()).filter((node) => node.depth === 1);
      expect(childNodes).toHaveLength(1);
    });

    it("calls LLM recursively for depth-2 nodes flagged with needsFurtherDecomposition", async () => {
      const provider = createMockProvider([
        JSON.stringify({
          nodes: [
            { id: "s1", task: "Setup infrastructure", dependsOn: [], needsFurtherDecomposition: true },
            { id: "s2", task: "Write tests", dependsOn: ["s1"] },
          ],
        }),
        // Recursive call for s1 sub-decomposition
        JSON.stringify({
          nodes: [
            { id: "s1a", task: "Create database", dependsOn: [] },
            { id: "s1b", task: "Configure connection pool", dependsOn: ["s1a"] },
          ],
        }),
      ]);

      const decomposer = new GoalDecomposer(provider, 3);
      const tree = await decomposer.decomposeProactive("test-session", "Complex task requiring infrastructure setup and tests");

      // Should have root (depth 0), s1/s2 (depth 1), s1a/s1b (depth 2)
      expect(tree.nodes.size).toBe(5); // root + 2 depth-1 + 2 depth-2
      expect(provider.chat).toHaveBeenCalledTimes(2);

      // Verify depth-2 children exist
      const depth2Nodes = Array.from(tree.nodes.values()).filter((n) => n.depth === 2);
      expect(depth2Nodes.length).toBe(2);
    });
  });

  // ===========================================================================
  // decomposeReactive Tests
  // ===========================================================================

  describe("decomposeReactive", () => {
    it("returns updated tree with sub-goals for failing node", async () => {
      const provider = createMockProvider([
        JSON.stringify({
          nodes: [
            { id: "fix1", task: "Fix auth token generation", dependsOn: [] },
            { id: "fix2", task: "Retry with new token format", dependsOn: ["fix1"] },
          ],
        }),
      ]);

      const rootId = "goal_root" as GoalNodeId;
      const failingId = "goal_failing" as GoalNodeId;
      const tree = buildTestTree({
        nodeOverrides: [
          { id: rootId, parentId: null, task: "Build auth", depth: 0, status: "executing" },
          { id: failingId, parentId: rootId, task: "Implement token auth", depth: 1, status: "failed" },
        ],
      });

      const decomposer = new GoalDecomposer(provider, 3);
      const updated = await decomposer.decomposeReactive(tree, failingId, "Token generation failed due to invalid secret");

      expect(updated).not.toBeNull();
      expect(updated!.nodes.size).toBeGreaterThan(tree.nodes.size);

      // New children should have depth = failingNode.depth + 1 = 2
      const newNodes = Array.from(updated!.nodes.values()).filter((n) => n.depth === 2);
      expect(newNodes.length).toBe(2);
    });

    it("returns null when failing node is at maxDepth (cannot decompose further)", async () => {
      const provider = createMockProvider([]);
      const rootId = "goal_root" as GoalNodeId;
      const deepId = "goal_deep" as GoalNodeId;

      const tree = buildTestTree({
        nodeOverrides: [
          { id: rootId, parentId: null, task: "Root task", depth: 0, status: "executing" },
          { id: deepId, parentId: rootId, task: "Deep task", depth: 3, status: "failed" },
        ],
      });

      const decomposer = new GoalDecomposer(provider, 3);
      const result = await decomposer.decomposeReactive(tree, deepId, "Failed at max depth");

      expect(result).toBeNull();
      // LLM should not be called since depth guard prevents it
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("passes failure context to LLM prompt", async () => {
      const provider = createMockProvider([
        JSON.stringify({
          nodes: [{ id: "r1", task: "Retry step", dependsOn: [] }],
        }),
      ]);

      const rootId = "goal_root" as GoalNodeId;
      const failingId = "goal_fail" as GoalNodeId;
      const tree = buildTestTree({
        nodeOverrides: [
          { id: rootId, parentId: null, task: "Root", depth: 0, status: "executing" },
          { id: failingId, parentId: rootId, task: "Failing step", depth: 1, status: "failed" },
        ],
      });

      const decomposer = new GoalDecomposer(provider, 3);
      await decomposer.decomposeReactive(tree, failingId, "Database connection timeout");

      // Verify the LLM was called with the failure context
      const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
      const systemPrompt = chatCall[0] as string;
      const messages = chatCall[1] as Array<{ content: string }>;
      const combinedText = systemPrompt + " " + messages.map((m) => m.content).join(" ");
      expect(combinedText).toContain("Database connection timeout");
    });
  });

  // ===========================================================================
  // Fallback Tests
  // ===========================================================================

  describe("fallback behavior", () => {
    it("with no provider falls back to a single executable child node", async () => {
      const decomposer = new GoalDecomposer(undefined, 3);
      const tree = await decomposer.decomposeProactive("test-session", "Build a complex system");

      expect(tree.nodes.size).toBe(2);
      const root = tree.nodes.get(tree.rootId);
      expect(root).toBeDefined();
      expect(root!.task).toBe("Build a complex system");
      const childNodes = Array.from(tree.nodes.values()).filter((node) => node.depth === 1);
      expect(childNodes).toHaveLength(1);
      expect(childNodes[0]?.task).toBe("Build a complex system");
    });

    it("cycle in LLM output is detected and falls back to flat sequential list", async () => {
      const provider = createMockProvider([
        // First call: cyclic output
        JSON.stringify({
          nodes: [
            { id: "a", task: "Step A", dependsOn: ["b"] },
            { id: "b", task: "Step B", dependsOn: ["a"] },
          ],
        }),
        // Retry: still cyclic
        JSON.stringify({
          nodes: [
            { id: "x", task: "Step X", dependsOn: ["y"] },
            { id: "y", task: "Step Y", dependsOn: ["x"] },
          ],
        }),
      ]);

      const decomposer = new GoalDecomposer(provider, 3);
      const tree = await decomposer.decomposeProactive("test-session", "Complex task needing steps and validation");

      // Should fall back to a single executable child node since both attempts had cycles
      expect(tree.nodes.size).toBe(2);
      const childNodes = Array.from(tree.nodes.values()).filter((node) => node.depth === 1);
      expect(childNodes).toHaveLength(1);
    });
  });
});
