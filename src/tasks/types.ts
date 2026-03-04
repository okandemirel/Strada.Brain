/**
 * Task System Domain Types
 *
 * Defines the task state machine, command types, and classification results
 * for the autonomous assistant task management system.
 */

import { randomBytes } from "node:crypto";

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
}

// ─── Commands ────────────────────────────────────────────────────────────────────

export type TaskCommand = "status" | "cancel" | "tasks" | "detail" | "help" | "pause" | "resume";

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
}
