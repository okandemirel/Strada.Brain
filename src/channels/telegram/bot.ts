import { randomUUID } from "node:crypto";
import { Bot, Context, InlineKeyboard } from "grammy";
import type {
  IChannelAdapter,
  IncomingMessage,
  ConfirmationRequest,
} from "../channel.interface.js";
import { AuthManager } from "../../security/auth.js";
import { getLogger } from "../../utils/logger.js";
import type { FileDiff, BatchDiff } from "../../utils/diff-generator.js";
import { formatDiffForTelegram, formatBatchDiffForTelegram } from "../../utils/diff-formatter.js";

/**
 * Options for diff confirmation requests
 */
export interface DiffConfirmationOptions {
  /** Maximum lines to show in diff preview */
  maxPreviewLines?: number;
  /** Whether this is a destructive operation */
  isDestructive?: boolean;
  /** Operation description */
  operation?: string;
  /** Additional context message */
  contextMessage?: string;
}

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Pending diff confirmation state
 */
interface PendingDiffConfirmation {
  resolve: (value: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
  diffType: "single" | "batch";
  fullDiff?: string;
  chatId: string;
  operation?: string;
}

/**
 * Telegram channel adapter using grammy.
 * Handles message routing, auth, and formatting for Telegram.
 */
export class TelegramChannel implements IChannelAdapter {
  readonly name = "telegram";

  private readonly bot: Bot;
  private readonly auth: AuthManager;
  private handler: MessageHandler | null = null;
  private readonly pendingConfirmations = new Map<
    string,
    { resolve: (value: string) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly pendingDiffConfirmations = new Map<string, PendingDiffConfirmation>();

  constructor(token: string, auth: AuthManager) {
    this.bot = new Bot(token);
    this.auth = auth;
    this.setupMiddleware();
    this.setupHandlers();
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    const logger = getLogger();
    logger.info("Starting Telegram bot...");

    // Set bot commands for the menu
    await this.bot.api.setMyCommands([
      { command: "start", description: "Start Strada Brain" },
      { command: "status", description: "Show project status" },
      { command: "analyze", description: "Analyze project structure" },
      { command: "help", description: "Show help" },
    ]);

    this.bot.start({
      onStart: (info) => {
        logger.info(`Telegram bot started: @${info.username}`);
      },
    });
  }

  async disconnect(): Promise<void> {
    getLogger().info("Stopping Telegram bot...");
    this.bot.stop();

    // Clean up pending confirmations
    for (const [, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timeout);
      pending.resolve("cancelled");
    }
    this.pendingConfirmations.clear();

    // Clean up pending diff confirmations
    for (const [, pending] of this.pendingDiffConfirmations) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingDiffConfirmations.clear();
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(parseInt(chatId, 10), text);
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(parseInt(chatId, 10), markdown, {
        parse_mode: "Markdown",
      });
    } catch {
      // Fallback to plain text if markdown fails
      await this.bot.api.sendMessage(parseInt(chatId, 10), markdown);
    }
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(parseInt(chatId, 10), "typing");
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const chatIdNum = parseInt(req.chatId, 10);
    const confirmId = `confirm_${randomUUID()}`;

    const keyboard = new InlineKeyboard();
    for (const option of req.options) {
      keyboard.text(option, `${confirmId}:${option}`);
    }

    let message = req.question;
    if (req.details) {
      message += `\n\n${req.details}`;
    }

    await this.bot.api.sendMessage(chatIdNum, message, {
      reply_markup: keyboard,
    });

    return new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingConfirmations.delete(confirmId);
        resolve("timeout");
      }, 120_000); // 2 minute timeout

