/**
 * Slack Channel Adapter for Strata Brain.
 * Implements IChannelAdapter using Slack Bolt framework.
 * Features: Message queue, rate limiting, retry logic, batch operations
 */

import { App, directMention, type SayFn } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import type { IncomingMessage, IChannelAdapter, ConfirmationRequest, Attachment } from "../channel.interface.js";
import { getLogger } from "../../utils/logger.js";
import { SlackRateLimiter, StreamingRateLimiter } from "./rate-limiter.js";
import { registerSlashCommands } from "./commands.js";
import {
  createConfirmationBlocks,
  createStreamingBlock,
  splitLongText,
} from "./blocks.js";
import { formatToSlackMrkdwn, truncateForSlack } from "./formatters.js";

interface SlackConfig {
  botToken: string;
  signingSecret: string;
  appToken?: string;
  socketMode?: boolean;
  allowedWorkspaces?: string[];
  allowedUserIds?: string[];
}

interface PendingConfirmation {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timestamp: number;
}

interface StreamingMessage {
  channelId: string;
  messageTs: string;
  accumulatedText: string;
  isFinalized: boolean;
}

interface QueuedMessage {
  id: string;
  type: 'text' | 'markdown' | 'blocks' | 'ephemeral' | 'thread' | 'file' | 'update';
  priority: number;
  channelId: string;
  content?: string;
  blocks?: KnownBlock[];
  userId?: string;
  threadTs?: string;
  fileData?: {
    file: Buffer;
    filename: string;
    initialComment?: string;
    title?: string;
  };
  updateData?: {
    messageTs: string;
    blocks?: KnownBlock[];
  };
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  retries: number;
  lastAttempt?: number;
}

// Slack message event type
interface SlackMessageEvent {
  type: string;
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  team?: string;
  bot_id?: string;
}

// Constants
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const QUEUE_PROCESS_INTERVAL_MS = 50;
const RATE_LIMIT_BACKOFF_MS = 5000;
const MESSAGE_BATCH_SIZE = 5;

export class SlackChannel implements IChannelAdapter {
  readonly name = "slack";
  
  private app: App | null = null;
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private readonly logger = getLogger();
  private readonly rateLimiter: SlackRateLimiter;
  private readonly streamingLimiter: StreamingRateLimiter;
  private readonly fileUploadLimiter: SlackRateLimiter;
  
  // Pending confirmations
  private readonly pendingConfirmations: Map<string, PendingConfirmation> = new Map();
  private readonly CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
  
  // Streaming messages
  private readonly streamingMessages: Map<string, StreamingMessage> = new Map();
  
  // Message queue for rate limit handling
  private messageQueue: QueuedMessage[] = [];
  private queueProcessing = false;
  private queueInterval: ReturnType<typeof setInterval> | null = null;
  private rateLimited = false;
  private rateLimitResetTime = 0;
  
  // Config
  private readonly config: SlackConfig;
  private isConnected = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private botUserId: string | null = null;

  constructor(config: SlackConfig) {
    this.config = config;
    this.rateLimiter = new SlackRateLimiter();
    this.streamingLimiter = new StreamingRateLimiter(2);
    this.fileUploadLimiter = new SlackRateLimiter({
      tier1: { requestsPerMinute: 10, burstAllowance: 2 },
    });
  }

