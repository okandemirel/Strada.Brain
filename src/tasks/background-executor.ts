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

import type {
  Task,
  TaskProgressSignal,
  TaskProgressUpdate,
} from "./types.js";
import { getTaskConversationKey, TaskStatus } from "./types.js";
import type { TaskManager } from "./task-manager.js";
import type { Orchestrator, SupervisorAdmissionDecision } from "../agents/orchestrator.js";
import { resolveConversationScope } from "../agents/orchestrator-text-utils.js";
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
import { calculateProgress } from "../goals/goal-progress.js";
import { buildGoalNarrativeFeedback } from "../goals/goal-feedback.js";
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
import type { WorkerRunRequest, WorkerRunResult } from "../agents/supervisor/supervisor-types.js";
import { normalizeSupervisorProgressMarkdown } from "../supervisor/supervisor-feedback.js";
import type { MonitorLifecycle } from "../dashboard/monitor-lifecycle.js";
import type { WorkspaceBus } from "../dashboard/workspace-bus.js";
import {
  goalTreeToDagPayload,
  type WorkspaceEventMap,
} from "../dashboard/workspace-events.js";

const LLM_TIMEOUT_MS = 10_000;
const GOAL_CANVAS_SUMMARY_WIDTH = 320;
const GOAL_CANVAS_SUMMARY_HEIGHT = 180;
const GOAL_CANVAS_CARD_WIDTH = 240;
const GOAL_CANVAS_CARD_HEIGHT = 120;
const GOAL_CANVAS_COLUMN_GAP = 320;
const GOAL_CANVAS_ROW_GAP = 180;
const GOAL_CANVAS_SUMMARY_X = 0;
const GOAL_CANVAS_SUMMARY_Y = 0;

/** Race a promise against a timeout; resolves to fallback on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Build a human-readable label for a substep based on tool name and language. */
export function buildSubstepLabel(toolName: string, lang: string = "en"): string {
  const labels: Record<string, Record<string, string>> = {
    file_read: { en: "Analyzing file", tr: "Dosya analiz ediliyor" },
    file_write: { en: "Applying changes", tr: "Duzenleme uygulaniyor" },
    bash: { en: "Running command", tr: "Komut calistiriliyor" },
    grep_search: { en: "Searching codebase", tr: "Arama yapiliyor" },
  };
  return labels[toolName]?.[lang] ?? labels[toolName]?.en ?? "Processing";
}

/** Truncate error messages to avoid leaking internal details. */
function sanitizeError(error: string, maxLen = 200): string {
  // Strip absolute file paths
  const cleaned = error.replace(/\/[^\s:]+/g, "<path>");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "…" : cleaned;
}

function truncateCanvasText(value: string, maxLen = 72): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}

function goalCanvasSummaryShapeId(rootId: string): string {
  return `goal-summary-${rootId}`;
}

function goalCanvasNodeShapeId(nodeId: string): string {
  return `goal-task-${nodeId}`;
}

function mapGoalNodeCanvasStatus(node: Pick<GoalNode, "status" | "reviewStatus">): string {
  if (node.reviewStatus === "spec_review" || node.reviewStatus === "quality_review") {
    return "verifying";
  }

  switch (node.status) {
    case "executing":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "pending":
    default:
      return "pending";
  }
}

