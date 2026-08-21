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

import { decideAutoResume, MAX_AUTO_RESUMES } from "./auto-resume.js";

describe("picking a blocked goal back up", () => {
  it("retries the first block even when nothing succeeded", () => {
    // A transient failure and a permanent one look identical the first time.
    const decision = decideAutoResume({ attempts: 0, previousSucceeded: 0 }, 0);

    expect(decision.resume).toBe(true);
  });

  it("carries on while rounds are still completing new nodes", () => {
    expect(decideAutoResume({ attempts: 1, previousSucceeded: 1 }, 3).resume).toBe(true);
  });

  it("stops when a round completed nothing new", () => {
    // The stall rule. Without it a goal that cannot progress runs forever.
    const decision = decideAutoResume({ attempts: 2, previousSucceeded: 3 }, 3);

    expect(decision.resume).toBe(false);
    expect(decision.reason).toContain("no new nodes");
  });

  it("stops when a round went backwards", () => {
    expect(decideAutoResume({ attempts: 1, previousSucceeded: 4 }, 2).resume).toBe(false);
  });

  it("stops at the hard cap however well it is going", () => {
    const decision = decideAutoResume(
      { attempts: MAX_AUTO_RESUMES, previousSucceeded: 1 },
      99,
    );

    expect(decision.resume).toBe(false);
    expect(decision.reason).toContain("so a person can look");
  });

  it("always says why, in both directions", () => {
    for (const d of [
      decideAutoResume({ attempts: 0, previousSucceeded: 0 }, 0),
      decideAutoResume({ attempts: 9, previousSucceeded: 0 }, 0),
    ]) {
      expect(d.reason.length).toBeGreaterThan(10);
    }
  });

  it("is what the block branch actually does", () => {
    // The decision function is worth nothing unless the branch that ended run
    // 37 consults it. Slice that branch, not the file: a match anywhere else
    // would pass while the branch still stops dead.
    const source = readFileSync("src/tasks/background-executor.ts", "utf8");
    const at = source.indexOf("if (supervisorResult.partial) {");
    const branch = source.slice(at, source.indexOf("}", source.indexOf("return;", at)));

    expect(at, "the partial branch moved; this test is measuring nothing").toBeGreaterThan(0);
    expect(branch, "a partially finished goal still stops for good").toContain(
      "autoResumeBlockedGoal",
    );
  });
});
