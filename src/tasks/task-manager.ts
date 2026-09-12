/**
 * Task Manager
 *
 * Business logic and state machine for task lifecycle.
 * Manages task creation, status transitions, cancellation,
 * and startup recovery.
 */

import { EventEmitter } from "node:events";
import type { Task, TaskId, TaskProgressUpdate } from "./types.js";
import { TaskStatus, ACTIVE_STATUSES, TERMINAL_STATUSES, generateTaskId, getTaskConversationKey } from "./types.js";
import { getTaskProgressMessage, toTaskProgressSignal } from "./progress-signals.js";
import { stripRetryMachinery } from "./auto-resume.js";
import type { TaskStorage } from "./task-storage.js";
import type { IBackgroundExecutor, IOrchestrator } from "./orchestrator-contract.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";
import type { TaskOrigin } from "../daemon/daemon-types.js";
import type { GoalTree } from "../goals/types.js";
import type { GoalNodeId } from "../goals/types.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import { prepareTreeForResume, prepareTreeForRetry } from "../goals/goal-resume.js";
import { stripVisibleProviderArtifacts } from "../agents/orchestrator-text-utils.js";
import type { MessageContent } from "../agents/providers/provider-core.interface.js";
import type { PendingTaskCheckpoint, TaskCheckpointStore } from "./task-checkpoint-store.js";

/** The three replay prefaces buildReplayPrompt writes; a prompt starting with one IS a replay. */
const REPLAY_PREFACE_RE = /^(?:Previous background execution was interrupted\.|The previous plan was attempted and then attempted again|Previous background execution failed or stalled\.)/;

export function isReplayPrompt(prompt: string): boolean {
  return REPLAY_PREFACE_RE.test(prompt.trimStart());
}

export class TaskManager extends EventEmitter {
  private readonly abortControllers = new Map<TaskId, AbortController>();
  private checkpointStore?: TaskCheckpointStore;
  /**
   * The live orchestrator a task was submitted with, for replay. Audited
   * 2026-09-02: every replay path rebuilt the task from SQLite, which has no
   * column for a live object graph, so `task.orchestrator` was always
   * undefined and an agent's retried mission silently ran as the MAIN agent —
   * wrong memory namespace, wrong budget, nothing logged. The object cannot be
   * persisted; it is remembered here for the life of the process and handed
   * to each replay in the lineage (submit re-registers the child).
   */
  private readonly liveOrchestrators = new Map<TaskId, IOrchestrator>();
  private static readonly MAX_LIVE_ORCHESTRATORS = 500;

  /** When this process began: a task created after it cannot have been interrupted by the restart that began it. */
  private readonly bootedAt: number;

  constructor(
    private readonly storage: TaskStorage,
    private readonly executor: IBackgroundExecutor,
    private readonly goalStorage?: GoalStorage,
    bootedAt: number = Date.now(),
  ) {
    super();
    this.setMaxListeners(20);
    this.bootedAt = bootedAt;
  }

  setCheckpointStore(store: TaskCheckpointStore): void {
    this.checkpointStore = store;
  }

  /**
   * Submit a new task for background execution.
   *
   * @param options Optional settings. `origin` defaults to 'user'; daemon-initiated
   *   tasks pass `{ origin: 'daemon' }` for security policy enforcement.
   */
  submit(
    chatId: string,
    channelType: string,
    prompt: string,
    options?: {
      origin?: TaskOrigin;
      triggerName?: string;
      workspacePolicy?: "none";
      /** "off": run as ONE agent — no top-level supervisor plan, no task lease (the guardian's compile repairs). */
      supervisorMode?: "auto" | "off";
      goalTree?: GoalTree;
      forceSharedPlanning?: boolean;
      userContent?: string | MessageContent[];
      attachments?: import("../channels/channel.interface.js").Attachment[];
      orchestrator?: IOrchestrator;
      conversationId?: string;
      userId?: string;
      parentId?: TaskId;
      goalRootId?: string;
    },
  ): Task {
    const logger = getLogger();
    const now = Date.now();

    const task: Task = {
      id: generateTaskId(),
      chatId,
      channelType,
      conversationId: options?.conversationId,
      userId: options?.userId,
      goalRootId: options?.goalRootId,
      title: prompt.slice(0, 80),
      status: TaskStatus.pending,
      prompt,
      progress: [],
      createdAt: now,
      updatedAt: now,
      parentId: options?.parentId,
      origin: options?.origin ?? "user",
      triggerName: options?.triggerName,
      workspacePolicy: options?.workspacePolicy,
      supervisorMode: options?.supervisorMode,
      goalTree: options?.goalTree,
      forceSharedPlanning: options?.forceSharedPlanning,
      userContent: options?.userContent,
      attachments: options?.attachments,
      orchestrator: options?.orchestrator,
    };

    this.storage.save(task);
    if (options?.orchestrator) this.rememberOrchestrator(task.id, options.orchestrator);
    logger.info("Task submitted", { taskId: task.id, chatId, promptLength: prompt.length });
    this.emit("task:created", task);

    // Enqueue for execution
    const ac = new AbortController();
    this.abortControllers.set(task.id, ac);

    try {
      this.executor.enqueue(task, ac.signal, (message: TaskProgressUpdate) => {
        this.addProgress(task.id, message);
      });
    } catch (enqueueErr) {
      // enqueue() throws on queue overflow (after marking the task failed). That
      // throw must NOT escape submit(): callers such as MessageRouter.flushPendingChat
      // run submit() fire-and-forget (`void this.flushPendingChat(...)`), so an
      // escaping throw becomes an unhandledRejection — which the global handler in
      // src/index.ts escalates to a full daemon shutdown. The task is already
      // marked failed by enqueue(); drop its now-unusable abort controller and
      // return it so the caller still gets a (failed) Task instead of throwing.
      this.abortControllers.delete(task.id);
      logger.warn("Task enqueue rejected; returning task without execution", {
        taskId: task.id,
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      });
    }

    return task;
  }

