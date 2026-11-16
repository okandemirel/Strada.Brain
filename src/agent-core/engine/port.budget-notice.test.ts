/**
 * Task #87: the interactive token-budget stop is judged on the run's Budget, which every call of
 * the run now debits (decomposition, reviews and consensus as well as model turns). The notice
 * that tells the user "used N of M" read a counter only model turns fed, so a stop could report
 * less than the cap it stopped at. The port hands the notice the Budget's spend.
 */

import { describe, expect, it, vi } from "vitest";
import { createAgentCorePort, type PortDeps } from "./port.js";
import type { AgentEngine } from "./agent-engine.js";
import type { EngineRunContext } from "./engine-deps.js";
import { createBudget } from "../control/budget.js";
import { withRunBudget } from "../control/budget-scope.js";

function harness() {
  // What model turns alone fed the counter during the run.
  const runCtx = { chatId: "chat-1", identityKey: "user-1", cumulativeOutputTokens: 400 };
  const rendered: number[] = [];
  const engine = {
    setupAgentCoreRun: vi.fn(async () => ({ runCtx, setup: {} })),
    portRenderInteractiveBudgetExceeded: vi.fn(async (c: EngineRunContext) => {
      rendered.push(c.cumulativeOutputTokens);
    }),
    buildPolicySeed: () => ({}),
  } as unknown as AgentEngine;
  const deps = {
    getTaskExecutionContext: () => undefined,
    monitorLifecycle: () => undefined,
    createGateway: () => ({}),
  } as unknown as PortDeps;
  const { port } = createAgentCorePort(engine, deps);
  return { port, rendered };
}

describe("the interactive budget-stop notice reports what the gate counted", () => {
  it("the run's Budget spend, auxiliary calls included, not the model turns' share of it", async () => {
    const h = harness();
    await h.port.setupRun({ chatId: "chat-1" } as never);
    const budget = createBudget(1_000, 10);
    budget.debit({ inputTokens: 0, outputTokens: 400 }); // model turns
    budget.debit({ inputTokens: 0, outputTokens: 700 }); // a goal decomposition

    await withRunBudget(budget, () => h.port.renderInteractiveBudgetExceeded());

    expect(h.rendered, "the notice reported the model turns alone, short of what stopped the run").toEqual([1_100]);
  });

  it("outside a run's Budget scope the counter the model turns fed is kept", async () => {
    const h = harness();
    await h.port.setupRun({ chatId: "chat-1" } as never);

    await h.port.renderInteractiveBudgetExceeded();

    expect(h.rendered).toEqual([400]);
  });
});
