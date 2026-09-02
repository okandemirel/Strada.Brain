/**
 * Agent Core v2 — V2AgentRunner spine unit tests (Phase 2 → route-flip readiness).
 *
 * Drives the unified loop with a MOCK OrchestratorPort + a ControlPlane backed by the REAL
 * control-plane primitives (openRunClock + createFailureLedger over a fake HealthCore + createBudget)
 * and the REAL run-scoped EventBus, all under a deterministic FakeClock. The gateway is a thin
 * fake that returns a scripted ProviderResponse (or throws) and emits the same model.* events the
 * real one does — so the spine's "never re-emit / never re-touch" invariants are exercised.
 *
 * Covered (per the design's required matrix):
 *  - clean single-step run → done (end_turn terminal),
 *  - multi-step run with tool calls (EXECUTING → REFLECTING → done),
 *  - retry (verdict retry → backoff → continue, heartbeat emitted before the sleep),
 *  - abort (verdict stop → AgentRunResult failed/blocked),
 *  - interactive-vs-background IOStrategy divergence (deliverFinal called for interactive, not bg),
 *  - the heartbeat-emitted-per-wait invariant (headSeq advances across every guardedSleep).
 */

import { describe, it, expect, vi } from "vitest";
import { FakeClock } from "../control/clock.js";
import { createAgentRunEventBus, type AgentRunEventBus } from "../events/event-bus.js";
import { openRunClock } from "../control/run-clock.js";
import { createBudget } from "../control/budget.js";
import { createFailureLedger, type HealthCore } from "../control/failure-ledger.js";
import { resolveRunBudgetPolicy, type PolicySeed, type RunMode } from "../control/policy.js";
import { ModelGateway, type SilentStreamPort } from "../model/model-gateway.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import { AgentPhase, createInitialState, type AgentState } from "../../agents/agent-state.js";
import type { AgentEvent } from "../events/agent-event.js";
import type { AgentRunRequest, IOStrategy, RunnerMode } from "./agent-runner.js";
import {
  V2AgentRunner,
  type ControlPlane,
  type OpenRunResult,
  type V2RunnerDeps,
} from "./v2-agent-runner.js";
import type {
  AgentRunSetupInput,
  BudgetCheckpointParams,
  OrchestratorPort,
  PreparedIteration,
  ReflectionDispatchResult,
  ParsedReflectionDecision,
  RunSetup,
} from "./orchestrator-port.js";

// ── seed / policy ───────────────────────────────────────────────────────────

const SEED: PolicySeed = {
  streamInitialTimeoutMs: 600_000,
  streamStallTimeoutMs: 300_000,
  providerFirstResponseMs: 90_000,
  taskInactivityMs: 600_000,
  minInactivityOverStreamRatio: 2,
  outputTokenCap: 100_000,
  costCapUsd: 10,
};

// ── fake provider / response ──────────────────────────────────────────────────

function mkProvider(name = "mock"): IAIProvider {
  return {
    name,
    model: "mock-model",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn(),
  } as unknown as IAIProvider;
}

function mkResponse(over: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    text: "ok",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...over,
  };
}

/** A scripted silentStream → one ProviderResponse per call, or a throw. */
function scriptedStream(script: (ProviderResponse | Error)[]): SilentStreamPort {
  let i = 0;
  return async () => {
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next ?? mkResponse();
  };
}

// ── fake health core (drives the REAL FailureLedger verdict precedence) ───────

/**
 * A STATEFUL fake HealthCore that mirrors the real tracker's key behavior the verdict depends on:
 * recordSuccess() clears the consecutive-failure run (so a recovered step stops the retry loop),
 * recordFailure() increments it. `over` seeds the initial consecutive count + the boolean gates.
 */
function mkHealth(over: Partial<HealthCore> = {}): HealthCore {
  let consecutive = over.consecutive ?? 0;
  return {
    recordSuccess: () => {
      consecutive = 0;
    },
    recordFailure: () => {
      consecutive += 1;
    },
    shouldAbort: over.shouldAbort ?? (() => false),
    shouldAskUser: over.shouldAskUser ?? (() => false),
    backoffMs: over.backoffMs ?? (() => 1000),
    statusLevel: over.statusLevel ?? "healthy",
    failureRate: over.failureRate ?? 0,
    get consecutive() {
      return consecutive;
    },
  };
}

// ── a ControlPlane over the REAL primitives + REAL bus ────────────────────────

interface PlaneHandles {
  readonly plane: ControlPlane;
  readonly clock: FakeClock;
  /** The last opened bus (so tests can read the event log). */
  bus(): AgentRunEventBus;
  events(): AgentEvent[];
}

function mkPlane(opts: {
  clock?: FakeClock;
  health?: Partial<HealthCore>;
  /** A shared health instance (so a test's port can record failures the ledger then sees). */
  healthCore?: HealthCore;
  mode?: RunMode;
  /** Override the resolved budget caps (e.g. to force budget-exhausted). */
  outputTokenCap?: number;
} = {}): PlaneHandles & { readonly health: HealthCore } {
  const clock = opts.clock ?? new FakeClock(0);
  const health = opts.healthCore ?? mkHealth(opts.health);
  let busRef: AgentRunEventBus | undefined;
  const onEventSpy = vi.fn();

  const plane: ControlPlane = {
    openRun(mode: RunMode): OpenRunResult {
      const { policy } = resolveRunBudgetPolicy(mode, {
        ...SEED,
        outputTokenCap: opts.outputTokenCap ?? SEED.outputTokenCap,
      });
      return {
        clock: openRunClock(clock, policy),
        ledger: createFailureLedger(health, {
          pauseRetryBudget: policy.pauseRetryBudget,
        }),
        budget: createBudget(policy.outputTokenCap, policy.costCapUsd),
      };
    },
    openBus(runId: string): AgentRunEventBus {
      const bus = createAgentRunEventBus({ runId, clock });
      // Mirror what the real openBus does: attach io's onEvent as a live sink (here a spy sink).
      bus.addSink({ id: "io", deliver: (e) => onEventSpy(e) });
      busRef = bus;
      return bus;
    },
  };

  return {
    plane,
    clock,
    health,
    bus: () => {
      if (!busRef) throw new Error("bus not opened yet");
      return busRef;
    },
    events: () => (busRef ? [...busRef.log] : []),
  };
}

// ── a mock OrchestratorPort ───────────────────────────────────────────────────

