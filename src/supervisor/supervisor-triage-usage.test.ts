/**
 * A triage call made during a real supervisor run bills that run (task #71).
 *
 * The brain hands the run's onUsage to the capability matcher; before the fix
 * it handed nothing, and the triage tokens reached no run's usage record. Drives
 * the REAL SupervisorBrain.execute → REAL CapabilityMatcher → REAL process
 * ledger; the decomposer, the triage provider and the node executor are seams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupervisorBrain } from "./supervisor-brain.js";
import { CapabilityMatcher } from "./capability-matcher.js";
import { ProviderAssigner } from "./provider-assigner.js";
import type { SupervisorConfig } from "./supervisor-types.js";
import type { GoalNode, GoalTree } from "../goals/types.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
  getLogger: () => logger,
  getLoggerSafe: () => logger,
  getLogRingBuffer: () => [],
}));

const CONFIG: SupervisorConfig = {
  enabled: true, complexityThreshold: "complex", maxParallelNodes: 2,
  nodeTimeoutMs: 5000, verificationMode: "disabled", verificationBudgetPct: 15,
  triageProvider: "groq", maxFailureBudget: 3, diversityCap: 0.6,
};

const SCORES = { reasoning: 0.9, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.5, cost: 0.4, quality: 0.9, creative: 0.8 };

/** Two leaf nodes with no keyword signal: both go to triage, in one call. */
function ambiguousTree(): GoalTree {
  const at = Date.now();
  const node = (id: string, parentId: string | null, task: string, depth: number): GoalNode =>
    ({ id, parentId, task, dependsOn: [], depth, status: "pending", createdAt: at, updatedAt: at }) as unknown as GoalNode;
  const nodes = new Map<string, GoalNode>([
    ["root", node("root", null, "Tidy up the product", 0)],
    ["a", node("a", "root", "Make the first thing nicer for the people who use it", 1)],
    ["b", node("b", "root", "Make the second thing nicer for the people who use it", 1)],
  ]);
  return { rootId: "root", sessionId: "s1", taskDescription: "Tidy up the product", nodes, createdAt: at } as unknown as GoalTree;
}

let harness: UsageLedgerHarness;

beforeEach(() => {
  vi.clearAllMocks();
  harness = installUsageLedgerHarness();
});

afterEach(() => harness.uninstall());

describe("SupervisorBrain.execute bills its capability triage to the run (task #71)", () => {
  it("the triage call's tokens reach the onUsage handed in the context, once, and the counters", async () => {
    const triage = scriptedProvider("groq", [
      { text: JSON.stringify([{ capabilities: ["reasoning"], preference: "cost" }, { capabilities: ["code-gen"], preference: "quality" }]), usage: usage(700, 80) },
    ]);
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue(ambiguousTree()),
    };
    const brain = new SupervisorBrain({
      config: CONFIG,
      decomposer: decomposer as never,
      capabilityMatcher: new CapabilityMatcher(triage),
      providerAssigner: new ProviderAssigner([{ name: "worker", model: "w", scores: SCORES }]),
    });
    brain.setExecuteNode(vi.fn(async (node: { id: string }) => ({
      nodeId: node.id, status: "ok", output: "done", artifacts: [], toolResults: [],
      provider: "worker", model: "w", cost: 0, duration: 1,
    })) as never);
    const run = harness.runSink();

    const result = await brain.execute("Tidy up the product", { chatId: "chat-1", onUsage: run.onUsage });

    expect(result?.success).toBe(true);
    expect(triage.chat).toHaveBeenCalledTimes(1);
    expect(run.events).toEqual([expect.objectContaining({ provider: "groq", inputTokens: 700, outputTokens: 80 })]);
    expect(run.events).toHaveLength(1);
    expect(harness.counted()).toEqual({ input: 700, output: 80, dailyTokens: 780 });
  });
});
