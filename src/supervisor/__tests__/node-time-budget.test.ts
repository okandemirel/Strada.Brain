import { describe, expect, it, vi } from "vitest";
import { SupervisorDispatcher } from "../supervisor-dispatcher.js";

/**
 * A node that was never told its deadline ran past the per-node timeout, was
 * killed with nothing salvaged, and its dependent nodes failed with it as
 * dependency-failed. The node must be told its budget so it can land a
 * smaller complete increment first.
 */
describe("node time budget", () => {
  function dispatcherWith(nodeTimeoutMs: number) {
    const dispatcher = Object.create(SupervisorDispatcher.prototype) as SupervisorDispatcher;
    (dispatcher as unknown as { config: unknown }).config = { nodeTimeoutMs };
    return dispatcher;
  }

  it("states the budget in the task the node receives", () => {
    const d = dispatcherWith(3_600_000);
    const withBudget = (d as unknown as {
      withDeadlineNotice(n: unknown, ms: number): { task: string; timeBudgetNotice?: string };
    }).withDeadlineNotice({ id: "n1", task: "Reconcile the tide-gauge readings" }, 3_600_000);

    // The visible label stays exactly as planned — the monitor and the
    // narrative render it; the budget rides in its own field.
    expect(withBudget.task).toBe("Reconcile the tide-gauge readings");
    expect(withBudget.timeBudgetNotice).toContain("TIME BUDGET:");
    expect(withBudget.timeBudgetNotice).toContain("60 minutes");
    expect(withBudget.timeBudgetNotice).toContain("smallest complete increment");
  });

  it("does not append the notice twice across retries", () => {
    const d = dispatcherWith(600_000);
    const api = d as unknown as {
      withDeadlineNotice(n: unknown, ms: number): { task: string; timeBudgetNotice?: string };
    };
    const once = api.withDeadlineNotice({ id: "n1", task: "Do the thing" }, 600_000);
    const twice = api.withDeadlineNotice(once, 600_000);

    expect(twice.timeBudgetNotice).toBe(once.timeBudgetNotice);
    expect(once.timeBudgetNotice!.match(/TIME BUDGET:/g)).toHaveLength(1);
    expect(once.timeBudgetNotice).toContain("10 minutes");
  });
});
