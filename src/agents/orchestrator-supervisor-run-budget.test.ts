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
 * QA, attempt 3: with an image in the input, admission first asks a vision model for grounded
 * planning context, and that call was recorded before the scope opened — debited nowhere, or,
 * when admission ran inside another run's scope, from that run's Budget.
 *
 * QA, attempt 4: after task #71 the supervisor's capability triage and node verification bill
 * through the direct-call ledger (billedChat → createProviderUsageLedger), which reached the
 * shared recorder without the Budget's debit: 0 debited inside the admission's scope.
 *
 * Drives the REAL Orchestrator admission → REAL SupervisorBrain → REAL GoalDecomposer and REAL
 * CapabilityMatcher, with the REAL direct-call ledger installed; only the providers, the budget
 * manager's snapshot and the node executor are seams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { SupervisorBrain } from "../supervisor/supervisor-brain.js";
import { CapabilityMatcher } from "../supervisor/capability-matcher.js";
import { ProviderAssigner } from "../supervisor/provider-assigner.js";
import { GoalDecomposer } from "../goals/goal-decomposer.js";
import { toBudgetUsage, UNSCOPED_DEBIT_LOG, withRunBudget } from "../agent-core/control/budget-scope.js";
import { createBudget, type Budget, type ChildBudget } from "../agent-core/control/budget.js";
import { createProviderUsageLedger } from "../agent-core/engine/accounting.js";
import { installProviderUsageLedger } from "./providers/billed-call.js";
import type { SupervisorConfig } from "../supervisor/supervisor-types.js";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
  getLogger: () => log,
  getLoggerSafe: () => log,
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
const GROUNDING_USAGE = { inputTokens: 3_000, outputTokens: 500, totalTokens: 3_500 };
const TRIAGE_USAGE = { inputTokens: 1_200, outputTokens: 150, totalTokens: 1_350 };
const DAILY_LIMIT_USD = 10;
const PROMPT = "Import tide tables from three file formats, validate them, and show the import report";
/** A screenshot of the import screen: rich input, so admission grounds it before planning. */
const WITH_IMAGE = [
  { type: "text", text: PROMPT },
  { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
];

interface Options {
  readonly plannerName?: string;
  /** Give admission an image, so it first asks a vision model for grounded planning context. */
  readonly image?: boolean;
  /** The brain finds nothing to decompose after admission has grounded the input. */
  readonly brainDeclines?: boolean;
  /** Give the capability matcher a triage model, which bills through the direct-call ledger. */
  readonly triage?: boolean;
}

async function runSupervisor(opts: Options = {}) {
  const planner = {
    name: opts.plannerName ?? "claude",
    capabilities: { maxTokens: 8192, streaming: false, toolCalling: false, vision: false, systemPrompt: true },
    chat: vi.fn(async () => ({ text: PLAN, toolCalls: [], stopReason: "end_turn", usage: PLAN_USAGE })),
  };
  const vision = {
    name: "claude",
    capabilities: { maxTokens: 8192, streaming: false, toolCalling: true, vision: true, systemPrompt: true },
    chat: vi.fn(async () => ({
      text: "- The import screen lists three files\n- One shows a red parse error",
      toolCalls: [],
      stopReason: "end_turn",
      usage: GROUNDING_USAGE,
    })),
  };
  const triage = {
    name: "claude",
    capabilities: { maxTokens: 4096, streaming: false, toolCalling: false, vision: false, systemPrompt: true },
    chat: vi.fn(async () => ({
      text: JSON.stringify([
        { capabilities: ["code-gen"], preference: "quality" },
        { capabilities: ["code-gen"], preference: "quality" },
      ]),
      toolCalls: [],
      stopReason: "end_turn",
      usage: TRIAGE_USAGE,
    })),
  };
  const decomposer = new GoalDecomposer(planner as never, 1, [0]);
  const brain = new SupervisorBrain({
    config: CONFIG,
    decomposer,
    capabilityMatcher: new CapabilityMatcher(opts.triage ? (triage as never) : undefined),
    providerAssigner: new ProviderAssigner([
      { name: "worker", model: "w", scores: { reasoning: 0.9, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.5, cost: 0.4, quality: 0.9, creative: 0.8 } },
    ]),
  });
  if (opts.brainDeclines) vi.spyOn(brain, "shouldExecute").mockReturnValue(false);
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
      getProvider: () => vision,
      getActiveInfo: () => ({ providerName: "claude", model: "default", isDefault: true }),
      listExecutionCandidates: () => [],
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
    prompt: PROMPT,
    chatId: "chat-1",
    channelType: "cli",
    ...(opts.image ? { userContent: WITH_IMAGE } : {}),
  } as never);

  if (!opts.brainDeclines) {
    expect(decision.path).toBe("supervisor");
    expect(planner.chat, "the supervisor never planned").toHaveBeenCalledTimes(1);
    expect(nodes.length, "no node was handed out").toBeGreaterThanOrEqual(1);
  }
  return { decision, runBudget: runBudget!, nodes, vision, triage };
}

