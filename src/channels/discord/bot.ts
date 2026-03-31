import { randomUUID } from "node:crypto";
import {
  Client,
  GatewayIntentBits,
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
import type { SlashCommand } from "./commands.js";

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
  accumulatedText: string;
  lastUpdate: number;
  updateQueued: boolean;
}

interface QueuedMessage {
  id: string;
  type: 'text' | 'markdown' | 'embed' | 'typing' | 'thread' | 'confirmation';
  chatId: string;
  content?: string;
  embedOptions?: Parameters<DiscordChannel['sendRichEmbed']>[1];
  threadOptions?: { name: string; autoArchiveDuration?: 60 | 1440 | 4320 | 10080 };
  confirmationRequest?: ConfirmationRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  retries: number;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const QUEUE_PROCESS_INTERVAL_MS = 100;
const RATE_LIMIT_BACKOFF_MS = 5000;

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
  private readonly pendingReplyCallbacks = new Map<string, (response: string) => Promise<void>>();
  private isConnected = false;
  private slashCommands: SlashCommand[] = [];
  
  // Message queue for rate limit handling
  private messageQueue: QueuedMessage[] = [];
  private queueProcessing = false;
  private queueInterval: NodeJS.Timeout | null = null;
  private rateLimited = false;
  private rateLimitResetTime = 0;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
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

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
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
    
