/**
 * A run that told the user it could not finish must not be recorded as a success.
 *
 * Measured on two from-scratch runs: each surfaced "Unable to complete this task
 * — the AI provider is not responding" twice, and each closed its episode with
 * failed:false. The settlement call passed no outcome at all, so it took the
 * default, and nothing carried the terminal reason out to it.
 */

import { describe, it, expect, vi } from "vitest";
import {
  isFailedTerminalKey,
  FAILED_TERMINAL_KEYS,
  systemStampsIn,
  terminalKeyOf,
  terminalMessageKeyOf,
} from "./terminal-outcome.js";
import { isTerminalKey, type TerminalKey } from "./terminal-key.js";
import { getResilienceMessage, renderingsOf, type MessageKey } from "../resilience-messages.js";
import { isTerminalFailureReport } from "./verifier-pipeline.js";

describe("which terminals are failures", () => {
  it("counts a provider outage as one", () => {
    expect(isFailedTerminalKey("provider_abort")).toBe(true);
  });

  it("counts a stuck run and an exhausted budget as failures", () => {
    expect(isFailedTerminalKey("task_stuck")).toBe(true);
    expect(isFailedTerminalKey("token_budget_exceeded")).toBe(true);
  });

  it("leaves a clean terminal alone", () => {
    // A clean finish maps to no key at all; that must stay a success.
    expect(isFailedTerminalKey(undefined)).toBe(false);
  });

  it("does not treat a question to the user as a failure", () => {
    // Asking the user something is a legitimate way for a run to end.
    expect(isFailedTerminalKey("provider_ask_user")).toBe(false);
    expect(FAILED_TERMINAL_KEYS.has("provider_ask_user")).toBe(false);
  });
});

/**
 * In campaign 18d4t five of six milestone tips ended on the system's own
 * "task_stuck" notice and all six went green: how a run ended existed only as
 * the sentence it showed the user (GDD-drift plan W01).
 */
describe("the run's terminal as a key", () => {
  const noQuota = () => false;
  const quota = () => true;

  it.each<[string | undefined, "completed" | "failed" | "blocked" | undefined, (() => boolean) | undefined, TerminalKey]>([
    ["verdict-stop:loop-detected", "completed", undefined, "task_stuck"],
    ["verdict-stop:loop-detected", "failed", undefined, "task_stuck"],
    ["hard-timeout:x", "completed", undefined, "cut_short"],
    ["hard-timeout:task", "failed", undefined, "cut_short"],
    ["task-inactivity", "failed", undefined, "cut_short"],
    ["budget-exhausted:cost", "blocked", undefined, "cut_short"],
    ["budget-exhausted:tokens", "blocked", undefined, "token_budget_exceeded"],
    ["end_turn", "completed", undefined, "done"],
    ["done", "completed", undefined, "done"],
    ["plan-review", "completed", undefined, "done"],
    ["goal-handoff", "completed", undefined, "done"],
    [undefined, "completed", undefined, "done"],
    // A redundant sibling won: the goal it served is met.
    ["first-success-satisfied", "completed", undefined, "done"],
    [undefined, "failed", quota, "provider_quota"],
    // A failure that names no cause is not a clean finish, and nothing says the provider caused it.
    [undefined, "failed", noQuota, "error"],
    [undefined, "failed", undefined, "error"],
    ["publication failed: the workspace commit threw", "failed", undefined, "error"],
    [undefined, "blocked", undefined, "error"],
    ["provider-stall:call", "failed", undefined, "provider_abort"],
    ["verdict-stop:health", "failed", undefined, "provider_abort"],
    // A provider that kept failing is the provider's stop, whatever the background notice says.
    ["provider-failure", "completed", undefined, "provider_abort"],
    ["blocked:ask_user", "blocked", undefined, "provider_ask_user"],
    ["blocked:provider_unavailable", "blocked", undefined, "provider_ask_user"],
    ["max-iterations", "completed", undefined, "max_steps_reached"],
    ["epoch-budget-exhausted", "blocked", undefined, "task_stuck"],
    ["max-tokens-runaway", "blocked", undefined, "task_stuck"],
    // The worker's own NOT DELIVERED is its outcome, whatever the provider registry says now.
    ["terminal-failure", "failed", quota, "task_stuck"],
    ["failed", "failed", quota, "task_stuck"],
    ["blocked", "blocked", undefined, "task_stuck"],
    ["self-managed-write-rejected", "blocked", undefined, "task_stuck"],
    ["user-cancel", "completed", undefined, "interrupted"],
    ["task-winddown", "completed", undefined, "interrupted"],
    ["parent-cancelled(user-cancel)", "completed", undefined, "interrupted"],
    ["parent-cancelled(parent-cancelled(task-winddown))", "completed", undefined, "interrupted"],
    // A node its parent stopped inherits the parent's cause.
    ["parent-cancelled(hard-timeout:task)", "failed", undefined, "cut_short"],
    ["parent-cancelled(provider-stall:call)", "failed", undefined, "provider_abort"],
    ["parent-cancelled(verdict-stop:loop-detected)", "failed", undefined, "task_stuck"],
  ])("terminalKeyOf(%j, %j) is the key that says how the run ended", (reason, status, quotaStopped, expected) => {
    const key = terminalKeyOf(reason, status, quotaStopped);
    expect(key).toBe(expected);
    expect(isTerminalKey(key)).toBe(true);
  });

  it("asks the provider registry only when the reason does not already say why", () => {
    const quotaStopped = vi.fn(() => true);
    expect(terminalKeyOf("verdict-stop:loop-detected", "failed", quotaStopped)).toBe("task_stuck");
    expect(terminalKeyOf("hard-timeout:task", "failed", quotaStopped)).toBe("cut_short");
    expect(quotaStopped).not.toHaveBeenCalled();
  });
});

