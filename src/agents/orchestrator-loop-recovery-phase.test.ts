/**
 * The loop recovery delegates only to a tool that runs in the phase it runs it in.
 *
 * The run's tool list is the same in every phase (agent-core/engine/phase-write-access.ts), so
 * while reflecting it names the delegate tools, which are writes (isReadOnly: false). The loop
 * recovery picked one from that list and ran it with the reflecting state; the gate refused it,
 * and the refusal was recorded as the delegated diagnosis: the gate the model read, a journal
 * insight (which reaches later prompts), a worker-trace row and a "Loop recovery delegation"
 * progress line (QA, 2026-11-11). While the list still followed the phase it held no delegate
 * tool there, and the recovery fell back to the hard-cap gate.
 *
 * These run with the real orchestrator: its tool list, its intervention deps, its gate and its
 * phase rule. While reflecting, through the reflection handler's continue path; while executing,
 * through the loop recovery the end-turn handler calls.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { AgentPhase, createInitialState, type AgentState } from "./agent-state.js";
import { handleBgReflectionContinue, type BgReflectionContext } from "./orchestrator-reflection-handler.js";
import {
  handleBackgroundLoopRecovery,
  type InterventionDeps,
  type WorkerRunCollector,
} from "./orchestrator-intervention-pipeline.js";
import { ControlLoopTracker } from "./autonomy/control-loop-tracker.js";
import { ExecutionJournal } from "./autonomy/execution-journal.js";
import { SelfVerification } from "./autonomy/self-verification.js";
import { phaseWriteRefusal } from "../agent-core/engine/phase-write-access.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const DIAGNOSIS = "The loop re-reads the same file; write the handler next.";

function tool(name: string, mutates: boolean, content: string) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    // As the delegation tool declares itself (delegation-tool.ts).
    metadata: { name, description: name, isReadOnly: !mutates, requiresConfirmation: false },
    execute: vi.fn().mockResolvedValue({ content }),
  };
}

let orch: Orchestrator;
let delegate: ReturnType<typeof tool>;

beforeEach(() => {
  delegate = tool("delegate_analysis", true, DIAGNOSIS);
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [delegate, tool("file_read", false, "read")] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
  });
});

const internals = () =>
  orch as unknown as {
    buildInterventionDeps: () => InterventionDeps;
    buildWorkerToolDefinitions: (task: unknown) => Array<{ name: string }>;
  };

const task = { type: "code_generation", complexity: "simple", criticality: "normal" };

/** What a text-only stall hands the loop recovery: a tracker one gate from its hard cap, and records. */
function stalled() {
  const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 99, hardCapReplan: 2, hardCapBlock: 6 });
  tracker.incrementTextOnlyGate();
  return {
    tracker,
    journal: new ExecutionJournal("Fix the handler"),
    workerCollector: { toolTrace: [], childWorkerResults: [] } as WorkerRunCollector,
    progress: [] as string[],
    session: { messages: [] as unknown[] },
    toolNames: internals().buildWorkerToolDefinitions(task).map((d) => d.name),
  };
}

const progressText = (update: unknown): string =>
  typeof update === "string" ? update : String((update as { message?: string }).message ?? "");

