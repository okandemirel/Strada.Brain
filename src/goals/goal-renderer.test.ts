/**
 * GoalRenderer Tests
 *
 * Tests for:
 * - renderGoalTree: ASCII tree with status icons, hierarchy, indentation
 * - summarizeTree: status count summary string
 * - Truncation for large trees
 * - Single-node and deep tree rendering
 * - Progress bar header for trees with sub-goals
 * - Duration display for completed nodes with timing
 * - Braille spinner for executing nodes
 * - Parallelizable node annotations
 */

import { describe, it, expect } from "vitest";
import { renderGoalTree, summarizeTree } from "./goal-renderer.js";
import type { GoalTree, GoalNode, GoalNodeId, GoalStatus } from "./types.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

function makeNode(
  id: string,
  task: string,
  opts: {
    parentId?: string | null;
    depth?: number;
    status?: GoalStatus;
    dependsOn?: string[];
    startedAt?: number;
    completedAt?: number;
    retryCount?: number;
  } = {},
): GoalNode {
  return {
    id: id as GoalNodeId,
    parentId: (opts.parentId ?? null) as GoalNodeId | null,
    task,
    depth: opts.depth ?? 0,
    status: opts.status ?? "pending",
    dependsOn: (opts.dependsOn ?? []) as GoalNodeId[],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: opts.startedAt,
    completedAt: opts.completedAt,
    retryCount: opts.retryCount,
  };
}

function makeTree(
  rootId: string,
  nodeList: GoalNode[],
): GoalTree {
  const nodes = new Map<GoalNodeId, GoalNode>();
  for (const n of nodeList) {
    nodes.set(n.id, n);
  }
  return {
    rootId: rootId as GoalNodeId,
    sessionId: "test-session",
    taskDescription: nodeList.find((n) => n.id === rootId)?.task ?? "Test task",
    nodes,
    createdAt: Date.now(),
  };
}

// =============================================================================
// renderGoalTree Tests
// =============================================================================

