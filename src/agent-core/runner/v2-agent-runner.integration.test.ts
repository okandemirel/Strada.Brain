/**
 * Agent Core v2 — V2AgentRunner REAL-PORT integration test (Phase 2d-2).
 *
 * The forcing function for the faithful port: drives the unified V2 loop over the REAL
 * `Orchestrator.createAgentCorePort()` (real setupRun / prepareIteration / dispatch* / tool turn /
 * synthesizeFinal / buildResultProjection), the REAL `createControlPlane`, and the REAL
 * `ModelGateway`. The ONLY seam is the provider: a non-streaming scripted `provider.chat`
 * (no `chatStream` → the frozen silentStream falls through to `.chat()`; the gateway passes
 * runClock=undefined → flag-OFF watchdog path). No `vi.useFakeTimers()` — the injected FakeClock +
 * `drive` pump own time.
 *
 * Test A is the must-pass (the port produces a port whose real methods run without throwing).
 * Test D is the highest-value (the verdict bridge end-to-end: classifyFailureForVerdict records
 * into the REAL IterationHealthTracker the REAL FailureLedger reads).
 *
 * The runner under test is constructed directly with the real port — no flag routing involved.
 * (Since THE FLIP this V2 spine is also the shipped production default on every route.)
 */

import { describe, it, expect, vi } from "vitest";
import { FakeClock } from "../control/clock.js";
import { createControlPlane } from "../control/control-plane.js";
import {
  CapabilityRegistry,
  CAPABILITY_MCP_STRADA,
  seedCapabilities,
  type CapabilityAdapter,
} from "../control/index.js";
import { V2AgentRunner, type V2RunnerDeps } from "./v2-agent-runner.js";
import type { AgentRunRequest, IOStrategy, RunnerMode } from "./agent-runner.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import type { WorkspaceLease } from "../../agents/supervisor/supervisor-types.js";
import { DEFAULT_TASK_CONFIG } from "../../config/config.js";
import type { TaskConfig } from "../../config/config.js";
import { createInitialState, type AgentState } from "../../agents/agent-state.js";
import { TaskPlanner } from "../../agents/autonomy/task-planner.js";
import { getResilienceMessage } from "../../agents/resilience-messages.js";
import { createMonitorLifecycle } from "../../dashboard/monitor-lifecycle.js";
import type { WorkspaceBus } from "../../dashboard/workspace-bus.js";
import type { GoalTree, GoalNode, GoalNodeId } from "../../goals/types.js";

// Logger + strada-knowledge module mocks — copied from orchestrator.test.ts so the Orchestrator
// boots without a real project / SQLite / network.
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

function mkScriptedProvider() {
  return {
    name: "mock",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn(), // scripted per-test; NO chatStream → silentStream falls through to chat
  };
}

function mkChannel() {
  return {
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
  };
}

function mkTool(name: string, isWrite = false, touched?: string[]) {
  return {
    name,
    description: `Mock ${name}`,
    inputSchema: { type: "object", properties: {} },
    isWrite,
    execute: vi.fn().mockResolvedValue({
      content: `${name} result`,
      metadata: touched ? { touchedFiles: touched } : undefined,
    }),
  };
}

function resp(over: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    text: "ok",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    ...over,
  } as ProviderResponse;
}

function mkIO(mode: RunnerMode): IOStrategy & {
  deliverFinal: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
} {
  return {
    mode,
    onEvent: vi.fn(),
    deliverFinal: vi.fn(),
    externalSignal: new AbortController().signal,
  } as IOStrategy & { deliverFinal: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> };
}

function mkRequest(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return { prompt: "do the thing", chatId: "chat-1", channelType: "web", ...over };
}

/** Pump microtasks + advance the FakeClock until the run settles (verbatim from v2 unit test). */
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