      this.pendingConfirmations.set(confirmId, { resolve, timeout });
    });
  }

  isHealthy(): boolean {
    return this.bot.isInited();
  }

  /**
   * Request confirmation for a single file diff with inline preview.
   * Shows the diff in a code block with approve/reject buttons.
   */
  async requestDiffConfirmation(
    chatId: string,
    diff: FileDiff,
    options: DiffConfirmationOptions = {}
  ): Promise<boolean> {
    const chatIdNum = parseInt(chatId, 10);
    const confirmId = `diff_${randomUUID()}`;
    const { 
      maxPreviewLines = 50, 
      isDestructive = false,
      operation = "Apply changes",
      contextMessage
    } = options;

    // Format the diff for Telegram
    const formattedDiff = formatDiffForTelegram(diff, {
      maxLines: maxPreviewLines,
    });

    // Store full diff for "view full" functionality
    const fullDiff = formatDiffForTelegram(diff, { maxLines: 500 });

    // Build message
    let message = "";
    if (isDestructive) {
      message += "⚠️ *Destructive Operation*\n\n";
    }
    if (contextMessage) {
      message += `${contextMessage}\n\n`;
    }
    message += `*${operation}*\n\n`;
    message += formattedDiff;

    // Create inline keyboard with diff-specific actions
    const keyboard = new InlineKeyboard()
      .text("✅ Approve", `${confirmId}:approve`)
      .text("❌ Reject", `${confirmId}:reject`)
      .row()
      .text("📋 View Full", `${confirmId}:view_full`);

    await this.bot.api.sendMessage(chatIdNum, message, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    });

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingDiffConfirmations.delete(confirmId);
        resolve(false);
      }, 300_000); // 5 minute timeout for diffs

      this.pendingDiffConfirmations.set(confirmId, {
        resolve,
        timeout,
        diffType: "single",
        fullDiff,
        chatId,
        operation,
      });
    });
  }

  /**
   * Request confirmation for a batch of file changes.
   * Shows summary and allows viewing individual files.
   */
  async requestBatchDiffConfirmation(
    chatId: string,
    batchDiff: BatchDiff,
    options: DiffConfirmationOptions = {}
  ): Promise<boolean> {
    const chatIdNum = parseInt(chatId, 10);
    const confirmId = `batch_${randomUUID()}`;
    const { 
      maxPreviewLines = 40, 
      isDestructive = false,
      operation = "Apply changes",
      contextMessage
    } = options;

    // Format batch diff
    const formattedBatch = formatBatchDiffForTelegram(batchDiff, {
      maxLines: maxPreviewLines,
    });

    // Build message
    let message = "";
    if (isDestructive) {
      message += "⚠️ *Batch Operation*\n\n";
    }
    if (contextMessage) {
      message += `${contextMessage}\n\n`;
    }
    message += `*${operation}*\n\n`;
    message += formattedBatch;

    // For batches, add options to view individual files
    const keyboard = new InlineKeyboard()
      .text("✅ Approve All", `${confirmId}:approve`)
      .text("❌ Reject", `${confirmId}:reject`)
      .row();

    // Add buttons for first 3 individual files
    batchDiff.files.slice(0, 3).forEach((file, index) => {
      const emoji = file.isNew ? "➕" : file.isDeleted ? "🗑️" : "📝";
      keyboard.text(`${emoji} ${file.newPath.split("/").pop()}`, `${confirmId}:file_${index}`);
    });

    if (batchDiff.files.length > 3) {
      keyboard.row().text(`📁 View All ${batchDiff.files.length} Files`, `${confirmId}:view_all`);
    }

    await this.bot.api.sendMessage(chatIdNum, message, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
    });

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingDiffConfirmations.delete(confirmId);
        resolve(false);
      }, 300_000);

      this.pendingDiffConfirmations.set(confirmId, {
        resolve,
        timeout,
        diffType: "batch",
        chatId,
        operation,
      });
    });
  }

  /**
   * Start a streaming message by sending a placeholder.
   * Returns the message ID for subsequent edits.
   */
  async startStreamingMessage(chatId: string): Promise<string | undefined> {
    try {
      const msg = await this.bot.api.sendMessage(
        parseInt(chatId, 10),
        "..."
      );
      return String(msg.message_id);
    } catch {
      return undefined;
    }
  }

  /**
   * Update the streaming message with accumulated text.
   * Throttled to avoid Telegram rate limits (max ~30 edits/sec per bot).
   */
  async updateStreamingMessage(
    chatId: string,
    streamId: string,
    accumulatedText: string
  ): Promise<void> {
    try {
      const text = accumulatedText || "...";
      await this.bot.api.editMessageText(
        parseInt(chatId, 10),
        parseInt(streamId, 10),
        text
      );
    } catch {
      // Edit can fail if text hasn't actually changed — safe to ignore
    }
  }

  /**
   * Finalize the streaming message with the complete markdown text.
   */
  async finalizeStreamingMessage(
    chatId: string,
    streamId: string,
    finalText: string
  ): Promise<void> {
    try {
      await this.bot.api.editMessageText(
        parseInt(chatId, 10),
        parseInt(streamId, 10),
        finalText,
        { parse_mode: "Markdown" }
      );
    } catch {
      // Fallback: try without markdown
      try {
        await this.bot.api.editMessageText(
          parseInt(chatId, 10),
          parseInt(streamId, 10),
          finalText
        );
      } catch {
        // Last resort: send a new message
        await this.sendMarkdown(chatId, finalText);
      }
    }
  }

  private setupMiddleware(): void {
    const logger = getLogger();

    // Auth middleware - block unauthorized users
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.auth.isTelegramUserAllowed(userId)) {
        await ctx.reply(
          "You are not authorized to use Strada Brain. Contact the administrator."
        );
        return;
      }

      await next();
    });

    // Error handler
    this.bot.catch((err) => {
      logger.error("Telegram bot error", { error: err.message });
    });
  }

  private setupHandlers(): void {
    // Handle callback queries (confirmations)
    this.bot.on("callback_query:data", async (ctx) => {
      // H3: Auth check on callback queries
      const userId = ctx.from?.id;
      if (!userId || !this.auth.isTelegramUserAllowed(userId)) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" });
        return;
      }

      const data = ctx.callbackQuery.data;
      const separatorIndex = data.indexOf(":");
      if (separatorIndex === -1) return;

      const confirmId = data.substring(0, separatorIndex);
      const selectedOption = data.substring(separatorIndex + 1);

      // Handle regular confirmations
      const pending = this.pendingConfirmations.get(confirmId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingConfirmations.delete(confirmId);
        pending.resolve(selectedOption);
        await ctx.answerCallbackQuery({ text: `Selected: ${selectedOption}` });
        return;
      }

      // Handle diff confirmations
      const diffPending = this.pendingDiffConfirmations.get(confirmId);
      if (diffPending) {
        await this.handleDiffCallback(ctx, confirmId, selectedOption, diffPending);
      }
    });

    // Handle /start command
    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "Welcome to *Strada Brain* - Your AI-powered Unity development assistant.\n\n" +
          "Send me any message to start working with your Strada.Core project.\n\n" +
          "Commands:\n" +
          "/status - Show project status\n" +
          "/analyze - Analyze project structure\n" +
          "/help - Show help",
        { parse_mode: "Markdown" }
      );
    });

    // Handle /help command
    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        "*Strada Brain Help*\n\n" +
          "I can help you with your Unity/Strada.Core project:\n\n" +
          "- Analyze project architecture\n" +
          "- Create modules, systems, components\n" +
          "- Show DI dependency graphs\n" +
          "- Trace EventBus message flow\n" +
          "- Generate Strada-convention code\n" +
          "- Read and modify source files\n\n" +
          "Just describe what you need in natural language!",
        { parse_mode: "Markdown" }
      );
    });

    // Handle all text messages -> route to orchestrator
    this.bot.on("message:text", async (ctx) => {
      await this.routeMessage(ctx);
    });
  }

  private async handleDiffCallback(
    ctx: Context,
    confirmId: string,
    action: string,
    pending: PendingDiffConfirmation
  ): Promise<void> {
    switch (action) {
      case "approve":
        clearTimeout(pending.timeout);
        this.pendingDiffConfirmations.delete(confirmId);
        pending.resolve(true);
        await ctx.answerCallbackQuery({ text: "✅ Approved" });
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
        await ctx.editMessageText(`✅ *${pending.operation}* approved\.`);
        break;

      case "reject":
        clearTimeout(pending.timeout);
        this.pendingDiffConfirmations.delete(confirmId);
        pending.resolve(false);
        await ctx.answerCallbackQuery({ text: "❌ Rejected" });
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
        await ctx.editMessageText(`❌ *${pending.operation}* rejected\.`);
        break;

      case "view_full":
        await ctx.answerCallbackQuery({ text: "Loading full diff..." });
        if (pending.fullDiff) {
          // Send full diff as a new message
          await ctx.reply(pending.fullDiff, { parse_mode: "MarkdownV2" });
        }
        break;

      case "view_all":
        await ctx.answerCallbackQuery({ text: "Loading all files..." });
        // This would need the batch diff stored - for now just acknowledge
        await ctx.reply("📁 All files would be shown here in full implementation");
        break;

      default:
        if (action.startsWith("file_")) {
          await ctx.answerCallbackQuery({ text: "Loading file details..." });
          // Handle individual file view
          await ctx.reply(`📄 File details would be shown here`);
        } else {
          await ctx.answerCallbackQuery({ text: "Unknown action" });
        }
    }
  }

  private async routeMessage(ctx: Context): Promise<void> {
    if (!this.handler) {
      await ctx.reply("Brain is not ready yet. Please try again later.");
      return;
    }

    const msg: IncomingMessage = {
      channelType: "telegram",
      chatId: String(ctx.chat?.id ?? ""),
      userId: String(ctx.from?.id ?? ""),
      text: ctx.message?.text ?? "",
      replyTo: ctx.message?.reply_to_message?.message_id?.toString(),
      timestamp: new Date(
        (ctx.message?.date ?? Math.floor(Date.now() / 1000)) * 1000
      ),
    };

    try {
      await ctx.api.sendChatAction(parseInt(msg.chatId, 10), "typing");
      await this.handler(msg);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      getLogger().error("Error handling message", {
        chatId: msg.chatId,
        error: errMsg,
      });
      await ctx.reply(
        "An error occurred while processing your request. Please try again."
      );
    }
  }
}
