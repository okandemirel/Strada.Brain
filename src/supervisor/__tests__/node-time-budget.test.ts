import { describe, expect, it, vi } from "vitest";
import { SupervisorDispatcher } from "../supervisor-dispatcher.js";

/**
 * Measured 2026-09-03 on Sprint 7 (the delivery sprint): one node spent 70
 * minutes on 12 headless compiles, hit the one-hour node timeout, was killed
 * with nothing salvaged, and took 8 dependent nodes down with it. The node
 * was never told it had a deadline.
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
    }).withDeadlineNotice({ id: "n1", task: "Clean project structure" }, 3_600_000);

    // The visible label stays exactly as planned — the monitor and the
    // narrative render it; the budget rides in its own field.
    expect(withBudget.task).toBe("Clean project structure");
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
