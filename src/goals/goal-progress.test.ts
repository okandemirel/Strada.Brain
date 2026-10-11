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
import { countDispatchableGoals } from "./tree-shape.js";
import { buildGoalNarrativeFeedback } from "./goal-feedback.js";

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

/**
 * root → A{A1, A2}, B — the shape the decomposer produces at the default goalMaxDepth (3).
 * The supervisor dispatches only A1, A2 and B; nothing ever marks A done (audit agent-core-goals#5).
 */
function scaffoldedTree(statuses: { a1: GoalNode["status"]; a2: GoalNode["status"]; b: GoalNode["status"] }) {
  const t = 1_000;
  const rootId = generateGoalNodeId();
  const a = generateGoalNodeId();
  const a1 = generateGoalNodeId();
  const a2 = generateGoalNodeId();
  const b = generateGoalNodeId();
  const tree = makeTree([
    makeNode({ id: rootId, task: "Root", createdAt: t }),
    makeNode({ id: a, parentId: rootId, depth: 1, task: "task A", createdAt: t + 1 }),
    makeNode({ id: a1, parentId: a, depth: 2, task: "task A1", status: statuses.a1, createdAt: t + 2 }),
    makeNode({ id: a2, parentId: a, depth: 2, task: "task A2", status: statuses.a2, dependsOn: [a1], createdAt: t + 3 }),
    makeNode({ id: b, parentId: rootId, depth: 1, task: "task B", status: statuses.b, dependsOn: [a], createdAt: t + 4 }),
  ], rootId);
  return tree;
}

describe("calculateProgress counts the work, not the scaffolding (agent-core-goals#5)", () => {
  it("a fully executed plan is 100%, as many steps as were dispatched", () => {
    const tree = scaffoldedTree({ a1: "completed", a2: "completed", b: "completed" });
    expect(calculateProgress(tree)).toEqual({ completed: 3, total: countDispatchableGoals(tree), percentage: 100 });
  });

  it("a partly executed plan counts only its leaves", () => {
    const tree = scaffoldedTree({ a1: "completed", a2: "pending", b: "pending" });
    expect(calculateProgress(tree)).toEqual({ completed: 1, total: 3, percentage: 33 });
  });

  it("the narrative closes out a finished plan instead of focusing on the never-dispatched parent", () => {
    const feedback = buildGoalNarrativeFeedback(
      scaffoldedTree({ a1: "completed", a2: "completed", b: "completed" }),
      "Build the game",
    );
    expect(feedback.narrative).toContain("Stage: closeout");
    expect(feedback.narrative).toContain("3/3");
    expect(feedback.narrative).not.toContain('"task A"');
  });

  it("the focus is the next leaf, and a step that waits on a scaffolding parent is ready once its leaves are done", () => {
    const midway = buildGoalNarrativeFeedback(scaffoldedTree({ a1: "completed", a2: "pending", b: "pending" }), "Build the game");
    expect(midway.focusTasks[0]).toBe("task A2");
    expect(midway.focusTasks).not.toContain("task A");

    const aDone = buildGoalNarrativeFeedback(scaffoldedTree({ a1: "completed", a2: "completed", b: "pending" }), "Build the game");
    expect(aDone.focusTasks).toEqual(["task B"]);
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
