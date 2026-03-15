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

import { MUTATION_TOOLS, VERIFY_TOOLS } from "./constants.js";
import type { LearningPipeline, TrajectoryStep, TrajectoryOutcome, TrajectoryStepResult, ErrorDetails } from "../../learning/index.js";
import { createBrand, now, durationMs, type JsonObject, type JsonValue } from "../../types/index.js";

/** Convert Record<string, unknown> to JsonObject, filtering non-JSON values */
function toJsonObject(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, v]) =>
        typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null ||
        Array.isArray(v) || (typeof v === "object" && v !== null)
      )
      .map(([k, v]) => {
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          return [k, v as JsonObject];
        }
        return [k, v as JsonValue];
      })
  ) as JsonObject;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const MAX_ERROR_HISTORY = 10;
const VERIFY_THRESHOLD = 2;   // mutations before nagging about verification
const STALL_THRESHOLD = 3;    // consecutive errors before suggesting new approach
const BUDGET_WARNING = 40;    // iteration count to warn about budget

/** Injected into system prompt once per task. */
const PLANNING_PROMPT = `

## Autonomous Execution Protocol

Follow this protocol for EVERY task:

### PLAN → ACT → VERIFY → RESPOND

1. **PLAN**: Break complex requests into ordered sub-tasks. State your plan briefly.
2. **ACT**: Execute one sub-task at a time. Read files before editing.
3. **VERIFY**: After editing files, run dotnet_build. After bug fixes, run dotnet_test.
   NEVER declare done without verifying compilation.
4. **RESPOND**: Only after verification passes, give your final response.

### Error Recovery
- When build/test fails, analyze errors systematically.
- Fix in dependency order: missing types → undefined symbols → type mismatches → logic.
- After fixing, rebuild to verify. If stuck after 3 attempts, try a different approach.
`;

// ─── State ──────────────────────────────────────────────────────────────────────

export interface TaskState {
  readonly mutationsSinceVerify: number;
  readonly consecutiveErrors: number;
  readonly buildVerified: boolean;
  readonly iterationsUsed: number;
  readonly errorHistory: readonly string[];
  /** Current session ID for learning */
  readonly sessionId: string;
  /** Task description */
  readonly taskDescription: string;
}

// ─── Planner ────────────────────────────────────────────────────────────────────

export class TaskPlanner {
  private mutationsSinceVerify = 0;
  private consecutiveErrors = 0;
  private buildVerified = false;
  private iterationsUsed = 0;
  private errorHistory: string[] = [];
  private sessionId = "";
  private taskDescription = "";
  private isTaskActive = false;

  private learningPipeline: LearningPipeline | null = null;
  private trajectorySteps: TrajectoryStep[] = [];
  private trajectoryStartTime: number = 0;

  /** Reset for a new task. */
  reset(): void {
    this.mutationsSinceVerify = 0;
    this.consecutiveErrors = 0;
    this.buildVerified = false;
    this.iterationsUsed = 0;
    this.errorHistory = [];
    this.sessionId = "";
    this.taskDescription = "";
    this.isTaskActive = false;
    this.trajectorySteps = [];
    this.trajectoryStartTime = 0;
  }

  /**
   * Start a new task with learning integration
   */
  startTask(params: {
    sessionId: string;
    taskDescription: string;
    learningPipeline?: LearningPipeline;
  }): void {
    this.reset();
    this.sessionId = params.sessionId;
    this.taskDescription = params.taskDescription;
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
    const completionRate = Math.min(this.iterationsUsed / 50, 1);
    
    const outcome: TrajectoryOutcome = {
      success: params.success,
      finalOutput: params.finalOutput,
      totalSteps: this.iterationsUsed,
      hadErrors: params.hadErrors,
      errorCount: params.errorCount,
      durationMs: durationMs(Date.now() - this.trajectoryStartTime),
      completionRate: completionRate as unknown as import("../../types/index.js").NormalizedScore,
    };

    // Record trajectory for learning
    if (this.learningPipeline) {
      this.learningPipeline.recordTrajectory({
        sessionId: this.sessionId,
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

  /** One-time system prompt append. */
  getPlanningPrompt(): string {
    return PLANNING_PROMPT;
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
    this.iterationsUsed++;

    // Mutation tracking — O(1)
    if (MUTATION_TOOLS.has(toolName)) {
      this.mutationsSinceVerify++;
      this.buildVerified = false;
    }

    // Verification tracking — O(1)
    if (VERIFY_TOOLS.has(toolName) && !isError) {
      this.mutationsSinceVerify = 0;
      if (toolName === "dotnet_build") this.buildVerified = true;
      this.consecutiveErrors = 0;
    }

    // Error tracking — O(1)
    if (isError) {
      this.consecutiveErrors++;
    } else if (!VERIFY_TOOLS.has(toolName)) {
      this.consecutiveErrors = 0;
    }

    // Record step for trajectory
    if (this.isTaskActive) {
      const jsonInput = input ? toJsonObject(input) : {} as JsonObject;
      
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
   * Get iteration-aware state injection.
   * Returns empty string when no intervention needed (fast path).
   */
  getStateInjection(): string {
    // Fast path: nothing to say
    if (this.mutationsSinceVerify < VERIFY_THRESHOLD
        && this.consecutiveErrors < STALL_THRESHOLD
        && this.iterationsUsed < BUDGET_WARNING) {
      return "";
    }

    const parts: string[] = [];

    if (this.mutationsSinceVerify >= VERIFY_THRESHOLD && !this.buildVerified) {
      parts.push(
        `[VERIFY] ${this.mutationsSinceVerify} files modified without build check. ` +
        `Run dotnet_build before continuing.`
      );
    }

    if (this.consecutiveErrors >= STALL_THRESHOLD) {
      const recent = this.errorHistory.slice(-3).join(" | ");
      parts.push(
        `[STALL] ${this.consecutiveErrors} consecutive errors. ` +
        `Consider a different approach. Recent: ${recent}`
      );
    }

    if (this.iterationsUsed >= BUDGET_WARNING) {
      parts.push(
        `[BUDGET] ${this.iterationsUsed}/50 iterations used. Wrap up and verify.`
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
