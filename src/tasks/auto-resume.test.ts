/**
 * A run that stops with work left has to have a reason.
 *
 * Measured 2026-08-21, run 37: five nodes, one completed, four failed. The task
 * blocked, the episode was marked terminal, and the process sat idle for
 * seventy-one minutes until I looked. Everything needed to carry on was in
 * place — prepareTreeForRetry keeps completed nodes and resets the rest,
 * retryGoalRoot resubmits the tree — and the only caller was a button in the
 * dashboard.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decideAutoResume, MAX_AUTO_RESUMES, MAX_AUTO_REPLANS } from "./auto-resume.js";

describe("picking a blocked goal back up", () => {
  it("retries the first block even when nothing succeeded", () => {
    // A transient failure and a permanent one look identical the first time.
    const decision = decideAutoResume({ attempts: 0, replans: 0, previousSucceeded: 0 }, 0);

    expect(decision.action).toBe("resume");
  });

  it("carries on while rounds are still completing new nodes", () => {
    expect(decideAutoResume({ attempts: 1, replans: 0, previousSucceeded: 1 }, 3).action).toBe("resume");
  });

  it("stops when a round completed nothing new", () => {
    // The stall rule. Without it a goal that cannot progress runs forever.
    const decision = decideAutoResume({ attempts: 2, replans: 0, previousSucceeded: 3 }, 3);

    // Not "stop": a round that repeated itself is the moment to plan
    // differently, which is the one thing replaying the same tree cannot do.
    expect(decision.action).toBe("replan");
    expect(decision.reason).toContain("no new nodes");
  });

  it("stops when a round went backwards", () => {
    expect(decideAutoResume({ attempts: 1, replans: 0, previousSucceeded: 4 }, 2).action).toBe("replan");
  });

  it("stops at the hard cap however well it is going", () => {
    const decision = decideAutoResume(
      { attempts: MAX_AUTO_RESUMES, replans: 0, previousSucceeded: 1 },
      99,
    );

    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("so a person can look");
  });

  it("always says why, in both directions", () => {
    for (const d of [
      decideAutoResume({ attempts: 0, replans: 0, previousSucceeded: 0 }, 0),
      decideAutoResume({ attempts: 9, replans: 9, previousSucceeded: 0 }, 0),
    ]) {
      expect(d.reason.length).toBeGreaterThan(10);
    }
  });


  it("stops once replanning has also stopped producing anything", () => {
    // A different plan is worth trying twice. A third identical outcome means
    // the obstacle is not the plan.
    const decision = decideAutoResume(
      { attempts: 2, replans: MAX_AUTO_REPLANS, previousSucceeded: 2 },
      2,
    );

    expect(decision.action).toBe("stop");
  });

  it("prefers replaying while progress is still being made", () => {
    // Replanning throws away a tree that is still completing nodes; only a
    // stalled one earns a new plan.
    expect(
      decideAutoResume({ attempts: 1, replans: 1, previousSucceeded: 2 }, 5).action,
    ).toBe("resume");
  });

  it("says which of the three it chose, and why, every time", () => {
    const seen = new Set<string>();
    for (const state of [
      { attempts: 0, replans: 0, previousSucceeded: 0 },
      { attempts: 1, replans: 0, previousSucceeded: 3 },
      { attempts: 9, replans: 9, previousSucceeded: 3 },
    ]) {
      const d = decideAutoResume(state, 3);
      seen.add(d.action);
      expect(d.reason.length).toBeGreaterThan(10);
    }

    expect(seen.size).toBeGreaterThan(1);
  });

  it("is what the block branch actually does", () => {
    const source = readFileSync("src/tasks/background-executor.ts", "utf8");
    const at = source.indexOf("if (supervisorResult.partial) {");
    const branch = source.slice(at, source.indexOf("}", source.indexOf("return;", at)));

    expect(at, "the partial branch moved; this test is measuring nothing").toBeGreaterThan(0);
    expect(branch, "a partially finished goal still stops for good").toContain(
      "autoResumeBlockedGoal",
    );
  });

  it("hands the failure reasons to the replan, not just the fact of failure", () => {
    // A fresh decomposition that is not told what blocked the last one is just
    // a reshuffle. Run 40 stalled on two nodes whose reasons were already in
    // nodeResults; this is what carries them into the next plan.
    const source = readFileSync("src/tasks/background-executor.ts", "utf8");
    const method = source.slice(source.indexOf("private autoResumeBlockedGoal("));
    const body = method.slice(0, method.indexOf("\n  }\n"));

    expect(body).toContain("replanGoalRoot(rootId, nodeOutcomes)");
    expect(source).toContain("summariseNodeOutcomes(supervisorResult.nodeResults),\n          );");
  });

  it("does not spend a replay budget on a replan, or the other way round", () => {
    // They are separate allowances: a goal that keeps being replanned must not
    // exhaust the replays it might still need, and vice versa.
    const source = readFileSync("src/tasks/background-executor.ts", "utf8");
    const method = source.slice(source.indexOf("private autoResumeBlockedGoal("));
    const body = method.slice(0, method.indexOf("\n  }\n"));

    expect(body).toContain("attempts: replanning ? state.attempts : state.attempts + 1");
    expect(body).toContain("replans: replanning ? state.replans + 1 : state.replans");
  });
});
