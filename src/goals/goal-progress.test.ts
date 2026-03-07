/**
 * Goal Progress Tests
 *
 * Tests for calculateProgress and renderProgressBar:
 * - calculateProgress counts non-root nodes
 * - calculateProgress excludes root node
 * - calculateProgress handles root-only tree
 * - renderProgressBar renders [######....] 3/5 (60%) format
 * - renderProgressBar handles edge cases (0/0, 5/5, 0/5)
 */

import { describe, it, expect } from "vitest";
import { calculateProgress, renderProgressBar } from "./goal-progress.js";
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

function makeTree(nodeList: GoalNode[], rootId: GoalNodeId): GoalTree {
  const nodes = new Map<GoalNodeId, GoalNode>();
  for (const n of nodeList) {
    nodes.set(n.id, n);
  }
  return {
    rootId,
    sessionId: "test-session",
    taskDescription: "Test tree",
    nodes,
    createdAt: Date.now(),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("calculateProgress", () => {
  it("returns correct counts for tree with 3/5 non-root nodes completed", () => {
    const rootId = generateGoalNodeId();
    const children = Array.from({ length: 5 }, (_, i) => {
      const id = generateGoalNodeId();
      return makeNode({
        id,
        parentId: rootId,
        depth: 1,
        task: `Child ${i}`,
        status: i < 3 ? "completed" : "pending",
      });
    });
    const root = makeNode({ id: rootId, task: "Root", status: "executing" });
    const tree = makeTree([root, ...children], rootId);

    const progress = calculateProgress(tree);
    expect(progress.completed).toBe(3);
    expect(progress.total).toBe(5);
    expect(progress.percentage).toBe(60);
  });

  it("returns { completed: 0, total: 0, percentage: 0 } for root-only tree", () => {
    const rootId = generateGoalNodeId();
    const root = makeNode({ id: rootId, task: "Root only" });
    const tree = makeTree([root], rootId);

    const progress = calculateProgress(tree);
    expect(progress.completed).toBe(0);
    expect(progress.total).toBe(0);
    expect(progress.percentage).toBe(0);
  });

  it("excludes root node even when it is completed", () => {
    const rootId = generateGoalNodeId();
    const childId = generateGoalNodeId();
    const root = makeNode({ id: rootId, task: "Root", status: "completed" });
    const child = makeNode({
      id: childId,
      parentId: rootId,
      depth: 1,
      task: "Child",
      status: "pending",
    });
    const tree = makeTree([root, child], rootId);

    const progress = calculateProgress(tree);
    expect(progress.completed).toBe(0);
    expect(progress.total).toBe(1);
    expect(progress.percentage).toBe(0);
  });

  it("counts only completed status (not executing, failed, etc.)", () => {
    const rootId = generateGoalNodeId();
    const statuses = [
      "completed",
      "executing",
      "failed",
      "skipped",
      "pending",
    ] as const;
    const children = statuses.map((status) => {
      const id = generateGoalNodeId();
      return makeNode({
        id,
        parentId: rootId,
        depth: 1,
        task: `Child ${status}`,
        status,
      });
    });
    const root = makeNode({ id: rootId, task: "Root" });
    const tree = makeTree([root, ...children], rootId);

    const progress = calculateProgress(tree);
    expect(progress.completed).toBe(1); // Only the "completed" one
    expect(progress.total).toBe(5);
    expect(progress.percentage).toBe(20);
  });
});

describe("renderProgressBar", () => {
  it('renders "[######....] 3/5 (60%)" for 3 of 5', () => {
    expect(renderProgressBar(3, 5)).toBe("[######....] 3/5 (60%)");
  });

  it('renders "[..........] 0/0 (0%)" for 0 of 0', () => {
    expect(renderProgressBar(0, 0)).toBe("[..........] 0/0 (0%)");
  });

  it('renders "[##########] 5/5 (100%)" for 5 of 5', () => {
    expect(renderProgressBar(5, 5)).toBe("[##########] 5/5 (100%)");
  });

  it('renders "[..........] 0/5 (0%)" for 0 of 5', () => {
    expect(renderProgressBar(0, 5)).toBe("[..........] 0/5 (0%)");
  });
});
