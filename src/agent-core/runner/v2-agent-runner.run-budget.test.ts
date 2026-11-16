/**
 * V2AgentRunner — the run's Budget counts EVERY provider call the run makes (task #87).
 *
 * The runner debits each MODEL TURN's tokens into the run's control-plane Budget, but the run's
 * AUXILIARY calls — goal decomposition, reviewer calls (shell review), consensus verification —
 * were recorded only to metrics / the rate limiter / the run's onUsage, never to the Budget. So
 * `spentOutputTokens()` / `remainingOutputTokens()` undercounted and the budget-exhausted verdict
 * was taken on a short count; a delegated child's auxiliary spend never reached its parent either.
 *
 * Drives the REAL V2AgentRunner over the REAL `Orchestrator.createAgentCorePort()` and the REAL
 * `createControlPlane`. The only seam is a scripted provider that gives each KIND of call its own
 * distinctive usage and records every call it serves, so each case asserts exact equalities: the
 * Budget's spend equals what the provider billed, and the auxiliary call really happened first.
 * Time is the injected FakeClock + the `drive` pump (no vi.useFakeTimers).
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { FakeClock } from "../control/clock.js";
import { createControlPlane } from "../control/control-plane.js";
import { createBudget, type Budget } from "../control/budget.js";
import { UNSCOPED_DEBIT_LOG } from "../control/budget-scope.js";
import { V2AgentRunner, type V2RunnerDeps } from "./v2-agent-runner.js";
import type { AgentRunRequest, IOStrategy, RunnerMode } from "./agent-runner.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import { GoalDecomposer } from "../../goals/goal-decomposer.js";
import { ConsensusManager } from "../routing/consensus-manager.js";
import { ConfidenceEstimator } from "../routing/confidence-estimator.js";
import { TaskClassifier } from "../routing/task-classifier.js";

// Logger + strada-knowledge module mocks — the same as the real-port integration test, so the
// Orchestrator boots without a real project / SQLite / network.
const loggerStub = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => loggerStub,
  getLoggerSafe: () => loggerStub,
  getLogRingBuffer: () => [],
}));
vi.mock("../../agents/context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: (p: { projectPath: string }) => ({
    content: `root=${p.projectPath}`,
    contentHashes: [p.projectPath],
    summary: `root=${p.projectPath}`,
    fingerprint: `root ${p.projectPath}`,
  }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

// Import AFTER the mocks are registered.
const { Orchestrator } = await import("../../agents/orchestrator.js");

// ─── The scripted provider: one distinctive usage per KIND of call ───────────────────────────

type CallKind = "model" | "decomposition" | "review" | "consensus";

/** What each kind of call reports; every number differs so a missing one shows in the sum. */
const USAGE: Record<CallKind, { inputTokens: number; outputTokens: number }> = {
  model: { inputTokens: 11, outputTokens: 5 },
  decomposition: { inputTokens: 203, outputTokens: 700 },
  review: { inputTokens: 41, outputTokens: 300 },
  consensus: { inputTokens: 17, outputTokens: 90 },
};
/** A superseded attempt the chain folded into a model reply (ProviderResponse.auxiliaryUsage). */
const SUPERSEDED = { inputTokens: 7, outputTokens: 13 };

interface ScriptedTurn {
  readonly text?: string;
  readonly stopReason?: ProviderResponse["stopReason"];
  readonly toolCalls?: ProviderResponse["toolCalls"];
  readonly auxiliaryUsage?: boolean;
}

interface Served {
  readonly kind: CallKind;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Everything the provider served, and what it billed: the ground truth the Budget is held to. */
class Ledger {
  readonly served: Served[] = [];
  /** Tokens the provider reported through a model reply's auxiliaryUsage (not a call of its own). */
  supersededInput = 0;
  supersededOutput = 0;
  private script: ScriptedTurn[] = [];

