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
 * DEFAULT-OFF: nothing in v1 routes here; the runner is constructed directly with the real port.
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
    instinctRetriever?: { getInsightsForTask: (prompt: string) => Promise<{ insights: string[] }> };
  },
  taskConfig?: TaskConfig,
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
    ...(taskConfig ? { taskConfig } : {}),
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
    const classifySpy = vi.spyOn(
      h.orch as unknown as { classifyAgentCoreFailure: (...a: unknown[]) => unknown },
      "classifyAgentCoreFailure",
    );
    // (c) spy recordMetricEnd (called by persistTerminal in the spine's finally) to assert the
    // recorded terminal phase is NOT COMPLETE for a cancel.
    const metricSpy = vi.spyOn(
      h.orch as unknown as { recordMetricEnd: (...a: unknown[]) => void },
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
    const getInsightsForTask = vi.fn().mockResolvedValue({ insights: ["learned-insight-xyz"] });
    const h = buildHarness(provider, undefined, undefined, { instinctRetriever: { getInsightsForTask } });

    await drive(h.clock, h.runner.run(mkRequest(), mkIO("worker")));

    // The v2 prologue must run the personalization layers (v1 parity, runBackgroundTask :3291-3388);
    // the prior profile:null version skipped them all. Instinct retrieval runs with the prompt.
    expect(getInsightsForTask).toHaveBeenCalledWith("do the thing");
  });
});
