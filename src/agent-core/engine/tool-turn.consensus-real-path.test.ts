/**
 * The tool turn's consensus step, on the real path, with the real classifier (task #91).
 *
 * The step used to classify the run's PROMPT, and TaskClassifier.classify rates no prompt
 * critical, so no tool turn ever reached the ConsensusManager — in any mode, "always" included.
 * The only test that reached it wrapped the classifier. A tool turn is now classified by the calls
 * that ran (TaskClassifier.classifyToolCall): a destructive call is reviewed by a second seat when
 * the owner turned consensus on by name ("always", "critical-only"). The default ("auto") and
 * "disabled" make exactly the calls a run made before.
 *
 * Drives the REAL V2AgentRunner over the REAL `Orchestrator.createAgentCorePort()`, the REAL
 * control plane, a REAL ConsensusManager, ConfidenceEstimator and the Orchestrator's own
 * TaskClassifier, unwrapped. The only seam is a scripted provider that tells each kind of call by
 * its system prompt and records what it was asked. Time is the injected FakeClock + `drive`.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { FakeClock } from "../control/clock.js";
import { createControlPlane } from "../control/control-plane.js";
import { V2AgentRunner, type V2RunnerDeps } from "../runner/v2-agent-runner.js";
import type { AgentRunRequest, IOStrategy } from "../runner/agent-runner.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import type { WorkerUsageEvent } from "../../tasks/types.js";
import { ConsensusManager, type ConsensusConfig } from "../routing/consensus-manager.js";
import { ConfidenceEstimator } from "../routing/confidence-estimator.js";
import { TaskClassifier } from "../routing/task-classifier.js";

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

const { Orchestrator } = await import("../../agents/orchestrator.js");

// ─── The scripted provider ───────────────────────────────────────────────────────────────────

type CallKind = "model" | "shell-review" | "consensus";

const USAGE: Record<CallKind, { inputTokens: number; outputTokens: number }> = {
  model: { inputTokens: 11, outputTokens: 5 },
  "shell-review": { inputTokens: 41, outputTokens: 30 },
  consensus: { inputTokens: 17, outputTokens: 90 },
};

interface ScriptedTurn {
  readonly text?: string;
  readonly stopReason?: ProviderResponse["stopReason"];
  readonly toolCalls?: ProviderResponse["toolCalls"];
}

class Ledger {
  readonly served: CallKind[] = [];
  /** What each consensus reviewer call was asked: the user message ConsensusManager built. */
  readonly consensusPrompts: string[] = [];
  private script: ScriptedTurn[] = [];
  setScript(turns: ScriptedTurn[]): void {
    this.script = [...turns];
  }
  nextTurn(): ScriptedTurn {
    return this.script.shift() ?? { text: "all done", stopReason: "end_turn" };
  }
  count(kind: CallKind): number {
    return this.served.filter((k) => k === kind).length;
  }
}

const SHELL_APPROVAL = JSON.stringify({ decision: "approve", reason: "bounded listing", taskAligned: true, bounded: true });
const CONSENSUS_APPROVAL = JSON.stringify({ approved: true, reasoning: "the listing is bounded and correct" });

function mkProvider(name: string, ledger: Ledger) {
  const chat = vi.fn(async (system: string, messages: unknown[]): Promise<ProviderResponse> => {
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
      kind = "shell-review";
      response = reply(kind, SHELL_APPROVAL);
    } else if (system.includes("code review agent")) {
      kind = "consensus";
      ledger.consensusPrompts.push(JSON.stringify(messages));
      response = reply(kind, CONSENSUS_APPROVAL);
    } else {
      kind = "model";
      const turn = ledger.nextTurn();
      response = {
        ...reply(kind, turn.text ?? ""),
        toolCalls: turn.toolCalls ?? [],
        stopReason: turn.stopReason ?? "end_turn",
      } as ProviderResponse;
    }
    ledger.served.push(kind);
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
    chat,
  };
}

// ─── The harness ─────────────────────────────────────────────────────────────────────────────

function mkTool(name: string, isWrite: boolean) {
  return {
    name,
    description: `Mock ${name}`,
    inputSchema: { type: "object", properties: {} },
    isWrite,
    execute: vi.fn().mockResolvedValue({ content: `${name} result` }),
  };
}

function mkIO(): IOStrategy {
  return { mode: "worker", onEvent: vi.fn(), deliverFinal: vi.fn(), externalSignal: new AbortController().signal } as IOStrategy;
}

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

