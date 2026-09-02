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
  TaskUsageEvent,
} from "./types.js";
import { getTaskConversationKey, TaskStatus } from "./types.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ITaskManager, IOrchestrator, SupervisorAdmissionDecision } from "./orchestrator-contract.js";
import { resolveConversationScope } from "../agents/orchestrator-text-utils.js";
import { subscribeTaskLiveness } from "../agents/liveness-hub.js";
import { deriveTestVerdict } from "./test-verdict.js";
function getLoggerSafe() {
  try {
    // Lazy require-free import chain: use the shared logger.
    return getLogger();
  } catch {
    return console;
  }
}

import type { GoalDecomposer } from "../goals/goal-decomposer.js";
import type { GoalNode, GoalTree } from "../goals/types.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import { buildGoalNarrativeFeedback } from "../goals/goal-feedback.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { DaemonEventMap } from "../daemon/daemon-events.js";
import { estimateCostWithCache } from "../budget/cost-model.js";
import type { BudgetTracker } from "../daemon/budget/budget-tracker.js";
import type { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
import { getLogger } from "../utils/logger.js";
import { summariseNodeOutcomes } from "./node-outcome-summary.js";
import { decideAutoResume, type AutoResumeState , decideMissionKeepAlive } from "./auto-resume.js";

// Shared outage measurement (also used by goal auto-resume and campaign
// self-revival); re-exported so existing importers keep their path.
export { setLiveChainMemberNames } from "../agents/providers/provider-outage.js";
import { allProvidersCoolingDownMs as sharedAllProvidersCoolingDownMs } from "../agents/providers/provider-outage.js";
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
import { terminalMessage } from "./terminal-message.js";

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
  /** Project root for post-delivery milestone integration (merge to current branch). */
  projectPath?: string;
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
  /**
   * Abort controllers for IN-FLIGHT executions, keyed by task id.
   *
   * The reaper and shutdown need a lever that settles the execution itself:
   * writing `failed` to the DB alone never released the concurrency slot or
   * the per-chat lock, so one wedged task per chat blacklisted that chat and
   * N wedged tasks starved the whole queue until process restart. Aborting
   * here lets executeTask settle and its `.finally` free everything.
   */
  private readonly inflight = new Map<string, AbortController>();
  /**
   * taskId → live workspace path, recorded at lease acquisition. Failed tool
   * calls register as "progress", so a task whose workspace directory was
   * deleted under it never trips the inactivity-based reaper — measured
   * 2026-08-27: a Sprint C task flailed for 40+ minutes against a lease dir
   * that no longer existed, every call rejected by the path guard. The
   * reaper sweeps this map and settles lost workspaces by name.
   */
  private readonly inflightWorkspacePaths = new Map<string, string>();
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
  private readonly projectPath?: string;

  constructor(opts: BackgroundExecutorOptions) {
    // Stuck-task reaper: an executing task with no progress signal for an hour
    // is wedged (bridge flap, dead provider, lost lease). Reap it so the queue
    // advances; user-origin missions resubmit via mission keep-alive. Measured
    // 2026-08-24: a task sat 'executing' for 1h+ while the queue starved.
    const reaper = setInterval(() => {
      try {
        this.reapStuckTasks();
        this.reapLostWorkspaces();
      } catch {
        // The reaper must never become the crash it guards against.
      }
    }, 5 * 60_000);
    reaper.unref?.();
    this.orchestrator = opts.orchestrator;
    this.concurrencyLimit = opts.concurrencyLimit ?? 3;
    this.projectPath = opts.projectPath;
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
    this.scheduleKeepAliveRearm();
  }

  /**
   * Re-arm mission keep-alives that died with the previous process.
   *
   * The keep-alive is a setTimeout: a task blocked with "Auto-retry N/10 in
   * ~Xs" holds a PROMISE whose timer lives only in that process. Measured
   * 2026-08-29: a mission blocked at 01:01 on an 8-hour provider cooldown was
   * never resumed after the 01:05 restart — the new process had no timer, and
   * only the campaign layer's own revive path saved the mission. Standalone
   * missions have no such second chance.
   *
   * Delayed 90s so startup recovery (campaign resume, queue replay) claims its
   * tasks first; the keep-alive's fire-time dedup skips any mission that is
   * already continuing under a fresh task id.
   */
  private scheduleKeepAliveRearm(): void {
    const timer = setTimeout(() => {
      try {
        const manager = this.taskManager as (ITaskManager & {
          listRecoverableTasks?: (limit?: number) => Array<Task>;
        }) | null;
        const candidates = manager?.listRecoverableTasks?.(50) ?? [];
        const seenLineages = new Set<string>();
        // Dedupe by the mission's PROMPT identity too, not only lineage id:
        // every campaign revive minted a fresh lineage for the same sprint,
        // and re-arming all of them with the same cooldown floor made them
        // fire in the same tick — each passed the alreadyContinued check
        // before the others had submitted (measured 2026-08-29 20:11:33,
        // three duplicate sprint missions). One re-arm per prompt root,
        // newest lineage wins, staggered so survivors can see each other.
        const seenPromptRoots = new Set<string>();
        // One re-arm per CHAT: replay-prefaced lineage roots defeat the
        // prompt-root compare (measured 2026-08-30 10:07 — three "distinct"
        // roots were the same sprint under different retry prefaces). A chat
        // is a serialized conversation; more than one re-armed mission per
        // chat is definitionally duplicate work.
        const seenChats = new Set<string>();
        const sorted = [...candidates].sort(
          (a, b) => ((b as { updatedAt?: number }).updatedAt ?? 0) - ((a as { updatedAt?: number }).updatedAt ?? 0),
        );
        let rearmIndex = 0;
        for (const task of sorted) {
          if (task.status !== "blocked" || task.origin !== "user") continue;
          const result = String((task as { result?: unknown }).result ?? "");
          // The attempt count is right there in the text this regex matches.
          // Audited 2026-09-02: it was used only as a boolean, and missionRetries
          // is an in-memory Map that died with the process — so every restart
          // re-armed the mission at attempt 0: a fresh ten-retry budget and the
          // backoff back at its 30s floor, making MAX_MISSION_RETRIES unenforceable.
          const marker = /Auto-retry (\d+)\/\d+ in ~\d+s/.exec(result);
          if (!marker) continue;
          // An escalated mission is waiting on a PERSON. Re-arming it would
          // silently withdraw the escalation and overwrite its notice.
          if (/MISSION STOPPED/.test(result)) {
            getLoggerSafe().info("Keep-alive re-arm skipped — mission already escalated to a person", {
              taskId: task.id,
            });
            continue;
          }
          const persistedAttempt = Number(marker[1]);
          const lineage = this.lineageRootTaskId(task);
          if (seenLineages.has(lineage)) continue;
          seenLineages.add(lineage);
          const root = this.taskManager?.getStatus(lineage) as { prompt?: string } | null;
          const promptRoot = (root?.prompt ?? task.prompt).slice(0, 160);
          if (seenChats.has(task.chatId)) {
            getLoggerSafe().info("Keep-alive re-arm skipped — chat already has a re-armed mission", {
              taskId: task.id,
            });
            continue;
          }
          if (seenPromptRoots.has(promptRoot)) {
            getLoggerSafe().info("Keep-alive re-arm skipped — same mission already re-armed under a newer lineage", {
              taskId: task.id,
            });
            continue;
          }
          seenPromptRoots.add(promptRoot);
          seenChats.add(task.chatId);
          getLoggerSafe().info("Re-arming keep-alive orphaned by restart", {
            taskId: task.id,
            lineageRoot: lineage,
            staggerMs: rearmIndex * 45_000,
          });
          const staggerMs = rearmIndex * 45_000;
          rearmIndex += 1;
          // Resume the count where the previous process left it, so the
          // backoff continues from its cap and the tenth retry still escalates.
          const key = `mission:${lineage}`;
          this.missionRetries.set(key, Math.max(this.missionRetries.get(key) ?? 0, persistedAttempt));
          if (staggerMs === 0) {
            this.scheduleMissionKeepAlive(task, "keep-alive re-armed after restart");
          } else {
            const t = setTimeout(
              () => this.scheduleMissionKeepAlive(task, "keep-alive re-armed after restart"),
              staggerMs,
            );
            t.unref?.();
          }
        }
      } catch {
        // Recovery is best-effort; a failure here must not affect boot.
      }
    }, 90_000);
    timer.unref?.();
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

  /**
   * Shut down the executor: settle in-flight work, clear the queue, release
   * all workspace leases.
   */
  async shutdown(): Promise<void> {
    const logger = getLogger();
    logger.info("[BackgroundExecutor] Shutting down", {
      queueSize: this.queue.length,
      activeConversations: this.activeConversations.size,
    });

    // Abort in-flight executions FIRST and give them a bounded window to
    // settle. Each executeTask's finally commits its workspace lease — tearing
    // the leases down while agents still ran deleted their cwd mid-write, and
    // the later commit found nothing left to commit. Graceful shutdown was a
    // work-shredder for every task caught running.
    for (const controller of this.inflight.values()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error("shutting down"));
      }
    }
    const settleDeadline = Date.now() + 10_000;
    while (this.running > 0 && Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.running > 0) {
      logger.warn("[BackgroundExecutor] In-flight tasks did not settle in time — their leases will be committed as-is", {
        running: this.running,
      });
    }

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
  private settleWatchdogAbortIfHung(
    task: Task,
    externalSignal: AbortSignal | undefined,
    abortReason?: unknown,
  ): boolean {
    // A genuine external cancel: the user asked to stop. Stay silent.
    if (!externalSignal || externalSignal.aborted) {
      return false;
    }
    if (!this.taskManager) {
      return false;
    }
    // A REAPER abort: the reaper already wrote the honest terminal (fail +
    // the keep-alive's "Auto-retry N/10" marker) before the abort rejected
    // this run. Audited 2026-09-02: this path then block()ed "The task was
    // stopped before it finished (Reaped: …)" over that marker — the restart
    // re-arm no longer matched the row, and the retry prompt quoted reaper
    // machinery as the "last known checkpoint". The terminal is written; the
    // run still counts as failed for the monitor.
    if (this.reapedInflight.delete(String(task.id))) {
      getLogger().info("Reaped task settled — the reaper's terminal stands, watchdog terminal withheld", {
        taskId: task.id,
        reason: abortReason instanceof Error ? abortReason.message : String(abortReason ?? ""),
      });
      return true;
    }

    // The combined signal aborted for a reason that is not the user. That is
    // USUALLY the inactivity watchdog, but this branch used to assert it
    // unconditionally and tell the user their task "made no progress" — advice
    // to split the request that is actively wrong when the cause was something
    // else. Measured on a real run: the task executed a tool and two LLM calls
    // in the four seconds before it was blocked, and its last progress update
    // was 2.5 minutes earlier, well inside the 10-minute inactivity window.
    //
    // The reason is now logged (nothing recorded it before, which is why that
    // run could not be explained) and the message only claims stalling when the
    // abort really came from the inactivity timer.
    const reasonText = abortReason instanceof Error ? abortReason.message : String(abortReason ?? "");
    const stalled = /made no progress/i.test(reasonText);
    getLogger().warn("Task aborted without a user cancel", {
      taskId: task.id,
      reason: reasonText || "(no reason recorded)",
      classifiedAs: stalled ? "inactivity-watchdog" : "other",
    });

    const isTurkish = TURKISH_HINT_RE.test(task.prompt);
    const message = stalled
      ? (isTurkish
        ? "Görev ilerleme kaydetmeden takıldı, bu yüzden durduruldu. Lütfen tekrar deneyin ya da isteği daha küçük adımlara bölün."
        : "The task stalled without making progress, so it was stopped. Please try again or break the request into smaller steps.")
      : (isTurkish
        ? `Görev tamamlanmadan durduruldu${reasonText ? ` (${reasonText})` : ""}. Yapılan değişiklikler korundu.`
        : `The task was stopped before it finished${reasonText ? ` (${reasonText})` : ""}. Any changes it made have been kept.`);
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
        onLiveness?: () => void;
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
      // Every supervisor node transition re-arms the inactivity watchdog. The
      // path otherwise only reports at planning milestones, so a wave running
      // tools for twenty minutes looked identical to a hung task.
      onLiveness: () => onProgress({ kind: "heartbeat", message: "" } as TaskProgressUpdate),
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
      this.inflight.set(entry.task.id, timeoutController);
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
          this.inflight.delete(entry.task.id);
          // A reaped run that never reached the watchdog settle (e.g. it
          // completed on its own after the abort) must not leave a stale mark.
          this.reapedInflight.delete(String(entry.task.id));
          this.inflightWorkspacePaths.delete(String(entry.task.id));
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
    if (shouldReleaseLease && managedWorkspaceLease) {
      this.inflightWorkspacePaths.set(String(params.taskRunId), managedWorkspaceLease.path);
    }

    try {
      return await this.executeWorkerRun(orchestrator, {
        ...params,
        workspaceLease: managedWorkspaceLease,
        workspaceLeaseRetained: !shouldReleaseLease,
      });
    } finally {
      if (shouldReleaseLease && managedWorkspaceLease) {
        this.inflightWorkspacePaths.delete(String(params.taskRunId));
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
                deletionsDeclined: result.removed.length,
              });
            }
            if (result.removed.length > 0) {
              getLogger().warn("Workspace lease deletions were not applied — the source keeps files the agent removed", {
                count: result.removed.length,
                removed: result.removed.slice(0, 20),
              });
            }
            if (result.conflicts.length > 0) {
              // Not silent: the agent's version of these files used to be
              // deleted with the workspace; it is now preserved under
              // .strada/lease-conflicts so nothing is lost to a race.
              getLogger().warn("Workspace lease had conflicting files — source kept, agent copy quarantined", {
                conflicts: result.conflicts.slice(0, 20),
                quarantinedUnder: result.conflictsQuarantinedUnder,
              });
            }
            if (result.failed.length > 0) {
              getLogger().warn("Workspace lease commit could not process some files", {
                count: result.failed.length,
                failed: result.failed.slice(0, 20),
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
    // Every tool execution re-arms the inactivity window. `onProgress` here is
    // the wrapped one, so the heartbeat re-arms the watchdog and is filtered
    // before it can reach the user as a message.
    taskOrchestrator.setLivenessCallback?.(() =>
      onProgress({ kind: "heartbeat", message: "" } as TaskProgressUpdate),
    );
    // setLivenessCallback only covers the singleton's own tool path. A wave's
    // tools run on worker orchestrator instances (agent-manager, delegation)
    // whose slot is never set; the hub relays their activity by chatId.
    // Measured 2026-08-29: two campaign tasks reaped at exactly 60min with
    // zero heartbeats while workers ran tools the whole time.
    const unsubscribeLiveness = subscribeTaskLiveness(task.chatId, () => {
      try {
        this.taskManager?.touch?.(task.id);
      } catch { /* liveness must never break the run */ }
    });
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
        task.workspacePolicy !== "none" &&
        (shouldAttemptSharedPlanning || (!hasRichInput && shouldDecomposeTask));
      if (shouldUseTaskWorkspace && this.workspaceLeaseManager) {
        taskWorkspaceLease = await this.workspaceLeaseManager.acquireLease({
          label: `task-${task.id}`,
          workerId: String(task.id),
        });
        this.inflightWorkspacePaths.set(String(task.id), taskWorkspaceLease.path);
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
          if (this.settleWatchdogAbortIfHung(task, externalSignal, signal.reason)) {
            requestFailed = true;
          }
          return;
        }

        // The settle logging on the worker path did not cover this one, and
        // this is the path a supervised run takes. Measured 2026-08-21: a run
        // whose agent wrote "I got blocked so we can move forward together"
        // was recorded completed, failed:false, and nothing said which node
        // reported what.
        getLogger().info("Task settling", {
          taskId: task.id,
          route: "supervisor",
          success: supervisorResult.success,
          partial: supervisorResult.partial,
          nodes: supervisorResult.totalNodes,
          succeeded: supervisorResult.succeeded,
          failed: supervisorResult.failed,
          // Read beside `failed`, which includes these: a node that stopped on
          // a question and a node that hit a compiler error both landed in the
          // same number, and they call for opposite responses.
          blocked: supervisorResult.blocked,
          skipped: supervisorResult.skipped,
          // The tally says how many; this says which, and why. Without it a run
          // that ends "4 of 5 failed" cannot be acted on at all.
          outcomes: summariseNodeOutcomes(supervisorResult.nodeResults),
        });

        try {
          // Mechanical test verdict from what the tools actually printed —
          // rides on the Task row so settle-side consumers (campaign green
          // gate) stop judging prose.
          const verdict = deriveTestVerdict(
            supervisorResult.nodeResults.flatMap((n) =>
              n.toolResults.map((tr) => ({ content: String(tr.content ?? ""), isError: tr.isError })),
            ),
          );
          if (verdict.testsGreen !== undefined) {
            (this.taskManager as { setVerification?: (id: string, v: typeof verdict) => void })
              .setVerification?.(task.id, verdict);
          }
        } catch { /* verdict carriage is best-effort */ }
        try {
          const touched = [...new Set(
            supervisorResult.nodeResults.flatMap((n) => n.artifacts.map((a) => a.path)),
          )];
          this.devKnowledgeCompletionHook?.({
            goal: task.prompt,
            success: supervisorResult.success,
            reason: supervisorResult.success ? undefined : `nodes failed:${supervisorResult.failed} blocked:${supervisorResult.blocked}`,
            taskRunId: task.id,
            touchedFiles: touched,
            iterationsUsed: supervisorResult.totalNodes,
            errorCount: supervisorResult.failed + supervisorResult.blocked,
          });
        } catch { /* note write is best-effort */ }

        if (supervisorResult.success) {
          this.taskManager.complete(task.id, supervisorResult.output);
          // Delivery includes INTEGRATION: worktree workers cannot merge to
          // main (the source worktree owns the ref), so the executor does it
          // here, at the source root, after a successful run. Measured
          // 2026-08-24: milestone branches piled up unmerged and the user had
          // to ask why the system "didn't merge it itself".
          this.integrateMilestoneBranches(task);
          return;
        }
        if (supervisorResult.partial) {
          requestFailed = true;
          this.taskManager.block(task.id, supervisorResult.output);
          if (!admission.supervisorGoalTree?.rootId) {
            // No tree ever formed — decomposition itself failed (measured
            // 2026-08-26: an all-provider cooldown storm failed the planning
            // LLM call, the task settled partial with zero nodes, and parked
            // forever: no tree to resume, and this return path never reached
            // the mission keep-alive). A planning-stage outage is a
            // mission-level retry, on the slow clock.
            if (this.scheduleMissionKeepAlive(task, supervisorResult.output || "supervisor run failed before planning")) {
              return;
            }
          }
          this.autoResumeBlockedGoal(
            task,
            admission.supervisorGoalTree,
            supervisorResult.succeeded,
            summariseNodeOutcomes(supervisorResult.nodeResults),
          );
          return;
        }
        // Mission keep-alive BEFORE terminal fail: only budget/cap may stop a
        // user-origin mission; provider blinks and node failures feed back in.
        if (this.scheduleMissionKeepAlive(task, supervisorResult.output || "supervisor run failed")) {
          return;
        }
        requestFailed = true;
        this.taskManager.fail(task.id, supervisorResult.output);
        return;
      }

      if (signal.aborted) {
        if (this.settleWatchdogAbortIfHung(task, externalSignal, signal.reason)) {
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
        if (this.settleWatchdogAbortIfHung(task, externalSignal, signal.reason)) {
          requestFailed = true;
        }
        return;
      }

      // How a run ended is the one thing a caller needs to decide whether the
      // work is done — and it was never written down. Measured 2026-08-20: a
      // run whose provider stopped responding was recorded "Task completed",
      // and the log held nothing to say whether that came from a worker
      // reporting success or from the fallthrough below.
      getLogger().info("Task settling", {
        taskId: task.id,
        workerStatus: result.workerResult?.status ?? "(no worker result)",
        reason: result.workerResult?.reason ?? "(none)",
        outputLength: result.output?.length ?? 0,
      });

      try {
        const verdict = deriveTestVerdict(
          (result.workerResult?.toolTrace ?? []).map((t) => ({ content: t.summary, isError: !t.success })),
        );
        if (verdict.testsGreen !== undefined) {
          (this.taskManager as { setVerification?: (id: string, v: typeof verdict) => void })
            .setVerification?.(task.id, verdict);
        }
      } catch { /* verdict carriage is best-effort */ }
      try {
        this.devKnowledgeCompletionHook?.({
          goal: task.prompt,
          success: result.workerResult ? result.workerResult.status === "completed" : true,
          reason: result.workerResult?.reason,
          taskRunId: task.id,
          touchedFiles: result.workerResult?.touchedFiles ?? [],
          iterationsUsed: result.workerResult?.toolTrace?.length ?? 0,
          errorCount: result.workerResult?.status === "completed" ? 0 : 1,
        });
      } catch { /* note write is best-effort */ }

      if (result.workerResult && result.workerResult.status === "failed") {
        // Mission keep-alive BEFORE terminal fail, exactly as the supervisor
        // branch does. Audited 2026-09-02: this direct-worker branch went
        // straight to fail(), so a provider blink on a mission admitted
        // direct_worker (busy/low_complexity/supervisor_error) killed it dead —
        // a "failed" row is invisible to both reapers and the restart re-arm.
        if (this.scheduleMissionKeepAlive(task, result.workerResult.reason ?? result.output ?? "worker failed")) {
          return;
        }
        requestFailed = true;
        this.taskManager.fail(
          task.id,
          terminalMessage(result.workerResult.reason, result.output, "Task failed"),
        );
        return;
      }

      if (result.workerResult && result.workerResult.status === "blocked") {
        requestFailed = true;
        this.taskManager.block(
          task.id,
          terminalMessage(result.workerResult.reason, result.output, "Task blocked"),
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
        if (this.settleWatchdogAbortIfHung(task, externalSignal, signal.reason)) {
          requestFailed = true;
        }
        return;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      const sanitizedErrMsg = sanitizeSecrets(errMsg);
      logger.error("Background task execution error", { taskId: task.id, error: sanitizedErrMsg });
      // The goal tree of the run that threw is failed FIRST — same order as
      // the non-throwing supervisor path — so a keep-alive retry never leaves
      // a tree marked executing in goalStorage with no goal:failed emitted
      // (review of ecdb7691, 2026-09-02). The retry builds its own tree.
      if (activeGoalTree) {
        this.failGoalExecution(task, activeGoalTree, errMsg, 0);
      } else if (task.goalTree) {
        this.failGoalExecution(task, task.goalTree, errMsg, 0);
      }
      // A thrown run ("All providers are in cooldown", a runner throw) is the
      // same transient the supervisor branch feeds back into the keep-alive.
      // Audited 2026-09-02: it went to a bare fail() here, route-independent.
      if (this.scheduleMissionKeepAlive(task, sanitizedErrMsg)) {
        return;
      }
      requestFailed = true;
      this.taskManager.fail(task.id, sanitizedErrMsg);
    } finally {
      unsubscribeLiveness();
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
                // A commit that adds 15 files and silently declines 18 deletions
                // is not the clean success "files: 15, conflicts: 0" reads as.
                // Measured 2026-08-21: an agent deleted a duplicate interface it
                // had just resolved, the deletion was declined, and the next run
                // opened on 25 CS0101 errors it had already fixed once.
                deletionsDeclined: result.removed.length,
              });
            }
            if (result.removed.length > 0) {
              getLogger().warn("Task workspace deletions were not applied — the project keeps files the agent removed", {
                count: result.removed.length,
                removed: result.removed.slice(0, 20),
              });
            }
            if (result.conflicts.length > 0) {
              getLogger().warn("Task workspace had conflicting files — project kept, agent copy quarantined", {
                conflicts: result.conflicts.slice(0, 20),
                quarantinedUnder: result.conflictsQuarantinedUnder,
              });
            }
            if (result.failed.length > 0) {
              getLogger().warn("Task workspace commit could not process some files", {
                count: result.failed.length,
                failed: result.failed.slice(0, 20),
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

  private buildUsageRecorder(task: Task): ((usage: TaskUsageEvent) => void) | undefined {
    if (!this._unifiedBudgetManager && !this.daemonBudgetTracker) {
      return undefined;
    }

    return (usage) => {
      // Cache-aware pricing: the cached share of the prompt is billed at a
      // fraction of the input rate (Anthropic reads 0.1x, OpenAI 0.5x), and
      // `model` is the CONCRETE model id when routing knows it — attributing
      // spend to the provider name made per-model costs wrong by construction.
      const costUsd = estimateCostWithCache(usage, usage.provider);
      if (costUsd <= 0) {
        return;
      }
      const model = usage.model ?? usage.provider;
      if (this._unifiedBudgetManager) {
        const source = task.origin === "daemon" ? "daemon" : "chat";
        this._unifiedBudgetManager.recordCost(costUsd, source, {
          model,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          triggerName: task.triggerName,
        });
        return;
      }
      this.daemonBudgetTracker?.recordCost(costUsd, {
        model,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        triggerName: task.triggerName,
      });
    };
  }

  /** Automatic resumes spent per goal root, with the progress each round reached. */
  private readonly autoResumeState = new Map<string, AutoResumeState>();

  /** Mission-level retries spent per chat+prompt chain (survives tree-less failures). */
  private readonly missionRetries = new Map<string, number>();

  /**
   * Task ids a reaper aborted THIS tick. The reaper writes the honest terminal
   * (fail + the keep-alive's "Auto-retry N/10" block) synchronously; the
   * aborted run then rejects on a later microtask and reaches executeTask's
   * catch, whose watchdog settle used to block() a second, weaker terminal
   * over the marker (audited 2026-09-02). The settle consumes the entry and
   * stands down.
   */
  private readonly reapedInflight = new Set<string>();

  /** Settlement hook for the dev-knowledge completion note. The route-level
   *  call sites fire when a background task is merely SUBMITTED (planner
   *  state empty → real-work gate rejects), so the one useful note type never
   *  wrote once while the useless verdict notes wrote 213 times. Settlement
   *  is where the run's real outcome lives. */
  private devKnowledgeCompletionHook?: (params: {
    goal: string;
    success: boolean;
    reason?: string;
    taskRunId?: string;
    touchedFiles: readonly string[];
    iterationsUsed: number;
    errorCount: number;
  }) => void;

  setDevKnowledgeCompletionHook(hook: NonNullable<BackgroundExecutor["devKnowledgeCompletionHook"]>): void {
    this.devKnowledgeCompletionHook = hook;
  }

  /**
   * Mission keep-alive: a failed supervisor run on a USER-origin mission is
   * resubmitted automatically on an exponential backoff until it succeeds,
   * the budget runs out, or the retry cap is hit — whichever comes first.
   * Every state change is announced on the channel; the final escalation is
   * a visible report naming the blocker, never a silent row.
   * Returns true when a retry was scheduled (caller must NOT also fail()).
   */
  /**
   * Merge delivered milestone/feature branches into the current branch at the
   * source root. Best-effort: a conflicted or non-fast history is left for the
   * person, with the conflict named in the log — never silently dropped.
   */
  private integrateMilestoneBranches(task: Task): void {
    const root = this.projectPath;
    if (!root) return;
    try {
      const run = (args: string[]): string =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 30_000 });
      const current = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      const branches = run(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => /^(milestone|feature)\//.test(b) && b !== current);
      for (const branch of branches) {
        // `merge-base --is-ancestor` answers with its EXIT CODE: 0 = already
        // integrated, 1 = not an ancestor = the branch that needs merging.
        // execFileSync throws on any non-zero exit, and this line sat one line
        // BEFORE the per-branch try — so every branch that needed merging threw
        // past the loop into the outer catch, `git merge` below was unreachable,
        // and the failure logged at DEBUG. Audited 2026-09-02: 100% of
        // deliveries left their milestone branch unmerged.
        const probe = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", branch, current], {
          encoding: "utf8",
          timeout: 30_000,
        });
        if (probe.status === 0) continue;
        if (probe.status !== 1) {
          // Not "unmerged" but "could not tell" — say so rather than merging blind.
          getLoggerSafe().warn("Milestone branch merge state could not be determined", {
            branch, task: task.id, status: probe.status, error: (probe.stderr || probe.error?.message || "").slice(0, 200),
          });
          continue;
        }
        try {
          // No `-X ours`: it resolved every conflicting hunk in favour of the
          // current branch and then logged "Integrated" — a full integration
          // claimed while the milestone's side was silently discarded. A real
          // conflict now fails into the manual-integration path below.
          run(["merge", "--no-ff", branch, "-m", `integrate ${branch} (post-delivery)`]);
          getLoggerSafe().info("Integrated delivered milestone branch", { branch, task: task.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          getLoggerSafe().warn("Milestone branch needs manual integration (conflict)", {
            branch, task: task.id, error: msg.slice(0, 200),
          });
          try {
            run(["merge", "--abort"]);
          } catch { /* nothing to abort */ }
        }
      }
    } catch (e) {
      // This used to be a DEBUG "skipped" — invisible at the default log level
      // while delivered work stayed stranded. A failure here is a failure.
      getLoggerSafe().warn("Milestone integration failed — delivered branches may be left unmerged", {
        task: task.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Settle tasks whose workspace directory no longer exists. The
   * inactivity-based reaper cannot catch these: every rejected tool call
   * still registers as progress, so a task flailing against a deleted lease
   * looks busy forever (measured 2026-08-27: 40+ minutes of path-guard
   * rejections on a Sprint C task whose lease dir had vanished). Failing
   * with the honest cause routes through mission keep-alive, which
   * resubmits onto a fresh workspace.
   */
  private reapLostWorkspaces(): void {
    if (!this.taskManager) return;
    for (const [taskId, workspacePath] of [...this.inflightWorkspacePaths]) {
      if (existsSync(workspacePath)) continue;
      const reason = `workspace directory is gone: ${workspacePath}`;
      getLoggerSafe().warn("Reaping task whose workspace vanished", { taskId, workspacePath });
      this.inflightWorkspacePaths.delete(taskId);
      try {
        const controller = this.inflight.get(taskId);
        if (controller && !controller.signal.aborted) {
          this.reapedInflight.add(String(taskId));
          controller.abort(new Error(`Reaped: ${reason}.`));
        }
        this.taskManager.fail(taskId, `Reaped: ${reason}.`);
      } catch { /* already settled */ }
      const task = this.taskManager.getStatus(taskId);
      if (task) {
        this.scheduleMissionKeepAlive(task as Task, reason);
      }
    }
  }

  /** Executing tasks whose last progress is older than this are considered wedged. */
  private static readonly STUCK_TASK_MS = 60 * 60_000;

  private reapStuckTasks(): void {
    if (!this.taskManager) return;
    const stuck = (this.taskManager.listStuckExecuting?.(BackgroundExecutor.STUCK_TASK_MS) ?? []) as ReadonlyArray<
      import("./types.js").Task
    >;
    for (const task of stuck) {
      const reason = `no progress signal for ${Math.round(BackgroundExecutor.STUCK_TASK_MS / 60_000)} minutes`;
      getLoggerSafe().warn("Reaping stuck executing task", { taskId: task.id, reason });
      // Queue continuation first: if more work for this chat is already
      // waiting, do not resubmit — the pending task IS the continuation.
      const hasPending = (this.taskManager.listTasks(task.chatId, 10) ?? []).some(
        (t) => t.status === "pending",
      );
      try {
        // Abort the execution FIRST so the promise settles and its `.finally`
        // releases the slot + conversation lock. `fail()` alone only flipped
        // the DB row: the wedged task kept running, `running` stayed elevated
        // forever, and every later task for that chat was starved.
        const controller = this.inflight.get(task.id);
        if (controller && !controller.signal.aborted) {
          // Mark BEFORE aborting: the settle path reads this on the microtask
          // the abort rejection lands on, and must find the reaper's terminal
          // already written rather than write its own over it.
          this.reapedInflight.add(String(task.id));
          controller.abort(new Error(`Reaped: ${reason}.`));
        }
        this.taskManager.fail(task.id, `Reaped: ${reason}.`);
      } catch { /* already settled */ }
      if (!hasPending) {
        this.scheduleMissionKeepAlive(task, reason);
      }
    }
  }

  private scheduleMissionKeepAlive(task: Task, reason: string): boolean {
    if (!this.taskManager || task.origin !== "user") return false;
    // An ask_user block is a QUESTION awaiting a person, not a failure to
    // retry. Auto-resubmitting would re-ask the same question into the void
    // (measured 2026-08-24): deliver it to the channel and wait.
    if (/ask_user/i.test(reason)) {
      const gateAsk = /gate|repeated|health/i.test(reason);
      const message = gateAsk
        ? "Paused after repeated failures. Reply with guidance (what to change or try) and the work continues from that point."
        : "Paused on a question for you. Reply here with your answer and the work continues from that exact point.";
      try {
        this.taskManager.appendTaskNotice(task.id, message);
      } catch { /* visibility best-effort */ }
      return false;
    }
    // Key on the retry lineage's ROOT id, which is stable across rounds. The
    // old key hashed the prompt — but every retry resubmits with a replay
    // preface prepended, so the key changed each round, the attempt counter
    // reset to 0 forever, and the backoff never grew past its floor. Measured
    // 2026-08-27 (PixelFlow): a fresh full decomposition every 30–60s for
    // twenty minutes, sixteen plan files deep, cap never reached.
    const key = `mission:${this.lineageRootTaskId(task)}`;
    const attempt = this.missionRetries.get(key) ?? 0;
    const budgetExceeded = this._unifiedBudgetManager?.isGlobalExceeded() ?? false;
    const decision = decideMissionKeepAlive(attempt, { budgetExceeded });

    if (decision.action === "report") {
      this.missionRetries.delete(key);
      try {
        this.taskManager.appendTaskNotice(
          task.id,
          `MISSION STOPPED — needs you. ${decision.reportReason} Last blocker: ${reason.slice(0, 200)}`,
        );
      } catch { /* visibility best-effort */ }
      // A BUDGET stop is a rolling-window condition, not a terminal one: the
      // 24h window drains and the money is back — but the stop used to be
      // one-shot, so a multi-day campaign that tripped the wall at hour 30
      // stayed stopped forever. Re-check hourly and resume when it clears.
      if (budgetExceeded) {
        const rearm = setTimeout(() => {
          try {
            if (this._unifiedBudgetManager?.isGlobalExceeded() ?? false) {
              this.scheduleMissionKeepAlive(task, reason); // still walled — re-checks again
              return;
            }
            getLoggerSafe().info("Budget window drained — resuming stopped mission", { taskId: task.id });
            this.taskManager?.retryTask(task.id);
          } catch { /* best-effort re-arm */ }
        }, 60 * 60_000);
        rearm.unref?.();
      }
      return false;
    }

    this.missionRetries.set(key, decision.attempt + 1);
    // A retry fired into an all-provider cooldown is a guaranteed burn: the
    // resubmitted task dies in its planning call before doing any work.
    // Measured overnight 2026-08-27: the keep-alive fed doomed decompositions
    // every 30–60s for over an hour while both providers sat cooled. When every
    // tracked provider is cooling, wait out the soonest recovery instead.
    const cooldownWaitMs = this.allProvidersCoolingDownMs();
    const effectiveBackoffMs = Math.max(decision.backoffMs, cooldownWaitMs);
    try {
      this.taskManager.block(
        task.id,
        `Transient failure — ${reason.slice(0, 160)}. Auto-retry ${decision.attempt + 1}/${10} in ~${Math.round(effectiveBackoffMs / 1000)}s.`,
      );
    } catch { /* block-marking is cosmetic here */ }
    const timer = setTimeout(() => {
      // Someone else may have already resubmitted this mission while the
      // backoff ran — the campaign layer reacts to the same settlement on its
      // own clock, and its grace window can expire before this timer fires
      // (measured live 2026-08-28 14:13: campaign resubmit at +90s, this
      // retry at +120s → two tasks writing the same sprint). An ACTIVE task
      // on this chat with the same prompt root IS the mission continuing;
      // a second copy only double-writes the repo.
      // Compare ROOT prompts, not raw prefixes: every replayed task starts
      // with the same 164-char retry preface, so a prefix compare matched all
      // retried missions to each other. The lineage root's prompt is the real
      // mission identity.
      const rootPromptOf = (t: { id: string; prompt: string }): string => {
        try {
          const rootId = (this.taskManager as { findLineageRootId?: (id: string) => string | null })
            .findLineageRootId?.(t.id);
          const root = rootId && rootId !== t.id ? this.taskManager?.getStatus?.(rootId) : null;
          return ((root as { prompt?: string } | null)?.prompt ?? t.prompt).slice(0, 160);
        } catch {
          return t.prompt.slice(0, 160);
        }
      };
      const promptRoot = rootPromptOf(task);
      const alreadyContinued = (this.taskManager?.listTasks?.(task.chatId, 10) ?? []).some(
        (t) =>
          t.id !== task.id &&
          ["pending", "planning", "executing"].includes(t.status) &&
          rootPromptOf(t) === promptRoot,
      );
      if (alreadyContinued) {
        this.missionRetries.delete(key);
        getLoggerSafe().info("Mission keep-alive retry skipped — the mission was already resubmitted elsewhere", {
          taskId: task.id,
        });
        return;
      }
      const retried = (() => {
        try {
          return this.taskManager?.retryTask(task.id);
        } catch {
          return null;
        }
      })();
      if (!retried) {
        this.missionRetries.delete(key);
        getLoggerSafe().warn("Mission keep-alive could not resubmit — escalated to report", { taskId: task.id });
        try {
          this.taskManager?.appendTaskNotice(task.id, `Auto-resubmit failed after backoff. Last blocker: ${reason.slice(0, 200)}`);
        } catch { /* best effort */ }
      }
    }, effectiveBackoffMs);
    timer.unref?.();
    getLoggerSafe().info("Mission keep-alive scheduled", {
      taskId: task.id, attempt: decision.attempt + 1, backoffMs: effectiveBackoffMs, reason: reason.slice(0, 120),
      ...(cooldownWaitMs > 0 ? { waitingOutProviderCooldownMs: cooldownWaitMs } : {}),
    });
    return true;
  }

  /**
   * Milliseconds until the soonest CURRENT provider-chain member's cooldown
   * expires — but only when every member is cooling (a retry has no one to
   * run on). Zero when anyone is available.
   *
   * Scoped to the current chain on purpose: the registry is a historical
   * graveyard (revoked keys from removed providers, aliases of the same
   * chain), and measuring against EVERY entry would wait forever on dead
   * providers nobody can run on. Measured overnight 2026-08-27: an OpenAI
   * 429-cooldown and an opencode 401-cooldown coexisted with a healthy
   * "chain" alias — the naive all-entries check read the alias as an escape
   * hatch and fired doomed retries anyway.
   */
  private allProvidersCoolingDownMs(): number {
    return sharedAllProvidersCoolingDownMs();
  }

  /**
   * The task at the root of a retry/replan lineage. retryGoalRoot and
   * replanGoalRoot both submit a new task with parentId set, so walking the
   * parent chain finds the mission the whole lineage belongs to — which is
   * what the auto-resume budget is actually bounded on.
   */
  private lineageRootTaskId(task: Task): string {
    let current: { id: string; parentId?: string } = task;
    for (let depth = 0; current.parentId && depth < 50; depth++) {
      const parent = this.taskManager?.getStatus(current.parentId) ?? null;
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  /**
   * Pick a partially-finished goal tree back up instead of leaving it blocked.
   *
   * Run 37 stopped here with four of five nodes unfinished and a person asleep.
   * prepareTreeForRetry keeps what completed and resets the rest, so a resume
   * costs only the work that failed. decideAutoResume holds the bounds.
   */
  private autoResumeBlockedGoal(
    task: Task,
    tree: { rootId: string } | undefined,
    succeeded: number,
    nodeOutcomes: readonly string[] = [],
  ): void {
    if (!tree?.rootId || !this.taskManager) return;
    const rootId = tree.rootId;

    // An ask_user block is a QUESTION awaiting a person, and neither replay nor
    // replan can answer it — the same prompt re-asks the same question into the
    // void. Worse, a replan mints a FRESH goal root, and the budget below is
    // keyed on rootId, so each replan resets the 3-resume/2-replan budget: the
    // loop becomes unbounded. Measured 2026-08-26: 35 blocked tasks at a ~23s
    // cadence on one goal lineage, burning provider calls until BOTH providers
    // sat in cooldown. The mission keep-alive has always refused to retry
    // ask_user for exactly this reason; the goal level now matches it.
    if (nodeOutcomes.some((outcome) => /ask_user/i.test(outcome))) {
      getLogger().warn("Goal paused on a question for the user — auto-resume skipped", {
        goalRootId: rootId,
      });
      try {
        this.taskManager.appendTaskNotice(
          task.id,
          "Paused on a question for you. Reply here with your answer and the work continues from that exact point.",
        );
      } catch { /* visibility is best-effort */ }
      return;
    }

    // A tree-level retry or replan fired into a full provider outage is a
    // guaranteed burn that also SPENDS the resume/replan budget on nothing:
    // the resubmitted task dies in its first planning call. Measured live
    // 2026-08-29 00:59: three fresh tasks in 47 seconds, each instantly
    // failing on "All providers are in cooldown", replan budget gone before
    // the cooldown was a minute old. The mission keep-alive already waits out
    // the soonest provider recovery — hand the mission to it with the budget
    // intact.
    const outageWaitMs = this.allProvidersCoolingDownMs();
    if (outageWaitMs > 0) {
      getLogger().info("Goal auto-resume deferred — all providers cooling down", {
        goalRootId: rootId,
        waitMs: outageWaitMs,
      });
      this.scheduleMissionKeepAlive(task, "All providers are in cooldown");
      return;
    }

    // The retry budget belongs to the mission's LINEAGE, not one goal tree:
    // retry/replan submit a new task (parentId-linked) whose decomposition
    // mints a fresh goal root, so keying the budget on rootId reset it every
    // round and made the loop unbounded — measured 2026-08-26, one lineage
    // produced 35 blocked tasks at a ~23s cadence and drove both providers
    // into cooldown.
    const budgetKey = this.lineageRootTaskId(task);
    const state = this.autoResumeState.get(budgetKey) ?? {
      attempts: 0,
      replans: 0,
      previousSucceeded: 0,
    };
    const decision = decideAutoResume(state, succeeded);

    if (decision.action === "stop") {
      getLogger().warn("Blocked goal left for a person", {
        goalRootId: rootId,
        attempts: state.attempts,
        replans: state.replans,
        reason: decision.reason,
      });
      this.autoResumeState.delete(budgetKey);
      // Tree-level retries are spent — escalate to MISSION level, which keeps
      // feeding the original prompt back in on the slow clock until success,
      // budget, or cap. The channel hears every step either way.
      if (this.scheduleMissionKeepAlive(task, decision.reason)) {
        return;
      }
      try {
        this.taskManager.appendTaskNotice(
          task.id,
          `Goal stopped after ${state.attempts} resume(s) and ${state.replans} replan(s): ${decision.reason}. ` +
            `This needs you — send instructions fixing the blocker.`,
        );
      } catch {
        // Visibility is best-effort; the task stays blocked either way.
      }
      return;
    }

    const replanning = decision.action === "replan";
    this.autoResumeState.set(budgetKey, {
      attempts: replanning ? state.attempts : state.attempts + 1,
      replans: replanning ? state.replans + 1 : state.replans,
      previousSucceeded: succeeded,
    });
    getLogger().info(
      replanning
        ? "Replanning a stalled goal instead of replaying it"
        : "Resuming blocked goal without waiting for a person",
      {
        goalRootId: rootId,
        attempt: replanning ? state.replans + 1 : state.attempts + 1,
        reason: decision.reason,
      },
    );
    try {
      if (replanning) {
        this.taskManager.replanGoalRoot(rootId, nodeOutcomes);
      } else {
        this.taskManager.retryGoalRoot(rootId);
      }
    } catch (error) {
      getLogger().error("Automatic resume failed to resubmit the goal", {
        goalRootId: rootId,
        action: decision.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }


}
