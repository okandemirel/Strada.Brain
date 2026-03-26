/**
 * Microsoft Teams Channel - Bot Framework adapter
 *
 * Requires: botframework-connector, botbuilder (npm install botbuilder)
 * Config: TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_ALLOWED_USER_IDS, TEAMS_ALLOW_OPEN_ACCESS
 */

import type { IChannelAdapter } from "../channel.interface.js";
import { limitIncomingText, type Attachment, type IncomingMessage } from "../channel-messages.interface.js";
import { getLogger } from "../../utils/logger.js";
import { isAllowedBySingleIdPolicy } from "../../security/access-policy.js";
import {
  downloadMedia,
  mimeToAttachmentType,
  validateMagicBytes,
  validateMediaAttachment,
} from "../../utils/media-processor.js";

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
          if (context.activity.type === "message") {
            if (!this.isAllowedInboundUser(context.activity.from.id)) {
              return;
            }

            const chatId = context.activity.conversation.id;

            // Detect feedback before routing to the normal handler
            const feedbackType = context.activity.text
              ? this.detectFeedback(context.activity.text)
              : null;
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

            const msg = await this.toIncomingMessage(context.activity);
            if (!msg) {
              if (this.activeTurnContexts.get(chatId) === context) {
                this.activeTurnContexts.delete(chatId);
              }
              return;
            }

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

  private async toIncomingMessage(activity: TeamsActivityLike): Promise<IncomingMessage | null> {
    const attachments = await this.extractAttachments(activity);
    const normalizedText = typeof activity.text === "string"
      ? limitIncomingText(activity.text)
      : attachments.some((attachment) => attachment.type === "audio")
        ? "(voice message)"
        : "";

    if (!normalizedText && attachments.length === 0) {
      return null;
    }

    return {
      channelType: "teams",
      chatId: activity.conversation.id,
      userId: activity.from.id,
      text: normalizedText,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: new Date(activity.timestamp ?? Date.now()),
    };
  }

  private async extractAttachments(activity: TeamsActivityLike): Promise<Attachment[]> {
    const rawAttachments = Array.isArray(activity.attachments) ? activity.attachments : [];
    const attachments: Attachment[] = [];

    for (const raw of rawAttachments) {
      const inferredMimeType = this.resolveAttachmentMimeType(raw);
      const inferredType = mimeToAttachmentType(inferredMimeType);
      const resolvedUrl = this.resolveAttachmentUrl(raw);

      let effectiveMimeType = inferredMimeType;
      let data: Buffer | undefined;
      let size = 0;

      if (resolvedUrl) {
        const downloaded = await downloadMedia(resolvedUrl);
        if (downloaded) {
          effectiveMimeType = downloaded.mimeType || effectiveMimeType;
          data = downloaded.data;
          size = downloaded.size;
        }
      }

      const type = effectiveMimeType ? mimeToAttachmentType(effectiveMimeType) : inferredType;

      const validation = validateMediaAttachment({
        mimeType: effectiveMimeType,
        size,
        type,
      });
      if (!validation.valid) continue;
      if (data && effectiveMimeType && !validateMagicBytes(data, effectiveMimeType)) continue;

      attachments.push({
        type,
        name: this.resolveAttachmentName(raw) || this.defaultAttachmentName(type),
        url: resolvedUrl,
        mimeType: effectiveMimeType,
        size,
        data,
      });
    }

    return attachments;
  }

  private resolveAttachmentUrl(attachment: TeamsAttachmentLike): string | undefined {
    if (typeof attachment.contentUrl === "string" && attachment.contentUrl.length > 0) {
      return attachment.contentUrl;
    }
    if (typeof attachment.content?.downloadUrl === "string" && attachment.content.downloadUrl.length > 0) {
      return attachment.content.downloadUrl;
    }
    return undefined;
  }

  private resolveAttachmentMimeType(attachment: TeamsAttachmentLike): string | undefined {
    const contentType = attachment.contentType?.trim();
    if (contentType && !contentType.startsWith("application/vnd.microsoft")) {
      return contentType;
    }

    const embeddedMimeType = typeof attachment.content?.mimeType === "string"
      ? attachment.content.mimeType.trim()
      : typeof attachment.content?.contentType === "string"
        ? attachment.content.contentType.trim()
        : "";
    if (embeddedMimeType && !embeddedMimeType.startsWith("application/vnd.microsoft")) {
      return embeddedMimeType;
    }

    const embeddedFileType = typeof attachment.content?.fileType === "string"
      ? attachment.content.fileType.trim().toLowerCase()
      : "";
    if (embeddedFileType) {
      return this.inferMimeTypeFromExtension(embeddedFileType);
    }

    const lowerName = attachment.name?.toLowerCase() ?? "";
    return this.inferMimeTypeFromExtension(lowerName);
  }

  private resolveAttachmentName(attachment: TeamsAttachmentLike): string | undefined {
    const directName = attachment.name?.trim();
    if (directName) return directName;

    const embeddedName = typeof attachment.content?.name === "string"
      ? attachment.content.name.trim()
      : typeof attachment.content?.fileName === "string"
        ? attachment.content.fileName.trim()
        : "";
    if (embeddedName) return embeddedName;

    const fileType = typeof attachment.content?.fileType === "string"
      ? attachment.content.fileType.trim().toLowerCase()
      : "";
    if (fileType) {
      return `attachment.${fileType.replace(/^\./, "")}`;
    }

    return undefined;
  }

  private inferMimeTypeFromExtension(value: string): string | undefined {
    const normalized = value.startsWith(".") ? value : value.includes(".") ? value.slice(value.lastIndexOf(".")) : `.${value}`;
    if (normalized === ".mp3") return "audio/mpeg";
    if (normalized === ".m4a") return "audio/mp4";
    if (normalized === ".wav") return "audio/wav";
    if (normalized === ".ogg" || normalized === ".oga") return "audio/ogg";
    if (normalized === ".webm") return "audio/webm";
    if (normalized === ".mp4") return "video/mp4";
    if (normalized === ".png") return "image/png";
    if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
    if (normalized === ".pdf") return "application/pdf";
    if (normalized === ".txt") return "text/plain";
    if (normalized === ".csv") return "text/csv";
    return undefined;
  }

  private defaultAttachmentName(type: Attachment["type"]): string {
    if (type === "audio") return "audio";
    if (type === "image") return "image";
    if (type === "video") return "video";
    return "file";
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
  activity: TeamsActivityLike;
  sendActivity(text: string): Promise<void>;
}

interface TeamsActivityLike {
  type: string;
  text?: string;
  conversation: { id: string };
  from: { id: string };
  timestamp?: string;
  attachments?: TeamsAttachmentLike[];
}

interface TeamsAttachmentLike {
  name?: string;
  contentType?: string;
  contentUrl?: string;
  content?: {
    downloadUrl?: string;
    mimeType?: string;
    contentType?: string;
    fileType?: string;
    name?: string;
    fileName?: string;
    [key: string]: unknown;
  };
}
