/**
 * Agent Core v2 — Phase 1c orchestrator gate test (silenceAccumulator OFF vs ON).
 *
 * The 1c feature is the conjunction at orchestrator.ts:1178-1179:
 *   taskInactivityExceeded:
 *     this.agentCoreFlagSet?.silenceAccumulator === true && runClock.silenceCeilingExceeded(),
 * The unit tests (run-clock.phase1b.test.ts P-C block) prove the accumulator → ledger rule-4
 * stop, but they pass `taskInactivityExceeded` BY HAND and so never exercise the `&& silence
 * Accumulator === true` gate. This file drives a real `runBackgroundTask` end-to-end with an
 * injected FakeClock and a provider that goes SILENT then throws, so the gate boolean itself is
 * tested at the orchestrator boundary:
 *
 *  - Arm A — silenceAccumulator ON (the Phase-1c set): the cross-call silence accumulator crosses
 *    the task ceiling on the first failed call → ledger rule 4 → stop → the loop terminates with
 *    the `provider_abort` message after exactly ONE provider call.
 *  - Arm B — silenceAccumulator OFF (the Phase-1b set): the gate forces taskInactivityExceeded
 *    = false, so the SAME over-ceiling accumulator is INERT (rule 4 dead). The first failure is a
 *    0ms-backoff retry; the loop proceeds to a second call which succeeds and completes normally —
 *    proving the run did NOT stop on inactivity.
 *
 * Per-call timers are kept far above the silent advance (large streamInitialTimeoutMs) so the
 * CallScope's own inactivity/hard timers never fire — the ONLY thing that can stop Arm A is the
 * task-scope accumulator (the livelock fix), and the ONLY difference between the arms is the flag.
 */
import { Orchestrator } from "./orchestrator.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { FakeClock } from "../agent-core/control/clock.js";
import { DEFAULT_FLAG_SET, resolveLegalFlagSet } from "../agent-core/runner/index.js";

// ─── Logger + knowledge mocks (mirror orchestrator-runclock.phase1b.test.ts) ──

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: (params: { projectPath: string }) => ({
    content: `## Project/World Memory\nActive project root: ${params.projectPath}`,
    contentHashes: [params.projectPath],
    summary: `root=${params.projectPath} | modules=none`,
    fingerprint: `root ${params.projectPath.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase()}`,
  }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "\n## Agent Capability Manifest\n",
  buildToolUsageHints: () => "",
}));

// Per-call timers must dwarf the silent advance so the CallScope never self-aborts; the task
// silence ceiling (DEFAULT_TASK_INACTIVITY_TIMEOUT_MS=600_000, kept at the floor by a small stall
// window) is what the accumulator crosses.
const HUGE_CALL_WINDOW_MS = 10_000_000; // streamInitialTimeoutMs → callFirstResponse/stall/hard carve
const SMALL_STALL_MS = 1000; // streamStallTimeoutMs → callStallMs (keeps taskInactivity at 600_000)
const SILENT_PER_CALL_MS = 700_000; // > 600_000 ceiling on the FIRST call, < HUGE_CALL_WINDOW_MS

// ─── A non-streaming provider whose `chat` advances the FakeClock then throws/succeeds ─

