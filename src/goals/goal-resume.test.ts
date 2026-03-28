/**
 * Goal Resume Tests
 *
 * Tests for interrupted tree detection and smart resume preparation:
 * - detectInterruptedTrees delegates to GoalStorage
 * - prepareTreeForResume resets executing nodes to pending
 * - prepareTreeForResume preserves completed/failed/pending nodes
 * - isTreeStale detects old trees (>24h)
 * - formatResumePrompt renders user-facing resume message
 */

import { describe, it, expect, vi } from "vitest";
import {
  detectInterruptedTrees,
  prepareTreeForResume,
  prepareTreeForRetry,
  isTreeStale,
  formatResumePrompt,
} from "./goal-resume.js";
import type { GoalNode, GoalTree, GoalNodeId } from "./types.js";
import { generateGoalNodeId } from "./types.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeNode(
  overrides: Partial<GoalNode> & { id: GoalNodeId },
): GoalNode {
  const now = Date.now();
  return {
    parentId: null,
    task: "test task",
    dependsOn: [],
    depth: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTree(
  nodeList: GoalNode[],
  rootId: GoalNodeId,
  taskDescription = "Test tree",
): GoalTree {
  const nodes = new Map<GoalNodeId, GoalNode>();
  for (const n of nodeList) {
    nodes.set(n.id, n);
  }
  return {
    rootId,
    sessionId: "test-session",
    taskDescription,
    nodes,
    createdAt: Date.now(),
  };
}

// =============================================================================
// detectInterruptedTrees
// =============================================================================

describe("detectInterruptedTrees", () => {
  it("delegates to goalStorage.getInterruptedTrees", () => {
    const rootId = generateGoalNodeId();
    const root = makeNode({ id: rootId, task: "Root", status: "executing" });
    const tree = makeTree([root], rootId);

    const mockStorage = {
      getInterruptedTrees: vi.fn().mockReturnValue([tree]),
    } as any;

    const result = detectInterruptedTrees(mockStorage);

    expect(mockStorage.getInterruptedTrees).toHaveBeenCalled();
    expect(result).toEqual([tree]);
  });
});

// =============================================================================
// prepareTreeForResume
// =============================================================================

describe("prepareTreeForResume", () => {
  it("resets executing nodes to pending", () => {
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "executing" });
    const a = makeNode({
      id: aId,
      parentId: rootId,
      depth: 1,
      task: "A",
      status: "executing",
      startedAt: 1000,
      completedAt: undefined,
    });
    const tree = makeTree([root, a], rootId);

    const resumed = prepareTreeForResume(tree);

    expect(resumed.nodes.get(aId)?.status).toBe("pending");
    expect(resumed.nodes.get(rootId)?.status).toBe("pending");
  });

  it("preserves completed nodes unchanged", () => {
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "executing" });
    const a = makeNode({
      id: aId,
      parentId: rootId,
      depth: 1,
      task: "A",
      status: "completed",
      result: "Done",
    });
    const tree = makeTree([root, a], rootId);

    const resumed = prepareTreeForResume(tree);

    const node = resumed.nodes.get(aId)!;
    expect(node.status).toBe("completed");
    expect(node.result).toBe("Done");
  });

  it("preserves failed nodes unchanged", () => {
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "executing" });
    const a = makeNode({
      id: aId,
      parentId: rootId,
      depth: 1,
      task: "A",
      status: "failed",
      error: "Something went wrong",
    });
    const tree = makeTree([root, a], rootId);

    const resumed = prepareTreeForResume(tree);

    const node = resumed.nodes.get(aId)!;
    expect(node.status).toBe("failed");
    expect(node.error).toBe("Something went wrong");
  });

  it("preserves pending nodes unchanged", () => {
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "executing" });
    const a = makeNode({
      id: aId,
      parentId: rootId,
      depth: 1,
      task: "A",
      status: "pending",
    });
    const tree = makeTree([root, a], rootId);

    const resumed = prepareTreeForResume(tree);
    expect(resumed.nodes.get(aId)?.status).toBe("pending");
  });

  it("clears startedAt and completedAt on reset nodes", () => {
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "executing" });
    const a = makeNode({
      id: aId,
      parentId: rootId,
      depth: 1,
      task: "A",
      status: "executing",
      startedAt: 12345,
      completedAt: 67890,
    });
    const tree = makeTree([root, a], rootId);

    const resumed = prepareTreeForResume(tree);

    const node = resumed.nodes.get(aId)!;
    expect(node.startedAt).toBeUndefined();
    expect(node.completedAt).toBeUndefined();
  });
});

