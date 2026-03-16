/**
 * Task System Domain Types
 *
 * Defines the task state machine, command types, and classification results
 * for the autonomous assistant task management system.
 */

import { randomBytes } from "node:crypto";
import type { TaskOrigin } from "../daemon/daemon-types.js";
import type { GoalTree } from "../goals/types.js";

// ─── Task Identity ──────────────────────────────────────────────────────────────

export type TaskId = string & { readonly __brand: "TaskId" };

export function generateTaskId(): TaskId {
  return `task_${randomBytes(4).toString("hex")}` as TaskId;
}

// ─── Task State Machine ─────────────────────────────────────────────────────────

export enum TaskStatus {
  pending = "pending",
  planning = "planning",
  executing = "executing",
  completed = "completed",
  failed = "failed",
  cancelled = "cancelled",
  paused = "paused",
  waiting_for_input = "waiting_for_input",
}

/** States that indicate a task is still alive (not terminal) */
export const ACTIVE_STATUSES = new Set([
  TaskStatus.pending,
  TaskStatus.planning,
  TaskStatus.executing,
  TaskStatus.paused,
  TaskStatus.waiting_for_input,
]);

/** States that indicate a task has finished (terminal) */
export const TERMINAL_STATUSES = new Set([
  TaskStatus.completed,
  TaskStatus.failed,
  TaskStatus.cancelled,
]);

// ─── Progress ────────────────────────────────────────────────────────────────────

export interface ProgressEntry {
  timestamp: number;
  message: string;
}

// ─── Task ────────────────────────────────────────────────────────────────────────

export interface Task {
  id: TaskId;
  chatId: string;
  channelType: string;
  title: string;
  status: TaskStatus;
  prompt: string;
  result?: string;
  error?: string;
  progress: ProgressEntry[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  parentId?: TaskId;
  /** Origin of the task -- 'user' for interactive, 'daemon' for daemon-initiated */
  origin?: TaskOrigin;
  /** Pre-decomposed goal tree for goal tasks (passed from Orchestrator to BackgroundExecutor) */
  goalTree?: GoalTree;
  /** Attachments forwarded from the incoming message (images, files) */
  attachments?: import("../channels/channel.interface.js").Attachment[];
}

// ─── Commands ────────────────────────────────────────────────────────────────────

export type TaskCommand = "status" | "cancel" | "tasks" | "detail" | "help" | "pause" | "resume" | "model" | "goal" | "autonomous" | "persona" | "daemon" | "agent" | "routing";

export interface ParsedCommand {
  type: "command";
  command: TaskCommand;
  args: string[];
}

export interface TaskRequest {
  type: "task_request";
  prompt: string;
}

export type ClassificationResult = ParsedCommand | TaskRequest;

// ─── Background Task Options ─────────────────────────────────────────────────────

export interface BackgroundTaskOptions {
  signal: AbortSignal;
  onProgress: (message: string) => void;
  chatId: string;
  channelType: string;
  /** Attachments from the original message for vision/file support */
  attachments?: import("../channels/channel.interface.js").Attachment[];
  /** Parent metric ID for subtask tracking (passed from BackgroundExecutor for decomposed tasks) */
  parentMetricId?: string;
}