function mapGoalNodeCanvasPriority(node: Pick<GoalNode, "status" | "reviewStatus">): string {
  const canvasStatus = mapGoalNodeCanvasStatus(node);
  switch (canvasStatus) {
    case "failed":
      return "critical";
    case "running":
    case "verifying":
      return "high";
    case "done":
    case "skipped":
      return "low";
    case "pending":
    default:
      return "medium";
  }
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

type ManagedWorkspaceLease = Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>>;

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

interface TopLevelAdmissionResult {
  decision: SupervisorAdmissionDecision;
  canExecuteGoalInline: boolean;
  supervisorGoalTree?: GoalTree;
  supervisorGoalStartedAt: number;
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
  workspaceBus?: WorkspaceBus;
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
  private workspaceBus?: WorkspaceBus;
  private monitorLifecycle?: MonitorLifecycle;
  private daemonBudgetTracker?: BudgetTracker;
  private currentPhase?: 'planning' | 'acting' | 'observing' | 'reflecting';
  private nodeProgress?: Map<string, { current: number; total: number; unit: string }>;

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
    this.workspaceBus = opts.workspaceBus;
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

  setWorkspaceBus(bus: WorkspaceBus): void {
    this.workspaceBus = bus;
  }

  setMonitorLifecycle(lifecycle: MonitorLifecycle): void {
    this.monitorLifecycle = lifecycle;
  }

  private emitGoalNarrative(task: Task, tree: GoalTree, nodeId?: string): void {
    if (!this.workspaceBus) {
      return;
    }
    const feedback = buildGoalNarrativeFeedback(tree, task.prompt);
    this.workspaceBus.emit("progress:narrative", {
      ...(nodeId ? { nodeId } : {}),
      narrative: feedback.narrative,
      lang: feedback.language,
      milestone: feedback.milestone,
    });
  }

  private buildGoalProgressSignal(task: Task, tree: GoalTree, updated = false): TaskProgressSignal {
    const feedback = buildGoalNarrativeFeedback(tree, task.prompt);
    return {
      kind: "goal",
      message: updated
        ? `Goal progress updated: ${feedback.milestone.current}/${feedback.milestone.total} ${feedback.milestone.label}`
        : `Goal plan ready: ${feedback.milestone.total} ${feedback.milestone.label}`,
      userSummary: feedback.narrative,
    };
  }

  private buildKickoffProgressSignal(task: Task): TaskProgressSignal {
    const isTurkish = /[ğüşöçıİ]|\b(?:ve|için|şu|hata|düzelt|incele|bak|çöz|dosya|ekle|güncelle)\b/iu.test(task.prompt);
    return {
      kind: "analysis",
      message: "Task started",
      userSummary: isTurkish
        ? "Aşama: inceleme. Son aksiyon: ilgili kanıtlar üzerinde hızlı bir ilk tarama başlattım. Sıradaki adım: ilk somut müdahale noktasını çıkaracağım."
        : "Stage: inspection. Last action: I started a quick first pass over the relevant evidence. Next: I'll line up the first concrete intervention point.",
    };
  }

  private getConversationScope(task: Pick<Task, "chatId" | "conversationId">): string {
    return resolveConversationScope(task.chatId, task.conversationId);
  }

  private async resolveTopLevelAdmission(params: {
    task: Task;
    taskOrchestrator: Orchestrator;
    signal: AbortSignal;
    onProgress: (message: TaskProgressUpdate) => void;
    workspaceLease?: ManagedWorkspaceLease;
  }): Promise<TopLevelAdmissionResult> {
    const { task, taskOrchestrator, signal, onProgress, workspaceLease } = params;
    const hasRichInput =
      (task.attachments?.length ?? 0) > 0 ||
      (Array.isArray(task.userContent) && task.userContent.some((block) => block.type !== "text"));
    const shouldDecomposeTask = this.decomposer?.shouldDecompose(task.prompt) ?? false;
    const shouldAttemptSharedPlanning =
      Boolean(task.goalTree) || Boolean(task.forceSharedPlanning) || shouldDecomposeTask;
    const canExecuteGoalInline = !hasRichInput && (Boolean(task.goalTree) || shouldDecomposeTask);
    const fallbackDecision: SupervisorAdmissionDecision = {
      path: canExecuteGoalInline ? "direct_goal_execution" : "direct_worker",
      reason: "unavailable",
    };

    const supervisorCapableOrchestrator = taskOrchestrator as Orchestrator & {
      evaluateSupervisorAdmission?: (params: {
        prompt: string;
        chatId: string;
        channelType?: string;
        conversationId?: string;
        userId?: string;
        signal?: AbortSignal;
        goalTree?: GoalTree;
        forceEligibility?: boolean;
        userContent?: string | import("../agents/providers/provider-core.interface.js").MessageContent[] | null;
        attachments?: import("../channels/channel.interface.js").Attachment[];
        taskRunId?: string;
        onUsage?: (usage: { provider: string; inputTokens: number; outputTokens: number }) => void;
        workspaceLease?: ManagedWorkspaceLease;
        onActivated?: (activation: { markdown: string }) => Promise<void> | void;
        reportUpdate?: (markdown: string) => Promise<void> | void;
        onGoalDecomposed?: (goalTree: GoalTree) => void;
      }) => Promise<SupervisorAdmissionDecision>;
    };

    if (typeof supervisorCapableOrchestrator.evaluateSupervisorAdmission !== "function") {
      return {
        decision: fallbackDecision,
        canExecuteGoalInline,
        supervisorGoalStartedAt: 0,
      };
    }

    let lastSupervisorSummary = "";
    let supervisorGoalTree: GoalTree | undefined;
    let supervisorGoalStartedAt = 0;
    const emitSupervisorProgress = (summary: string): void => {
      const normalized = summary.trim();
      if (!normalized || normalized === lastSupervisorSummary) {
        return;
      }
      lastSupervisorSummary = normalized;
      onProgress({
        kind: "goal",
        message: "Supervisor update",
        userSummary: normalized,
      });
    };

    const decision = await supervisorCapableOrchestrator.evaluateSupervisorAdmission({
      prompt: task.prompt,
      chatId: task.chatId,
      channelType: task.channelType,
      conversationId: task.conversationId,
      userId: task.userId,
      signal,
      goalTree: task.goalTree,
      forceEligibility: shouldAttemptSharedPlanning,
      userContent: task.userContent,
      attachments: task.attachments,
      taskRunId: task.id,
      onUsage: this.buildUsageRecorder(task),
      workspaceLease,
      onGoalDecomposed: (goalTree: GoalTree) => {
        supervisorGoalTree = goalTree;
        supervisorGoalStartedAt = Date.now();
        this.beginGoalExecution(task, goalTree, onProgress);
      },
      onActivated: (activation) => {
        emitSupervisorProgress(normalizeSupervisorProgressMarkdown(activation.markdown));
      },
      reportUpdate: (markdown) => {
        emitSupervisorProgress(normalizeSupervisorProgressMarkdown(markdown));
      },
    });
    const normalizedDecision =
      decision.path === "direct_worker" && canExecuteGoalInline && shouldAttemptSharedPlanning
        ? {
            ...decision,
            path: "direct_goal_execution" as const,
          }
        : decision;

    return {
      decision: normalizedDecision,
      canExecuteGoalInline,
      supervisorGoalTree,
      supervisorGoalStartedAt,
    };
  }

  private beginGoalExecution(
    task: Task,
    goalTree: GoalTree,
    onProgress: (message: TaskProgressUpdate) => void,
  ): void {
    const logger = getLogger();
    this.taskManager?.attachGoalRoot?.(task.id, String(goalTree.rootId));
    onProgress(this.buildGoalProgressSignal(task, goalTree));
    this.emitGoalNarrative(task, goalTree);
    this.emitGoalCanvasSnapshot(task, goalTree);

    const conversationScope = this.getConversationScope(task);
    if (this.monitorLifecycle) {
      this.monitorLifecycle.goalDecomposed(conversationScope, goalTree);
    } else if (this.workspaceBus) {
      this.workspaceBus.emit("monitor:dag_init", goalTreeToDagPayload(goalTree));
    }

    if (this.daemonEventBus) {
      this.daemonEventBus.emit("goal:started", {
        rootId: goalTree.rootId,
        taskDescription: goalTree.taskDescription,
        nodeCount: goalTree.nodes.size - 1,
        timestamp: Date.now(),
      });
    }

    if (this.goalStorage) {
      try {
        this.goalStorage.upsertTree(goalTree, "executing");
      } catch (e) {
        logger.debug("Goal tree initial persistence failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  private buildGoalCanvasSummary(
    task: Task,
    goalTree: GoalTree,
    statusLine?: string,
  ): WorkspaceEventMap["canvas:agent_draw"]["shapes"][number] {
    const feedback = buildGoalNarrativeFeedback(goalTree, task.prompt);
    const lines = [
      truncateCanvasText(goalTree.taskDescription, 96),
      "",
      `Progress: ${feedback.milestone.current}/${feedback.milestone.total} ${feedback.milestone.label}`,
      feedback.narrative,
    ];

    if (statusLine) {
      lines.push("", statusLine);
    }

    return {
      id: goalCanvasSummaryShapeId(String(goalTree.rootId)),
      type: "note-block",
      position: { x: GOAL_CANVAS_SUMMARY_X, y: GOAL_CANVAS_SUMMARY_Y },
      props: {
        w: GOAL_CANVAS_SUMMARY_WIDTH,
        h: GOAL_CANVAS_SUMMARY_HEIGHT,
        color: "#7dd3fc",
        content: lines.join("\n"),
      },
    };
  }

  private buildGoalCanvasPositions(goalTree: GoalTree): Map<string, { x: number; y: number }> {
    const nodesByDepth = new Map<number, GoalNode[]>();
    for (const node of goalTree.nodes.values()) {
      if (String(node.id) === String(goalTree.rootId)) {
        continue;
      }
      const bucket = nodesByDepth.get(node.depth) ?? [];
      bucket.push(node);
      nodesByDepth.set(node.depth, bucket);
    }

    const positions = new Map<string, { x: number; y: number }>();
    for (const [depth, nodes] of [...nodesByDepth.entries()].sort((left, right) => left[0] - right[0])) {
      nodes.sort((left, right) => left.task.localeCompare(right.task));
      const centeredOffset = ((nodes.length - 1) * GOAL_CANVAS_ROW_GAP) / 2;
      nodes.forEach((node, index) => {
        positions.set(String(node.id), {
          x: GOAL_CANVAS_SUMMARY_X + (depth * GOAL_CANVAS_COLUMN_GAP),
          y: GOAL_CANVAS_SUMMARY_Y + (index * GOAL_CANVAS_ROW_GAP) - centeredOffset,
        });
      });
    }

    return positions;
  }

  private buildGoalCanvasNodeShape(
    node: GoalNode,
    position: { x: number; y: number } | undefined,
  ): WorkspaceEventMap["canvas:agent_draw"]["shapes"][number] {
    return {
      id: goalCanvasNodeShapeId(String(node.id)),
      type: "task-card",
      ...(position ? { position } : {}),
      props: {
        w: GOAL_CANVAS_CARD_WIDTH,
        h: GOAL_CANVAS_CARD_HEIGHT,
        title: truncateCanvasText(node.task),
        status: mapGoalNodeCanvasStatus(node),
        priority: mapGoalNodeCanvasPriority(node),
      },
    };
  }

  private emitGoalCanvasSnapshot(task: Task, goalTree: GoalTree): void {
    if (!this.workspaceBus) {
      return;
    }

    const positions = this.buildGoalCanvasPositions(goalTree);
    this.workspaceBus.emit("canvas:agent_draw", {
      action: "draw",
      intent: "goal_execution_board",
      autoSwitch: false,
      layout: "flow",
      shapes: [
        this.buildGoalCanvasSummary(task, goalTree),
        ...[...goalTree.nodes.values()]
          .filter((node) => String(node.id) !== String(goalTree.rootId))
          .map((node) => this.buildGoalCanvasNodeShape(node, positions.get(String(node.id)))),
      ],
    });
  }

  private emitGoalCanvasNodeUpdate(task: Task, goalTree: GoalTree, updatedNode: GoalNode): void {
    if (!this.workspaceBus) {
      return;
    }

    const positions = this.buildGoalCanvasPositions(goalTree);
    this.workspaceBus.emit("canvas:agent_draw", {
      action: "update",
      intent: "goal_execution_board",
      autoSwitch: false,
      shapes: [
        this.buildGoalCanvasSummary(task, goalTree),
        this.buildGoalCanvasNodeShape(updatedNode, positions.get(String(updatedNode.id))),
      ],
    });
  }

  private completeGoalExecution(
    task: Task,
    goalTree: GoalTree,
    durationMs: number,
    successCount: number,
  ): void {
    const logger = getLogger();
    if (this.goalStorage) {
      try {
        this.goalStorage.updateTreeStatus(goalTree.rootId, "completed");
      } catch (e) {
        logger.debug("Goal tree completion persistence failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (this.daemonEventBus) {
      this.daemonEventBus.emit("goal:complete", {
        rootId: goalTree.rootId,
        taskDescription: goalTree.taskDescription,
        durationMs,
        successCount,
        failureCount: 0,
        timestamp: Date.now(),
      });
    }

    this.workspaceBus?.emit("canvas:agent_draw", {
      action: "update",
      intent: "goal_execution_board",
      autoSwitch: false,
      shapes: [
        this.buildGoalCanvasSummary(task, goalTree, "Status: completed"),
      ],
    });
  }

  private failGoalExecution(task: Task, goalTree: GoalTree, error: string, failureCount: number): void {
    const logger = getLogger();
    if (this.goalStorage) {
      try {
        this.goalStorage.updateTreeStatus(goalTree.rootId, "failed");
      } catch (e) {
        logger.debug("Goal tree failure persistence failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (this.daemonEventBus) {
      this.daemonEventBus.emit("goal:failed", {
        rootId: goalTree.rootId,
        error,
        failureCount,
        timestamp: Date.now(),
      });
    }

    this.workspaceBus?.emit("canvas:agent_draw", {
      action: "update",
      intent: "goal_execution_board",
      autoSwitch: false,
      shapes: [
        this.buildGoalCanvasSummary(task, goalTree, `Blocked: ${sanitizeError(error, 120)}`),
      ],
    });
  }

  setPhase(phase: 'planning' | 'acting' | 'observing' | 'reflecting'): void {
    this.currentPhase = phase;
  }

  setNodeProgress(nodeId: string, current: number, total: number, unit: string): void {
    if (!this.nodeProgress) this.nodeProgress = new Map();
    this.nodeProgress.set(nodeId, { current, total, unit });
  }

  emitSubstep(
    rootId: string,
    nodeId: string,
    substep: {
      id: string;
      label: string;
      status: "active" | "done" | "skipped";
      order: number;
      files?: string[];
    },
  ): void {
    if (this.workspaceBus) {
      this.workspaceBus.emit("monitor:substep", { rootId, nodeId, substep });
    }
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
    const shouldDeferDaemonWork = this.taskManager?.hasActiveForegroundTasks?.() ?? false;
    let firstRunnableDaemonIndex = -1;
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
        if (entry.task.origin !== "daemon") {
          return index;
        }
        if (!shouldDeferDaemonWork && firstRunnableDaemonIndex < 0) {
          firstRunnableDaemonIndex = index;
        }
      }
    }
    return firstRunnableDaemonIndex;
  }

  private async executeWorkerRun(
    orchestrator: Orchestrator,
    params: {
      mode: WorkerRunRequest["mode"];
      prompt: string;
      signal: AbortSignal;
      onProgress: (message: TaskProgressUpdate) => void;
      chatId: string;
      taskRunId: string;
      channelType: string;
      conversationId?: string;
      userId?: string;
      assignedProvider?: string;
      assignedModel?: string;
      attachments?: import("../channels/channel.interface.js").Attachment[];
      userContent?: string | import("../agents/providers/provider-core.interface.js").MessageContent[] | null;
      onUsage?: (usage: { provider: string; inputTokens: number; outputTokens: number }) => void;
      workspaceLease?: Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>>;
      workspaceLeaseRetained?: boolean;
      supervisorMode?: import("./types.js").BackgroundTaskOptions["supervisorMode"];
    },
  ): Promise<{ output: string; workerResult?: WorkerRunResult }> {
    if (typeof (orchestrator as Orchestrator & { runWorkerTask?: unknown }).runWorkerTask === "function") {
      const workerResult = await (
        orchestrator as Orchestrator & {
          runWorkerTask: (request: {
            prompt: string;
            mode: WorkerRunRequest["mode"];
            signal: AbortSignal;
            onProgress: (message: TaskProgressUpdate) => void;
            chatId: string;
            taskRunId: string;
            channelType: string;
            conversationId?: string;
            userId?: string;
            assignedProvider?: string;
            assignedModel?: string;
            attachments?: import("../channels/channel.interface.js").Attachment[];
            userContent?: string | import("../agents/providers/provider-core.interface.js").MessageContent[] | null;
            onUsage?: (usage: { provider: string; inputTokens: number; outputTokens: number }) => void;
            workspaceLease?: Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>>;
            workspaceLeaseRetained?: boolean;
            supervisorMode?: import("./types.js").BackgroundTaskOptions["supervisorMode"];
          }) => Promise<WorkerRunResult>;
        }
      ).runWorkerTask({
        prompt: params.prompt,
        mode: params.mode,
        signal: params.signal,
        onProgress: params.onProgress,
        chatId: params.chatId,
        taskRunId: params.taskRunId,
        channelType: params.channelType,
        conversationId: params.conversationId,
        userId: params.userId,
        assignedProvider: params.assignedProvider,
        assignedModel: params.assignedModel,
        attachments: params.attachments,
        userContent: params.userContent,
        onUsage: params.onUsage,
        workspaceLease: params.workspaceLease,
        workspaceLeaseRetained: params.workspaceLeaseRetained,
        supervisorMode: params.supervisorMode,
      });
      return {
        output: workerResult.visibleResponse,
        workerResult,
      };
    }

    return {
      output: await orchestrator.runBackgroundTask(
        params.prompt,
        {
          signal: params.signal,
          onProgress: params.onProgress,
          chatId: params.chatId,
          taskRunId: params.taskRunId,
          channelType: params.channelType,
          conversationId: params.conversationId,
          userId: params.userId,
          assignedProvider: params.assignedProvider,
          assignedModel: params.assignedModel,
          attachments: params.attachments,
          userContent: params.userContent,
          onUsage: params.onUsage,
          workspaceLease: params.workspaceLease,
          workspaceLeaseRetained: params.workspaceLeaseRetained,
          supervisorMode: params.supervisorMode,
        } as import("./types.js").BackgroundTaskOptions & {
          workspaceLeaseRetained?: boolean;
        },
      ),
    };
  }

  async runWorkerEnvelope(
    orchestrator: Orchestrator,
    params: {
      mode: WorkerRunRequest["mode"];
      prompt: string;
      signal: AbortSignal;
      onProgress: (message: TaskProgressUpdate) => void;
      chatId: string;
      taskRunId: string;
      channelType: string;
      conversationId?: string;
      userId?: string;
      assignedProvider?: string;
      assignedModel?: string;
      attachments?: import("../channels/channel.interface.js").Attachment[];
      userContent?: string | import("../agents/providers/provider-core.interface.js").MessageContent[] | null;
      onUsage?: (usage: { provider: string; inputTokens: number; outputTokens: number }) => void;
      workspaceLease?: Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>>;
      workspaceSourceRoot?: string;
      supervisorMode?: import("./types.js").BackgroundTaskOptions["supervisorMode"];
    },
  ): Promise<{ output: string; workerResult?: WorkerRunResult }> {
    const managedWorkspaceLease = params.workspaceLease ?? (this.workspaceLeaseManager
      ? await this.workspaceLeaseManager.acquireLease({
        label: `${params.mode}-worker-${params.taskRunId}`,
        workerId: params.taskRunId,
        ...(params.workspaceSourceRoot
          ? {
              sourceRoot: params.workspaceSourceRoot,
              forceTempCopy: true,
            }
          : {}),
      })
      : undefined);
    const shouldReleaseLease = !params.workspaceLease && Boolean(managedWorkspaceLease);

    try {
      return await this.executeWorkerRun(orchestrator, {
        ...params,
        workspaceLease: managedWorkspaceLease,
        workspaceLeaseRetained: !shouldReleaseLease,
      });
    } finally {
      if (shouldReleaseLease) {
        await managedWorkspaceLease?.release().catch(() => {});
      }
    }
  }

  private async executeTask(entry: QueueEntry): Promise<void> {
    const { task, signal, onProgress } = entry;
    const logger = getLogger();
    const taskOrchestrator = task.orchestrator ?? this.orchestrator;
    let taskWorkspaceLease: ManagedWorkspaceLease | undefined;

    if (!this.taskManager) {
      logger.error("TaskManager not set on BackgroundExecutor");
      return;
    }

    if (signal.aborted) {
      return;
    }

    // Update status to executing
    this.taskManager.updateStatus(task.id, TaskStatus.executing);
    onProgress(this.buildKickoffProgressSignal(task));

    const conversationScope = this.getConversationScope(task);

    // Monitor lifecycle: emit simple DAG so monitor workspace always shows something
    this.monitorLifecycle?.requestStart(conversationScope, task.prompt);

    let requestFailed = false;
    let activeGoalTree: GoalTree | undefined;
    try {
      const hasRichInput =
        (task.attachments?.length ?? 0) > 0 ||
        (Array.isArray(task.userContent) && task.userContent.some((block) => block.type !== "text"));
      const shouldDecomposeTask = this.decomposer?.shouldDecompose(task.prompt) ?? false;
      const shouldAttemptSharedPlanning =
        Boolean(task.goalTree) || Boolean(task.forceSharedPlanning) || shouldDecomposeTask;
      const shouldUseTaskWorkspace =
        shouldAttemptSharedPlanning || (!hasRichInput && shouldDecomposeTask);
      if (shouldUseTaskWorkspace && this.workspaceLeaseManager) {
        taskWorkspaceLease = await this.workspaceLeaseManager.acquireLease({
          label: `task-${task.id}`,
          workerId: String(task.id),
        });
      }
      const admission = await this.resolveTopLevelAdmission({
        task,
        taskOrchestrator,
        signal,
        onProgress,
        workspaceLease: taskWorkspaceLease,
      });
      const supervisorDecision = admission.decision;

      if (supervisorDecision.path === "supervisor") {
        const supervisorResult = supervisorDecision.result;
        activeGoalTree = admission.supervisorGoalTree;
        if (admission.supervisorGoalTree) {
          if (supervisorResult.success) {
            this.completeGoalExecution(
              task,
              admission.supervisorGoalTree,
              Date.now() - admission.supervisorGoalStartedAt,
              supervisorResult.succeeded,
            );
          } else {
            this.failGoalExecution(
              task,
              admission.supervisorGoalTree,
              supervisorResult.partial ? "Goal execution blocked" : "Goal execution failed",
              supervisorResult.failed + supervisorResult.skipped,
            );
          }
        }

        if (signal.aborted) {
          return;
        }

        if (supervisorResult.success) {
          this.taskManager.complete(task.id, supervisorResult.output);
          return;
        }
        if (supervisorResult.partial) {
          requestFailed = true;
          this.taskManager.block(task.id, supervisorResult.output);
          return;
        }
        requestFailed = true;
        this.taskManager.fail(task.id, supervisorResult.output);
        return;
      }

      if (signal.aborted) {
        return;
      }

      if (supervisorDecision.path === "direct_goal_execution" && admission.canExecuteGoalInline) {
        const result = await this.executeDecomposed(
          task,
          signal,
          onProgress,
          task.goalTree,
          taskWorkspaceLease,
        );
        if (signal.aborted) return;
        if (!result.success) {
          if (result.blocked) {
            requestFailed = true;
            this.taskManager.block(
              task.id,
              result.output || result.error || "Goal execution blocked",
            );
            return;
          }
          requestFailed = true;
          this.taskManager.fail(task.id, result.error ?? "Goal execution failed");
          return;
        }
        this.taskManager.complete(task.id, result.output);
        return;
      }

      const result = await this.runWorkerEnvelope(taskOrchestrator, {
        mode: "background",
        prompt: task.prompt,
        signal,
        onProgress,
        chatId: task.chatId,
        taskRunId: task.id,
        channelType: task.channelType,
        conversationId: task.conversationId,
        userId: task.userId,
        attachments: task.attachments,
        userContent: task.userContent,
        onUsage: this.buildUsageRecorder(task),
        workspaceLease: taskWorkspaceLease,
        supervisorMode: "off",
      });

      if (signal.aborted) {
        // Already cancelled -- don't overwrite the cancelled status
        return;
      }

      if (result.workerResult && result.workerResult.status === "failed") {
        requestFailed = true;
        this.taskManager.fail(
          task.id,
          result.workerResult.reason ?? (result.output || "Task failed"),
        );
        return;
      }

      if (result.workerResult && result.workerResult.status === "blocked") {
        requestFailed = true;
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
      requestFailed = true;
      this.taskManager.fail(task.id, errMsg);

      // Emit goal:failed if we have a goal tree context (INT-02 catch path)
      if (activeGoalTree) {
        this.failGoalExecution(task, activeGoalTree, errMsg, 0);
      } else if (task.goalTree) {
        this.failGoalExecution(task, task.goalTree, errMsg, 0);
      }
    } finally {
      await taskWorkspaceLease?.release().catch(() => {});
      this.monitorLifecycle?.requestEnd(conversationScope, requestFailed);
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
    workspaceLease?: ManagedWorkspaceLease,
  ): Promise<DecomposedExecutionResult> {
    const logger = getLogger();
    const startTime = Date.now();
    const taskOrchestrator = task.orchestrator ?? this.orchestrator;

    // Use pre-built tree if provided, otherwise decompose
    const goalTree = preBuiltTree ?? await this.decomposer!.decomposeProactive(task.chatId, task.prompt);
    const nodeCount = goalTree.nodes.size - 1; // exclude root
    logger.info("Task decomposed into goal tree", { taskId: task.id, nodeCount, preBuilt: !!preBuiltTree });
    this.beginGoalExecution(task, goalTree, onProgress);

    // Create executor with config (or defaults)
    const config: GoalExecutorConfig = {
      maxRetries: 1,
      maxFailures: 3,
      parallelExecution: workspaceLease ? false : true,
      maxParallel: workspaceLease ? 1 : 3,
      ...this.goalExecutorConfig,
      maxRedecompositions: this.goalExecutorConfig?.maxRedecompositions ?? this.goalConfig?.maxRedecompositions ?? 2,
    };
    const executor = new GoalExecutor(config);
    const childWorkerResults = new Map<string, WorkerRunResult>();
    let blockedWorkerReason: string | undefined;

    // Node executor: delegates to orchestrator.runBackgroundTask
    const nodeExecutor = async (node: GoalNode, nodeSignal: AbortSignal): Promise<string> => {
      const result = await this.runWorkerEnvelope(taskOrchestrator, {
        mode: "background",
        prompt: node.task,
        signal: nodeSignal,
        onProgress: (msg: TaskProgressUpdate) =>
          onProgress(typeof msg === "string" ? `[${node.task}] ${msg}` : msg),
        chatId: task.chatId,
        taskRunId: `${task.id}:${node.id}`,
        channelType: task.channelType,
        conversationId: task.conversationId,
        userId: task.userId,
        attachments: task.attachments,
        userContent: task.userContent,
        onUsage: this.buildUsageRecorder(task),
        workspaceLease,
        supervisorMode: "off",
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

      // Workspace monitor: task update event for dashboard UI
      if (this.workspaceBus) {
        this.workspaceBus.emit("monitor:task_update", {
          rootId: String(updatedTree.rootId),
          nodeId: String(updatedNode.id),
          status: String(updatedNode.status),
          reviewStatus: updatedNode.reviewStatus,
          phase: updatedNode.status === "executing"
            ? (this.currentPhase ?? "acting")
            : undefined,
          progress: this.nodeProgress?.get(String(updatedNode.id)),
          elapsed: updatedNode.startedAt
            ? Date.now() - updatedNode.startedAt
            : undefined,
        });
      }

      // Throttled progress rendering to avoid message flood
      const now = Date.now();
      const isTerminal = updatedNode.status === "completed" || updatedNode.status === "failed" || updatedNode.status === "skipped";
      if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS || isTerminal) {
        lastProgressUpdate = now;
        onProgress(this.buildGoalProgressSignal(task, updatedTree, true));
        this.emitGoalNarrative(task, updatedTree, String(updatedNode.id));
        this.emitGoalCanvasNodeUpdate(task, updatedTree, updatedNode);
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

    const allChildWorkerResults = [...childWorkerResults.values()];
    const blockedWorker = allChildWorkerResults.find((workerResult) => workerResult.status === "blocked");
    const childWorkerIssues = allChildWorkerResults.some(
      (workerResult) =>
        workerResult.status !== "completed" ||
        workerResult.reviewFindings.some((finding) => finding.severity === "error") ||
        workerResult.verificationResults.some((entry) => entry.status === "issues"),
    );
    const hasFailed = result.aborted || result.failureCount > 0 || childWorkerIssues;
    if (hasFailed) {
      this.failGoalExecution(
        task,
        goalTree,
        result.aborted ? "Goal aborted" : `${result.failureCount} sub-goal(s) failed`,
        result.failureCount,
      );
    } else {
      this.completeGoalExecution(
        task,
        goalTree,
        Date.now() - startTime,
        result.results.filter((r) => r.result && !r.error).length,
      );
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
    if (blockedWorker) {
      const blockedSummary = blockedWorkerReason ?? blockedWorker.reason ?? "Goal execution blocked";
      output = output.trim()
        ? `${output}\n\nBlocked:\n${blockedSummary}`
        : `Blocked:\n${blockedSummary}`;
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
