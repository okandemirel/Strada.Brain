/**
 * Background Executor
 *
 * Async execution queue for running tasks in the background.
 * Uses a FIFO queue with configurable concurrency limit.
 * All work is I/O-bound (LLM API calls), so same event loop is fine.
 *
 * Optionally accepts a GoalDecomposer to decompose complex prompts
 * into goal trees. When GoalExecutor is available, executes sub-goals
 * in parallel waves with LLM criticality evaluation, failure budget UX,
 * channel-adaptive progress updates, and persistent tree state.
 */

import type { Task } from "./types.js";
import { TaskStatus } from "./types.js";
import type { TaskManager } from "./task-manager.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import type { GoalDecomposer } from "../goals/goal-decomposer.js";
import type { GoalNode } from "../goals/types.js";
import { GoalExecutor } from "../goals/goal-executor.js";
import type {
  GoalExecutorConfig,
  CriticalityEvaluator,
  OnFailureBudgetExceeded,
  FailureReport,
} from "../goals/goal-executor.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import { calculateProgress, renderProgressBar } from "../goals/goal-progress.js";
import { renderGoalTree } from "../goals/goal-renderer.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import { supportsMessageEditing } from "../channels/channel-core.interface.js";
import { supportsInteractivity } from "../channels/channel.interface.js";
import { getLogger } from "../utils/logger.js";

interface QueueEntry {
  task: Task;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export class BackgroundExecutor {
  private readonly queue: QueueEntry[] = [];
  private running = 0;
  private taskManager: TaskManager | null = null;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly concurrencyLimit: number = 3,
    private readonly decomposer?: GoalDecomposer,
    private readonly goalStorage?: GoalStorage,
    private readonly goalExecutorConfig?: GoalExecutorConfig,
    private readonly aiProvider?: IAIProvider,
    private readonly channel?: IChannelAdapter,
  ) {}

  /**
   * Set the task manager reference (avoids circular dependency).
   */
  setTaskManager(manager: TaskManager): void {
    this.taskManager = manager;
  }

  /**
   * Add a task to the execution queue.
   */
  enqueue(task: Task, signal: AbortSignal, onProgress: (message: string) => void): void {
    this.queue.push({ task, signal, onProgress });
    this.processQueue();
  }

  /**
   * Process the queue, starting tasks up to the concurrency limit.
   */
  private processQueue(): void {
    while (this.running < this.concurrencyLimit && this.queue.length > 0) {
      const entry = this.queue.shift()!;

      // Skip if already cancelled
      if (entry.signal.aborted) {
        continue;
      }

      this.running++;
      this.executeTask(entry).finally(() => {
        this.running--;
        this.processQueue();
      });
    }
  }

  private async executeTask(entry: QueueEntry): Promise<void> {
    const { task, signal, onProgress } = entry;
    const logger = getLogger();

    if (!this.taskManager) {
      logger.error("TaskManager not set on BackgroundExecutor");
      return;
    }

    // Update status to executing
    this.taskManager.updateStatus(task.id, TaskStatus.executing);
    onProgress("Task started");

    try {
      // Check if task should be decomposed into subtasks
      if (this.decomposer?.shouldDecompose(task.prompt)) {
        const result = await this.executeDecomposed(task, signal, onProgress);
        if (signal.aborted) return;
        this.taskManager.complete(task.id, result);
        return;
      }

      const result = await this.orchestrator.runBackgroundTask(task.prompt, {
        signal,
        onProgress,
        chatId: task.chatId,
        channelType: task.channelType,
      });

      if (signal.aborted) {
        // Already cancelled — don't overwrite the cancelled status
        return;
      }

      this.taskManager.complete(task.id, result);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Background task execution error", { taskId: task.id, error: errMsg });
      this.taskManager.fail(task.id, errMsg);
    }
  }