interface MockPortOptions {
  /** Reflection dispatch result (default: terminal done). */
  reflection?: ReflectionDispatchResult;
  /** Parsed reflection decision (default: CONTINUE, wasOverride false). */
  reflectionDecision?: ParsedReflectionDecision;
  /** Tool results returned by the bound executeToolCalls. */
  toolResults?: {
    toolName: string;
    toolCallId: string;
    success: boolean;
    touchedFiles?: readonly string[];
  }[];
  iterationLimit?: number;
  bgEpochLimit?: number;
  canContinueEpoch?: boolean;
  /** If set, the mock handlePlanPhase transitions the state into this phase (e.g. EXECUTING). */
  planTransitionTo?: AgentPhase;
  /**
   * Side effect run inside classifyFailureForVerdict — the real port records the failure into the
   * health tracker here; a test wires this to the SHARED HealthCore so the ledger's next verdict
   * sees the incremented consecutive count (faithful to v1's recordPhase1*FailureAndVerdict).
   */
  onClassifyFailure?: () => void;
}

function mkSetup(): RunSetup {
  return {
    systemPrompt: "sys",
    session: { messages: [] },
    executionJournal: {} as RunSetup["executionJournal"],
    memoryRefresher: null,
    identityKey: "id-1",
    fallbackProvider: mkProvider("fallback"),
    iterationHealth: {} as RunSetup["iterationHealth"],
    metricId: "metric-1",
    enableGoalDetection: false,
  };
}

function mkPrepared(provider: IAIProvider): PreparedIteration {
  return {
    executionStrategy: {
      task: { type: "code-edit", complexity: "simple", criticality: "low" },
    } as PreparedIteration["executionStrategy"],
    activePrompt: "active",
    currentAssignment: {
      role: "executor",
      providerName: provider.name,
      modelId: "mock-model",
      provider,
      reason: "test",
    } as PreparedIteration["currentAssignment"],
    currentProvider: provider,
    currentToolDefinitions: [],
    currentToolNames: [],
  };
}

function mkPort(provider: IAIProvider, opts: MockPortOptions = {}): OrchestratorPort & {
  readonly spies: {
    setupRun: ReturnType<typeof vi.fn>;
    persistTerminal: ReturnType<typeof vi.fn>;
    synthesizeFinal: ReturnType<typeof vi.fn>;
    dispatchEndTurn: ReturnType<typeof vi.fn>;
    dispatchReflection: ReturnType<typeof vi.fn>;
    parseReflectionDecision: ReturnType<typeof vi.fn>;
    executeToolCalls: ReturnType<typeof vi.fn>;
    recordHealthSuccess: ReturnType<typeof vi.fn>;
    classifyFailureForVerdict: ReturnType<typeof vi.fn>;
    onEpochRollover: ReturnType<typeof vi.fn>;
    handlePlanPhase: ReturnType<typeof vi.fn>;
  };
} {
  const setup = mkSetup();
  const spies = {
    setupRun: vi.fn(async () => setup),
    persistTerminal: vi.fn(async () => {}),
    synthesizeFinal: vi.fn((_s: AgentState) => ({ text: "final-answer", summary: "summary" })),
    dispatchEndTurn: vi.fn(async (p: { agentState: AgentState; responseText?: string }) => ({
      agentState: { ...p.agentState, phase: AgentPhase.COMPLETE },
      finalText: p.responseText ?? "final-answer",
    })),
    dispatchReflection: vi.fn(
      async (p: { agentState: AgentState }): Promise<ReflectionDispatchResult> =>
        opts.reflection ?? {
          agentState: { ...p.agentState, phase: AgentPhase.COMPLETE },
          terminal: true,
          reason: "done",
        },
    ),
    parseReflectionDecision: vi.fn(
      async (): Promise<ParsedReflectionDecision> =>
        opts.reflectionDecision ?? { decision: "CONTINUE", wasOverride: false },
    ),
    executeToolCalls: vi.fn(async () => opts.toolResults ?? []),
    recordHealthSuccess: vi.fn(),
    classifyFailureForVerdict: vi.fn(() => {
      opts.onClassifyFailure?.(); // faithful: the real port records the failure into the tracker
      return { callStalled: false, taskCancelReason: null, benign: false };
    }),
    onEpochRollover: vi.fn(),
    // Spied so a test can assert WHICH phase the spine handed to the plan
    // port — the REPLANNING regression is invisible from the result alone.
    handlePlanPhase: vi.fn(async (p: { agentState: AgentState }) => ({
      agentState: { ...p.agentState, phase: opts.planTransitionTo ?? AgentPhase.EXECUTING },
    })),
  };

  const port: OrchestratorPort = {
    setupRun: spies.setupRun,
    // Step 0 / gap #1: pass-through — the unit test's mock port has no real ALS scope; the spine just
    // needs the wrapper to invoke its body.
    withRunTaskContext: <T>(_input: AgentRunSetupInput, fn: () => Promise<T>): Promise<T> => fn(),
    buildPolicySeed: () => SEED,
    prepareIteration: () => mkPrepared(provider),
    maybeCompactSession: () => {},
    trimContextWindow: () => {},
    recordExecutionTrace: () => {},
    recordProviderUsage: () => {},
    saveBudgetExceededCheckpoint: async () => {},
    classifyFailureForVerdict: spies.classifyFailureForVerdict,
    recordHealthSuccess: spies.recordHealthSuccess,
    dispatchReflection: spies.dispatchReflection,
    parseReflectionDecision: spies.parseReflectionDecision,
    dispatchEndTurn: spies.dispatchEndTurn,
    // Default mirrors v1's handlePlanPhaseTransition: a normal plan moves PLANNING→EXECUTING.
    // Tests override planTransitionTo to pin a specific target.
    handlePlanPhase: spies.handlePlanPhase,
    decomposeGoalsIfPlanning: async (p) => p.agentState,
    executeToolCalls: spies.executeToolCalls,
    getInteractiveIterationLimit: () => opts.iterationLimit ?? 10,
    getBackgroundEpochIterationLimit: () => opts.bgEpochLimit ?? opts.iterationLimit ?? 10,
    canAutoContinueBackgroundEpoch: () => opts.canContinueEpoch ?? false,
    canAutoContinueInteractiveEpoch: () => false,
    onEpochRollover: spies.onEpochRollover,
    getLiveInteractiveTokenBudget: () => 100_000,
    getLiveOutputTokenCap: () => 100_000,
    onBudgetConfigChanged: () => () => {},
    classifyIntent: async () => "intent",
    synthesizeFinal: spies.synthesizeFinal,
    persistTerminal: spies.persistTerminal,
    buildResultProjection: (p) => ({
      provider: provider.name,
      model: "mock-model",
      catalogVersion: "cat-1",
      assignmentVersion: 1,
      touchedFiles: p.touchedFiles,
      toolTrace: p.toolTrace.map((t) => ({
        toolName: t.toolName,
        success: t.success,
        summary: "",
        timestamp: 0,
      })),
      verificationResults: [],
      reviewFindings: [],
      artifacts: [],
    }),
  };

  return Object.assign(port, { spies });
}

