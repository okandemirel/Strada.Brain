/**
 * Orchestrator Contract
 *
 * Lightweight interface that the task system uses to reference the
 * Orchestrator without importing the full implementation module.
 * This breaks the circular dependency between tasks/ and agents/orchestrator.ts.
 *
 * The concrete Orchestrator class satisfies this interface structurally
 * (duck-typing) — no explicit `implements` clause is required.
 *
 * IMPORTANT: This file must NOT import from ./types.ts to avoid an
 * intra-package cycle (types.ts already imports from this file).
 */

import type { SupervisorResult } from "../supervisor/supervisor-types.js";

// ─── Task System Interfaces ─────────────────────────────────────────────────
// Minimal contracts to break the task-manager <-> background-executor cycle.

/** Minimal contract that BackgroundExecutor needs from TaskManager. */
export interface ITaskManager {
  updateStatus(id: string, status: string): void;
  complete(id: string, result: string): void;
  fail(id: string, error: string): void;
  block(id: string, reason: string): void;
  attachGoalRoot(taskId: string, goalRootId: string): void;
  hasActiveForegroundTasks(excludedChatIds?: readonly string[]): boolean;
}

/** Minimal contract that TaskManager needs from BackgroundExecutor. */
export interface IBackgroundExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enqueue(task: any, signal: AbortSignal, onProgress: (message: any) => void): void;
}

// ─── Orchestrator Interface ──────────────────────────────────────────────────

/** Minimal contract the task system needs from an Orchestrator instance. */
export interface IOrchestrator {
  /**
   * Execute a task in background mode and return the visible response.
   *
   * The `options` parameter uses a broad signature here to avoid importing
   * BackgroundTaskOptions (which lives in ./types.ts and would create an
   * intra-package cycle). Callers in background-executor.ts always pass a
   * properly-typed BackgroundTaskOptions object.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runBackgroundTask(prompt: string, options: any): Promise<string>;
}

// ─── Supervisor Admission Types ──────────────────────────────────────────────

export type SupervisorAdmissionPath = "supervisor" | "direct_worker";

export type SupervisorAdmissionReason =
  | "eligible"
  | "multimodal_passthrough"
  | "busy"
  | "low_complexity"
  | "not_decomposable"
  | "unavailable"
  | "supervisor_error";

export type SupervisorAdmissionDecision =
  | {
      readonly path: "supervisor";
      readonly reason: "eligible";
      readonly result: SupervisorResult;
    }
  | {
      readonly path: Exclude<SupervisorAdmissionPath, "supervisor">;
      readonly reason: Exclude<SupervisorAdmissionReason, "eligible">;
    };
