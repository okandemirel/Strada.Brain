/**
 * The autonomous loop's reasoning call reaches the counters and the cost ledger (task #71).
 *
 * AgentCore.tick called activeProvider.chat and parsed only the decision: every
 * reasoning round spent tokens that no counter and no cost row ever saw. This
 * test drives one REAL tick over the REAL process ledger (usage-ledger-harness).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { AgentCore } from "./agent-core.js";
import { ObservationEngine } from "./observation-engine.js";
import { PriorityScorer } from "./priority-scorer.js";
import { createObservation } from "./observation-types.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import { estimateCostWithCache } from "../common/cost-model.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger, createLogger: () => logger }));

const DECISION = '```json\n{"action":"wait","reasoning":"nothing needs doing yet"}\n```';

function coreWith(provider: ReturnType<typeof scriptedProvider>): AgentCore {
  const engine = new ObservationEngine();
  engine.register({ name: "test", collect: () => [createObservation("build", "Build broken: 2 compile errors", { priority: 90 })] });
  const taskManager = {
    submit: vi.fn().mockReturnValue({ id: "task_mock01" }),
    listTasks: vi.fn().mockReturnValue([]),
    getStatus: vi.fn().mockReturnValue(null),
  } as unknown as TaskManager;
  const channel = { sendText: vi.fn() } as unknown as IChannelAdapter;
  const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) };
  return new AgentCore(engine, new PriorityScorer(), provider, taskManager, channel, budget, undefined, {
    minReasoningIntervalMs: 0,
    minObservationPriority: 30,
    budgetFloorPct: 10,
  });
}

let harness: UsageLedgerHarness;
beforeEach(() => {
  vi.clearAllMocks();
  harness = installUsageLedgerHarness();
});
afterEach(() => harness.uninstall());

describe("AgentCore bills its reasoning call (task #71)", () => {
  it("one tick's reasoning reply reaches the counters and books one ledger row under daemon", async () => {
    const provider = scriptedProvider("deepseek", [{ text: DECISION, usage: usage(2600, 150) }]);
    await coreWith(provider).tick();

    expect(provider.chat).toHaveBeenCalledTimes(1); // the tick reached the reasoning call
    expect(harness.counted()).toEqual({ input: 2600, output: 150, dailyTokens: 2750 });
    expect(harness.booked).toHaveLength(1);
    const row = harness.booked[0]!;
    expect(row.source).toBe("daemon");
    expect(row.metadata).toMatchObject({ triggerName: "agent-core-reasoning", tokensIn: 2600, tokensOut: 150 });
    expect(row.amount).toBeGreaterThan(0);
    expect(row.amount).toBe(estimateCostWithCache({ inputTokens: 2600, outputTokens: 150 }, "deepseek"));
  });
});
