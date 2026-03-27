/**
 * Task System Domain Types
 *
 * Defines the task state machine, command types, and classification results
 * for the autonomous assistant task management system.
 */

import { randomBytes } from "node:crypto";
import type { TaskOrigin } from "../daemon/daemon-types.js";
import type { GoalTree } from "../goals/types.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import type { WorkspaceLease } from "../agents/supervisor/supervisor-types.js";
import type { MessageContent } from "../agents/providers/provider-core.interface.js";

// ─── Task Identity ──────────────────────────────────────────────────────────────

export type TaskId = string & { readonly __brand: "TaskId" };

export function generateTaskId(): TaskId {
  return `task_${randomBytes(4).toString("hex")}` as TaskId;
}

export function getTaskConversationKey(chatId: string, channelType: string, conversationId?: string): string {
  return JSON.stringify([channelType, conversationId?.trim() || chatId]);
}

// ─── Task State Machine ─────────────────────────────────────────────────────────

export enum TaskStatus {
  pending = "pending",
  planning = "planning",
  executing = "executing",
  completed = "completed",
  failed = "failed",
  blocked = "blocked",
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
  TaskStatus.blocked,
  TaskStatus.cancelled,
]);

// ─── Progress ────────────────────────────────────────────────────────────────────

export type TaskProgressKind =
  | "other"
  | "status"
  | "editing"
  | "verification"
  | "analysis"
  | "inspection"
  | "clarification"
  | "visibility"
  | "replanning"
  | "delegation"
  | "loop_recovery"
  | "goal";

export interface TaskProgressSignal {
  kind: TaskProgressKind;
  message: string;
  userSummary?: string;
  reason?: string;
  files?: readonly string[];
  toolNames?: readonly string[];
  delegationType?: string;
}

export type TaskProgressUpdate = string | TaskProgressSignal;

export interface ProgressEntry {
  timestamp: number;
  message: string;
}

// ─── Task ────────────────────────────────────────────────────────────────────────

export interface Task {
  id: TaskId;
  chatId: string;
  channelType: string;
  conversationId?: string;
  userId?: string;
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
  /** Trigger name when spawned by daemon heartbeat. */
  triggerName?: string;
  /** Pre-decomposed goal tree for goal tasks (passed from Orchestrator to BackgroundExecutor) */
  goalTree?: GoalTree;
  /** Hint that the request already produced a goal plan and must re-enter shared planning. */
  forceSharedPlanning?: boolean;
  /** Original multimodal user content for grounded planning / execution fallback. */
  userContent?: string | MessageContent[];
  /** Attachments forwarded from the incoming message (images, files) */
  attachments?: import("../channels/channel.interface.js").Attachment[];
  /** Optional agent-specific orchestrator for queued execution paths. */
  orchestrator?: Orchestrator;
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
  onProgress: (message: TaskProgressUpdate) => void;
  chatId: string;
  channelType: string;
  taskRunId?: string;
  conversationId?: string;
  userId?: string;
  /** Internal: fixed provider assignment for delegated supervisor child runs. */
  assignedProvider?: string;
  /** Internal: fixed model assignment for delegated supervisor child runs. */
  assignedModel?: string;
  /** Attachments from the original message for vision/file support */
  attachments?: import("../channels/channel.interface.js").Attachment[];
  /** Original multimodal user content from the initiating message. */
  userContent?: string | MessageContent[];
  /** Parent metric ID for subtask tracking (passed from BackgroundExecutor for decomposed tasks) */
  parentMetricId?: string;
  /** Optional usage callback for recording provider/token consumption. */
  onUsage?: (usage: TaskUsageEvent) => void;
  /** Optional isolated workspace for parallel worker execution. */
  workspaceLease?: WorkspaceLease;
  /** Internal: disable supervisor routing for nested worker runs. */
  supervisorMode?: "auto" | "off";
}

export interface TaskUsageEvent {
  provider: string;
  inputTokens: number;
  outputTokens: number;
}