describe("prepareTreeForRetry", () => {
  it("resets a failed node and its dependency descendants to pending", () => {
    const rootId = generateGoalNodeId();
    const failedId = generateGoalNodeId();
    const dependentId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "pending" });
    const failed = makeNode({
      id: failedId,
      parentId: rootId,
      depth: 1,
      task: "Fix bug",
      status: "failed",
      error: "boom",
      reviewStatus: "review_stuck",
    });
    const dependent = makeNode({
      id: dependentId,
      parentId: rootId,
      depth: 1,
      task: "Verify",
      dependsOn: [failedId],
      status: "skipped",
    });

    const retried = prepareTreeForRetry(makeTree([root, failed, dependent], rootId), failedId);

    expect(retried.nodes.get(failedId)?.status).toBe("pending");
    expect(retried.nodes.get(failedId)?.error).toBeUndefined();
    expect(retried.nodes.get(failedId)?.reviewStatus).toBe("none");
    expect(retried.nodes.get(dependentId)?.status).toBe("pending");
  });

  it("preserves completed nodes when retrying the full tree", () => {
    const rootId = generateGoalNodeId();
    const completedId = generateGoalNodeId();
    const failedId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Root", status: "pending" });
    const completed = makeNode({
      id: completedId,
      parentId: rootId,
      depth: 1,
      task: "Already done",
      status: "completed",
      result: "kept",
    });
    const failed = makeNode({
      id: failedId,
      parentId: rootId,
      depth: 1,
      task: "Need retry",
      status: "failed",
      error: "boom",
    });

    const retried = prepareTreeForRetry(makeTree([root, completed, failed], rootId));

    expect(retried.nodes.get(completedId)?.status).toBe("completed");
    expect(retried.nodes.get(completedId)?.result).toBe("kept");
    expect(retried.nodes.get(failedId)?.status).toBe("pending");
  });
});

// =============================================================================
// isTreeStale
// =============================================================================

describe("isTreeStale", () => {
  it("returns true for trees with latest update > 24 hours ago", () => {
    const rootId = generateGoalNodeId();
    const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    const root = makeNode({
      id: rootId,
      task: "Root",
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    const tree = makeTree([root], rootId);
    // Override createdAt since makeTree uses Date.now()
    const staleTree = { ...tree, createdAt: oldTime };

    expect(isTreeStale(staleTree)).toBe(true);
  });

  it("returns false for recent trees", () => {
    const rootId = generateGoalNodeId();
    const recentTime = Date.now() - 1000; // 1 second ago
    const root = makeNode({
      id: rootId,
      task: "Root",
      createdAt: recentTime,
      updatedAt: recentTime,
    });
    const tree = makeTree([root], rootId);

    expect(isTreeStale(tree)).toBe(false);
  });
});

// =============================================================================
// formatResumePrompt
// =============================================================================

describe("formatResumePrompt", () => {
  it("renders tree with progress bar and Resume/Discard options for single tree", () => {
    const rootId = generateGoalNodeId();
    const aId = generateGoalNodeId();
    const bId = generateGoalNodeId();

    const root = makeNode({ id: rootId, task: "Build app", status: "executing" });
    const a = makeNode({
      id: aId,
      parentId: rootId,
      depth: 1,
      task: "Setup DB",
      status: "completed",
    });
    const b = makeNode({
      id: bId,
      parentId: rootId,
      depth: 1,
      task: "Write API",
      status: "executing",
    });
    const tree = makeTree([root, a, b], rootId, "Build app");

    const prompt = formatResumePrompt([tree]);

    expect(prompt).toContain("Found 1 interrupted goal tree:");
    expect(prompt).toContain("Build app");
    expect(prompt).toContain("Resume");
    expect(prompt).toContain("Discard");
  });

  it("shows staleness warning for old trees", () => {
    const rootId = generateGoalNodeId();
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    const root = makeNode({
      id: rootId,
      task: "Old task",
      status: "executing",
      createdAt: oldTime,
      updatedAt: oldTime,
    });
    const tree = { ...makeTree([root], rootId, "Old task"), createdAt: oldTime };

    const prompt = formatResumePrompt([tree]);

    expect(prompt).toContain("over 24 hours old");
    expect(prompt).toContain("discard");
  });

  it("handles multiple trees with numbered options", () => {
    const trees: GoalTree[] = [];
    for (let i = 0; i < 2; i++) {
      const rootId = generateGoalNodeId();
      const root = makeNode({
        id: rootId,
        task: `Task ${i + 1}`,
        status: "executing",
      });
      trees.push(makeTree([root], rootId, `Task ${i + 1}`));
    }

    const prompt = formatResumePrompt(trees);

    expect(prompt).toContain("Found 2 interrupted goal trees:");
    expect(prompt).toContain("Resume all");
    expect(prompt).toContain("Resume #N");
    expect(prompt).toContain("Discard all");
  });

  it("returns empty string for no trees", () => {
    expect(formatResumePrompt([])).toBe("");
  });
});
