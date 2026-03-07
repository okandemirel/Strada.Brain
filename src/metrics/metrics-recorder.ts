/**
 * Metrics Recorder
 *
 * Thin facade for the orchestrator to record task metrics.
 * Handles three-state completion mapping from AgentPhase:
 *   - AgentPhase.COMPLETE -> 'success'
 *   - AgentPhase.FAILED -> 'failure'
 *   - hitMaxIterations=true -> 'partial'
 */

import { randomUUID } from "node:crypto";
import { AgentPhase } from "../agents/agent-state.js";
import type { MetricsStorage } from "./metrics-storage.js";
import type { CompletionStatus, TaskType } from "./metrics-types.js";

// ─── Pending Task ────────────────────────────────────────────────────────────

interface PendingTask {
  readonly sessionId: string;
  readonly taskDescription: string;
  readonly taskType: TaskType;
  readonly parentTaskId?: string;
  readonly instinctIds: string[];
  readonly startedAt: number;
}

// ─── Recorder ────────────────────────────────────────────────────────────────

export class MetricsRecorder {
  private readonly storage: MetricsStorage;
  private readonly pending = new Map<string, PendingTask>();
  private readonly recorded = new Set<string>();

  constructor(storage: MetricsStorage) {
    this.storage = storage;
  }

  /**
   * Start tracking a task. Returns a unique metric ID for endTask() correlation.
   */
  startTask(opts: {
    sessionId: string;
    taskDescription: string;
    taskType: TaskType;
    parentTaskId?: string;
    instinctIds?: string[];
  }): string {
    const id = `metric_${randomUUID()}`;
    this.pending.set(id, {
      sessionId: opts.sessionId,
      taskDescription: opts.taskDescription,
      taskType: opts.taskType,
      parentTaskId: opts.parentTaskId,
      instinctIds: opts.instinctIds ?? [],
      startedAt: Date.now(),
    });
    return id;
  }

  /**
   * Record the final metric for a completed task.
   * Maps AgentPhase to three-state CompletionStatus.
   */
  endTask(
    metricId: string,
    result: {
      agentPhase: AgentPhase;
      iterations: number;
      toolCallCount: number;
      hitMaxIterations: boolean;
    },
  ): void {
    const pendingTask = this.pending.get(metricId);
    if (!pendingTask) {
      return; // Already recorded or unknown ID
    }

    const completedAt = Date.now();
    const completionStatus = this.mapCompletionStatus(result.agentPhase, result.hitMaxIterations);

    this.storage.recordTaskMetric({
      id: metricId,
      sessionId: pendingTask.sessionId,
      parentTaskId: pendingTask.parentTaskId,
      taskType: pendingTask.taskType,
      taskDescription: pendingTask.taskDescription,
      completionStatus,
      paorIterations: result.iterations,
      toolCallCount: result.toolCallCount,
      instinctIds: pendingTask.instinctIds,
      instinctCount: pendingTask.instinctIds.length,
      startedAt: pendingTask.startedAt,
      completedAt,
      durationMs: completedAt - pendingTask.startedAt,
    });

    this.pending.delete(metricId);
    this.recorded.add(metricId);
  }

  /**
   * Check if a metric has been recorded (endTask called).
   */
  isRecorded(metricId: string): boolean {
    return this.recorded.has(metricId);
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Three-state completion mapping:
   *   hitMaxIterations=true -> 'partial' (work done but not finished)
   *   AgentPhase.COMPLETE -> 'success'
   *   AgentPhase.FAILED -> 'failure'
   *   Any other phase -> 'partial' (unexpected exit)
   */
  private mapCompletionStatus(phase: AgentPhase, hitMaxIterations: boolean): CompletionStatus {
    if (hitMaxIterations) {
      return "partial";
    }
    if (phase === AgentPhase.COMPLETE) {
      return "success";
    }
    if (phase === AgentPhase.FAILED) {
      return "failure";
    }
    // Unexpected phase at exit -- treat as partial
    return "partial";
  }
}
