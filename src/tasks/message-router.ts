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
import type { TaskManager } from "./task-manager.js";
import { CommandHandler } from "./command-handler.js";
import { detectCommand } from "./command-detector.js";
import { getLogger } from "../utils/logger.js";

export class MessageRouter {
  constructor(
    private readonly taskManager: TaskManager,
    private readonly commandHandler: CommandHandler,
  ) {}

  /**
   * Route an incoming message to the appropriate handler.
   * This bypasses the session lock for commands so /status works during long tasks.
   */
  async route(msg: IncomingMessage): Promise<void> {
    const logger = getLogger();
    const { chatId, text, channelType } = msg;

    if (!text.trim()) return;

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

    this.taskManager.submit(chatId, channelType, text);
  }
}
