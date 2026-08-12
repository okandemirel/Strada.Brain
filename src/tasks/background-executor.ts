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
import {
  selectAgentRunner,
  toWorkerRunResult,
  type AgentRunRequest,
  type IOStrategy,
  type RunnerMode,
  type RunnerHostOrchestrator,
} from "../agent-core/runner/index.js";
import { TURKISH_HINT_RE } from "./progress-signals.js";
import { agentEventToTaskProgress, type AgentEvent } from "../agent-core/events/agent-event.js";
import { normalizeSupervisorProgressMarkdown } from "../supervisor/supervisor-feedback.js";
import type { MonitorLifecycle } from "../dashboard/monitor-lifecycle.js";
import type { WorkspaceBus } from "../dashboard/workspace-bus.js";
import {
  goalTreeToDagPayload,
  type WorkspaceEventMap,
} from "../dashboard/workspace-events.js";
// Single source for the per-task inactivity default (config-only; config has no dep on tasks).
import { DEFAULT_TASK_INACTIVITY_TIMEOUT_MS } from "../config/config.js";

const GOAL_CANVAS_SUMMARY_WIDTH = 320;

/**
 * Shared no-op for the background/worker IOStrategy.deliverFinal sink — these paths never deliver
 * to a channel (the answer is carried in AgentRunResult.finalText), so the sink is inert. Hoisted
 * to module scope so it is allocated once rather than per task.
 */
const NOOP_DELIVER_FINAL: IOStrategy["deliverFinal"] = () => {};
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
  /**
   * The ORIGINAL external cancel signal, BEFORE it is combined with the per-task
   * inactivity watchdog (see {@link BackgroundExecutor.processQueue}). Inside
   * {@link BackgroundExecutor.executeTask} `signal` is the COMBINED signal, so it
   * aborts for two distinct reasons: a user `/cancel` (external) OR the inactivity
   * watchdog firing. Only the external one is silent; a watchdog abort must emit a
   * terminal so the chat does not silently lose the answer (BUG#7). This field is
   * the authoritative "user actually cancelled" indicator that disambiguates them.
   * Absent for entries that have not yet been combined (queued).
   */
  externalSignal?: AbortSignal;
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
 * Default per-task inactivity window. Imported from config (the single source) and re-exported
 * so existing `src/tasks` importers keep resolving the established name unchanged; the value +
 * its rationale now live beside the sibling LLM stream timeouts in config-types.ts.
 */