describe("renderGoalTree", () => {
  it("produces ASCII tree with status icons for a simple tree", () => {
    const tree = makeTree("root", [
      makeNode("root", "Build auth system", { depth: 0, status: "executing" }),
      makeNode("s1", "Setup database", { parentId: "root", depth: 1, status: "completed" }),
      makeNode("s2", "Create middleware", { parentId: "root", depth: 1, status: "pending" }),
    ]);

    const result = renderGoalTree(tree);
    expect(result).toContain("[~] Build auth system");
    expect(result).toContain("[x] Setup database");
    expect(result).toContain("[ ] Create middleware");
  });

  it("status icons are correct for all statuses", () => {
    const tree = makeTree("root", [
      makeNode("root", "Root", { depth: 0, status: "pending" }),
      makeNode("s1", "Pending task", { parentId: "root", depth: 1, status: "pending" }),
      makeNode("s2", "Executing task", { parentId: "root", depth: 1, status: "executing" }),
      makeNode("s3", "Completed task", { parentId: "root", depth: 1, status: "completed" }),
      makeNode("s4", "Failed task", { parentId: "root", depth: 1, status: "failed" }),
      makeNode("s5", "Skipped task", { parentId: "root", depth: 1, status: "skipped" }),
    ]);

    const result = renderGoalTree(tree);
    expect(result).toContain("[ ] Pending task");
    expect(result).toContain("[~] Executing task");
    expect(result).toContain("[x] Completed task");
    expect(result).toContain("[!] Failed task");
    expect(result).toContain("[-] Skipped task");
  });

  it("tree rendering shows hierarchy with indentation (box-drawing chars)", () => {
    const tree = makeTree("root", [
      makeNode("root", "Root task", { depth: 0, status: "executing" }),
      makeNode("s1", "First child", { parentId: "root", depth: 1, status: "completed" }),
      makeNode("s2", "Second child", { parentId: "root", depth: 1, status: "pending" }),
    ]);

    const result = renderGoalTree(tree);
    // Should use box-drawing characters for hierarchy
    expect(result).toContain("+--");
    expect(result).toContain("\\--");
  });

  it("large trees (> 3000 chars rendered) are truncated with summary", () => {
    // Build a tree with many nodes to exceed 3000 chars
    const nodes: GoalNode[] = [
      makeNode("root", "Large root task with a long description to help fill up chars", { depth: 0, status: "executing" }),
    ];

    for (let i = 0; i < 60; i++) {
      nodes.push(
        makeNode(
          `s${i}`,
          `Sub-goal number ${i}: perform an extensive operation with lots of descriptive text padding`,
          { parentId: "root", depth: 1, status: "pending" },
        ),
      );
    }

    const tree = makeTree("root", nodes);
    const result = renderGoalTree(tree);

    expect(result.length).toBeLessThanOrEqual(3200); // some buffer for truncation message
    expect(result).toContain("/api/goals");
  });

  it("single-node tree (root only) renders without children or progress bar", () => {
    const tree = makeTree("root", [
      makeNode("root", "Simple task", { depth: 0, status: "pending" }),
    ]);

    const result = renderGoalTree(tree);
    expect(result).toContain("[ ] Simple task");
    // Should not contain child indicators
    expect(result).not.toContain("+--");
    expect(result).not.toContain("\\--");
    // Should not contain progress bar (no sub-goals)
    expect(result).not.toContain("[#");
    expect(result).not.toContain("[.");
  });

  it("deep tree (3 levels) renders with proper nesting", () => {
    const tree = makeTree("root", [
      makeNode("root", "Root task", { depth: 0, status: "executing" }),
      makeNode("s1", "Level 1 child", { parentId: "root", depth: 1, status: "executing" }),
      makeNode("s1a", "Level 2 grandchild A", { parentId: "s1", depth: 2, status: "completed" }),
      makeNode("s1b", "Level 2 grandchild B", { parentId: "s1", depth: 2, status: "pending" }),
      makeNode("s2", "Level 1 sibling", { parentId: "root", depth: 1, status: "pending" }),
    ]);

    const result = renderGoalTree(tree);

    // All nodes should be present
    expect(result).toContain("Root task");
    expect(result).toContain("Level 1 child");
    expect(result).toContain("Level 2 grandchild A");
    expect(result).toContain("Level 2 grandchild B");
    expect(result).toContain("Level 1 sibling");

    // Deeper nesting should use more indentation
    const lines = result.split("\n");
    const grandchildLine = lines.find((l) => l.includes("Level 2 grandchild A"));
    const childLine = lines.find((l) => l.includes("Level 1 child") && !l.includes("Level 2"));
    expect(grandchildLine).toBeDefined();
    expect(childLine).toBeDefined();
    // Grandchild line should be longer (more indentation prefix) than child line
    const grandchildPrefix = grandchildLine!.indexOf("[");
    const childPrefix = childLine!.indexOf("[");
    expect(grandchildPrefix).toBeGreaterThan(childPrefix);
  });

  // ==========================================================================
  // NEW: Progress bar header tests
  // ==========================================================================

  it("includes progress bar for trees with sub-goals", () => {
    const tree = makeTree("root", [
      makeNode("root", "Build system", { depth: 0, status: "executing" }),
      makeNode("s1", "Step one", { parentId: "root", depth: 1, status: "completed" }),
      makeNode("s2", "Step two", { parentId: "root", depth: 1, status: "pending" }),
      makeNode("s3", "Step three", { parentId: "root", depth: 1, status: "pending" }),
    ]);

    const result = renderGoalTree(tree);
    // Should contain progress bar: 1/3 completed
    expect(result).toContain("1/3");
    expect(result).toContain("33%");
  });

  it("excludes progress bar for root-only trees", () => {
    const tree = makeTree("root", [
      makeNode("root", "Solo task", { depth: 0, status: "pending" }),
    ]);

    const result = renderGoalTree(tree);
    // No progress bar for root-only
    expect(result).not.toMatch(/\d+\/\d+ \(\d+%\)/);
  });

  // ==========================================================================
  // NEW: Duration display tests
  // ==========================================================================

  it("shows duration for completed nodes with timing", () => {
    const now = Date.now();
    const tree = makeTree("root", [
      makeNode("root", "Main task", { depth: 0, status: "executing" }),
      makeNode("s1", "Fast step", {
        parentId: "root",
        depth: 1,
        status: "completed",
        startedAt: now - 500,
        completedAt: now,
      }),
      makeNode("s2", "Slow step", {
        parentId: "root",
        depth: 1,
        status: "completed",
        startedAt: now - 2300,
        completedAt: now,
      }),
    ]);

    const result = renderGoalTree(tree);
    // 500ms should display as "500ms"
    expect(result).toContain("(500ms)");
    // 2300ms should display as "2.3s"
    expect(result).toContain("(2.3s)");
  });

  // ==========================================================================
  // NEW: Braille spinner tests
  // ==========================================================================

  it("shows braille spinner for executing nodes", () => {
    const tree = makeTree("root", [
      makeNode("root", "Main task", { depth: 0, status: "executing" }),
      makeNode("s1", "Running step", { parentId: "root", depth: 1, status: "executing" }),
    ]);

    const result = renderGoalTree(tree);
    // Should contain one of the braille spinner characters after the executing node
    const braillePattern = /\[~\] Running step [\u2800-\u28FF]/;
    expect(result).toMatch(braillePattern);
  });

  // ==========================================================================
  // NEW: Parallelizable annotation tests
  // ==========================================================================

  it("with annotateParallelizable=true marks parallelizable pending nodes", () => {
    const tree = makeTree("root", [
      makeNode("root", "Main task", { depth: 0, status: "executing" }),
      makeNode("s1", "Independent A", { parentId: "root", depth: 1, status: "pending", dependsOn: ["root"] }),
      makeNode("s2", "Independent B", { parentId: "root", depth: 1, status: "pending", dependsOn: ["root"] }),
      makeNode("s3", "Depends on A", { parentId: "root", depth: 1, status: "pending", dependsOn: ["s1"] }),
    ]);

    const result = renderGoalTree(tree, { annotateParallelizable: true });
    // s1 and s2 are both ready (depend only on root which is always in completedIds)
    expect(result).toContain("Independent A (parallelizable)");
    expect(result).toContain("Independent B (parallelizable)");
    // s3 depends on s1 (not completed), so not parallelizable
    expect(result).not.toContain("Depends on A (parallelizable)");
  });

  it("with annotateParallelizable=false (or omitted) does not annotate", () => {
    const tree = makeTree("root", [
      makeNode("root", "Main task", { depth: 0, status: "executing" }),
      makeNode("s1", "Independent A", { parentId: "root", depth: 1, status: "pending", dependsOn: ["root"] }),
      makeNode("s2", "Independent B", { parentId: "root", depth: 1, status: "pending", dependsOn: ["root"] }),
    ]);

    // Without options
    const result1 = renderGoalTree(tree);
    expect(result1).not.toContain("(parallelizable)");

    // With annotateParallelizable=false
    const result2 = renderGoalTree(tree, { annotateParallelizable: false });
    expect(result2).not.toContain("(parallelizable)");
  });
});