  setScript(turns: ScriptedTurn[]): void {
    this.script = [...turns];
  }
  nextTurn(): ScriptedTurn {
    return this.script.shift() ?? { text: "all done", stopReason: "end_turn" };
  }
  count(kind: CallKind): number {
    return this.served.filter((s) => s.kind === kind).length;
  }
  get billedOutput(): number {
    return this.served.reduce((n, s) => n + s.outputTokens, 0) + this.supersededOutput;
  }
  get billedInput(): number {
    return this.served.reduce((n, s) => n + s.inputTokens, 0) + this.supersededInput;
  }
}

const DECOMPOSITION_PLAN = JSON.stringify({
  nodes: [
    { id: "table", task: "Write the calibration table for the north anemometer", dependsOn: [] },
    { id: "check", task: "Add a test that compares the table with the logged readings", dependsOn: ["table"] },
  ],
});
const REVIEW_APPROVAL = JSON.stringify({
  decision: "approve",
  reason: "bounded listing inside the station directory",
  taskAligned: true,
  bounded: true,
});
const CONSENSUS_APPROVAL = JSON.stringify({ approved: true, reasoning: "the reading is bounded and correct" });

function mkProvider(name: string, ledger: Ledger) {
  const chat = vi.fn(async (system: string, messages: unknown[]): Promise<ProviderResponse> => {
    const transcript = JSON.stringify(messages);
    const reply = (kind: CallKind, text: string): ProviderResponse =>
      ({
        text,
        toolCalls: [],
        stopReason: "end_turn",
        usage: { ...USAGE[kind], totalTokens: USAGE[kind].inputTokens + USAGE[kind].outputTokens },
      }) as ProviderResponse;
    let kind: CallKind;
    let response: ProviderResponse;
    if (system.includes("shell safety arbiter")) {
      kind = "review";
      response = reply(kind, REVIEW_APPROVAL);
    } else if (system.includes("code review agent")) {
      kind = "consensus";
      response = reply(kind, CONSENSUS_APPROVAL);
    } else if (transcript.includes("ecompose this")) {
      kind = "decomposition";
      response = reply(kind, DECOMPOSITION_PLAN);
    } else {
      kind = "model";
      const turn = ledger.nextTurn();
      response = {
        ...reply(kind, turn.text ?? ""),
        toolCalls: turn.toolCalls ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        ...(turn.auxiliaryUsage
          ? {
              auxiliaryUsage: {
                ...SUPERSEDED,
                totalTokens: SUPERSEDED.inputTokens + SUPERSEDED.outputTokens,
              },
            }
          : {}),
      } as ProviderResponse;
      if (turn.auxiliaryUsage) {
        ledger.supersededInput += SUPERSEDED.inputTokens;
        ledger.supersededOutput += SUPERSEDED.outputTokens;
      }
    }
    ledger.served.push({ kind, ...USAGE[kind] });
    return response;
  });
  return {
    name,
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat, // NO chatStream → the frozen silentStream and streamOrChatText fall through to chat
  };
}

// ─── The harness: real Orchestrator + real control plane, the Budget captured at openRun ─────

function mkTool(name: string, isWrite: boolean) {
  return {
    name,
    description: `Mock ${name}`,
    inputSchema: { type: "object", properties: {} },
    isWrite,
    execute: vi.fn().mockResolvedValue({ content: `${name} result` }),
  };
}

function mkIO(mode: RunnerMode): IOStrategy {
  return { mode, onEvent: vi.fn(), deliverFinal: vi.fn(), externalSignal: new AbortController().signal } as IOStrategy;
}

function mkRequest(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return { prompt: "do the thing", chatId: "chat-budget", channelType: "web", ...over };
}

/** Pump microtasks + advance the FakeClock until the run settles. */
async function drive<T>(clock: FakeClock, runPromise: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = runPromise.then(
    (v) => {
      settled = true;
      return v;
    },
    (e) => {
      settled = true;
      throw e;
    },
  );
  for (let i = 0; i < 5000 && !settled; i++) {
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(5000);
  }
  return wrapped;
}

interface HarnessOptions {
  readonly goalDecomposer?: boolean;
  /** A second seat plus a real ConsensusManager that reviews every tool turn ("always" mode). */
  readonly consensus?: boolean;
}

function buildHarness(opts: HarnessOptions = {}) {
  const ledger = new Ledger();
  const clock = new FakeClock(0);
  const provider = mkProvider("mock", ledger);
  const reviewerSeat = mkProvider("review-seat", ledger);
  const tools = [mkTool("file_read", false), mkTool("shell_exec", true)];
  const seats = [provider, reviewerSeat];
  const providerManager = {
    getProvider: vi.fn(() => provider),
    getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
    shutdown: vi.fn(),
    // Consensus needs a second, routable seat to review from (the resolver reads these).
    listAvailable: () => seats.map((s) => ({ name: s.name, label: s.name, defaultModel: "mock-model" })),
    listRoutable: () => seats.map((s) => ({ name: s.name, label: s.name, defaultModel: "mock-model" })),
    getPrimaryProviderByName: (n: string) => seats.find((s) => s.name === n) ?? null,
    getProviderByName: (n: string) => seats.find((s) => s.name === n) ?? null,
    isAvailable: () => true,
  };
  const orch = new Orchestrator({
    providerManager,
    tools,
    channel: {
      name: "mock",
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendVisibleAssistantMarkdown: vi.fn().mockResolvedValue(undefined),
      sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
      requestConfirmation: vi.fn().mockResolvedValue("Yes"),
      isHealthy: vi.fn().mockReturnValue(true),
    },
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    agentCoreClock: clock,
    ...(opts.goalDecomposer
      ? { goalDecomposer: new GoalDecomposer(provider as never, 3, [0], { streamingEnabled: false }) }
      : {}),
    ...(opts.consensus
      ? {
          consensusManager: new ConsensusManager({ mode: "always" }),
          confidenceEstimator: new ConfidenceEstimator(),
          providerRouter: { recordExecutionTrace: vi.fn(), recordPhaseOutcome: vi.fn() },
        }
      : {}),
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);

  const { port, gateway, seed, createHealthCore } = orch.createAgentCorePort();
  const plane = createControlPlane({ clock, seed, createHealthCore });
  // Observe the run's Budget: the plane hands the runner exactly one per run.
  const budgets: Budget[] = [];
  const openRun = plane.openRun.bind(plane);
  plane.openRun = (...args) => {
    const opened = openRun(...args);
    budgets.push(opened.budget);
    return opened;
  };
  const runner = new V2AgentRunner({ controlPlane: plane, gateway, orchestratorPort: port, clock } as V2RunnerDeps);
  return { clock, ledger, runner, tools, budgets, provider };
}

/** A prompt long enough (>= 60 chars) for the decomposer's pre-filter. */
const LONG_PROMPT =
  "Write a calibration table for the north anemometer and add a test that compares it with the logged readings";

/** The planning turn that precedes proactive decomposition, then an end-turn reply. */
const PLAN_THEN_DONE: ScriptedTurn[] = [
  { text: "here is the plan", stopReason: "end_turn" },
  { text: "all done", stopReason: "end_turn" },
];

/**
 * A real TaskClassifier never rates a PROMPT "critical" (only a destructive tool call is), and
 * both consensus call sites read the prompt's rating, so a run never reaches consensus on its
 * own. Rate the prompts naming the "pier 4 gauge" critical (type "analysis", a read-only task the
 * end-turn verifier does not ask a mutation of) and the real ConsensusManager runs; everything
 * after that decision is the real path.
 */
function rateGaugePromptsCritical(): void {
  const classify = TaskClassifier.prototype.classify;
  vi.spyOn(TaskClassifier.prototype, "classify").mockImplementation(function (this: TaskClassifier, prompt: string) {
    return prompt.includes("pier 4 gauge")
      ? { type: "analysis", complexity: "moderate", criticality: "critical" }
      : classify.call(this, prompt);
  });
}

/** The turns of a run that reads one file, then answers. */
const PLAN_READ_DONE: ScriptedTurn[] = [
  { text: "here is the plan", stopReason: "end_turn" },
  {
    text: "",
    stopReason: "tool_use",
    toolCalls: [{ id: "tc-read", name: "file_read", input: { path: "gauges.txt" } }],
  },
  { text: "all done", stopReason: "end_turn" },
];
const GAUGE_PROMPT = "Explain what the pier 4 gauge has been reading since Monday";

describe("V2AgentRunner — every provider call a run makes is debited from its Budget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // The runtime half of the funnel tripwire: nothing the run recorded was out of a Budget's scope.
    const unscoped = loggerStub.warn.mock.calls.filter(([message]) => message === UNSCOPED_DEBIT_LOG);
    loggerStub.warn.mockClear();
    expect(unscoped, "a call the run made was recorded with no run's Budget in scope").toEqual([]);
  });