/**
 * The mapper as it stood before W01 (orchestrator.ts mapTerminalReasonToMessageKey
 * at 048f17c4), frozen here. Moving the logic must not change one sentence a
 * user reads.
 */
function mappingBeforeW01(
  reason: string | undefined,
  status: "completed" | "failed" | "blocked" | undefined,
  quotaStopped: () => boolean,
): MessageKey | undefined {
  if (reason) {
    if (reason.startsWith("budget-exhausted")) {
      return reason.endsWith(":tokens") ? "token_budget_exceeded" : "cost_budget_exceeded";
    }
    if (reason.startsWith("provider-stall") || reason.startsWith("hard-timeout") || reason === "task-inactivity") {
      return "provider_abort";
    }
    if (reason.startsWith("verdict-stop")) {
      return reason.endsWith(":loop-detected") ? "task_stuck" : "provider_abort";
    }
    if (reason.includes("ask_user")) return "provider_ask_user";
    if (reason.includes("provider_unavailable")) return "provider_ask_user";
    if (reason === "provider-failure" || reason === "max-tokens-runaway" || reason === "epoch-budget-exhausted") {
      return "task_stuck";
    }
    if (reason === "max-iterations") return "max_steps_reached";
    if (reason.startsWith("parent-cancelled")) return "provider_abort";
  }
  if (status === "failed") return quotaStopped() ? "provider_quota" : "provider_abort";
  return undefined;
}

describe("the sentence a user reads is unchanged", () => {
  const REASONS: (string | undefined)[] = [
    undefined, "", "done", "end_turn", "plan-review", "goal-handoff",
    "user-cancel", "task-winddown", "first-success-satisfied",
    "parent-cancelled(user-cancel)", "parent-cancelled(hard-timeout:task)", "parent-cancelled(provider-stall:call)",
    "parent-cancelled(budget-exhausted:tokens)", "parent-cancelled(verdict-stop:loop-detected)",
    "provider-stall:call", "provider-stall:task", "hard-timeout:call", "hard-timeout:task", "hard-timeout:x",
    "task-inactivity", "budget-exhausted:tokens", "budget-exhausted:cost",
    "verdict-stop:health", "verdict-stop:loop-detected",
    "blocked:ask_user", "blocked:provider_unavailable", "provider-failure", "max-tokens-runaway",
    "epoch-budget-exhausted", "max-iterations", "terminal-failure", "failed", "blocked",
    "self-managed-write-rejected", "publication failed: the workspace commit threw", "something-new",
  ];
  const STATUSES = ["completed", "failed", "blocked", undefined] as const;

  it("matches the pre-W01 mapping for every reason, status and quota state", () => {
    for (const reason of REASONS) {
      for (const status of STATUSES) {
        for (const quota of [false, true]) {
          expect(
            terminalMessageKeyOf(reason, status, () => quota),
            `${String(reason)} / ${String(status)} / quota=${quota}`,
          ).toBe(mappingBeforeW01(reason, status, () => quota));
        }
      }
    }
  });
});

