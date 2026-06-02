/**
 * Microsoft Teams Channel - Bot Framework adapter
 *
 * Requires: botframework-connector, botbuilder (npm install botbuilder)
 * Config: TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_ALLOWED_USER_IDS, TEAMS_ALLOW_OPEN_ACCESS
 */

import type { IChannelAdapter } from "../channel.interface.js";
import { limitIncomingText, type Attachment, type IncomingMessage } from "../channel-messages.interface.js";
import { chunkText } from "../chunk-text.js";
import { getLogger } from "../../utils/logger.js";
import { isAllowedBySingleIdPolicy } from "../../security/access-policy.js";
import {
  downloadMedia,
  mimeToAttachmentType,
  validateMagicBytes,
  validateMediaAttachment,
} from "../../utils/media-processor.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Conservative per-message character cap for Teams / Bot Framework. Activities
 * have a payload limit (~28 KB) and channels truncate or reject long text, so we
 * split well under that to leave headroom for UTF-16/UTF-8 expansion and markup.
 */
const TEAMS_MAX_MESSAGE_LENGTH = 18_000;

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
  private turnContextClass: TurnContextStaticLike | null = null;
  private server: import("node:http").Server | null = null;
  private healthy = false;
  private activeTurnContexts = new Map<string, TurnContextLike>();
  /**
   * Persisted Bot Framework conversation references keyed by chatId. Unlike the
   * ephemeral per-request turn context (deleted when the inbound handler
   * returns), these survive after the request completes so asynchronous,
   * fire-and-forget agent replies can be delivered proactively via
   * adapter.continueConversationAsync.
   */
  private readonly conversationReferences = new Map<string, ConversationReferenceLike>();
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
    const { CloudAdapter, ConfigurationBotFrameworkAuthentication, TurnContext } =
      await import("botbuilder" as string);

    const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.appId,
      MicrosoftAppPassword: this.appPassword,
      MicrosoftAppType: "MultiTenant",
    });

    this.adapter = new CloudAdapter(botFrameworkAuth) as unknown as BotAdapterLike;
    this.turnContextClass = TurnContext as unknown as TurnContextStaticLike;

    // Create HTTP server for Bot Framework messages
    const { createServer } = await import("node:http");
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    // net.Server.listen reports bind failures (EADDRINUSE/EACCES) via an 'error'
    // event, NOT the listening callback. Without a one-shot error listener the
    // promise would never settle (hanging boot) or surface as an
    // unhandledRejection. Reject so the caller can fail fast.
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error): void => {
        server.removeListener("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(this.port, this.listenHost, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    this.healthy = true;
    logger.info("Teams channel listening", { port: this.port, host: this.listenHost });
  }

  /**
   * Handle one inbound Bot Framework HTTP request. A throw from adapter.process
   * (auth/JWT verification failure, malformed activity) on the public
   * /api/messages endpoint must NOT escape: an unhandledRejection here trips the
   * global handler in src/index.ts and shuts the whole daemon down (remote DoS).
   * Catch it, log, and always close the socket.
   */
  private async handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (req.method === "POST" && req.url === "/api/messages") {
      try {
        await (this.adapter as BotAdapterLike).process(req, res, async (context: TurnContextLike) => {
          if (context.activity.type === "message") {
            if (!this.isAllowedInboundUser(context.activity.from.id)) {
              return;
            }

            const chatId = context.activity.conversation.id;

            // Persist a conversation reference so asynchronous (fire-and-forget)
            // agent replies can be delivered proactively after this request's
            // ephemeral turn context has been torn down.
            this.captureConversationReference(chatId, context.activity);

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
      } catch (err) {
        getLogger().error("Teams request processing failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    this.activeTurnContexts.clear();
    this.conversationReferences.clear();
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
    // Plain-text intent: render verbatim so user/tool-derived content cannot
    // inject Teams markdown/HTML (Bot Framework defaults text to markdown).
    await this.deliver(chatId, text, "plain");
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    // Markdown intent: leave Bot Framework's default markdown rendering in place.
    await this.deliver(chatId, markdown, "markdown");
  }

  /**
   * Split `body` into provider-safe chunks and deliver each non-empty piece.
   *
   * Outbound delivery is stateless: it prefers the synchronous turn context if
   * one is still active for the chat, otherwise it sends proactively via the
   * persisted conversation reference. This is what makes asynchronous,
   * fire-and-forget agent replies reach the user — the ephemeral turn context is
   * already gone by the time the answer is ready.
   */
  private async deliver(
    chatId: string,
    body: string,
    format: "plain" | "markdown",
  ): Promise<void> {
    const chunks = chunkText(body, TEAMS_MAX_MESSAGE_LENGTH);
    if (chunks.length === 0) return; // nothing to send (empty/whitespace input)

    const context = this.activeTurnContexts.get(chatId);
    const reference = this.conversationReferences.get(chatId);

    if (!context && !reference) {
      throw new Error(`No active Teams conversation for: ${chatId}`);
    }

    for (const chunk of chunks) {
      const activity: OutgoingActivityLike = {
        type: "message",
        text: chunk,
        textFormat: format,
      };

      if (context) {
        // Fast path: a turn context is still active for this chat.
        await context.sendActivity(activity);
      } else {
        // Proactive path: deliver via the persisted conversation reference.
        await this.adapter!.continueConversationAsync(
          this.appId,
          reference!,
          async (proactive) => {
            await proactive.sendActivity(activity);
          },
        );
      }
    }
  }

  /** Capture and persist a Bot Framework conversation reference for a chat. */
  private captureConversationReference(chatId: string, activity: TeamsActivityLike): void {
    if (!this.turnContextClass) return;
    try {
      const reference = this.turnContextClass.getConversationReference(activity);
      this.conversationReferences.set(chatId, reference);
    } catch (err) {
      getLogger().warn("Teams failed to capture conversation reference", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

/** Outgoing Bot Framework activity payload (subset we set). */
interface OutgoingActivityLike {
  type: string;
  text: string;
  textFormat: "plain" | "markdown";
}

/** Opaque Bot Framework conversation reference for proactive messaging. */
type ConversationReferenceLike = Record<string, unknown>;

interface BotAdapterLike {
  process(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    logic: (context: TurnContextLike) => Promise<void>,
  ): Promise<void>;
  /** Proactively continue a conversation from a stored reference. */
  continueConversationAsync(
    botAppId: string,
    reference: ConversationReferenceLike,
    logic: (context: TurnContextLike) => Promise<void>,
  ): Promise<void>;
}

/** Static surface of botbuilder's TurnContext class that we rely on. */
interface TurnContextStaticLike {
  getConversationReference(activity: TeamsActivityLike): ConversationReferenceLike;
}

interface TurnContextLike {
  activity: TeamsActivityLike;
  sendActivity(activityOrText: string | OutgoingActivityLike): Promise<void>;
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