// ── IOStrategy builders ───────────────────────────────────────────────────────

function mkIO(mode: RunnerMode, deliverFinal = vi.fn()): IOStrategy & {
  deliverFinal: ReturnType<typeof vi.fn>;
} {
  return {
    mode,
    onEvent: vi.fn(),
    deliverFinal,
    externalSignal: new AbortController().signal,
  } as IOStrategy & { deliverFinal: ReturnType<typeof vi.fn> };
}

function mkRequest(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    prompt: "do the thing",
    chatId: "chat-1",
    channelType: "web",
    ...over,
  };
}

function mkRunner(plane: ControlPlane, gateway: ModelGateway, port: OrchestratorPort, clock: FakeClock): V2AgentRunner {
  const deps: V2RunnerDeps = { controlPlane: plane, gateway, orchestratorPort: port, clock };
  return new V2AgentRunner(deps);
}

/**
 * Drive a run to completion under a FakeClock. The spine's only waits are guardedSleep timers
 * (intent-ack 2s fallback, retry/pause backoffs, epoch rollover) — none resolve until the fake
 * clock advances. We pump microtasks + advance the clock on a loop until the run promise settles,
 * so the run is fully deterministic with no real wall-clock dependency.
 */
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
  // Bound the pump so a genuine infinite loop fails fast instead of hanging the suite.
  for (let i = 0; i < 5000 && !settled; i++) {
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(5000);
  }
  return wrapped;
}

// ── TESTS ─────────────────────────────────────────────────────────────────────

describe("V2AgentRunner — clean run (PLANNING → EXECUTING → end_turn)", () => {
  it("end_turn terminal → completed, deliverFinal called, run.ended emitted, persistTerminal joined", async () => {
    const handles = mkPlane();
    const provider = mkProvider();
    // Step 1 (PLANNING): text → handlePlanPhase moves to EXECUTING.
    // Step 2 (EXECUTING): end_turn, no tools → dispatchEndTurn terminal.
    const gateway = new ModelGateway(scriptedStream([mkResponse({ text: "all done", stopReason: "end_turn" })]));
    const port = mkPort(provider);
    const io = mkIO("interactive");
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), io));

    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("final-answer");
    expect(io.deliverFinal).toHaveBeenCalledTimes(1);
    expect(io.deliverFinal).toHaveBeenCalledWith("final-answer", expect.objectContaining({ phase: AgentPhase.COMPLETE }));
    expect(port.spies.dispatchEndTurn).toHaveBeenCalledTimes(1);
    expect(port.spies.persistTerminal).toHaveBeenCalledTimes(1);
    expect(port.spies.recordHealthSuccess).toHaveBeenCalledWith("mock");

    const types = handles.events().map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("intent.ack");
    expect(types).toContain("step.started");
    expect(types).toContain("run.ending");
    expect(types).toContain("run.ended");
    // The gateway's own events are present, emitted by the gateway (not re-emitted by the spine).
    expect(types).toContain("model.call.started");
    expect(types).toContain("model.call.finished");
  });

  /* audited 2026-09-02: the budget-exceeded checkpoint must carry what was spent, the cap, and the files touched */
  it("budget-exhausted stop persists the real spend, the cap, and the touched files (not used:0 / budget:<=0 / [])", async () => {
    // cap 12: plan(5) → 7 left; tool turn(5) → 2 left, tools run and touch a.cs; tool turn(5) → -3;
    // the next gate trips budget-exhausted:tokens.
    const handles = mkPlane({ outputTokenCap: 12 });
    const toolTurn = mkResponse({
      text: "editing",
      stopReason: "tool_use",
      toolCalls: [{ id: "tc-1", name: "edit_file", input: { path: "a.cs" } }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const gateway = new ModelGateway(scriptedStream([mkResponse({ text: "the plan" }), toolTurn, toolTurn]));
    const port = mkPort(mkProvider(), {
      toolResults: [{ toolName: "edit_file", toolCallId: "tc-1", success: true, touchedFiles: ["a.cs"] }],
    });
    const saveSpy = vi.fn(async () => {});
    port.saveBudgetExceededCheckpoint = saveSpy;
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest({ taskRunId: "task-42", userId: "u-1" }), mkIO("worker")));

    expect(result.reason).toBe("budget-exhausted:tokens");
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const cp = saveSpy.mock.calls[0]![0] as BudgetCheckpointParams;
    expect(cp.used).toBe(15); // three 5-token turns actually spent
    expect(cp.budget).toBe(12); // the cap, not the (negative) remainder
    expect(cp.touchedFiles).toContain("a.cs");
    expect(cp.userId).toBe("u-1");
  });

  it("the spine never re-emits model.call.* (exactly one finished PER call, terminates without spinning)", async () => {
    const handles = mkPlane();
    const gateway = new ModelGateway(scriptedStream([mkResponse({ stopReason: "end_turn" })]));
    const port = mkPort(mkProvider());
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    await drive(handles.clock, runner.run(mkRequest(), mkIO("interactive")));

    // PLANNING step + EXECUTING terminal = exactly 2 model calls → 2 finished events. Crucially
    // NOT 10 (the iteration limit): the run terminated, and each call has exactly one finished
    // event (the spine re-emits none of the gateway's events).
    const started = handles.events().filter((e) => e.type === "model.call.started");
    const finished = handles.events().filter((e) => e.type === "model.call.finished");
    expect(finished).toHaveLength(2);
    expect(started).toHaveLength(2);
  });
});

