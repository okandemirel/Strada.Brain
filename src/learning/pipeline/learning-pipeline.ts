/**
 * Learning Pipeline - Core learning engine for pattern detection and instinct creation
 * 
 * Processes observations, creates instincts, and manages evolution of learned patterns.
 */

import { randomUUID } from "node:crypto";
import { LearningStorage } from "../storage/learning-storage.js";
import { ConfidenceScorer } from "../scoring/confidence-scorer.js";
import { PatternMatcher } from "../matching/pattern-matcher.js";
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
  type EvolutionProposalId,
  type LearningConfig,
  type ErrorDetails,
  type InstinctType,
  type ContextCondition,
  type ContextConditionId,
  createInstinctId,
} from "../types.js";
import { createBrand, type ToolName, type TimestampMs, type JsonObject } from "../../types/index.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLDS = {
  EVOLUTION: 0.9,
  ACTIVE: 0.7,
  DEPRECATED: 0.3,
  SIMILAR: 0.85,
  AUTO_EVOLVE: 0.95,
  MAX_INITIAL: 0.8,
};

const VERDICT_SCORE = {
  HIGH: 0.7,
  PERFECT: 1.0,
};

// ─── LearningPipeline Class ──────────────────────────────────────────────────

export class LearningPipeline {
  private storage: LearningStorage;
  private confidenceScorer: ConfidenceScorer;
  private patternMatcher: PatternMatcher;
  private config: LearningConfig;
  private detectionTimer: ReturnType<typeof setInterval> | null = null;
  private evolutionTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(storage: LearningStorage, config: Partial<LearningConfig> = {}) {
    this.storage = storage;
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
    this.confidenceScorer = new ConfidenceScorer();
    this.patternMatcher = new PatternMatcher(storage);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.isRunning || !this.config.enabled) return;
    
    this.isRunning = true;
    this.detectionTimer = setInterval(() => this.runDetectionBatch(), this.config.detectionIntervalMs);
    this.evolutionTimer = setInterval(() => this.runEvolution(), this.config.evolutionIntervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.detectionTimer) {
      clearInterval(this.detectionTimer);
      this.detectionTimer = null;
    }
    if (this.evolutionTimer) {
      clearInterval(this.evolutionTimer);
      this.evolutionTimer = null;
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
    const observation: Observation = {
      id: `obs_${randomUUID()}` as ObservationId,
      type: params.success ? "success" : "error",
      sessionId: createBrand(params.sessionId, "SessionId" as const),
      toolName: createBrand(params.toolName, "ToolName" as const),
      input: params.input as JsonObject,
      output: params.output,
      success: params.success,
      errorDetails: params.errorDetails,
      timestamp: Date.now() as TimestampMs,
      processed: false,
    };

    this.storage.recordObservation(observation);
    this.storage.flush();

    if (!params.success && params.errorDetails) {
      this.recordErrorPattern(params.errorDetails, params.toolName);
    }
  }

  observeCorrection(params: {
    sessionId: string;
    toolName: string;
    originalInput: Record<string, unknown>;
    originalOutput: string;
    correctedOutput: string;
    correction: string;
  }): void {
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

    this.considerInstinctCreation({
      type: "correction",
      triggerPattern: this.extractTriggerPattern(params.originalOutput),
      action: params.correction,
      toolName: params.toolName,
    });
  }

  // ─── Trajectory Methods ──────────────────────────────────────────────────────

