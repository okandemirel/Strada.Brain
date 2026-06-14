/**
 * Message Router
 *
 * Central routing layer — the new entry point replacing direct
 * orchestrator.handleMessage() calls from channel adapters.
 *
 * Classification order:
 *   1. Command (prefix match) → CommandHandler
 *   2. Task request (default)  → TaskManager.submit()
 */

import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import type { IChannelSender } from "../channels/channel-core.interface.js";
import type { TaskManager } from "./task-manager.js";
import { getTaskConversationKey } from "./types.js";
import { CommandHandler } from "./command-handler.js";
import { detectCommand } from "./command-detector.js";
import { buildBatchedPrompt, buildBurstOrQueueNotice } from "./message-bursting.js";
import { getLogger } from "../utils/logger.js";

const QUEUE_NOTICE_COOLDOWN_MS = 15_000;
/**
 * Upper bound on tracked per-conversation queue-notice cooldowns. Without a cap
 * the map grew once per distinct conversation forever. Mirrors the bounded-Map
 * + oldest-drop idiom used for MAX_SESSIONS in orchestrator-session-manager.
 */
const MAX_QUEUE_NOTICE_COOLDOWNS = 500;

export interface MessageRouterOptions {
  readonly burstWindowMs: number;
  readonly maxBurstMessages: number;
}

