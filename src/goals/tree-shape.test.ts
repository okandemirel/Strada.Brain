/**
 * The decomposer already answers "does this need splitting". These tests pin
 * what it means to read that answer.
 */

import { describe, it, expect } from "vitest";
import { countDispatchableGoals, warrantsSupervisor } from "./tree-shape.js";
import type { GoalTree, GoalNode } from "./types.js";

function tree(nodes: Array<{ id: string; parentId: string | null }>): GoalTree {
  const map = new Map<string, GoalNode>();
  for (const n of nodes) {
    map.set(n.id, {
      id: n.id,
      parentId: n.parentId,
      task: n.id,
      dependsOn: [],
      depth: n.parentId === null ? 0 : 1,
      status: "pending",
      createdAt: 0,
      updatedAt: 0,
    } as GoalNode);
  }
  return {
    rootId: nodes[0]?.id ?? "root",
    sessionId: "s",
    taskDescription: "t",
    nodes: map,
    createdAt: 0,
  };
}

describe("counting the work a tree would dispatch", () => {
  it("counts a lone node as one goal", () => {
    expect(countDispatchableGoals(tree([{ id: "root", parentId: null }]))).toBe(1);
  });

  it("counts the leaves, not the scaffolding", () => {
    // A root that only groups its children is not a unit of work.
    const t = tree([
      { id: "root", parentId: null },
      { id: "a", parentId: "root" },
      { id: "b", parentId: "root" },
    ]);
    expect(countDispatchableGoals(t)).toBe(2);
  });

  it("counts leaves at any depth", () => {
    const t = tree([
      { id: "root", parentId: null },
      { id: "a", parentId: "root" },
      { id: "a1", parentId: "a" },
      { id: "a2", parentId: "a" },
      { id: "b", parentId: "root" },
    ]);
    expect(countDispatchableGoals(t)).toBe(3);
  });
});

describe("whether the supervisor is warranted", () => {
  it("is not, with no tree at all", () => {
    expect(warrantsSupervisor(undefined)).toBe(false);
  });

  it("is not, for a tree the decomposer declined to split", () => {
    // This is the case that used to force the whole apparatus: triage, a node
    // runner and a verification call, to run one agent loop.
    expect(warrantsSupervisor(tree([{ id: "root", parentId: null }]))).toBe(false);
  });

  it("is not, for a root with a single child", () => {
    // One goal wearing two nodes is still one goal.
    const t = tree([
      { id: "root", parentId: null },
      { id: "only", parentId: "root" },
    ]);
    expect(warrantsSupervisor(t)).toBe(false);
  });

  it("is, as soon as there are two pieces of work to coordinate", () => {
    const t = tree([
      { id: "root", parentId: null },
      { id: "a", parentId: "root" },
      { id: "b", parentId: "root" },
    ]);
    expect(warrantsSupervisor(t)).toBe(true);
  });
});
