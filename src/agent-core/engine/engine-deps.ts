/**
 * Agent Core v2 — Engine dependency surface (relocation Step 0; blueprint:
 * project_v2_engine_relocation). `EngineRunContext` is the per-run state struct the port closes
 * over (moved VERBATIM from orchestrator.ts's AgentCorePortRunContext — orchestrator.ts re-exports
 * the old name during the transition). `EngineDeps` is the DI boundary the AgentEngine consumes;
 * it GROWS per relocation step (services move in with the methods that read them) — fields are
 * added when their first consumer method relocates, never speculatively.
 *
 * Import rule (cycle safety): this module may import any orchestrator-FREE `src/agents/*` leaf
 * (session-manager, intervention-pipeline, supervisor types, autonomy trackers, …) but NEVER
 * `orchestrator.ts` or anything that pulls it (agent-manager, delegation-manager — inject those
 * through EngineDeps instead).
 */

import type { TaskProgressUpdate, TaskUsageEvent } from "../../tasks/types.js";
import type { Attachment } from "../../channels/channel-messages.interface.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { Session, SessionManager } from "../../agents/orchestrator-session-manager.js";
import type { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { IterationHealthCoreAdapter } from "../control/iteration-health-core-adapter.js";
import type { WorkspaceLease } from "../../agents/supervisor/supervisor-types.js";
import type {
  SupervisorAssignment,
  SupervisorExecutionStrategy,
} from "../../agents/orchestrator-supervisor-routing.js";
import type { WorkerRunCollector } from "../../agents/orchestrator-intervention-pipeline.js";

/** v1 ToolExecutionMode parity (module-local in orchestrator/intervention-pipeline; engine copy). */
export type ToolExecutionMode = "interactive" | "background" | "delegated";
import type { ProgressLanguage } from "../../tasks/progress-signals.js";
import type { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";

/**
 * Per-run state the OrchestratorPort closes over. Populated by the engine setup (today still Orchestrator.setupAgentCoreRun);
 * the V2 spine never touches it. Mutable on the few fields prepareIteration refreshes each step.
 */
export interface EngineRunContext {
  onUsage?: (usage: TaskUsageEvent) => void;
  readonly iterationHealth: IterationHealthTracker;
  readonly healthAdapter: IterationHealthCoreAdapter;
  readonly session: Session;
  readonly chatId: string;
  readonly metricId: string | undefined;
  /** Tool-execution mode for the bound executeToolCalls turn (v1 ToolExecutionMode parity). */
  readonly toolExecMode: ToolExecutionMode;
  // Worker isolation + supervisor linkage (threaded into executeOptions + the result projection).
  readonly workspaceLease?: WorkspaceLease;
  readonly workspaceLeaseRetained?: boolean;
  readonly goalContext?: { readonly rootId: string; readonly nodeId: string };
  readonly executionJournal: ReturnType<typeof createAutonomyBundle>["executionJournal"];
  readonly selfVerification: ReturnType<typeof createAutonomyBundle>["selfVerification"];
  readonly stradaConformance: ReturnType<typeof createAutonomyBundle>["stradaConformance"];
  readonly errorRecovery: ReturnType<typeof createAutonomyBundle>["errorRecovery"];
  readonly taskPlanner: ReturnType<typeof createAutonomyBundle>["taskPlanner"];
  readonly controlLoopTracker: NonNullable<ReturnType<typeof createAutonomyBundle>["controlLoopTracker"]> | undefined;
  systemPrompt: string;
  /**
   * H2: per-run guard so proactive goal decomposition runs AT MOST ONCE (v1 parity).
   * v1 decomposes on the first PLANNING then transitions to EXECUTING; the v2 spine
   * re-enters PLANNING on every epoch rollover, which without this guard re-runs
   * decomposeProactive → a FRESH goal tree (dag_init) each epoch, discarding progress
   * and spraying the DAG/Kanban monitor. Flipped true by the decomposeGoalsIfPlanning binding.
   */
  goalsDecomposed: boolean;
  readonly identityKey: string;
  // Step 3 (3.5/3.6) — the interactive PLANNING-phase divergences need these: `userId` for the
  // autonomous-mode check (3.5 plan-review gate); `channelType`/`attachments`/`conversationScope`
  // for the goal→background submit (3.6). Threaded from AgentRunSetupInput; undefined on paths that
  // don't supply them (the divergences are interactive-only, where they are always set).
  readonly userId?: string;
  readonly channelType?: string;
  readonly attachments?: readonly Attachment[];
  readonly conversationScope?: string;
  readonly projectWorldFingerprint?: string;
  // Refreshed each step by prepareIteration (the handler contexts read them).
  executionStrategy: SupervisorExecutionStrategy | undefined;
  lastAssignment: SupervisorAssignment | undefined;
  lastToolNames: string[];
  lastProviderCapabilities: IAIProvider["capabilities"] | undefined;
  // 3.3: cumulative OUTPUT tokens for the interactive live token-budget gate (v1's cumulativeOutputTokens,
  // orchestrator.ts:5209). Accumulated in recordProviderUsage; read by checkInteractiveBudget. Output-only
  // — input re-counts the growing context each iteration and would kill a stable working set (audit #3).
  cumulativeOutputTokens: number;
  readonly taskStartedAtMs: number;
  readonly progressLanguage: ProgressLanguage;
  readonly progressTitle: string;
  readonly emitProgress: (update: TaskProgressUpdate) => void;
  readonly workerCollector: WorkerRunCollector | undefined;
  readonly profileLanguage: string | undefined;
  // v1 parity (runBackgroundTask :3549-3550): a worker carrying a parent monitorScope joins the
  // parent whole-goal episode (joinEpisode at setup, joinEpisodeEnd at persistTerminal) instead
  // of opening a sibling monitor workspace. False/undefined on interactive + scope-less runs.
  readonly joinsParentEpisode: boolean;
  readonly workerMonitorScope: string | undefined;
  /** step5-parity: v1 refreshed memory per tool turn via this refresher (mid-run re-retrieval);
   *  the port's tool turn threads it into refreshMemoryIfNeeded exactly as the v1 loops did. */
  readonly memoryRefresher: ReturnType<SessionManager["createMemoryRefresher"]> | null;
  /** step5-parity: the supervisor provider pin's fixed all-roles strategy (undefined = unpinned). */
  readonly fixedExecutionStrategy: SupervisorExecutionStrategy | undefined;
}

import type { AccountingDeps } from "./accounting.js";
import type { BudgetDeps } from "./budget.js";
import type { PrepareIterationDeps } from "./prepare-iteration.js";
import type { SynthesisDeps } from "./synthesis.js";
import type { ReviewDeps } from "./review.js";
import type { RenderDeps } from "./render.js";

/**
 * The DI boundary for the relocated engine. Grows per relocation step (each module contributes
 * its Deps slice). Mutable setter-backed orchestrator fields (taskManager, workspaceBus,
 * checkpointStore, unifiedBudgetManager, capabilityRegistry) must be injected as LAZY GETTERS,
 * never by-value.
 */
export interface EngineDeps
  extends AccountingDeps,
    BudgetDeps,
    PrepareIterationDeps,
    SynthesisDeps,
    ReviewDeps,
    RenderDeps {}