/** A reflection that asked to continue, with nothing to say and no tool call. */
async function reflectionContinuesWithoutTools() {
  const { tracker, journal, workerCollector, progress, session, toolNames } = stalled();
  const state: AgentState = { ...createInitialState("Fix the handler"), phase: AgentPhase.REFLECTING };
  const ctx = {
    chatId: "chat1",
    identityKey: "id-1",
    prompt: "Fix the handler",
    responseText: "",
    executionStrategy: {
      task,
      executor: { providerName: "mock", modelId: "m" },
      reviewer: { providerName: "mock", modelId: "m", provider: createMockProvider() },
      synthesizer: { providerName: "mock", modelId: "m" },
    },
    executionJournal: journal,
    selfVerification: new SelfVerification(),
    taskStartedAtMs: Date.now() - 5_000,
    currentToolNames: toolNames,
    interventionDeps: internals().buildInterventionDeps(),
    session,
    controlLoopTracker: tracker,
    workerCollector,
    progressTitle: "Fix the handler",
    progressLanguage: "en",
    iteration: 1,
    workspaceLease: undefined,
    progressAssessmentEnabled: false,
    usageHandler: undefined,
    emitProgress: (update: unknown) => progress.push(progressText(update)),
    buildStructuredProgressSignal: (_p: string, _t: string, signal: { message?: string }) => signal,
  } as unknown as BgReflectionContext;

  const action = await handleBgReflectionContinue(state, ctx, 0);
  const gate = session.messages.map((m) => JSON.stringify(m)).join("\n");
  return { action, toolNames, gate, journal, workerCollector, progress };
}

/** The loop recovery of a stall while executing, as the end-turn handler calls it. */
async function executingStallRecovers() {
  const { tracker, journal, workerCollector, progress, session, toolNames } = stalled();
  const result = await handleBackgroundLoopRecovery(
    {
      chatId: "chat1",
      identityKey: "id-1",
      prompt: "Fix the handler",
      title: "Fix the handler",
      state: { ...createInitialState("Fix the handler"), phase: AgentPhase.EXECUTING },
      strategy: {
        task,
        executor: { providerName: "mock", modelId: "m" },
        reviewer: { providerName: "mock", modelId: "m", provider: createMockProvider() },
        synthesizer: { providerName: "mock", modelId: "m" },
      } as never,
      tracker,
      executionJournal: journal,
      kind: "reflection_continue",
      reason: "Continued without tool execution.",
      gate: "Please continue.",
      iteration: 1,
      availableToolNames: toolNames,
      selfVerification: new SelfVerification(),
      onProgress: (update) => progress.push(progressText(update)),
      session: session as never,
      workerCollector,
      daemonMode: true,
      progressAssessmentEnabled: false,
    },
    internals().buildInterventionDeps(),
  );
  return { gate: result.gate ?? "", journal, workerCollector, progress };
}

describe("loop recovery while reflecting, with the delegate tools in the run's list", () => {
  it("the run's tool list holds the delegate tool in every phase", () => {
    expect(internals().buildWorkerToolDefinitions(task).map((d) => d.name)).toContain("delegate_analysis");
  });

  it("delegates nothing: no refusal as a diagnosis, journal insight, worker-trace row or progress line", async () => {
    const r = await reflectionContinuesWithoutTools();

    expect(r.toolNames).toContain("delegate_analysis");
    expect(delegate.execute, "the gate's refusal was taken for a run").not.toHaveBeenCalled();
    expect(r.gate).not.toContain("Delegated diagnosis");
    expect(r.gate).not.toContain(phaseWriteRefusal(AgentPhase.REFLECTING));
    expect(r.gate).toContain("[HARD CAP]");
    expect(r.journal.snapshot().learnedInsights.filter((i) => i.startsWith("Delegated"))).toEqual([]);
    expect(r.workerCollector.toolTrace).toEqual([]);
    expect(r.progress.filter((m) => m.startsWith("Loop recovery delegation"))).toEqual([]);
  });

  it("while executing, the same list delegates as before and the diagnosis is the delegate's", async () => {
    const r = await executingStallRecovers();

    expect(delegate.execute).toHaveBeenCalledTimes(1);
    expect(r.gate).toContain("Delegated diagnosis");
    expect(r.gate).toContain(DIAGNOSIS);
    expect(r.journal.snapshot().learnedInsights).toContain(`Delegated analysis diagnosis: ${DIAGNOSIS}`);
    expect(r.workerCollector.toolTrace.map((t) => [t.toolName, t.success])).toEqual([["delegate_analysis", true]]);
    expect(r.progress).toContain("Loop recovery delegation: delegate_analysis");
  });
});