    // Stop queue processor
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }

    // Clean up pending confirmations
    for (const [, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timeout);
      pending.resolve("cancelled");
    }
    this.pendingConfirmations.clear();

    // Clean up streaming messages
    for (const [, state] of this.streamingMessages) {
      try {
        await state.message.edit("*Message ended*");
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.streamingMessages.clear();

    await this.client.destroy();
  }

  // ---- Queue-based Message Sending ----

  private startQueueProcessor(): void {
    this.queueInterval = setInterval(() => {
      void this.processMessageQueue().catch((err) => {
        getLogger().error("Queue processor error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, QUEUE_PROCESS_INTERVAL_MS);
  }

  private enqueueMessage(message: Omit<QueuedMessage, 'id' | 'retries' | 'resolve' | 'reject'>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const queuedMessage: QueuedMessage = {
        ...message,
        id: randomUUID(),
        retries: 0,
        resolve,
        reject,
      };
      
      this.messageQueue.push(queuedMessage);
    });
  }

  private async processMessageQueue(): Promise<void> {
    if (this.queueProcessing || this.messageQueue.length === 0) return;
    if (this.rateLimited && Date.now() < this.rateLimitResetTime) return;

    this.queueProcessing = true;
    this.rateLimited = false;

    try {
      // Process up to 5 messages per interval (respecting rate limits)
      const batchSize = Math.min(5, this.messageQueue.length);

      for (let i = 0; i < batchSize; i++) {
        const message = this.messageQueue[0];
        if (!message) break;

        try {
          await this.processQueuedMessage(message);
          this.messageQueue.shift(); // Remove successfully processed message
        } catch (error) {
          if (this.isRateLimitError(error)) {
            // Rate limited - pause processing
            const retryAfter = this.extractRetryAfter(error) || RATE_LIMIT_BACKOFF_MS;
            this.rateLimited = true;
            this.rateLimitResetTime = Date.now() + retryAfter;
            this.rateLimiter.reportRateLimitError(retryAfter);
            getLogger().warn("Discord rate limited", { retryAfter });
            break;
          }

          // Retry logic
          message.retries++;
          if (message.retries >= MAX_RETRIES) {
            message.reject(error instanceof Error ? error : new Error(String(error)));
            this.messageQueue.shift();
          } else {
            // Move to end of queue with exponential backoff — re-enqueue after delay
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, message.retries - 1);
            this.messageQueue.shift();
            setTimeout(() => {
              this.messageQueue.push(message);
            }, delay);
          }
        }
      }
    } finally {
      this.queueProcessing = false;
    }
  }

  private async processQueuedMessage(msg: QueuedMessage): Promise<void> {
    switch (msg.type) {
      case 'text':
        await this.sendTextImmediate(msg.chatId, msg.content!);
        msg.resolve(undefined);
        break;
      case 'markdown':
        await this.sendMarkdownImmediate(msg.chatId, msg.content!);
        msg.resolve(undefined);
        break;
      case 'embed':
        await this.sendRichEmbedImmediate(msg.chatId, msg.embedOptions!);
        msg.resolve(undefined);
        break;
      case 'typing':
        await this.sendTypingIndicatorImmediate(msg.chatId);
        msg.resolve(undefined);
        break;
      case 'thread': {
        const threadId = await this.createThreadImmediate(msg.chatId, msg.threadOptions!.name, {
          autoArchiveDuration: msg.threadOptions!.autoArchiveDuration,
        });
        msg.resolve(threadId);
        break;
      }
      case 'confirmation': {
        const result = await this.requestConfirmationImmediate(msg.confirmationRequest!);
        msg.resolve(result);
        break;
      }
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
    // If a slash command is awaiting a reply for this channel, route through its callback
    const replyCallback = this.pendingReplyCallbacks.get(chatId);
    if (replyCallback) {
      this.pendingReplyCallbacks.delete(chatId);
      const truncated = truncateForDiscord(text, 2000);
      await replyCallback(truncated);
      return;
    }

    await this.rateLimiter.acquire();
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) {
      throw new Error(`Invalid channel: ${chatId}`);
    }
    const truncated = truncateForDiscord(text, 2000);
    await (channel as TextChannel).send(truncated);
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    await this.enqueueMessage({ type: 'markdown', chatId, content: markdown }) as Promise<void>;
  }

  private async sendMarkdownImmediate(chatId: string, markdown: string): Promise<void> {
    // If a slash command is awaiting a reply for this channel, route through its callback
    const replyCallback = this.pendingReplyCallbacks.get(chatId);
    if (replyCallback) {
      this.pendingReplyCallbacks.delete(chatId);
      const formatted = formatToDiscordMarkdown(markdown);
      const truncated = truncateForDiscord(formatted, 2000);
      await replyCallback(truncated);
      return;
    }

    await this.rateLimiter.acquire();
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) {
      throw new Error(`Invalid channel: ${chatId}`);
    }
    const formatted = formatToDiscordMarkdown(markdown);
    const truncated = truncateForDiscord(formatted, 2000);
    await (channel as TextChannel).send(truncated);
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
    return this.enqueueMessage({ 
      type: 'confirmation', 
      chatId: req.chatId, 
      confirmationRequest: req 
    }) as Promise<string>;
  }

  private async requestConfirmationImmediate(req: ConfirmationRequest): Promise<string> {
    const channel = await this.client.channels.fetch(req.chatId);
    if (!channel?.isTextBased()) {
      throw new Error(`Invalid channel: ${req.chatId}`);
    }

    const confirmId = `confirm_${randomUUID()}`;

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

    return new Promise<string>((resolve) => {
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

      this.streamingMessages.set(streamId, {
        message,
        accumulatedText: "",
        lastUpdate: Date.now(),
        updateQueued: false,
      });

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

    state.accumulatedText = accumulatedText;

    // Throttle updates to avoid rate limits (max 1 update per second)
    const now = Date.now();
    if (now - state.lastUpdate < 1000) {
      if (!state.updateQueued) {
        state.updateQueued = true;
        setTimeout(() => {
          state.updateQueued = false;
          void this.performStreamUpdate(streamId);
        }, 1000 - (now - state.lastUpdate));
      }
      return;
    }

    await this.performStreamUpdate(streamId);
  }

  private async performStreamUpdate(streamId: string): Promise<void> {
    const state = this.streamingMessages.get(streamId);
    if (!state) return;

    try {
      await this.rateLimiter.acquire();
      const text = state.accumulatedText || "...";
      const truncated = truncateForDiscord(text, 2000);
      await state.message.edit(truncated);
      state.lastUpdate = Date.now();
    } catch (_error) {
      // Ignore update errors
    }
  }

  async finalizeStreamingMessage(
    _chatId: string,
    streamId: string,
    finalText: string
  ): Promise<void> {
    const state = this.streamingMessages.get(streamId);
    if (!state) return;

    try {
      await this.rateLimiter.acquire();
      const formatted = formatToDiscordMarkdown(finalText);
      const truncated = truncateForDiscord(formatted, 2000);
      await state.message.edit(truncated);
    } catch (_error) {
      try {
        await this.sendMarkdown(_chatId, finalText);
      } catch {
        getLogger().error("Failed to finalize streaming message");
      }
    } finally {
      this.streamingMessages.delete(streamId);
    }
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
    await this.rateLimiter.acquire();
    const thread = await this.client.channels.fetch(threadId);
    if (!(thread instanceof ThreadChannel)) {
      throw new Error(`Invalid thread: ${threadId}`);
    }

    const text = options?.markdown
      ? formatToDiscordMarkdown(content)
      : content;
    const truncated = truncateForDiscord(text, 2000);
    await thread.send(truncated);
  }

  // ---- Private Setup Methods ----

  private setupEventHandlers(): void {
    const logger = getLogger();

    this.client.once(Events.ClientReady, () => {
      logger.info(`Discord bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on(Events.Error, (error) => {
      logger.error("Discord client error", { error: error.message });
    });

    this.client.on(Events.Warn, (info) => {
      logger.warn("Discord client warning", { info });
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
    });

    // Feedback via emoji reactions (thumbs up/down)
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      try {
        if (user.bot) return;
        if (!this.feedbackReactionCallback) return;

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
          userId: interaction.user.id,
          text: limitIncomingText(modelText),
          timestamp: new Date(),
        };

        await this.routeMessage(msg, async (response) => {
          await interaction.editReply(response);
        });
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

    // Register the callback so sendText/sendMarkdown can route the response
    // back to the slash command interaction instead of sending a new channel message
    if (replyCallback) {
      this.pendingReplyCallbacks.set(msg.chatId, replyCallback);
    }

    try {
      await this.handler(msg);
    } finally {
      // Clean up if the callback was never consumed (e.g. handler error or no response)
      this.pendingReplyCallbacks.delete(msg.chatId);
    }
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
