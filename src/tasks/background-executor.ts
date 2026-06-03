/**
 * Background Executor
 *
 * Async execution queue for running tasks in the background.
 * Uses a FIFO queue with configurable concurrency limit.
 * All work is I/O-bound (LLM API calls), so same event loop is fine.
 *
 * Routes tasks through two execution paths:
 *  - "supervisor": full supervisor-managed execution with goal decomposition
 *  - "direct_worker": single-shot worker execution via orchestrator
 *
 * Emits goal lifecycle events to DaemonEventBus for WebSocket dashboard
 * broadcasting.
 */

import type {
  Task,
  TaskProgressSignal,
  TaskProgressUpdate,
} from "./types.js";
import { getTaskConversationKey, TaskStatus } from "./types.js";
import type { ITaskManager, IOrchestrator, SupervisorAdmissionDecision } from "./orchestrator-contract.js";
import { resolveConversationScope } from "../agents/orchestrator-text-utils.js";
import type { GoalDecomposer } from "../goals/goal-decomposer.js";
import type { GoalNode, GoalTree } from "../goals/types.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import { buildGoalNarrativeFeedback } from "../goals/goal-feedback.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { DaemonEventMap } from "../daemon/daemon-events.js";
import { estimateCost } from "../security/rate-limiter.js";
import type { BudgetTracker } from "../daemon/budget/budget-tracker.js";
import type { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
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

const GOAL_CANVAS_SUMMARY_WIDTH = 320;
const GOAL_CANVAS_SUMMARY_HEIGHT = 180;
const GOAL_CANVAS_CARD_WIDTH = 240;
const GOAL_CANVAS_CARD_HEIGHT = 120;
const GOAL_CANVAS_COLUMN_GAP = 320;
const GOAL_CANVAS_ROW_GAP = 180;
const GOAL_CANVAS_SUMMARY_X = 0;
const GOAL_CANVAS_SUMMARY_Y = 0;

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

type ManagedWorkspaceLease = Awaited<ReturnType<WorkspaceLeaseManager["acquireLease"]>>;

interface TopLevelAdmissionResult {
  decision: SupervisorAdmissionDecision;
  supervisorGoalTree?: GoalTree;
  supervisorGoalStartedAt: number;
}

export interface BackgroundExecutorOptions {
  orchestrator: IOrchestrator;
  concurrencyLimit?: number;
  decomposer?: GoalDecomposer;
  goalStorage?: GoalStorage;
  aiProvider?: IAIProvider;
  channel?: IChannelAdapter;
  daemonEventBus?: IEventEmitter<DaemonEventMap>;
  learningEventBus?: IEventEmitter<LearningEventMap>;
  workspaceLeaseManager?: WorkspaceLeaseManager;
  workspaceBus?: WorkspaceBus;
  /**
   * Per-task INACTIVITY timeout (ms). A task is aborted only after it produces no
   * progress for this long; every progress update resets the window. Defaults to
   * {@link DEFAULT_TASK_INACTIVITY_TIMEOUT_MS}. Reasoning models (gpt-5.x) can
   * "think" for minutes on a single step, so this must NOT be a hard wall-clock cap.
   */
  taskInactivityTimeoutMs?: number;
  /**
   * The per-LLM-call stream initial timeout (ms). Used only to enforce the ordering
   * invariant {@link MIN_INACTIVITY_OVER_STREAM_RATIO}× so the per-task inactivity
   * window is always strictly larger than a single legitimately-long LLM call —
   * otherwise the blind task timer could abort a call the stream watchdog is still
   * keeping alive (it does not see keepalive liveness; see ARCHITECTURE-AUDIT #8/#9).
   */
  streamInitialTimeoutMs?: number;
}

/** The task inactivity window must be at least this multiple of the per-call stream window. */
export const MIN_INACTIVITY_OVER_STREAM_RATIO = 2;

/**
 * Default per-task inactivity window. A background task is aborted only after it
 * has produced NO progress update for this long (not a hard wall-clock cap), so a
 * reasoning model that legitimately spends minutes on a single step is not killed
 * mid-flight, while a genuinely hung task still cannot block the conversation
 * forever. The streaming stall watchdog (LLM_STREAM_STALL_TIMEOUT_MS) independently
 * detects dead provider connections during a single LLM call.
 */
export const DEFAULT_TASK_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export class BackgroundExecutor {
  private readonly queue: QueueEntry[] = [];
  private readonly activeConversations = new Set<string>();
  private readonly pausedConversations = new Set<string>();
  private running = 0;
  private taskManager: ITaskManager | null = null;
  private readonly orchestrator: IOrchestrator;
  private readonly concurrencyLimit: number;
  private readonly taskInactivityTimeoutMs: number;
  private readonly decomposer?: GoalDecomposer;
  private readonly goalStorage?: GoalStorage;
  private readonly daemonEventBus?: IEventEmitter<DaemonEventMap>;
  private readonly workspaceLeaseManager?: WorkspaceLeaseManager;
  private workspaceBus?: WorkspaceBus;
  private monitorLifecycle?: MonitorLifecycle;
  private daemonBudgetTracker?: BudgetTracker;
  private _unifiedBudgetManager?: UnifiedBudgetManager;

  constructor(opts: BackgroundExecutorOptions) {
    this.orchestrator = opts.orchestrator;
    this.concurrencyLimit = opts.concurrencyLimit ?? 3;
    // Enforce the ordering invariant: the per-task inactivity window must be at least
    // MIN_INACTIVITY_OVER_STREAM_RATIO× the per-call stream window, so a single long
    // (keepalive-kept-alive) LLM call can never trip the task timer before the stream
    // watchdog would. The task timer cannot observe intra-call keepalive liveness, so
    // it must give the call strictly more headroom than the per-call watchdog.
    {
      const requested = opts.taskInactivityTimeoutMs ?? DEFAULT_TASK_INACTIVITY_TIMEOUT_MS;
      const floor = (opts.streamInitialTimeoutMs ?? 0) * MIN_INACTIVITY_OVER_STREAM_RATIO;
      this.taskInactivityTimeoutMs = Math.max(requested, floor);
    }
    this.decomposer = opts.decomposer;
    this.goalStorage = opts.goalStorage;
    this.daemonEventBus = opts.daemonEventBus;
    this.workspaceLeaseManager = opts.workspaceLeaseManager;
    this.workspaceBus = opts.workspaceBus;
  }

  /**
   * Set the task manager reference (avoids circular dependency).
   */
  setTaskManager(manager: ITaskManager): void {
    this.taskManager = manager;
  }

  setDaemonBudgetTracker(tracker: BudgetTracker): void {
    this.daemonBudgetTracker = tracker;
  }

  setUnifiedBudgetManager(mgr: UnifiedBudgetManager): void {
    this._unifiedBudgetManager = mgr;
  }

  setWorkspaceBus(bus: WorkspaceBus): void {
    this.workspaceBus = bus;
  }

  setMonitorLifecycle(lifecycle: MonitorLifecycle): void {
    this.monitorLifecycle = lifecycle;
  }

  /** Shut down the executor: clear queue and release all workspace leases. */
  async shutdown(): Promise<void> {
    const logger = getLogger();
    logger.info("[BackgroundExecutor] Shutting down", {
      queueSize: this.queue.length,
      activeConversations: this.activeConversations.size,
    });

    // Clear pending queue
    this.queue.length = 0;
    this.activeConversations.clear();
    this.pausedConversations.clear();

    // Release workspace leases
    if (this.workspaceLeaseManager) {
      try {
        await this.workspaceLeaseManager.dispose();
      } catch (err) {
        logger.error("[BackgroundExecutor] Failed to dispose workspace leases", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
    taskOrchestrator: IOrchestrator;
    signal: AbortSignal;
    onProgress: (message: TaskProgressUpdate) => void;
    workspaceLease?: ManagedWorkspaceLease;
  }): Promise<TopLevelAdmissionResult> {
    const { task, taskOrchestrator, signal, onProgress, workspaceLease } = params;
    const fallbackDecision: SupervisorAdmissionDecision = {
      path: "direct_worker",
      reason: "unavailable",
    };

    const supervisorCapableOrchestrator = taskOrchestrator as IOrchestrator & {
      evaluateSupervisorAdmission?: (params: {
        prompt: string;
        chatId: string;
        channelType?: string;
        conversationId?: string;
        userId?: string;
        signal?: AbortSignal;
        goalTree?: GoalTree;
        // forceEligibility removed — supervisor complexity gate always applies
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
      // Do NOT bypass the supervisor complexity gate — let the orchestrator's
      // shouldActivateSupervisor() always apply. Previously forceEligibility was
      // set here which caused every decomposable prompt to skip the complexity
      // threshold, routing simple messages through the full supervisor pipeline.
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
    return {
      decision,
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

  setPhase(_phase: 'planning' | 'acting' | 'observing' | 'reflecting'): void {
    // No-op: direct_goal_execution path removed
  }

  setNodeProgress(_nodeId: string, _current: number, _total: number, _unit: string): void {
    // No-op: direct_goal_execution path removed
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

  /**
   * Pause a conversation so its tasks are not picked up by processQueue.
   * Running tasks continue until they naturally complete or abort.
   */
  pauseConversation(conversationKey: string): void {
    this.pausedConversations.add(conversationKey);
  }

  /**
   * Resume a previously paused conversation, allowing its queued tasks
   * to be picked up again.
   */
  resumeConversation(conversationKey: string): void {
    this.pausedConversations.delete(conversationKey);
    this.processQueue();
  }

  /**
   * Returns true if the conversation is currently paused.
   */
  isConversationPaused(conversationKey: string): boolean {
    return this.pausedConversations.has(conversationKey);
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
        try { this.taskManager.fail(task.id, errMsg); } catch (e) { logger.debug("Best-effort task fail", { taskId: task.id, error: e instanceof Error ? e.message : String(e) }); }
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

      // Combine the external cancel signal with a per-task INACTIVITY watchdog so a
      // hung task cannot block the conversation forever — WITHOUT killing a task
      // that is actively working. A reasoning model (gpt-5.x) can legitimately
      // spend minutes "thinking" on a single step; the previous hard 5-min
      // wall-clock cap aborted such tasks mid-flight ("This operation was aborted")
      // and collapsed the whole provider chain. Instead, abort only after the task
      // has produced NO progress for the inactivity window; every progress update
      // resets the timer. (The streaming stall watchdog independently catches a
      // genuinely dead provider connection during a single LLM call.)
      const inactivityTimeoutMs = this.taskInactivityTimeoutMs;
      const timeoutController = new AbortController();
      const onExternalAbort = () => timeoutController.abort();
      entry.signal.addEventListener("abort", onExternalAbort, { once: true });
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
      const armInactivityTimer = (): void => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(
          () => timeoutController.abort(new Error(`Task made no progress for ${inactivityTimeoutMs}ms`)),
          inactivityTimeoutMs,
        );
      };
      armInactivityTimer();
      // Wrap onProgress so every progress update the task emits resets the window.
      const progressAwareOnProgress = (update: TaskProgressUpdate): void => {
        armInactivityTimer();
        entry.onProgress(update);
      };
      const timedEntry: QueueEntry = {
        ...entry,
        signal: timeoutController.signal,
        onProgress: progressAwareOnProgress,
      };

      this.executeTask(timedEntry)
        .catch((err) => {
          // Catch any unhandled rejection that escapes executeTask's own try/catch
          const rawMsg = err instanceof Error ? err.message : String(err);
          logger.error("Unhandled error in executeTask", {
            taskId: entry.task.id,
            error: rawMsg,
          });
          // Best-effort: mark task as failed so it doesn't stay orphaned
          if (this.taskManager) {
            try {
              this.taskManager.fail(
                entry.task.id,
                sanitizeSecrets(rawMsg),
              );
            } catch (e) { getLogger().debug("Task fail cleanup", { taskId: entry.task.id, error: e instanceof Error ? e.message : String(e) }); }
          }
        })
        .finally(() => {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          entry.signal.removeEventListener("abort", onExternalAbort);
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
      if (this.pausedConversations.has(conversationKey)) {
        continue;
      }
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
    orchestrator: IOrchestrator,
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
      goalContext?: import("./types.js").GoalContext;
    },
  ): Promise<{ output: string; workerResult?: WorkerRunResult }> {
    if (typeof (orchestrator as IOrchestrator & { runWorkerTask?: unknown }).runWorkerTask === "function") {
      const workerResult = await (
        orchestrator as IOrchestrator & {
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
            goalContext?: import("./types.js").GoalContext;
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
        goalContext: params.goalContext,
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
          goalContext: params.goalContext,
        } as import("./types.js").BackgroundTaskOptions & {
          workspaceLeaseRetained?: boolean;
        },
      ),
    };
  }

  async runWorkerEnvelope(
    orchestrator: IOrchestrator,
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
      goalContext?: import("./types.js").GoalContext;
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
        await managedWorkspaceLease?.release().catch((err) => {
          getLogger().warn("Workspace lease release failed", { error: err instanceof Error ? err.message : String(err) });
        });
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
      const sanitizedErrMsg = sanitizeSecrets(errMsg);
      logger.error("Background task execution error", { taskId: task.id, error: sanitizedErrMsg });
      requestFailed = true;
      this.taskManager.fail(task.id, sanitizedErrMsg);

      // Emit goal:failed if we have a goal tree context (INT-02 catch path)
      if (activeGoalTree) {
        this.failGoalExecution(task, activeGoalTree, errMsg, 0);
      } else if (task.goalTree) {
        this.failGoalExecution(task, task.goalTree, errMsg, 0);
      }
    } finally {
      await taskWorkspaceLease?.release().catch((err) => {
        getLogger().warn("Task workspace lease release failed", { error: err instanceof Error ? err.message : String(err) });
      });
      this.monitorLifecycle?.requestEnd(conversationScope, requestFailed);
    }
  }

  private buildUsageRecorder(task: Task): ((usage: { provider: string; inputTokens: number; outputTokens: number }) => void) | undefined {
    if (!this._unifiedBudgetManager && !this.daemonBudgetTracker) {
      return undefined;
    }

    return (usage) => {
      const costUsd = estimateCost(usage.inputTokens, usage.outputTokens, usage.provider);
      if (costUsd <= 0) {
        return;
      }
      if (this._unifiedBudgetManager) {
        const source = task.origin === "daemon" ? "daemon" : "chat";
        this._unifiedBudgetManager.recordCost(costUsd, source, {
          model: usage.provider,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          triggerName: task.triggerName,
        });
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
