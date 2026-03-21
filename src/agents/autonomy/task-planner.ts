/**
 * Task Planner
 *
 * Injects autonomous planning behavior into the LLM via system prompt
 * and tracks execution state to detect stalls and enforce verification gates.
 *
 * Learning Integration:
 *   - Records successful trajectories
 *   - Observes tool usage patterns
 *   - Tracks corrections for pattern learning
 *
 * Performance:
 *   - Tool tracking: O(1) per call via Set.has()
 *   - State injection: O(1) — checks counters, not lists
 *   - Error history: bounded array (max 10)
 */

import { MUTATION_TOOLS, isVerificationToolName } from "./constants.js";
import { expandExecutedToolCalls } from "./executed-tools.js";
import { randomUUID } from "node:crypto";
import type {
  LearningPipeline,
  TrajectoryReplayContext,
  TrajectoryPhaseReplay,
  TrajectoryStep,
  TrajectoryOutcome,
  TrajectoryStepResult,
  ErrorDetails,
} from "../../learning/index.js";
import {
  createBrand,
  now,
  durationMs,
  type JsonObject,
  type JsonValue,
} from "../../types/index.js";

/** Convert Record<string, unknown> to JsonObject, filtering non-JSON values */
function toJsonObject(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([, v]) =>
          typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean" ||
          v === null ||
          Array.isArray(v) ||
          (typeof v === "object" && v !== null),
      )
      .map(([k, v]) => {
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          return [k, v as JsonObject];
        }
        return [k, v as JsonValue];
      }),
  ) as JsonObject;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const MAX_ERROR_HISTORY = 10;
const VERIFY_THRESHOLD = 2; // mutations before nagging about verification
const STALL_THRESHOLD = 3; // consecutive errors before suggesting new approach
const DEFAULT_ITERATION_BUDGET = 50;
const BUDGET_WARNING_RATIO = 0.8;

// ─── State ──────────────────────────────────────────────────────────────────────

export interface TaskState {
  readonly mutationsSinceVerify: number;
  readonly consecutiveErrors: number;
  readonly buildVerified: boolean;
  readonly iterationsUsed: number;
  readonly budgetWindowIterationsUsed: number;
  readonly errorHistory: readonly string[];
  /** Current session ID for learning */
  readonly sessionId: string;
  /** Task description */
  readonly taskDescription: string;
}

export interface TaskPlannerOptions {
  readonly iterationBudget?: number;
}

// ─── Planner ────────────────────────────────────────────────────────────────────

export class TaskPlanner {
  private mutationsSinceVerify = 0;
  private consecutiveErrors = 0;
  private buildVerified = false;
  private iterationsUsed = 0;
  private budgetWindowIterationsUsed = 0;
  private errorHistory: string[] = [];
  private sessionId = "";
  private chatId: string | undefined;
  private taskDescription = "";
  private taskRunId = "";
  private isTaskActive = false;

  private learningPipeline: LearningPipeline | null = null;
  private trajectorySteps: TrajectoryStep[] = [];
  private trajectoryStartTime: number = 0;
  private trajectoryReplayContext: TrajectoryReplayContext | undefined;
  private readonly iterationBudget: number;
  private readonly budgetWarningThreshold: number;

  constructor(options: TaskPlannerOptions = {}) {
    this.iterationBudget = Math.max(1, options.iterationBudget ?? DEFAULT_ITERATION_BUDGET);
    this.budgetWarningThreshold = Math.max(
      1,
      Math.min(this.iterationBudget, Math.ceil(this.iterationBudget * BUDGET_WARNING_RATIO)),
    );
  }

  /** Reset for a new task. */
  reset(): void {
    this.mutationsSinceVerify = 0;
    this.consecutiveErrors = 0;
    this.buildVerified = false;
    this.iterationsUsed = 0;
    this.budgetWindowIterationsUsed = 0;
    this.errorHistory = [];
    this.sessionId = "";
    this.chatId = undefined;
    this.taskDescription = "";
    this.taskRunId = "";
    this.isTaskActive = false;
    this.trajectorySteps = [];
    this.trajectoryStartTime = 0;
    this.trajectoryReplayContext = undefined;
  }

  /**
   * Start a new task with learning integration
   */
  startTask(params: {
    sessionId: string;
    chatId?: string;
    taskDescription: string;
    learningPipeline?: LearningPipeline;
  }): void {
    this.reset();
    this.sessionId = params.sessionId;
    this.chatId = params.chatId;
    this.taskDescription = params.taskDescription;
    this.taskRunId = `taskrun_${randomUUID()}`;
    this.isTaskActive = true;
    this.trajectoryStartTime = Date.now();

    if (params.learningPipeline) {
      this.learningPipeline = params.learningPipeline;
    }
  }