/** `undefined`: no ConsensusManager at all, the run as it is built without one. */
function buildHarness(mode: ConsensusConfig["mode"] | undefined) {
  const ledger = new Ledger();
  const clock = new FakeClock(0);
  const provider = mkProvider("mock", ledger);
  const reviewerSeat = mkProvider("review-seat", ledger);
  const seats = [provider, reviewerSeat];
  const providerManager = {
    getProvider: vi.fn(() => provider),
    getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
    shutdown: vi.fn(),
    listAvailable: () => seats.map((s) => ({ name: s.name, label: s.name, defaultModel: "mock-model" })),
    listRoutable: () => seats.map((s) => ({ name: s.name, label: s.name, defaultModel: "mock-model" })),
    getPrimaryProviderByName: (n: string) => seats.find((s) => s.name === n) ?? null,
    getProviderByName: (n: string) => seats.find((s) => s.name === n) ?? null,
    isAvailable: () => true,
  };
  const orch = new Orchestrator({
    providerManager,
    tools: [mkTool("file_read", false), mkTool("file_write", true), mkTool("shell_exec", true)],
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
    ...(mode === undefined
      ? {}
      : {
          consensusManager: new ConsensusManager({ mode }),
          confidenceEstimator: new ConfidenceEstimator(),
          providerRouter: { recordExecutionTrace: vi.fn(), recordPhaseOutcome: vi.fn() },
        }),
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
  const { port, gateway, seed, createHealthCore } = orch.createAgentCorePort();
  const plane = createControlPlane({ clock, seed, createHealthCore });
  const runner = new V2AgentRunner({ controlPlane: plane, gateway, orchestratorPort: port, clock } as V2RunnerDeps);
  return { clock, ledger, runner };
}

const PROMPT = "List the tide gauge exports in the station folder";

const shell = (id: string, path: string) => ({ id, name: "shell_exec", input: { command: `ls ${path}` } });

/** Plan, then two shell turns, then the answer. */
const TWO_SHELL_TURNS: ScriptedTurn[] = [
  { text: "here is the plan", stopReason: "end_turn" },
  { text: "", stopReason: "tool_use", toolCalls: [shell("tc-shell-1", "tide-logs")] },
  { text: "", stopReason: "tool_use", toolCalls: [shell("tc-shell-2", "tide-exports")] },
  { text: "all done", stopReason: "end_turn" },
];

async function runScript(mode: ConsensusConfig["mode"] | undefined, script: ScriptedTurn[]) {
  const h = buildHarness(mode);
  h.ledger.setScript(script);
  const usage: WorkerUsageEvent[] = [];
  const request: AgentRunRequest = { prompt: PROMPT, chatId: "chat-consensus", channelType: "web", onUsage: (u) => usage.push(u) };
  const result = await drive(h.clock, h.runner.run(request, mkIO()));
  expect(result.status, `run ended ${result.status}: ${String(result.reason)}`).toBe("completed");
  return { ledger: h.ledger, usage };
}

describe("the tool turn's consensus step on the real path (classifier unwrapped)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the classifier the run uses is the real one: nothing here wraps it", () => {
    expect(vi.isMockFunction(TaskClassifier.prototype.classify)).toBe(false);
    expect(vi.isMockFunction(TaskClassifier.prototype.classifyToolCall)).toBe(false);
  });

  it("'always': each destructive tool turn is reviewed by the second seat, as the call it was", async () => {
    const { ledger, usage } = await runScript("always", TWO_SHELL_TURNS);

    expect(ledger.count("shell-review"), "the shell commands never ran").toBe(2);
    expect(ledger.count("consensus"), "a destructive tool turn never reached the ConsensusManager").toBe(2);
    expect(ledger.consensusPrompts[0]).toContain("Task type: destructive-operation, Criticality: critical");
    expect(ledger.consensusPrompts[0]).toContain("shell_exec(");
    expect(ledger.consensusPrompts[0]).toContain(PROMPT);
    // Billed through the run's usage funnel (consensusUsageSink -> recordProviderUsage), once per call.
    const reviewerSpend = usage.filter(
      (u) => u.inputTokens === USAGE.consensus.inputTokens && u.outputTokens === USAGE.consensus.outputTokens,
    );
    expect(reviewerSpend, "the reviewer's calls never reached the run's usage sink").toHaveLength(2);
  });

  it("'critical-only': a low-confidence destructive turn is reviewed", async () => {
    // A tool turn with no text scores below the 0.5 threshold (ConfidenceEstimator: base 0.7,
    // -0.15 for a response under 10 characters, and the call's complexity over the seat's tier).
    const { ledger } = await runScript("critical-only", TWO_SHELL_TURNS);

    expect(ledger.count("consensus"), "a low-confidence destructive turn was not reviewed").toBe(2);
  });

  it("'always': a tool turn with no destructive call makes no reviewer call", async () => {
    const { ledger } = await runScript("always", [
      { text: "here is the plan", stopReason: "end_turn" },
      { text: "", stopReason: "tool_use", toolCalls: [{ id: "tc-read", name: "file_read", input: { path: "gauges.txt" } }] },
      {
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "tc-write", name: "file_write", input: { path: "notes/gauges.md", content: "a, b" } }],
      },
      { text: "all done", stopReason: "end_turn" },
    ]);

    expect(ledger.count("model")).toBeGreaterThanOrEqual(4);
    expect(ledger.count("consensus")).toBe(0);
  });

  it("'always': a turn whose destructive call is not its first is reviewed once, with every call", async () => {
    const { ledger } = await runScript("always", [
      { text: "here is the plan", stopReason: "end_turn" },
      {
        text: "",
        stopReason: "tool_use",
        toolCalls: [
          { id: "tc-write", name: "file_write", input: { path: "notes/gauges.md", content: "a, b" } },
          shell("tc-shell", "tide-logs"),
        ],
      },
      { text: "all done", stopReason: "end_turn" },
    ]);

    expect(ledger.count("consensus")).toBe(1);
    expect(ledger.consensusPrompts[0]).toContain("file_write(");
    expect(ledger.consensusPrompts[0]).toContain("shell_exec(");
  });

  it("the default ('auto') and 'disabled' make exactly the calls a run without consensus makes", async () => {
    const without = await runScript(undefined, TWO_SHELL_TURNS);
    const auto = await runScript("auto", TWO_SHELL_TURNS);
    const disabled = await runScript("disabled", TWO_SHELL_TURNS);

    expect(without.ledger.count("shell-review"), "the shell commands never ran").toBe(2);
    expect(auto.ledger.served, "the default mode changed the run's provider calls").toEqual(without.ledger.served);
    expect(disabled.ledger.served).toEqual(without.ledger.served);
    expect(auto.ledger.count("consensus")).toBe(0);
    expect(auto.usage).toEqual(without.usage);
  });
});