interface PendingTaskBatch {
  readonly conversationKey: string;
  chatId: string;
  channelType: string;
  readonly messages: IncomingMessage[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class MessageRouter {
  private notifiedChats: Set<string> | null = new Set<string>();
  private startupNoticeMarkdown?: string;
  private readonly pendingTaskBatches = new Map<string, PendingTaskBatch>();
  private readonly queueNoticeCooldowns = new Map<string, number>();
  private readonly burstWindowMs: number;
  private readonly maxBurstMessages: number;
  private startupNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  dispose(): void {
    // Cancel the one-shot startup-notice reset timer so it can't keep `this`
    // (and its Maps) alive — or keep the Node event loop running — on a fast
    // shutdown that happens within the 60s window.
    if (this.startupNoticeTimer) {
      clearTimeout(this.startupNoticeTimer);
      this.startupNoticeTimer = null;
    }

    for (const [, batch] of this.pendingTaskBatches) {
      if (batch.timer) {
        clearTimeout(batch.timer);
      }
    }
    // Buffered (un-flushed) burst messages are intentionally DROPPED on dispose
    // rather than flushed. Flushing here would call taskManager.submit() during
    // shutdown — after the task pipeline / channel may already be torn down — so
    // the result could never be delivered and could throw mid-teardown. Dropping
    // is the lower-risk choice: dispose() only runs on shutdown, and any task
    // not yet flushed has not been acknowledged to the user.
    this.pendingTaskBatches.clear();
    this.queueNoticeCooldowns.clear();
  }

  constructor(
    private readonly taskManager: TaskManager,
    private readonly commandHandler: CommandHandler,
    private readonly channel: IChannelSender | undefined,
    startupNotices: string[] | undefined,
    options: MessageRouterOptions,
  ) {
    const notices = [...new Set((startupNotices ?? []).map((notice) => notice.trim()).filter(Boolean))];
    if (notices.length > 0) {
      this.startupNoticeMarkdown = [
        "*System Status*",
        "",
        ...notices.map((notice) => `- ${notice}`),
      ].join("\n");
    }

    this.burstWindowMs = options.burstWindowMs;
    this.maxBurstMessages = options.maxBurstMessages;

    // Auto-clear startup notice state after 60s — no need to track chats forever.
    // Store the handle so dispose() can cancel it; unref() so this one-shot timer
    // never keeps the Node process alive on its own.
    this.startupNoticeTimer = setTimeout(() => {
      this.notifiedChats = null;
      this.startupNoticeMarkdown = undefined;
      this.startupNoticeTimer = null;
    }, 60_000);
    this.startupNoticeTimer.unref?.();
  }

  /**
   * Route an incoming message to the appropriate handler.
   * This bypasses the session lock for commands so /status works during long tasks.
   */
  async route(msg: IncomingMessage): Promise<void> {
    const logger = getLogger();
    const { chatId, text } = msg;

    if (!text.trim()) return;

    await this.sendStartupNotice(chatId);

    const classification = detectCommand(text);

    if (classification.type === "command") {
      await this.flushPendingChat(getTaskConversationKey(chatId, msg.channelType, msg.conversationId));
      logger.debug("Message classified as command", {
        chatId,
        command: classification.command,
        args: classification.args,
      });

      await this.commandHandler.handle(chatId, classification.command, classification.args, msg.userId);
      return;
    }

    // Implicit recovery intent detection — only fires when there is a pending
    // checkpoint for this chat AND the user's message expresses a high-
    // confidence retry/resume/budget-update intent. Conservative on purpose:
    // a false positive here would route the user's actual request into a
    // stale checkpoint resume. The parser + checkpoint guard inside
    // `tryHandleImplicitRecovery` keep the trigger rate very low.
    //
    // Ordering note: flushPendingChat runs AFTER implicit recovery resolves
    // (inside the `handled` branch only) — flushing eagerly before the probe
    // would break the burst-batching invariant for normal task messages,
    // which is covered by the "batches consecutive follow-ups" tests.
    // Race with the resumed PAOR loop is already bounded by the per-session
    // lock in SessionManager and by `resumeInFlight` in Orchestrator.
    try {
      const handled = await this.commandHandler.tryHandleImplicitRecovery(
        chatId,
        text,
        msg.userId,
      );
      if (handled) {
        await this.flushPendingChat(getTaskConversationKey(chatId, msg.channelType, msg.conversationId));
        logger.info("Message classified as implicit recovery intent", { chatId });
        return;
      }
    } catch (err) {
      // Never let implicit recovery break normal routing — log and fall through.
      logger.warn("Implicit recovery probe failed; falling back to task submission", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.bufferTaskSubmission(msg);
  }

  private async sendStartupNotice(chatId: string): Promise<void> {
    if (!this.channel || !this.startupNoticeMarkdown || !this.notifiedChats || this.notifiedChats.has(chatId)) {
      return;
    }

    this.notifiedChats.add(chatId);

    try {
      await this.channel.sendMarkdown(chatId, this.startupNoticeMarkdown);
    } catch (error) {
      getLogger().warn("Failed to send startup capability notice", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private bufferTaskSubmission(msg: IncomingMessage): void {
    const conversationKey = getTaskConversationKey(msg.chatId, msg.channelType, msg.conversationId);
    const existing = this.pendingTaskBatches.get(conversationKey);
    if (existing) {
      existing.chatId = msg.chatId;
      existing.channelType = msg.channelType;
      existing.messages.push(msg);
      if (existing.messages.length >= this.maxBurstMessages) {
        void this.flushPendingChat(conversationKey);
        return;
      }
      this.scheduleFlush(existing);
      return;
    }

    const batch: PendingTaskBatch = {
      conversationKey,
      chatId: msg.chatId,
      channelType: msg.channelType,
      messages: [msg],
      timer: null,
    };
    this.pendingTaskBatches.set(conversationKey, batch);
    this.scheduleFlush(batch);
  }

  private scheduleFlush(batch: PendingTaskBatch): void {
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    batch.timer = setTimeout(() => {
      void this.flushPendingChat(batch.conversationKey);
    }, this.burstWindowMs);
  }

  private async flushPendingChat(conversationKey: string): Promise<void> {
    const batch = this.pendingTaskBatches.get(conversationKey);
    if (!batch) {
      return;
    }

    this.pendingTaskBatches.delete(conversationKey);
    if (batch.timer) {
      clearTimeout(batch.timer);
    }

    const prompt = this.buildBatchedPrompt(batch.messages);
    const attachments = batch.messages.flatMap((message) => message.attachments ?? []);
    const userId = [...batch.messages]
      .reverse()
      .find((message) => message.userId.trim().length > 0)
      ?.userId;
    const conversationId = [...batch.messages]
      .reverse()
      .find((message) => typeof message.conversationId === "string" && message.conversationId.trim().length > 0)
      ?.conversationId;
    const logger = getLogger();

    logger.info("Message submitted as task", {
      chatId: batch.chatId,
      channelType: batch.channelType,
      promptLength: prompt.length,
      burstCount: batch.messages.length,
    });

    const hasActiveConversationTask = this.hasActiveTaskForConversation(
      conversationKey,
      batch.chatId,
    );
    this.taskManager.submit(batch.chatId, batch.channelType, prompt, {
      attachments: attachments.length > 0 ? attachments : undefined,
      conversationId,
      userId,
    });

    await this.sendBurstOrQueueNotice(batch, hasActiveConversationTask);
  }

  private buildBatchedPrompt(messages: IncomingMessage[]): string {
    return buildBatchedPrompt(messages);
  }

  private hasActiveTaskForConversation(conversationKey: string, chatId: string): boolean {
    return this.taskManager.listActiveTasks(chatId).some((task) =>
      getTaskConversationKey(task.chatId, task.channelType, task.conversationId) === conversationKey,
    );
  }

  private buildQueueNotice(messages: readonly IncomingMessage[], queuedBehindActiveTask: boolean): string | null {
    return buildBurstOrQueueNotice(messages, queuedBehindActiveTask);
  }

  private async sendBurstOrQueueNotice(
    batch: PendingTaskBatch,
    queuedBehindActiveTask: boolean,
  ): Promise<void> {
    if (!this.channel) {
      return;
    }

    if (queuedBehindActiveTask) {
      const now = Date.now();
      const cooldownUntil = this.queueNoticeCooldowns.get(batch.conversationKey) ?? 0;
      if (now < cooldownUntil) {
        return;
      }
      this.pruneQueueNoticeCooldowns(now);
      this.queueNoticeCooldowns.set(batch.conversationKey, now + QUEUE_NOTICE_COOLDOWN_MS);
    }

    const notice = this.buildQueueNotice(batch.messages, queuedBehindActiveTask);
    if (!notice) {
      return;
    }

    try {
      await this.channel.sendText(batch.chatId, notice);
    } catch (error) {
      getLogger().warn("Failed to send queue/burst notice", {
        chatId: batch.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Bound `queueNoticeCooldowns`: drop expired entries (already inert), then if
   * still at/over the cap evict oldest-first (Map preserves insertion order).
   * Called before inserting a new cooldown so the map can never grow unbounded.
   */
  private pruneQueueNoticeCooldowns(now: number): void {
    for (const [key, until] of this.queueNoticeCooldowns) {
      if (until <= now) {
        this.queueNoticeCooldowns.delete(key);
      }
    }
    while (this.queueNoticeCooldowns.size >= MAX_QUEUE_NOTICE_COOLDOWNS) {
      const oldestKey = this.queueNoticeCooldowns.keys().next().value;
      if (oldestKey === undefined) break;
      this.queueNoticeCooldowns.delete(oldestKey);
    }
  }
}