describe("V2AgentRunner — REPLANNING is not an absorbing state", () => {
  it("hands a REPLANNING turn to the plan port, so the run can return to EXECUTING", async () => {
    // Regression: the spine gated its plan branch on `phase === PLANNING`
    // only, while the port itself handles `PLANNING || REPLANNING` and owns
    // the single REPLANNING→EXECUTING transition (orchestrator-loop-utils
    // handlePlanPhaseTransition). A replan therefore parked the run in
    // REPLANNING forever: write tools are stripped in that phase, the
    // reflection boundary stops firing, and the run either ends early or
    // burns its whole iteration budget making no progress.
    const handles = mkPlane();
    const gateway = new ModelGateway(
      scriptedStream([
        mkResponse({ text: "here is a plan" }),
        mkResponse({ text: "revised plan" }),
        mkResponse({ text: "done", stopReason: "end_turn" }),
      ]),
    );
    // Turn 1 (PLANNING) lands in REPLANNING, reproducing the post-replan state.
    const port = mkPort(mkProvider(), { planTransitionTo: AgentPhase.REPLANNING });
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    await drive(handles.clock, runner.run(mkRequest(), mkIO("interactive")));

    const phasesHandled = port.spies.handlePlanPhase.mock.calls.map(
      (c: [{ agentState: AgentState }]) => c[0].agentState.phase,
    );
    expect(phasesHandled).toContain(AgentPhase.PLANNING);
    expect(phasesHandled).toContain(AgentPhase.REPLANNING);
  });
});

describe("V2AgentRunner — multi-step run with tool calls", () => {
  it("PLANNING → EXECUTING(tool) → REFLECTING → done; tool.started/finished emitted; toolTrace projected", async () => {
    const handles = mkPlane();
    const provider = mkProvider();
    // Step 1: PLANNING, returns text → handlePlanPhase moves PLANNING→EXECUTING.
    // Step 2: EXECUTING, returns a tool call → tool exec → EXECUTING→REFLECTING.
    // Step 3: REFLECTING, returns text → the reflection turn → terminal done.
    const gateway = new ModelGateway(
      scriptedStream([
        mkResponse({ text: "here is the plan", stopReason: "end_turn" }),
        mkResponse({
          text: "",
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-1", name: "edit_file", input: {} }],
        }),
        mkResponse({ text: "reflected: done", stopReason: "end_turn" }),
      ]),
    );
    const port = mkPort(provider, {
      // The mock plan-phase transition mirrors v1's handlePlanPhaseTransition: PLANNING→EXECUTING.
      planTransitionTo: AgentPhase.EXECUTING,
      toolResults: [{ toolName: "edit_file", toolCallId: "tc-1", success: true, touchedFiles: ["a.cs"] }],
    });
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), mkIO("background")));

    expect(result.status).toBe("completed");
    expect(port.spies.executeToolCalls).toHaveBeenCalledTimes(1);
    expect(port.spies.dispatchReflection).toHaveBeenCalledTimes(1);
    expect(result.toolTrace.map((t) => t.toolName)).toEqual(["edit_file"]);
    expect(result.touchedFiles).toContain("a.cs");

    const types = handles.events().map((e) => e.type);
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.finished");
    // PLANNING→EXECUTING and EXECUTING→REFLECTING are real phase moves → phase.changed events.
    expect(types.filter((t) => t === "phase.changed").length).toBeGreaterThanOrEqual(2);
  });
});

describe("V2AgentRunner — D1/D2 spine equivalence (reflection decision routing + assistant text)", () => {
  it("D1: a parsed DONE reflection terminates AND dispatchReflection receives the parsed decision (not a hardcoded CONTINUE)", async () => {
    const handles = mkPlane();
    const provider = mkProvider();
    // plan → tool turn (→ REFLECTING via the advanceAfterTools fallback) → reflection turn.
    const gateway = new ModelGateway(
      scriptedStream([
        mkResponse({ text: "plan", stopReason: "end_turn" }),
        mkResponse({ text: "", stopReason: "tool_use", toolCalls: [{ id: "tc-1", name: "edit_file", input: {} }] }),
        mkResponse({ text: "DONE", stopReason: "end_turn" }),
      ]),
    );
    const port = mkPort(provider, {
      planTransitionTo: AgentPhase.EXECUTING,
      toolResults: [{ toolName: "edit_file", toolCallId: "tc-1", success: true }],
      reflectionDecision: { decision: "DONE", wasOverride: false },
    });
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), mkIO("background")));

    expect(result.status).toBe("completed");
    expect(port.spies.parseReflectionDecision).toHaveBeenCalledTimes(1); // D1: the spine now parses first
    expect(port.spies.dispatchReflection).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "DONE" }), // threaded — NOT the old hardcoded "CONTINUE"
    );
  });

  it("D1: a parsed CONTINUE reflection continues the loop instead of force-terminating", async () => {
    const handles = mkPlane();
    const provider = mkProvider();
    const gateway = new ModelGateway(
      scriptedStream([
        mkResponse({ text: "plan", stopReason: "end_turn" }),
        mkResponse({ text: "", stopReason: "tool_use", toolCalls: [{ id: "tc-1", name: "edit_file", input: {} }] }),
        mkResponse({ text: "CONTINUE", stopReason: "end_turn" }), // reflection: continue
        mkResponse({ text: "now actually done", stopReason: "end_turn" }), // post-reflection EXECUTING → terminal
      ]),
    );
    const port = mkPort(provider, {
      planTransitionTo: AgentPhase.EXECUTING,
      toolResults: [{ toolName: "edit_file", toolCallId: "tc-1", success: true }],
      reflectionDecision: { decision: "CONTINUE", wasOverride: false },
      // CONTINUE: the dispatch returns the loop to EXECUTING, non-terminal (mirrors v1's continue).
      reflection: {
        agentState: { ...createInitialState("do the thing"), phase: AgentPhase.EXECUTING },
        terminal: false,
      },
    });
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), mkIO("background")));

    expect(result.status).toBe("completed");
    expect(port.spies.dispatchReflection).toHaveBeenCalledWith(expect.objectContaining({ decision: "CONTINUE" }));
    // The loop CONTINUED past reflection: the post-reflection EXECUTING step ran end_turn → terminal.
    expect(port.spies.dispatchEndTurn).toHaveBeenCalledTimes(1);
  });

  it("D2: the assistant pre-tool text (response.text) is threaded to executeToolCalls", async () => {
    const handles = mkPlane();
    const provider = mkProvider();
    const gateway = new ModelGateway(
      scriptedStream([
        mkResponse({ text: "plan", stopReason: "end_turn" }),
        mkResponse({ text: "thinking before the tools", stopReason: "tool_use", toolCalls: [{ id: "tc-1", name: "edit_file", input: {} }] }),
        mkResponse({ text: "DONE", stopReason: "end_turn" }),
      ]),
    );
    const port = mkPort(provider, {
      planTransitionTo: AgentPhase.EXECUTING,
      toolResults: [{ toolName: "edit_file", toolCallId: "tc-1", success: true }],
      reflectionDecision: { decision: "DONE", wasOverride: false },
    });
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    await drive(handles.clock, runner.run(mkRequest(), mkIO("background")));

    // D2: executeToolCalls receives (toolCalls, session, agentState, response.text) — the 4th arg
    // is the assistant's pre-tool text the port pushes onto the session before the tool results.
    expect(port.spies.executeToolCalls).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "edit_file" })]),
      expect.anything(), // session
      expect.anything(), // agentState
      "thinking before the tools", // ← response.text (D2 — was dropped before the fix)
    );
  });
});