function buildHarness(
  provider: ReturnType<typeof mkScriptedProvider>,
  tools = [mkTool("file_read"), mkTool("edit_file", true, ["a.cs"])],
  capability?: {
    registry?: CapabilityRegistry;
    adapters?: ReadonlyMap<string, CapabilityAdapter>;
    toolMetadataByName?: Map<string, { requiresBridge?: boolean; readOnly?: boolean }>;
  },
  personalization?: {
    instinctRetriever?: {
      getInsightsForTask: (
        prompt: string,
      ) => Promise<{ insights: string[]; matchedInstinctIds: string[] }>;
    };
  },
  taskConfig?: TaskConfig,
  // GAP1: an optional learning event emitter so emitToolResult's tool:result path runs end-to-end
  // (the orchestrator's emitToolResult early-returns when eventEmitter is null).
  eventEmitter?: { emit: (event: string, payload: unknown) => void },
  // A user-profile store for the prologue's personalization load (loadRunPersonalization).
  userProfileStore?: unknown,
) {
  const clock = new FakeClock(0);
  const channel = mkChannel();
  const getProvider = vi.fn((_identityKey?: string) => provider);
  const orch = new Orchestrator({
    providerManager: {
      getProvider,
      getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
      shutdown: vi.fn(),
    },
    tools,
    channel,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    agentCoreClock: clock,
    // Phase 3b flag-on wiring — default tests omit `capability` → registry undefined → flag-off path.
    capabilityRegistry: capability?.registry,
    capabilityAdapters: capability?.adapters,
    toolMetadataByName: capability?.toolMetadataByName,
    // Step 0 / gap #6 — inject a personalization store (instinct retriever) to exercise the prologue.
    instinctRetriever: personalization?.instinctRetriever,
    // GAP1 — inject a learning event emitter so emitToolResult emits tool:result (else it no-ops).
    ...(eventEmitter ? { eventEmitter } : {}),
    ...(taskConfig ? { taskConfig } : {}),
    ...(userProfileStore ? { userProfileStore } : {}),
    // agentCoreFlagSet OMITTED — the gateway passes runClock=undefined → flag-OFF silentStream.
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);

  const { port, gateway, seed, createHealthCore } = orch.createAgentCorePort();
  const controlPlane = createControlPlane({ clock, seed, createHealthCore }); // no learning sink
  const runner = new V2AgentRunner({ controlPlane, gateway, orchestratorPort: port, clock } as V2RunnerDeps);
  return { clock, channel, provider, tools, runner, getProvider, orch, port };
}

describe("V2AgentRunner — REAL port + REAL gateway (provider.chat scripted)", () => {
  it("A: clean single-step run → completed, deliverFinal once, real synthesizeFinal", async () => {
    const provider = mkScriptedProvider();
    // PLANNING text → real handlePlanPhase → EXECUTING; then end_turn terminal.
    provider.chat
      .mockResolvedValueOnce(resp({ text: "here is the plan", stopReason: "end_turn" }))
      .mockResolvedValueOnce(resp({ text: "all done", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const io = mkIO("worker"); // structured result by value

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("completed");
    expect(result.finalText.length).toBeGreaterThan(0); // REAL synthesizeFinal read the transcript
    // The terminal AgentState is the v1 working phase (the v1 loop never sets COMPLETE on the
    // state — only the metrics record COMPLETE in persistTerminal); assert it is a real phase.
    expect(result.terminalState).toBeDefined();
    expect(provider.chat).toHaveBeenCalled(); // proves gateway→silentStream→chat ran
    expect(io.deliverFinal).toHaveBeenCalledTimes(1);
    expect(result.catalogVersion).toBeTruthy(); // REAL buildResultProjection
  });

  it("B: multi-step with a real tool exec → completed + edit_file executed + phases transitioned", async () => {
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" })) // PLANNING→EXECUTING
      .mockResolvedValueOnce(
        resp({
          text: "",
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-1", name: "edit_file", input: { path: "a.cs" } }],
        }),
      )
      .mockResolvedValueOnce(resp({ text: "reflected, done", stopReason: "end_turn" })); // REFLECTING→terminal
    const h = buildHarness(provider);
    const editTool = h.tools.find((t) => t.name === "edit_file")!;
    const io = mkIO("worker");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("completed"); // (1) status
    expect(editTool.execute).toHaveBeenCalledTimes(1); // (2) tool executed via the REAL tool turn
    expect(result.toolTrace.map((t) => t.toolName)).toContain("edit_file"); // trace projected by value
    expect(result.terminalState!.iteration).toBeGreaterThan(0); // REAL recordStepResultsAndCheckReflection bump
    // PLANNING→EXECUTING is a real phase move; a single tool call below the reflect interval does
    // NOT force REFLECTING (faithful to v1 recordStepResultsAndCheckReflection), so we assert ≥1.
    const phaseEvents = io.onEvent.mock.calls
      .map((c) => c[0] as { type?: string })
      .filter((e) => e?.type === "phase.changed");
    expect(phaseEvents.length).toBeGreaterThanOrEqual(1); // at least PLANNING→EXECUTING
  });

  it("B2: a tool call made during PLANNING is executed, not discarded", async () => {
    // The PLANNING branch passed `toolCallCount: response.toolCalls.length` to
    // handlePlanPhase and then continued — the calls themselves were read as a
    // number and thrown away. A planner that opens a file to decide how to plan
    // had that read discarded and had to ask again on the next turn: one
    // guaranteed round-trip per run that cannot do work.
    //
    // Safe to run because the phase's write restriction is enforced at the gate
    // (d27e4eb4), not just in what the model is offered — a write named here is
    // refused there rather than executed in the phase that exists to prevent it.
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(
        resp({
          text: "before planning I need to look at the file",
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-plan-read", name: "file_read", input: { path: "a.cs" } }],
        }),
      )
      .mockResolvedValue(resp({ text: "all done", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const readTool = h.tools.find((t) => t.name === "file_read")!;
    const io = mkIO("worker");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(readTool.execute, "the planning turn's tool call was discarded").toHaveBeenCalledTimes(1);
    expect(result.toolTrace.map((t) => t.toolName)).toContain("file_read");
  });

  it("C: interactive renders to the channel (real divergence)", async () => {
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" }))
      .mockResolvedValueOnce(resp({ text: "final visible answer", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const io = mkIO("interactive");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("completed");
    // The interactive divergence point is deliverFinal (interactive renders; bg/worker no-op). The
    // REAL synthesizeFinal read the visible answer the dispatch handler appended to the transcript.
    expect(io.deliverFinal).toHaveBeenCalledTimes(1);
    expect(result.finalText).toContain("final visible answer");
  });

  it("D: provider-failure retry through the REAL ledger (verdict bridge end-to-end)", async () => {
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" })) // PLANNING→EXECUTING
      .mockRejectedValueOnce(new Error("boom")) // throw → classifyFailureForVerdict records into REAL tracker
      .mockResolvedValueOnce(resp({ text: "recovered, done", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const io = mkIO("worker");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("completed");
    expect(provider.chat).toHaveBeenCalledTimes(3); // plan, throw, recover — REAL retry path
  });

  it("D2 (livelock guard): persistent provider failure ABORTS via rule 5 — not a background livelock", async () => {
    // Regression guard for the v2-background-livelock fix. The FailureLedger's health core MUST be the
    // SAME tracker the spine records into (createAgentCorePort now threads one shared instance into both
    // createHealthCore AND setupAgentCoreRun's runCtx). With it unified, 5 consecutive failures trip
    // rule 5 → {decision:"stop", verdict-stop:health, finalize:"hard"} → status "failed" at ~6 calls.
    // PRE-FIX the ledger read a permanently-EMPTY tracker → rule 5/7 dead → the background run looped to
    // backgroundEpochMaxIterations × backgroundMaxEpochs, re-decomposing the goal tree each epoch (the
    // "sürekli eklemeli ilerleyip başa saran" loop the soak caught). A small epoch budget here makes the
    // pre-fix livelock settle deterministically (~16 calls) so the post-fix abort (~6) is a clean split.
    const provider = mkScriptedProvider();
    provider.chat.mockImplementation(async () => {
      // call 1 = PLANNING success → EXECUTING; every subsequent call throws a NON-retryable error.
      if (provider.chat.mock.calls.length === 1) {
        return resp({ text: "the plan", stopReason: "end_turn" });
      }
      throw new Error("API error 401: Insufficient balance");
    });
    const taskConfig = {
      ...DEFAULT_TASK_CONFIG,
      backgroundEpochMaxIterations: 8,
      backgroundMaxEpochs: 2,
    } as TaskConfig;
    const h = buildHarness(provider, undefined, undefined, undefined, taskConfig);
    const io = mkIO("background");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    // GRACEFULLY TERMINATED via the now-live health rules — NOT run to the epoch cap (which yields
    // "completed"). For background, rule 7 (ask_user, ASK_USER_CONSECUTIVE) trips before rule 5
    // (abort, ABORT_CONSECUTIVE=5): ask_user YIELDS "blocked"; a pure rule-5 hard stop is "failed".
    // Either is the fix working; "completed" here would mean the pre-fix livelock to the epoch cap.
    expect(["failed", "blocked"]).toContain(result.status);
    expect(result.status).not.toBe("completed");
    // A handful of calls (1 plan + a few consecutive failures), far below the epoch cap (~16 pre-fix).
    expect(provider.chat.mock.calls.length).toBeLessThan(10);
  });

  it("H2 (decompose idempotency): proactive goal decomposition runs at most once per run", async () => {
    // The v2 spine re-enters PLANNING on each REPLAN cycle; without the per-run guard in the
    // decomposeGoalsIfPlanning binding, every re-entry re-runs decomposeProactive → a FRESH goal
    // tree (dag_init), discarding progress and spraying the DAG/Kanban monitor. Guard = once per run.
    const provider = mkScriptedProvider();
    const h = buildHarness(provider);
    // Populate the per-run context cell the binding reads (ctx().goalsDecomposed). setupRun is the
    // REAL prologue; drive() pumps the FakeClock in case it awaits internally.
    const setupInput = (
      h.runner as unknown as {
        toSetupInput: (r: AgentRunRequest, m: RunnerMode) => Parameters<typeof h.port.setupRun>[0];
      }
    ).toSetupInput(mkRequest(), "background");
    await drive(h.clock, h.port.setupRun(setupInput));
    // Spy the underlying decompose the binding calls — bypasses goalDecomposer/tree wiring; we are
    // asserting the GUARD, not decomposition itself.
    const decompSpy = vi
      .spyOn(
        h.orch as unknown as {
          runProactiveGoalDecomposition: (o: { agentState: AgentState }) => Promise<AgentState>;
        },
        "runProactiveGoalDecomposition",
      )
      .mockImplementation(async (o: { agentState: AgentState }) => o.agentState);
    const state = createInitialState("do the thing");

    // Three PLANNING entries (initial + two REPLAN re-entries) on the SAME run.
    for (let i = 0; i < 3; i++) {
      await h.port.decomposeGoalsIfPlanning({ agentState: state, responseText: "plan", chatId: "chat-1" });
    }

    expect(decompSpy).toHaveBeenCalledTimes(1); // once-per-run, NOT once-per-PLANNING-entry
  });

  it("GAP3 (epoch-rollover side effects): the bg epoch boundary records phase-outcome + persists memory + resets the planner budget window", async () => {
    // Regression guard for the v2 background epoch-rollover gap. v1 runBackgroundTask ran a block of
    // side effects at EVERY epoch boundary (orchestrator.ts ~4587-4623): recordPhaseOutcome (continued
    // /blocked), persistExecutionMemory, and ON CONTINUE taskPlanner.resetBudgetWindow() + the loop
    // amnesty. The v2 spine's rollover was a bare `epoch++` → on a multi-epoch background run the
    // phase-outcome telemetry under-counted, the planner budget window never reset (drift), and the
    // loop-detector amnesty never fired. The port's onEpochRollover (called once per boundary, on both
    // the continue AND the budget-exhausted-break path) now replicates v1 verbatim.
    //
    // Drive ≥2 epochs WITHOUT terminating: backgroundEpochMaxIterations=1 (one iteration per epoch) +
    // backgroundMaxEpochs=2. The provider ALWAYS returns a tool-call response so no iteration hits an
    // end_turn / DONE terminal — each epoch's single iteration is consumed (PLANNING transition in
    // epoch 0, tool execution in epoch 1) and the inner `for` completes → the rollover runs.
    //   epoch 0: canAutoContinueBackgroundEpoch(1) → 1<2 = true  → onEpochRollover(true, 0)  → epoch++
    //   epoch 1: canAutoContinueBackgroundEpoch(2) → 2<2 = false → onEpochRollover(false, 1) → break
    const provider = mkScriptedProvider();
    provider.chat.mockResolvedValue(
      resp({
        text: "working",
        stopReason: "tool_use",
        toolCalls: [{ id: "tc-1", name: "edit_file", input: { path: "a.cs" } }],
      }),
    );
    const taskConfig = {
      ...DEFAULT_TASK_CONFIG,
      backgroundEpochMaxIterations: 1, // one iteration per epoch → the inner `for` completes → rollover
      backgroundMaxEpochs: 2, // allow exactly one auto-continue (epoch 0→1), then stop (epoch 1)
    } as TaskConfig;
    const h = buildHarness(provider, undefined, undefined, undefined, taskConfig);
    const io = mkIO("background");

    // recordPhaseOutcome is a private orchestrator method; persistExecutionMemory is on its
    // sessionManager. resetBudgetWindow is a per-run TaskPlanner instance built inside setupRun —
    // spy the prototype to catch the continue-path reset.
    const recordPhaseOutcomeSpy = vi.spyOn(
      h.orch as unknown as { recordPhaseOutcome: (p: { status: string }) => void },
      "recordPhaseOutcome",
    );
    const persistExecMemSpy = vi.spyOn(
      (h.orch as unknown as { sessionManager: { persistExecutionMemory: (...a: unknown[]) => void } })
        .sessionManager,
      "persistExecutionMemory",
    );
    const resetBudgetWindowSpy = vi.spyOn(TaskPlanner.prototype, "resetBudgetWindow");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    // The run reached the epoch-budget-exhausted stop via the rollover (not a livelock / throw). The
    // spine's terminal STATUS on this path is its existing choice (not part of GAP3); GAP3 asserts the
    // SIDE EFFECTS fire at the boundary. The run.ending reason proves the budget-exhausted break ran.
    expect(["completed", "blocked"]).toContain(result.status);
    const endingReasons = io.onEvent.mock.calls
      .map((c) => c[0] as { type?: string; reason?: string })
      .filter((e) => e?.type === "run.ending")
      .map((e) => e.reason);
    expect(endingReasons).toContain("epoch-budget-exhausted");

    // (1) Phase-outcome telemetry fired at the boundary — a "continued" on the rollover AND a
    //     "blocked" on the budget-exhausted stop (the under-count the fix closes).
    const statuses = recordPhaseOutcomeSpy.mock.calls.map((c) => c[0].status);
    expect(statuses).toContain("continued"); // epoch 0 auto-continue
    expect(statuses).toContain("blocked"); // epoch 1 budget exhausted

    // (2) Execution memory persisted at EACH epoch boundary. Two rollover calls (continue + stop) plus
    //     the terminal persistTerminal flush → ≥2 (the rollover ones are the regression target).
    expect(persistExecMemSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // (3) The taskPlanner budget window was reset on the CONTINUE rollover (planner-drift fix).
    expect(resetBudgetWindowSpy).toHaveBeenCalled();
  });

  it("E (P-E): reaches the REAL REFLECTING boundary → real parseReflectionDecision drives termination", async () => {
    // The ONLY test that exercises the REAL portParseReflectionDecision (processReflectionPreamble):
    // 3 tool calls in one turn push stepResults.length to 3 → recordStepResultsAndCheckReflection
    // transitions EXECUTING→REFLECTING (reflectInterval=3), so the next turn hits the spine's
    // REFLECTING branch and the real decision parser runs on the model's "**DONE**" text.
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "the plan", stopReason: "end_turn" })) // PLANNING→EXECUTING
      .mockResolvedValueOnce(
        resp({
          text: "doing the work",
          stopReason: "tool_use",
          toolCalls: [
            { id: "tc-1", name: "file_read", input: {} },
            { id: "tc-2", name: "file_read", input: {} },
            { id: "tc-3", name: "edit_file", input: { path: "a.cs" } },
          ],
        }),
      )
      .mockResolvedValueOnce(resp({ text: "All requirements met.\n\n**DONE**", stopReason: "end_turn" })) // REFLECTING
      .mockResolvedValue(resp({ text: "finished", stopReason: "end_turn" })); // safety net if the parse overrides DONE→CONTINUE
    const h = buildHarness(provider);
    const io = mkIO("worker");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("completed");
    // Reached + processed the REAL reflection boundary (plan + 3-tool turn + reflection = ≥3 calls)
    // through the real parseReflectionDecision without throwing.
    expect(provider.chat.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.tools.find((t) => t.name === "edit_file")!.execute).toHaveBeenCalled(); // real tool turn ran
  });

  /* audited 2026-09-02: the recorded terminal metric must carry the run's real terminal status/reason */
  it("metric: an epoch-budget-exhausted run is recorded as iteration-budget-terminated, not as a completion", async () => {
    // Same drive as GAP3: one iteration per epoch, two epochs, the provider never ends the turn.
    const provider = mkScriptedProvider();
    provider.chat.mockResolvedValue(
      resp({
        text: "working",
        stopReason: "tool_use",
        toolCalls: [{ id: "tc-1", name: "edit_file", input: { path: "a.cs" } }],
      }),
    );
    const taskConfig = {
      ...DEFAULT_TASK_CONFIG,
      backgroundEpochMaxIterations: 1,
      backgroundMaxEpochs: 2,
    } as TaskConfig;
    const h = buildHarness(provider, undefined, undefined, undefined, taskConfig);
    const io = mkIO("background");
    const metricSpy = vi.spyOn(
      (h.orch as unknown as { engine: { recordMetricEnd: (...a: unknown[]) => void } }).engine,
      "recordMetricEnd",
    );

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.reason).toBe("epoch-budget-exhausted");
    expect(result.status).toBe("blocked");
    expect(metricSpy).toHaveBeenCalledTimes(1);
    const recorded = metricSpy.mock.calls[0]![1] as { agentPhase: string; terminatedByIterationBudget?: boolean };
    // mapCompletionStatus: terminatedByIterationBudget → "partial"; COMPLETE would have been "success".
    expect(recorded.terminatedByIterationBudget).toBe(true);
    expect(recorded.agentPhase).not.toBe("complete");
  });

  it("metric: a run that ends blocked on a verdict (max-tokens runaway) is recorded FAILED, not COMPLETE", async () => {
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "the plan", stopReason: "end_turn" }))
      .mockResolvedValue(resp({ text: "truncated…", stopReason: "max_tokens", toolCalls: [] }));
    const h = buildHarness(provider);
    const io = mkIO("worker");
    const metricSpy = vi.spyOn(
      (h.orch as unknown as { engine: { recordMetricEnd: (...a: unknown[]) => void } }).engine,
      "recordMetricEnd",
    );

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("blocked");
    expect(metricSpy).toHaveBeenCalledTimes(1);
    const recorded = metricSpy.mock.calls[0]![1] as { agentPhase: string; terminatedByIterationBudget?: boolean };
    expect(recorded.agentPhase).toBe("failed");
    expect(recorded.terminatedByIterationBudget).toBeFalsy();
  });

  it("E (P-E): 3 consecutive no-tool max_tokens turns → runaway guard aborts (worker → blocked)", async () => {
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "the plan", stopReason: "end_turn" })) // PLANNING→EXECUTING
      .mockResolvedValue(resp({ text: "truncated…", stopReason: "max_tokens", toolCalls: [] })); // then truncate forever
    const h = buildHarness(provider);
    const io = mkIO("worker");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    // The spine's consecutiveMaxTokens>=3 guard aborts; worker (non-interactive) → blocked.
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("max-tokens-runaway");
    expect(provider.chat).toHaveBeenCalledTimes(4); // plan + 3 truncated turns before the abort
  });

  /* audited 2026-09-02: the run context must carry the loaded profile's language */
  it("a worker verdict-stop renders its terminal text in the user's PROFILE language, not the daemon default", async () => {
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "the plan", stopReason: "end_turn" })) // PLANNING→EXECUTING
      .mockResolvedValue(resp({ text: "truncated…", stopReason: "max_tokens", toolCalls: [] })); // truncate forever
    // A profile store whose only profile speaks Turkish. The daemon default stays "en".
    const trProfile = { chatId: "chat-1", language: "tr", activePersona: "default", preferences: {}, lastTopics: [], firstSeenAt: 0, lastSeenAt: 0 };
    const store = {
      getProfile: vi.fn(() => trProfile),
      upsertProfile: vi.fn(),
      touchLastSeen: vi.fn(),
      isAutonomousMode: vi.fn(() => false),
      setAutonomousMode: vi.fn(async () => undefined),
      setActivePersona: vi.fn(),
      resolveLinkedIdentity: vi.fn(() => null),
    };
    const h = buildHarness(provider, undefined, undefined, undefined, undefined, undefined, store);
    const io = mkIO("worker");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("max-tokens-runaway");
    expect(store.getProfile).toHaveBeenCalled(); // the prologue really loaded the profile
    // task_stuck in "tr" (resilience-messages.ts) — the profile language, not the "en" default.
    expect(result.finalText).toContain("takıldım");
  });

  it("GAP4 (verdict-stop fallback): a worker that STOPS on a verdict returns the reason text, NOT a false 'Task completed.'", async () => {
    // The bug: synthesizeFinal is a pure read-back of the last VISIBLE assistant message. A
    // VERDICT-STOP terminal (here max-tokens-runaway) breaks epochLoop BEFORE any dispatch handler
    // appends a visible assistant message — the max_tokens continuation pushes to session.messages
    // ONLY, never session.visibleMessages — so the read-back is empty and PRE-FIX the run returned
    // the bare string "Task completed." (a FALSE success). POST-FIX synthesizeFinal maps the spine's
    // terminalReason ("max-tokens-runaway" → task_stuck) to the localized resilience text.
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "the plan", stopReason: "end_turn" })) // PLANNING→EXECUTING
      .mockResolvedValue(resp({ text: "truncated…", stopReason: "max_tokens", toolCalls: [] })); // truncate forever
    const h = buildHarness(provider);
    const io = mkIO("worker");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("max-tokens-runaway");
    // The fix: NOT the bare false-success fallback…
    expect(result.finalText).not.toBe("Task completed.");
    // …and it reflects the terminal reason — the localized task_stuck resilience message (worker
    // path → profileLanguage undefined → defaultLanguage EN). Asserted against the source of truth.
    expect(result.finalText).toBe(getResilienceMessage("task_stuck", "en"));
    expect(result.finalSummary).toBe(getResilienceMessage("task_stuck", "en"));
  });

  it("GAP4 (happy-path verbatim): a clean end_turn completion still returns the real visible answer", async () => {
    // The positive control: the read-back happy path MUST NOT regress. A clean run whose final turn
    // emits a real answer (dispatchEndTurn → sendVisibleAssistantMarkdown appends it to the visible
    // transcript) returns that answer VERBATIM — never the reason fallback.
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" }))
      .mockResolvedValueOnce(resp({ text: "the real worker answer", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const io = mkIO("worker");

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    expect(result.status).toBe("completed");
    expect(result.finalText).toContain("the real worker answer"); // verbatim read-back, not the fallback
    expect(result.finalText).not.toBe("Task completed.");
    expect(result.finalText).not.toBe(getResilienceMessage("task_stuck", "en"));
  });

  it("F (P-E): workspaceLease scopes the V2 tool turn to the worktree (isolation — the flip prerequisite)", async () => {
    // The blocker the worker flip depended on: a V2 worker must run its tools in the LEASED git
    // worktree, not the main tree (else parallel workers collide). Proves the lease threads
    // request → setupRun → runCtx → executeOptions → executeToolCalls' projectPath (v1 @ :7175).
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" }))
      .mockResolvedValueOnce(
        resp({
          text: "editing",
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-1", name: "edit_file", input: { path: "a.cs" } }],
        }),
      )
      .mockResolvedValue(resp({ text: "done", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const io = mkIO("worker");
    const lease = { id: "ws-1", path: "/tmp/worktree-ws-1" } as unknown as WorkspaceLease;

    const result = await drive(h.clock, h.runner.run(mkRequest({ workspaceLease: lease }), io));

    expect(result.status).toBe("completed");
    expect(result.workspaceId).toBe("ws-1"); // #2: projection surfaces the lease id (v1 parity)
    const editTool = h.tools.find((t) => t.name === "edit_file")!;
    expect(editTool.execute).toHaveBeenCalled();
    // #1 ISOLATION: the tool executed with the worktree path as projectPath — NOT /tmp/test-project.
    const toolCtx = editTool.execute.mock.calls[0]?.[1] as { projectPath?: string } | undefined;
    expect(toolCtx?.projectPath).toBe("/tmp/worktree-ws-1");
    // #2: the workspace artifact is surfaced (buildWorkerArtifacts).
    expect(result.artifacts.some((a) => a.kind === "workspace")).toBe(true);
  });

  it("USERID (flip trio catch): the interactive tool turn threads the run's userId into executeOptions (v1 parity @ :6350)", async () => {
    // Identity-keyed gates in executeSingleToolCall (dm-policy autonomy prefs keyed
    // `${userId}:${chatId}`) must resolve the USER's stored prefs on multi-user channels
    // where userId != chatId. v1 interactive threads userId; the port must too.
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" }))
      .mockResolvedValueOnce(
        resp({
          text: "reading",
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-1", name: "file_read", input: {} }],
        }),
      )
      .mockResolvedValue(resp({ text: "done", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const spy = vi.spyOn(
      h.orch as unknown as {
        executeToolCalls: (c: string, tc: unknown[], opts: { userId?: string }) => Promise<unknown>;
      },
      "executeToolCalls",
    );

    const result = await drive(h.clock, h.runner.run(mkRequest({ userId: "user-42" }), mkIO("interactive")));

    expect(result.status).toBe("completed");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[2]?.userId).toBe("user-42");
  });

  it("USERID (worker parity): the worker tool turn does NOT thread userId (v1 background parity @ :4642)", async () => {
    // v1's background/worker loop never threaded userId into executeOptions — the port keeps
    // byte-parity per route; unconditional threading is a separate post-deletion decision.
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" }))
      .mockResolvedValueOnce(
        resp({
          text: "reading",
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-1", name: "file_read", input: {} }],
        }),
      )
      .mockResolvedValue(resp({ text: "done", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const spy = vi.spyOn(
      h.orch as unknown as {
        executeToolCalls: (c: string, tc: unknown[], opts: { userId?: string }) => Promise<unknown>;
      },
      "executeToolCalls",
    );

    const result = await drive(h.clock, h.runner.run(mkRequest({ userId: "user-42" }), mkIO("worker")));

    expect(result.status).toBe("completed");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[2]?.userId).toBeUndefined();
  });

  it("CANCEL (P1): a mid-run external /cancel is a BENIGN cancel — no health failure, not a COMPLETE metric", async () => {
    // The soak-audit P1: when io.externalSignal aborts mid-call, gateway.call throws → the spine
    // catches {kind:"threw"}. PRE-FIX the failure gate ran classifyFailureForVerdict (recordFailure →
    // poisoned per-run health) and the run was recorded as AgentPhase.COMPLETE (cancelReason undefined,
    // since the reason lived only on externalSignal, never on the task token). POST-FIX the run-open
    // signal→token wiring stamps runClock.taskToken.reason = user-cancel, the gate short-circuits the
    // benign cancel (NO classify/recordFailure), and persistTerminal records a non-COMPLETE phase.
    const provider = mkScriptedProvider();
    const controller = new AbortController();
    provider.chat.mockImplementation(async () => {
      // call 1 = PLANNING success → EXECUTING. On the 2nd call the user cancels mid-run: abort the
      // signal (fires the run-open listener synchronously → token.reason = user-cancel) then reject
      // with an abort-style error, exactly as a provider rejects when its AbortSignal trips.
      if (provider.chat.mock.calls.length === 1) {
        return resp({ text: "the plan", stopReason: "end_turn" });
      }
      controller.abort();
      throw new Error("This operation was aborted");
    });
    const h = buildHarness(provider);
    const io: IOStrategy & { deliverFinal: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> } = {
      mode: "worker",
      onEvent: vi.fn(),
      deliverFinal: vi.fn(),
      externalSignal: controller.signal, // the REAL user-cancel signal, wired to the task token
    } as IOStrategy & { deliverFinal: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> };

    // (b) spy the health-failure classifier (the port delegates classifyFailureForVerdict → this);
    // a benign cancel must NOT reach it (no recordFailure → no per-run health poison).
    // The port assembly + accounting moved into the engine (relocation Step 9); the classifier +
    // metric-end now live on orch.engine, so the spies target it (same methods, same call path).
    const classifySpy = vi.spyOn(
      (h.orch as unknown as { engine: { classifyAgentCoreFailure: (...a: unknown[]) => unknown } }).engine,
      "classifyAgentCoreFailure",
    );
    // (c) spy recordMetricEnd (called by persistTerminal in the spine's finally) to assert the
    // recorded terminal phase is NOT COMPLETE for a cancel.
    const metricSpy = vi.spyOn(
      (h.orch as unknown as { engine: { recordMetricEnd: (...a: unknown[]) => void } }).engine,
      "recordMetricEnd",
    );

    const result = await drive(h.clock, h.runner.run(mkRequest(), io));

    // (a) the task token carries the typed user-cancel reason (the wiring populated it).
    expect(result.cancelReason).toEqual({ kind: "user-cancel" });
    // (d) cancelReason surfaced on AgentRunResult + the terminal reason is the typed cancel label.
    expect(result.reason).toBe("user-cancel");
    // (b) NO health failure was classified/recorded for the benign cancel.
    expect(classifySpy).not.toHaveBeenCalled();
    // (e) NOT recorded as a successful completion — the metric phase is the v1-parity non-COMPLETE.
    expect(metricSpy).toHaveBeenCalled();
    const recordedPhases = metricSpy.mock.calls.map((c) => (c[1] as { agentPhase?: string })?.agentPhase);
    expect(recordedPhases).not.toContain("complete");
    // status is NOT "completed" via the success path's lens — a benign cancel terminates gracefully
    // and is never billed as a real completion (the executor's signal.aborted guard owns the surface).
    expect(result.status).not.toBe("failed"); // benign cancel ≠ provider failure
  });
});

describe("V2AgentRunner — Phase 3b capability guard (flag-on; the first registry-wired integration)", () => {
  // A requiresBridge tool → capabilityForTool({requiresBridge:true}) → "mcp:strada". The registry's
  // health for that capability is the ONLY thing that differs between G1 (runs) and G2 (BLOCKED), so
  // the differential proves the guardExecute write-path wrap — not some filter — gates the tool.
  const BRIDGE = "unity_bridge";

  function bridgeHarness(
    provider: ReturnType<typeof mkScriptedProvider>,
    opts: { state: "live" | "down"; adapterRevives?: boolean },
  ) {
    const registry = new CapabilityRegistry(new FakeClock(0)); // own clock, never advanced → down stays down
    seedCapabilities(registry, { mcpConnected: true }); // mcp:strada starts live
    if (opts.state === "down") {
      for (let i = 0; i < 6; i++) registry.recordFailure(CAPABILITY_MCP_STRADA, "ECONNREFUSED bridge");
      expect(registry.canAttempt(CAPABILITY_MCP_STRADA)).toBe(false); // guard: truly down (downThreshold=5)
    }
    const adapterRevives = opts.adapterRevives;
    const adapters =
      adapterRevives === undefined
        ? undefined
        : new Map<string, CapabilityAdapter>([
            [
              CAPABILITY_MCP_STRADA,
              { capabilityId: CAPABILITY_MCP_STRADA, revive: () => Promise.resolve(adapterRevives) },
            ],
          ]);
    const tools = [mkTool("file_read"), mkTool("edit_file", true, ["a.cs"]), mkTool(BRIDGE)];
    return buildHarness(provider, tools, {
      registry,
      adapters,
      toolMetadataByName: new Map([[BRIDGE, { requiresBridge: true, readOnly: true }]]),
    });
  }

  function scriptBridgeCall(provider: ReturnType<typeof mkScriptedProvider>) {
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" })) // PLANNING→EXECUTING
      .mockResolvedValueOnce(
        resp({ text: "", stopReason: "tool_use", toolCalls: [{ id: "b1", name: BRIDGE, input: {} }] }),
      )
      .mockResolvedValue(resp({ text: "done", stopReason: "end_turn" })); // continue after the tool result
  }

  it("G1: live mcp:strada → the bridge tool runs through guardExecute (ok path)", async () => {
    const provider = mkScriptedProvider();
    scriptBridgeCall(provider);
    const h = bridgeHarness(provider, { state: "live" });
    const result = await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));
    expect(result.status).toBe("completed");
    expect(h.tools.find((t) => t.name === BRIDGE)!.execute).toHaveBeenCalledTimes(1); // canAttempt(live) → ran
  });

  it("G2: down mcp:strada + no adapter → BLOCKED contract, tool NEVER executed", async () => {
    const provider = mkScriptedProvider();
    scriptBridgeCall(provider);
    const h = bridgeHarness(provider, { state: "down" }); // no adapters → no revive
    const result = await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));
    expect(result.status).toBe("completed"); // BLOCKED is non-fatal — the loop continues
    expect(h.tools.find((t) => t.name === BRIDGE)!.execute).not.toHaveBeenCalled(); // guardExecute blocked first
    // The typed BLOCKED result reached the model as the tool result (proves the wrap, not a filter).
    const seenByModel = JSON.stringify(provider.chat.mock.calls);
    expect(seenByModel).toContain("BLOCKED");
    expect(seenByModel).toContain("mcp:strada");
  });

  it("G3: down mcp:strada + an adapter that revives → recovers and the tool runs", async () => {
    const provider = mkScriptedProvider();
    scriptBridgeCall(provider);
    const h = bridgeHarness(provider, { state: "down", adapterRevives: true });
    const result = await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));
    expect(result.status).toBe("completed");
    // revive() → recordProbeSuccess → degraded(usable) → canAttempt → the tool ran (step 2b recovery).
    expect(h.tools.find((t) => t.name === BRIDGE)!.execute).toHaveBeenCalledTimes(1);
  });
});

describe("Step 0 — v2 prologue fidelity gaps (behind the route flag; production routes stay v1)", () => {
  it("gap #5: the run identity is resolved via resolveIdentityKey — userId wins over chatId", async () => {
    const provider = mkScriptedProvider();
    provider.chat.mockResolvedValue(resp({ text: "done", stopReason: "end_turn" }));
    const h = buildHarness(provider);

    await drive(h.clock, h.runner.run(mkRequest({ userId: "user-42" }), mkIO("worker")));

    // setupAgentCoreRun must key the run on the RESOLVED identity (userId), not the raw chatId.
    // Pre-fix it hardcoded `identityKey = chatId` → getProvider("chat-1"); the fix routes through
    // resolveIdentityKey → "user-42" (the fallback-provider fetch in the v2 prologue).
    expect(h.getProvider).toHaveBeenCalledWith("user-42");
  });

  it("gap #1: the run establishes v1's task-execution ALS scope (identity + taskRunId)", async () => {
    const provider = mkScriptedProvider();
    provider.chat.mockResolvedValue(resp({ text: "done", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const scopeSpy = vi.spyOn(h.orch as unknown as { withTaskExecutionContext: (...a: unknown[]) => unknown }, "withTaskExecutionContext");

    await drive(h.clock, h.runner.run(mkRequest({ userId: "user-42", taskRunId: "run-7" }), mkIO("worker")));

    // The spine must wrap the WHOLE run in withTaskExecutionContext so deep readers (goal-decomposition
    // taskRunId, artifact-eval identityKey) see the ctx instead of undefined. Pre-fix the v2 path never
    // established the scope (0 calls); post-fix it is called once with the resolved v1-parity ctx.
    expect(scopeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        userId: "user-42",
        identityKey: "user-42",
        taskRunId: "run-7",
      }),
      expect.any(Function),
    );
  });

  it("gap #3: a worker run builds a FRESH session — the shared persistent session is untouched", async () => {
    const provider = mkScriptedProvider();
    provider.chat.mockResolvedValue(resp({ text: "done", stopReason: "end_turn" }));
    const h = buildHarness(provider);
    const sm = (
      h.orch as unknown as {
        sessionManager: { getOrCreateSession: (id: string) => { messages: unknown[] } };
      }
    ).sessionManager;
    // Materialize the shared persistent session for this chatId BEFORE the run; a worker run must NOT
    // write its transcript into it (the parallel-worker collision gap #3 closes) — it uses a fresh
    // session built from userContent. Pre-fix the worker pulled getOrCreateSession(chatId) and grew it.
    const persistent = sm.getOrCreateSession("chat-1");
    const before = persistent.messages.length;

    await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));

    expect(persistent.messages.length).toBe(before); // worker used a FRESH session, not the shared one
  });

  it("gap #6: the worker prologue runs personalization — instinct retrieval is invoked (v1 parity)", async () => {
    const provider = mkScriptedProvider();
    provider.chat.mockResolvedValue(resp({ text: "done", stopReason: "end_turn" }));
    const getInsightsForTask = vi
      .fn()
      .mockResolvedValue({ insights: ["learned-insight-xyz"], matchedInstinctIds: [] });
    const h = buildHarness(provider, undefined, undefined, { instinctRetriever: { getInsightsForTask } });

    await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));

    // The v2 prologue must run the personalization layers (v1 parity, runBackgroundTask :3291-3388);
    // the prior profile:null version skipped them all. Instinct retrieval runs with the prompt.
    expect(getInsightsForTask).toHaveBeenCalledWith("do the thing");
  });

  it("GAP1: v2 attributes the retrieved instincts — tool:result carries appliedInstinctIds, cleared after", async () => {
    // The v2 path was open-loop: it retrieved insights for the prompt but DROPPED matchedInstinctIds,
    // so every tool:result carried appliedInstinctIds:[] and the confidence reinforcement at
    // learning-pipeline.ts (gated on appliedInstinctIds.length>0) never fired. This asserts the fix:
    // setupAgentCoreRun stashes the IDs in currentSessionInstinctIds, the SHARED emitToolResult tags
    // each tool:result with them, and persistTerminal clears the per-session store after the run.
    const provider = mkScriptedProvider();
    provider.chat
      .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" })) // PLANNING→EXECUTING
      .mockResolvedValueOnce(
        resp({
          text: "",
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-1", name: "edit_file", input: { path: "a.cs" } }],
        }),
      )
      .mockResolvedValueOnce(resp({ text: "done", stopReason: "end_turn" })); // REFLECTING→terminal
    const getInsightsForTask = vi
      .fn()
      .mockResolvedValue({ insights: ["learned-insight-xyz"], matchedInstinctIds: ["inst-1"] });
    // Capture every emitted tool:result through a real injected learning emitter (emitToolResult
    // no-ops when eventEmitter is null, so it must be wired for the attribution path to run).
    const events: Array<{ toolName: string; appliedInstinctIds: string[] }> = [];
    const eventEmitter = {
      emit: (evt: string, payload: unknown) => {
        if (evt === "tool:result") {
          const p = payload as { toolName?: string; appliedInstinctIds?: string[] };
          events.push({
            toolName: p.toolName ?? "",
            appliedInstinctIds: p.appliedInstinctIds ?? [],
          });
        }
      },
    };
    const h = buildHarness(
      provider,
      undefined,
      undefined,
      { instinctRetriever: { getInsightsForTask } },
      undefined,
      eventEmitter,
    );

    // Mid-run probe: capture currentSessionInstinctIds WHILE the tool turn runs (it is cleared on
    // teardown). The edit tool's execute resolves during the run, so read the store from inside it.
    let midRunInstinctIds: string[] | undefined;
    let midRunKeys: string[] = [];
    const editTool = h.tools.find((t) => t.name === "edit_file")!;
    const store = (
      h.orch as unknown as { currentSessionInstinctIds: Map<string, string[]> }
    ).currentSessionInstinctIds;
    (editTool.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // audited 2026-09-02: the set is stored per RUN now (chatId + taskRunId),
      // so probe by the chat's prefix rather than by the bare chatId.
      midRunKeys = [...store.keys()];
      midRunInstinctIds = store.get(
        midRunKeys.find((k) => k === "chat-1" || k.startsWith("chat-1\u0000")) ?? "",
      );
      return { content: "edit_file result" };
    });

    await drive(h.clock, h.runner.run(mkRequest(), mkIO("interactive")));

    // (a) the IDs were retrieved and stashed during the run …
    expect(getInsightsForTask).toHaveBeenCalledWith("do the thing");
    expect(midRunInstinctIds).toEqual(["inst-1"]);
    expect(midRunKeys, "the set was not scoped to the run").toEqual([
      expect.stringMatching(/^chat-1\u0000.+/),
    ]);
    // (b) … the SHARED emitToolResult attributed the tool:result to them (the reinforcement signal) …
    const toolResults = events.filter((e) => e.toolName === "edit_file");
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults.every((e) => e.appliedInstinctIds.includes("inst-1"))).toBe(true);
    // (c) … and the per-session store was CLEARED on teardown (no cross-run mis-attribution / leak).
    expect([...store.keys()]).toEqual([]);
  });

  it("two concurrent runs on ONE chatId each keep their OWN retrieved instincts", async () => {
    // audited 2026-09-02: setupAgentCoreRun stashed the retrieved IDs under the
    // chatId alone. Every supervisor wave node runs on the one Orchestrator with
    // the one chatId (createSupervisorExecuteNodeBridge), so concurrent nodes
    // overwrote each other's set: the last node's instincts were credited with
    // every other node's tool outcomes, and the first node to reach teardown
    // deleted the set out from under its siblings, whose remaining results then
    // carried nothing at all. The bridge already stamps a per-node taskRunId;
    // the set is scoped to it.
    const provider = mkScriptedProvider();
    const turns: Record<string, number> = { alpha: 0, beta: 0 };
    provider.chat.mockImplementation(async (...args: unknown[]) => {
      const tag = JSON.stringify(args).includes("alpha") ? "alpha" : "beta";
      const turn = turns[tag]++;
      if (turn === 0) return resp({ text: "plan", stopReason: "end_turn" });
      if (turn === 1) {
        return resp({
          text: "",
          stopReason: "tool_use",
          toolCalls: [{ id: `tc-${tag}`, name: "edit_file", input: { path: `${tag}.cs` } }],
        });
      }
      return resp({ text: "done", stopReason: "end_turn" });
    });

    // Both runs finish retrieval before either reaches its tool turn — the wave
    // shape, made deterministic. Each node retrieves a DIFFERENT instinct.
    let arrived = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const getInsightsForTask = vi.fn(async (prompt: string) => {
      const tag = prompt.includes("alpha") ? "alpha" : "beta";
      if (++arrived === 2) openGate();
      await gate;
      return { insights: [], matchedInstinctIds: [`inst-${tag}`] };
    });

    const attributed: Array<{ path: string; ids: string[] }> = [];
    const eventEmitter = {
      emit: (evt: string, payload: unknown) => {
        if (evt !== "tool:result") return;
        const p = payload as {
          toolName?: string;
          input?: { path?: string };
          appliedInstinctIds?: string[];
        };
        if (p.toolName === "edit_file") {
          attributed.push({ path: p.input?.path ?? "", ids: p.appliedInstinctIds ?? [] });
        }
      },
    };

    const h = buildHarness(
      provider,
      undefined,
      undefined,
      { instinctRetriever: { getInsightsForTask } },
      undefined,
      eventEmitter,
    );
    // A second port over the SAME Orchestrator: two nodes of one wave.
    const secondPort = h.orch.createAgentCorePort();
    const runnerB = new V2AgentRunner({
      controlPlane: createControlPlane({
        clock: h.clock,
        seed: secondPort.seed,
        createHealthCore: secondPort.createHealthCore,
      }),
      gateway: secondPort.gateway,
      orchestratorPort: secondPort.port,
      clock: h.clock,
    } as V2RunnerDeps);

    await drive(
      h.clock,
      Promise.all([
        h.runner.run(
          mkRequest({ prompt: "do the alpha thing", taskRunId: "wave:node-alpha" }),
          mkIO("worker"),
        ),
        runnerB.run(
          mkRequest({ prompt: "do the beta thing", taskRunId: "wave:node-beta" }),
          mkIO("worker"),
        ),
      ]),
    );

    expect(getInsightsForTask).toHaveBeenCalledTimes(2);
    const alpha = attributed.filter((a) => a.path === "alpha.cs");
    const beta = attributed.filter((a) => a.path === "beta.cs");
    expect(alpha.length, "the alpha node produced no attributed tool result").toBeGreaterThan(0);
    expect(beta.length, "the beta node produced no attributed tool result").toBeGreaterThan(0);
    expect(
      alpha.every((a) => a.ids.length === 1 && a.ids[0] === "inst-alpha"),
      `alpha's outcome was credited to ${JSON.stringify(alpha)}`,
    ).toBe(true);
    expect(
      beta.every((b) => b.ids.length === 1 && b.ids[0] === "inst-beta"),
      `beta's outcome was credited to ${JSON.stringify(beta)}`,
    ).toBe(true);

    // Both nodes tore down their OWN set; nothing of either run is left behind.
    const store = (
      h.orch as unknown as { currentSessionInstinctIds: Map<string, string[]> }
    ).currentSessionInstinctIds;
    expect([...store.keys()]).toEqual([]);
  });
});

