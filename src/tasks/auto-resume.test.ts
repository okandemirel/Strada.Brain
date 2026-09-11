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

import { decideAutoResume, MAX_AUTO_RESUMES, MAX_AUTO_REPLANS , decideMissionKeepAlive, stripRetryMachinery } from "./auto-resume.js";

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
    const end = source.indexOf("this.autoResumeBlockedGoal(", at);
    const branch = source.slice(at, end);

    expect(at, "the partial branch moved; this test is measuring nothing").toBeGreaterThan(0);
    expect(end, "a partially finished goal still stops for good").toBeGreaterThan(at);
    // A planning-stage outage (no tree ever formed) is a mission-level retry,
    // not a goal-level resume — measured 2026-08-26: a provider-cooldown storm
    // failed decomposition, settled partial with zero nodes, and parked.
    expect(branch).toContain("scheduleMissionKeepAlive");
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

describe("mission keep-alive — only time and budget may stop a mission", () => {
  it("keeps retrying with capped exponential backoff under the cap", () => {
    const d = decideMissionKeepAlive(0, { budgetExceeded: false });
    expect(d.action).toBe("retry");
    expect(d.backoffMs).toBe(30_000);
    expect(decideMissionKeepAlive(3, { budgetExceeded: false }).backoffMs).toBe(240_000);
    expect(decideMissionKeepAlive(9, { budgetExceeded: false }).action).toBe("retry");
  });

  it("caps the backoff at ten minutes", () => {
    // attempt 8 stays under the retry cap but its raw 30s*2^8 overflows the cap.
    expect(decideMissionKeepAlive(8, { budgetExceeded: false }).backoffMs).toBe(600_000);
  });

  it("escalates to a visible report once retries are spent", () => {
    const d = decideMissionKeepAlive(10, { budgetExceeded: false });
    expect(d.action).toBe("report");
    expect(d.reportReason).toMatch(/needs a human/i);
  });

  it("stops immediately on budget — and says so honestly", () => {
    const d = decideMissionKeepAlive(1, { budgetExceeded: true });
    expect(d.action).toBe("report");
    expect(d.reportReason).toMatch(/budget/i);
  });
});

describe("stripRetryMachinery", () => {
  // The keep-alive writes its bookkeeping into the task's RESULT, which is
  // also what a replay prompt quotes back as "previous attempt progress".
  // Measured 2026-09-11: the restart-carry sentence was added to the block
  // text and to two of the three strip sites, and reached the replay prompt
  // from the third.
  it("removes every sentence the keep-alive writes, and keeps the work's own words", () => {
    const cleaned = stripRetryMachinery(
      "Transient failure — worker crashed. Auto-retry 9/10 in ~600s. Restart re-arm — failure retries still at 8/10.",
    );
    expect(cleaned).toBe("worker crashed.");
    expect(stripRetryMachinery("Reaped: no progress signal for 60 minutes. Placeholders now 231."))
      .toBe("Placeholders now 231.");
  });

  it("leaves a real report alone", () => {
    const report = "Sprint 3 delivered: 24 sprites replaced, measured placeholderSprites 231.";
    expect(stripRetryMachinery(report)).toBe(report);
  });
});

describe("stripRetryMachinery is used where a result reaches a model (Codex 2026-09-11 G#16)", () => {
  it("is called by priorProgressSummary and the campaign's retry tail", () => {
    // The helper being right is not the property that matters; the property
    // is that every path feeding a task's own result back into a prompt runs
    // through it. Mutating the call away used to leave both tests green.
    const taskManager = readFileSync("src/tasks/task-manager.ts", "utf8");
    const atSummary = taskManager.indexOf("const resultTail =");
    expect(atSummary).toBeGreaterThan(0);
    expect(taskManager.slice(atSummary, atSummary + 200)).toContain("stripRetryMachinery(");
    // …and the replay prompt's "Last known failure" too (G#10).
    const atFailure = taskManager.indexOf("Last known failure:");
    expect(taskManager.slice(atFailure - 400, atFailure)).toContain("stripRetryMachinery(");

    const campaign = readFileSync("src/campaign/campaign-manager.ts", "utf8");
    const atTail = campaign.indexOf("The previous attempt ended ${status}:");
    expect(atTail).toBeGreaterThan(0);
    expect(campaign.slice(atTail - 900, atTail)).toContain("stripRetryMachinery(output)");
    // No fallback to the unstripped text (G#10).
    expect(campaign.slice(atTail, atTail + 200)).not.toContain("cleaned || output");
  });

  it("removes the scheduler's re-arm reason, and leaves nothing when that is all there was", () => {
    expect(stripRetryMachinery("Transient failure — keep-alive re-armed after restart. Auto-retry 9/10 in ~600s. Restart re-arm — failure retries still at 8/10.")).toBe("");
    expect(stripRetryMachinery("could not resubmit after backoff — keep-alive re-armed after restart")).toBe("");
    expect(stripRetryMachinery("Reaped: no progress signal for 60 minutes.")).toBe("");
    // A real cause beside the machinery survives.
    expect(stripRetryMachinery("Transient failure — keep-alive re-armed after restart. Compile error CS0246.")).toBe("Compile error CS0246.");
  });
});

describe("progress is CUMULATIVE, not this dispatch's (Codex 2026-09-11 F#8)", () => {
  it("counts the tree's completed nodes so a second finished node is progress", () => {
    const source = readFileSync("src/tasks/background-executor.ts", "utf8");
    const at = source.indexOf("const decision = decideAutoResume(");
    expect(at).toBeGreaterThan(0);
    const block = source.slice(at - 900, at + 200);
    // The comparison reads the TREE, not the dispatch, and the stored
    // baseline is the same number so the next round compares like with like.
    expect(block).toContain("this.completedNodeCount(rootId)");
    // …and it is what the comparison USES, not merely what it computes.
    expect(block).toContain("const progressed = completedInTree ?? succeeded;");
    expect(block).toContain("decideAutoResume(state, progressed)");
    expect(source.slice(at, at + 3000)).toContain("previousSucceeded: progressed,");

    // The rule itself: one more completed node is progress, the same count is not.
    expect(decideAutoResume({ attempts: 1, replans: 0, previousSucceeded: 1 }, 2).action).toBe("resume");
    expect(decideAutoResume({ attempts: 1, replans: 0, previousSucceeded: 1 }, 1).action).toBe("replan");
  });
});
