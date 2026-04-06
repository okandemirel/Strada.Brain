/**
 * Orchestrator Contract
 *
 * Lightweight interface that the task system uses to reference the
 * Orchestrator without importing the full implementation module.
 * This breaks the circular dependency between tasks/ and agents/orchestrator.ts.
 *
 * The concrete Orchestrator class satisfies this interface structurally
 * (duck-typing) — no explicit `implements` clause is required.
 */

import type { BackgroundTaskOptions } from "./types.js";
import type { SupervisorResult } from "../supervisor/supervisor-types.js";

// ─── Orchestrator Interface ──────────────────────────────────────────────────

/** Minimal contract the task system needs from an Orchestrator instance. */
export interface IOrchestrator {
  /** Execute a task in background mode and return the visible response. */
  runBackgroundTask(prompt: string, options: BackgroundTaskOptions): Promise<string>;
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
