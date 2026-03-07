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
import type { GoalNode, GoalTree } from "../goals/types.js";
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
import type { IChannelInteractive } from "../channels/channel-core.interface.js";
import { supportsInteractivity } from "../channels/channel.interface.js";
import { getLogger } from "../utils/logger.js";

interface QueueEntry {
  task: Task;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export interface BackgroundExecutorOptions {
  orchestrator: Orchestrator;
  concurrencyLimit?: number;
  decomposer?: GoalDecomposer;
  goalStorage?: GoalStorage;
  goalExecutorConfig?: GoalExecutorConfig;
  aiProvider?: IAIProvider;
  channel?: IChannelAdapter;
}

export class BackgroundExecutor {
  private readonly queue: QueueEntry[] = [];
  private running = 0;
  private taskManager: TaskManager | null = null;
  private readonly orchestrator: Orchestrator;
  private readonly concurrencyLimit: number;
  private readonly decomposer?: GoalDecomposer;
  private readonly goalStorage?: GoalStorage;
  private readonly goalExecutorConfig?: GoalExecutorConfig;
  private readonly aiProvider?: IAIProvider;
  private readonly channel?: IChannelAdapter;

  constructor(opts: BackgroundExecutorOptions) {
    this.orchestrator = opts.orchestrator;
    this.concurrencyLimit = opts.concurrencyLimit ?? 3;
    this.decomposer = opts.decomposer;
    this.goalStorage = opts.goalStorage;
    this.goalExecutorConfig = opts.goalExecutorConfig;
    this.aiProvider = opts.aiProvider;
    this.channel = opts.channel;
  }

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

    // Status change callback: persist node status + send throttled progress update
    let lastProgressUpdate = 0;
    const PROGRESS_THROTTLE_MS = 500;

    const onStatusChange = (updatedTree: GoalTree, updatedNode: GoalNode): void => {
      // Persist individual node status change (not full tree rewrite)
      if (this.goalStorage) {
        try {
          this.goalStorage.updateNodeStatus(updatedNode.id, updatedNode.status, updatedNode.error);
        } catch (e) {
          logger.debug("Goal node persistence failed", { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Throttled progress rendering to avoid message flood
      const now = Date.now();
      const isTerminal = updatedNode.status === "completed" || updatedNode.status === "failed" || updatedNode.status === "skipped";
      if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS || isTerminal) {
        lastProgressUpdate = now;
        const progress = calculateProgress(updatedTree);
        const progressContent = renderProgressBar(progress.completed, progress.total) + "\n" + renderGoalTree(updatedTree);
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
            const interactiveChannel = this.channel as unknown as IChannelInteractive;
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