  /**
   * End the current task and record trajectory
   */
  endTask(params: {
    success: boolean;
    finalOutput?: string;
    hadErrors: boolean;
    errorCount: number;
  }): void {
    if (!this.isTaskActive) return;

    // Calculate completion rate (steps used / max budget of 50)
    const completionRate = Math.min(this.budgetWindowIterationsUsed / this.iterationBudget, 1);

    const outcome: TrajectoryOutcome = {
      success: params.success,
      finalOutput: params.finalOutput,
      totalSteps: this.iterationsUsed,
      hadErrors: params.hadErrors,
      errorCount: params.errorCount,
      durationMs: durationMs(Date.now() - this.trajectoryStartTime),
      completionRate: completionRate as unknown as import("../../types/index.js").NormalizedScore,
      replayContext: this.trajectoryReplayContext,
    };

    // Record trajectory for learning
    if (this.learningPipeline) {
      this.learningPipeline.recordTrajectory({
        sessionId: this.sessionId,
        chatId: this.chatId,
        taskRunId: this.taskRunId || undefined,
        taskDescription: this.taskDescription,
        steps: this.trajectorySteps,
        outcome,
      });
    }

    this.isTaskActive = false;
  }

  /**
   * Connect to learning pipeline
   */
  enableLearning(pipeline: LearningPipeline): void {
    this.learningPipeline = pipeline;
  }

  /**
   * Disconnect learning pipeline
   */
  disableLearning(): void {
    this.learningPipeline = null;
  }

  /**
   * Start timestamp for the currently active trajectory window.
   * Used to collect task-scoped replay telemetry after orchestration finishes.
   */
  getTaskStartedAt(): number | null {
    return this.trajectoryStartTime || null;
  }

  getTaskRunId(): string | null {
    return this.taskRunId || null;
  }

  /**
   * Attach replay/recovery context to the trajectory that will be recorded
   * when the current task ends.
   */
  attachReplayContext(context: TrajectoryReplayContext | null | undefined): void {
    if (!context) {
      this.trajectoryReplayContext = undefined;
      return;
    }

    const learnedInsights = (context.learnedInsights ?? [])
      .map((insight) => insight.trim())
      .filter((insight) => insight.length > 0)
      .slice(0, 4);
    const phaseTelemetry = (context.phaseTelemetry ?? [])
      .map((phase): TrajectoryPhaseReplay | null => {
        const provider = phase.provider.trim();
        if (!provider) {
          return null;
        }
        return {
          phase: phase.phase,
          role: phase.role,
          provider,
          model: phase.model?.trim() || undefined,
          source: phase.source,
          status: phase.status,
          verifierDecision: phase.verifierDecision,
          phaseVerdict: phase.phaseVerdict,
          phaseVerdictScore: phase.phaseVerdictScore,
          retryCount:
            typeof phase.retryCount === "number" ? Math.max(0, phase.retryCount) : undefined,
          rollbackDepth:
            typeof phase.rollbackDepth === "number" ? Math.max(0, phase.rollbackDepth) : undefined,
          timestamp: phase.timestamp,
        };
      })
      .filter((phase): phase is TrajectoryPhaseReplay => phase !== null)
      .slice(0, 12);

    this.trajectoryReplayContext = {
      projectWorldFingerprint: context.projectWorldFingerprint?.trim() || undefined,
      projectWorldSummary: context.projectWorldSummary?.trim() || undefined,
      branchSummary: context.branchSummary?.trim() || undefined,
      verifierSummary: context.verifierSummary?.trim() || undefined,
      learnedInsights,
      phaseTelemetry,
    };
  }

  /**
   * Track a completed tool call. O(1).
   */
  trackToolCall(
    toolName: string,
    isError: boolean,
    input?: Record<string, unknown>,
    output?: string,
  ): void {
    const executedTools = expandExecutedToolCalls(toolName, input ?? {}, {
      toolCallId: "planner-track",
      content: output ?? "",
      isError,
    });

    for (const executedTool of executedTools) {
      this.iterationsUsed++;
      this.budgetWindowIterationsUsed++;

      // Mutation tracking — O(1)
      if (MUTATION_TOOLS.has(executedTool.toolName)) {
        this.mutationsSinceVerify++;
        this.buildVerified = false;
      }

      // Verification tracking — O(1)
      const isVerificationTool = isVerificationToolName(executedTool.toolName);

      if (isVerificationTool && !executedTool.isError) {
        this.mutationsSinceVerify = 0;
        this.buildVerified = true;
        this.consecutiveErrors = 0;
      }

      // Error tracking — O(1)
      if (executedTool.isError) {
        this.consecutiveErrors++;
      } else if (!isVerificationTool) {
        this.consecutiveErrors = 0;
      }
    }

    // Record step for trajectory
    if (this.isTaskActive) {
      const jsonInput = input ? toJsonObject(input) : ({} as JsonObject);

      // Build TrajectoryStepResult based on isError
      let result: TrajectoryStepResult;
      if (isError) {
        const errorDetails: ErrorDetails = {
          category: "unknown",
          message: output ?? "Unknown error",
        };
        result = { kind: "error", error: errorDetails };
      } else {
        result = { kind: "success", output: output ?? "" };
      }

      const step: TrajectoryStep = {
        stepNumber: this.iterationsUsed,
        toolName: createBrand(toolName, "ToolName"),
        input: jsonInput,
        result,
        timestamp: now(),
        durationMs: durationMs(0),
      };
      this.trajectorySteps.push(step);

      // NOTE: Direct pipeline.observeToolUse() removed -- event bus handles this now.
      // The orchestrator emits 'tool:result' events which the learning pipeline subscribes to.
    }
  }