function createGoSilentProvider(clock: FakeClock, opts: { succeedOnCall: number | null }) {
  let calls = 0;
  const chat = vi.fn(async (): Promise<ProviderResponse> => {
    calls += 1;
    // Advance the injected clock to simulate a long SILENT call (no tokens emitted). The
    // CallScope commits this gap to the task accumulator when `chat`'s finally runs leave().
    clock.advance(SILENT_PER_CALL_MS);
    if (opts.succeedOnCall !== null && calls >= opts.succeedOnCall) {
      return {
        text: "Done.\n**DONE**",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    }
    throw new Error("provider stalled (silent timeout)");
  });
  return {
    provider: {
      name: "mock-silent",
      capabilities: {
        maxTokens: 4096,
        streaming: false,
        structuredStreaming: false,
        toolCalling: true,
        vision: false,
        systemPrompt: true,
        thinkingSupported: false,
      },
      chat,
      // No chatStream → with streamingEnabled:false the non-streaming `chat` (CallScope) path runs.
    },
    callCount: () => calls,
    chat,
  };
}

function createMockChannel() {
  return {
    name: "mock",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    requestConfirmation: vi.fn().mockResolvedValue("Yes"),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

function makeProviderManager(provider: { name: string }) {
  return {
    getProvider: () => provider,
    getActiveInfo: () => ({ providerName: "mock-silent", model: "default", isDefault: true }),
    shutdown: vi.fn(),
  } as any;
}

const PHASE_1B_SET = resolveLegalFlagSet({
  ...DEFAULT_FLAG_SET,
  failureLedger: true,
  runClock: true,
  // silenceAccumulator stays FALSE → the gate at :1179 forces taskInactivityExceeded = false.
});

const PHASE_1C_SET = resolveLegalFlagSet({
  ...DEFAULT_FLAG_SET,
  failureLedger: true,
  runClock: true,
  silenceAccumulator: true, // ← the 1c flip that turns the gate ON.
});

// The v1-engine + full-control-plane combo ("v1-driver+full-control-plane" — the shipped
// production default until THE FLIP moved the default to v2-all-routes; it remains the
// no-redeploy v1 revert target): the proven v1 engine + ALL FOUR control-plane concerns ON.
// The per-flag tests cover 1a/1b/1c in isolation, and phase1d covers typedCancelReason as a
// pure-fn gate — but nothing drove the full four-flag combo through a live orchestrator run
// until the arms below (the revert-path backstop: the combo boots + completes, and rule-4
// precedence is intact with 1d also ON).
const V1_REVERT_TARGET_SET = resolveLegalFlagSet({
  ...DEFAULT_FLAG_SET,
  failureLedger: true,
  runClock: true,
  silenceAccumulator: true,
  typedCancelReason: true, // ← the 1d flip the per-flag tests never drive through the live loop
});

function makeOrchestrator(opts: {
  clock: FakeClock;
  provider: { name: string };
  flagSet: ReturnType<typeof resolveLegalFlagSet>;
}) {
  return new Orchestrator({
    providerManager: makeProviderManager(opts.provider),
    tools: [],
    channel: createMockChannel(),
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    streamingEnabled: false, // force the non-streaming CallScope `chat` path
    agentCoreClock: opts.clock,
    agentCoreFlagSet: opts.flagSet,
    streamInitialTimeoutMs: HUGE_CALL_WINDOW_MS,
    streamStallTimeoutMs: SMALL_STALL_MS,
  });
}

describe("Phase 1c orchestrator gate — silence accumulator OFF (inert) vs ON (stops)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ON (silenceAccumulator): a silent provider trips the task accumulator → loop stops after ONE call (rule 4)", async () => {
    const clock = new FakeClock(0);
    const p = createGoSilentProvider(clock, { succeedOnCall: null }); // always silent+throw
    const orch = makeOrchestrator({ clock, provider: p.provider, flagSet: PHASE_1C_SET });

    const result = await orch.runBackgroundTask("Analyze", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      chatId: "bg-1c-on",
      channelType: "cli",
    });

    // The accumulator crossed 600_000 on the first 700_000ms silent call → rule-4 stop.
    expect(p.callCount()).toBe(1);
    // Terminal surface is the provider_abort resilience message (the rule-4 graceful stop).
    expect(result).toMatch(/Unable to complete this task/i);
  });

  it("OFF (Phase-1b set): the SAME silent provider does NOT stop on inactivity — it proceeds and completes", async () => {
    const clock = new FakeClock(0);
    // Call 1 goes silent + throws (accumulator crosses, but the gate is OFF so rule 4 is inert);
    // call 2 succeeds → the loop completes normally instead of stopping on task-inactivity.
    const p = createGoSilentProvider(clock, { succeedOnCall: 2 });
    const orch = makeOrchestrator({ clock, provider: p.provider, flagSet: PHASE_1B_SET });

    const result = await orch.runBackgroundTask("Analyze", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      chatId: "bg-1c-off",
      channelType: "cli",
    });

    // Proof the gate kept rule 4 inert: the loop did NOT stop after the first (over-ceiling)
    // silent call — it issued a 0ms-backoff retry and called the provider a SECOND time.
    expect(p.callCount()).toBe(2);
    // And it did NOT terminate with the provider_abort message — it completed normally.
    expect(result).not.toMatch(/Unable to complete this task/i);
  });
});

describe("v1 revert target (v1-driver+full-control-plane) — the four-flag combo end-to-end", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("a clean run completes under the full four-flag control plane (the combo boots + the happy path works)", async () => {
    const clock = new FakeClock(0);
    // Succeeds on the first call → no failure → the verdict path is not hit; proves the four-flag
    // combo constructs + runs a normal task to completion (no boot/run interaction crash).
    const p = createGoSilentProvider(clock, { succeedOnCall: 1 });
    const orch = makeOrchestrator({ clock, provider: p.provider, flagSet: V1_REVERT_TARGET_SET });

    const result = await orch.runBackgroundTask("Analyze", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      chatId: "bg-prod-default-ok",
      channelType: "cli",
    });

    expect(p.callCount()).toBe(1);
    expect(result).not.toMatch(/Unable to complete this task/i); // completed, not aborted
  });

  it("the silence-accumulator stop (rule 4) STILL fires with typedCancelReason ALSO on — verdict precedence intact", async () => {
    const clock = new FakeClock(0);
    // Same silent-throw provider as the Phase-1c ON arm, but now the FULL control plane is on
    // (typedCancelReason added). The verdict path runs with typedCancelReason:true feeding the live
    // RunClock task-token reason into buildPhase1bVerdictInput — the 1d ON-gate exercised end-to-end
    // for the first time (the reason is null here, so the gate reads-live-and-finds-none, vs the
    // hardcoded-null OFF path). Rule 4 must still win on the over-ceiling silent call: adding 1d must
    // not perturb the rule-4 stop. Proves the combined four-flag default terminates correctly.
    const p = createGoSilentProvider(clock, { succeedOnCall: null });
    const orch = makeOrchestrator({ clock, provider: p.provider, flagSet: V1_REVERT_TARGET_SET });

    const result = await orch.runBackgroundTask("Analyze", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      chatId: "bg-prod-default-stop",
      channelType: "cli",
    });

    expect(p.callCount()).toBe(1); // rule-4 stop after one over-ceiling silent call (unchanged by 1d)
    expect(result).toMatch(/Unable to complete this task/i);
  });
});
