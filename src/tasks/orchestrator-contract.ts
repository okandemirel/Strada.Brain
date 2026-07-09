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