  /**
   * Record a correction for learning
   */
  async recordCorrection(params: {
    toolName: string;
    originalInput: Record<string, unknown>;
    originalOutput: string;
    correctedOutput: string;
    correction: string;
  }): Promise<void> {
    if (!this.learningPipeline) return;

    await this.learningPipeline.observeCorrection({
      sessionId: this.sessionId,
      toolName: params.toolName,
      originalInput: params.originalInput,
      originalOutput: params.originalOutput,
      correctedOutput: params.correctedOutput,
      correction: params.correction,
    });

    // Also record as a step
    const jsonInput = toJsonObject(params.originalInput);

    const step: TrajectoryStep = {
      stepNumber: this.iterationsUsed + 1,
      toolName: createBrand("correction", "ToolName"),
      input: jsonInput,
      result: { kind: "success", output: params.correctedOutput },
      timestamp: now(),
      durationMs: durationMs(0),
    };
    this.trajectorySteps.push(step);
  }

  /**
   * Record an error summary for stall detection.
   * Bounded array (max 10 entries).
   */
  recordError(summary: string): void {
    if (this.errorHistory.length >= MAX_ERROR_HISTORY) {
      this.errorHistory.shift();
    }
    this.errorHistory.push(summary);
  }

  /**
   * Reset the active budget window without losing total task history.
   * Used when long-running autonomous work rolls into a new background epoch.
   */
  resetBudgetWindow(): void {
    this.budgetWindowIterationsUsed = 0;
  }

  /**
   * Get iteration-aware state injection.
   * Returns empty string when no intervention needed (fast path).
   */
  getStateInjection(): string {
    // Fast path: nothing to say
    if (
      this.mutationsSinceVerify < VERIFY_THRESHOLD &&
      this.consecutiveErrors < STALL_THRESHOLD &&
      this.budgetWindowIterationsUsed < this.budgetWarningThreshold
    ) {
      return "";
    }

    const parts: string[] = [];

    if (this.mutationsSinceVerify >= VERIFY_THRESHOLD && !this.buildVerified) {
      parts.push(
        `[VERIFY] ${this.mutationsSinceVerify} files modified without build check. ` +
          `Run dotnet_build before continuing.`,
      );
    }

    if (this.consecutiveErrors >= STALL_THRESHOLD) {
      const recent = this.errorHistory.slice(-3).join(" | ");
      parts.push(
        `[STALL] ${this.consecutiveErrors} consecutive errors. ` +
          `Consider a different approach. Recent: ${recent}`,
      );
    }

    if (this.budgetWindowIterationsUsed >= this.budgetWarningThreshold) {
      parts.push(
        `[BUDGET] ${this.budgetWindowIterationsUsed}/${this.iterationBudget} iterations used in the current execution window. Wrap up and verify.`,
      );
    }

    return parts.length > 0 ? "\n" + parts.join("\n") : "";
  }

  /** Read-only state snapshot for testing/debugging. */
  getState(): TaskState {
    return {
      mutationsSinceVerify: this.mutationsSinceVerify,
      consecutiveErrors: this.consecutiveErrors,
      buildVerified: this.buildVerified,
      iterationsUsed: this.iterationsUsed,
      budgetWindowIterationsUsed: this.budgetWindowIterationsUsed,
      errorHistory: [...this.errorHistory],
      sessionId: this.sessionId,
      taskDescription: this.taskDescription,
    };
  }

  /** Get trajectory steps recorded so far */
  getTrajectorySteps(): readonly TrajectoryStep[] {
    return [...this.trajectorySteps];
  }

  /** Check if a task is currently active */
  isActive(): boolean {
    return this.isTaskActive;
  }
}
