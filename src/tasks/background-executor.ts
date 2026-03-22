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
 *
 * Supports pre-decomposed goal trees (from inline goal detection) to
 * skip redundant LLM decomposition. Emits goal lifecycle events to
 * DaemonEventBus for WebSocket dashboard broadcasting.
 */

import type { Task, TaskProgressUpdate } from "./types.js";
import { getTaskConversationKey, TaskStatus } from "./types.js";
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
  ExecutionResult,
} from "../goals/goal-executor.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import { calculateProgress, renderProgressBar } from "../goals/goal-progress.js";
import { renderGoalTree } from "../goals/goal-renderer.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import { supportsInteractivity } from "../channels/channel.interface.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { DaemonEventMap } from "../daemon/daemon-events.js";
import type { GoalConfig } from "../config/config.js";
import { estimateCost } from "../security/rate-limiter.js";
import type { BudgetTracker } from "../daemon/budget/budget-tracker.js";
import { getLogger } from "../utils/logger.js";
import { WorkspaceLeaseManager } from "../agents/multi/workspace-lease-manager.js";
import type { WorkerRunResult } from "../agents/supervisor/supervisor-types.js";

const LLM_TIMEOUT_MS = 10_000;

/** Race a promise against a timeout; resolves to fallback on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Truncate error messages to avoid leaking internal details. */
function sanitizeError(error: string, maxLen = 200): string {
  // Strip absolute file paths
  const cleaned = error.replace(/\/[^\s:]+/g, "<path>");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "…" : cleaned;
}

interface QueueEntry {
  task: Task;
  signal: AbortSignal;
  onProgress: (message: TaskProgressUpdate) => void;
}

interface DecomposedExecutionResult {
  output: string;
  success: boolean;
  error?: string;
  blocked?: boolean;
  aborted: boolean;
}

interface GoalResultSynthesizer {
  synthesizeGoalExecutionResult?: (params: {
    prompt: string;
    goalTree: GoalTree;
    executionResult: ExecutionResult;
    chatId: string;
    conversationId?: string;
    userId?: string;
    channelType?: string;
    onUsage?: (usage: { provider: string; inputTokens: number; outputTokens: number }) => void;
    childWorkerResults?: readonly WorkerRunResult[];
  }) => Promise<string>;
}

export interface BackgroundExecutorOptions {
  orchestrator: Orchestrator;
  concurrencyLimit?: number;
  decomposer?: GoalDecomposer;
  goalStorage?: GoalStorage;
  goalExecutorConfig?: GoalExecutorConfig;
  aiProvider?: IAIProvider;
  channel?: IChannelAdapter;
  daemonEventBus?: IEventEmitter<DaemonEventMap>;
  goalConfig?: GoalConfig;
  learningEventBus?: IEventEmitter<LearningEventMap>;
  workspaceLeaseManager?: WorkspaceLeaseManager;
}

export class BackgroundExecutor {
  private readonly queue: QueueEntry[] = [];
  private readonly activeConversations = new Set<string>();
  private running = 0;
  private taskManager: TaskManager | null = null;
  private readonly orchestrator: Orchestrator;
  private readonly concurrencyLimit: number;
  private readonly decomposer?: GoalDecomposer;
  private readonly goalStorage?: GoalStorage;
  private readonly goalExecutorConfig?: GoalExecutorConfig;
  private readonly aiProvider?: IAIProvider;
  private readonly channel?: IChannelAdapter;
  private readonly daemonEventBus?: IEventEmitter<DaemonEventMap>;
  private readonly goalConfig?: GoalConfig;
  private readonly learningEventBus?: IEventEmitter<LearningEventMap>;
  private readonly workspaceLeaseManager?: WorkspaceLeaseManager;
  private daemonBudgetTracker?: BudgetTracker;

  constructor(opts: BackgroundExecutorOptions) {
    this.orchestrator = opts.orchestrator;
    this.concurrencyLimit = opts.concurrencyLimit ?? 3;
    this.decomposer = opts.decomposer;
    this.goalStorage = opts.goalStorage;
    this.goalExecutorConfig = opts.goalExecutorConfig;
    this.aiProvider = opts.aiProvider;
    this.channel = opts.channel;
    this.daemonEventBus = opts.daemonEventBus;
    this.goalConfig = opts.goalConfig;
    this.learningEventBus = opts.learningEventBus;
    this.workspaceLeaseManager = opts.workspaceLeaseManager;
  }

