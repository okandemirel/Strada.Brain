/**
 * Learning Pipeline - Core learning engine for pattern detection and instinct creation
 * 
 * Processes observations, creates instincts, and manages evolution of learned patterns.
 */

import { randomUUID } from "node:crypto";
import { sanitizePromptInjection } from "../../agents/orchestrator-text-utils.js";
import { LearningStorage } from "../storage/learning-storage.js";
import { ConfidenceScorer, EVIDENCE_WEIGHTS, getVerdictScore } from "../scoring/confidence-scorer.js";
import { getLoggerSafe } from "../../utils/logger.js";
import { PatternMatcher } from "../matching/pattern-matcher.js";
import { RuntimeArtifactManager } from "../runtime-artifact-manager.js";
import type { ToolResultEvent, FeedbackReactionEvent, IEventBus, LearningEventMap } from "../../core/event-bus.js";
import { FeedbackHandler } from "../feedback/feedback-handler.js";
import { EmbeddingQueue } from "./embedding-queue.js";
import type { IEmbeddingProvider } from "../../rag/rag.interface.js";
import {
  DEFAULT_LEARNING_CONFIG,
  type Instinct,
  type InstinctId,
  type Trajectory,
  type TrajectoryId,
  type TrajectoryStep,
  type TrajectoryOutcome,
  type Observation,
  type ObservationId,
  type ErrorPattern,
  type ErrorPatternId,
  type Verdict,
  type VerdictId,
  type VerdictDimensions,
  type EvolutionProposal,
  type LearningConfig,
  type ErrorDetails,
  type InstinctType,
  type ContextCondition,
  type ContextConditionId,
  type RuntimeArtifact,
  type BayesianConfig,
  type InstinctLifecycleEvent,
  type ScopeType,
  type CorrectionRecord,
  CONFIDENCE_THRESHOLDS,
  createInstinctId,
} from "../types.js";
import { createBrand, type ToolName, type TimestampMs, type JsonObject } from "../../types/index.js";
import { seedAllFrameworkConventions } from "../seeds/framework-seeds.js";

const VERDICT_SCORE = {
  HIGH: 0.7,
  PERFECT: 1.0,
};

/** Default confidence system config used when none is provided */
const DEFAULT_BAYESIAN_CONFIG: BayesianConfig = {
  enabled: true,
  deprecatedThreshold: 0.3,
  activeThreshold: 0.7,
  evolutionThreshold: 0.9,
  autoEvolveThreshold: 0.95,
  maxInitial: 0.5,
  coolingPeriodDays: 7,
  coolingMinObservations: 10,
  coolingMaxFailures: 3,
  promotionMinObservations: 25,
  verdictCleanSuccess: 0.9,
  verdictRetrySuccess: 0.6,
  verdictFailure: 0.2,
};

// ─── LearningPipeline Class ──────────────────────────────────────────────────

export class LearningPipeline {
  private storage: LearningStorage;
  private confidenceScorer: ConfidenceScorer;
  private patternMatcher: PatternMatcher;
  private readonly runtimeArtifacts: RuntimeArtifactManager;
  private config: LearningConfig;
  private bayesianConfig: BayesianConfig;
  private eventBus: IEventBus<LearningEventMap> | null = null;
  private readonly feedbackHandler: FeedbackHandler;
  private embeddingQueue: EmbeddingQueue | null = null;
  private evolutionTimer: ReturnType<typeof setInterval> | null = null;
  private feedbackReactionListener: ((event: FeedbackReactionEvent) => void) | null = null;
  private periodicTimer?: ReturnType<typeof setInterval>;
  private isRunning = false;

  private static readonly RESOLUTION_LINK_WINDOW_MS = 5 * 60 * 1000;
  private static readonly STALE_RESOLUTION_THRESHOLD_MS = 10 * 60 * 1000;

  private recentObservations: Array<{
    toolName: string; errorPattern?: string; timestamp: number;
  }> = [];

  /** Tracks pending error resolutions: `${sessionId}:${toolName}` → error observation data */
  private pendingResolutions = new Map<string, {
    errorObservation: Observation;
    toolName: string;
    errorOutput: string;
    timestamp: number;
  }>();

  /**
   * LIVING VAULT (C) — optional injected note-writer for the learning↔vault
   * bridge. When set (bootstrap wires it after the dev-knowledge vault is
   * registered), high-confidence instinct creations and clean-success verdicts
   * are mirrored as human-readable notes into the dev-knowledge vault. The
   * dependency is INTERFACE-ONLY (defined in src/vault/), so there is no
   * runtime src/learning -> src/vault import — no import cycle. Unset (default,
   * and in all unit tests that don't wire it) ⇒ every bridge call is a
   * null-guarded no-op ⇒ byte-identical to prior behavior.
   */
  private noteWriter?: import("../../vault/dev-knowledge-writer.js").DevKnowledgeNoteWriter;
  /** Per-id dedup set so the same instinct/verdict is not re-noted within a process. */
  private readonly notedIds = new Set<string>();

  /** Project path for scope-aware instinct creation (Phase 13) */
  private projectPath?: string;
  /** Scope promotion threshold (Phase 13): distinct projects needed for universal promotion */
  private promotionThreshold = 3;

  /**
   * audited 2026-09-02: per-run credit ledger, keyed by the run's sessionId (= chatId).
   * The orchestrator tags EVERY tool:result of a run with the whole set retrieved
   * ONCE at run start, so an instinct retrieved once was being credited once per
   * tool call — 60 calls read as "applied 60x", and 13 failing unrelated calls
   * deprecated a healthy teaching. An instinct is now credited at most once per
   * run per tool it governs; the orchestrator clears the run's ledger at teardown
   * ({@link clearRunInstinctCredits}) alongside currentSessionInstinctIds.
   */
  private readonly runCreditedInstinctIds = new Map<string, Set<string>>();

  /** Run teardown: forget which instincts this run already credited. */
  clearRunInstinctCredits(sessionId: string): void {
    this.runCreditedInstinctIds.delete(sessionId);
  }

  constructor(
    storage: LearningStorage,
    config: Partial<LearningConfig> = {},
    embeddingProvider?: IEmbeddingProvider,
    bayesianConfig?: BayesianConfig,
    eventBus?: IEventBus<LearningEventMap>,
  ) {
    this.storage = storage;
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
    this.bayesianConfig = bayesianConfig ?? DEFAULT_BAYESIAN_CONFIG;
    this.confidenceScorer = new ConfidenceScorer();
    this.patternMatcher = new PatternMatcher(storage);
    this.runtimeArtifacts = new RuntimeArtifactManager(storage);
    this.eventBus = eventBus ?? null;
    // audited 2026-09-02: reactions must reach the stored confidence the
    // lifecycle, ranking and intervention tier read — not only factor_* columns.
    this.feedbackHandler = new FeedbackHandler(storage, {
      onReaction: (instinct, positive) => this.applyReactionEvidence(instinct, positive),
    });

    if (embeddingProvider) {
      this.embeddingQueue = new EmbeddingQueue(embeddingProvider, storage);
    }

    // Subscribe to feedback:reaction events from channel adapters
    if (this.eventBus) {
      this.feedbackReactionListener = (event: FeedbackReactionEvent) => {
        if (event.type === "thumbs_up") {
          this.feedbackHandler.handleThumbsUp({
            instinctIds: event.instinctIds,
            userId: event.userId,
            source: event.source,
          });
        } else if (event.type === "thumbs_down") {
          this.feedbackHandler.handleThumbsDown({
            instinctIds: event.instinctIds,
            userId: event.userId,
            source: event.source,
          });
        }
      };
      this.eventBus.on("feedback:reaction", this.feedbackReactionListener);
    }
  }

