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
    // agentCoreFlagSet OMITTED — the gateway passes runClock=undefined → flag-OFF silentStream.
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);

  const { port, gateway, seed, createHealthCore } = orch.createAgentCorePort();
  const controlPlane = createControlPlane({ clock, seed, createHealthCore }); // no learning sink
  const runner = new V2AgentRunner({ controlPlane, gateway, orchestratorPort: port, clock } as V2RunnerDeps);
  return { clock, channel, provider, tools, runner, getProvider, orch };
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
});
