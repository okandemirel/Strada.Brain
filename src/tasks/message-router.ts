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
import { getLogger } from "../utils/logger.js";

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
  private readonly burstWindowMs: number;
  private readonly maxBurstMessages: number;

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

    // Auto-clear startup notice state after 60s — no need to track chats forever
    setTimeout(() => {
      this.notifiedChats = null;
      this.startupNoticeMarkdown = undefined;
    }, 60_000);
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

    this.taskManager.submit(batch.chatId, batch.channelType, prompt, {
      attachments: attachments.length > 0 ? attachments : undefined,
      conversationId,
      userId,
    });
  }

  private buildBatchedPrompt(messages: IncomingMessage[]): string {
    if (messages.length === 1) {
      return messages[0]!.text;
    }

    const parts = messages.map((message, index) =>
      `[User message ${index + 1}]\n${message.text.trim()}`,
    );
    return [
      `The user sent ${messages.length} consecutive messages before you responded. Treat them as one ordered request.`,
      "",
      ...parts,
    ].join("\n\n");
  }
}