  attachGoalRoot(taskId: TaskId, goalRootId: string): void {
    this.storage.updateGoalRoot(taskId, goalRootId);
  }

  /**
   * Cancel a running task.
   */
  /**
   * `reason: "superseded"` marks a cancel made only to resubmit the same
   * work as this task's child (the campaign's attempt N+1); descendants do
   * not inherit it as a stop order. Every other cancel is a deliberate stop
   * that retires the whole lineage.
   */
  cancel(taskId: TaskId, opts: { reason?: Task["cancelReason"] } = {}): boolean {
    const task = this.storage.load(taskId);
    if (!task) return false;
    // A BLOCKED task is not finished — it is parked, waiting for a
    // continuation (the mission keep-alive, the goal auto-resume) that will
    // revive it. Refusing to cancel it made every retirement a silent no-op:
    // measured live 2026-09-03, a delivered campaign's sweep logged 33
    // cancellations while the database recorded 9, and its sprint work came
    // back seven times. Cancelling a parked task is exactly how a deliberate
    // stop is expressed; a task that already reached completed/failed/
    // cancelled is left alone.
    const retirable = ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.blocked;
    if (!retirable) {
      // …EXCEPT a deliberate stop on a task the campaign had SUPERSEDED. That
      // row says "replaced, carry on"; a person cancelling it means "stop",
      // and refusing to write anything left the stop with no record at all —
      // the campaign's revival timer then read the supersession and continued
      // (Codex 2026-09-11 J#3). A terminal row's status does not change; only
      // its reason is upgraded.
      // …and a row cancelled with NO reason at all (an older version, or the
      // executor's own cancel) can be upgraded the same way: refusing it left
      // a person's explicit stop with no record anywhere (Codex 2026-09-11 L#6).
      if (task.status === TaskStatus.cancelled && task.cancelReason !== "user" && opts.reason === "user") {
        this.storage.markCancelled(taskId, "user");
        // THE EVENT, TOO. The upgrade persisted the reason and emitted
        // nothing, so a campaign watching for the stop never saw one and its
        // current milestone carried on working (Codex 2026-09-11 L#1).
        this.emit("task:cancelled", taskId);
        getLogger().info("A finished task was cancelled deliberately — the stop is recorded", { taskId });
        return true;
      }
      return false;
    }

    const ac = this.abortControllers.get(taskId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(taskId);
    }

    // If the task was paused, release its conversation lock. pauseTask() added
    // the conversationKey to BackgroundExecutor.pausedConversations and only
    // resumeTask() removes it — but resumeTask() bails at its `status === paused`
    // guard once the task is cancelled, so without this every future task in the
    // conversation would be skipped forever (e.g. /cancel during the 500ms
    // auto-resume window, or cancelling a recovery-paused task).
    if (task.status === TaskStatus.paused) {
      this.executor.resumeConversation(
        getTaskConversationKey(task.chatId, task.channelType, task.conversationId),
      );
    }

    this.storage.markCancelled(taskId, opts.reason);
    this.emit("task:cancelled", taskId);
    getLogger().info("Task cancelled", { taskId, ...(opts.reason ? { reason: opts.reason } : {}) });
    return true;
  }

  cancelGoalRoot(goalRootId: string, opts: { reason?: Task["cancelReason"] } = {}): boolean {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    if (!task) {
      return false;
    }
    return this.cancel(task.id, opts);
  }