  /**
   * Decompose a task into a goal tree, execute via GoalExecutor with parallel
   * wave-based execution, LLM criticality evaluation, failure budget UX,
   * channel-adaptive progress updates, and persistent tree state.
   */
  private async executeDecomposed(
    task: Task,
    signal: AbortSignal,
    onProgress: (message: string) => void,
  ): Promise<string> {
    const logger = getLogger();

    // Decompose the task into a goal tree
    const goalTree = await this.decomposer!.decomposeProactive(task.chatId, task.prompt);
    const nodeCount = goalTree.nodes.size - 1; // exclude root
    logger.info("Task decomposed into goal tree", { taskId: task.id, nodeCount });
    onProgress(`Decomposed into ${nodeCount} sub-goals`);
    onProgress(renderGoalTree(goalTree));

    // Persist initial tree state
    if (this.goalStorage) {
      try {
        this.goalStorage.upsertTree(goalTree, "executing");
      } catch (e) {
        logger.debug("Goal tree initial persistence failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Create executor with config (or defaults)
    const config = this.goalExecutorConfig ?? {
      maxRetries: 1, maxFailures: 3, parallelExecution: true, maxParallel: 3,
    };
    const executor = new GoalExecutor(config);

    // Node executor: delegates to orchestrator.runBackgroundTask
    const nodeExecutor = async (node: GoalNode, nodeSignal: AbortSignal): Promise<string> => {
      return this.orchestrator.runBackgroundTask(node.task, {
        signal: nodeSignal,
        onProgress: (msg: string) => onProgress(`[${node.task}] ${msg}`),
        chatId: task.chatId,
        channelType: task.channelType,
      });
    };

    // Channel-adaptive progress tracking (per user decision: edit in-place where supported)
    let progressMessageId: string | null = null;

    // Status change callback: persist + send channel-adaptive progress update
    const onStatusChange = (updatedTree: import("../goals/types.js").GoalTree, _node: GoalNode): void => {
      // Persist tree state (fire-and-forget)
      if (this.goalStorage) {
        try {
          this.goalStorage.upsertTree(updatedTree, "executing");
        } catch (e) {
          logger.debug("Goal tree persistence failed", { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Build progress content
      const progress = calculateProgress(updatedTree);
      const progressContent = renderProgressBar(progress.completed, progress.total) + "\n" + renderGoalTree(updatedTree);

      // Channel-adaptive update: edit in-place where supported, append where not
      if (this.channel && progressMessageId && supportsMessageEditing(this.channel)) {
        // Edit existing progress message in-place (Telegram, Discord, Web)
        this.channel.editMessage(task.chatId, progressMessageId, progressContent).catch((e: unknown) => {
          logger.debug("Progress message edit failed, falling back to append", { error: e instanceof Error ? e.message : String(e) });
          onProgress(progressContent);
        });
      } else {
        // Append new message (CLI, or when no messageId yet)
        onProgress(progressContent);
      }
    };

    // LLM criticality evaluator (per user decision: "Agent decides at runtime whether
    // child failure propagates to parent -- LLM evaluates criticality")
    const criticalityEvaluator: CriticalityEvaluator | undefined = this.aiProvider
      ? async (failedNode: GoalNode, parentTask: string): Promise<boolean> => {
          try {
            const response = await this.aiProvider!.chat(
              "You are a task criticality evaluator. Respond with exactly YES or NO followed by one sentence of reasoning.",
              [{
                role: "user" as const,
                content: `A sub-goal failed during task execution. Evaluate if this failure is critical enough to block dependent sub-goals.

Failed sub-goal: "${failedNode.task}"
Error: "${failedNode.error ?? "unknown error"}"
Parent goal: "${parentTask}"

Is this failure critical? A critical failure means dependent sub-goals cannot proceed without this result. A non-critical failure means other sub-goals can work around it.`,
              }],
              [],
            );
            const text = response.text?.trim().toUpperCase() ?? "YES";
            return text.startsWith("YES");
          } catch (e) {
            logger.debug("Criticality evaluation LLM call failed, defaulting to critical", { error: e instanceof Error ? e.message : String(e) });
            return true; // Default to critical on LLM failure
          }
        }
      : undefined;

    // Failure budget exceeded handler (per user decisions:
    // - "detailed failure report listing all failed nodes with errors"
    // - "LLM-generated fix suggestions: both diagnosis and actionable next steps"
    // - "Force-continue option when budget exceeded"
    // - "'Always continue' option remembered for the current tree")
    const onFailureBudgetExceeded: OnFailureBudgetExceeded | undefined =
      (this.channel && supportsInteractivity(this.channel))
        ? async (report: FailureReport) => {
            // Build detailed failure report
            const failureLines: string[] = [
              `Failure budget exceeded (${report.failureCount}/${report.maxFailures} failures):`,
              "",
            ];
            for (const fn of report.failedNodes) {
              failureLines.push(`[!] ${fn.task}`);
              failureLines.push(`    Error: ${fn.error}`);
              if (fn.retryCount > 0) failureLines.push(`    Retries: ${fn.retryCount}`);
              failureLines.push("");
            }

            // LLM-generated fix suggestions (per user decision)
            let diagnosis = "";
            if (this.aiProvider) {
              try {
                const diagResponse = await this.aiProvider.chat(
                  "You are a task failure diagnostician. Provide a brief diagnosis and actionable next steps. Be concise (2-3 sentences).",
                  [{
                    role: "user" as const,
                    content: `The following sub-goals failed during execution of "${goalTree.taskDescription}":

${report.failedNodes.map(fn => `- "${fn.task}": ${fn.error}`).join("\n")}

Provide a brief diagnosis (what likely went wrong) and actionable next steps.`,
                  }],
                  [],
                );
                diagnosis = diagResponse.text?.trim() ?? "";
              } catch {
                // LLM diagnosis is best-effort
              }
            }

            if (diagnosis) {
              failureLines.push("Diagnosis:", diagnosis, "");
            }

            const details = failureLines.join("\n");

            // Present force-continue / abort options to user (per user decision)
            const interactiveChannel = this.channel as unknown as import("../channels/channel-core.interface.js").IChannelInteractive;
            const choice = await interactiveChannel.requestConfirmation({
              chatId: task.chatId,
              question: `Failure budget exceeded (${report.failureCount}/${report.maxFailures}). How would you like to proceed?`,
              options: ["Force continue", "Always continue", "Abort"],
              details,
            });

            const normalized = choice.toLowerCase().trim();
            if (normalized === "always continue") {
              return { continue: true, alwaysContinue: true };
            } else if (normalized === "force continue") {
              return { continue: true, alwaysContinue: false };
            } else {
              return { continue: false, alwaysContinue: false };
            }
          }
        : undefined;

    // Send initial progress message and capture messageId for in-place editing
    if (this.channel && supportsMessageEditing(this.channel)) {
      try {
        // Send an initial progress message to get a messageId for future edits
        // Use startStreamingMessage pattern if available, otherwise sendMarkdown
        const initialProgress = renderProgressBar(0, nodeCount) + "\n" + renderGoalTree(goalTree);
        await this.channel.sendMarkdown(task.chatId, initialProgress);
        // Note: sendMarkdown doesn't return messageId in current interface.
        // For channels that support editing, the onProgress callback will
        // be used initially, and progressMessageId can be captured from
        // a wrapper that the channel provides. For now, fall back to append mode.
        // TODO: Once sendMarkdown returns messageId, wire it here.
      } catch {
        // Non-critical: fall back to onProgress callback
      }
    }

    // Execute the tree with all callbacks
    const result = await executor.executeTree(goalTree, nodeExecutor, signal, {
      onStatusChange,
      criticalityEvaluator,
      onFailureBudgetExceeded,
    });

    // Persist final tree state
    if (this.goalStorage) {
      try {
        const finalStatus = result.aborted ? "failed" : result.failureCount > 0 ? "failed" : "completed";
        this.goalStorage.upsertTree(result.tree, finalStatus);
      } catch (e) {
        logger.debug("Goal tree final persistence failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Combine results
    if (result.results.length === 0) return "";
    return result.results
      .filter(r => r.result)
      .map(r => `## Sub-goal: ${r.task}\n\n${r.result}`)
      .join("\n\n---\n\n");
  }
}
