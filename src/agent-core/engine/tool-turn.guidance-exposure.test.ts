/**
 * ROUND 12 #9 (producer half) — THE MID-RUN RE-RETRIEVAL DATES ITS OWN EXPOSURE.
 *
 * `noteGuidanceShown` exists so the credit ledger's exposure column is the moment
 * the guidance entered the prompt. The tool turn's STEP G is one of the two places
 * that moment happens: a mid-run re-retrieval merges NEW instinct ids into the
 * run's participating set, and from then on every tool:result carries them. Until
 * this test the engine told nobody, so the ledger dated those exposures from the
 * tool event instead — and, since tool events ride the learning queue, a rule
 * retired in between read as "applied AFTER it was retired".
 *
 * The assertion is against a REAL LearningPipeline and a real credit row: the
 * exposure must be the merge moment, not the event's own timestamp and not the
 * moment the event was processed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portExecuteToolTurn, type ToolTurnDeps } from "./tool-turn.js";
import type { EngineRunContext } from "./engine-deps.js";
import { createInitialState } from "../../agents/agent-state.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { ToolCall, ToolResult } from "../../agents/providers/provider.interface.js";
import { LearningStorage } from "../../learning/storage/learning-storage.js";
import { LearningPipeline } from "../../learning/pipeline/learning-pipeline.js";
import type { Instinct } from "../../learning/types.js";
import type { ToolResultEvent } from "../../core/event-bus.js";
import type { TimestampMs } from "../../types/index.js";

const CHAT = "chat-1";
const RUN = "run-mid-retrieval";
const INSTINCT = "instinct_mid_run";

let dir: string;
let storage: LearningStorage;
let pipeline: LearningPipeline;

function makeDeps(overrides?: Partial<ToolTurnDeps>): ToolTurnDeps {
  return {
    sessionManager: { extractLastUserMessage: () => "do the thing" },
    executeToolCalls: async (_chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> =>
      toolCalls.map((tc) => ({ toolCallId: tc.id, content: "ok", isError: false }) as unknown as ToolResult),
    emitToolResult: vi.fn(),
    buildToolBatchProgressSignal: () => undefined as never,
    emitPlainLoopStep: vi.fn(),
    consensusManager: undefined,
    confidenceEstimator: undefined,
    providerRouter: undefined,
    providerManager: {} as never,
    taskClassifier: {} as never,
    getSupervisorRoutingContext: () => ({}) as never,
    currentSessionInstinctIds: new Map<string, string[]>(),
    getTaskExecutionContext: () => ({ taskRunId: RUN }),
    ...overrides,
  } as unknown as ToolTurnDeps;
}

function makeRunCtx(overrides?: Partial<EngineRunContext>): EngineRunContext {
  const bundle = createAutonomyBundle({ prompt: "do the thing", iterationBudget: 20 });
  return {
    onUsage: undefined,
    iterationHealth: new IterationHealthTracker(Date.now()),
    healthAdapter: {} as never,
    session: { messages: [], conversationScope: "conv-1" } as never,
    chatId: CHAT,
    metricId: undefined,
    toolExecMode: "interactive",
    workspaceLease: undefined,
    goalContext: undefined,
    executionJournal: bundle.executionJournal,
    selfVerification: bundle.selfVerification,
    stradaConformance: bundle.stradaConformance,
    errorRecovery: bundle.errorRecovery,
    taskPlanner: bundle.taskPlanner,
    controlLoopTracker: bundle.controlLoopTracker ?? undefined,
    systemPrompt: "sys",
    goalsDecomposed: false,
    identityKey: "id-1",
    userId: "user-1",
    conversationScope: "conv-1",
    executionStrategy: undefined,
    lastAssignment: { providerName: "p", modelId: "m" } as never,
    lastToolNames: [],
    lastProviderCapabilities: undefined,
    cumulativeOutputTokens: 0,
    taskStartedAtMs: Date.now(),
    progressLanguage: "en" as never,
    progressTitle: "Task",
    emitProgress: () => {},
    workerCollector: undefined,
    profileLanguage: undefined,
    joinsParentEpisode: false,
    workerMonitorScope: undefined,
    memoryRefresher: null,
    fixedExecutionStrategy: undefined,
    plainLoopStepIndex: 0,
    ...overrides,
  } as unknown as EngineRunContext;
}

/** A re-retrieval that fires once and hands back one NEW instinct id. */
function memoryRefresherShowing(instinctId: string, onShown: () => void) {
  return {
    shouldRefresh: async () => ({ should: true, reason: "drift", cosineDistance: 0.9 }),
    refresh: async () => {
      onShown();
      return {
        triggered: true,
        newInsights: [`use ${instinctId}`],
        newInstinctIds: [instinctId],
      };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tool-turn-exposure-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  storage.createInstinct({
    id: INSTINCT as Instinct["id"],
    name: "mid-run rule",
    type: "error_fix",
    status: "active",
    confidence: 0.8,
    triggerPattern: "CS0246",
    action: "Add the using directive",
    contextConditions: [],
    stats: { timesSuggested: 2, timesApplied: 2, timesFailed: 0, successRate: 1, averageExecutionMs: 5 },
    createdAt: Date.now() as TimestampMs,
    updatedAt: Date.now() as TimestampMs,
    sourceTrajectoryIds: [],
    tags: [],
  } as Instinct);
  pipeline = new LearningPipeline(storage, {
    enabled: true,
    detectionIntervalMs: 1000,
    evolutionIntervalMs: 5000,
    minConfidenceForCreation: 0.5,
    batchSize: 5,
  });
});

afterEach(() => {
  pipeline.stop();
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("portExecuteToolTurn reports the mid-run re-retrieval's exposure (r12 #9)", () => {
  it("PROOF: the credit row is dated from the merge, not from the tool event or its processing", async () => {
    let shownAt = 0;
    const deps = makeDeps({
      noteGuidanceShown: (chatId, instinctIds, taskRunId) =>
        pipeline.noteGuidanceShown({
          sessionId: chatId,
          instinctIds,
          ...(taskRunId ? { taskRunId } : {}),
        }),
    });
    const runCtx = makeRunCtx({
      memoryRefresher: memoryRefresherShowing(INSTINCT, () => {
        shownAt = Date.now();
      }) as unknown as EngineRunContext["memoryRefresher"],
    });

    await portExecuteToolTurn(
      deps,
      [
        [{ id: "tc-1", name: "edit_file", input: {} } as unknown as ToolCall],
        undefined,
        createInitialState("do the thing"),
        "the plan text",
      ],
      runCtx,
    );

    // The merge happened, and the run's participating set carries the new id —
    // which is what makes every later tool:result claim it was applied.
    expect(shownAt, "the re-retrieval never ran").toBeGreaterThan(0);
    expect([...deps.currentSessionInstinctIds.values()].flat()).toContain(INSTINCT);

    // In production the event is handled on the serial learning queue, so it is
    // processed measurably later than the prompt it came from. Its own timestamp
    // is pushed far out, so a row dated from EITHER of those two clocks is
    // unmistakable.
    await new Promise((r) => setTimeout(r, 40));
    const processedAt = Date.now();
    await pipeline.handleToolResult({
      sessionId: CHAT,
      taskRunId: RUN,
      toolName: "edit_file",
      input: {},
      output: "ok",
      success: true,
      appliedInstinctIds: [INSTINCT],
      timestamp: processedAt + 60_000,
    } as ToolResultEvent);
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, RUN);

    const rows = storage.getInstinctCredits({ instinctId: INSTINCT });
    expect(rows, "the run left no credit row at all").toHaveLength(1);
    const exposedAt = rows[0]!.exposedAt;
    expect(exposedAt, "no exposure was recorded").toBeDefined();
    // TEETH: before the wiring the engine told nobody, so this was the event's
    // own timestamp (processedAt + 60s).
    expect(exposedAt!).toBeGreaterThanOrEqual(shownAt);
    expect(exposedAt!, "the exposure was dated from the event, not the prompt").toBeLessThan(processedAt);
  });

  it("GUARD: a deps object with no exposure seam still runs the turn and still credits the run", async () => {
    // The seam is optional on purpose: every other caller of portExecuteToolTurn
    // (and every test harness) keeps working, and the ledger falls back to the
    // event's own in-run timestamp rather than losing the row.
    const deps = makeDeps();
    const runCtx = makeRunCtx({
      memoryRefresher: memoryRefresherShowing(INSTINCT, () => {}) as unknown as EngineRunContext["memoryRefresher"],
    });

    const result = await portExecuteToolTurn(
      deps,
      [
        [{ id: "tc-1", name: "edit_file", input: {} } as unknown as ToolCall],
        undefined,
        createInitialState("do the thing"),
        "the plan text",
      ],
      runCtx,
    );
    expect(result).toBeDefined();

    const at = Date.now();
    await pipeline.handleToolResult({
      sessionId: CHAT,
      taskRunId: RUN,
      toolName: "edit_file",
      input: {},
      output: "ok",
      success: true,
      appliedInstinctIds: [INSTINCT],
      timestamp: at,
    } as ToolResultEvent);
    pipeline.clearRunInstinctCredits(CHAT, { success: true }, RUN);

    const rows = storage.getInstinctCredits({ instinctId: INSTINCT });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exposedAt).toBe(at);
  });
});
