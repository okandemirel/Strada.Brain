/**
 * The interactive run.ending notice names the cause the run actually stopped on.
 *
 * Audit agent-core-goals#1: every reason outside a "happy" list rendered "the AI
 * provider is not responding … switch to a different provider", so an honest
 * failure report, a refused write and the spending limit each ended with advice
 * to change providers. Only a provider cause may say the provider failed.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../events/agent-event.js";
import { renderInteractiveResilienceEvent } from "./render.js";
import { getResilienceMessage } from "../../agents/resilience-messages.js";
import { isFailedTerminalKey } from "../../agents/autonomy/terminal-outcome.js";
import { Orchestrator } from "../../agents/orchestrator.js";

const PROVIDER_ABORT = getResilienceMessage("provider_abort", "en");

function render(reason: string, language = "en"): string[] {
  const out: string[] = [];
  renderInteractiveResilienceEvent({ type: "run.ending", reason } as AgentEvent, language, (t) => out.push(t));
  return out;
}

describe("interactive run.ending renders the cause it stopped on (agent-core-goals#1)", () => {
  it("a reflection that settled as failed already rendered its report: no provider notice", () => {
    expect(render("failed")).toEqual([]);
  });

  it("a write the self-managed review refused already said why: no provider notice", () => {
    expect(render("self-managed-write-rejected")).toEqual([]);
  });

  it("the cost cap says it is the spending limit, in the user's language", () => {
    const en = render("budget-exhausted:cost");
    expect(en).toHaveLength(1);
    expect(en[0]).not.toBe(PROVIDER_ABORT);
    expect(en[0]).toBe(getResilienceMessage("cost_budget_exceeded", "en"));
    expect(en[0]).toMatch(/budget|spending/i);
    expect(render("budget-exhausted:cost", "tr")[0]).toBe(getResilienceMessage("cost_budget_exceeded", "tr"));
  });

  it("a cancel the user or the daemon asked for is not blamed on the provider", () => {
    expect(render("user-cancel")).toEqual([]);
    expect(render("task-winddown")).toEqual([]);
    expect(render("parent-cancelled(user-cancel)")).toEqual([]);
  });

  it("a loop stop says the run got stuck, as the background path does", () => {
    expect(render("verdict-stop:loop-detected")).toEqual([getResilienceMessage("task_stuck", "en")]);
  });

  it("a background run stopped by the cost cap reports the spending limit too, and still as unfinished", () => {
    // The background/worker terminal text comes from the orchestrator's own mapper.
    const map = (Orchestrator.prototype as unknown as {
      mapTerminalReasonToMessageKey(this: unknown, reason: string, status: string): string | undefined;
    }).mapTerminalReasonToMessageKey;
    const key = map.call({ quotaStopped: () => false }, "budget-exhausted:cost", "failed");
    expect(key).toBe("cost_budget_exceeded");
    expect(isFailedTerminalKey(key)).toBe(true);
  });

  it("a provider cause still says the provider failed", () => {
    for (const reason of [
      "provider-stall:call",
      "provider-stall:task",
      "hard-timeout:call",
      "hard-timeout:task",
      "task-inactivity",
      "verdict-stop:health",
      "provider-failure",
      "parent-cancelled(provider-stall:call)",
    ]) {
      expect(render(reason), reason).toEqual([PROVIDER_ABORT]);
    }
  });
});