  /**
   * Initialize and connect to Slack.
   */
  async connect(): Promise<void> {
    try {
      this.app = new App({
        token: this.config.botToken,
        signingSecret: this.config.signingSecret,
        appToken: this.config.appToken,
        socketMode: this.config.socketMode ?? true,
        port: this.config.socketMode ? undefined : 3000,
      });

      this.registerEventHandlers();
      registerSlashCommands(this.app);
      
      await this.app.start();
      
      this.isConnected = true;
      this.logger.info("Slack channel connected", {
        socketMode: this.config.socketMode ?? true,
      });

      // Get bot user ID
      await this.refreshBotUserId();
      
      // Start message queue processor
      this.startQueueProcessor();
      
      // Start health check
      this.startHealthCheck();

    } catch (error) {
      this.logger.error("Failed to connect to Slack", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Disconnect from Slack.
   */
  async disconnect(): Promise<void> {
    this.isConnected = false;
    
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Clean up pending confirmations
    const pendingConfirmations = Array.from(this.pendingConfirmations.entries());
    this.pendingConfirmations.clear();
    for (const [, pending] of pendingConfirmations) {
      pending.reject(new Error("Channel disconnected"));
    }

    if (this.app) {
      // @ts-expect-error - accessing internal property
      if (this.app.receiver?.stop) {
        // @ts-expect-error
        await this.app.receiver.stop();
      }
      this.app = null;
    }

    this.logger.info("Slack channel disconnected");
  }

  /**
   * Register message handler.
   */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // ---- Message Queue System ----

  private startQueueProcessor(): void {
    this.queueInterval = setInterval(() => {
      this.processMessageQueue();
    }, QUEUE_PROCESS_INTERVAL_MS);
  }

  private enqueueMessage(
    type: QueuedMessage['type'],
    channelId: string,
    data: Omit<Omit<QueuedMessage, 'id' | 'type' | 'channelId' | 'priority' | 'retries'>, 'resolve' | 'reject'>,
    priority: number = 5
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const message: QueuedMessage = {
        ...data,
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        type,
        channelId,
        priority,
        retries: 0,
        resolve,
        reject,
      };
      
      // Insert by priority
      const insertIndex = this.messageQueue.findIndex(m => m.priority > priority);
      if (insertIndex === -1) {
        this.messageQueue.push(message);
      } else {
        this.messageQueue.splice(insertIndex, 0, message);
      }
    });
  }

  private async processMessageQueue(): Promise<void> {
    if (this.queueProcessing || this.messageQueue.length === 0) return;
    if (this.rateLimited && Date.now() < this.rateLimitResetTime) return;
    
    this.queueProcessing = true;
    this.rateLimited = false;

    // Process batch of messages
    const batchSize = Math.min(MESSAGE_BATCH_SIZE, this.messageQueue.length);
    const processedIds: string[] = [];
    
    for (let i = 0; i < batchSize; i++) {
      const message = this.messageQueue[i];
      if (!message) break;

      try {
        await this.processQueuedMessage(message);
        processedIds.push(message.id);
        message.resolve(undefined);
      } catch (error) {
        if (this.isRateLimitError(error)) {
          const retryAfter = this.extractRetryAfter(error) || RATE_LIMIT_BACKOFF_MS;
          this.rateLimited = true;
          this.rateLimitResetTime = Date.now() + retryAfter;
          this.logger.warn("Slack rate limited", { retryAfter });
          break;
        }
        
        // Retry with exponential backoff
        message.retries++;
        if (message.retries >= MAX_RETRIES) {
          message.reject(error instanceof Error ? error : new Error(String(error)));
          processedIds.push(message.id);
        } else {
          const delay = Math.min(
            RETRY_BASE_DELAY_MS * Math.pow(2, message.retries - 1),
            MAX_RETRY_DELAY_MS
          );
          
          // Move to end of queue with delay
          setTimeout(() => {
            // Message will be retried in next cycle
          }, delay);
          processedIds.push(message.id);
          const msg = this.messageQueue.splice(i, 1)[0];
          if (msg) {
            this.messageQueue.push(msg);
            i--; // Adjust index
          }
        }
      }
    }

    // Remove processed messages
    this.messageQueue = this.messageQueue.filter(m => !processedIds.includes(m.id));
    this.queueProcessing = false;
  }

  private async processQueuedMessage(msg: QueuedMessage): Promise<void> {
    if (!this.app?.client) throw new Error("Slack client not initialized");

    switch (msg.type) {
      case 'text':
        await this.rateLimiter.acquire("chat.postMessage", 1);
        await this.app.client.chat.postMessage({
          channel: msg.channelId,
          text: truncateForSlack(msg.content!),
        });
        break;

      case 'markdown':
        await this.rateLimiter.acquire("chat.postMessage", 1);
        await this.app.client.chat.postMessage({
          channel: msg.channelId,
          text: truncateForSlack(msg.content!),
          mrkdwn: true,
        });
        break;

      case 'blocks':
        await this.rateLimiter.acquire("chat.postMessage", 1);
        await this.app.client.chat.postMessage({
          channel: msg.channelId,
          blocks: msg.blocks?.slice(0, 50),
          text: msg.content || "Message with blocks",
        });
        break;

      case 'ephemeral':
        await this.rateLimiter.acquire("chat.postEphemeral", 1);
        await this.app.client.chat.postEphemeral({
          channel: msg.channelId,
          user: msg.userId!,
          text: truncateForSlack(msg.content!),
          blocks: msg.blocks?.slice(0, 50),
        });
        break;

      case 'thread':
        await this.rateLimiter.acquire("chat.postMessage", 1);
        await this.app.client.chat.postMessage({
          channel: msg.channelId,
          thread_ts: msg.threadTs,
          text: truncateForSlack(msg.content!),
          blocks: msg.blocks?.slice(0, 50),
        });
        break;

      case 'file': {
        await this.fileUploadLimiter.acquire("files.upload", 1);
        const fileData = {
          channel_id: msg.channelId,
          file: msg.fileData!.file,
          filename: msg.fileData!.filename,
          initial_comment: msg.fileData!.initialComment,
          title: msg.fileData!.title,
          thread_ts: msg.threadTs,
        };
        await this.app.client.files.uploadV2(fileData as Parameters<WebClient['files']['uploadV2']>[0]);
        break;
      }

      case 'update':
        await this.rateLimiter.acquire("chat.update", 1);
        await this.app.client.chat.update({
          channel: msg.channelId,
          ts: msg.updateData!.messageTs,
          text: truncateForSlack(msg.content!),
          blocks: msg.updateData!.blocks,
        });
        break;
    }
  }

  private isRateLimitError(error: unknown): boolean {
    if (error && typeof error === 'object') {
      const code = (error as { code?: string }).code;
      const statusCode = (error as { statusCode?: number }).statusCode;
      return code === 'slack_sdk_rate_limit_error' || statusCode === 429;
    }
    return false;
  }

  private extractRetryAfter(error: unknown): number | null {
    if (error && typeof error === 'object') {
      const retryAfter = (error as { retryAfter?: number }).retryAfter;
      if (typeof retryAfter === 'number') {
        return retryAfter * 1000; // Convert to ms
      }
    }
    return null;
  }

  // ---- Public API ----

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.app?.client) throw new Error("Slack client not initialized");
    await this.enqueueMessage('text', chatId, { content: text }, 5);
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    if (!this.app?.client) throw new Error("Slack client not initialized");
    const formattedText = formatToSlackMrkdwn(markdown);
    await this.enqueueMessage('markdown', chatId, { content: formattedText }, 5);
  }

  async sendBlockMessage(chatId: string, blocks: KnownBlock[], text?: string): Promise<void> {
    if (!this.app?.client) throw new Error("Slack client not initialized");
    await this.enqueueMessage('blocks', chatId, { blocks, content: text }, 4);
  }

  async sendEphemeral(channelId: string, userId: string, text: string, blocks?: KnownBlock[]): Promise<void> {
    if (!this.app?.client) throw new Error("Slack client not initialized");
    await this.enqueueMessage('ephemeral', channelId, { content: text, blocks, userId }, 6);
  }

  async sendThreadReply(channelId: string, threadTs: string, text: string, blocks?: KnownBlock[]): Promise<void> {
    if (!this.app?.client) throw new Error("Slack client not initialized");
    await this.enqueueMessage('thread', channelId, { content: text, blocks, threadTs }, 3);
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // Slack doesn't have direct typing indicator for bots
    return Promise.resolve();
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    if (!this.app?.client) throw new Error("Slack client not initialized");

    const actionIdPrefix = `confirm_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const blocks = createConfirmationBlocks(req.question, req.details, actionIdPrefix);

    await this.rateLimiter.acquire("chat.postMessage", 1);

    const result = await this.app.client.chat.postMessage({
      channel: req.chatId,
      blocks,
      text: `Confirmation required: ${req.question}`,
    });

    if (!result.ts) throw new Error("Failed to send confirmation message");

    return new Promise((resolve, reject) => {
      const confirmation: PendingConfirmation = {
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.pendingConfirmations.set(actionIdPrefix, confirmation);

      setTimeout(() => {
        if (this.pendingConfirmations.has(actionIdPrefix)) {
          this.pendingConfirmations.delete(actionIdPrefix);
          reject(new Error("Confirmation timeout"));
        }
      }, this.CONFIRMATION_TIMEOUT_MS);
    });
  }

  async openModal(triggerId: string, view: Parameters<WebClient["views"]["open"]>[0]["view"]): Promise<void> {
    if (!this.app?.client) throw new Error("Slack client not initialized");
    await this.rateLimiter.acquire("views.open", 3);
    await this.app.client.views.open({ trigger_id: triggerId, view });
  }

  async uploadFile(
    channelId: string,
    file: Buffer,
    filename: string,
    options?: {
      threadTs?: string;
      initialComment?: string;
      title?: string;
    }
  ): Promise<void> {
    if (!this.app?.client) throw new Error("Slack client not initialized");
    await this.enqueueMessage('file', channelId, {
      fileData: {
        file,
        filename,
        initialComment: options?.initialComment,
        title: options?.title,
      },
      threadTs: options?.threadTs,
    }, 2);
  }

  async startStreamingMessage(chatId: string): Promise<string> {
    if (!this.app?.client) throw new Error("Slack client not initialized");

    const streamId = `stream_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    await this.rateLimiter.acquire("chat.postMessage", 1);

    const result = await this.app.client.chat.postMessage({
      channel: chatId,
      blocks: createStreamingBlock("⏳ Thinking..."),
      text: "⏳ Thinking...",
    });

    if (!result.ts) throw new Error("Failed to start streaming message");

    this.streamingMessages.set(streamId, {
      channelId: chatId,
      messageTs: result.ts,
      accumulatedText: "",
      isFinalized: false,
    });

    return streamId;
  }

  async updateStreamingMessage(_chatId: string, streamId: string, accumulatedText: string): Promise<void> {
    if (!this.app?.client) return;

    const stream = this.streamingMessages.get(streamId);
    if (!stream || stream.isFinalized) return;

    if (!this.streamingLimiter.shouldUpdate()) {
      stream.accumulatedText = accumulatedText;
      return;
    }

    await this.streamingLimiter.acquire();
    stream.accumulatedText = accumulatedText;

    try {
      await this.app.client.chat.update({
        channel: stream.channelId,
        ts: stream.messageTs,
        blocks: createStreamingBlock(accumulatedText),
        text: accumulatedText.substring(0, 100) || "Streaming...",
      });
    } catch (error) {
      this.logger.warn("Failed to update streaming message", {
        error: error instanceof Error ? error.message : String(error),
        streamId,
      });
    }
  }

  async finalizeStreamingMessage(_chatId: string, streamId: string, finalText: string): Promise<void> {
    if (!this.app?.client) return;

    const stream = this.streamingMessages.get(streamId);
    if (!stream || stream.isFinalized) return;

    stream.isFinalized = true;
    stream.accumulatedText = finalText;

    const formattedText = formatToSlackMrkdwn(finalText);
    const chunks = splitLongText(formattedText, 2900);

    try {
      await this.app.client.chat.update({
        channel: stream.channelId,
        ts: stream.messageTs,
        text: chunks[0] || finalText.substring(0, 2900),
        blocks: undefined,
      });

      for (let i = 1; i < chunks.length; i++) {
        const text = chunks[i] ?? "";
        await this.rateLimiter.acquire("chat.postMessage", 1);
        await this.app.client.chat.postMessage({
          channel: stream.channelId,
          thread_ts: stream.messageTs,
          text,
          attachments: [],
        });
      }

      this.streamingMessages.delete(streamId);
    } catch (error) {
      this.logger.error("Failed to finalize streaming message", {
        error: error instanceof Error ? error.message : String(error),
        streamId,
      });
    }
  }

  isHealthy(): boolean {
    return this.isConnected && this.app !== null;
  }

  // ---- Private Methods ----

  private async refreshBotUserId(): Promise<void> {
    if (!this.app?.client) return;
    try {
      const result = await this.app.client.auth.test();
      this.botUserId = result.user_id || null;
    } catch {
      this.botUserId = null;
    }
  }

  private registerEventHandlers(): void {
    if (!this.app) return;

    this.app.message(async ({ message, say }) => {
      await this.handleIncomingMessage(message as SlackMessageEvent, say);
    });

    this.app.message(directMention as unknown as string, async ({ message, say }) => {
      await this.handleIncomingMessage(message as SlackMessageEvent, say);
    });

    this.app.action(/confirm_.*/, async ({ ack, body, action }) => {
      await ack();

      const actionId = (action as { action_id: string }).action_id;
      const value = (action as { value: string }).value;
      
      const prefix = actionId.replace(/_(approve|deny)$/, "");
      const pending = this.pendingConfirmations.get(prefix);

      if (pending) {
        this.pendingConfirmations.delete(prefix);
        pending.resolve(value === "approve" ? "approve" : "deny");

        if (this.app?.client && "channel" in body && "message" in body) {
          const channelId = (body as { channel: { id: string } }).channel.id;
          const ts = (body as { message: { ts: string } }).message.ts;
          
          await this.app.client.chat.update({
            channel: channelId,
            ts,
            text: value === "approve" ? "✅ Approved" : "❌ Denied",
            blocks: [{
              type: "section",
              text: {
                type: "mrkdwn",
                text: value === "approve" 
                  ? "✅ *Approved* - The operation will proceed."
                  : "❌ *Denied* - The operation was cancelled.",
              },
            }],
          });
        }
      }
    });

    this.app.error(async (error) => {
      this.logger.error("Slack app error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleIncomingMessage(
    message: SlackMessageEvent,
    say: SayFn
  ): Promise<void> {
    if (message.subtype === "bot_message" || !message.text) return;

    const userId = message.user;
    const teamId = message.team || "";
    
    if (this.config.allowedWorkspaces?.length && !this.config.allowedWorkspaces.includes(teamId)) {
      this.logger.warn("Unauthorized workspace", { teamId, userId });
      await say("❌ This workspace is not authorized to use Strata Brain.");
      return;
    }

    if (this.config.allowedUserIds?.length && (!userId || !this.config.allowedUserIds.includes(userId))) {
      this.logger.warn("Unauthorized user", { userId, teamId });
      await say("❌ You are not authorized to use Strata Brain.");
      return;
    }

    const channelId = message.channel;
    if (!channelId || !userId) {
      this.logger.warn("Missing channel or user info in message");
      return;
    }

    const threadTs = message.thread_ts;
    let text = message.text;
    
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
    }

    if (!text) return;

    const attachments: Attachment[] = [];

    const incomingMessage: IncomingMessage = {
      channelType: "slack",
      chatId: channelId,
      userId: userId,
      text: text,
      attachments,
      replyTo: threadTs,
      timestamp: new Date(Number(message.ts) * 1000),
    };

    this.logger.debug("Received Slack message", { userId, channelId, textLength: text.length });

    if (this.messageHandler) {
      try {
        await this.messageHandler(incomingMessage);
      } catch (error) {
        this.logger.error("Error handling message", {
          error: error instanceof Error ? error.message : String(error),
        });
        await say("❌ Sorry, I encountered an error processing your message.");
      }
    }
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      if (!this.isConnected) return;

      try {
        if (this.app?.client) {
          await this.app.client.auth.test();
        }
      } catch (error) {
        this.logger.error("Health check failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.isConnected = false;
      }

      // Clean up old pending confirmations
      const now = Date.now();
      for (const [key, pending] of this.pendingConfirmations) {
        if (now - pending.timestamp > this.CONFIRMATION_TIMEOUT_MS) {
          pending.reject(new Error("Confirmation timeout"));
          this.pendingConfirmations.delete(key);
        }
      }
    }, 30000);
  }
}

export function createSlackChannelFromEnv(): SlackChannel | null {
  const botToken = process.env["SLACK_BOT_TOKEN"];
  const signingSecret = process.env["SLACK_SIGNING_SECRET"];
  const appToken = process.env["SLACK_APP_TOKEN"];
  const socketMode = process.env["SLACK_SOCKET_MODE"] === "true";

  if (!botToken || !signingSecret) {
    getLogger().warn("Slack configuration incomplete", {
      hasBotToken: !!botToken,
      hasSigningSecret: !!signingSecret,
    });
    return null;
  }

  const allowedWorkspaces = process.env["ALLOWED_SLACK_WORKSPACES"]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

  const allowedUserIds = process.env["ALLOWED_SLACK_USER_IDS"]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

  return new SlackChannel({
    botToken,
    signingSecret,
    appToken,
    socketMode,
    allowedWorkspaces,
    allowedUserIds,
  });
}