// =============================================================================
// summarizeTree Tests
// =============================================================================

describe("summarizeTree", () => {
  it("returns correct summary format with multiple statuses", () => {
    const tree = makeTree("root", [
      makeNode("root", "Root", { depth: 0, status: "executing" }),
      makeNode("s1", "Done", { parentId: "root", depth: 1, status: "completed" }),
      makeNode("s2", "Running", { parentId: "root", depth: 1, status: "executing" }),
      makeNode("s3", "Waiting", { parentId: "root", depth: 1, status: "pending" }),
      makeNode("s4", "Broken", { parentId: "root", depth: 1, status: "failed" }),
    ]);

    const summary = summarizeTree(tree);
    expect(summary).toContain("4 sub-goals");
    expect(summary).toContain("1 complete");
    expect(summary).toContain("1 running");
    expect(summary).toContain("1 pending");
    expect(summary).toContain("1 failed");
  });

  it("omits zero-count statuses from the summary string", () => {
    const tree = makeTree("root", [
      makeNode("root", "Root", { depth: 0, status: "executing" }),
      makeNode("s1", "Done", { parentId: "root", depth: 1, status: "completed" }),
      makeNode("s2", "Also done", { parentId: "root", depth: 1, status: "completed" }),
    ]);

    const summary = summarizeTree(tree);
    expect(summary).toContain("2 sub-goals");
    expect(summary).toContain("2 complete");
    expect(summary).not.toContain("running");
    expect(summary).not.toContain("pending");
    expect(summary).not.toContain("failed");
  });
});