  /** Set the project path for scope-aware instinct creation (Phase 13) */
  setProjectPath(path: string): void {
    this.projectPath = path;
  }

  /** Set the promotion threshold for scope promotion (Phase 13) */
  setPromotionThreshold(threshold: number): void {
    this.promotionThreshold = threshold;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.isRunning || !this.config.enabled) return;

    this.isRunning = true;

    // Seed Strada.Core conventions on every boot (idempotent — skips existing patterns)
    seedAllFrameworkConventions(this.storage).catch((_err) => {
      // Seed errors are non-fatal — conventions will be seeded on next boot
    });

    // Detection timer removed -- event-driven processing via handleToolResult() replaces it.
    // Drain any leftover unprocessed observations from previous sessions on startup.
    void this.runDetectionBatch().catch(() => { /* non-critical startup drain */ });

    this.evolutionTimer = setInterval(() => this.tickEvolution(), this.config.evolutionIntervalMs);

    // Periodic trajectory extraction — use detection interval from config
    const periodicMs = this.config.detectionIntervalMs;
    this.periodicTimer = setInterval(() => {
      void this.tickPeriodicExtraction();
    }, periodicMs);
  }

  /**
   * Evolution tick with error isolation. An unguarded throw in a setInterval
   * callback escapes to the process and the global uncaughtException handler
   * shuts the whole daemon down, so swallow it (non-fatal; the next tick retries).
   */
  private tickEvolution(): void {
    try {
      this.runEvolution();
    } catch {
      /* evolution tick errors are non-fatal; the next tick retries */
    }
  }

  /**
   * Periodic-extraction tick with error isolation. runPeriodicExtraction is
   * async, so an unguarded rejection from the setInterval callback becomes an
   * unhandledRejection — which the process-level handler escalates to a full
   * daemon shutdown (src/index.ts). Swallow it (non-fatal; the next tick retries).
   */
  private tickPeriodicExtraction(): Promise<void> {
    return this.runPeriodicExtraction().catch(() => {
      /* periodic-extraction tick errors are non-fatal; the next tick retries */
    });
  }

  stop(): void {
    if (this.embeddingQueue) {
      this.embeddingQueue.shutdown();
    }
    this.isRunning = false;
    if (this.evolutionTimer) {
      clearInterval(this.evolutionTimer);
      this.evolutionTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    if (this.eventBus && this.feedbackReactionListener) {
      this.eventBus.off("feedback:reaction", this.feedbackReactionListener);
      this.feedbackReactionListener = null;
    }
  }

  // ─── Observation Methods ─────────────────────────────────────────────────────

  observeToolUse(params: {
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
    output: string;
    success: boolean;
    errorDetails?: ErrorDetails;
  }): void {
    // Note: observation recording is handled by handleToolResult() via the event bus.
    // Only record error patterns here to avoid double-writing observations.
    if (!params.success && params.errorDetails) {
      this.recordErrorPattern(params.errorDetails, params.toolName);
    }
  }

  async observeCorrection(params: {
    sessionId: string;
    toolName: string;
    originalInput: Record<string, unknown>;
    originalOutput: string;
    correctedOutput: string;
    correction: string;
  }): Promise<void> {
    const observation: Observation = {
      id: `obs_${randomUUID()}` as ObservationId,
      type: "correction",
      sessionId: createBrand(params.sessionId, "SessionId" as const),
      toolName: createBrand(params.toolName, "ToolName" as const),
      input: params.originalInput as JsonObject,
      output: params.originalOutput,
      correction: params.correction,
      timestamp: Date.now() as TimestampMs,
      // audited 2026-09-02: instinct creation runs inline right below, so the
      // row is processed at write time. Left at false it was never marked, and
      // the startup drain replayed it into a second, different instinct.
      processed: true,
    };

    this.storage.recordObservation(observation);
    this.storage.flush();

    await this.considerInstinctCreation({
      type: "correction",
      triggerPattern: this.extractTriggerPattern(params.originalOutput),
      action: params.correction,
      toolName: params.toolName,
    });
  }

  // ─── Event-Driven Processing ─────────────────────────────────────────────────

  /**
   * Handle a tool result event from the event bus.
   * Runs the full pipeline per event: observe -> process -> confidence update.
   * Replaces the batch detection timer for per-event learning.
   */
  async handleToolResult(event: ToolResultEvent): Promise<void> {
    // 1. Build observation in-memory (avoids write→read DB round-trip)
    const observation: Observation = {
      id: `obs_${randomUUID()}` as ObservationId,
      type: event.success ? "success" : "error",
      sessionId: createBrand(event.sessionId, "SessionId" as const),
      toolName: createBrand(event.toolName, "ToolName" as const),
      input: event.input as JsonObject,
      output: event.output,
      success: event.success,
      errorDetails: event.errorDetails as ErrorDetails | undefined,
      timestamp: Date.now() as TimestampMs,
      processed: false,
    };

    // 2. Persist and process in-memory (skip getUnprocessedObservations read-back)
    this.storage.recordObservation(observation);

    // Track error→resolution chains.
    // audited 2026-09-02: the map was keyed on tool name alone, so with several
    // sessions sharing one pipeline, session A's failure was "resolved" by
    // session B's unrelated success on the same tool — minting an error_fix
    // instinct whose action was never observed to fix that error — and B's own
    // failure evicted A's pending entry. Key on session + tool.
    const resolutionKey = LearningPipeline.resolutionKey(event.sessionId, event.toolName);
    if (!event.success) {
      // Record this as a pending error
      this.pendingResolutions.set(resolutionKey, {
        errorObservation: observation,
        toolName: event.toolName,
        errorOutput: event.output,
        timestamp: Date.now(),
      });
    } else if (this.pendingResolutions.has(resolutionKey)) {
      // Same tool in the same session succeeded after a previous failure — auto-record resolution
      const pending = this.pendingResolutions.get(resolutionKey)!;
      this.pendingResolutions.delete(resolutionKey);

      // Only link if the resolution happened within 5 minutes of the error
      const elapsed = Date.now() - pending.timestamp;
      if (elapsed < LearningPipeline.RESOLUTION_LINK_WINDOW_MS) {
        await this.recordAutoResolution(pending.errorObservation, observation, event.toolName);
      }
    }

    if (!event.success && event.errorDetails) {
      this.recordErrorPattern(event.errorDetails as ErrorDetails, event.toolName);
    }

    await this.processObservation(observation);
    // Ensure the observation is flushed to DB before marking it processed,
    // since markObservationsProcessed runs a direct SQL UPDATE.
    this.storage.flush();
    this.storage.markObservationsProcessed([observation.id]);

    // 3. Update confidence for relevant instincts
    if (event.appliedInstinctIds && event.appliedInstinctIds.length > 0) {
      const verdict = getVerdictScore(event);

      for (const instinctId of event.appliedInstinctIds) {
        const instinct = this.storage.getInstinct(instinctId);
        if (!instinct) continue;

        // Skip permanent instincts -- confidence is frozen
        if (instinct.status === "permanent") continue;

        // Only update confidence if instinct has a tool_name contextCondition matching event.toolName.
        // Shared with the trajectory-credit disjoint computation (computeTrajectoryCreditIds) so the
        // two stay exact complements by construction (Issue #22 SIBLING A).
        if (!LearningPipeline.isInstinctRelevantToTool(instinct, event.toolName as string)) continue;

        // audited 2026-09-02: once per run, not once per tool call (see runCreditedInstinctIds).
        let credited = this.runCreditedInstinctIds.get(event.sessionId);
        if (!credited) {
          credited = new Set<string>();
          this.runCreditedInstinctIds.set(event.sessionId, credited);
        }
        if (credited.has(instinctId)) continue;
        credited.add(instinctId);

        // Increment coolingFailures for failures on cooling instincts
        let instinctForUpdate = instinct;
        if (!verdict.success && instinct.coolingStartedAt) {
          instinctForUpdate = {
            ...instinct,
            coolingFailures: (instinct.coolingFailures ?? 0) + 1,
          };
        }

        const updated = this.confidenceScorer.updateConfidence(instinctForUpdate, verdict.success, verdict.verdictScore);
        this.updateInstinctStatus(updated);
      }
    }

    // 4. Inline pattern detection
    this.detectPatternInline({
      toolName: event.toolName,
      success: event.success,
      errorDetails: event.errorDetails as ErrorDetails | undefined,
    });
  }

  // ─── Trajectory Methods ──────────────────────────────────────────────────────

  recordTrajectory(params: {
    sessionId: string;
    chatId?: string;
    taskRunId?: string;
    taskDescription: string;
    steps: TrajectoryStep[];
    outcome: TrajectoryOutcome;
    appliedInstinctIds?: string[];
  }): void {
    // Issue #22 (SIBLING A) — trajectory-level instinct credit (DISJOINT-SET, default OFF, dark).
    // GROUNDWORK ONLY: no production caller passes appliedInstinctIds today (the route-level endTask
    // fires before the run and under a different taskRunId, so it was removed; a future in-run trigger
    // with the populated set in scope will supply it). Until then this always yields [] → byte-identical.
    // The caller passes the FULL set of instincts that participated across the run. The per-tool-result
    // path (handleToolResult, this file ~:344-348) ALREADY credits each participating instinct whose
    // tool_name contextCondition matched a used tool (or that has no contextConditions). To avoid any
    // double-count, the trajectory credit is restricted to the DISJOINT remainder — participating
    // instincts the per-turn path STRUCTURALLY SKIPS (those with contextConditions but no tool_name
    // matching any tool used in this trajectory). Stored AS the trajectory's appliedInstinctIds so the
    // existing autoGenerateVerdict → updateInstinctsFromVerdict reinforces exactly that disjoint set
    // (one updateConfidence each). Flag-OFF (or no appliedInstinctIds): yields [] → byte-identical.
    const creditIds =
      this.config.trajectoryLevelCredit && params.appliedInstinctIds && params.appliedInstinctIds.length > 0
        ? this.computeTrajectoryCreditIds(params.appliedInstinctIds, params.steps)
        : [];

    const trajectory: Trajectory = {
      id: `traj_${randomUUID()}` as TrajectoryId,
      sessionId: createBrand(params.sessionId, "SessionId" as const),
      chatId: params.chatId ? createBrand(params.chatId, "ChatId" as const) : undefined,
      taskRunId: params.taskRunId,
      taskDescription: params.taskDescription,
      steps: params.steps,
      outcome: params.outcome,
      appliedInstinctIds: creditIds as InstinctId[],
      createdAt: Date.now() as TimestampMs,
      processed: false,
    };

    this.storage.createTrajectory(trajectory);

    // Flush immediately to ensure trajectory exists in DB for any follow-up operations
    this.storage.flush();

    // A verdict must name what it measured. The route-level caller reports
    // success as "routeMessage didn't throw" and fires BEFORE the background
    // run, with zero steps — which minted 213 byte-identical "Verified Clean
    // Success, Steps: 0, score=0.88" notes on one campaign (PixelFlow,
    // 2026-08-27) and reinforced pure noise. An empty-step trajectory carries
    // no evidence of work; it earns no verdict.
    if (params.outcome.success && !params.outcome.hadErrors && params.steps.length > 0) {
      this.autoGenerateVerdict(trajectory);
    }
  }

  /**
   * Issue #22 (SIBLING A) — compute the DISJOINT trajectory-credit subset.
   *
   * Returns the participating instincts the per-tool-result path NEVER credited, using the SAME
   * predicate that path applies ({@link isInstinctRelevantToTool}, shared with handleToolResult):
   * per-turn credits an instinct on a tool result iff that predicate holds for that tool. Across the
   * whole run the per-turn-credited set is therefore every participating instinct relevant to SOME
   * tool used in the trajectory. The disjoint remainder (returned here) is the rest: instincts WITH
   * contextConditions whose tool_name conditions (if any) never matched a used tool — provably zero
   * overlap, so no double-count. Missing/permanent instincts are harmless downstream (updateConfidence
   * freezes permanent; updateInstinctsFromVerdict skips missing) but are filtered here for clarity.
   */
  private computeTrajectoryCreditIds(
    participatingInstinctIds: readonly string[],
    steps: readonly TrajectoryStep[],
  ): string[] {
    const usedToolNames: string[] = [];
    for (const step of steps) {
      usedToolNames.push(step.toolName as string);
    }

    const disjoint: string[] = [];
    const seen = new Set<string>();
    for (const instinctId of participatingInstinctIds) {
      if (seen.has(instinctId)) continue;
      seen.add(instinctId);

      const instinct = this.storage.getInstinct(instinctId);
      if (!instinct) continue;

      // Per-turn-credited iff the SHARED predicate holds for ANY tool used in the run (no
      // contextConditions ⇒ relevant to every tool ⇒ always per-turn-credited ⇒ NOT disjoint). The
      // disjoint set is the exact complement: relevant to NONE of the used tools.
      const perTurnCredited = usedToolNames.some((toolName) =>
        LearningPipeline.isInstinctRelevantToTool(instinct, toolName),
      );
      if (perTurnCredited) continue;

      // Structurally skipped per-turn (planning/strategy or stale-tool instinct) ⇒ disjoint, credit it.
      disjoint.push(instinctId);
    }
    return disjoint;
  }

  /**
   * Issue #22 (SIBLING A) — the single per-turn relevance predicate, shared by the per-tool-result
   * credit path (handleToolResult) and the trajectory-credit disjoint computation
   * ({@link computeTrajectoryCreditIds}). Per-turn credits an instinct on a given tool result iff it
   * has NO contextConditions (applies to every tool) OR a `tool_name` contextCondition equal to that
   * tool. Keeping ONE definition guarantees the disjoint set stays the exact complement of the
   * per-turn-credited set, so no future edit to one site can silently reintroduce double-count.
   */
  private static isInstinctRelevantToTool(instinct: Instinct, toolName: string): boolean {
    return (
      instinct.contextConditions.length === 0 ||
      instinct.contextConditions.some((cc) => cc.type === "tool_name" && cc.value === toolName)
    );
  }

  submitVerdict(params: {
    trajectoryId: string;
    judgeType: Verdict["judgeType"];
    score: number;
    dimensions: Partial<VerdictDimensions>;
    feedback?: string;
  }): void {
    const verdict: Verdict = {
      id: `verdict_${randomUUID()}` as VerdictId,
      trajectoryId: params.trajectoryId as TrajectoryId,
      judgeType: params.judgeType,
      score: params.score,
      dimensions: {
        efficiency: params.dimensions.efficiency ?? 0.5,
        correctness: params.dimensions.correctness ?? 0.5,
        quality: params.dimensions.quality ?? 0.5,
        bestPractices: params.dimensions.bestPractices ?? 0.5,
      },
      feedback: params.feedback,
      createdAt: Date.now() as TimestampMs,
      judgeId: "system", // Required field
    };

    this.storage.recordVerdict(verdict);
    this.updateInstinctsFromVerdict(params.trajectoryId, params.score);
  }

  // ─── Batch Processing ────────────────────────────────────────────────────────

  async runDetectionBatch(): Promise<{ instinctsCreated: number; patternsDetected: number }> {
    if (!this.config.enabled) return { instinctsCreated: 0, patternsDetected: 0 };

    let instinctsCreated = 0;
    let patternsDetected = 0;

    // Process observations
    const observations = this.storage.getUnprocessedObservations(this.config.batchSize);
    for (const obs of observations) {
      if (await this.processObservation(obs)) patternsDetected++;
    }
    this.storage.markObservationsProcessed(observations.map(o => o.id));

    // Process trajectories
    const trajectories = this.storage.getUnprocessedTrajectories(this.config.batchSize);
    for (const trajectory of trajectories) {
      const instinct = await this.extractInstinctFromTrajectory(trajectory);
      if (instinct) {
        this.checkScopePromotion(instinct);
        if (this.embeddingQueue) {
          this.embeddingQueue.enqueue(instinct.id, `${instinct.triggerPattern} ${instinct.action}`);
        }
        instinctsCreated++;
      }
    }
    this.storage.markTrajectoriesProcessed(trajectories.map(t => t.id));

    return { instinctsCreated, patternsDetected };
  }

  // ─── Instinct Management ─────────────────────────────────────────────────────

  async considerInstinctCreation(params: {
    type: InstinctType;
    triggerPattern: string;
    action: string;
    toolName?: string;
    contextConditions?: ContextCondition[];
    scopeType?: ScopeType;
    confidence?: number;
  }): Promise<Instinct | null> {
    if (!this.isMeaningfulTrigger(params.triggerPattern)) return null;
    // Check for similar existing instincts (use similarity threshold, not confidence)
    const similar = await this.patternMatcher.findSimilarInstincts(params.triggerPattern);
    // Check raw similarity (relevance), not confidence-weighted score.
    // audited 2026-09-02: dead instincts (deprecated/evolved) are excluded from
    // retrieval everywhere else but counted here, so a retired wrong fix
    // permanently blocked learning the right fix for the same trigger.
    if (similar.some(m =>
      m.relevance > CONFIDENCE_THRESHOLDS.SIMILAR &&
      m.instinct?.status !== "deprecated" &&
      m.instinct?.status !== "evolved",
    )) return null;

    const initialConfidence = params.confidence ?? this.calculateInitialConfidence(params);
    if (initialConfidence < this.config.minConfidenceForCreation) return null;

    const scopeType: ScopeType = params.scopeType ?? 'project';

    const instinct: Instinct = {
      id: createInstinctId(),
      name: this.generateInstinctName(params),
      type: params.type,
      status: "proposed",
      confidence: initialConfidence,
      triggerPattern: params.triggerPattern,
      action: params.action,
      contextConditions: params.contextConditions ?? this.generateContextConditions(params.toolName as ToolName | undefined),
      stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
      createdAt: Date.now() as TimestampMs,
      updatedAt: Date.now() as TimestampMs,
      sourceTrajectoryIds: [],
      tags: [],
      scopeType,
    };

    // Store instinct row without old-style scope, then add v2 scope entry with scopeType
    this.storage.createInstinct(instinct, undefined);
    if (this.projectPath) {
      this.storage.addInstinctScopeV2(instinct.id, this.projectPath, scopeType);
    }
    this.checkScopePromotion(instinct);
    if (this.embeddingQueue) {
      this.embeddingQueue.enqueue(instinct.id, `${instinct.triggerPattern} ${instinct.action}`);
    }
    this.enforceMaxInstincts();
    // LIVING VAULT (C): mirror high-confidence instincts as learned-heuristic notes.
    this.noteHighConfidenceInstinct(instinct);
    return instinct;
  }

  createInstinct(params: Omit<Instinct, "id" | "stats" | "createdAt" | "updatedAt" | "sourceTrajectoryIds" | "tags"> & { scopeType?: ScopeType }): Instinct {
    const scopeType: ScopeType = params.scopeType ?? 'project';
    const instinct: Instinct = {
      ...params,
      id: createInstinctId(),
      stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
      createdAt: Date.now() as TimestampMs,
      updatedAt: Date.now() as TimestampMs,
      sourceTrajectoryIds: [],
      tags: [],
      scopeType,
    };

    // Store instinct row without old-style scope, then add v2 scope entry with scopeType
    this.storage.createInstinct(instinct, undefined);
    if (this.projectPath) {
      this.storage.addInstinctScopeV2(instinct.id, this.projectPath, scopeType);
    }
    this.checkScopePromotion(instinct);
    if (this.embeddingQueue) {
      this.embeddingQueue.enqueue(instinct.id, `${instinct.triggerPattern} ${instinct.action}`);
    }
    this.enforceMaxInstincts();
    // LIVING VAULT (C): mirror high-confidence instincts as learned-heuristic notes.
    this.noteHighConfidenceInstinct(instinct);
    return instinct;
  }

  /**
   * Push a user reaction (thumbs up/down) into the stored posterior and run
   * the lifecycle state machine on the result. Stats are untouched: a
   * reaction is not an application.
   */
  private applyReactionEvidence(instinct: Instinct, positive: boolean): void {
    if (instinct.status === "permanent") return;
    const updated = this.confidenceScorer.applyEvidence(
      instinct,
      positive ? EVIDENCE_WEIGHTS.reactionUp : EVIDENCE_WEIGHTS.reactionDown,
    );
    this.updateInstinctStatus(updated);
  }

  /**
   * Push the outcome of a task an instinct merely informed (retrieved, not
   * necessarily applied) into the stored posterior. Wired from
   * InstinctRetriever.recordOutcome so the "P2 action→outcome feedback loop"
   * changes the number retrieval ranks on. (audited 2026-09-02)
   */
  recordInstinctOutcomeEvidence(instinctId: string, success: boolean): void {
    const instinct = this.storage.getInstinct(instinctId);
    if (!instinct || instinct.status === "permanent") return;
    const updated = this.confidenceScorer.applyEvidence(
      instinct,
      success ? EVIDENCE_WEIGHTS.outcomeSuccess : EVIDENCE_WEIGHTS.outcomeFailure,
    );
    this.updateInstinctStatus(updated);
  }

  updateInstinctStatus(instinct: Instinct): void {
    const config = this.bayesianConfig;

    // Skip permanent instincts entirely -- they are frozen
    if (instinct.status === "permanent") {
      const updatedInstinct: Instinct = {
        ...instinct,
        updatedAt: Date.now() as TimestampMs,
      };
      this.storage.updateInstinct(updatedInstinct);
      return;
    }

    const totalObs = instinct.stats.timesApplied + instinct.stats.timesFailed;
    let updatedInstinct: Instinct = { ...instinct };

    // ─── PROMOTION CHECK (before cooling -- high confidence trumps everything) ───
    if (
      instinct.confidence >= config.autoEvolveThreshold &&
      totalObs >= config.promotionMinObservations &&
      instinct.status === "active"
    ) {
      updatedInstinct = {
        ...updatedInstinct,
        status: "permanent",
        updatedAt: Date.now() as TimestampMs,
      };
      this.storage.updateInstinct(updatedInstinct);

      // Emit lifecycle event
      this.emitLifecycleEvent("instinct:promoted", updatedInstinct, instinct.status, "permanent", `Promoted to permanent: confidence=${instinct.confidence.toFixed(3)}, observations=${totalObs}`);

      // Persist lifecycle log
      this.writeLifecycleLogSafe(instinct, "permanent", `Auto-promoted: confidence ${instinct.confidence.toFixed(3)} >= ${config.autoEvolveThreshold} with ${totalObs} observations`);

      // Increment weekly counter
      this.incrementWeeklyCounterSafe("promoted");
      return;
    }

    // ─── COOLING CHECK ──────────────────────────────────────────────────────
    if (instinct.confidence < config.deprecatedThreshold && totalObs >= config.coolingMinObservations) {
      if (!instinct.coolingStartedAt) {
        // START COOLING
        updatedInstinct = {
          ...updatedInstinct,
          coolingStartedAt: Date.now() as TimestampMs,
          coolingFailures: 0,
          updatedAt: Date.now() as TimestampMs,
        };
        this.storage.updateInstinct(updatedInstinct);

        this.emitLifecycleEvent("instinct:cooling-started", updatedInstinct, instinct.status, instinct.status, `Cooling started: confidence=${instinct.confidence.toFixed(3)}, observations=${totalObs}`);
        this.writeLifecycleLogSafe(instinct, "cooling", `Cooling started: confidence ${instinct.confidence.toFixed(3)} < ${config.deprecatedThreshold} with ${totalObs} observations`);
        this.incrementWeeklyCounterSafe("cooling_started");
        return;
      } else {
        // ALREADY COOLING -- check deprecation triggers
        const daysCooling = (Date.now() - instinct.coolingStartedAt) / (1000 * 60 * 60 * 24);
        if (daysCooling >= config.coolingPeriodDays || (instinct.coolingFailures ?? 0) >= config.coolingMaxFailures) {
          const reason = daysCooling >= config.coolingPeriodDays
            ? `Cooling period expired: ${daysCooling.toFixed(1)} days >= ${config.coolingPeriodDays}`
            : `Consecutive failures: ${instinct.coolingFailures} >= ${config.coolingMaxFailures}`;

          updatedInstinct = {
            ...updatedInstinct,
            status: "deprecated",
            coolingStartedAt: undefined,
            coolingFailures: 0,
            updatedAt: Date.now() as TimestampMs,
          };
          this.storage.updateInstinct(updatedInstinct);

          this.emitLifecycleEvent("instinct:deprecated", updatedInstinct, instinct.status, "deprecated", reason);
          this.writeLifecycleLogSafe(instinct, "deprecated", reason);
          this.incrementWeeklyCounterSafe("deprecated");
          return;
        }
      }
    }

    // ─── COOLING RECOVERY CHECK ─────────────────────────────────────────────
    if (instinct.coolingStartedAt && instinct.confidence >= config.deprecatedThreshold) {
      updatedInstinct = {
        ...updatedInstinct,
        coolingStartedAt: undefined,
        coolingFailures: 0,
        updatedAt: Date.now() as TimestampMs,
      };
      this.storage.updateInstinct(updatedInstinct);
      this.incrementWeeklyCounterSafe("cooling_recovered");
      return;
    }

    // ─── EXISTING: proposed -> active promotion ─────────────────────────────
    let newStatus = instinct.status;
    if (instinct.confidence >= config.activeThreshold && instinct.status === "proposed") {
      newStatus = "active";
    }

    updatedInstinct = {
      ...updatedInstinct,
      status: newStatus,
      updatedAt: Date.now() as TimestampMs,
    };
    this.storage.updateInstinct(updatedInstinct);
  }

  // ─── Evolution ───────────────────────────────────────────────────────────────

  runEvolution(): { proposals: number; artifacts: number } {
    if (!this.config.enabled) return { proposals: 0, artifacts: 0 };

    let proposals = 0;
    let artifacts = 0;
    const candidates = this.storage.getInstincts({
      status: "active",
      minConfidence: CONFIDENCE_THRESHOLDS.EVOLUTION,
    });

    for (const instinct of candidates) {
      if (instinct.confidence > CONFIDENCE_THRESHOLDS.AUTO_EVOLVE) {
        const result = this.materializeRuntimeArtifact(instinct);
        if (result.proposalCreated) {
          proposals++;
          artifacts++;
        }
      }
    }

    return { proposals, artifacts };
  }

  materializeRuntimeArtifact(instinct: Instinct): {
    artifact: RuntimeArtifact;
    proposal: EvolutionProposal | null;
    proposalCreated: boolean;
    created: boolean;
  } {
    return this.runtimeArtifacts.materializeShadowArtifact(instinct, this.projectPath);
  }

  getRuntimeArtifactManager(): RuntimeArtifactManager {
    return this.runtimeArtifacts;
  }

  // ─── Lifecycle Helpers ───────────────────────────────────────────────────────

  /** Emit a lifecycle event on the event bus (fire-and-forget) */
  private emitLifecycleEvent(
    eventName: "instinct:cooling-started" | "instinct:deprecated" | "instinct:promoted",
    instinct: Instinct,
    fromStatus: string,
    toStatus: string,
    reason: string,
  ): void {
    if (!this.eventBus) return;
    try {
      const event: InstinctLifecycleEvent = {
        instinct,
        fromStatus: fromStatus as Instinct["status"],
        toStatus: toStatus as Instinct["status"],
        reason,
        timestamp: Date.now(),
      };
      this.eventBus.emit(eventName, event);
    } catch {
      // Fire-and-forget: log and continue
    }
  }

  /** Write lifecycle log entry (fire-and-forget) */
  private writeLifecycleLogSafe(instinct: Instinct, toStatus: string, reason: string): void {
    try {
      const totalObs = instinct.stats.timesApplied + instinct.stats.timesFailed;
      this.storage.writeLifecycleLog({
        instinctId: instinct.id,
        fromStatus: instinct.status,
        toStatus: toStatus as Instinct["status"],
        reason,
        confidenceAtTransition: instinct.confidence,
        bayesianAlpha: instinct.bayesianAlpha ?? 1,
        bayesianBeta: instinct.bayesianBeta ?? 1,
        observationCount: totalObs,
        timestamp: Date.now(),
      });
    } catch {
      // Fire-and-forget: log and continue
    }
  }

  /** Increment weekly counter (fire-and-forget) */
  private incrementWeeklyCounterSafe(eventType: "promoted" | "deprecated" | "cooling_started" | "cooling_recovered"): void {
    try {
      this.storage.incrementWeeklyCounter(eventType);
    } catch {
      // Fire-and-forget: log and continue
    }
  }

  // ─── Scope Promotion (Phase 13) ──────────────────────────────────────────────

  /**
   * Check if an instinct qualifies for scope promotion to universal.
   * Fires instinct:scope_promoted event when threshold reached.
   */
  private checkScopePromotion(instinct: Instinct): void {
    if (!this.projectPath) return;

    try {
      const scopeCount = this.storage.getInstinctScopeCount(instinct.id);
      if (scopeCount >= this.promotionThreshold) {
        // Promote to universal scope
        this.storage.addInstinctScope(instinct.id, "*");

        // Emit scope promotion event
        if (this.eventBus) {
          this.eventBus.emit("instinct:scope_promoted", {
            instinct,
            projectPath: this.projectPath,
            promotedToUniversal: true,
            distinctProjectCount: scopeCount,
            timestamp: Date.now(),
          });
        }
      }
    } catch {
      // Non-blocking: promotion failure should not affect instinct creation
    }
  }

  // ─── Inline Detection ────────────────────────────────────────────────────────

  private detectPatternInline(obs: {
    toolName: string; success: boolean;
    errorDetails?: { message?: string };
  }): void {
    const windowSize = this.config?.batchSize ? this.config.batchSize * 2 : 20;

    this.recentObservations.push({
      toolName: obs.toolName,
      errorPattern: obs.errorDetails?.message
        ? this.sanitizePattern(obs.errorDetails.message) : undefined,
      timestamp: Date.now(),
    });

    if (this.recentObservations.length > windowSize) {
      this.recentObservations.splice(0, this.recentObservations.length - windowSize);
    }

    const minObs = this.config?.minObservationsBeforeLearning ?? 5;
    if (this.recentObservations.length < minObs) return;

    // Same error pattern 3+ times
    if (obs.errorDetails?.message) {
      const pattern = this.sanitizePattern(obs.errorDetails.message);
      const count = this.recentObservations.filter(o => o.errorPattern === pattern).length;
      if (count >= 3) {
        this.considerInstinctCreation({
          type: "error_pattern",
          triggerPattern: pattern,
          action: JSON.stringify({ description: 'Recurring error: ' + pattern }),
          toolName: obs.toolName,
        }).catch(() => {});
      }
    }

    // Same tool sequence 3+ times
    if (this.recentObservations.length >= 9) {
      const seqLen = 3;
      const recent = this.recentObservations.slice(-seqLen).map(o => o.toolName).join('->');
      let seqCount = 0;
      for (let i = 0; i <= this.recentObservations.length - seqLen; i++) {
        const seq = this.recentObservations.slice(i, i + seqLen).map(o => o.toolName).join('->');
        if (seq === recent) seqCount++;
      }
      if (seqCount >= 3) {
        this.considerInstinctCreation({
          type: "workflow_pattern",
          triggerPattern: recent,
          action: JSON.stringify({ description: 'Common workflow: ' + recent }),
        }).catch(() => {});
      }
    }
  }

  // ─── Periodic Trajectory Extraction ─────────────────────────────────────────

  private async runPeriodicExtraction(): Promise<void> {
    // Clean stale pending resolutions (older than 10 minutes)
    const staleThreshold = Date.now() - LearningPipeline.STALE_RESOLUTION_THRESHOLD_MS;
    for (const [key, pending] of this.pendingResolutions) {
      if (pending.timestamp < staleThreshold) {
        this.pendingResolutions.delete(key);
      }
    }

    const unprocessed = this.storage.getUnprocessedTrajectories();
    for (const trajectory of unprocessed) {
      // extractInstinctFromTrajectory -> considerInstinctCreation already persists
      await this.extractInstinctFromTrajectory(trajectory);
    }
    this.storage.markTrajectoriesProcessed(unprocessed.map(t => t.id));

    this.pruneObservations();
  }

  /**
   * Retention sweep: delete processed observations older than
   * config.observationRetentionDays. Unprocessed rows are kept regardless of
   * age. Returns what was measured so callers never mistake a no-op for a
   * sweep. (audited 2026-09-02: the table had no retention path at all.)
   */
  pruneObservations(): { deleted: number; olderThanMs: number; retentionDays: number } {
    const retentionDays = this.config.observationRetentionDays;
    const olderThanMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted = this.storage.pruneProcessedObservations(olderThanMs);
    return { deleted, olderThanMs, retentionDays };
  }

  // ─── Max Instincts Enforcement ──────────────────────────────────────────────

  /**
   * Evict lowest-confidence rows until the store is within maxInstincts.
   * Order: deprecated → proposed → active. Permanent and evolved rows are never
   * evicted, so the cap can be unenforceable; the returned counts and the
   * warning say so instead of returning silently.
   *
   * audited 2026-09-02: there was no 'proposed' pass, yet every pipeline-created
   * instinct is proposed at 0.5 and most never leave that status. In a
   * proposed-dominated store the cap deleted the few reinforced ACTIVE rows
   * first, freed nothing else, and returned without a word.
   */
  async enforceMaxInstincts(): Promise<{ evicted: number; remainingOverCap: number }> {
    const maxInstincts = this.config?.maxInstincts ?? 1000;
    const count = this.storage.countInstincts();
    if (count <= maxInstincts) return { evicted: 0, remainingOverCap: 0 };
    const overflow = count - maxInstincts;

    let remaining = overflow;
    const evictedByStatus: Record<string, number> = {};
    for (const status of ["deprecated", "proposed", "active"] as const) {
      if (remaining <= 0) break;
      const before = this.storage.countInstincts();
      this.storage.deleteLowestConfidenceInstincts(status, remaining);
      const deleted = before - this.storage.countInstincts();
      if (deleted > 0) evictedByStatus[status] = deleted;
      remaining -= deleted;
    }

    const evicted = overflow - remaining;
    if (remaining > 0) {
      try {
        getLoggerSafe().warn("maxInstincts cap could not be enforced: only permanent/evolved rows remain over the cap", {
          maxInstincts,
          countBefore: count,
          evicted,
          evictedByStatus,
          remainingOverCap: remaining,
        });
      } catch {
        // Logger may not be available in test environments
      }
    }
    return { evicted, remainingOverCap: remaining };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private recordErrorPattern(errorDetails: ErrorDetails, _toolName?: string): void {
    const pattern: ErrorPattern = {
      id: `error_${randomUUID()}` as ErrorPatternId,
      name: `${errorDetails.category} pattern`,
      category: errorDetails.category,
      codePattern: errorDetails.code,
      messagePattern: this.sanitizePattern(errorDetails.message),
      filePatterns: errorDetails.file ? [errorDetails.file] : [],
      occurrenceCount: 1,
      firstSeen: Date.now() as TimestampMs,
      lastSeen: Date.now() as TimestampMs,
      isActive: true,
    };

    this.storage.upsertErrorPattern(pattern);
  }

  private async processObservation(obs: Observation): Promise<boolean> {
    switch (obs.type) {
      case "error":
        if (obs.errorDetails) this.recordErrorPattern(obs.errorDetails, obs.toolName);
        return true;
      case "correction":
        if (obs.correction) {
          await this.considerInstinctCreation({
            type: "correction",
            triggerPattern: this.extractTriggerPattern(obs.output ?? ""),
            action: obs.correction,
            toolName: obs.toolName,
          });
        }
        return true;
      default:
        return false;
    }
  }

  private async extractInstinctFromTrajectory(trajectory: Trajectory): Promise<Instinct | null> {
    if (!trajectory.outcome.success) return null;

    // Find error→fix patterns
    for (let i = 0; i < trajectory.steps.length - 1; i++) {
      const step = trajectory.steps[i]!;
      const nextStep = trajectory.steps[i + 1]!;

      // Check if step result is error and next step is success
      const isError = step.result.kind === "error";
      const isNextSuccess = nextStep.result.kind === "success";

      if (isError && isNextSuccess) {
        const errorResult = step.result;
        return await this.considerInstinctCreation({
          type: "error_fix",
          triggerPattern: errorResult.error.message,
          action: this.stepToAction(nextStep),
          toolName: step.toolName,
          contextConditions: [
                { id: `ctx_${randomUUID()}` as ContextConditionId, type: "error_code", value: errorResult.error.code ?? "unknown", match: "include" },
            { id: `ctx_${randomUUID()}` as ContextConditionId, type: "tool_name", value: step.toolName, match: "include" },
          ],
        }) ?? null;
      }
    }

    return null;
  }

  private updateInstinctsFromVerdict(trajectoryId: string, score: number): void {
    const trajectory = this.storage.getTrajectory(trajectoryId);
    if (!trajectory) return;

    for (const instinctId of trajectory.appliedInstinctIds) {
      const instinct = this.storage.getInstinct(instinctId);
      if (!instinct) continue;

      const updatedInstinct = this.confidenceScorer.updateConfidence(instinct, score >= VERDICT_SCORE.HIGH, score);
      this.storage.updateInstinct(updatedInstinct);
    }
  }

  private stepToAction(step: TrajectoryStep): string {
    const result = step.result;
    const output = result.kind === "success" ? result.output : "";
    return JSON.stringify({ tool: step.toolName, input: step.input, output });
  }

  private extractTriggerPattern(output: string): string {
    // Whole-word signals only, with line-number/pipe prefixes stripped: the
    // old substring test passed JSON metrics ('"compileErrors": 0') and code
    // listings ('  41 | ... ArgumentNullException...') as "error lines" —
    // measured 2026-08-30: 75 instincts created, every trigger a raw output
    // fragment no future task could match and no reader could learn from.
    const relevantLines = output
      .split("\n")
      .map((l) => l.replace(/^\s*\d+\s*\|\s?/, "").trim())
      .filter((l) => /\b(error|failed|exception|cannot|missing|invalid)\b/i.test(l))
      .filter((l) => !/^"[\w.]+"\s*:/.test(l) && !/^[\w.]+\s*:\s*\d+\s*,?\s*$/.test(l));
    return [...new Set(relevantLines)].join(" ").slice(0, 500);
  }

  /**
   * A trigger worth remembering names a CONDITION, not a fragment of output.
   * Gate applied at creation so the instinct store holds knowledge, not noise.
   */
  private isMeaningfulTrigger(trigger: string): boolean {
    const s = trigger.trim();
    if (s.length < 12) return false;
    // JSON metric fragment: quoted key, or a bare numeric metric line —
    // narrow on purpose so error codes ("CS1061: 'Board'…") stay eligible.
    if (/^"[\w.]+"\s*:/.test(s)) return false;
    if (/^[\w.]+\s*:\s*\d+\s*,?\s*$/.test(s)) return false;
    if (/^\s*\d+\s*\|/.test(s)) return false; // code-listing line
    const letters = (s.match(/[a-zA-Z]/g) ?? []).length;
    return letters / s.length >= 0.5;
  }

  /** A resolution may only be attributed to the session that produced the error. */
  private static resolutionKey(sessionId: string, toolName: string): string {
    return `${sessionId}:${toolName}`;
  }

  /**
   * Automatically record a resolution when a tool succeeds after a prior failure.
   * Creates a correction observation and considers instinct creation from the pattern.
   */
  private async recordAutoResolution(
    errorObs: Observation,
    successObs: Observation,
    toolName: string,
  ): Promise<void> {
    const correction = `Auto-resolved: ${toolName} failed with "${(errorObs.output ?? '').slice(0, 100)}" then succeeded with "${(successObs.output ?? '').slice(0, 100)}"`;

    const resolutionObs: Observation = {
      id: `obs_${randomUUID()}` as ObservationId,
      type: "correction",
      sessionId: successObs.sessionId,
      toolName: successObs.toolName,
      input: successObs.input,
      output: successObs.output,
      correction,
      timestamp: Date.now() as TimestampMs,
      // audited 2026-09-02: the error->fix instinct is considered inline below;
      // an unmarked row was replayed by the startup drain into a junk
      // "Auto-resolved: ..." instinct keyed on the SUCCESS output.
      processed: true,
    };

    this.storage.recordObservation(resolutionObs);
    this.storage.flush();

    // Consider creating an instinct from this error→resolution pattern
    const errorPattern = this.extractTriggerPattern(errorObs.output ?? '');
    if (errorPattern) {
      const rawAction = String((successObs.input as Record<string, unknown>)?.["command"] ?? (successObs.input as Record<string, unknown>)?.["content"] ?? "retrying with corrected input");
      await this.considerInstinctCreation({
        type: "error_fix" as InstinctType,
        triggerPattern: errorPattern,
        action: `When ${toolName} fails with this pattern, the resolution involved: ${sanitizePromptInjection(rawAction.slice(0, 300))}`,
        toolName,
      });
    }
  }

  private sanitizePattern(message: string): string {
    return message
      .replace(/'[^']+'/g, "'%NAME%'")
      .replace(/"[^"]+"/g, '"%NAME%"')
      .replace(/\d+/g, "%NUM%")
      .slice(0, 500);
  }

  private generateInstinctName(params: { type: InstinctType; toolName?: string }): string {
    const prefix = params.type.replace("_", "-");
    const tool = params.toolName ?? "general";
    return `${prefix}:${tool}:${Date.now()}`;
  }

  private generateContextConditions(toolName?: ToolName): ContextCondition[] {
    return toolName ? [{ id: `ctx_${randomUUID()}` as ContextConditionId, type: "tool_name", value: toolName, match: "include" }] : [];
  }

  private calculateInitialConfidence(params: { type: InstinctType; triggerPattern: string; action: string }): number {
    let confidence = 0.5;

    if (params.type === "error_fix") confidence += 0.1;
    if (params.type === "correction") confidence += 0.15;
    if (params.triggerPattern.length > 50) confidence += 0.1;
    if (params.action.length > 20) confidence += 0.05;

    return Math.min(confidence, CONFIDENCE_THRESHOLDS.MAX_INITIAL);
  }

  private autoGenerateVerdict(trajectory: Trajectory): void {
    const dimensions: VerdictDimensions = {
      efficiency: trajectory.outcome.totalSteps < 5 ? 0.9 : 0.7,
      correctness: VERDICT_SCORE.PERFECT,
      quality: 0.8,
      bestPractices: 0.8,
    };

    const score = Object.values(dimensions).reduce((a, b) => a + b, 0) / 4;

    this.submitVerdict({
      trajectoryId: trajectory.id,
      judgeType: "automated",
      score,
      dimensions,
      feedback: "Auto-generated verdict for clean successful trajectory",
    });

    // LIVING VAULT (C): mirror the clean-success trajectory as a durable note.
    this.noteCleanSuccessVerdict(trajectory, score);
  }

  // ─── Feedback Methods ────────────────────────────────────────────────────────

  /**
   * Store an explicit user teaching as a new instinct.
   */
  async teachExplicit(content: string, scopeType: ScopeType, _userId?: string): Promise<string> {
    const instinct = this.createInstinct({
      name: `teaching:explicit:${Date.now()}`,
      type: 'user_teaching',
      status: 'active',
      confidence: 0.7,
      triggerPattern: this.sanitizePattern(content),
      action: content,
      contextConditions: [],
      scopeType,
    });
    return instinct.id;
  }

  /**
   * Record a user correction and consider creating an instinct from it.
   */
  async recordCorrection(params: CorrectionRecord): Promise<void> {
    // Source-specific confidence: direct user feedback scores higher
    const sourceBoost: Record<string, number> = {
      button: 0.15,
      reaction: 0.1,
      natural_language: 0.05,
      file_heuristic: 0.0,
    };
    const confidence = this.calculateInitialConfidence({
      type: 'correction',
      triggerPattern: this.sanitizePattern(params.corrected),
      action: params.corrected,
    }) + (sourceBoost[params.source] ?? 0);

    await this.considerInstinctCreation({
      type: 'correction',
      triggerPattern: this.sanitizePattern(params.corrected),
      action: params.corrected,
      scopeType: 'user',
      confidence: Math.min(confidence, CONFIDENCE_THRESHOLDS.MAX_INITIAL),
    });
  }

  // ─── Public Getters ──────────────────────────────────────────────────────────

  getStats() {
    return this.storage.getStats();
  }

  /**
   * Issue #22 (SIBLING A) — whether trajectory-level instinct credit is enabled (default OFF).
   * Reserved seam for a future in-run trigger to gate its instinct-set capture on, so flag-off
   * does zero extra work and stays byte-identical. No production caller today (the route-level
   * wiring was removed as structurally unable to supply the run's real instinct set).
   */
  isTrajectoryLevelCreditEnabled(): boolean {
    return this.config.trajectoryLevelCredit === true;
  }

  // ─── LIVING VAULT (C): learning↔vault bridge ──────────────────────────────

  /**
   * Inject the dev-knowledge note-writer (bootstrap wires it after the vault is
   * registered). Interface-only dependency — no src/learning -> src/vault
   * runtime import. Idempotent; passing undefined detaches the bridge.
   */
  setNoteWriter(
    writer: import("../../vault/dev-knowledge-writer.js").DevKnowledgeNoteWriter | undefined,
  ): void {
    this.noteWriter = writer;
  }

  /**
   * Fire-and-forget bridge write. Best-effort, per-id deduped, never throws onto
   * the caller's path. No-op when no writer is wired.
   */
  private writeKnowledgeNote(dedupId: string, relPath: string, content: string): void {
    const writer = this.noteWriter;
    if (!writer) return;
    if (this.notedIds.has(dedupId)) return;
    this.notedIds.add(dedupId);
    void writer.writeNote(relPath, content).catch(() => {
      // Best-effort: the writer already swallows+logs; this catch is a final guard.
    });
  }

  /**
   * Mirror a newly created high-confidence instinct as a durable "learned
   * heuristic" note. Low-volume (creation is rare); deduped by instinctId.
   */
  private noteHighConfidenceInstinct(instinct: Instinct): void {
    if (!this.noteWriter) return;
    const ACTIVE_THRESHOLD = this.bayesianConfig.activeThreshold;
    if (instinct.confidence < ACTIVE_THRESHOLD) return;
    const trigger = sanitizePromptInjection(instinct.triggerPattern.slice(0, 500));
    const action = sanitizePromptInjection(instinct.action.slice(0, 500));
    const content = [
      '---',
      `title: "${instinct.name.replace(/["\n]/g, ' ').trim()}"`,
      `date: ${new Date().toISOString()}`,
      `instinctId: ${instinct.id}`,
      `confidence: ${instinct.confidence.toFixed(2)}`,
      `type: ${instinct.type}`,
      '---',
      '',
      '## Learned Heuristic',
      `When: ${trigger}`,
      '',
      `Do: ${action}`,
      '',
      `Confidence: ${instinct.confidence.toFixed(2)} (${instinct.status})`,
      '',
    ].join('\n');
    this.writeKnowledgeNote(
      `instinct:${instinct.id}`,
      `knowledge/instincts/${instinct.id}.md`,
      content,
    );
  }

  /**
   * Mirror a clean-success trajectory verdict as a human-readable note.
   * Gated upstream (only clean, error-free successes reach autoGenerateVerdict);
   * deduped by trajectoryId.
   */
  private noteCleanSuccessVerdict(trajectory: Trajectory, score: number): void {
    if (!this.noteWriter) return;
    const desc = sanitizePromptInjection((trajectory.taskDescription ?? '').slice(0, 500));
    const content = [
      '---',
      `title: "${desc.replace(/["\n]/g, ' ').slice(0, 80).trim() || 'Clean success'}"`,
      `date: ${new Date().toISOString()}`,
      `trajectoryId: ${trajectory.id}`,
      `score: ${score.toFixed(2)}`,
      '---',
      '',
      '## Verified Clean Success',
      desc || '(no description)',
      '',
      `Steps: ${trajectory.outcome.totalSteps}; score=${score.toFixed(2)}`,
      '',
      '## Key Learning',
      'Approach that worked — verified clean success (no errors, no retries).',
      '',
    ].join('\n');
    this.writeKnowledgeNote(
      `verdict:${trajectory.id}`,
      `knowledge/verdicts/${trajectory.id}.md`,
      content,
    );
  }
}
