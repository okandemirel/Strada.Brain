/**
 * Microsoft Teams Channel - Bot Framework adapter
 *
 * Requires: botframework-connector, botbuilder (npm install botbuilder)
 * Config: TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_APP_TYPE (MultiTenant|SingleTenant),
 *         TEAMS_APP_TENANT_ID, TEAMS_ALLOWED_USER_IDS, TEAMS_ALLOW_OPEN_ACCESS
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Bot Framework app tenancy model. Single-tenant bots need their tenant id. */
type TeamsAppType = "MultiTenant" | "SingleTenant";

/**
 * On-disk location for persisted conversation references. The in-memory map is
 * lost on restart, which silently drops any reply produced after a restart; we
 * mirror it to a tiny JSON file under `.strada` so proactive delivery survives.
 */
const CONVERSATION_REFERENCES_FILE = join(".strada", "teams-conversation-references.json");

/** Callback for feedback reactions (thumbs up/down) from channel adapters. */
type FeedbackReactionCallback = (
  type: "thumbs_up" | "thumbs_down",
  instinctIds: string[],
  userId?: string,
  source?: "reaction" | "button",
) => void;

/** The minimal structural shape of the optional `botbuilder` package that connect() consumes. */
interface BotbuilderModule {
  CloudAdapter: new (auth: unknown) => unknown;
  ConfigurationBotFrameworkAuthentication: new (config: Record<string, string | undefined>) => unknown;
  TurnContext: unknown;
}

/**
 * Load the optional `botbuilder` dependency. It ships as an optionalDependency, so a
 * platform where its native/transitive install failed must surface an ACTIONABLE error
 * ("reinstall / pick another channel"), not a raw MODULE_NOT_FOUND stack that kills boot
 * with no hint (measured 2026-08-23: bare dynamic import crashed bootstrap-stages).
 */
async function importBotbuilder(): Promise<BotbuilderModule> {
  const mod = (await import("botbuilder" as string)) as Partial<BotbuilderModule> | undefined;
  if (!mod?.CloudAdapter || !mod.ConfigurationBotFrameworkAuthentication || !mod.TurnContext) {
    throw new Error("botbuilder package loaded but is missing expected exports");
  }
  return mod as BotbuilderModule;
}

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
    private readonly appType: TeamsAppType = "MultiTenant",
    private readonly appTenantId?: string,
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
    let botbuilder: BotbuilderModule;
    try {
      botbuilder = await importBotbuilder();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("Teams channel cannot start: the optional 'botbuilder' dependency failed to load", { detail });
      throw new Error(
        "Teams channel requires the optional 'botbuilder' package, which failed to load. "
        + "Reinstall with optional dependencies enabled (`npm install`), or start a different channel "
        + `(\`strada start --channel web|telegram|discord|slack|cli\`). Original error: ${detail}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    const { CloudAdapter, ConfigurationBotFrameworkAuthentication, TurnContext } = botbuilder;

    // Single-tenant bots are issued tokens scoped to their home tenant, so the
    // adapter must be told the tenancy + tenant id or proactive
    // (continueConversationAsync) sends fail. Multi-tenant remains the default.
    const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.appId,
      MicrosoftAppPassword: this.appPassword,
      MicrosoftAppType: this.appType,
      ...(this.appTenantId ? { MicrosoftAppTenantId: this.appTenantId } : {}),
    });

    this.adapter = new CloudAdapter(botFrameworkAuth) as unknown as BotAdapterLike;
    this.turnContextClass = TurnContext as unknown as TurnContextStaticLike;

    // Restore conversation references persisted before the last shutdown so a
    // reply produced after a restart can still be delivered proactively.
    this.restoreConversationReferences();

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
      // Make the dropped delivery loud: with neither a live turn context nor a
      // persisted reference there is no way to reach the user, so surface it
      // clearly instead of letting the reply vanish silently.
      getLogger().warn("Teams cannot deliver reply: no active turn context or stored conversation reference", {
        chatId,
      });
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
      // Mirror to disk so the reference survives a restart and a later
      // fire-and-forget reply can still be delivered proactively.
      this.persistConversationReferences();
    } catch (err) {
      getLogger().warn("Teams failed to capture conversation reference", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Persist the in-memory conversation references to a small JSON file under
   * `.strada`. Best-effort: a write failure must not break inbound handling, so
   * it is logged and swallowed. Bot Framework conversation references are plain
   * JSON-serialisable objects, so a JSON round-trip is lossless.
   */
  private persistConversationReferences(): void {
    try {
      mkdirSync(dirname(CONVERSATION_REFERENCES_FILE), { recursive: true });
      const serialisable = Object.fromEntries(this.conversationReferences);
      writeFileSync(CONVERSATION_REFERENCES_FILE, JSON.stringify(serialisable), "utf8");
    } catch (err) {
      getLogger().warn("Teams failed to persist conversation references", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Restore conversation references from disk into the in-memory map. Best-effort:
   * a missing or malformed file is treated as "no references yet" and logged at
   * debug level so a fresh install does not warn.
   */
  private restoreConversationReferences(): void {
    let raw: string;
    try {
      raw = readFileSync(CONVERSATION_REFERENCES_FILE, "utf8");
    } catch {
      // No persisted file yet (first run / never received a message) — nothing to restore.
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, ConversationReferenceLike>;
      if (parsed && typeof parsed === "object") {
        for (const [chatId, reference] of Object.entries(parsed)) {
          if (reference && typeof reference === "object") {
            this.conversationReferences.set(chatId, reference);
          }
        }
      }
    } catch (err) {
      getLogger().warn("Teams failed to restore conversation references", {
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
