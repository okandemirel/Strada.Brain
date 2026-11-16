/**
 * The capability triage call bills the run that asked for it (task #71).
 *
 * Measured before the fix: CapabilityMatcher.matchWithTriage called
 * triageProvider.chat and read only the text, so the triage tokens reached no
 * run's usage record, no rate limiter and no /api/metrics counter. Drives the
 * REAL CapabilityMatcher through the REAL process ledger; only the triage
 * provider is scripted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityMatcher } from "./capability-matcher.js";
import type { GoalNode } from "../goals/types.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

/** No keyword signal at all: the heuristic's confidence is 0.3, so the node goes to triage. */
function ambiguousNode(id: string): GoalNode {
  return { id, task: "Make the thing nicer for the people who use it", dependsOn: [], depth: 1, status: "pending" } as unknown as GoalNode;
}

const TRIAGE_REPLY = JSON.stringify([{ capabilities: ["reasoning"], preference: "cost" }]);

let harness: UsageLedgerHarness;

beforeEach(() => {
  vi.clearAllMocks();
  harness = installUsageLedgerHarness();
});

afterEach(() => harness.uninstall());

describe("CapabilityMatcher bills its triage call (task #71)", () => {
  it("the triage reply reaches the run's onUsage once and the counters once", async () => {
    const triage = scriptedProvider("groq", [{ text: TRIAGE_REPLY, usage: usage(640, 90) }]);
    const run = harness.runSink();

    const [tagged] = await new CapabilityMatcher(triage).matchNodes([ambiguousNode("n1")], { onUsage: run.onUsage });

    expect(triage.chat).toHaveBeenCalledTimes(1);
    expect(tagged?.capabilityProfile?.source).toBe("llm-triage");
    expect(run.events).toEqual([expect.objectContaining({ provider: "groq", inputTokens: 640, outputTokens: 90 })]);
    expect(run.events).toHaveLength(1);
    expect(harness.counted()).toEqual({ input: 640, output: 90, dailyTokens: 730 });
    expect(harness.booked).toEqual([]);
  });

  it("with no run handed in, the counters still count and the matching is unchanged", async () => {
    const triage = scriptedProvider("groq", [{ text: TRIAGE_REPLY, usage: usage(640, 90) }]);

    const [tagged] = await new CapabilityMatcher(triage).matchNodes([ambiguousNode("n1")]);

    expect(tagged?.capabilityProfile).toMatchObject({ primary: ["reasoning"], preference: "cost", source: "llm-triage" });
    expect(harness.counted()).toEqual({ input: 640, output: 90, dailyTokens: 730 });
  });

  it("a node the heuristic finalizes makes no triage call and bills nothing", async () => {
    const triage = scriptedProvider("groq", [{ text: TRIAGE_REPLY, usage: usage(640, 90) }]);
    const run = harness.runSink();
    const clear = { ...ambiguousNode("n2"), task: "Implement and refactor the login module" };

    await new CapabilityMatcher(triage).matchNodes([clear], { onUsage: run.onUsage });

    expect(triage.chat).not.toHaveBeenCalled();
    expect(run.events).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
  });
});