/** Every call the admission recorded had a run's Budget in scope. */
function expectNothingRecordedUnscoped(): void {
  const unscoped = log.warn.mock.calls.filter(([message]) => message === UNSCOPED_DEBIT_LOG);
  expect(unscoped, "a call was recorded with no run's Budget in scope").toEqual([]);
}

describe("a supervisor run's plan is debited from its run budget", () => {
  beforeEach(() => {
    // Bootstrap installs the process ledger the direct calls (billedChat) bill through; so does this.
    installProviderUsageLedger(createProviderUsageLedger({ counters: {} }));
  });
  afterEach(() => {
    installProviderUsageLedger(undefined);
    vi.restoreAllMocks();
    log.warn.mockClear();
  });

  it("the plan's tokens and cost leave the run budget before the first node's slice is carved", async () => {
    const { runBudget, nodes } = await runSupervisor();
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
    expectNothingRecordedUnscoped();
  });

  it("a plan on an unpriced provider counts its tokens and leaves the cost ceiling where it was", async () => {
    const { runBudget, nodes } = await runSupervisor({ plannerName: "ollama" });

    expect(runBudget.spentOutputTokens()).toBe(40_000);
    expect(nodes[0]!.slice?.costUsd).toBeCloseTo(DAILY_LIMIT_USD, 9);
  });

  it("the grounding call on an image is debited from the same run budget, before the nodes are carved", async () => {
    const { runBudget, nodes, vision } = await runSupervisor({ image: true });
    const cost = (toBudgetUsage(PLAN_USAGE, "claude", undefined).costUsd ?? 0) + (toBudgetUsage(GROUNDING_USAGE, "claude", undefined).costUsd ?? 0);

    expect(vision.chat, "admission never grounded the image").toHaveBeenCalledTimes(1);
    expect(runBudget.spentOutputTokens(), "the grounding call's 500 output tokens never reached the supervisor's run budget").toBe(40_500);
    expect(runBudget.inputTokensSeen(), "the grounding call's input tokens never reached the supervisor's run budget").toBe(203_000);
    expect(nodes[0]!.slice?.costUsd, "the first node's slice was carved before the grounding call's cost came off").toBeCloseTo(
      DAILY_LIMIT_USD - cost,
      9,
    );
    expectNothingRecordedUnscoped();
  });

  it("the capability triage a run bills through the direct-call ledger is debited before the nodes are carved", async () => {
    const { runBudget, nodes, triage } = await runSupervisor({ triage: true });
    const calls = triage.chat.mock.calls.length;
    const cost = (toBudgetUsage(PLAN_USAGE, "claude", undefined).costUsd ?? 0) + calls * (toBudgetUsage(TRIAGE_USAGE, "claude", undefined).costUsd ?? 0);

    expect(calls, "the matcher never asked its triage model").toBeGreaterThanOrEqual(1);
    expect(runBudget.spentOutputTokens(), "the triage call's output tokens never reached the supervisor's run budget").toBe(40_000 + calls * 150);
    expect(runBudget.inputTokensSeen(), "the triage call's input tokens never reached the supervisor's run budget").toBe(200_000 + calls * 1_200);
    expect(nodes[0]!.slice?.costUsd, "the first node's slice was carved from a ceiling that never saw the triage").toBeCloseTo(
      DAILY_LIMIT_USD - cost,
      9,
    );
    expectNothingRecordedUnscoped();
  });

  it("admission inside another run's scope spends its own budget, not that run's", async () => {
    const other = createBudget(1_000_000, 1_000);

    const { runBudget } = await withRunBudget(other, () => runSupervisor({ image: true }));

    expect(other.spentOutputTokens(), "the grounding call or the plan was debited from the run admission happened to run in").toBe(0);
    expect(runBudget.spentOutputTokens()).toBe(40_500);
  });

  it("a declined admission keeps its grounding spend out of every run's Budget, the run it ran in included", async () => {
    const other = createBudget(1_000_000, 1_000);

    const { decision, vision } = await withRunBudget(other, () => runSupervisor({ image: true, brainDeclines: true }));

    expect(decision.path).not.toBe("supervisor");
    expect(vision.chat, "admission never grounded the image").toHaveBeenCalledTimes(1);
    expect(other.spentOutputTokens(), "the declined admission's grounding call was debited from another run").toBe(0);
    expectNothingRecordedUnscoped();
  });
});