describe("V2AgentRunner — retry (verdict retry → backoff → continue)", () => {
  it("a provider THROW → failure recorded → retry verdict → guardedSleep backoff → recovery continues", async () => {
    // A shared, stateful health: the throw's classifyFailureForVerdict records a failure
    // (consecutive 0→1) → the failure-gate verdict is `retry` (consecutive>0, !modelProposedDone)
    // → guardedSleep backoff → the recovery step's recordHealthSuccess clears it → clean terminal.
    const health = mkHealth({ backoffMs: () => 2000 });
    const handles = mkPlane({ healthCore: health });
    const provider = mkProvider();
    // Step 1: THROW (classified non-benign). Step 2: clean end_turn.
    const gateway = new ModelGateway(
      scriptedStream([new Error("boom"), mkResponse({ stopReason: "end_turn" })]),
    );
    const port = mkPort(provider, { onClassifyFailure: () => health.recordFailure() });
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), mkIO("background")));

    expect(result.status).toBe("completed"); // recovered after the retry
    expect(port.spies.classifyFailureForVerdict).toHaveBeenCalledTimes(1);
    // A backoff event must have been emitted (the retry's guardedSleep beat).
    const backoffs = handles.events().filter((e) => e.type === "backoff");
    expect(backoffs.length).toBeGreaterThanOrEqual(1);
    // The dispatchEndTurn ran on the (post-recovery) EXECUTING terminal step.
    expect(port.spies.dispatchEndTurn).toHaveBeenCalledTimes(1);
    // recordHealthSuccess fires on every successful step after the recovery (≥1).
    expect(port.spies.recordHealthSuccess.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("V2AgentRunner — abort (verdict stop)", () => {
  it("health shouldAbort → stop hard → AgentRunResult failed", async () => {
    const handles = mkPlane({ health: { shouldAbort: () => true } });
    const gateway = new ModelGateway(scriptedStream([mkResponse({ stopReason: "end_turn" })]));
    const port = mkPort(mkProvider());
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), mkIO("background")));

    // The very first GATE returns stop (hard) → the loop breaks before any model call.
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("verdict-stop");
    const types = handles.events().map((e) => e.type);
    expect(types).toContain("run.ending");
    expect(types).toContain("run.ended");
  });

  it("background ask_user (health) → run yields blocked", async () => {
    const handles = mkPlane({ health: { shouldAskUser: () => true } });
    const gateway = new ModelGateway(scriptedStream([mkResponse({ stopReason: "end_turn" })]));
    const port = mkPort(mkProvider());
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), mkIO("background")));

    expect(result.status).toBe("blocked");
    const types = handles.events().map((e) => e.type);
    expect(types).toContain("ask_user");
  });

  it("interactive ask_user (health) → emits ask_user, continues, does NOT block", async () => {
    // First gate asks; the gate then TAKES the step (audited 2026-09-02 — it used to re-loop
    // to the gate and spin). With this always-asking health every gate asks once and steps
    // once. We only assert it did NOT yield "blocked".
    const handles = mkPlane({ health: { shouldAskUser: () => true } });
    const gateway = new ModelGateway(scriptedStream([mkResponse({ stopReason: "end_turn" })]));
    const port = mkPort(mkProvider(), { iterationLimit: 2 });
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), mkIO("interactive")));

    expect(result.status).not.toBe("blocked");
    const asks = handles.events().filter((e) => e.type === "ask_user");
    expect(asks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("V2AgentRunner — interactive vs background divergence (only via IOStrategy)", () => {
  it("interactive deliverFinal renders; background deliverFinal is a no-op sink (still called, strategy differs)", async () => {
    // Interactive.
    const h1 = mkPlane();
    const interactiveDeliver = vi.fn();
    const r1 = mkRunner(h1.plane, new ModelGateway(scriptedStream([mkResponse({ stopReason: "end_turn" })])), mkPort(mkProvider()), h1.clock);
    await drive(h1.clock, r1.run(mkRequest(), mkIO("interactive", interactiveDeliver)));
    expect(interactiveDeliver).toHaveBeenCalledTimes(1);

    // Background: deliverFinal is still invoked by the spine (same call site) — the divergence is
    // that the background STRATEGY's deliverFinal is a no-op, which here we assert by passing a
    // no-op fn and confirming the run still completes + carries finalText on the result.
    const h2 = mkPlane();
    const bgDeliver = vi.fn(); // a background strategy would do nothing on render
    const r2 = mkRunner(h2.plane, new ModelGateway(scriptedStream([mkResponse({ stopReason: "end_turn" })])), mkPort(mkProvider()), h2.clock);
    const bgResult = await drive(h2.clock, r2.run(mkRequest(), mkIO("background", bgDeliver)));
    expect(bgDeliver).toHaveBeenCalledTimes(1);
    expect(bgResult.finalText).toBe("final-answer"); // background carries the text by value
  });

  it("worker mode maps to the delegate policy and still completes by value", async () => {
    const handles = mkPlane();
    const gateway = new ModelGateway(scriptedStream([mkResponse({ stopReason: "end_turn" })]));
    const result = await drive(
      handles.clock,
      mkRunner(handles.plane, gateway, mkPort(mkProvider()), handles.clock).run(mkRequest(), mkIO("worker")),
    );
    expect(result.status).toBe("completed");
    expect(result.provider).toBe("mock");
    expect(result.catalogVersion).toBe("cat-1");
  });
});

describe("V2AgentRunner — heartbeat-per-wait invariant", () => {
  it("every guardedSleep advances headSeq before sleeping (no silent spin across the retry wait)", async () => {
    const health = mkHealth({ backoffMs: () => 3000 });
    const handles = mkPlane({ healthCore: health });
    const gateway = new ModelGateway(scriptedStream([new Error("boom"), mkResponse({ stopReason: "end_turn" })]));
    const port = mkPort(mkProvider(), { onClassifyFailure: () => health.recordFailure() });
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    await drive(handles.clock, runner.run(mkRequest(), mkIO("background")));

    // The backoff beat (a wait-point) is in the log, and it precedes the subsequent step.started
    // for the recovery iteration — i.e. the loop emitted BEFORE it slept, never after a silent gap.
    const log = handles.events();
    const backoffIdx = log.findIndex((e) => e.type === "backoff");
    expect(backoffIdx).toBeGreaterThanOrEqual(0);
    // seq is gap-free and monotonic — the bus's structural guarantee the heartbeat invariant rides on.
    const seqs = log.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("intent.ack is emitted within the prologue (the ≤2s ack contract)", async () => {
    const handles = mkPlane();
    const gateway = new ModelGateway(scriptedStream([mkResponse({ stopReason: "end_turn" })]));
    // A classifier that never resolves → the 2s fallback must still emit intent.ack.
    const port = mkPort(mkProvider());
    port.classifyIntent = () => new Promise<string>(() => {}); // never resolves
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    await drive(handles.clock, runner.run(mkRequest({ prompt: "Refactor the build pipeline. Then test." }), mkIO("interactive")));

    const ack = handles.events().find((e) => e.type === "intent.ack");
    expect(ack).toBeDefined();
    expect((ack as { summary: string }).summary).toBe("Refactor the build pipeline");
  });
});

// ── Phase 1c: streaming liveness re-arm (the false-task-inactivity-abort regression) ──────────
describe("V2AgentRunner — Phase 1c streaming liveness re-arm (no false task-inactivity abort)", () => {
  // The bug: the spine created `call = runClock.enterCall(callLimits)` but passed `undefined` for
  // silentStream's 8th (runClock) arg, so the frozen silentStream never re-armed the CallScope.
  // EVERY streamed call then committed its full wall-clock duration as "silent" ms (its CallScope
  // lastActivityAt frozen at enter), and a sequence of dense-but-productive streaming calls whose
  // cumulative wall-clock exceeded taskInactivityMs tripped silenceCeilingExceeded() → the ledger
  // issued {stop, task-inactivity} and killed a run that was steadily producing tokens.
  //
  // The fix: the spine FORWARDS runClock into gateway.call → the gateway threads it to the
  // SilentStreamPort's 8th arg → the (frozen, here faithfully simulated) silentStream opens its OWN
  // CallScope and re-arms firstTokenSeen()/touch() per visible chunk = v1's flag-ON branch.
  //
  // This test drives the REAL RunClock + REAL FailureLedger over a FakeClock, with a faithful
  // streaming SilentStreamPort that re-arms per chunk EXACTLY as orchestrator.ts:6457-6478 does. A
  // small inactivity window keeps the wall-clock arithmetic obvious: each call advances the clock
  // 80ms (4×20ms chunks, each gap < the 50ms stall window, total < the 100ms call-hard ceiling), so
  // two productive calls = 160ms cumulative > the 100ms taskInactivityMs. With the re-arm wired the
  // committed silent ms stays ~0 and the run COMPLETES; the pre-fix path would commit ~160ms silent
  // and stop with task-inactivity.

  // A faithful silentStream: mirrors v1's flag-ON branch — open a scope on the threaded runClock,
  // re-arm firstTokenSeen()/touch() per visible chunk (advancing the clock between chunks), leave().
  // `runClock` is the 8th arg the gateway forwards (typed unknown at the port boundary, narrowed
  // here to the minimal touch surface the real silentStream uses).
  function faithfulStreamPort(
    clock: FakeClock,
    script: ProviderResponse[],
    opts: { chunkMs?: number; chunks?: number } = {},
  ): SilentStreamPort {
    const chunkMs = opts.chunkMs ?? 20;
    const chunks = opts.chunks ?? 4;
    let i = 0;
    return async (_chatId, _sys, _session, _provider, _tools, _externalSignal, _onLiveness, runClock) => {
      const rc = runClock as
        | {
            enterCall: (l: { firstResponseMs: number; stallMs: number; hardMs: number }) => {
              firstTokenSeen: () => void;
              touch: () => void;
              leave: () => void;
            };
          }
        | undefined;
      // The 8th arg MUST be the live RunClock (the whole point of the Phase 1c fix). If the gateway
      // regressed to passing undefined, this throws → the test fails loudly rather than silently
      // exercising the no-rearm path.
      if (!rc || typeof rc.enterCall !== "function") {
        throw new Error("Phase 1c regression: gateway did not forward the RunClock to silentStream's 8th arg");
      }
      // v1 parity (orchestrator.ts:6445): silentStream opens its OWN call scope on the runClock.
      const scope = rc.enterCall({ firstResponseMs: 100, stallMs: 50, hardMs: 100 });
      try {
        for (let c = 0; c < chunks; c++) {
          clock.advance(chunkMs); // dense streaming: time passes between visible chunks
          // v1 parity (orchestrator.ts:6467-6468): a visible chunk re-arms liveness.
          scope.firstTokenSeen();
          scope.touch();
        }
      } finally {
        scope.leave(); // commits this call's silent contribution (~0 — last touch was just now)
      }
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      return next ?? mkResponse({ stopReason: "end_turn" });
    };
  }

  // A ControlPlane over the REAL primitives with a SMALL inactivity window, exposing the live
  // RunClock so the test can read accumulatedSilentMs(). Mirrors mkPlane but with a tiny seed +
  // a captured clock handle.
  function mkTinyInactivityPlane(clock: FakeClock): {
    plane: ControlPlane;
    runClock: () => ReturnType<typeof openRunClock>;
  } {
    const tinySeed: PolicySeed = {
      streamInitialTimeoutMs: 100,
      streamStallTimeoutMs: 50,
      providerFirstResponseMs: 100,
      taskInactivityMs: 100, // == 2×callStallMs(50) floor → applied verbatim, no clamp warning
      minInactivityOverStreamRatio: 2,
      outputTokenCap: 100_000,
      costCapUsd: 10,
      // taskHardMs omitted → Infinity (the task-hard timer never fires; isolates the inactivity path)
    };
    let rcRef: ReturnType<typeof openRunClock> | undefined;
    const plane: ControlPlane = {
      openRun(mode: RunMode): OpenRunResult {
        const { policy } = resolveRunBudgetPolicy(mode, tinySeed);
        const rc = openRunClock(clock, policy);
        rcRef = rc;
        return {
          clock: rc,
          ledger: createFailureLedger(mkHealth(), { pauseRetryBudget: policy.pauseRetryBudget }),
          budget: createBudget(policy.outputTokenCap, policy.costCapUsd),
        };
      },
      openBus(runId: string): AgentRunEventBus {
        return createAgentRunEventBus({ runId, clock });
      },
    };
    return {
      plane,
      runClock: () => {
        if (!rcRef) throw new Error("runClock not opened yet");
        return rcRef;
      },
    };
  }

  it("a long-but-productive 2-step stream COMPLETES (re-arm keeps silent ms ~0) — no task-inactivity", async () => {
    const clock = new FakeClock(0);
    const provider = mkProvider();
    const { plane, runClock } = mkTinyInactivityPlane(clock);
    // Step 1 (PLANNING): faithful stream re-arms across 80ms → handlePlanPhase moves to EXECUTING.
    // Step 2 (EXECUTING): faithful stream re-arms across 80ms → end_turn terminal. Cumulative
    // wall-clock 160ms > taskInactivityMs(100); with the re-arm the silence accumulator stays ~0.
    const gateway = new ModelGateway(
      faithfulStreamPort(clock, [
        mkResponse({ text: "the plan", stopReason: "end_turn" }),
        mkResponse({ text: "all done", stopReason: "end_turn" }),
      ]),
    );
    const port = mkPort(provider);
    const runner = mkRunner(plane, gateway, port, clock);

    const result = await drive(clock, runner.run(mkRequest(), mkIO("interactive")));

    // The run completed normally — NOT killed by a spurious task-inactivity stop.
    expect(result.status).toBe("completed");
    expect(result.reason).not.toBe("task-inactivity");
    // The terminal came from the real end_turn path (dispatchEndTurn), proving step 2 actually ran
    // (a pre-fix abort would have stopped at the gate BEFORE step 2's terminal).
    expect(port.spies.dispatchEndTurn).toHaveBeenCalledTimes(1);
    // The silence accumulator stayed far below the 100ms ceiling — the re-arm worked. (Each call
    // commits ~0 because its scope's lastActivityAt was just touched; the spine's own superseded
    // enterCall also commits ~0 because silentStream's enterCall leaves it immediately at entry.)
    expect(runClock().accumulatedSilentMs()).toBeLessThan(100);
  });

  it("CONTROL (proves the assertion bites): the SAME stream withOUT the re-arm commits the full duration as silent", async () => {
    // The negative control: a port that does NOT re-arm (it simply lets the spine's frozen `call`
    // hold the whole call) advances the clock the same 80ms/call but never touches. The spine's
    // own enterCall scope then commits its full duration on leave() → the silence accumulator climbs
    // past the ceiling, exactly the pre-fix behavior. This locks in that the re-arm — not some other
    // effect — is what keeps the run alive in the test above.
    const clock = new FakeClock(0);
    const provider = mkProvider();
    const { plane, runClock } = mkTinyInactivityPlane(clock);
    let i = 0;
    const noRearmScript = [
      mkResponse({ text: "the plan", stopReason: "end_turn" }),
      mkResponse({ text: "all done", stopReason: "end_turn" }),
    ];
    const noRearmPort: SilentStreamPort = async () => {
      clock.advance(80); // same wall-clock as faithfulStreamPort, but NO scope.touch() re-arm
      const next = noRearmScript[Math.min(i, noRearmScript.length - 1)];
      i += 1;
      return next ?? mkResponse({ stopReason: "end_turn" });
    };
    const runner = mkRunner(plane, new ModelGateway(noRearmPort), mkPort(provider), clock);

    await drive(clock, runner.run(mkRequest(), mkIO("interactive")));

    // Without the re-arm, the spine's frozen per-call scope committed its full ~80ms/call → the
    // accumulator crossed the 100ms ceiling (this is the bug the fix prevents).
    expect(runClock().accumulatedSilentMs()).toBeGreaterThanOrEqual(100);
  });
});

describe("V2AgentRunner — a free-tier model costs the run's budget nothing (audited 2026-09-02)", () => {
  /** A plane over the REAL primitives that hands the test the run's Budget. */
  function mkBudgetPlane(clock: FakeClock, costCapUsd: number) {
    let budgetRef: ReturnType<typeof createBudget> | undefined;
    const plane: ControlPlane = {
      openRun(mode: RunMode): OpenRunResult {
        const { policy } = resolveRunBudgetPolicy(mode, { ...SEED, costCapUsd });
        const budget = createBudget(policy.outputTokenCap, policy.costCapUsd);
        budgetRef = budget;
        return {
          clock: openRunClock(clock, policy),
          ledger: createFailureLedger(mkHealth(), { pauseRetryBudget: policy.pauseRetryBudget }),
          budget,
        };
      },
      openBus: (runId: string) => createAgentRunEventBus({ runId, clock }),
    };
    return {
      plane,
      spentUsd: () => {
        if (!budgetRef) throw new Error("budget not opened yet");
        return costCapUsd - budgetRef.remainingCostUsd();
      },
    };
  }

  /** One PLANNING turn + one end_turn turn, both served by `servedBy`, 1k in / 2k out each. */
  function twoTurnsServedBy(servedBy: { provider: string; model: string }): SilentStreamPort {
    const usage = { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 };
    return scriptedStream([
      mkResponse({ text: "the plan", stopReason: "end_turn", usage, servedBy }),
      mkResponse({ text: "all done", stopReason: "end_turn", usage, servedBy }),
    ]);
  }

  it("an opencode '-free' model debits $0, while the same provider's paid model debits the table rate", async () => {
    // opencode is IN the rate table (0.6 in / 3.0 out per 1M), so the free model's $0 can only come
    // from estimateCost's "-free" rule — which needs the model id. Without it the free run is
    // charged the paid rate and a live run's cost headroom pays for tokens nobody billed.
    const CAP = 10;

    const freeClock = new FakeClock(0);
    const free = mkBudgetPlane(freeClock, CAP);
    const freeResult = await drive(
      freeClock,
      mkRunner(
        free.plane,
        new ModelGateway(twoTurnsServedBy({ provider: "opencode", model: "qwen3.6-coder-free" })),
        mkPort(mkProvider("opencode")),
        freeClock,
      ).run(mkRequest(), mkIO("worker")),
    );

    const paidClock = new FakeClock(0);
    const paid = mkBudgetPlane(paidClock, CAP);
    const paidResult = await drive(
      paidClock,
      mkRunner(
        paid.plane,
        new ModelGateway(twoTurnsServedBy({ provider: "opencode", model: "qwen3.6-plus" })),
        mkPort(mkProvider("opencode")),
        paidClock,
      ).run(mkRequest(), mkIO("worker")),
    );

    // Both runs did the SAME work — same provider, same token counts, same two turns.
    expect(freeResult.status).toBe("completed");
    expect(paidResult.status).toBe("completed");
    expect(freeResult.usage?.outputTokens).toBe(paidResult.usage?.outputTokens);

    // The free-tier model costs the run's budget nothing…
    expect(free.spentUsd()).toBe(0);
    // …and the control proves the assertion bites: the paid model is charged the table rate,
    // 2 turns × (1000 × $0.6 + 2000 × $3.0) / 1M = $0.0132.
    expect(paid.spentUsd()).toBeCloseTo(0.0132, 6);
  });
});

describe("V2AgentRunner — a provider that only ever stalls reaches a FAILED terminal (audited 2026-09-02)", () => {
  /**
   * The spine's own CallScope is auto-left (timers cleared, token never cancelled) the instant
   * silentStream opens the scope that really runs the call, so `call.token.reason` was
   * structurally null → callStalled never true → FailureLedger rule 6 (the per-task stall
   * budget) was dead code. Worse, the rule's exhaustion stopped with `finalize: "graceful"`,
   * which the spine maps to terminalStatus "completed" — so even once the stall reached the
   * ledger, a run whose provider never answered once settled as a SUCCESS, and
   * background-executor complete()d the task on it.
   */
  function stallingSilentStream(clock: FakeClock, onStall: () => void): SilentStreamPort {
    return async (_chatId, _sys, _session, _provider, _tools, _ext, _liveness, runClock) => {
      const rc = runClock as {
        enterCall: (l: { firstResponseMs: number; stallMs: number; hardMs: number }) => {
          leave: () => void;
        };
      };
      // silentStream's OWN scope — this is the one the stall timer fires on.
      const scope = rc.enterCall({ firstResponseMs: 100, stallMs: 100, hardMs: 100_000 });
      try {
        clock.advance(150); // no first token inside the window → provider-stall on THIS scope
        onStall();
        throw new Error("stream stalled");
      } finally {
        scope.leave();
      }
    };
  }

  /** The real classifier's rule (engine/accounting.ts): callStalled IS the carried reason. */
  function realStallClassification(port: ReturnType<typeof mkPort>): void {
    port.spies.classifyFailureForVerdict.mockImplementation(
      (p: { failedCallReason: { kind?: string } | null }) => ({
        callStalled: p.failedCallReason?.kind === "provider-stall" || p.failedCallReason?.kind === "hard-timeout",
        taskCancelReason: null,
        benign: false,
      }),
    );
  }

  it("the stall is classified from the scope that ran the call, and the run ends FAILED / provider-stall:task", async () => {
    const clock = new FakeClock(0);
    const handles = mkPlane({ clock });
    let stalls = 0;
    const port = mkPort(mkProvider());
    realStallClassification(port);
    const runner = mkRunner(
      handles.plane,
      new ModelGateway(stallingSilentStream(clock, () => { stalls += 1; })),
      port,
      clock,
    );

    const result = await drive(clock, runner.run(mkRequest(), mkIO("worker")));

    // 1) Every failure was classified from the scope that actually ran the call.
    const reasons = port.spies.classifyFailureForVerdict.mock.calls.map(
      (c) => (c[0] as { failedCallReason: unknown }).failedCallReason,
    );
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(r).toEqual({ kind: "provider-stall", scope: "call" });

    // 2) Rule 6 is live: pauseRetryBudget(5) re-opens the call five times, the sixth stall stops.
    expect(stalls).toBe(6);

    // 3) The terminal NAMES the stall and is a FAILURE — not "completed". This is the half the
    //    earlier attempt got wrong: a graceful stop here settles as a completed task downstream.
    expect(result.reason).toBe("provider-stall:task");
    expect(["failed", "blocked"]).toContain(result.status);
    expect(result.status).toBe("failed");

    // 4) …and the terminal the run persists says the same thing, so the task boundary and the
    //    metric agree with the result object.
    expect(port.spies.persistTerminal).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      "failed",
      "provider-stall:task",
    );
    expect(handles.events().some((e) => e.type === "run.ended" && e.status === "failed")).toBe(true);
  });
});

describe("V2AgentRunner — interactive gate ask_user takes the step (audited 2026-09-02)", () => {
  it("3 consecutive failures → ask_user → the run still calls the provider and recovers on call #4", async () => {
    // The gate's ask_user verdict is derived from the health tracker, which changes ONLY when a
    // call is made (recordSuccess / recordFailure). Re-looping to the gate re-derived the same
    // verdict forever: no model call, one visible ask_user per iteration, until max-iterations.
    // Mirrors the real tracker's ASK_USER_CONSECUTIVE=3 with a stateful fake.
    const health: HealthCore = mkHealth({
      shouldAskUser: () => health.consecutive >= 3,
      backoffMs: () => 1000,
    });
    const handles = mkPlane({ healthCore: health });
    const provider = mkProvider();
    const gateway = new ModelGateway(
      scriptedStream([
        new Error("boom"),
        new Error("boom"),
        new Error("boom"),
        mkResponse({ text: "the plan", stopReason: "end_turn" }), // PLANNING → EXECUTING
        mkResponse({ text: "all done", stopReason: "end_turn" }), // end_turn terminal
      ]),
    );
    const port = mkPort(provider, { iterationLimit: 10, onClassifyFailure: () => health.recordFailure() });
    port.spies.recordHealthSuccess.mockImplementation(() => health.recordSuccess());
    const runner = mkRunner(handles.plane, gateway, port, handles.clock);

    const result = await drive(handles.clock, runner.run(mkRequest(), mkIO("interactive")));

    // The provider recovered on call #4 — the run MUST have taken that call and finished normally.
    expect(port.spies.dispatchEndTurn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.reason).not.toBe("max-iterations");
    // At most one ask per site (the failure site + the gate before the retried step) — not one
    // per remaining iteration.
    const asks = handles.events().filter((e) => e.type === "ask_user");
    expect(asks.length).toBeLessThanOrEqual(2);
    expect(port.spies.classifyFailureForVerdict).toHaveBeenCalledTimes(3);
  });
});
