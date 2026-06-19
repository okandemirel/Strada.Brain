import { randomUUID } from "node:crypto";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ThreadChannel,
  TextChannel,
  Message,
  type Interaction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type {
  IChannelAdapter,
  IncomingMessage,
  ConfirmationRequest,
  Attachment,
} from "../channel.interface.js";
import { limitIncomingText } from "../channel-messages.interface.js";
import { AuthManager } from "../../security/auth.js";
import { getLogger } from "../../utils/logger.js";
import { downloadMedia, mimeToAttachmentType, validateMediaAttachment, validateMagicBytes } from "../../utils/media-processor.js";
import { classifyErrorMessage } from "../../utils/error-messages.js";
import { DiscordRateLimiter } from "./rate-limiter.js";
import { formatToDiscordMarkdown, truncateForDiscord } from "./formatters.js";
import { chunkText } from "../chunk-text.js";
import type { SlashCommand } from "./commands.js";
import { MessageQueue } from "../message-queue.js";
import { StreamingBuffer } from "../streaming-buffer.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/** Callback for feedback reactions (thumbs up/down) from channel adapters. */
type FeedbackReactionCallback = (
  type: "thumbs_up" | "thumbs_down",
  instinctIds: string[],
  userId?: string,
  source?: "reaction" | "button",
) => void;

interface StreamingMessageState {
  message: Message;
  /** Throttled streaming buffer that manages edits and finalization. */
  buffer: StreamingBuffer;
}

/** Payload-only queue message.  resolve/reject/retries/enqueuedAt are now
 * managed by the shared MessageQueue infrastructure. */
interface QueuedMessage {
  id: string;
  type: 'text' | 'markdown' | 'embed' | 'typing' | 'thread' | 'confirmation';
  chatId: string;
  content?: string;
  embedOptions?: Parameters<DiscordChannel['sendRichEmbed']>[1];
  threadOptions?: { name: string; autoArchiveDuration?: 60 | 1440 | 4320 | 10080 };
  confirmationRequest?: ConfirmationRequest;
  /** Pre-generated confirmation id, set for 'confirmation' items so the long-lived
   * response promise can be registered before the prompt is dispatched. */
  confirmId?: string;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const QUEUE_PROCESS_INTERVAL_MS = 100;
const RATE_LIMIT_BACKOFF_MS = 5000;
const MESSAGE_TIMEOUT_MS = 30_000;
/** Discord per-message hard limit is 2000 chars; split long content into chunks. */
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/**
 * Discord channel adapter using discord.js.
 * Features:
 * - Message queue with prioritization
 * - Exponential backoff retry
 * - Optimized rate limiting
 * - Connection pooling
 */
export class DiscordChannel implements IChannelAdapter {
  readonly name = "discord";

  private readonly client: Client;
  private readonly auth: AuthManager;
  private readonly rateLimiter: DiscordRateLimiter;
  private readonly token: string;
  private readonly guildId?: string;
  private handler: MessageHandler | null = null;
  private readonly pendingConfirmations = new Map<
    string,
    {
      resolve: (value: string) => void;
      timeout: ReturnType<typeof setTimeout>;
      chatId: string;
      userId?: string;
    }
  >();
  private readonly streamingMessages = new Map<string, StreamingMessageState>();
  /** Pending slash-command reply callbacks keyed by a unique per-interaction token
   * (the interaction id), falling back to chatId when no token is present. Keying
   * by token prevents concurrent slash commands in the same channel from
   * overwriting each other's callback (which would route a response to the wrong
   * interaction). */
  private readonly pendingReplyCallbacks = new Map<string, (response: string) => Promise<void>>();
  /** chatId -> FIFO-ordered list of pending reply tokens, so the send path (which
   * only knows chatId) can resolve the oldest waiting interaction for a channel. */
  private readonly replyTokensByChatId = new Map<string, string[]>();
  private isConnected = false;
  private slashCommands: SlashCommand[] = [];
  /** Set true once disconnect() runs so reconnection backoff stops. */
  private shuttingDown = false;
  /** Pending reconnection backoff timer (cleared on disconnect). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly RECONNECT_BASE_DELAY_MS = 1000;
  private static readonly RECONNECT_MAX_DELAY_MS = 60_000;

  /** Shared queue infrastructure — FIFO ordering, timeout eviction, retry. */
  private readonly queue: MessageQueue<QueuedMessage>;
  private queueInterval: NodeJS.Timeout | null = null;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;

  /** Backward-compatible accessor — used internally by /status and by tests. */
  protected get messageQueue(): MessageQueue<QueuedMessage>["entries"] {
    return this.queue.entries;
  }

