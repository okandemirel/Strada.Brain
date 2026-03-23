/**
 * Microsoft Teams Channel - Bot Framework adapter
 *
 * Requires: botframework-connector, botbuilder (npm install botbuilder)
 * Config: TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_ALLOWED_USER_IDS, TEAMS_ALLOW_OPEN_ACCESS
 */

import type { IChannelAdapter } from "../channel.interface.js";
import { limitIncomingText, type IncomingMessage } from "../channel-messages.interface.js";
import { getLogger } from "../../utils/logger.js";
import { isAllowedBySingleIdPolicy } from "../../security/access-policy.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/** Callback for feedback reactions (thumbs up/down) from channel adapters. */
type FeedbackReactionCallback = (
  type: "thumbs_up" | "thumbs_down",
  instinctIds: string[],
  userId?: string,
  source?: "reaction" | "button",
) => void;

export class TeamsChannel implements IChannelAdapter {
  readonly name = "teams";

  private handler: MessageHandler | null = null;
  private adapter: BotAdapterLike | null = null;
  private server: import("node:http").Server | null = null;
  private healthy = false;
  private activeTurnContexts = new Map<string, TurnContextLike>();
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
  /** Per-conversationId applied instinct IDs for feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();

  constructor(
    private readonly appId: string,
    private readonly appPassword: string,
    private readonly port: number = 3978,
    private readonly allowedUserIds: readonly string[] = [],
    private readonly listenHost: string = "127.0.0.1",
    private readonly allowOpenAccess: boolean = false,
  ) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register a callback for feedback reactions (thumbs up/down). */
  setFeedbackHandler(callback: FeedbackReactionCallback | null): void {
    this.feedbackReactionCallback = callback;
  }

  /** Set the applied instinct IDs for a conversation so feedback can be attributed. */
  setAppliedInstinctIds(chatId: string, instinctIds: string[]): void {
    if (instinctIds.length > 0) {
      this.appliedInstinctIds.set(chatId, instinctIds);
    } else {
      this.appliedInstinctIds.delete(chatId);
    }
  }

  async connect(): Promise<void> {
    const logger = getLogger();
    const { CloudAdapter, ConfigurationBotFrameworkAuthentication } =
      await import("botbuilder" as string);

    const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.appId,
      MicrosoftAppPassword: this.appPassword,
      MicrosoftAppType: "MultiTenant",
    });

    this.adapter = new CloudAdapter(botFrameworkAuth) as unknown as BotAdapterLike;

    // Create HTTP server for Bot Framework messages
    const { createServer } = await import("node:http");
    this.server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/messages") {
        await (this.adapter as BotAdapterLike).process(req, res, async (context: TurnContextLike) => {
          if (context.activity.type === "message" && context.activity.text) {
            if (!this.isAllowedInboundUser(context.activity.from.id)) {
              return;
            }

            const chatId = context.activity.conversation.id;

            // Detect feedback before routing to the normal handler
            const feedbackType = this.detectFeedback(context.activity.text);
            if (feedbackType) {
              const sent = this.fireFeedback(feedbackType, chatId, context.activity.from.id);
              this.activeTurnContexts.set(chatId, context);
              try {
                await context.sendActivity(
                  sent
                    ? (feedbackType === "thumbs_up"
                        ? "Thanks for the positive feedback!"
                        : "Thanks for the feedback. I'll try to improve.")
                    : "No recent response to give feedback on.",
                );
              } finally {
                if (this.activeTurnContexts.get(chatId) === context) {
                  this.activeTurnContexts.delete(chatId);
                }
              }
              return;
            }

            this.activeTurnContexts.set(chatId, context);

            const msg: IncomingMessage = {
              channelType: "teams",
              chatId,
              userId: context.activity.from.id,
              text: limitIncomingText(context.activity.text),
              timestamp: new Date(context.activity.timestamp ?? Date.now()),
            };

            try {
              await this.handler?.(msg);
            } finally {
              if (this.activeTurnContexts.get(chatId) === context) {
                this.activeTurnContexts.delete(chatId);
              }
            }
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, this.listenHost, () => resolve());
    });

    this.healthy = true;
    logger.info("Teams channel listening", { port: this.port, host: this.listenHost });
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    this.activeTurnContexts.clear();
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const context = this.activeTurnContexts.get(chatId);
    if (!context) {
      throw new Error(`No active Teams turn context for conversation: ${chatId}`);
    }

    await context.sendActivity(text);
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    await this.sendText(chatId, markdown);
  }

  private isAllowedInboundUser(userId: string): boolean {
    return isAllowedBySingleIdPolicy(
      userId,
      this.allowedUserIds,
      this.allowOpenAccess ? "open" : "closed",
    );
  }

  /**
   * Detect standalone feedback in a message text.
   * Recognises emoji thumbs (👍 / 👎) and `/feedback up` / `/feedback down`.
   */
  private detectFeedback(text: string): "thumbs_up" | "thumbs_down" | null {
    const trimmed = text.trim();
    if (trimmed === "\uD83D\uDC4D" || trimmed === "/feedback up") {
      return "thumbs_up";
    }
    if (trimmed === "\uD83D\uDC4E" || trimmed === "/feedback down") {
      return "thumbs_down";
    }
    return null;
  }

  /** Fire the feedback callback with stored instinct IDs. Returns true if feedback was actually sent. */
  private fireFeedback(
    type: "thumbs_up" | "thumbs_down",
    chatId: string,
    userId?: string,
  ): boolean {
    if (!this.feedbackReactionCallback) return false;
    const instinctIds = this.appliedInstinctIds.get(chatId);
    if (!instinctIds || instinctIds.length === 0) return false;
    this.feedbackReactionCallback(type, instinctIds, userId, "reaction");
    return true;
  }
}

// Minimal type stubs
interface BotAdapterLike {
  process(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    logic: (context: TurnContextLike) => Promise<void>,
  ): Promise<void>;
}

interface TurnContextLike {
  activity: {
    type: string;
    text?: string;
    conversation: { id: string };
    from: { id: string };
    timestamp?: string;
  };
  sendActivity(text: string): Promise<void>;
}
