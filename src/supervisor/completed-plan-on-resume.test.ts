import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { completedPlanOnResume, dependentClosure } from "./supervisor-brain.js";
import type { GoalNode, GoalNodeId, GoalTree } from "../goals/types.js";

function node(id: string, parentId: string | null, status: GoalNode["status"], task = `task ${id}`): GoalNode {
  return {
    id: id as GoalNodeId, parentId: parentId as GoalNodeId | null, task, dependsOn: [], depth: parentId ? 1 : 0,
    status, result: status === "completed" ? `done ${id}` : undefined, createdAt: 1, updatedAt: 5, startedAt: 2, completedAt: 5,
  };
}
function tree(nodes: GoalNode[]): GoalTree {
  return { rootId: "root" as GoalNodeId, sessionId: "s", taskDescription: "mission", nodes: new Map(nodes.map((n) => [n.id, n])), createdAt: 1 };
}

describe("a resumed task whose saved plan is already complete (2026-09-10 21:20)", () => {
  it("is DONE, with one ok result per completed leaf — not 'No sub-tasks after decomposition'", () => {
    const t = tree([node("root", null, "pending"), node("a", "root", "completed"), node("b", "root", "completed"), node("c", "root", "completed")]);
    const r = completedPlanOnResume(t);
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    expect(r!.partial).toBe(false);
    expect(r!.totalNodes).toBe(3);
    expect(r!.nodeResults.map((n) => n.output)).toEqual(["done a", "done b", "done c"]);
    expect(r!.output).toMatch(/All 3 planned steps were already completed/);
  });

  it("stays null when any leaf is still pending or failed, when no tree was saved, or when the tree has no leaves", () => {
    expect(completedPlanOnResume(undefined)).toBeNull();
    expect(completedPlanOnResume(tree([node("root", null, "pending")]))).toBeNull();
    expect(completedPlanOnResume(tree([node("root", null, "pending"), node("a", "root", "completed"), node("b", "root", "pending")]))).toBeNull();
    expect(completedPlanOnResume(tree([node("root", null, "pending"), node("a", "root", "completed"), node("b", "root", "failed")]))).toBeNull();
  });

  it("scaffolding parents do not count as leaves", () => {
    const t = tree([node("root", null, "pending"), node("p", "root", "pending"), node("a", "p", "completed"), node("b", "p", "completed")]);
    expect(completedPlanOnResume(t)?.totalNodes).toBe(2);
  });

  it("the supervisor re-verifies the saved results before counting the resume done (Codex 2026-09-11 #1)", () => {
    const source = readFileSync("src/supervisor/supervisor-brain.ts", "utf8");
    const at = source.indexOf("const alreadyDone = completedPlanOnResume(context.goalTree);");
    const branch = source.slice(at, source.indexOf('"No sub-tasks after decomposition"', at));
    expect(branch).toContain("verifier.verifyWithReport(alreadyDone.nodeResults)");
    expect(branch).toContain('mode: "always"');
    expect(branch).toContain("synthesized.success");
    // Nobody-looked is not approval, the wait is kept alive, and an abort
    // during it is honoured (Codex 2026-09-11 C#4, C#7).
    expect(branch).toContain("const unapproved = report.candidates - report.approved;");
    expect(branch).toContain("if (unapproved > 0) {");
    expect(branch).toContain("success: false");
    // A rejected step is written back as failed so a retry RE-RUNS it (C#5).
    expect(branch).toContain("for (const id of dependentClosure(context.goalTree, rejected))");
    expect(branch).toContain('"failed"');
    expect(branch).toContain("withLivenessHeartbeat");
    expect(branch).toContain("Aborted during resume re-verification");
    // A verifier that never settles cannot hold the resume open (D#7).
    expect(branch).toContain('if (verifiedOrTimeout === "timeout") {');
    expect(branch).toContain("could not be re-verified within");
  });

  it("a rejected step takes its DEPENDENTS with it (Codex 2026-09-11 D#5)", () => {
    const t = tree([
      node("root", null, "pending"),
      { ...node("a", "root", "completed") },
      { ...node("b", "root", "completed"), dependsOn: ["a" as GoalNodeId] },
      { ...node("c", "root", "completed"), dependsOn: ["b" as GoalNodeId] },
      { ...node("d", "root", "completed") },
    ]);
    expect(dependentClosure(t, new Set(["a"])).sort()).toEqual(["a", "b", "c"]);
    expect(dependentClosure(t, new Set(["d"]))).toEqual(["d"]);
    expect(dependentClosure(undefined, new Set(["a"]))).toEqual(["a"]);
  });

  it("the rejection write preserves what the node already recorded (Codex 2026-09-11 D#18)", () => {
    const source = readFileSync("src/supervisor/supervisor-brain.ts", "utf8");
    const at = source.indexOf("for (const id of dependentClosure(");
    const block = source.slice(at, at + 900);
    expect(block).toContain("node?.result");
    expect(block).toContain("node?.retryCount");
    expect(block).toContain("node?.reviewStatus");
  });

  it("the supervisor asks it before declaring 'No sub-tasks after decomposition'", () => {
    const source = readFileSync("src/supervisor/supervisor-brain.ts", "utf8");
    const at = source.indexOf('"No sub-tasks after decomposition"');
    expect(source.lastIndexOf("completedPlanOnResume(context.goalTree)", at)).toBeGreaterThan(at - 8000);
  });
});