  /**
   * Pause a running task. The task is stopped in the executor but its
   * state is preserved so it can be resumed later.
   */
  pauseTask(taskId: TaskId): boolean {
    const task = this.storage.load(taskId);
    if (!task || task.status !== TaskStatus.executing) {
      return false;
    }

    const ac = this.abortControllers.get(taskId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(taskId);
    }

    const conversationKey = getTaskConversationKey(
      task.chatId,
      task.channelType,
      task.conversationId,
    );
    this.executor.pauseConversation(conversationKey);
    this.storage.updateStatus(taskId, TaskStatus.paused);
    this.emit("task:paused", taskId);

    if (this.checkpointStore) {
      const cp: PendingTaskCheckpoint = {
        taskId,
        chatId: task.chatId,
        timestamp: Date.now(),
        stage: "manual_pause",
        lastUserMessage: task.prompt,
        touchedFiles: [],
        userId: task.userId,
      };
      void this.checkpointStore.save(cp);
    }

    getLogger().info("Task paused", { taskId });
    return true;
  }

  /**
   * Resume a paused task.
   */
  resumeTask(taskId: TaskId): Task | null {
    const task = this.storage.load(taskId);
    if (!task || task.status !== TaskStatus.paused) {
      return null;
    }

    const conversationKey = getTaskConversationKey(
      task.chatId,
      task.channelType,
      task.conversationId,
    );
    this.executor.resumeConversation(conversationKey);

    if (task.goalRootId) {
      return this.resumeGoalRoot(task.goalRootId);
    }

    return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "resume"), {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      conversationId: task.conversationId,
      userId: task.userId,
      orchestrator: this.replayOrchestrator(task),
      workspacePolicy: task.workspacePolicy,
      supervisorMode: task.supervisorMode,
      userContent: task.userContent,
      attachments: task.attachments,
      // audited 2026-09-02: persisted but never forwarded — see replayForcesSharedPlanning.
      forceSharedPlanning: this.replayForcesSharedPlanning(task),
      parentId: task.id,
    });
  }

  /**
   * The prompt a replay should quote: the task's own when it is not itself a
   * replay, else the nearest ancestor's that is not (bounded walk; the
   * lineage root as the last resort).
   */
  private originalPromptFor(task: Task): string {
    let current: Task | null = task;
    for (let depth = 0; current && depth < 64; depth++) {
      if (!isReplayPrompt(current.prompt)) return current.prompt;
      if (!current.parentId) break;
      try {
        current = this.storage.load(current.parentId);
      } catch {
        break;
      }
    }
    try {
      const rootId = this.storage.findLineageRootId(task.id);
      const root = rootId && rootId !== task.id ? this.storage.load(rootId) : null;
      if (root?.prompt) return root.prompt;
    } catch {
      // Lineage lookup is best-effort; the task's own prompt still works.
    }
    return task.prompt;
  }

  /**
   * Get current status of a task.
   */
  getStatus(taskId: TaskId): Task | null {
    return this.storage.load(taskId);
  }

  /**
   * The newest task in the retry/resume lineage rooted at `taskId` (the task
   * itself when nothing retried it). Long-lived observers such as the campaign
   * layer track work through this instead of a single task id, because every
   * retry path mints a new id with `parentId` pointing back.
   */
  findLatestLineageTask(taskId: TaskId): Task | null {
    return this.storage.findLatestDescendant(taskId);
  }

  /** True when `taskId` is `rootId` itself or a retry/resume descendant of it. */
  isInLineage(rootId: TaskId, taskId: TaskId): boolean {
    if (rootId === taskId) return true;
    return this.storage.lineageContains(rootId, taskId);
  }

  /** Stable root id of the retry lineage `taskId` belongs to (itself when never retried). */
  findLineageRootId(taskId: TaskId): TaskId | null {
    return this.storage.findLineageRootId(taskId);
  }

  /** Was any task in this lineage TREE stopped deliberately? (Codex L#2) */
  lineageHasDeliberateStop(taskId: TaskId): boolean {
    const root = this.storage.findLineageRootId(taskId) ?? taskId;
    return this.storage.lineageHasDeliberateStop(root);
  }

  /**
   * Every unfinished task descending from this one, at any depth — what a
   * campaign must retire when it finishes, rather than the newest tasks of a
   * chat (Codex 2026-09-11 I#7).
   */
  listLiveInLineage(taskId: TaskId): Task[] {
    try {
      const rootId = this.storage.findLineageRootId(taskId) ?? taskId;
      return this.storage.listLiveInLineage(rootId);
    } catch {
      return [];
    }
  }

  /** The chat a person most recently talked in — the target for daemon notices. */
  findLatestUserChat(): { chatId: string; channelType: string } | null {
    return this.storage.findLatestUserChat();
  }

  retryTask(taskId: TaskId): Task | null {
    const task = this.storage.load(taskId);
    if (!task || ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.completed) {
      return null;
    }

    if (task.goalRootId) {
      return this.retryGoalRoot(task.goalRootId);
    }

    return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "retry"), {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      conversationId: task.conversationId,
      userId: task.userId,
      orchestrator: this.replayOrchestrator(task),
      workspacePolicy: task.workspacePolicy,
      supervisorMode: task.supervisorMode,
      userContent: task.userContent,
      attachments: task.attachments,
      // audited 2026-09-02: persisted but never forwarded — see replayForcesSharedPlanning.
      forceSharedPlanning: this.replayForcesSharedPlanning(task),
      parentId: task.id,
    });
  }

  retryGoalRoot(goalRootId: string, nodeId?: string): Task | null {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    if (!task || ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.completed) {
      return null;
    }
    const tree = this.goalStorage?.getTree(goalRootId as GoalNodeId);
    if (!tree) {
      return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "retry"), {
        origin: task.origin ?? "user",
        triggerName: task.triggerName,
        conversationId: task.conversationId,
        userId: task.userId,
        orchestrator: this.replayOrchestrator(task),
        workspacePolicy: task.workspacePolicy,
        supervisorMode: task.supervisorMode,
        userContent: task.userContent,
        attachments: task.attachments,
        // audited 2026-09-02: persisted but never forwarded — see replayForcesSharedPlanning.
        forceSharedPlanning: this.replayForcesSharedPlanning(task),
        parentId: task.id,
      });
    }

    const replayTree = prepareTreeForRetry(tree, nodeId as GoalNodeId | undefined);
    return this.submit(task.chatId, task.channelType, task.prompt, {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      goalTree: replayTree,
      goalRootId,
      forceSharedPlanning: true,
      userContent: task.userContent,
      attachments: task.attachments,
      orchestrator: this.replayOrchestrator(task),
      workspacePolicy: task.workspacePolicy,
      supervisorMode: task.supervisorMode,
      conversationId: task.conversationId,
      userId: task.userId,
      parentId: task.id,
    });
  }

  /**
   * Plan a stalled goal again from scratch, with the failure reasons as input.
   *
   * retryGoalRoot replays the same tree, which is right while rounds are still
   * completing nodes and useless once they are not. This deliberately submits
   * without a goalTree so decomposition runs afresh: the failed steps come back
   * as context to plan around, not as a tree to re-execute.
   */
  replanGoalRoot(goalRootId: string, failureReasons: readonly string[] = []): Task | null {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    if (!task || ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.completed) {
      return null;
    }

    const lines = [this.buildReplayPrompt(task, "replan")];
    if (failureReasons.length > 0) {
      lines.push("", "What the last two rounds could not get past:");
      for (const reason of failureReasons.slice(0, 10)) {
        lines.push(`- ${sanitizeSecrets(reason)}`);
      }
    }
    // The replan preface promises "Completed work still stands; keep it" —
    // but this submission deliberately carries no goalTree, so the fresh
    // decomposition could not SEE that work and re-planned it from scratch.
    // Name what is already done so the new plan builds on it.
    try {
      const tree = this.goalStorage?.getTree(goalRootId as GoalNodeId);
      const done = tree
        ? [...tree.nodes.values()].filter((n) => n.id !== tree.rootId && n.status === "completed")
        : [];
      if (done.length > 0) {
        lines.push("", "Already COMPLETED in previous rounds (do not re-plan these):");
        for (const n of done.slice(0, 12)) {
          lines.push(`- ${n.task}${n.result ? ` → ${n.result.slice(0, 160)}` : ""}`);
        }
      }
    } catch {
      // Best-effort enrichment.
    }

    return this.submit(task.chatId, task.channelType, lines.join("\n"), {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      forceSharedPlanning: true,
      userContent: task.userContent,
      attachments: task.attachments,
      orchestrator: this.replayOrchestrator(task),
      workspacePolicy: task.workspacePolicy,
      supervisorMode: task.supervisorMode,
      conversationId: task.conversationId,
      userId: task.userId,
      parentId: task.id,
    });
  }

  resumeGoalRoot(goalRootId: string): Task | null {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    // PAUSED IS THE RESUME CASE. `paused` sits in ACTIVE_STATUSES, so this
    // guard refused to resume the very task the caller had just asked about:
    // any goal-backed task a restart parked could never be resumed by this
    // path at all, and only a person could move it. Measured live 2026-09-11
    // 21:12:53 — "Restart-paused task could not be resumed" on a mission
    // whose work was already done.
    if (!task) return null;
    const stillRunning = ACTIVE_STATUSES.has(task.status) && task.status !== TaskStatus.paused;
    if (stillRunning || task.status === TaskStatus.completed) {
      return null;
    }
    const tree = this.goalStorage?.getTree(goalRootId as GoalNodeId);
    if (!tree) {
      return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "resume"), {
        origin: task.origin ?? "user",
        triggerName: task.triggerName,
        conversationId: task.conversationId,
        userId: task.userId,
        orchestrator: this.replayOrchestrator(task),
        workspacePolicy: task.workspacePolicy,
        supervisorMode: task.supervisorMode,
        userContent: task.userContent,
        attachments: task.attachments,
        // audited 2026-09-02: persisted but never forwarded — see replayForcesSharedPlanning.
        forceSharedPlanning: this.replayForcesSharedPlanning(task),
        parentId: task.id,
      });
    }

    const replayTree = task.status === TaskStatus.blocked
      ? prepareTreeForRetry(tree)
      : prepareTreeForResume(tree);
    return this.submit(task.chatId, task.channelType, task.prompt, {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      goalTree: replayTree,
      goalRootId,
      forceSharedPlanning: true,
      userContent: task.userContent,
      attachments: task.attachments,
      orchestrator: this.replayOrchestrator(task),
      workspacePolicy: task.workspacePolicy,
      supervisorMode: task.supervisorMode,
      conversationId: task.conversationId,
      userId: task.userId,
      parentId: task.id,
    });
  }

  /**
   * List recent tasks for a chat (active + recent completed).
   */
  listTasks(chatId: string, limit = 10): Task[] {
    return this.storage.listByChatId(chatId, limit);
  }

  /** Executing tasks whose last progress signal is older than the cutoff. */
  listStuckExecuting(olderThanMs: number): Task[] {
    const cutoff = Date.now() - olderThanMs;
    return this.storage
      .listExecuting()
      .filter((t) => t.updatedAt < cutoff);
  }

  /**
   * List only active tasks for a chat.
   */
  listActiveTasks(chatId: string): Task[] {
    return this.storage.listActiveByChatId(chatId);
  }

  /**
   * List all currently active tasks, newest first.
   */
  listAllActiveTasks(): Task[] {
    return this.storage.loadIncomplete();
  }

  /**
   * User tasks a restart parked as `paused` and nobody resumed.
   *
   * recoverOnStartup marks them paused-and-recoverable, and the only things
   * that ever resumed one were a human's `/resume` or the monitor: the
   * keep-alive re-arm reads listRecoverable, which excludes `paused`.
   * Measured 2026-09-10: five boots, each pausing the mission in flight
   * (task_d526df85 11:44, task_eee999a6 14:32 …), each waiting for a hand.
   */
  listPausedByRestart(limit = 20): Task[] {
    return this.storage
      .loadIncomplete()
      .filter(
        (t) =>
          t.status === TaskStatus.paused &&
          t.origin !== "daemon" &&
          /interrupted by system restart/i.test(t.error ?? ""),
      )
      .slice(0, limit);
  }

  listRecoverableTasks(limit = 20): Task[] {
    return this.storage
      .listRecoverable(limit)
      .filter((task) => task.channelType !== "daemon");
  }

  /**
   * Count active user-facing tasks across chats.
   * Daemon-internal tasks are excluded so control-plane observers do not
   * mistake their own background work for a foreground user session.
   *
   * `paused` and `waiting_for_input` rows are NOT counted: they are parked on
   * a person, consuming no execution slot. Counting them made one abandoned
   * pause (startup recovery mass-pauses interrupted tasks) defer every
   * daemon-origin task in the queue for the life of the process.
   */
  countActiveForegroundTasks(excludedChatIds: readonly string[] = []): number {
    const excluded = new Set(excludedChatIds);
    const progressing = new Set<TaskStatus>([
      TaskStatus.pending,
      TaskStatus.planning,
      TaskStatus.executing,
    ]);
    return this.storage.loadIncomplete().filter((task) =>
      task.channelType !== "daemon" &&
      !excluded.has(task.chatId) &&
      progressing.has(task.status)
    ).length;
  }

  /**
   * Check whether any foreground user task is currently active.
   */
  hasActiveForegroundTasks(excludedChatIds: readonly string[] = []): boolean {
    return this.countActiveForegroundTasks(excludedChatIds) > 0;
  }

  /** Bump the task's liveness clock (updated_at) without recording progress. */
  touch(taskId: TaskId): void {
    this.storage.touch(taskId);
  }

  /** The orchestrator a replay must run under: the row's (never set — SQLite) or the remembered live one. */
  private replayOrchestrator(task: Task): IOrchestrator | undefined {
    return task.orchestrator ?? this.liveOrchestrators.get(task.id);
  }

  /**
   * Whether the replay must re-enter shared planning, as the original submit
   * decided.
   *
   * Audited 2026-09-02: `forceSharedPlanning` IS persisted (the
   * force_shared_planning column) and IS read back onto the Task, but no
   * non-goal replay path forwarded it. reflection.ts sets it when the incoming
   * message carries images or files — that input can be planned but not
   * decomposed blind — and BackgroundExecutor gates the shared-planning route
   * on `goalTree || forceSharedPlanning || shouldDecompose`. So a retried or
   * resumed screenshot task kept the attachments it was planned FROM and lost
   * the route that reads them: it re-ran as an ordinary worker.
   *
   * The goal-tree replay paths pass `true` outright — a replayed tree is always
   * re-planned — so this is only for the paths that carry no tree.
   */
  private replayForcesSharedPlanning(task: Task): boolean | undefined {
    return task.forceSharedPlanning ? true : undefined;
  }

  private rememberOrchestrator(taskId: TaskId, orchestrator: IOrchestrator): void {
    this.liveOrchestrators.set(taskId, orchestrator);
    // Bounded: a lineage hands its entry to each replayed child, so the oldest
    // entries belong to long-terminal ancestors nobody replays.
    if (this.liveOrchestrators.size > TaskManager.MAX_LIVE_ORCHESTRATORS) {
      const oldest = this.liveOrchestrators.keys().next().value;
      if (oldest !== undefined) this.liveOrchestrators.delete(oldest);
    }
  }

  /** Persist the mechanical test verdict derived from a run's tool evidence. */
  setVerification(taskId: TaskId, verdict: import("./test-verdict.js").TaskTestVerdict): void {
    try {
      this.storage.setVerification(taskId, JSON.stringify(verdict));
    } catch { /* verdict carriage is best-effort; the run outcome stands */ }
  }

  /**
   * Compact "what the previous run already achieved" block for a follow-up
   * submission (campaign milestone retries). Mirrors buildReplayPrompt's
   * checkpoint section: without it, attempt N+1 saw only attempt N's failure
   * text and re-derived the whole sprint from scratch (audited 2026-08-29).
   * Returns "" when nothing usable is known.
   */
  priorProgressSummary(taskId: TaskId): string {
    try {
      const latest = this.findLatestLineageTask(taskId) ?? this.getStatus(taskId);
      if (!latest) return "";
      const checkpoint = this.checkpointStore?.loadByTaskIdSync?.(latest.id);
      const touched = (checkpoint?.touchedFiles ?? []).slice(0, 30);
      const resultTail = stripRetryMachinery(latest.result ?? "").slice(-400);
      if (touched.length === 0 && !resultTail) return "";
      const lines: string[] = ["\n\nPREVIOUS ATTEMPT PROGRESS (verify before redoing any of it):"];
      if (touched.length > 0) {
        lines.push(`Files the previous attempt already created/modified:\n${touched.map((f) => `- ${f}`).join("\n")}`);
      }
      if (resultTail) {
        lines.push(`Its final report ended with:\n${resultTail}`);
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  /**
   * Add a progress entry to a task.
   */
  addProgress(taskId: TaskId, message: TaskProgressUpdate): void {
    const signal = toTaskProgressSignal(message);
    this.storage.addProgress(taskId, signal.userSummary?.trim() || getTaskProgressMessage(message));
    this.emit("task:progress", taskId, message);
  }

  /**
   * Mark a task as completed with result.
   */
  /**
   * Emit a TERMINAL event so one bad listener cannot silence the others.
   *
   * EventEmitter calls listeners in order and a throw stops the rest: measured
   * by review 2026-09-12 (T#9) — a listener that threw after the task was
   * already stored as completed left every later subscriber with nothing, and
   * the retry could not help because the terminal guard (rightly) refuses to
   * write twice. `rawListeners` keeps `once` semantics: the wrapper removes
   * itself when it runs.
   */
  private emitTerminal(event: string, ...args: unknown[]): void {
    for (const listener of this.rawListeners(event)) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        getLogger().error("A task listener threw; the other listeners still ran", {
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  complete(taskId: TaskId, result: string): void {
    // A TERMINAL STATE IS NOT OVERWRITTEN. This wrote and emitted
    // unconditionally, so a completion arriving after a cancel replaced it,
    // and a listener that threw made the caller repeat the write — the task
    // emitted `completed` twice (Codex 2026-09-12 S#3).
    const current = this.storage.load(taskId);
    if (current && TERMINAL_STATUSES.has(current.status)) {
      getLogger().info("Task completion ignored — the task is already settled", {
        taskId,
        status: current.status,
      });
      return;
    }
    const sanitizedResult = sanitizeSecrets(stripVisibleProviderArtifacts(result));
    this.storage.updateResult(taskId, sanitizedResult);
    this.abortControllers.delete(taskId);
    this.liveOrchestrators.delete(taskId); // a completed task is never replayed
    this.emitTerminal("task:completed", taskId, sanitizedResult);
    getLogger().info("Task completed", { taskId, resultLength: sanitizedResult.length });
  }

  /**
   * Mark a task as failed with error.
   */
  fail(taskId: TaskId, error: string): void {
    const sanitizedError = sanitizeSecrets(error);
    this.storage.updateError(taskId, sanitizedError);
    this.abortControllers.delete(taskId);
    this.emitTerminal("task:failed", taskId, sanitizedError);
    getLogger().error("Task failed", { taskId, error: sanitizedError });
  }

  /**
   * Mark a task as blocked with a checkpoint summary.
   */
  block(taskId: TaskId, result: string): void {
    const sanitizedResult = sanitizeSecrets(stripVisibleProviderArtifacts(result));
    this.storage.updateBlocked(taskId, sanitizedResult);
    this.abortControllers.delete(taskId);
    this.emit("task:blocked", taskId, sanitizedResult);
    getLogger().warn("Task blocked", { taskId, resultLength: sanitizedResult.length });
  }

  /**
   * Append a visibility notice to an already-blocked task and re-announce it.
   *
   * Used when automatic resume/replan budgets are exhausted: the decision used
   * to live only in the log file while the person on the channel saw silence
   * (measured 2026-08-23). The notice names what was tried and how to continue.
   */
  appendTaskNotice(taskId: TaskId, notice: string): void {
    const task = this.storage.load(taskId);
    if (!task) return;
    const existing = task.result?.trim() ?? "";
    const combined = `${existing}${existing ? "\n\n" : ""}${sanitizeSecrets(notice)}`;
    this.storage.updateBlocked(taskId, combined);
    this.emit("task:blocked", taskId, combined);
    getLogger().info("Task notice appended", { taskId, noticeLength: notice.length });
  }

  /**
   * Update task status.
   */
  updateStatus(taskId: TaskId, status: TaskStatus): void {
    const task = this.storage.load(taskId);
    if (task && TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    this.storage.updateStatus(taskId, status);
    this.emit("task:status", taskId, status);
  }

  /**
   * Recover incomplete tasks on startup.
   * Marks them as failed since we can't resume LLM conversations.
   */
  recoverOnStartup(): void {
    const logger = getLogger();
    const incomplete = this.storage.loadIncomplete();

    if (incomplete.length === 0) return;

    logger.info("Recovering incomplete tasks on startup", { count: incomplete.length });

    for (const task of incomplete) {
      // A task THIS process submitted is live, not interrupted. Measured
      // 2026-09-08 04:18: the campaign's reconcile fired 16 s before this pass,
      // cancelled the old lineage and submitted attempt 2 (8918 chars, delivery
      // gate attached); this pass then paused it as an orphan and the campaign
      // "resumed" it as a replay whose prompt had lost the gate block.
      if (task.createdAt >= this.bootedAt) {
        logger.info("Recovery left a task alone — it was submitted by this process", {
          taskId: task.id,
          status: task.status,
          createdAt: new Date(task.createdAt).toISOString(),
          bootedAt: new Date(this.bootedAt).toISOString(),
        });
        continue;
      }
      if (task.origin === "daemon") {
        this.storage.updateError(
          task.id,
          "Task interrupted by system restart. The daemon will recreate it if still needed.",
        );
        if (task.goalRootId && this.goalStorage) {
          this.goalStorage.updateTreeStatus(task.goalRootId as GoalNodeId, "failed");
        }
        logger.warn("Task marked as failed on recovery", { taskId: task.id, previousStatus: task.status });
        continue;
      }

      const pausedReason = task.goalRootId
        ? "Task interrupted by system restart. Resume is available from the monitor and will continue from the saved plan."
        : "Task interrupted by system restart. Resume is available and will continue from the strongest checkpoint.";
      // updateError() also forces status=failed, so it must run BEFORE
      // updateStatus(paused) — otherwise it clobbers the paused status and the
      // recoverable task is wrongly left as failed. updateStatus only touches
      // status/updated_at, leaving the error message intact.
      this.storage.updateError(task.id, pausedReason);
      this.storage.updateStatus(task.id, TaskStatus.paused);
      if (task.goalRootId && this.goalStorage) {
        this.goalStorage.updateTreeStatus(task.goalRootId as GoalNodeId, "paused");
      }
      this.emit("task:paused", task.id);
      logger.warn("Task marked as paused on recovery", {
        taskId: task.id,
        previousStatus: task.status,
        recoverable: true,
      });
    }
  }

  /**
   * Fail active tasks during graceful shutdown so they do not remain
   * executing until a later startup recovery pass.
   */
  failActiveTasksOnShutdown(reason = "Task interrupted by system shutdown. Resume is available after restart."): void {
    const logger = getLogger();
    const activeTasks = this.storage.loadIncomplete();

    if (activeTasks.length === 0) return;

    logger.info("Failing active tasks on shutdown", { count: activeTasks.length });

    for (const task of activeTasks) {
      const ac = this.abortControllers.get(task.id);
      if (ac) {
        ac.abort();
        this.abortControllers.delete(task.id);
      }

      if (task.origin === "daemon") {
        this.storage.updateError(task.id, reason);
        if (task.goalRootId && this.goalStorage) {
          this.goalStorage.updateTreeStatus(task.goalRootId as GoalNodeId, "failed");
        }
        this.emit("task:failed", task.id, reason);
        logger.warn("Task marked as failed on shutdown", {
          taskId: task.id,
          previousStatus: task.status,
          recoverable: false,
        });
        continue;
      }

      this.storage.updateBlocked(task.id, reason);
      if (task.goalRootId && this.goalStorage) {
        this.goalStorage.updateTreeStatus(task.goalRootId as GoalNodeId, "blocked");
      }
      this.emit("task:blocked", task.id, reason);
      logger.warn("Task marked as blocked on shutdown", {
        taskId: task.id,
        previousStatus: task.status,
        recoverable: true,
      });
    }
  }

  private buildReplayPrompt(task: Task, mode: "retry" | "resume" | "replan"): string {
    const preface = mode === "resume"
      ? "Previous background execution was interrupted. Resume from the strongest checkpoint, preserve completed work, and only redo what is necessary."
      : mode === "replan"
      ? "The previous plan was attempted and then attempted again, and the second round finished nothing the first had not. Do not repeat it — and do NOT plan an audit: no step of the new plan may be 'audit/extract/review previous work' (measured: such plans deliver nothing). Produce a different DOING plan — a different decomposition, a different order, or smaller steps that sidestep whatever blocked the last one, every step an implementation or verification of the ORIGINAL task's requirements. Completed work still stands; keep it."
      : "Previous background execution failed or stalled. CONTINUE THE WORK — do not audit, reconstruct or re-verify previous attempts (measured: retries whose preface said 'analyze the failure' spent whole runs producing forensic audits and zero deliverables). One glance at the checkpoint below to see what already exists, then pick the first unmet requirement of the ORIGINAL task and implement it.";

    // The TRUE original prompt, from the lineage root — task.prompt on a
    // retried task IS a replay prompt, so quoting it nested another whole
    // preface per generation (measured live: +313 chars/gen, the real
    // instruction at nesting depth 3, and the bloat then polluted vault
    // retrieval because the query contained the failure boilerplate).
    //
    // The NEAREST non-replay ancestor, not the lineage root. Measured
    // 2026-09-08 04:18: a campaign lineage 30 tasks deep — every resubmission
    // a fresh prompt with the latest measurement and delivery gate, each with
    // parentId on the last — replayed from its root, a 4584-char prompt from
    // 29 sprints earlier with no gate block at all.
    const originalPrompt = this.originalPromptFor(task);

    const lines = [preface, "", `Original request: ${originalPrompt}`];

    // "Last known checkpoint" must be a checkpoint, not machinery noise: the
    // keep-alive's block message ("Transient failure … Auto-retry 3/10 in
    // ~120s") was quoted here verbatim and the model was told to continue
    // from a retry countdown.
    const result = task.result?.trim();
    if (result && !/Auto-retry \d+\/\d+ in ~\d+s/.test(result)) {
      lines.push("", `Last known checkpoint:\n${result.slice(0, 1200)}`);
    }
    if (task.error) {
      // Stripped like the result is: "Reaped: no progress signal for 60
      // minutes." reached the next run verbatim as its last known failure
      // (Codex 2026-09-11 G#10).
      const failure = stripRetryMachinery(sanitizeSecrets(task.error));
      if (failure) lines.push("", `Last known failure:\n${failure.slice(0, 800)}`);
    }

    // The rolling epoch checkpoint knows which files the previous run actually
    // touched — the one piece of REAL progress that survives a crash. It sat
    // write-only for months; feed it to the retry so "preserve completed
    // work" points at concrete files instead of nothing.
    if (this.checkpointStore) {
      try {
        const cp = this.checkpointStore.loadByTaskIdSync(task.id);
        if (cp && cp.touchedFiles.length > 0) {
          lines.push(
            "",
            `Files the previous run already created/modified (verify before redoing):\n${cp.touchedFiles
              .slice(0, 40)
              .map((f) => `- ${f}`)
              .join("\n")}`,
          );
        }
      } catch {
        // Checkpoint read is best-effort.
      }
    }

    return lines.join("\n");
  }
}
