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
  /**
   * Append a visibility notice to an already-blocked task and re-announce it on
   * the channel. Used when automatic resume/replan budgets are exhausted — the
   * decision must reach the person waiting, not only the log file.
   */
  appendTaskNotice(id: string, notice: string): void;
  attachGoalRoot(taskId: string, goalRootId: string): void;
  /**
   * Resubmit a blocked goal tree, keeping every completed node and replaying
   * the rest. Present since the dashboard's retry button; the executor now
   * calls it too, so a run does not stop just because nobody is watching.
   */
  retryGoalRoot(goalRootId: string, nodeId?: string): unknown;
  /** Resubmit a finished/blocked task's original prompt (mission keep-alive). */
  retryTask(taskId: string): unknown;
  /** Executing tasks with no progress signal since the cutoff (stuck-task reaper). */
  listStuckExecuting(olderThanMs: number): unknown[];
  /** Bump the task's liveness clock without recording a progress entry. */
  touch?(id: string): void;
  /** Recent tasks for a chat (queue-continuation checks). */
  listTasks(chatId: string, limit: number): Array<{ id: string; status: string; chatId: string; prompt: string }>;
  /**
   * Plan a stalled goal again from scratch with the failure reasons as input.
   * Replaying the same tree cannot get past an obstacle the plan itself has.
   */
  replanGoalRoot(goalRootId: string, failureReasons?: readonly string[]): unknown;
  /**
   * Look up a task by id. The executor walks parentId chains with this to find
   * the lineage root a retry budget belongs to — retry/replan mint fresh goal
   * roots, and a budget keyed on the root resets every round (measured
   * 2026-08-26: one lineage produced 35 blocked tasks at a 23s cadence).
   */
  getStatus(id: string): { id: string; parentId?: string } | null;
  hasActiveForegroundTasks(excludedChatIds?: readonly string[]): boolean;
}

/** Minimal contract that TaskManager needs from BackgroundExecutor. */
export interface IBackgroundExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enqueue(task: any, signal: AbortSignal, onProgress: (message: any) => void): void;
  pauseConversation(conversationKey: string): void;
  resumeConversation(conversationKey: string): void;
  isConversationPaused(conversationKey: string): boolean;
}

// ─── Orchestrator Interface ──────────────────────────────────────────────────

/**
 * Minimal contract the task system needs from an Orchestrator instance.
 *
 * Cutover Step 5 removed the v1 `runBackgroundTask` entry point: the task system now routes
 * every run through the Agent Core runner seam (`selectAgentRunner` over the host hooks below;
 * see `src/agent-core/runner/runner-factory.ts`). The hooks are typed loosely here to keep this
 * contract import-free (it must not import ./types.ts, and stays decoupled from agent-core's
 * concrete types — background-executor narrows via `RunnerHostOrchestrator` at the call site).
 */
export interface IOrchestrator {
  /** Agent Core v2 strangler seam: builds the port/gateway bundle the V2 runner drives. */
  createAgentCorePort(): unknown;
  /** The injected agent-core clock (SystemClock in prod, FakeClock in tests). */
  getAgentCoreClock(): unknown;
  /**
   * Called after every tool execution, purely so the task's inactivity watchdog
   * can tell "working" from "hung".
   *
   * Attached to tool execution rather than to any one control path because a
   * task that is running tools is not idle, whichever path is driving it. An
   * earlier fix signalled liveness from supervisor node transitions only, and a
   * plain-loop run was killed at 20 minutes regardless: measured, "no progress
   * for 1200000ms" fired at 20:56:05 on a task whose last tool call was 20:55:16
   * and whose next one landed at 20:56:24 — after it had been stopped.
   */
  setLivenessCallback?(callback: () => void): void;
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
