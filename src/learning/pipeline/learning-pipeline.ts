/**
 * Learning Pipeline - Core learning engine for pattern detection and instinct creation
 * 
 * Processes observations, creates instincts, and manages evolution of learned patterns.
 */

import { randomUUID } from "node:crypto";
import { LearningStorage } from "../storage/learning-storage.js";
import { ConfidenceScorer, getVerdictScore } from "../scoring/confidence-scorer.js";
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
  private periodicTimer?: ReturnType<typeof setInterval>;
  private isRunning = false;

  private recentObservations: Array<{
    toolName: string; errorPattern?: string; timestamp: number;
  }> = [];

  /** Project path for scope-aware instinct creation (Phase 13) */
  private projectPath?: string;
  /** Scope promotion threshold (Phase 13): distinct projects needed for universal promotion */
  private promotionThreshold = 3;

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
    this.feedbackHandler = new FeedbackHandler(storage);

    if (embeddingProvider) {
      this.embeddingQueue = new EmbeddingQueue(embeddingProvider, storage);
    }

    // Subscribe to feedback:reaction events from channel adapters
    if (this.eventBus) {
      this.eventBus.on("feedback:reaction", (event: FeedbackReactionEvent) => {
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
      });
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

    // Detection timer removed -- event-driven processing via handleToolResult() replaces it
    this.evolutionTimer = setInterval(() => this.runEvolution(), this.config.evolutionIntervalMs);

    // Periodic trajectory extraction — use detection interval from config
    const periodicMs = this.config.detectionIntervalMs;
    this.periodicTimer = setInterval(() => this.runPeriodicExtraction(), periodicMs);
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
      processed: false,
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
    this.storage.flush();

    if (!event.success && event.errorDetails) {
      this.recordErrorPattern(event.errorDetails as ErrorDetails, event.toolName);
    }

    await this.processObservation(observation);
    this.storage.markObservationsProcessed([observation.id]);

    // 3. Update confidence for relevant instincts
    if (event.appliedInstinctIds && event.appliedInstinctIds.length > 0) {
      const verdict = getVerdictScore(event);

      for (const instinctId of event.appliedInstinctIds) {
        const instinct = this.storage.getInstinct(instinctId);
        if (!instinct) continue;

        // Skip permanent instincts -- confidence is frozen
        if (instinct.status === "permanent") continue;

        // Only update confidence if instinct has a tool_name contextCondition matching event.toolName
        const isRelevant = instinct.contextConditions.length === 0 ||
          instinct.contextConditions.some(cc =>
            cc.type === "tool_name" && cc.value === event.toolName
          );
        if (!isRelevant) continue;

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
    const trajectory: Trajectory = {
      id: `traj_${randomUUID()}` as TrajectoryId,
      sessionId: createBrand(params.sessionId, "SessionId" as const),
      chatId: params.chatId ? createBrand(params.chatId, "ChatId" as const) : undefined,
      taskRunId: params.taskRunId,
      taskDescription: params.taskDescription,
      steps: params.steps,
      outcome: params.outcome,
      appliedInstinctIds: (params.appliedInstinctIds ?? []) as InstinctId[],
      createdAt: Date.now() as TimestampMs,
      processed: false,
    };

    this.storage.createTrajectory(trajectory);
    
    // Flush immediately to ensure trajectory exists in DB for any follow-up operations
    this.storage.flush();

    if (params.outcome.success && !params.outcome.hadErrors) {
      this.autoGenerateVerdict(trajectory);
    }
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
        this.storage.createInstinct(instinct, this.projectPath);
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
    // Check for similar existing instincts (use similarity threshold, not confidence)
    const similar = await this.patternMatcher.findSimilarInstincts(params.triggerPattern);
    // Check raw similarity (relevance), not confidence-weighted score
    if (similar.some(m => m.relevance > CONFIDENCE_THRESHOLDS.SIMILAR)) return null;

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
    return instinct;
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
        });
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
        });
      }
    }
  }

  // ─── Periodic Trajectory Extraction ─────────────────────────────────────────

  private async runPeriodicExtraction(): Promise<void> {
    const unprocessed = this.storage.getUnprocessedTrajectories();
    for (const trajectory of unprocessed) {
      // extractInstinctFromTrajectory -> considerInstinctCreation already persists
      await this.extractInstinctFromTrajectory(trajectory);
    }
    this.storage.markTrajectoriesProcessed(unprocessed.map(t => t.id));
  }

  // ─── Max Instincts Enforcement ──────────────────────────────────────────────

  async enforceMaxInstincts(): Promise<void> {
    const maxInstincts = this.config?.maxInstincts ?? 1000;
    const count = this.storage.countInstincts();
    if (count <= maxInstincts) return;
    const overflow = count - maxInstincts;
    // Delete deprecated first, then active if still over limit
    const deprecatedBefore = this.storage.countInstincts();
    this.storage.deleteLowestConfidenceInstincts("deprecated", overflow);
    const deprecatedAfter = this.storage.countInstincts();
    const deleted = deprecatedBefore - deprecatedAfter;
    if (deleted >= overflow) return;
    this.storage.deleteLowestConfidenceInstincts("active", overflow - deleted);
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
    const relevantLines = output.split("\n").filter(l =>
      /error|Error|failed|Exception/i.test(l)
    );
    return relevantLines.join(" ").slice(0, 500);
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
}