  recordTrajectory(params: {
    sessionId: string;
    taskDescription: string;
    steps: TrajectoryStep[];
    outcome: TrajectoryOutcome;
    appliedInstinctIds?: string[];
  }): void {
    const trajectory: Trajectory = {
      id: `traj_${randomUUID()}` as TrajectoryId,
      sessionId: createBrand(params.sessionId, "SessionId" as const),
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

  runDetectionBatch(): { instinctsCreated: number; patternsDetected: number } {
    if (!this.config.enabled) return { instinctsCreated: 0, patternsDetected: 0 };

    let instinctsCreated = 0;
    let patternsDetected = 0;

    // Process observations
    const observations = this.storage.getUnprocessedObservations(this.config.batchSize);
    for (const obs of observations) {
      if (this.processObservation(obs)) patternsDetected++;
    }
    this.storage.markObservationsProcessed(observations.map(o => o.id));

    // Process trajectories
    const trajectories = this.storage.getUnprocessedTrajectories(this.config.batchSize);
    for (const trajectory of trajectories) {
      const instinct = this.extractInstinctFromTrajectory(trajectory);
      if (instinct) {
        this.storage.createInstinct(instinct);
        instinctsCreated++;
      }
    }
    this.storage.markTrajectoriesProcessed(trajectories.map(t => t.id));

    return { instinctsCreated, patternsDetected };
  }

  // ─── Instinct Management ─────────────────────────────────────────────────────

  considerInstinctCreation(params: {
    type: InstinctType;
    triggerPattern: string;
    action: string;
    toolName?: string;
    contextConditions?: ContextCondition[];
  }): Instinct | null {
    // Check for similar existing instincts (use similarity threshold, not confidence)
    const similar = this.patternMatcher.findSimilarInstincts(params.triggerPattern);
    // Check raw similarity (relevance), not confidence-weighted score
    if (similar.some(m => m.relevance > CONFIDENCE_THRESHOLDS.SIMILAR)) return null;

    const initialConfidence = this.calculateInitialConfidence(params);
    if (initialConfidence < this.config.minConfidenceForCreation) return null;

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
    };

    this.storage.createInstinct(instinct);
    return instinct;
  }

  createInstinct(params: Omit<Instinct, "id" | "stats" | "createdAt" | "updatedAt" | "sourceTrajectoryIds" | "tags">): Instinct {
    const instinct: Instinct = {
      ...params,
      id: createInstinctId(),
      stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
      createdAt: Date.now() as TimestampMs,
      updatedAt: Date.now() as TimestampMs,
      sourceTrajectoryIds: [],
      tags: [],
    };

    this.storage.createInstinct(instinct);
    return instinct;
  }

  updateInstinctStatus(instinct: Instinct): void {
    let newStatus = instinct.status;
    
    if (instinct.confidence >= CONFIDENCE_THRESHOLDS.EVOLUTION) {
      // Ready for evolution
    } else if (instinct.confidence >= CONFIDENCE_THRESHOLDS.ACTIVE && instinct.status === "proposed") {
      newStatus = "active";
    } else if (instinct.confidence < CONFIDENCE_THRESHOLDS.DEPRECATED && instinct.status === "active") {
      newStatus = "deprecated";
    }

    const updatedInstinct: Instinct = { 
      ...instinct, 
      status: newStatus,
      updatedAt: Date.now() as TimestampMs 
    };
    this.storage.updateInstinct(updatedInstinct);
  }

  // ─── Evolution ───────────────────────────────────────────────────────────────

  runEvolution(): { proposals: number } {
    if (!this.config.enabled) return { proposals: 0 };

    let proposals = 0;
    const candidates = this.storage.getInstincts({
      status: "active",
      minConfidence: CONFIDENCE_THRESHOLDS.EVOLUTION,
    });

    for (const instinct of candidates) {
      if (instinct.type === "tool_usage" && instinct.confidence > CONFIDENCE_THRESHOLDS.AUTO_EVOLVE) {
        this.evolveToSkill(instinct);
        proposals++;
      }
    }

    return { proposals };
  }

  evolveToSkill(instinct: Instinct): EvolutionProposal {
    const proposal: EvolutionProposal = {
      id: `evolution_${randomUUID()}` as EvolutionProposalId,
      instinctId: instinct.id,
      targetType: "skill",
      name: instinct.name,
      description: `Evolved skill from instinct: ${instinct.name}`,
      confidence: instinct.confidence,
      implementation: this.generateSkillImplementation(instinct),
      status: "pending",
      proposedAt: Date.now() as TimestampMs,
      affectedTrajectoryIds: [],
    };

    // Access db through a public method or use storage methods
    const storage = this.storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } | null };
    storage.db?.prepare(`
      INSERT INTO evolution_proposals 
      (id, instinct_id, target_type, name, description, confidence, implementation, status, proposed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.id, proposal.instinctId, proposal.targetType, proposal.name,
      proposal.description, proposal.confidence, proposal.implementation ?? null,
      proposal.status, proposal.proposedAt
    );

    const updatedInstinct: Instinct = { 
      ...instinct, 
      status: "evolved",
      evolvedTo: proposal.id as InstinctId,
      updatedAt: Date.now() as TimestampMs 
    };
    this.storage.updateInstinct(updatedInstinct);

    return proposal;
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

  private processObservation(obs: Observation): boolean {
    switch (obs.type) {
      case "error":
        if (obs.errorDetails) this.recordErrorPattern(obs.errorDetails, obs.toolName);
        return true;
      case "correction":
        if (obs.correction) {
          this.considerInstinctCreation({
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

  private extractInstinctFromTrajectory(trajectory: Trajectory): Instinct | null {
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
        return this.considerInstinctCreation({
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

  private generateSkillImplementation(instinct: Instinct): string {
    return `
// Auto-generated skill from instinct: ${instinct.name}
// Confidence: ${instinct.confidence}

export async function executeSkill(context: SkillContext): Promise<SkillResult> {
  // Trigger pattern: ${instinct.triggerPattern.slice(0, 100)}...
  const action = ${instinct.action};
  return await context.execute(action);
}
`;
  }

  // ─── Public Getters ──────────────────────────────────────────────────────────

  getStats() {
    return this.storage.getStats();
  }
}