// ===========================================================================
// BUG#1 P2 — live plain-loop step DAG, END-TO-END through the REAL port + REAL
// MonitorLifecycle. This is the test that would have caught the DEAD-FEATURE guard
// bug (goalsDecomposed===false is true only in a synthetic runCtx; the REAL spine
// flips it in PLANNING before any tool turn). It drives the actual V2 spine and
// asserts the monitor emissions the frontend consumes.
// ===========================================================================

function mkCapturingBus(): WorkspaceBus & { calls: Array<{ event: string; payload: unknown }> } {
  const calls: Array<{ event: string; payload: unknown }> = [];
  return {
    calls,
    emit(event: string, payload: unknown) {
      calls.push({ event, payload });
    },
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceBus & { calls: Array<{ event: string; payload: unknown }> };
}

function mkGoalTree(): GoalTree {
  const rootId = "goal_root" as GoalNodeId;
  const childId = "goal_child_1" as GoalNodeId;
  const now = Date.now();
  const nodes = new Map<GoalNodeId, GoalNode>();
  nodes.set(rootId, {
    id: rootId, parentId: null, task: "Root", dependsOn: [], depth: 0,
    status: "pending", createdAt: now, updatedAt: now,
  });
  nodes.set(childId, {
    id: childId, parentId: rootId, task: "Child", dependsOn: [], depth: 1,
    status: "pending", createdAt: now, updatedAt: now,
  });
  return { rootId, sessionId: "s", taskDescription: "d", nodes, createdAt: now };
}

/** A 2-tool-batch background run: PLANNING → tool batch 1 → tool batch 2 → terminal. */
function scriptTwoBatchRun(provider: ReturnType<typeof mkScriptedProvider>): void {
  provider.chat
    .mockResolvedValueOnce(resp({ text: "plan", stopReason: "end_turn" })) // PLANNING → EXECUTING
    .mockResolvedValueOnce(
      resp({ text: "", stopReason: "tool_use", toolCalls: [{ id: "b1", name: "file_read", input: {} }] }),
    )
    .mockResolvedValueOnce(
      resp({ text: "", stopReason: "tool_use", toolCalls: [{ id: "b2", name: "edit_file", input: { path: "a.cs" } }] }),
    )
    .mockResolvedValueOnce(resp({ text: "done", stopReason: "end_turn" })); // terminal
}

describe("BUG#1 P2 — plain-loop live step DAG (REAL port + REAL MonitorLifecycle)", () => {
  it("PLAIN run (no decomposition) EMITS a step DAG: dag_init + per-batch task_update with ALIGNED ids", async () => {
    const provider = mkScriptedProvider();
    scriptTwoBatchRun(provider);
    const h = buildHarness(provider); // no goalDecomposer → runProactiveGoalDecomposition is a no-op
    const bus = mkCapturingBus();
    const lc = createMonitorLifecycle(bus);
    h.orch.setMonitorLifecycle(lc);
    // The shell opens the episode before the run (orchestrator/background-executor requestStart).
    // conversationScope for chatId "chat-1" (no conversationId) resolves to "chat-1".
    lc.requestStart("chat-1", "do the thing");
    bus.calls.length = 0; // drop the requestStart single-node dag_init; watch only the run's emissions.

    const result = await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));
    // The run reached terminal after executing its tool batches (exact terminal status is a spine
    // concern, not this test's subject — the SUBJECT is the monitor emissions below). Assert it ran.
    expect(["completed", "blocked", "failed"]).toContain(result.status);
    expect((h.tools.find((t) => t.name === "file_read")!.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalled();

    // The plain-loop DAG actually emitted — proving isPlainLoop admitted the run (goalsDecomposed was
    // true at tool-turn time) AND plainLoopStepIndex was reached and advanced per batch.
    const stepDagInits = bus.calls.filter(
      (c) => c.event === "monitor:dag_init" &&
        (c.payload as { nodes: Array<{ id: string }> }).nodes.some((n) => n.id.startsWith("step-")),
    );
    expect(stepDagInits.length).toBeGreaterThanOrEqual(1);

    // ID ALIGNMENT + the counter actually advanced: batch 0 seeded step-0; batch 1 appended step-1.
    // Two dag_inits carrying step nodes prove plainLoopStepIndex advanced 0 → 1 (two batches emitted).
    expect(stepDagInits.length).toBeGreaterThanOrEqual(2);
    const lastDag = stepDagInits[stepDagInits.length - 1]!.payload as {
      rootId: string; nodes: Array<{ id: string; status: string }>;
    };
    const declaredIds = lastDag.nodes.map((n) => n.id);
    expect(declaredIds).toEqual(["step-0", "step-1"]); // aligned, ordered id source
    // LOW-2 single source: step-0's completion is conveyed by the dag_init re-emit (topology), not a
    // redundant per-batch task_update. The final dag_init shows step-0 completed + step-1 executing.
    expect(lastDag.nodes.find((n) => n.id === "step-0")!.status).toBe("completed");
    expect(lastDag.nodes.find((n) => n.id === "step-1")!.status).toBe("executing");

    // Any step task_update that IS emitted (e.g. requestEnd settle, not called in this test) must
    // target an id a dag_init declared — no orphan node = no static-DAG bug.
    const allDeclared = new Set<string>();
    for (const d of stepDagInits) {
      for (const n of (d.payload as { nodes: Array<{ id: string }> }).nodes) allDeclared.add(n.id);
    }
    const stepUpdates = bus.calls.filter(
      (c) => c.event === "monitor:task_update" &&
        String((c.payload as { nodeId: string }).nodeId).startsWith("step-"),
    );
    for (const u of stepUpdates) {
      expect(allDeclared.has(String((u.payload as { nodeId: string }).nodeId))).toBe(true);
    }
    // All step emissions carried the EPISODE root, not a sibling.
    const episodeRoot = lastDag.rootId;
    for (const d of stepDagInits) expect((d.payload as { rootId: string }).rootId).toBe(episodeRoot);
  });

  it("DECOMPOSED run (goalDecomposed re-rooted the board) EMITS NO step nodes — stepBatch no-ops", async () => {
    const provider = mkScriptedProvider();
    scriptTwoBatchRun(provider);
    const h = buildHarness(provider);
    const bus = mkCapturingBus();
    const lc = createMonitorLifecycle(bus);
    h.orch.setMonitorLifecycle(lc);
    lc.requestStart("chat-1", "do the thing");
    // Simulate what runProactiveGoalDecomposition does in PLANNING when a real tree exists: it calls
    // monitorLifecycle.goalDecomposed BEFORE any EXECUTING tool turn. This flips dagKind → 'goal-tree'.
    lc.goalDecomposed("chat-1", mkGoalTree());
    bus.calls.length = 0;

    const result = await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));
    expect(["completed", "blocked", "failed"]).toContain(result.status);

    // NO plain-loop step nodes were emitted — the goal-tree board owns node status, so the authoritative
    // stepBatch guard suppressed every batch (even though the engine gate admitted the run).
    const stepDagInits = bus.calls.filter(
      (c) => c.event === "monitor:dag_init" &&
        (c.payload as { nodes: Array<{ id: string }> }).nodes.some((n) => n.id.startsWith("step-")),
    );
    const stepUpdates = bus.calls.filter(
      (c) => c.event === "monitor:task_update" &&
        String((c.payload as { nodeId: string }).nodeId).startsWith("step-"),
    );
    expect(stepDagInits).toHaveLength(0);
    expect(stepUpdates).toHaveLength(0);
  });

  it("SCOPE-KEY DIFFERENTIAL (conversationId !== chatId): a REAL decomposition suppresses step nodes end-to-end", async () => {
    // THE regression test for the HIGH scope-key mismatch. On the web channel the client's
    // conversationId (profileId) != chatId, so the monitor episode + stepBatch key off the RESOLVED
    // scope (profileId) while the decomposition USED to key goalDecomposed off the RAW chatId. That
    // flipped dagKind on a DIFFERENT episode than stepBatch reads → the plain-loop DAG collided with
    // the goal tree. This drives the REAL spine WITH a real goalDecomposer (shouldDecompose→true) and a
    // request whose conversationId ('profile-9') != chatId ('chat-1'), and asserts ZERO step-* nodes.
    // Pre-fix (raw chatId) this FAILS: goalDecomposed('chat-1') misses the 'profile-9' episode → step
    // nodes emit. Post-fix (resolved scope) goalDecomposed('profile-9') aligns → suppression holds.
    const provider = mkScriptedProvider();
    scriptTwoBatchRun(provider);

    // A real goalDecomposer stub: shouldDecompose true, decomposeProactive returns a real 2-node tree
    // seeded with the scope it is GIVEN (proving the decomposition path's scope == the monitor scope).
    let decomposeScope: string | undefined;
    const goalDecomposer = {
      shouldDecompose: () => true,
      decomposeProactive: async (sessionId: string) => {
        decomposeScope = sessionId;
        const t = mkGoalTree();
        return { ...t, sessionId };
      },
      decomposeReactive: async () => null,
    };

    const clock = new FakeClock(0);
    const channel = mkChannel();
    const bus = mkCapturingBus();
    const orch = new Orchestrator({
      providerManager: {
        getProvider: vi.fn(() => provider),
        getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
        shutdown: vi.fn(),
      },
      tools: [mkTool("file_read"), mkTool("edit_file", true, ["a.cs"])],
      channel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      agentCoreClock: clock,
      goalDecomposer, // REAL decomposition path fires in PLANNING (port.ts → runProactiveGoalDecomposition)
    } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
    const lc = createMonitorLifecycle(bus);
    orch.setMonitorLifecycle(lc);
    const { port, gateway, seed, createHealthCore } = orch.createAgentCorePort();
    const controlPlane = createControlPlane({ clock, seed, createHealthCore });
    const runner = new V2AgentRunner({ controlPlane, gateway, orchestratorPort: port, clock } as V2RunnerDeps);

    // The shell opens the episode under the RESOLVED scope (profileId), as the real orchestrator does.
    const RESOLVED = "profile-9"; // resolveConversationScope("chat-1", "profile-9") === "profile-9"
    lc.requestStart(RESOLVED, "do the thing");
    bus.calls.length = 0;

    const result = await drive(
      clock,
      runner.run(mkRequest({ chatId: "chat-1", conversationId: "profile-9" }), mkIO("worker")),
    );
    expect(["completed", "blocked", "failed"]).toContain(result.status);

    // The REAL decomposition fired and keyed off the RESOLVED scope (profileId), NOT the raw chatId.
    expect(decomposeScope).toBe(RESOLVED);
    // And therefore ZERO plain-loop step nodes leaked onto the goal-tree board.
    const stepDagInits = bus.calls.filter(
      (c) => c.event === "monitor:dag_init" &&
        (c.payload as { nodes: Array<{ id: string }> }).nodes.some((n) => n.id.startsWith("step-")),
    );
    const stepUpdates = bus.calls.filter(
      (c) => c.event === "monitor:task_update" &&
        String((c.payload as { nodeId: string }).nodeId).startsWith("step-"),
    );
    expect(stepDagInits).toHaveLength(0);
    expect(stepUpdates).toHaveLength(0);
  });
});
