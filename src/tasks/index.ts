/**
 * Task System - Barrel Exports
 *
 * Autonomous assistant task management:
 * - Background task execution with concurrency control
 * - Deterministic command detection (bilingual TR/EN)
 * - SQLite persistence for task state
 * - Proactive progress reporting to channels
 */

export { TaskStorage } from "./task-storage.js";
export { TaskManager } from "./task-manager.js";
export { BackgroundExecutor } from "./background-executor.js";
export { MessageRouter } from "./message-router.js";
export { CommandHandler } from "./command-handler.js";
export { ProgressReporter } from "./progress-reporter.js";
export { TaskDecomposer } from "./task-decomposer.js";
export { detectCommand } from "./command-detector.js";
export {
  type Task,
  type TaskId,
  type ProgressEntry,
  type TaskCommand,
  type ParsedCommand,
  type TaskRequest,
  type ClassificationResult,
  type BackgroundTaskOptions,
  TaskStatus,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  generateTaskId,
} from "./types.js";