  it("a goal decomposition's reply counts against the run's output-token spend", async () => {
    const h = buildHarness({ goalDecomposer: true });
    h.ledger.setScript(PLAN_THEN_DONE);

    const result = await drive(h.clock, h.runner.run(mkRequest({ prompt: LONG_PROMPT }), mkIO("worker")));

    expect(result.status, `run ended ${result.status}: ${String(result.reason)}`).toBe("completed");
    expect(h.ledger.count("decomposition"), "the planning turn never reached the decomposer").toBeGreaterThanOrEqual(1);
    expect(h.ledger.count("model")).toBeGreaterThanOrEqual(2);
    const budget = h.budgets[0]!;
    expect(
      budget.spentOutputTokens(),
      `the decomposition call's ${USAGE.decomposition.outputTokens} output tokens never reached the run's Budget`,
    ).toBe(h.ledger.billedOutput);
    expect(budget.spentOutputTokens()).toBeGreaterThanOrEqual(
      h.ledger.count("model") * USAGE.model.outputTokens + USAGE.decomposition.outputTokens,
    );
    expect(budget.inputTokensSeen(), "the decomposition call's input tokens never reached the run's Budget").toBe(
      h.ledger.billedInput,
    );
  });

  it("a reviewer's call on a shell command counts against the run's output-token spend", async () => {
    const h = buildHarness();
    h.ledger.setScript([
      { text: "here is the plan", stopReason: "end_turn" },
      {
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "tc-shell", name: "shell_exec", input: { command: "ls station-notes" } }],
      },
      { text: "all done", stopReason: "end_turn" },
    ]);