  /** Backward-compatible accessor — used by tests to inspect/inject retry timers. */
  protected get retryTimers(): MessageQueue<QueuedMessage>["timerMap"] {
    return this.queue.timerMap;
  }
  /** Per-channelId applied instinct IDs for reaction-based feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();

  constructor(
    token: string,
    auth: AuthManager,
    options?: {
      guildId?: string;
      slashCommands?: SlashCommand[];
    }
  ) {
    this.token = token;
    this.auth = auth;
    this.guildId = options?.guildId;
    this.slashCommands = options?.slashCommands ?? [];
    this.rateLimiter = new DiscordRateLimiter();

    this.queue = new MessageQueue<QueuedMessage>({
      maxRetries: MAX_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      batchSize: 5,
      timeoutMs: MESSAGE_TIMEOUT_MS,
      ordering: "fifo",
      jitter: false,
      skipBackedOff: false,
      rateLimitBackoffMs: RATE_LIMIT_BACKOFF_MS,
      processItem: async (msg) => {
        try {
          return await this.processQueuedMessage(msg);
        } catch (error) {
          if (this.isRateLimitError(error)) {
            const retryAfter = this.extractRetryAfter(error) ?? RATE_LIMIT_BACKOFF_MS;
            this.rateLimiter.reportRateLimitError(retryAfter);
            getLogger().warn("Discord rate limited", { retryAfter });
          }
          throw error;
        }
      },
      isRateLimitError: (err) => this.isRateLimitError(err),
      extractRetryAfter: (err) => this.extractRetryAfter(err),
      isConnected: () => this.isConnected,
    });

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      // Required so DMs (uncached channels) and reactions on messages the bot
      // did not see created (e.g. older replies after a restart) are delivered
      // as partial structures instead of being silently dropped.
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    this.setupEventHandlers();
    this.startQueueProcessor();
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register a callback for feedback reactions (thumbs up/down). */
  setFeedbackHandler(callback: FeedbackReactionCallback | null): void {
    this.feedbackReactionCallback = callback;
  }

  /** Set the applied instinct IDs for a channel so reactions can be attributed. */
  setAppliedInstinctIds(chatId: string, instinctIds: string[]): void {
    if (instinctIds.length > 0) {
      this.appliedInstinctIds.set(chatId, instinctIds);
    } else {
      this.appliedInstinctIds.delete(chatId);
    }
  }

  async connect(): Promise<void> {
    const logger = getLogger();
    logger.info("Starting Discord bot...");

    await this.client.login(this.token);
    this.isConnected = true;

    if (this.slashCommands.length > 0) {
      await this.registerSlashCommands();
    }

    logger.info(`Discord bot connected as ${this.client.user?.tag}`);
  }

  async disconnect(): Promise<void> {
    getLogger().info("Stopping Discord bot...");
    this.isConnected = false;
    this.shuttingDown = true;

    // Cancel any pending reconnection backoff — this is an intentional shutdown.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Stop queue processor
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }

    // Reject every queued and retry-pending message: the queue processor that
    // would settle their promises is now stopped, so without this every awaiting
    // caller (sendText/sendMarkdown/...) would hang forever. Mirrors the Slack
    // channel's disconnect drain.
    this.queue.rejectRetryTimers("Discord channel disconnected");
    this.queue.rejectAll("Discord channel disconnected");

    // Clean up pending confirmations
    for (const [, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timeout);
      pending.resolve("cancelled");
    }
    this.pendingConfirmations.clear();

    // Clean up streaming messages
    for (const [, state] of this.streamingMessages) {
      // Stop any pending throttled update so it cannot fire after destroy().
      state.buffer.clearOnDisconnect();
      try {
        await state.message.edit("*Message ended*");
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.streamingMessages.clear();

    // Drop any pending slash-command reply callbacks; the awaiting interactions
    // will fall through to their own deferReply timeout rather than hang on a
    // callback that can no longer be invoked against the destroyed client.
    this.pendingReplyCallbacks.clear();
    this.replyTokensByChatId.clear();

    // Clear the rate limiter's pending cooldown timer and flush its waiters so
    // no timer fires against the destroyed client and no acquire() hangs.
    this.rateLimiter.dispose();

    await this.client.destroy();
  }

  /**
   * Schedule an application-level relogin with exponential backoff after a fatal
   * session invalidation. discord.js handles transient shard reconnects itself;
   * this only covers the case where the client has given up.
   */
  private scheduleReconnect(): void {
    const logger = getLogger();

    if (this.shuttingDown) return; // Intentional disconnect — do not reconnect.
    if (this.reconnectTimer) return; // A reconnect is already scheduled.

    if (this.reconnectAttempts >= DiscordChannel.MAX_RECONNECT_ATTEMPTS) {
      logger.error("Discord reconnection gave up after max attempts", {
        attempts: this.reconnectAttempts,
      });
      return;
    }

    const delay = Math.min(
      DiscordChannel.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      DiscordChannel.RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts++;

    logger.info("Scheduling Discord reconnection", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown) return;
      this.client
        .login(this.token)
        .then(() => {
          this.isConnected = true;
          logger.info("Discord reconnected");
        })
        .catch((error) => {
          logger.error("Discord reconnection attempt failed", {
            attempt: this.reconnectAttempts,
            error: error instanceof Error ? error.message : String(error),
          });
          // Schedule the next attempt (backoff grows via reconnectAttempts).
          this.scheduleReconnect();
        });
    }, delay);
  }

  // ---- Queue-based Message Sending ----