describe("the system's own stamps in a stored result", () => {
  const STAMPED: TerminalKey[] = [
    "task_stuck",
    "provider_abort",
    "provider_quota",
    "token_budget_exceeded",
    "max_steps_reached",
  ];
  const fill = (template: string): string =>
    template
      .replace(/\{provider\}/g, "Kimi")
      .replace(/\{detail\}/g, "You've reached your usage limit for this billing cycle.")
      .replace(/\{used\}/g, "812")
      .replace(/\{budget\}/g, "800");

  it("knows every locale", () => {
    expect(renderingsOf("task_stuck")).toHaveLength(8);
  });

  it("finds task_stuck in all eight locales", () => {
    for (const text of renderingsOf("task_stuck")) {
      expect(systemStampsIn(text), text).toEqual(["task_stuck"]);
    }
  });

  it("finds each stamped key in every locale, parameters filled in", () => {
    for (const key of STAMPED) {
      for (const template of renderingsOf(key as MessageKey)) {
        const text = `Worker report: wired the board.\n\n${fill(template)}`;
        expect(systemStampsIn(text), `${key}: ${template}`).toEqual([key]);
      }
    }
  });

  it("finds a stamp whose start the 500-character excerpt cut off (18d4t m1)", () => {
    expect(
      systemStampsIn("fter multiple approaches. I'll share what I tried and where I got blocked so we can move forward together."),
    ).toEqual(["task_stuck"]);
  });

  it("finds the quota notice with its provider and reply filled in", () => {
    const en = getResilienceMessage("provider_quota", "en", { provider: "Kimi", detail: "Your quota will be refreshed in the next cycle." });
    const tr = getResilienceMessage("provider_quota", "tr", { provider: "Kimi", detail: "Kota doldu." });
    expect(systemStampsIn(en)).toEqual(["provider_quota"]);
    expect(systemStampsIn(tr)).toEqual(["provider_quota"]);
  });

  it("finds a stamp that a line wrap broke", () => {
    const wrapped = getResilienceMessage("task_stuck", "en").replace(" after multiple", "\n  after multiple");
    expect(systemStampsIn(wrapped)).toEqual(["task_stuck"]);
  });

  it("names every stamp in a result, worst first", () => {
    const text = [
      getResilienceMessage("provider_quota", "en", { provider: "Kimi", detail: "limit" }),
      "Then the next attempt ran.",
      getResilienceMessage("task_stuck", "en"),
    ].join("\n");
    expect(systemStampsIn(text)).toEqual(["task_stuck", "provider_quota"]);
  });

  it("reads a worker's own words as nothing", () => {
    expect(systemStampsIn("I'll add the double jump; enemies can't pass walls.")).toEqual([]);
    expect(systemStampsIn("I got stuck on the jump physics for a while, then fixed it. Tests are green.")).toEqual([]);
    expect(systemStampsIn("")).toEqual([]);
    expect(systemStampsIn(undefined)).toEqual([]);
  });
});

describe("a terminal failure report, read with the system's stamps", () => {
  it("is not read off the stamp by default — W01 changes no decision", () => {
    // campaign-manager settles a completed milestone as failed on this
    // predicate; reading stamps by default would flip 18d4t's greens before
    // the scope gate (W09) decides how to use them.
    for (const text of renderingsOf("task_stuck")) {
      expect(isTerminalFailureReport(text), text).toBe(false);
    }
  });

  it("is a failure report in every locale when the caller asks for the stamps", () => {
    for (const text of renderingsOf("task_stuck")) {
      expect(isTerminalFailureReport(text, { systemStamps: true }), text).toBe(true);
    }
    expect(isTerminalFailureReport(
      getResilienceMessage("provider_quota", "en", { provider: "Kimi", detail: "limit" }),
      { systemStamps: true },
    )).toBe(true);
  });

  it("still reads a worker's description of the game as no failure", () => {
    expect(isTerminalFailureReport("I'll add the double jump; enemies can't pass walls.", { systemStamps: true })).toBe(false);
  });
});