    const result = await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));

    expect(result.status, `run ended ${result.status}: ${String(result.reason)}`).toBe("completed");
    expect(h.ledger.count("review"), "the shell command never went to the reviewer").toBeGreaterThanOrEqual(1);
    const budget = h.budgets[0]!;
    expect(
      budget.spentOutputTokens(),
      `the reviewer's ${USAGE.review.outputTokens} output tokens never reached the run's Budget`,
    ).toBe(h.ledger.billedOutput);
    expect(budget.inputTokensSeen(), "the reviewer's input tokens never reached the run's Budget").toBe(
      h.ledger.billedInput,
    );
  });

  it("a consensus verification's calls count against the run's output-token spend", async () => {
    rateGaugePromptsCritical();
    const h = buildHarness({ consensus: true });
    h.ledger.setScript(PLAN_READ_DONE);

    const result = await drive(
      h.clock,
      h.runner.run(mkRequest({ prompt: GAUGE_PROMPT }), mkIO("worker")),
    );

    expect(result.status, `run ended ${result.status}: ${String(result.reason)}`).toBe("completed");
    expect(h.ledger.count("consensus"), "no consensus reviewer call was made").toBeGreaterThanOrEqual(1);
    const budget = h.budgets[0]!;
    expect(
      budget.spentOutputTokens(),
      `the consensus reviewer's ${USAGE.consensus.outputTokens} output tokens never reached the run's Budget`,
    ).toBe(h.ledger.billedOutput);
    expect(budget.inputTokensSeen(), "the consensus reviewer's input tokens never reached the run's Budget").toBe(
      h.ledger.billedInput,
    );
  });

  it("a model turn's auxiliaryUsage and an auxiliary call are each debited exactly once", async () => {
    const h = buildHarness({ goalDecomposer: true });
    h.ledger.setScript([
      { text: "here is the plan", stopReason: "end_turn", auxiliaryUsage: true },
      { text: "all done", stopReason: "end_turn" },
    ]);

    const result = await drive(h.clock, h.runner.run(mkRequest({ prompt: LONG_PROMPT }), mkIO("worker")));

    expect(result.status, `run ended ${result.status}: ${String(result.reason)}`).toBe("completed");
    expect(h.ledger.supersededOutput, "the scripted superseded attempt was never served").toBe(SUPERSEDED.outputTokens);
    expect(h.ledger.count("decomposition"), "the planning turn never reached the decomposer").toBeGreaterThanOrEqual(1);
    const budget = h.budgets[0]!;
    const expectedOutput =
      h.ledger.count("model") * USAGE.model.outputTokens +
      SUPERSEDED.outputTokens +
      h.ledger.count("decomposition") * USAGE.decomposition.outputTokens;
    expect(expectedOutput, "the ledger and the hand-built sum disagree").toBe(h.ledger.billedOutput);
    expect(
      budget.spentOutputTokens(),
      "a reply was counted twice or not at all: model turns + auxiliaryUsage + decomposition, once each",
    ).toBe(expectedOutput);
    expect(budget.inputTokensSeen(), "input tokens were counted twice or not at all").toBe(h.ledger.billedInput);
  });

  it("on an interactive run the finite output-token cap shrinks by the consensus spend too", async () => {
    rateGaugePromptsCritical();
    const h = buildHarness({ consensus: true });
    h.ledger.setScript(PLAN_READ_DONE);

    const result = await drive(h.clock, h.runner.run(mkRequest({ prompt: GAUGE_PROMPT }), mkIO("interactive")));

    expect(result.status, `run ended ${result.status}: ${String(result.reason)}`).toBe("completed");
    expect(h.ledger.count("consensus"), "no consensus reviewer call was made").toBeGreaterThanOrEqual(1);
    const budget = h.budgets[0]!;
    expect(Number.isFinite(budget.outputTokenCap()), "an interactive run must carry a finite output-token cap").toBe(true);
    expect(
      budget.remainingOutputTokens(),
      "the cap did not shrink by the consensus reviewer's output tokens: the exhausted verdict reads a short count",
    ).toBe(budget.outputTokenCap() - h.ledger.billedOutput);
    expect(budget.spentOutputTokens()).toBe(h.ledger.billedOutput);
  });

  it("a delegated run's decomposition reaches the parent Budget through the child's debits", async () => {
    const h = buildHarness({ goalDecomposer: true });
    h.ledger.setScript(PLAN_THEN_DONE);
    const parent = createBudget(1_000_000, 1_000);

    const result = await drive(
      h.clock,
      h.runner.run(
        mkRequest({
          prompt: LONG_PROMPT,
          childBudget: { slice: { outputTokens: 100_000, costUsd: 100 }, parent },
        }),
        mkIO("supervisor-node"),
      ),
    );

    expect(result.status, `run ended ${result.status}: ${String(result.reason)}`).toBe("completed");
    expect(h.ledger.count("decomposition"), "the delegated run never decomposed its task").toBeGreaterThanOrEqual(1);
    const child = h.budgets[0]!;
    expect(
      child.spentOutputTokens(),
      `the decomposition call's ${USAGE.decomposition.outputTokens} output tokens never reached the child's Budget`,
    ).toBe(h.ledger.billedOutput);
    expect(
      parent.spentOutputTokens(),
      "the child's full spend, decomposition included, never reached the parent's Budget",
    ).toBe(h.ledger.billedOutput);
    expect(parent.inputTokensSeen(), "the child's input tokens never reached the parent's Budget").toBe(
      h.ledger.billedInput,
    );
  });
});