  private startQueueProcessor(): void {
    this.queueInterval = setInterval(() => {
      void this.queue.processQueue().catch((err) => {
        getLogger().error("Queue processor error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, QUEUE_PROCESS_INTERVAL_MS);
  }

  private enqueueMessage(message: Omit<QueuedMessage, 'id'>): Promise<unknown> {
    const queuedMessage: QueuedMessage = {
      ...message,
      id: randomUUID(),
    };
    return this.queue.enqueue(queuedMessage);
  }

  /** Alias for backward-compat with characterization tests (delegated to queue.processQueue). */
  protected processMessageQueue(): Promise<void> {
    return this.queue.processQueue();
  }

  private async processQueuedMessage(msg: QueuedMessage): Promise<unknown> {
    switch (msg.type) {
      case 'text':
        await this.sendTextImmediate(msg.chatId, msg.content!);
        return undefined;
      case 'markdown':
        await this.sendMarkdownImmediate(msg.chatId, msg.content!);
        return undefined;
      case 'embed':
        await this.sendRichEmbedImmediate(msg.chatId, msg.embedOptions!);
        return undefined;
      case 'typing':
        await this.sendTypingIndicatorImmediate(msg.chatId);
        return undefined;
      case 'thread': {
        const threadId = await this.createThreadImmediate(msg.chatId, msg.threadOptions!.name, {
          autoArchiveDuration: msg.threadOptions!.autoArchiveDuration,
        });
        return threadId;
      }
      case 'confirmation': {
        // Only SEND the embed+buttons through the rate-limited path here.
        // The long-lived promise that waits for the user's button click
        // (or 120s timeout) is owned by requestConfirmation and must NOT
        // block the shared send queue.
        await this.sendConfirmationPrompt(msg.confirmationRequest!, msg.confirmId!);
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private isRateLimitError(error: unknown): boolean {
    if (error && typeof error === 'object') {
      const status = (error as { status?: number }).status;
      return status === 429; // Discord rate limit status code
    }
    return false;
  }

  private extractRetryAfter(error: unknown): number | null {
    if (error && typeof error === 'object') {
      const retryAfter = (error as { retryAfter?: number }).retryAfter;
      if (typeof retryAfter === 'number') {
        // discord.js v14 already provides retryAfter in milliseconds
        return retryAfter;
      }
    }
    return null;
  }

  // ---- Public API (Queue-based) ----

  async sendText(chatId: string, text: string): Promise<void> {
    await this.enqueueMessage({ type: 'text', chatId, content: text }) as Promise<void>;
  }

  private async sendTextImmediate(chatId: string, text: string): Promise<void> {
    const chunks = chunkText(text, DISCORD_MAX_MESSAGE_LENGTH);
    if (chunks.length === 0) return; // Nothing to send (empty/whitespace input)

    // If a slash command is awaiting a reply for this channel, route through its
    // callback (oldest waiting interaction first; resolved+removed atomically).
    const replyCallback = this.takeReplyCallback(chatId);
    if (replyCallback) {
      // The interaction reply takes the first chunk; any overflow is delivered
      // as follow-up channel messages so no content is dropped.
      await replyCallback(chunks[0]!);
      await this.sendChunksToChannel(chatId, chunks.slice(1));
      return;
    }

    await this.sendChunksToChannel(chatId, chunks);
  }

  /** Send each pre-split chunk to the channel through the rate limiter, isolating
   * per-chunk failures so one failed send does not drop the remaining chunks. */
  private async sendChunksToChannel(chatId: string, chunks: string[]): Promise<void> {
    let resolvedChannel: TextChannel | null = null;
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      await this.rateLimiter.acquire();
      if (!resolvedChannel) {
        const channel = await this.client.channels.fetch(chatId);
        if (!channel?.isTextBased()) {
          throw new Error(`Invalid channel: ${chatId}`);
        }
        resolvedChannel = channel as TextChannel;
      }
      await resolvedChannel.send(chunk);
    }
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    await this.enqueueMessage({ type: 'markdown', chatId, content: markdown }) as Promise<void>;
  }

  private async sendMarkdownImmediate(chatId: string, markdown: string): Promise<void> {
    const formatted = formatToDiscordMarkdown(markdown);
    const chunks = chunkText(formatted, DISCORD_MAX_MESSAGE_LENGTH);
    if (chunks.length === 0) return; // Nothing to send (empty/whitespace input)

    // If a slash command is awaiting a reply for this channel, route through its
    // callback (oldest waiting interaction first; resolved+removed atomically).
    const replyCallback = this.takeReplyCallback(chatId);
    if (replyCallback) {
      // The interaction reply takes the first chunk; any overflow is delivered
      // as follow-up channel messages so no content is dropped.
      await replyCallback(chunks[0]!);
      await this.sendChunksToChannel(chatId, chunks.slice(1));
      return;
    }

    await this.sendChunksToChannel(chatId, chunks);
  }

  async sendRichEmbed(
    chatId: string,
    options: {
      title?: string;
      description?: string;
      color?: number;
      fields?: { name: string; value: string; inline?: boolean }[];
      footer?: { text: string; iconURL?: string };
      timestamp?: Date;
      thumbnail?: string;
      image?: string;
      url?: string;
    }
  ): Promise<void> {
    await this.enqueueMessage({ type: 'embed', chatId, embedOptions: options });
  }

  private async sendRichEmbedImmediate(
    chatId: string,
    options: Parameters<DiscordChannel['sendRichEmbed']>[1]
  ): Promise<void> {
    await this.rateLimiter.acquire();
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) {
      throw new Error(`Invalid channel: ${chatId}`);
    }

    const embed = new EmbedBuilder();
    if (options.title) embed.setTitle(options.title);
    if (options.description)
      embed.setDescription(truncateForDiscord(options.description, 4096));
    if (options.color) embed.setColor(options.color);
    if (options.fields) embed.addFields(options.fields);
    if (options.footer) embed.setFooter(options.footer);
    if (options.timestamp) embed.setTimestamp(options.timestamp);
    if (options.thumbnail) embed.setThumbnail(options.thumbnail);
    if (options.image) embed.setImage(options.image);
    if (options.url) embed.setURL(options.url);

    await (channel as TextChannel).send({ embeds: [embed] });
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    // Typing indicator doesn't need queue - it's low priority
    const channel = await this.client.channels.fetch(chatId);
    if (channel?.isTextBased() && "sendTyping" in channel) {
      await channel.sendTyping();
    }
  }

  private async sendTypingIndicatorImmediate(chatId: string): Promise<void> {
    const channel = await this.client.channels.fetch(chatId);
    if (channel?.isTextBased() && "sendTyping" in channel) {
      await channel.sendTyping();
    }
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const confirmId = `confirm_${randomUUID()}`;

    // The long-lived response promise resolves on a button click or the 120s
    // timeout — it is independent of the send queue, so a pending confirmation
    // never blocks other channels' sends (head-of-line) and is never evicted by
    // the queue's send-dispatch timeout.
    const responsePromise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingConfirmations.delete(confirmId);
        resolve("timeout");
      }, 120_000);

      this.pendingConfirmations.set(confirmId, {
        resolve,
        timeout,
        chatId: req.chatId,
        userId: req.userId,
      });
    });

    // Dispatch only the embed+buttons through the rate-limited queue. If the
    // send itself fails (e.g. invalid channel, or the queue is drained on
    // disconnect), settle the response promise as "cancelled" so it never hangs
    // for the full 120s timeout. (disconnect() may have already resolved the
    // pending entry, in which case it is gone and there is nothing to clean up.)
    try {
      await this.enqueueMessage({
        type: 'confirmation',
        chatId: req.chatId,
        confirmationRequest: req,
        confirmId,
      });
    } catch (error) {
      const pending = this.pendingConfirmations.get(confirmId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingConfirmations.delete(confirmId);
        pending.resolve("cancelled");
        getLogger().warn("Discord confirmation prompt could not be sent", {
          chatId: req.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return responsePromise;
  }

  /** Send the confirmation prompt (embed + buttons) for an already-registered
   * confirmId. Does NOT wait for the user's response. */
  private async sendConfirmationPrompt(req: ConfirmationRequest, confirmId: string): Promise<void> {
    const channel = await this.client.channels.fetch(req.chatId);
    if (!channel?.isTextBased()) {
      throw new Error(`Invalid channel: ${req.chatId}`);
    }

    const buttons = req.options.map((option) =>
      new ButtonBuilder()
        .setCustomId(`${confirmId}:${option}`)
        .setLabel(option)
        .setStyle(ButtonStyle.Primary)
    );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

    const embed = new EmbedBuilder()
      .setTitle("Confirmation Required")
      .setDescription(req.question)
      .setColor(0xffa500);

    if (req.details) {
      embed.addFields({ name: "Details", value: req.details });
    }

    await this.rateLimiter.acquire();
    await (channel as TextChannel).send({
      embeds: [embed],
      components: [row],
    });
  }

  isHealthy(): boolean {
    return this.isConnected && this.client.isReady();
  }

  // ---- Streaming Support ----

  async startStreamingMessage(chatId: string): Promise<string | undefined> {
    try {
      await this.rateLimiter.acquire();
      const channel = await this.client.channels.fetch(chatId);
      if (!channel?.isTextBased()) {
        return undefined;
      }

      const message = await (channel as TextChannel).send("...");
      const streamId = randomUUID();

      const buffer = new StreamingBuffer({
        throttleMs: 1000,
        onFlush: async (text) => {
          const state = this.streamingMessages.get(streamId);
          if (!state) return;
          try {
            await this.rateLimiter.acquire();
            // Intermediate preview: a single edited message cannot exceed Discord's
            // 2000-char limit, so the in-progress view is truncated; the full content
            // is delivered in finalizeStreamingMessage (which splits into chunks).
            const truncated = truncateForDiscord(text || "...", DISCORD_MAX_MESSAGE_LENGTH);
            await state.message.edit(truncated);
          } catch (error) {
            getLogger().debug("Failed to update streaming message", {
              streamId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        onFinalize: async (text) => {
          const state = this.streamingMessages.get(streamId);
          if (!state) return;

          const formatted = formatToDiscordMarkdown(text);
          // Split the full final text so nothing is dropped: the first chunk edits the
          // existing streaming message; any remaining chunks are sent as follow-ups.
          const chunks = chunkText(formatted, DISCORD_MAX_MESSAGE_LENGTH);

          try {
            if (chunks.length === 0) {
              // Empty final text — leave the streaming placeholder as-is.
              return;
            }

            let editApplied = false;
            try {
              await this.rateLimiter.acquire();
              await state.message.edit(chunks[0]!);
              editApplied = true;
            } catch (error) {
              getLogger().debug("Failed to edit streaming message on finalize", {
                streamId,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            if (editApplied) {
              // Edit landed — send only the overflow chunks as follow-ups.
              await this.sendChunksToChannel(chatId, chunks.slice(1));
            } else {
              // The edit definitively did not apply (the streaming placeholder still
              // shows "..."), so deliver the full final text as new messages. This is
              // not a double-send of the final content because the edit failed.
              try {
                await this.sendChunksToChannel(chatId, chunks);
              } catch {
                getLogger().error("Failed to finalize streaming message", { streamId });
              }
            }
          } finally {
            this.streamingMessages.delete(streamId);
          }
        },
      });

      this.streamingMessages.set(streamId, { message, buffer });

      return streamId;
    } catch (error) {
      getLogger().error("Failed to start streaming message", { error });
      return undefined;
    }
  }

  async updateStreamingMessage(
    _chatId: string,
    streamId: string,
    accumulatedText: string
  ): Promise<void> {
    const state = this.streamingMessages.get(streamId);
    if (!state) return;
    await state.buffer.update(accumulatedText);
  }

  async finalizeStreamingMessage(
    _chatId: string,
    streamId: string,
    finalText: string
  ): Promise<void> {
    const state = this.streamingMessages.get(streamId);
    if (!state) return;
    await state.buffer.finalize(finalText);
  }

  // ---- Thread Support ----

  async createThread(
    channelId: string,
    name: string,
    options?: {
      autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
      reason?: string;
    }
  ): Promise<string> {
    return this.enqueueMessage({
      type: 'thread',
      chatId: channelId,
      threadOptions: { name, autoArchiveDuration: options?.autoArchiveDuration }
    }) as Promise<string>;
  }

  private async createThreadImmediate(
    channelId: string,
    name: string,
    options?: { autoArchiveDuration?: 60 | 1440 | 4320 | 10080 }
  ): Promise<string> {
    await this.rateLimiter.acquire();
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Invalid channel: ${channelId}`);
    }

    const textChannel = channel as TextChannel;
    if (!textChannel.threads) {
      throw new Error("Channel does not support threads");
    }

    const thread = await textChannel.threads.create({
      name: name.substring(0, 100),
      autoArchiveDuration: options?.autoArchiveDuration ?? 1440,
    });

    return thread.id;
  }

  async sendInThread(
    threadId: string,
    content: string,
    options?: { markdown?: boolean }
  ): Promise<void> {
    const text = options?.markdown
      ? formatToDiscordMarkdown(content)
      : content;
    const chunks = chunkText(text, DISCORD_MAX_MESSAGE_LENGTH);
    if (chunks.length === 0) return; // Nothing to send (empty/whitespace input)

    await this.rateLimiter.acquire();
    const thread = await this.client.channels.fetch(threadId);
    if (!(thread instanceof ThreadChannel)) {
      throw new Error(`Invalid thread: ${threadId}`);
    }

    // First chunk uses the token already acquired above; each subsequent chunk
    // acquires its own so multi-chunk sends still respect the rate limiter.
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await this.rateLimiter.acquire();
      await thread.send(chunks[i]!);
    }
  }

  // ---- Private Setup Methods ----

  private setupEventHandlers(): void {
    const logger = getLogger();

    this.client.on(Events.ClientReady, () => {
      // A successful (re)connect: clear backoff state.
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.isConnected = true;
      logger.info(`Discord bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on(Events.Error, (error) => {
      logger.error("Discord client error", { error: error.message });
    });

    this.client.on(Events.Warn, (info) => {
      logger.warn("Discord client warning", { info });
    });

    // Shard lifecycle: discord.js auto-reconnects shards in most cases. We log
    // these so a degraded connection is observable via isHealthy().
    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      logger.warn("Discord shard disconnected", {
        shardId,
        code: (event as { code?: number }).code,
      });
    });

    this.client.on(Events.ShardReconnecting, (shardId) => {
      logger.info("Discord shard reconnecting", { shardId });
    });

    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      logger.info("Discord shard resumed", { shardId, replayedEvents });
    });

    // Fatal: the session was invalidated (token reset, prolonged outage). The
    // client gives up here, so we attempt an application-level relogin with
    // exponential backoff instead of leaving the bot permanently unhealthy.
    this.client.on(Events.Invalidated, () => {
      logger.error("Discord session invalidated; scheduling reconnection");
      this.isConnected = false;
      this.scheduleReconnect();
    });

    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      try {
        if (interaction.isButton()) {
          await this.handleButtonInteraction(interaction);
        } else if (interaction.isChatInputCommand()) {
          await this.handleSlashCommand(interaction);
        }
      } catch (error) {
        logger.error("Error handling interaction", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        if (message.author.bot) return;

        const userId = message.author.id;
        if (!this.auth.isDiscordUserAllowed(userId, this.extractRoleIds(message))) {
          await message.reply(
            "You are not authorized to use Strada Brain. Contact the administrator."
          );
          return;
        }

        if (message.content.startsWith("/")) return;

        await this.handleRegularMessage(message);
      } catch (error) {
        logger.error("Error handling Discord message", {
          error: error instanceof Error ? error.message : String(error),
          userId: message.author?.id,
          channelId: message.channelId,
        });
      }
    });

    // Feedback via emoji reactions (thumbs up/down)
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      try {
        if (user.bot) return;
        if (!this.feedbackReactionCallback) return;

        // With Partials enabled, reactions on uncached messages arrive partial;
        // fetch the full structure before reading emoji/message fields.
        if (reaction.partial) {
          try {
            await reaction.fetch();
          } catch {
            return; // Cannot resolve the reaction — nothing we can attribute.
          }
        }

        const emoji = reaction.emoji.name;
        let feedbackType: "thumbs_up" | "thumbs_down" | null = null;
        if (emoji === "\uD83D\uDC4D" || emoji === "thumbsup") {
          feedbackType = "thumbs_up";
        } else if (emoji === "\uD83D\uDC4E" || emoji === "thumbsdown") {
          feedbackType = "thumbs_down";
        }
        if (!feedbackType) return;

        const channelId = reaction.message.channelId;
        const instinctIds = this.appliedInstinctIds.get(channelId);
        if (!instinctIds || instinctIds.length === 0) return;

        this.feedbackReactionCallback(feedbackType, instinctIds, user.id, "reaction");
      } catch (error) {
        logger.debug("Error handling reaction feedback", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private async handleButtonInteraction(
    interaction: ButtonInteraction
  ): Promise<void> {
    if (!this.auth.isDiscordUserAllowed(interaction.user.id, this.extractRoleIds(interaction))) {
      await interaction.reply({
        content: "Unauthorized",
        ephemeral: true,
      });
      return;
    }

    const data = interaction.customId;
    const separatorIndex = data.indexOf(":");
    if (separatorIndex === -1) return;

    const confirmId = data.substring(0, separatorIndex);
    const selectedOption = data.substring(separatorIndex + 1);

    const pending = this.pendingConfirmations.get(confirmId);
    if (pending) {
      if (interaction.channelId !== pending.chatId) {
        await interaction.reply({
          content: "This confirmation belongs to a different channel.",
          ephemeral: true,
        });
        return;
      }

      if (pending.userId && interaction.user.id !== pending.userId) {
        await interaction.reply({
          content: "Only the original requester can respond to this confirmation.",
          ephemeral: true,
        });
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingConfirmations.delete(confirmId);
      pending.resolve(selectedOption);

      await interaction.update({
        content: `Selected: **${selectedOption}**`,
        components: [],
        embeds: [],
      });
    }
  }

  private async handleSlashCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!this.auth.isDiscordUserAllowed(interaction.user.id, this.extractRoleIds(interaction))) {
      await interaction.reply({
        content: "You are not authorized to use Strada Brain.",
        ephemeral: true,
      });
      return;
    }

    const commandName = interaction.commandName;

    switch (commandName) {
      case "ask": {
        const question = interaction.options.getString("question", true);
        await interaction.deferReply();

        const msg: IncomingMessage = {
          channelType: "discord",
          chatId: interaction.channelId,
          // Unique per-interaction token so concurrent slash commands in the same
          // channel each get their own pending reply slot (avoids cross-routing).
          replyToken: interaction.id,
          userId: interaction.user.id,
          text: limitIncomingText(question),
          timestamp: new Date(),
        };

        await this.routeMessage(msg, async (response) => {
          await interaction.editReply(response);
        });
        break;
      }

      case "analyze": {
        await interaction.deferReply();

        const msg: IncomingMessage = {
          channelType: "discord",
          chatId: interaction.channelId,
          // Unique per-interaction token so concurrent slash commands in the same
          // channel each get their own pending reply slot (avoids cross-routing).
          replyToken: interaction.id,
          userId: interaction.user.id,
          text: limitIncomingText("Analyze project structure"),
          timestamp: new Date(),
        };

        await this.routeMessage(msg, async (response) => {
          await interaction.editReply(response);
        });
        break;
      }

      case "generate": {
        const type = interaction.options.getString("type", true);
        const name = interaction.options.getString("name", true);
        const description = interaction.options.getString("description") ?? "";

        await interaction.deferReply();

        const msg: IncomingMessage = {
          channelType: "discord",
          chatId: interaction.channelId,
          // Unique per-interaction token so concurrent slash commands in the same
          // channel each get their own pending reply slot (avoids cross-routing).
          replyToken: interaction.id,
          userId: interaction.user.id,
          text: limitIncomingText(`Create ${type} named "${name}"${description ? `: ${description}` : ""}`),
          timestamp: new Date(),
        };

        await this.routeMessage(msg, async (response) => {
          await interaction.editReply(response);
        });
        break;
      }

      case "status": {
        const embed = new EmbedBuilder()
          .setTitle("Strada Brain Status")
          .setDescription("System is operational")
          .setColor(0x00ff00)
          .addFields(
            { name: "Bot", value: this.client.user?.tag ?? "Unknown", inline: true },
            { name: "Latency", value: `${this.client.ws.ping}ms`, inline: true },
            { name: "Uptime", value: `${Math.floor(process.uptime() / 60)}m`, inline: true },
            { name: "Queue Size", value: `${this.messageQueue.length}`, inline: true }
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "help": {
        const embed = new EmbedBuilder()
          .setTitle("Strada Brain Help")
          .setDescription("Your AI-powered Unity development assistant")
          .setColor(0x0099ff)
          .addFields(
            { name: "/ask <question>", value: "Ask Strada Brain a question about your project" },
            { name: "/analyze", value: "Analyze your Unity/Strada.Core project structure" },
            { name: "/generate <type> <name> [description]", value: "Generate a module, system, component, or mediator" },
            { name: "/status", value: "Show system status and health" },
            { name: "/help", value: "Show this help message" }
          )
          .setFooter({ text: "Just type naturally for conversational interactions!" });

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "autonomous": {
        const action = interaction.options.getString("action", true);
        const hours = interaction.options.getInteger("hours");

        await interaction.deferReply();

        const autonomousText = hours
          ? `/autonomous ${action} ${hours}`
          : `/autonomous ${action}`;

        const msg: IncomingMessage = {
          channelType: "discord",
          chatId: interaction.channelId,
          // Unique per-interaction token so concurrent slash commands in the same
          // channel each get their own pending reply slot (avoids cross-routing).
          replyToken: interaction.id,
          userId: interaction.user.id,
          text: limitIncomingText(autonomousText),
          timestamp: new Date(),
        };

        await this.routeMessage(msg, async (response) => {
          await interaction.editReply(response);
        });
        break;
      }

      case "model": {
        const action = interaction.options.getString("action", true);
        const model = interaction.options.getString("model");

        await interaction.deferReply();

        const modelText = model
          ? `/model ${action} ${model}`
          : `/model ${action}`;

        const msg: IncomingMessage = {
          channelType: "discord",
          chatId: interaction.channelId,
          // Unique per-interaction token so concurrent slash commands in the same
          // channel each get their own pending reply slot (avoids cross-routing).
          replyToken: interaction.id,
          userId: interaction.user.id,
          text: limitIncomingText(modelText),
          timestamp: new Date(),
        };

        await this.routeMessage(msg, async (response) => {
          await interaction.editReply(response);
        });
        break;
      }

      case "search": {
        const query = interaction.options.getString("query", true);
        const type = interaction.options.getString("type") ?? "all";

        await interaction.deferReply();

        const msg: IncomingMessage = {
          channelType: "discord",
          chatId: interaction.channelId,
          // Unique per-interaction token so concurrent slash commands in the same
          // channel each get their own pending reply slot (avoids cross-routing).
          replyToken: interaction.id,
          userId: interaction.user.id,
          text: limitIncomingText(`Search ${type}: ${query}`),
          timestamp: new Date(),
        };

        await this.routeMessage(msg, async (response) => {
          await interaction.editReply(response);
        });
        break;
      }

      case "thread": {
        const topic = interaction.options.getString("topic", true);
        const initialMessage = interaction.options.getString("initial_message");

        await interaction.deferReply();

        try {
          const threadId = await this.createThread(interaction.channelId, topic);
          if (initialMessage) {
            await this.sendInThread(threadId, initialMessage);
          }
          await interaction.editReply(`Created thread: <#${threadId}>`);
        } catch (error) {
          getLogger().error("Failed to create thread from slash command", {
            error: error instanceof Error ? error.message : String(error),
          });
          await interaction.editReply(
            "Could not create a thread in this channel.",
          );
        }
        break;
      }

      default:
        await interaction.reply({
          content: "Unknown command",
          ephemeral: true,
        });
    }
  }

  private extractRoleIds(source: { member?: unknown }): string[] {
    const member = source.member;
    if (!member || typeof member !== "object") {
      return [];
    }

    const roles = (member as { roles?: unknown }).roles;
    if (!roles) {
      return [];
    }

    if (Array.isArray(roles)) {
      return roles.filter((role): role is string => typeof role === "string");
    }

    if (typeof roles === "object" && roles !== null && "cache" in roles) {
      const cache = (roles as { cache?: unknown }).cache;
      if (cache instanceof Map) {
        return Array.from(cache.keys()).filter((role): role is string => typeof role === "string");
      }
      if (cache && typeof cache === "object" && "keys" in cache && typeof cache.keys === "function") {
        return Array.from(cache.keys()).filter((role): role is string => typeof role === "string");
      }
      if (cache && typeof cache === "object" && "values" in cache && typeof cache.values === "function") {
        return Array.from(cache.values()).flatMap((role) => {
          if (typeof role === "string") {
            return [role];
          }
          if (role && typeof role === "object" && "id" in role && typeof role.id === "string") {
            return [role.id];
          }
          return [];
        });
      }
    }

    return [];
  }

  private async handleRegularMessage(message: Message): Promise<void> {
    if (!this.handler) {
      await message.reply("Brain is not ready yet. Please try again later.");
      return;
    }

    // Extract attachments from the Discord message (validated)
    const attachments: Attachment[] = [];
    if (message.attachments.size > 0) {
      for (const [, att] of message.attachments) {
        const type = mimeToAttachmentType(att.contentType);
        const v = validateMediaAttachment({ mimeType: att.contentType ?? undefined, size: att.size, type });
        if (!v.valid) continue; // Skip unsupported or oversized files

        let data: Buffer | undefined;
        // Download image data for vision + audio data for STT transcription + magic bytes validation
        if ((type === "image" || type === "audio") && att.url) {
          try {
            const downloaded = await downloadMedia(att.url);
            if (downloaded && validateMagicBytes(downloaded.data, downloaded.mimeType)) {
              data = downloaded.data;
            }
          } catch {
            // Non-critical — proceed with URL only
          }
        }

        attachments.push({
          type,
          name: att.name ?? "attachment",
          url: att.url,
          mimeType: att.contentType ?? undefined,
          size: att.size,
          data,
        });
      }
    }

    const msg: IncomingMessage = {
      channelType: "discord",
      chatId: message.channelId,
      userId: message.author.id,
      text: limitIncomingText(message.content),
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: message.reference?.messageId ?? undefined,
      timestamp: message.createdAt,
    };

    try {
      if (message.channel.isTextBased() && "sendTyping" in message.channel) {
        await message.channel.sendTyping();
      }

      await this.handler(msg);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      getLogger().error("Error handling Discord message", {
        chatId: msg.chatId,
        error: errMsg,
      });
      await message.reply(classifyErrorMessage(error));
    }
  }

  private async routeMessage(
    msg: IncomingMessage,
    replyCallback?: (response: string) => Promise<void>
  ): Promise<void> {
    if (!this.handler) {
      if (replyCallback) {
        await replyCallback("Brain is not ready yet. Please try again later.");
      }
      return;
    }

    // Key the pending callback by the unique per-interaction token (falling back
    // to chatId when none is present) so concurrent slash commands in the same
    // channel do not overwrite each other's callback and misroute the response.
    const replyKey = msg.replyToken ?? msg.chatId;

    // Register the callback so sendText/sendMarkdown can route the response
    // back to the slash command interaction instead of sending a new channel message
    if (replyCallback) {
      this.registerReplyCallback(msg.chatId, replyKey, replyCallback);
    }

    try {
      await this.handler(msg);
    } finally {
      // Clean up if the callback was never consumed (e.g. handler error or no response)
      if (replyCallback) {
        this.removeReplyCallback(msg.chatId, replyKey);
      }
    }
  }

  /** Register a pending slash-command reply callback under its unique key and
   * track the key in the chatId index so the send path can resolve it. */
  private registerReplyCallback(
    chatId: string,
    key: string,
    callback: (response: string) => Promise<void>,
  ): void {
    this.pendingReplyCallbacks.set(key, callback);
    const tokens = this.replyTokensByChatId.get(chatId);
    if (tokens) {
      tokens.push(key);
    } else {
      this.replyTokensByChatId.set(chatId, [key]);
    }
  }

  /** Resolve the oldest pending reply callback for a channel (FIFO) and remove it,
   * so the send path can deliver a response to the correct waiting interaction. */
  private takeReplyCallback(
    chatId: string,
  ): ((response: string) => Promise<void>) | undefined {
    const tokens = this.replyTokensByChatId.get(chatId);
    if (!tokens || tokens.length === 0) return undefined;

    const key = tokens.shift()!;
    if (tokens.length === 0) this.replyTokensByChatId.delete(chatId);

    const callback = this.pendingReplyCallbacks.get(key);
    this.pendingReplyCallbacks.delete(key);
    return callback;
  }

  /** Remove a still-pending reply callback by its key (e.g. handler error or no
   * response), keeping the chatId index in sync. */
  private removeReplyCallback(chatId: string, key: string): void {
    if (!this.pendingReplyCallbacks.delete(key)) return;
    const tokens = this.replyTokensByChatId.get(chatId);
    if (!tokens) return;
    const idx = tokens.indexOf(key);
    if (idx !== -1) tokens.splice(idx, 1);
    if (tokens.length === 0) this.replyTokensByChatId.delete(chatId);
  }

  private async registerSlashCommands(): Promise<void> {
    const logger = getLogger();

    if (!this.client.user?.id) {
      logger.warn("Cannot register slash commands: client user ID not available yet");
      return;
    }

    const appId = this.client.user.id;
    logger.info("Registering Discord slash commands...");

    try {
      const { REST, Routes } = await import("discord.js");
      const rest = new REST({ version: "10" }).setToken(this.token);

      const commandsData = this.slashCommands.map((cmd) => cmd.data.toJSON());

      if (this.guildId) {
        await rest.put(
          Routes.applicationGuildCommands(appId, this.guildId),
          { body: commandsData }
        );
        logger.info(`Registered ${commandsData.length} guild slash commands`);
      } else {
        await rest.put(
          Routes.applicationCommands(appId),
          { body: commandsData }
        );
        logger.info(`Registered ${commandsData.length} global slash commands`);
      }
    } catch (error) {
      logger.error("Failed to register slash commands", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getClient(): Client {
    return this.client;
  }
}