export { DEFAULT_TASK_INACTIVITY_TIMEOUT_MS };

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
    const isTurkish = TURKISH_HINT_RE.test(task.prompt);
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

  /**
   * An aborted run reached a terminal early-return. Decide whether the abort was a
   * genuine user `/cancel` (stay silent — the user already knows) or the inactivity
   * WATCHDOG firing (the task hung with no progress). In the watchdog case we MUST
   * emit a terminal `block`, otherwise no `task:blocked`/`task:failed` event is
   * raised, the chat never receives an answer, and the task is stuck "executing"
   * forever (BUG#7 — silent data loss).
   *
   * `externalSignal` is the un-timed external cancel signal; if IT is aborted the
   * user cancelled. If only the combined `signal` is aborted, the watchdog fired.
   * Returns `true` if a watchdog terminal was emitted (so `requestFailed` should be
   * set by the caller); `false` for a genuine cancel (caller stays silent).
   */
  private settleWatchdogAbortIfHung(task: Task, externalSignal: AbortSignal | undefined): boolean {
    // A genuine external cancel: the user asked to stop. Stay silent.
    if (!externalSignal || externalSignal.aborted) {
      return false;
    }
    // Only the combined signal aborted -> the inactivity watchdog tripped. Block the
    // task with a clear "no progress" message instead of silently dropping it.
    if (!this.taskManager) {
      return false;
    }
    const isTurkish = TURKISH_HINT_RE.test(task.prompt);
    const message = isTurkish
      ? "Görev ilerleme kaydetmeden takıldı, bu yüzden durduruldu. Lütfen tekrar deneyin ya da isteği daha küçük adımlara bölün."
      : "The task stalled without making progress, so it was stopped. Please try again or break the request into smaller steps.";
    this.taskManager.block(task.id, message);
    return true;
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
    // Whole-goal monitor unit: a sub-goal task's decomposition grows the PARENT
    // episode (task.monitorScope) so it lands as nodes on the one whole-goal DAG.
    const monitorScope = task.monitorScope?.trim() || undefined;
    const emittedScope = monitorScope ?? conversationScope;
    if (this.monitorLifecycle) {
      this.monitorLifecycle.goalDecomposed(conversationScope, goalTree, monitorScope);
    } else if (this.workspaceBus) {
      this.workspaceBus.emit("monitor:dag_init", goalTreeToDagPayload(goalTree, emittedScope));
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
        // Liveness heartbeats exist only to re-arm the inactivity window from
        // intra-call stream activity (keepalive/reasoning); they are NOT user-facing
        // and must not reach the channel/UI (audit #8).
        if (typeof update === "object" && update.kind === "heartbeat") return;
        entry.onProgress(update);
      };
      const timedEntry: QueueEntry = {
        ...entry,
        signal: timeoutController.signal,
        onProgress: progressAwareOnProgress,
        // Preserve the un-timed external signal so executeTask can tell a real
        // user /cancel (silent) apart from the inactivity-watchdog abort (must
        // still emit a terminal — BUG#7).
        externalSignal: entry.signal,
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
      monitorScope?: string;
    },
  ): Promise<{ output: string; workerResult?: WorkerRunResult }> {
    // The runner seam (cutover Step 5: the V2 spine is THE engine — selectAgentRunner constructs
    // V2AgentRunner over the passed orchestrator's port/gateway and throws a descriptive error if
    // the host lacks the wiring hooks). The runner is built per-call over the PASSED orchestrator
    // (which may be a per-task orchestrator, not this.orchestrator). RunnerMode mirrors the
    // underlying WorkerRunRequest.mode: "delegated" → supervisor-node, anything else → worker;
    // the exact mode is preserved verbatim via request.workerMode.
    const mode: RunnerMode = params.mode === "delegated" ? "supervisor-node" : "worker";
    const runner = selectAgentRunner(orchestrator as unknown as RunnerHostOrchestrator, mode);
    const io: IOStrategy = {
      mode,
      // The V2 bus delivers the closed AgentEvent union to io.onEvent; v1 consumers expect
      // TaskProgressUpdate. agentEventToTaskProgress is THE adapter: narrative signals unwrap
      // verbatim (tool-batch detail), error/capability surface as status, everything else
      // collapses to the liveness heartbeat that re-arms the inactivity watchdog and is filtered
      // from the UI (audit #8). Already-v1-shaped updates (test fakes; the sink contract is still
      // typed TaskProgressUpdate) pass through untouched.
      onEvent: (e) => params.onProgress(agentEventToTaskProgress(e as AgentEvent | TaskProgressUpdate)),
      externalSignal: params.signal,
      // background/worker never delivers to a channel — the string is carried in the result.
      deliverFinal: NOOP_DELIVER_FINAL,
      // visibleSink omitted: background streams silently by design.
    };

    const request: AgentRunRequest = {
      prompt: params.prompt,
      workerMode: params.mode,
      chatId: params.chatId,
      channelType: params.channelType,
      conversationId: params.conversationId,
      userId: params.userId,
      taskRunId: params.taskRunId,
      attachments: params.attachments,
      userContent: params.userContent,
      assignedProvider: params.assignedProvider,
      assignedModel: params.assignedModel,
      workspaceLease: params.workspaceLease,
      workspaceLeaseRetained: params.workspaceLeaseRetained,
      supervisorMode: params.supervisorMode,
      goalContext: params.goalContext,
      // Parent-episode rollup scope; see AgentRunRequest.monitorScope. MONITOR-only.
      monitorScope: params.monitorScope,
      onUsage: params.onUsage,
    };

    const result = await runner.run(request, io);
    // toWorkerRunResult is a TOTAL projection post-Step-5 (the legacy bare-string path died
    // with V1AgentRunner) — every run yields the byte-identical structured worker view.
    return { output: result.finalText, workerResult: toWorkerRunResult(result) };
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
      monitorScope?: string;
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
      if (shouldReleaseLease && managedWorkspaceLease) {
        // Commit BEFORE release. release() deletes the lease directory, so
        // skipping this makes the whole lease write-only: the agent edits a
        // temp copy, verifies it, reports success, and the user's project never
        // receives a byte. Measured before this existed — a one-file request
        // wrote Assets/Scripts/Board.cs into
        // <tmp>/strada-workspaces/task-<id>/ and it was deleted on release.
        await Promise.resolve()
          .then(() => managedWorkspaceLease.commit())
          .then((result) => {
            if (result.written.length > 0) {
              getLogger().info("Workspace lease committed", {
                files: result.written.length,
                conflicts: result.conflicts.length,
              });
            }
            if (result.conflicts.length > 0) {
              // Not silent: the agent's version of these files is about to be
              // deleted, and the user needs to know their edit won the race.
              getLogger().warn("Workspace lease had conflicting files — source kept, agent copy discarded", {
                conflicts: result.conflicts.slice(0, 20),
              });
            }
          })
          .catch((err) => {
            getLogger().error("Workspace lease commit failed — agent work discarded", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        await managedWorkspaceLease.release().catch((err) => {
          getLogger().warn("Workspace lease release failed", { error: err instanceof Error ? err.message : String(err) });
        });
      }
    }
  }

  private async executeTask(entry: QueueEntry): Promise<void> {
    const { task, signal, onProgress, externalSignal } = entry;
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
    // Whole-goal monitor unit: a task submitted as a sub-goal of a parent goal carries
    // the parent's monitorScope, so its monitor events JOIN the parent episode (one
    // workspace per whole goal) rather than minting a sibling conversation. A normal
    // top-level task (no override, or override === own scope) is its own whole-goal
    // root and owns episode create + terminal. MONITOR-only — task chatId/session/
    // identity are unchanged.
    const monitorScope = task.monitorScope?.trim() || undefined;
    const isMonitorRootRun = !monitorScope || monitorScope === conversationScope;

    // Monitor lifecycle: emit simple DAG so monitor workspace always shows something
    if (isMonitorRootRun) {
      this.monitorLifecycle?.requestStart(conversationScope, task.prompt);
    } else {
      this.monitorLifecycle?.joinEpisode(conversationScope, task.prompt, monitorScope);
    }

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
          // Watchdog abort -> emit a terminal so the answer is not silently lost
          // (BUG#7); a genuine /cancel stays silent.
          if (this.settleWatchdogAbortIfHung(task, externalSignal)) {
            requestFailed = true;
          }
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
        if (this.settleWatchdogAbortIfHung(task, externalSignal)) {
          requestFailed = true;
        }
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
        // Already cancelled -- don't overwrite the cancelled status. But if the
        // INACTIVITY watchdog (not a user /cancel) aborted, emit a terminal so the
        // result isn't silently dropped and the task isn't stuck "executing" (BUG#7).
        if (this.settleWatchdogAbortIfHung(task, externalSignal)) {
          requestFailed = true;
        }
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
        // The run threw because it was aborted. A user /cancel stays silent; the
        // inactivity watchdog emits a "no progress" terminal so the answer isn't
        // silently lost and the task doesn't hang "executing" (BUG#7). The raw
        // abort error (e.g. "This operation was aborted") is deliberately NOT
        // surfaced to the user here.
        if (this.settleWatchdogAbortIfHung(task, externalSignal)) {
          requestFailed = true;
        }
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
      // Commit BEFORE release — release() deletes the lease directory. This is
      // the task-scoped lease, the one a normal CLI request actually takes; the
      // delegated-run lease below has the same pairing. Missing it here made
      // the whole lease write-only: the agent edited a temp copy, verified it,
      // reported success, and the project never received a byte.
      //
      // Commits UNCONDITIONALLY, including on abort and failure. A `!aborted`
      // guard was tried and reverted: the stall detector aborts a task that
      // stopped making progress, and measured on a real run that had already
      // written 13 files, the guard threw all of them away. "The user said
      // stop" and "a watchdog gave up" are not the same thing, and the executor
      // cannot cheaply tell them apart here.
      //
      // The asymmetry decides it. Publishing work the user did not want leaves
      // files they can read and delete — recoverable. Withholding work they did
      // want destroys it with no way back — not recoverable. Their own edits
      // are already protected by the conflict check, so publishing cannot
      // clobber anything of theirs.
      if (taskWorkspaceLease) {
        await Promise.resolve()
          .then(() => taskWorkspaceLease!.commit())
          .then((result) => {
            if (result.written.length > 0) {
              getLogger().info("Task workspace committed", {
                files: result.written.length,
                conflicts: result.conflicts.length,
              });
            }
            if (result.conflicts.length > 0) {
              getLogger().warn("Task workspace had conflicting files — project kept, agent copy discarded", {
                conflicts: result.conflicts.slice(0, 20),
              });
            }
          })
          .catch((err) => {
            getLogger().error("Task workspace commit failed — agent work discarded", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
      await taskWorkspaceLease?.release().catch((err) => {
        getLogger().warn("Task workspace lease release failed", { error: err instanceof Error ? err.message : String(err) });
      });
      // A root task marks its episode terminal; a re-scoped sub-goal task settles ONLY
      // its joined card (joinEpisodeEnd) so it never prematurely terminates the shared
      // parent episode — the whole-goal episode stays open until the ROOT settles.
      if (isMonitorRootRun) {
        this.monitorLifecycle?.requestEnd(conversationScope, requestFailed);
      } else {
        this.monitorLifecycle?.joinEpisodeEnd(conversationScope, requestFailed, monitorScope);
      }
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
