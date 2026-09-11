import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { completedPlanOnResume, dependentClosure, effectiveLeafDependencies, stopAfterDeadline } from "./supervisor-brain.js";
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

    // …transitively, whatever ORDER the nodes were inserted in: a chain
    // written back-to-front used to need one pass per link and a single pass
    // reached the whole chain by luck (Codex 2026-09-11 E#16).
    const reversed = tree([
      node("root", null, "pending"),
      { ...node("z", "root", "completed"), dependsOn: ["y" as GoalNodeId] },
      { ...node("y", "root", "completed"), dependsOn: ["x" as GoalNodeId] },
      { ...node("x", "root", "completed") },
    ]);
    expect(dependentClosure(reversed, new Set(["x"])).sort()).toEqual(["x", "y", "z"]);

    // A step that waited on a scaffolding PARENT waited on its whole subtree
    // (Codex 2026-09-11 E#3): rejecting the child invalidates that consumer.
    const throughParent = tree([
      node("root", null, "pending"),
      node("p", "root", "pending"),
      { ...node("a", "p", "completed") },
      { ...node("b", "root", "completed"), dependsOn: ["p" as GoalNodeId] },
      { ...node("c", "root", "completed"), dependsOn: ["b" as GoalNodeId] },
      { ...node("e", "root", "completed") },
    ]);
    expect(dependentClosure(throughParent, new Set(["a"])).sort()).toEqual(["a", "b", "c"]);
    // The parent itself is not invalidated — it has no work of its own.
    expect(dependentClosure(throughParent, new Set(["a"]))).not.toContain("p");

    // A PARENT's own prerequisite is inherited by its children, so rejecting
    // that prerequisite invalidates the work done under it (Codex G#1).
    const inherited = tree([
      node("root", null, "pending"),
      { ...node("a", "root", "completed") },
      { ...node("p", "root", "pending"), dependsOn: ["a" as GoalNodeId] },
      { ...node("b", "p", "completed") },
    ]);
    expect(dependentClosure(inherited, new Set(["a"])).sort()).toEqual(["a", "b"]);

    // …and a leaf whose dependency IS its own scaffolding parent is not
    // invalidated by a sibling's rejection: the executor drops that
    // dependency, so invalidation must drop it too (Codex G#7).
    const sibling = tree([
      node("root", null, "pending"),
      node("p", "root", "pending"),
      { ...node("a", "p", "completed") },
      { ...node("b", "p", "completed"), dependsOn: ["p" as GoalNodeId] },
    ]);
    expect(dependentClosure(sibling, new Set(["a"]))).toEqual(["a"]);

    // …and inheritance walks the WHOLE ancestor chain, not one level: a
    // grandparent's prerequisite reaches the leaves under it (Codex G#16).
    const grandparent = tree([
      node("root", null, "pending"),
      { ...node("a", "root", "completed") },
      { ...node("g", "root", "pending"), dependsOn: ["a" as GoalNodeId] },
      node("p", "g", "pending"),
      { ...node("b", "p", "completed") },
    ]);
    expect(dependentClosure(grandparent, new Set(["a"])).sort()).toEqual(["a", "b"]);
  });

  it("invalidation and execution read the SAME dependency list (Codex 2026-09-11 G#1, G#7)", () => {
    const t = tree([
      node("root", null, "pending"),
      { ...node("a", "root", "completed") },
      { ...node("p", "root", "pending"), dependsOn: ["a" as GoalNodeId] },
      { ...node("b", "p", "pending"), dependsOn: ["p" as GoalNodeId] },
      { ...node("c", "root", "pending"), dependsOn: ["p" as GoalNodeId] },
    ]);
    const deps = effectiveLeafDependencies(t);
    // Scaffolding is not a unit of work, so it has no entry at all.
    expect(deps.has("p")).toBe(false);
    // b inherits p's prerequisite and drops its dependency on its own parent.
    expect([...deps.get("b")!].sort()).toEqual(["a"]);
    // c depends on p, which means p's leaves.
    expect([...deps.get("c")!].sort()).toEqual(["b"]);
  });

  it("nothing new is verified after the resume deadline (Codex 2026-09-11 E#11)", async () => {
    const started: string[] = [];
    let past = false;
    const guarded = stopAfterDeadline(async (n: string) => { started.push(n); return "ok"; }, () => past);
    await expect(guarded("a")).resolves.toBe("ok");
    past = true;
    await expect(guarded("b")).rejects.toThrow(/deadline passed/);
    expect(started).toEqual(["a"]);
    // …and the deadline is what flips it: the timeout sets the flag before it
    // resolves the race, so the aggregator stops instead of running on.
    const source = readFileSync("src/supervisor/supervisor-brain.ts", "utf8");
    const at = source.indexOf("const alreadyDone = completedPlanOnResume(context.goalTree);");
    expect(at).toBeGreaterThan(0);
    const block = source.slice(at, source.indexOf('"No sub-tasks after decomposition"', at));
    expect(block).toContain("let verifyDeadlinePassed = false;");
    expect(block).toContain("verifyDeadlinePassed = true;");
    // The guard is wired to the FLAG, not to a constant: `() => false` keeps
    // every assertion above true while nothing ever stops (Codex G#16).
    expect(block).toContain("() => verifyDeadlinePassed)");
  });

  it("the rejection write preserves what the node already recorded (Codex 2026-09-11 D#18)", () => {
    const source = readFileSync("src/supervisor/supervisor-brain.ts", "utf8");
    const at = source.indexOf("for (const id of dependentClosure(");
    const block = source.slice(at, at + 900);
    expect(block).toContain("node?.result");
    expect(block).toContain("node?.retryCount");
    expect(block).toContain("node?.reviewStatus");
    // …including the review iterations, which a `0` here would silently drop
    // (Codex 2026-09-11 E#16).
    // Pinned as the ARGUMENT, so `node?.reviewIterations ? 0 : 0` — which
    // keeps the substring and drops every count — fails (Codex G#16).
    expect(block).toMatch(/node\?\.reviewIterations,/);
  });

  it("the supervisor asks it before declaring 'No sub-tasks after decomposition'", () => {
    const source = readFileSync("src/supervisor/supervisor-brain.ts", "utf8");
    const at = source.indexOf('"No sub-tasks after decomposition"');
    expect(source.lastIndexOf("completedPlanOnResume(context.goalTree)", at)).toBeGreaterThan(at - 8000);
    // …and it ACTS on the answer: a guard that can never be true leaves the
    // helper call sitting there while every resume falls through to "No
    // sub-tasks" (Codex 2026-09-11 E#16).
    const branch = source.slice(source.indexOf("const alreadyDone = completedPlanOnResume(context.goalTree);"), at);
    expect(branch).toContain("if (alreadyDone) {");
    expect(branch).not.toMatch(/if \(\s*(?:false|0)\s*&&/);
  });
});
