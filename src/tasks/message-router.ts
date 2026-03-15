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
import { CommandHandler } from "./command-handler.js";
import { detectCommand } from "./command-detector.js";
import { getLogger } from "../utils/logger.js";

export class MessageRouter {
  private notifiedChats: Set<string> | null = new Set<string>();
  private startupNoticeMarkdown?: string;

  constructor(
    private readonly taskManager: TaskManager,
    private readonly commandHandler: CommandHandler,
    private readonly channel?: IChannelSender,
    startupNotices: string[] = [],
  ) {
    const notices = [...new Set(startupNotices.map((notice) => notice.trim()).filter(Boolean))];
    if (notices.length > 0) {
      this.startupNoticeMarkdown = [
        "*System Status*",
        "",
        ...notices.map((notice) => `- ${notice}`),
      ].join("\n");
    }

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
    const { chatId, text, channelType } = msg;

    if (!text.trim()) return;

    await this.sendStartupNotice(chatId);

    const classification = detectCommand(text);

    if (classification.type === "command") {
      logger.debug("Message classified as command", {
        chatId,
        command: classification.command,
        args: classification.args,
      });

      await this.commandHandler.handle(chatId, classification.command, classification.args);
      return;
    }

    // Default: submit as background task
    logger.info("Message submitted as task", {
      chatId,
      channelType,
      promptLength: text.length,
    });

    this.taskManager.submit(chatId, channelType, text, { attachments: msg.attachments });
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
}
