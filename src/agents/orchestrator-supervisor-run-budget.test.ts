/**
 * A supervisor run's own calls are debited from its run budget (task #87, QA 2026-11-16).
 *
 * The orchestrator opens one Budget for a supervisor run (ACR-9) and the brain carves each
 * node's slice from it. The plan call billed through the accounting funnel (#67), but no Budget
 * scope was open around the brain, so the debit went nowhere: measured with a 200k in / 40k out
 * plan on a priced provider, the run budget kept its whole $10 and every node slice was carved
 * from a ceiling that never saw the plan's cost. With a global daily or monthly limit set, the
 * nodes were allowed to spend the plan's cost a second time.
 *
 * Drives the REAL Orchestrator admission → REAL SupervisorBrain → REAL GoalDecomposer; only the
 * provider, the budget manager's snapshot and the node executor are seams.
 */
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { SupervisorBrain } from "../supervisor/supervisor-brain.js";
import { CapabilityMatcher } from "../supervisor/capability-matcher.js";
import { ProviderAssigner } from "../supervisor/provider-assigner.js";
import { GoalDecomposer } from "../goals/goal-decomposer.js";
import { toBudgetUsage } from "../agent-core/control/budget-scope.js";
import type { Budget, ChildBudget } from "../agent-core/control/budget.js";
import type { SupervisorConfig } from "../supervisor/supervisor-types.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

/** One node at a time, so the first node's slice is everything the run budget still holds. */
const CONFIG: SupervisorConfig = {
  enabled: true, complexityThreshold: "complex", maxParallelNodes: 1,
  nodeTimeoutMs: 5000, verificationMode: "disabled", verificationBudgetPct: 15,
  triageProvider: "groq", maxFailureBudget: 3, diversityCap: 0.6,
};

const PLAN = JSON.stringify({
  nodes: [
    { id: "a", task: "Write the parser for the tide-table file format", dependsOn: [] },
    { id: "b", task: "Add a test that loads three sample tide tables", dependsOn: ["a"] },
  ],
});

const PLAN_USAGE = { inputTokens: 200_000, outputTokens: 40_000, totalTokens: 240_000 };
const DAILY_LIMIT_USD = 10;

async function runSupervisor(plannerName: string) {
  const planner = {
    name: plannerName,
    capabilities: { maxTokens: 8192, streaming: false, toolCalling: false, vision: false, systemPrompt: true },
    chat: vi.fn(async () => ({ text: PLAN, toolCalls: [], stopReason: "end_turn", usage: PLAN_USAGE })),
  };
  const decomposer = new GoalDecomposer(planner as never, 1, [0]);
  const brain = new SupervisorBrain({
    config: CONFIG,
    decomposer,
    capabilityMatcher: new CapabilityMatcher(),
    providerAssigner: new ProviderAssigner([
      { name: "worker", model: "w", scores: { reasoning: 0.9, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.5, cost: 0.4, quality: 0.9, creative: 0.8 } },
    ]),
  });
  // What the run budget held, and the slice carved, at the moment each node was handed out.
  const nodes: Array<{ remainingCostUsd: number; slice: ChildBudget["slice"] | undefined }> = [];
  let runBudget: Budget | undefined;
  brain.setExecuteNode(vi.fn(async (node: { id: string }, context: { runBudget?: Budget; nodeBudget?: ChildBudget }) => {
    runBudget = context.runBudget;
    nodes.push({ remainingCostUsd: context.runBudget?.remainingCostUsd() ?? Number.NaN, slice: context.nodeBudget?.slice });
    return { nodeId: node.id, status: "ok", output: "done", artifacts: [], toolResults: [], provider: "worker", model: "w", cost: 0, duration: 1 };
  }) as never);
  const orchestrator = new Orchestrator({
    providerManager: {
      getProvider: () => ({ name: "mock", capabilities: {}, chat: vi.fn() }),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: { name: "mock", onMessage: vi.fn(), sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    supervisorBrain: brain,
    goalDecomposer: decomposer,
    supervisorComplexityThreshold: "complex",
  });
  (orchestrator as unknown as { taskClassifier: unknown }).taskClassifier = {
    classify: () => ({ type: "analysis", complexity: "complex", criticality: "high" }),
  };
  // A $10 daily limit with nothing spent and nothing reserved: the run budget starts at $10.
  orchestrator.setUnifiedBudgetManager({
    getSnapshot: () => ({
      global: { daily: { usedUsd: 0, limitUsd: DAILY_LIMIT_USD }, monthly: { usedUsd: 0, limitUsd: 0 } },
      estimates: { outstandingUsd: 0, reconciledUsd: 0 },
    }),
  } as never);

  const decision = await orchestrator.evaluateSupervisorAdmission({
    prompt: "Import tide tables from three file formats, validate them, and show the import report",
    chatId: "chat-1",
    channelType: "cli",
  } as never);

  expect(decision.path).toBe("supervisor");
  expect(planner.chat, "the supervisor never planned").toHaveBeenCalledTimes(1);
  expect(nodes.length, "no node was handed out").toBeGreaterThanOrEqual(1);
  return { runBudget: runBudget!, nodes };
}

describe("a supervisor run's plan is debited from its run budget", () => {
  it("the plan's tokens and cost leave the run budget before the first node's slice is carved", async () => {
    const { runBudget, nodes } = await runSupervisor("claude");
    const planCost = toBudgetUsage(PLAN_USAGE, "claude", undefined).costUsd ?? 0;
    expect(planCost, "the plan must be priced for this case to measure anything").toBeGreaterThan(0);

    expect(runBudget.spentOutputTokens(), "the plan's 40,000 output tokens never reached the supervisor's run budget").toBe(40_000);
    expect(runBudget.inputTokensSeen(), "the plan's input tokens never reached the supervisor's run budget").toBe(200_000);
    expect(nodes[0]!.remainingCostUsd, "the run budget still held the plan's cost when its first node was carved").toBeCloseTo(
      DAILY_LIMIT_USD - planCost,
      9,
    );
    expect(nodes[0]!.slice?.costUsd, "the first node's slice was carved from a ceiling that never saw the plan").toBeCloseTo(
      DAILY_LIMIT_USD - planCost,
      9,
    );
  });

  it("a plan on an unpriced provider counts its tokens and leaves the cost ceiling where it was", async () => {
    const { runBudget, nodes } = await runSupervisor("ollama");

    expect(runBudget.spentOutputTokens()).toBe(40_000);
    expect(nodes[0]!.slice?.costUsd).toBeCloseTo(DAILY_LIMIT_USD, 9);
  });
});
