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

export class TaskManager extends EventEmitter {
  private readonly abortControllers = new Map<TaskId, AbortController>();
  private checkpointStore?: TaskCheckpointStore;

  constructor(
    private readonly storage: TaskStorage,
    private readonly executor: IBackgroundExecutor,
    private readonly goalStorage?: GoalStorage,
  ) {
    super();
    this.setMaxListeners(20);
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
      goalTree: options?.goalTree,
      forceSharedPlanning: options?.forceSharedPlanning,
      userContent: options?.userContent,
      attachments: options?.attachments,
      orchestrator: options?.orchestrator,
    };

    this.storage.save(task);
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
  cancel(taskId: TaskId): boolean {
    const task = this.storage.load(taskId);
    if (!task || !ACTIVE_STATUSES.has(task.status)) {
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

    this.storage.updateStatus(taskId, TaskStatus.cancelled);
    this.emit("task:cancelled", taskId);
    getLogger().info("Task cancelled", { taskId });
    return true;
  }

  cancelGoalRoot(goalRootId: string): boolean {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    if (!task) {
      return false;
    }
    return this.cancel(task.id);
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
      orchestrator: task.orchestrator,
      userContent: task.userContent,
      attachments: task.attachments,
      parentId: task.id,
    });
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
      orchestrator: task.orchestrator,
      userContent: task.userContent,
      attachments: task.attachments,
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
        orchestrator: task.orchestrator,
        userContent: task.userContent,
        attachments: task.attachments,
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
      orchestrator: task.orchestrator,
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
      orchestrator: task.orchestrator,
      conversationId: task.conversationId,
      userId: task.userId,
      parentId: task.id,
    });
  }

  resumeGoalRoot(goalRootId: string): Task | null {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    if (!task || ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.completed) {
      return null;
    }
    const tree = this.goalStorage?.getTree(goalRootId as GoalNodeId);
    if (!tree) {
      return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "resume"), {
        origin: task.origin ?? "user",
        triggerName: task.triggerName,
        conversationId: task.conversationId,
        userId: task.userId,
        orchestrator: task.orchestrator,
        userContent: task.userContent,
        attachments: task.attachments,
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
      orchestrator: task.orchestrator,
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
      const resultTail = (latest.result ?? "")
        .replace(/Reaped:[^.]*\./g, "")
        .replace(/Auto-retry \d+\/\d+ in ~\d+s\.?/g, "")
        .trim()
        .slice(-400);
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
  complete(taskId: TaskId, result: string): void {
    const sanitizedResult = sanitizeSecrets(stripVisibleProviderArtifacts(result));
    this.storage.updateResult(taskId, sanitizedResult);
    this.abortControllers.delete(taskId);
    this.emit("task:completed", taskId, sanitizedResult);
    getLogger().info("Task completed", { taskId, resultLength: sanitizedResult.length });
  }

  /**
   * Mark a task as failed with error.
   */
  fail(taskId: TaskId, error: string): void {
    const sanitizedError = sanitizeSecrets(error);
    this.storage.updateError(taskId, sanitizedError);
    this.abortControllers.delete(taskId);
    this.emit("task:failed", taskId, sanitizedError);
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
      ? "The previous plan was attempted and then attempted again, and the second round finished nothing the first had not. Do not repeat it. Work out why those steps could not be completed and produce a different plan — a different decomposition, a different order, or smaller steps that sidestep whatever blocked the last one. Completed work still stands; keep it."
      : "Previous background execution failed or stalled. First analyze the failure cause briefly, then continue from the strongest checkpoint instead of restarting blindly.";

    // The TRUE original prompt, from the lineage root — task.prompt on a
    // retried task IS a replay prompt, so quoting it nested another whole
    // preface per generation (measured live: +313 chars/gen, the real
    // instruction at nesting depth 3, and the bloat then polluted vault
    // retrieval because the query contained the failure boilerplate).
    let originalPrompt = task.prompt;
    try {
      const rootId = this.storage.findLineageRootId(task.id);
      const root = rootId && rootId !== task.id ? this.storage.load(rootId) : null;
      if (root?.prompt) originalPrompt = root.prompt;
    } catch {
      // Lineage lookup is best-effort; the task's own prompt still works.
    }

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
      lines.push("", `Last known failure:\n${sanitizeSecrets(task.error).slice(0, 800)}`);
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