  /**
   * Set the task manager reference (avoids circular dependency).
   */
  setTaskManager(manager: TaskManager): void {
    this.taskManager = manager;
  }

  setDaemonBudgetTracker(tracker: BudgetTracker): void {
    this.daemonBudgetTracker = tracker;
  }

  /**
   * Returns true if any tasks are currently running or queued.
   */
  hasRunningTasks(): boolean {
    return this.running > 0 || this.queue.length > 0;
  }

  private static readonly MAX_QUEUE_SIZE = 100;

  /**
   * Add a task to the execution queue.
   */
  enqueue(task: Task, signal: AbortSignal, onProgress: (message: TaskProgressUpdate) => void): void {
    if (this.queue.length >= BackgroundExecutor.MAX_QUEUE_SIZE) {
      // Mark the rejected task as failed so it doesn't become orphaned
      const logger = getLogger();
      const errMsg = `Task queue full (max ${BackgroundExecutor.MAX_QUEUE_SIZE}). Try again later.`;
      logger.error("Task queue overflow", { taskId: task.id, queueSize: this.queue.length });
      if (this.taskManager) {
        try { this.taskManager.fail(task.id, errMsg); } catch { /* best-effort cleanup */ }
      }
      throw new Error(errMsg);
    }
    this.queue.push({ task, signal, onProgress });
    try {
      this.processQueue();
    } catch (err) {
      const logger = getLogger();
      logger.error("processQueue failed during enqueue", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Process the queue, starting tasks up to the concurrency limit.
   */
  private processQueue(): void {
    const logger = getLogger();
    while (this.running < this.concurrencyLimit) {
      const nextIndex = this.findNextRunnableIndex();
      if (nextIndex < 0) {
        return;
      }
      const entry = this.queue.splice(nextIndex, 1)[0]!;
      const conversationKey = getTaskConversationKey(
        entry.task.chatId,
        entry.task.channelType,
        entry.task.conversationId,
      );

      // Skip if already cancelled
      if (entry.signal.aborted) {
        continue;
      }

      this.activeConversations.add(conversationKey);
      this.running++;
      this.executeTask(entry)
        .catch((err) => {
          // Catch any unhandled rejection that escapes executeTask's own try/catch
          logger.error("Unhandled error in executeTask", {
            taskId: entry.task.id,
            error: err instanceof Error ? err.message : String(err),
          });
          // Best-effort: mark task as failed so it doesn't stay orphaned
          if (this.taskManager) {
            try {
              this.taskManager.fail(
                entry.task.id,
                err instanceof Error ? err.message : String(err),
              );
            } catch { /* task may already be in terminal state */ }
          }
        })
        .finally(() => {
          this.activeConversations.delete(conversationKey);
          this.running--;
          try {
            this.processQueue();
          } catch (err) {
            logger.error("processQueue failed in finally callback", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
    }
  }

  private findNextRunnableIndex(): number {
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index]!;
      if (entry.signal.aborted) {
        return index;
      }
      const conversationKey = getTaskConversationKey(
        entry.task.chatId,
        entry.task.channelType,
        entry.task.conversationId,
      );
      if (!this.activeConversations.has(conversationKey)) {
        return index;
      }
    }
    return -1;
  }

  private async executeWorkerRun(
    orchestrator: Orchestrator,
    params: {
      prompt: string;
      signal: AbortSignal;
      onProgress: (message: TaskProgressUpdate) => void;
      chatId: string;
      taskRunId: string;
      channelType: string;
      conversationId?: string;
      userId?: string;
      attachments?: import("../channels/channel.interface.js").Attachment[];
      onUsage?: (usage: { provider: string; inputTokens: number; outputTokens: number }) => void;
      workspaceLease?: Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>>;
    },
  ): Promise<{ output: string; workerResult?: WorkerRunResult }> {
    if (typeof (orchestrator as Orchestrator & { runWorkerTask?: unknown }).runWorkerTask === "function") {
      const workerResult = await (
        orchestrator as Orchestrator & {
          runWorkerTask: (request: {
            prompt: string;
            mode: "background";
            signal: AbortSignal;
            onProgress: (message: TaskProgressUpdate) => void;
            chatId: string;
            taskRunId: string;
            channelType: string;
            conversationId?: string;
            userId?: string;
            attachments?: import("../channels/channel.interface.js").Attachment[];
            onUsage?: (usage: { provider: string; inputTokens: number; outputTokens: number }) => void;
            workspaceLease?: Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>>;
          }) => Promise<WorkerRunResult>;
        }
      ).runWorkerTask({
        prompt: params.prompt,
        mode: "background",
        signal: params.signal,
        onProgress: params.onProgress,
        chatId: params.chatId,
        taskRunId: params.taskRunId,
        channelType: params.channelType,
        conversationId: params.conversationId,
        userId: params.userId,
        attachments: params.attachments,
        onUsage: params.onUsage,
        workspaceLease: params.workspaceLease,
      });
      return {
        output: workerResult.visibleResponse,
        workerResult,
      };
    }

    return {
      output: await orchestrator.runBackgroundTask(params.prompt, {
        signal: params.signal,
        onProgress: params.onProgress,
        chatId: params.chatId,
        taskRunId: params.taskRunId,
        channelType: params.channelType,
        conversationId: params.conversationId,
        userId: params.userId,
        attachments: params.attachments,
        onUsage: params.onUsage,
        workspaceLease: params.workspaceLease,
      }),
    };
  }

  private async executeTask(entry: QueueEntry): Promise<void> {
    const { task, signal, onProgress } = entry;
    const logger = getLogger();
    const taskOrchestrator = task.orchestrator ?? this.orchestrator;

    if (!this.taskManager) {
      logger.error("TaskManager not set on BackgroundExecutor");
      return;
    }

    if (signal.aborted) {
      return;
    }

    // Update status to executing
    this.taskManager.updateStatus(task.id, TaskStatus.executing);
    onProgress("Task started");

    let taskLease: Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>> | undefined;
    try {
      // Check for pre-decomposed goal tree (from inline goal detection)
      if (task.goalTree) {
        const result = await this.executeDecomposed(task, signal, onProgress, task.goalTree);
        if (signal.aborted) return;
        if (!result.success) {
          if (result.blocked) {
            this.taskManager.block(task.id, result.error ?? "Goal execution blocked");
            return;
          }
          this.taskManager.fail(task.id, result.error ?? "Goal execution failed");
          return;
        }
        this.taskManager.complete(task.id, result.output);
        return;
      }

      // Check if task should be decomposed into subtasks
      if (this.decomposer?.shouldDecompose(task.prompt)) {
        const result = await this.executeDecomposed(task, signal, onProgress);
        if (signal.aborted) return;
        if (!result.success) {
          if (result.blocked) {
            this.taskManager.block(task.id, result.error ?? "Goal execution blocked");
            return;
          }
          this.taskManager.fail(task.id, result.error ?? "Goal execution failed");
          return;
        }
        this.taskManager.complete(task.id, result.output);
        return;
      }

      taskLease = this.workspaceLeaseManager
        ? await this.workspaceLeaseManager.acquireLease({
          label: `task-${task.id}`,
          workerId: task.id,
        })
        : undefined;
      const result = await this.executeWorkerRun(taskOrchestrator, {
        prompt: task.prompt,
        signal,
        onProgress,
        chatId: task.chatId,
        taskRunId: task.id,
        channelType: task.channelType,
        conversationId: task.conversationId,
        userId: task.userId,
        attachments: task.attachments,
        onUsage: this.buildUsageRecorder(task),
        workspaceLease: taskLease,
      });

      if (signal.aborted) {
        // Already cancelled -- don't overwrite the cancelled status
        return;
      }

      if (result.workerResult && result.workerResult.status === "failed") {
        this.taskManager.fail(
          task.id,
          result.workerResult.reason ?? (result.output || "Task failed"),
        );
        return;
      }

      if (result.workerResult && result.workerResult.status === "blocked") {
        this.taskManager.block(
          task.id,
          result.workerResult.reason ?? (result.output || "Task blocked"),
        );
        return;
      }

      this.taskManager.complete(task.id, result.output);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Background task execution error", { taskId: task.id, error: errMsg });
      this.taskManager.fail(task.id, errMsg);

      // Emit goal:failed if we have a goal tree context (INT-02 catch path)
      if (this.daemonEventBus && task.goalTree) {
        this.daemonEventBus.emit("goal:failed", {
          rootId: task.goalTree.rootId,
          error: errMsg,
          failureCount: 0,
          timestamp: Date.now(),
        });
      }
    } finally {
      await taskLease?.release().catch(() => {});
    }
  }

  /**
   * Decompose a task into a goal tree, execute via GoalExecutor with parallel
   * wave-based execution, LLM criticality evaluation, failure budget UX,
   * channel-adaptive progress updates, and persistent tree state.
   *
   * When preBuiltTree is provided (from inline goal detection), uses it directly
   * instead of calling decomposer.decomposeProactive -- zero extra LLM cost.
   */
  private async executeDecomposed(
    task: Task,
    signal: AbortSignal,
    onProgress: (message: TaskProgressUpdate) => void,
    preBuiltTree?: GoalTree,
  ): Promise<DecomposedExecutionResult> {
    const logger = getLogger();
    const startTime = Date.now();
    const taskOrchestrator = task.orchestrator ?? this.orchestrator;

    // Use pre-built tree if provided, otherwise decompose
    const goalTree = preBuiltTree ?? await this.decomposer!.decomposeProactive(task.chatId, task.prompt);
    const nodeCount = goalTree.nodes.size - 1; // exclude root
    logger.info("Task decomposed into goal tree", { taskId: task.id, nodeCount, preBuilt: !!preBuiltTree });
    onProgress(`Decomposed into ${nodeCount} sub-goals`);
    onProgress(renderGoalTree(goalTree));

    // Emit goal:started event
    if (this.daemonEventBus) {
      this.daemonEventBus.emit("goal:started", {
        rootId: goalTree.rootId,
        taskDescription: goalTree.taskDescription,
        nodeCount,
        timestamp: Date.now(),
      });
    }

    // Persist initial tree state
    if (this.goalStorage) {
      try {
        this.goalStorage.upsertTree(goalTree, "executing");
      } catch (e) {
        logger.debug("Goal tree initial persistence failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Create executor with config (or defaults)
    const config: GoalExecutorConfig = {
      maxRetries: 1,
      maxFailures: 3,
      parallelExecution: true,
      maxParallel: 3,
      ...this.goalExecutorConfig,
      maxRedecompositions: this.goalExecutorConfig?.maxRedecompositions ?? this.goalConfig?.maxRedecompositions ?? 2,
    };
    const executor = new GoalExecutor(config);
    const childWorkerResults = new Map<string, WorkerRunResult>();
    let blockedWorkerReason: string | undefined;

    // Node executor: delegates to orchestrator.runBackgroundTask
    const nodeExecutor = async (node: GoalNode, nodeSignal: AbortSignal): Promise<string> => {
      const workspaceLease = this.workspaceLeaseManager
        ? await this.workspaceLeaseManager.acquireLease({
          label: `goal-node-${node.id}`,
          workerId: `${task.id}:${node.id}`,
        })
        : undefined;
      try {
        const result = await this.executeWorkerRun(taskOrchestrator, {
          prompt: node.task,
          signal: nodeSignal,
          onProgress: (msg: TaskProgressUpdate) =>
            onProgress(typeof msg === "string" ? `[${node.task}] ${msg}` : msg),
          chatId: task.chatId,
          taskRunId: `${task.id}:${node.id}`,
          channelType: task.channelType,
          conversationId: task.conversationId,
          userId: task.userId,
          onUsage: this.buildUsageRecorder(task),
          workspaceLease,
        });
        if (result.workerResult) {
          childWorkerResults.set(node.id, result.workerResult);
          if (result.workerResult.status !== "completed") {
            if (result.workerResult.status === "blocked" && !blockedWorkerReason) {
              blockedWorkerReason =
                result.workerResult.reason ?? (result.output || "Worker blocked");
            }
            throw new Error(
              result.workerResult.reason ?? (result.output || "Worker did not complete"),
            );
          }
        }
        return result.output;
      } finally {
        await workspaceLease?.release().catch(() => {});
      }
    };

    // Status change callback: persist node status + send throttled progress update
    let lastProgressUpdate = 0;
    const PROGRESS_THROTTLE_MS = 500;

    const onStatusChange = (updatedTree: GoalTree, updatedNode: GoalNode): void => {
      // Persist individual node status change (not full tree rewrite)
      if (this.goalStorage) {
        try {
          this.goalStorage.updateNodeStatus(
            updatedNode.id, updatedNode.status,
            updatedNode.result, updatedNode.error,
            updatedNode.retryCount, updatedNode.redecompositionCount,
          );
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

    // Wave completion callback for daemon events (progress rendering handled by onStatusChange)
    const onWaveComplete = (_updatedTree: GoalTree, waveIndex: number): void => {
      if (this.daemonEventBus) {
        const progress = calculateProgress(_updatedTree);
        this.daemonEventBus.emit("goal:wave_complete", {
          rootId: goalTree.rootId,
          waveIndex,
          completedCount: progress.completed,
          totalCount: progress.total,
          timestamp: Date.now(),
        });
      }
    };

    // LLM criticality evaluator (per user decision: "Agent decides at runtime whether
    // child failure propagates to parent -- LLM evaluates criticality")
    const criticalityEvaluator: CriticalityEvaluator | undefined = this.aiProvider
      ? async (failedNode: GoalNode, parentTask: string): Promise<boolean> => {
          try {
            const response = await withTimeout(
              this.aiProvider!.chat(
                "You are a task criticality evaluator. Respond with exactly YES or NO followed by one sentence of reasoning.",
                [{
                  role: "user" as const,
                  content: `A sub-goal failed during task execution. Evaluate if this failure is critical enough to block dependent sub-goals.

<failed_subgoal>${failedNode.task}</failed_subgoal>
<error>${sanitizeError(failedNode.error ?? "unknown error")}</error>
<parent_goal>${parentTask}</parent_goal>

Is this failure critical? A critical failure means dependent sub-goals cannot proceed without this result. A non-critical failure means other sub-goals can work around it. Respond with exactly YES or NO followed by one sentence of reasoning.`,
                }],
                [],
              ),
              LLM_TIMEOUT_MS,
              { text: "YES" } as Awaited<ReturnType<IAIProvider["chat"]>>,
            );
            const text = response.text?.trim().toUpperCase() ?? "YES";
            return text.startsWith("YES");
          } catch (e) {
            logger.debug("Criticality evaluation LLM call failed, defaulting to critical", { error: e instanceof Error ? e.message : String(e) });
            return true; // Default to critical on LLM failure
          }
        }
      : undefined;

    // LLM-driven re-decomposition on node failure (Plan 16-03)
    const onNodeFailed = this.decomposer && this.aiProvider
      ? async (currentTree: GoalTree, failedNode: GoalNode): Promise<GoalTree | null> => {
          const maxRedecompositions = this.goalConfig?.maxRedecompositions ?? 2;
          const currentCount = failedNode.redecompositionCount ?? 0;

          // Enforce per-node redecomposition limit
          if (currentCount >= maxRedecompositions) {
            logger.debug("Re-decomposition limit reached for node", {
              nodeId: failedNode.id,
              count: currentCount,
              max: maxRedecompositions,
            });
            return null;
          }

          // Ask LLM: RETRY or DECOMPOSE?
          try {
            const advisorResponse = await withTimeout(
              this.aiProvider!.chat(
                "You are a goal execution recovery advisor. A sub-goal has failed. Decide the best recovery strategy. Respond with exactly RETRY or DECOMPOSE followed by a brief reason.",
                [{
                  role: "user" as const,
                  content: `Original goal: ${goalTree.taskDescription}\n\nFailed sub-goal: ${failedNode.task}\nError: ${sanitizeError(failedNode.error ?? "unknown")}\nRedecomposition count: ${currentCount}/${maxRedecompositions}\n\nShould we RETRY the same approach or DECOMPOSE into smaller steps?`,
                }],
                [],
              ),
              LLM_TIMEOUT_MS,
              { text: "RETRY" } as Awaited<ReturnType<IAIProvider["chat"]>>,
            );

            const decision = advisorResponse.text?.trim().toUpperCase() ?? "RETRY";

            if (decision.startsWith("DECOMPOSE") && this.decomposer) {
              // decomposeReactive builds its own completed-nodes context internally
              const reflectionContext = `Error: ${failedNode.error ?? "unknown"}\nFailed task: ${failedNode.task}`;

              const newTree = await this.decomposer.decomposeReactive(
                currentTree,
                failedNode.id,
                reflectionContext,
              );

              if (newTree) {
                // Increment redecompositionCount on the failed node in the new tree
                const updatedFailedNode = newTree.nodes.get(failedNode.id);
                if (updatedFailedNode) {
                  const mutableNodes = new Map(newTree.nodes);
                  mutableNodes.set(failedNode.id, {
                    ...updatedFailedNode,
                    redecompositionCount: currentCount + 1,
                  });
                  const updatedTree = { ...newTree, nodes: mutableNodes };

                  // Emit goal:redecomposed event
                  if (this.learningEventBus) {
                    const newNodeCount = newTree.nodes.size - currentTree.nodes.size;
                    this.learningEventBus.emit("goal:redecomposed", {
                      rootId: goalTree.rootId,
                      nodeId: failedNode.id,
                      task: failedNode.task,
                      newNodeCount,
                      timestamp: Date.now(),
                    });
                  }

                  return updatedTree;
                }
                return newTree;
              }
            }

            // RETRY decision or DECOMPOSE failed
            if (this.learningEventBus) {
              this.learningEventBus.emit("goal:retry", {
                rootId: goalTree.rootId,
                nodeId: failedNode.id,
                task: failedNode.task,
                attempt: (failedNode.retryCount ?? 0) + 1,
                timestamp: Date.now(),
              });
            }
            return null;
          } catch (e) {
            logger.debug("onNodeFailed recovery failed", {
              error: e instanceof Error ? e.message : String(e),
            });
            return null;
          }
        }
      : undefined;

    // Failure budget exceeded handler: detailed report, LLM diagnosis, 4-option escalation UX
    const interactiveChannel = this.channel && supportsInteractivity(this.channel)
      ? this.channel
      : undefined;

    const onFailureBudgetExceeded: OnFailureBudgetExceeded = async (report: FailureReport) => {
      // Build detailed failure report
      const failureLines: string[] = [
        `Failure budget exceeded (${report.failureCount}/${report.maxFailures} failures):`,
        "",
      ];
      for (const fn of report.failedNodes) {
        failureLines.push(`[!] ${fn.task}`);
        failureLines.push(`    Error: ${sanitizeError(fn.error)}`);
        if (fn.retryCount > 0) failureLines.push(`    Retries: ${fn.retryCount}`);
        failureLines.push("");
      }

      // LLM-generated diagnosis (best-effort, lightweight model)
      let diagnosis = "";
      if (this.aiProvider) {
        try {
          const diagResponse = await withTimeout(
            this.aiProvider.chat(
              "You are a task failure diagnostician. Provide a brief diagnosis and actionable fix suggestions. Be concise (2-3 sentences).",
              [{
                role: "user" as const,
                content: `Task: ${goalTree.taskDescription}\n\nFailed sub-goals:\n${report.failedNodes.map(fn =>
                  `- ${fn.task}: ${sanitizeError(fn.error)} (${fn.retryCount} retries)`
                ).join("\n")}`,
              }],
              [],
            ),
            LLM_TIMEOUT_MS,
            { text: "" } as Awaited<ReturnType<IAIProvider["chat"]>>,
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
      const timeoutMinutes = this.goalConfig?.escalationTimeoutMinutes ?? 10;

      if (interactiveChannel) {
        const timeoutMs = timeoutMinutes * 60_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const choice = await Promise.race([
          interactiveChannel.requestConfirmation({
            chatId: task.chatId,
            question: `Failure budget exceeded (${report.failureCount}/${report.maxFailures}). How to proceed?`,
            options: ["Continue", "Always Continue", "Abort"],
            details,
          }),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
          }),
        ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });

        if (choice === "__timeout__") {
          await interactiveChannel.sendText(task.chatId,
            `Auto-aborting after ${timeoutMinutes}min timeout.${diagnosis ? `\n${diagnosis}` : ""}`);
          return { continue: false, alwaysContinue: false };
        }

        const normalized = choice.toLowerCase().trim();
        if (normalized === "always continue") return { continue: true, alwaysContinue: true };
        if (normalized === "continue") return { continue: true, alwaysContinue: false };
        return { continue: false, alwaysContinue: false }; // Abort or unrecognized
      } else {
        // Non-interactive: send report via progress and auto-abort
        onProgress(`Failure budget exceeded. ${diagnosis || "Aborting."}`);
        return { continue: false, alwaysContinue: false };
      }
    };

    // Execute the tree with all callbacks
    const result = await executor.executeTree(goalTree, nodeExecutor, signal, {
      onStatusChange,
      criticalityEvaluator,
      onFailureBudgetExceeded,
      onWaveComplete,
      onNodeFailed,
    });

    // Persist final tree state
    const allChildWorkerResults = [...childWorkerResults.values()];
    const blockedWorker = allChildWorkerResults.find((workerResult) => workerResult.status === "blocked");
    const childWorkerIssues = allChildWorkerResults.some(
      (workerResult) =>
        workerResult.status !== "completed" ||
        workerResult.reviewFindings.some((finding) => finding.severity === "error") ||
        workerResult.verificationResults.some((entry) => entry.status === "issues"),
    );
    const hasFailed = result.aborted || result.failureCount > 0 || childWorkerIssues;
    if (this.goalStorage) {
      try {
        this.goalStorage.upsertTree(result.tree, hasFailed ? "failed" : "completed");
      } catch (e) {
        logger.debug("Goal tree final persistence failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Emit goal event -- goal:failed for failures/aborts, goal:complete for successes only (INT-02)
    if (this.daemonEventBus) {
      if (hasFailed) {
        this.daemonEventBus.emit("goal:failed", {
          rootId: goalTree.rootId,
          error: result.aborted
            ? "Goal aborted"
            : `${result.failureCount} sub-goal(s) failed`,
          failureCount: result.failureCount,
          timestamp: Date.now(),
        });
      } else {
        const successCount = result.results.filter(r => r.result && !r.error).length;
        this.daemonEventBus.emit("goal:complete", {
          rootId: goalTree.rootId,
          taskDescription: goalTree.taskDescription,
          durationMs: Date.now() - startTime,
          successCount,
          failureCount: 0,
          timestamp: Date.now(),
        });
      }
    }

    // Combine results
    const rawOutput = result.results
      .filter(r => r.result)
      .map(r => `## Sub-goal: ${r.task}\n\n${r.result}`)
      .join("\n\n---\n\n");

    let output = rawOutput;
    const synthesizer = taskOrchestrator as GoalResultSynthesizer;
    if (
      !hasFailed &&
      rawOutput &&
      typeof synthesizer.synthesizeGoalExecutionResult === "function"
    ) {
      try {
        const synthesized = await synthesizer.synthesizeGoalExecutionResult({
          prompt: task.prompt,
          goalTree: result.tree,
          executionResult: result,
          chatId: task.chatId,
          conversationId: task.conversationId,
          userId: task.userId,
          channelType: task.channelType,
          onUsage: this.buildUsageRecorder(task),
          childWorkerResults: allChildWorkerResults,
        });
        if (synthesized.trim()) {
          output = synthesized;
        }
      } catch (error) {
        logger.debug("Goal result synthesis failed, falling back to raw sub-goal output", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      output,
      success: !hasFailed && !blockedWorker,
      error:
        blockedWorkerReason
        ?? blockedWorker?.reason
        ?? (
          hasFailed
            ? (
              result.aborted
                ? "Goal aborted"
                : childWorkerIssues && result.failureCount === 0
                  ? "Child worker verification/review did not finish cleanly"
                  : `${result.failureCount} sub-goal(s) failed`
            )
            : undefined
        ),
      blocked: Boolean(blockedWorker),
      aborted: result.aborted,
    };
  }

  private buildUsageRecorder(task: Task): ((usage: { provider: string; inputTokens: number; outputTokens: number }) => void) | undefined {
    if (task.origin !== "daemon" || !this.daemonBudgetTracker) {
      return undefined;
    }

    return (usage) => {
      const costUsd = estimateCost(usage.inputTokens, usage.outputTokens, usage.provider);
      if (costUsd <= 0) {
        return;
      }
      this.daemonBudgetTracker?.recordCost(costUsd, {
        model: usage.provider,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        triggerName: task.triggerName,
      });
    };
  }
}
