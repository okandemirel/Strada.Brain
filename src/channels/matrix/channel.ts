/**
 * Matrix Channel - Decentralized chat via Matrix protocol
 *
 * Requires: matrix-js-sdk (npm install matrix-js-sdk)
 * Config: MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, MATRIX_USER_ID,
 *         MATRIX_ALLOWED_USER_IDS, MATRIX_ALLOWED_ROOM_IDS, MATRIX_ALLOW_OPEN_ACCESS
 */

import { createDecipheriv, createHash } from "node:crypto";
import type {
  IChannelAdapter,
  IChannelRichMessaging,
} from "../channel.interface.js";
import { limitIncomingText, type IncomingMessage, type Attachment } from "../channel-messages.interface.js";
import { chunkText } from "../chunk-text.js";
import { getLogger, getLoggerSafe } from "../../utils/logger.js";
import { isAllowedByDualAllowlistPolicy } from "../../security/access-policy.js";
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

/** Patterns recognised as feedback input (text-based, since Matrix reactions require extra event handling). */
const FEEDBACK_UP_PATTERNS = ["\uD83D\uDC4D", "/feedback up"];
const FEEDBACK_DOWN_PATTERNS = ["\uD83D\uDC4E", "/feedback down"];

/**
 * Conservative per-message character budget. Matrix limits a single PDU/event to
 * roughly 65536 bytes (and many homeservers reject smaller). We chunk well under
 * that to leave headroom for multi-byte characters and HTML expansion applied to
 * the formatted body. Measured in JS string length (UTF-16 code units).
 */
const MATRIX_MAX_CHARS = 32000;

/** Max attempts (initial + retries) for a transient/rate-limited send. */
const MATRIX_SEND_MAX_ATTEMPTS = 4;
/** Base backoff (ms) used when the server does not supply retry_after_ms. */
const MATRIX_SEND_BASE_BACKOFF_MS = 500;

/** Matrix msgtype for each outbound attachment kind. */
const MATRIX_MSGTYPE_BY_TYPE: Record<Attachment["type"], string> = {
  audio: "m.audio",
  image: "m.image",
  video: "m.video",
  file: "m.file",
  document: "m.file",
};

/** Escape HTML-significant characters (order matters: & first). */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a minimal, dependency-free markdown subset (**bold**, *italic*, `code`)
 * to Matrix custom HTML. Escapes FIRST so any `<`/`>`/`&` in the content is inert
 * before markup is applied \u2014 the raw-markdown-as-formatted_body path otherwise
 * both mis-rendered (literal asterisks) and injected unescaped HTML.
 *
 * Newlines are converted to <br/> last: in Matrix org.matrix.custom.html clients
 * follow HTML whitespace-collapsing, so raw newlines in formatted_body would
 * otherwise collapse and multi-line replies would lose their line breaks.
 */
function markdownToMatrixHtml(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`(.*?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br/>");
}

export class MatrixChannel implements IChannelAdapter, IChannelRichMessaging {
  readonly name = "matrix";

  private handler: MessageHandler | null = null;
  private client: unknown = null;
  private healthy = false;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
  /** Per-roomId applied instinct IDs for feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();
  /** Stored timeline handler so it can be removed on disconnect (no listener leak). */
  private timelineHandler: TimelineHandler | null = null;
  /** Stored sync handler so it can be removed on disconnect. */
  private syncHandler: SyncHandler | null = null;

  constructor(
    private readonly homeserver: string,
    private readonly accessToken: string,
    private readonly userId: string,
    private readonly allowedUserIds: readonly string[] = [],
    private readonly allowedRoomIds: readonly string[] = [],
    private readonly allowOpenAccess: boolean = false,
  ) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register a callback for feedback reactions (thumbs up/down). */
  setFeedbackHandler(callback: FeedbackReactionCallback | null): void {
    this.feedbackReactionCallback = callback;
  }

  /** Set the applied instinct IDs for a room so feedback can be attributed. */
  setAppliedInstinctIds(chatId: string, instinctIds: string[]): void {
    if (instinctIds.length > 0) {
      this.appliedInstinctIds.set(chatId, instinctIds);
    } else {
      this.appliedInstinctIds.delete(chatId);
    }
  }

  async connect(): Promise<void> {
    const logger = getLogger();
    // Dynamic import to avoid hard dependency
    const { createClient } = await import("matrix-js-sdk" as string);

    this.client = createClient({
      baseUrl: this.homeserver,
      accessToken: this.accessToken,
      userId: this.userId,
    }) as MatrixClientLike;

    const client = this.client as MatrixClientLike;

    this.timelineHandler = (
      event: MatrixEvent,
      _room: unknown,
      toStartOfTimeline?: boolean,
      removed?: boolean,
      data?: { liveEvent?: boolean },
    ): void => {
      // Only process live events. matrix-js-sdk re-emits Room.timeline for
      // backfilled/paginated history (toStartOfTimeline), redaction/removal
      // re-emits (removed), and flags non-live events via data.liveEvent.
      // Without this guard, historical messages get reprocessed as if new.
      if (!this.isLiveTimelineEvent(toStartOfTimeline, removed, data)) return;
      if (event.getType() !== "m.room.message") return;
      const sender = event.getSender();
      const roomId = event.getRoomId();
      // Real matrix-js-sdk events can have undefined sender/roomId (room-less
      // or pre-room events); without these, the event can't be attributed or routed.
      if (!sender || !roomId) return;
      if (sender === this.userId) return;
      if (!this.isAllowedInboundMessage(sender, roomId)) return;
      void this.handleTimelineEvent(event, client);
    };
    client.on("Room.timeline", this.timelineHandler);

    // Track sync lifecycle so a dropped/failed long-poll flips isHealthy() false
    // instead of leaving it stuck true forever. matrix-js-sdk auto-retries sync;
    // we simply mirror the reported state.
    this.syncHandler = (state: string): void => {
      if (state === "PREPARED" || state === "SYNCING") {
        this.healthy = true;
      } else if (state === "ERROR" || state === "STOPPED" || state === "RECONNECTING") {
        this.healthy = false;
      }
    };
    client.on("sync", this.syncHandler);

    await client.startClient({ initialSyncLimit: 0 });
    this.healthy = true;
    logger.info("Matrix channel connected", { userId: this.userId });
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    const client = this.client as MatrixClientLike | null;
    if (client) {
      if (this.timelineHandler) {
        client.removeListener?.("Room.timeline", this.timelineHandler);
      }
      if (this.syncHandler) {
        client.removeListener?.("sync", this.syncHandler);
      }
      client.stopClient();
    }
    this.timelineHandler = null;
    this.syncHandler = null;
    this.client = null;
    this.appliedInstinctIds.clear();
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const client = this.client as MatrixClientLike;
    // Split oversized replies (Matrix hard-rejects events past ~65KB) and send
    // each chunk; skip empty input so we never post a blank event.
    for (const chunk of chunkText(text, MATRIX_MAX_CHARS)) {
      await this.sendWithRetry(() => client.sendTextMessage(chatId, chunk));
    }
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    const client = this.client as MatrixClientLike;
    // Chunk on the raw markdown so HTML expansion of each chunk still stays under
    // the event cap, then render each chunk to plain + HTML bodies.
    for (const chunk of chunkText(markdown, MATRIX_MAX_CHARS)) {
      // Matrix m.room.message with format=org.matrix.custom.html
      // Plain text fallback strips markdown, HTML body preserves it
      const plainText = chunk
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`(.*?)`/g, "$1");
      await this.sendWithRetry(() =>
        client.sendHtmlMessage(chatId, plainText, markdownToMatrixHtml(chunk)),
      );
    }
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    const client = this.client as MatrixClientLike;
    await client.sendTyping(chatId, true, 5000);
  }

  async sendAttachment(chatId: string, attachment: Attachment): Promise<void> {
    const client = this.client as MatrixClientLike;

    // Without raw bytes we cannot upload to the homeserver; fall back to a text
    // placeholder so the user is at least notified of the attachment.
    if (!attachment.data) {
      await this.sendText(chatId, `[Attachment: ${attachment.name}]`);
      return;
    }

    if (typeof client.uploadContent !== "function" || typeof client.sendMessage !== "function") {
      await this.sendText(chatId, `[Attachment: ${attachment.name}]`);
      return;
    }

    const upload = await this.sendWithRetry(() =>
      client.uploadContent!(attachment.data!, {
        type: attachment.mimeType,
        name: attachment.name,
      }),
    );
    const mxcUrl = upload.content_uri;

    const msgtype = MATRIX_MSGTYPE_BY_TYPE[attachment.type];
    const info: Record<string, unknown> = {};
    if (attachment.mimeType) info.mimetype = attachment.mimeType;
    if (typeof attachment.size === "number") info.size = attachment.size;

    await this.sendWithRetry(() =>
      client.sendMessage!(chatId, {
        msgtype,
        body: attachment.name,
        url: mxcUrl,
        ...(Object.keys(info).length > 0 ? { info } : {}),
      }),
    );
  }

  /**
   * Run a single SDK send with bounded retry. Matrix homeservers return
   * M_LIMIT_EXCEEDED (HTTP 429) with retry_after_ms under flood protection; we
   * honor that delay when present, otherwise fall back to exponential backoff.
   * Non-rate-limit errors are retried a couple of times for transient failures
   * then rethrown so the caller still sees a hard failure.
   */
  private async sendWithRetry<T>(send: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MATRIX_SEND_MAX_ATTEMPTS; attempt++) {
      try {
        return await send();
      } catch (error) {
        lastError = error;
        if (attempt === MATRIX_SEND_MAX_ATTEMPTS) break;
        const retryAfterMs = this.extractRetryAfterMs(error);
        const delayMs = retryAfterMs ?? MATRIX_SEND_BASE_BACKOFF_MS * 2 ** (attempt - 1);
        getLoggerSafe().warn("Matrix send failed; retrying", {
          attempt,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  /** Read retry_after_ms from a matrix-js-sdk rate-limit (M_LIMIT_EXCEEDED) error. */
  private extractRetryAfterMs(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const err = error as {
      errcode?: string;
      httpStatus?: number;
      data?: { retry_after_ms?: number };
    };
    if (err.errcode === "M_LIMIT_EXCEEDED" || err.httpStatus === 429) {
      const retry = err.data?.retry_after_ms;
      if (typeof retry === "number" && Number.isFinite(retry) && retry >= 0) {
        return retry;
      }
    }
    return undefined;
  }

  /** msgtypes whose content.body is plain user text we should route. */
  private isTextMsgType(msgtype: string): boolean {
    return msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote";
  }

  private async handleTimelineEvent(event: MatrixEvent, client: MatrixClientLike): Promise<void> {
    const content = event.getContent();

    if (this.isTextMsgType(content.msgtype)) {
      const trimmedBody = (content.body ?? "").trim();
      if (this.feedbackReactionCallback) {
        let feedbackType: "thumbs_up" | "thumbs_down" | null = null;
        if (FEEDBACK_UP_PATTERNS.includes(trimmedBody)) {
          feedbackType = "thumbs_up";
        } else if (FEEDBACK_DOWN_PATTERNS.includes(trimmedBody)) {
          feedbackType = "thumbs_down";
        }
        if (feedbackType) {
          const roomId = event.getRoomId();
          const instinctIds = roomId ? this.appliedInstinctIds.get(roomId) : undefined;
          if (instinctIds && instinctIds.length > 0) {
            this.feedbackReactionCallback(feedbackType, instinctIds, event.getSender() ?? undefined, "reaction");
            return;
          }
        }
      }
    }

    const msg = await this.toIncomingMessage(event, client);
    if (!msg) return;
    this.handler?.(msg).catch((err) => {
      getLogger().warn("Message handler failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }

  private async toIncomingMessage(
    event: MatrixEvent,
    client: MatrixClientLike,
  ): Promise<IncomingMessage | null> {
    const sender = event.getSender();
    const roomId = event.getRoomId();
    // Real matrix-js-sdk events may have undefined sender/roomId; without these
    // the message cannot be attributed or routed, so drop it.
    if (!sender || !roomId) {
      return null;
    }

    const content = event.getContent();
    const attachments = await this.extractAttachments(content, client);

    let text = this.isTextMsgType(content.msgtype)
      ? limitIncomingText(content.body ?? "")
      : attachments.some((attachment) => attachment.type === "audio")
        ? "(voice message)"
        : "";

    if (!text && attachments.length === 0) {
      return null;
    }

    if (text === "(voice message)" && attachments.length === 0) {
      text = "";
    }

    return {
      channelType: "matrix",
      chatId: roomId,
      userId: sender,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: new Date(event.getTs()),
    };
  }

  private async extractAttachments(
    content: MatrixMessageContent,
    client: MatrixClientLike,
  ): Promise<Attachment[]> {
    if (!["m.audio", "m.file", "m.image", "m.video"].includes(content.msgtype)) {
      return [];
    }

    const declaredMimeType = content.info?.mimetype ?? content.file?.mimetype ?? this.inferMimeTypeFromName(content.body);
    const declaredType = content.msgtype === "m.audio"
      ? "audio"
      : content.msgtype === "m.image"
        ? "image"
        : content.msgtype === "m.video"
          ? "video"
          : mimeToAttachmentType(declaredMimeType);

    const resolvedUrl = this.resolveMediaUrl(content, client);
    let effectiveMimeType = declaredMimeType;
    let data: Buffer | undefined;
    let size = content.info?.size ?? 0;

    if (resolvedUrl) {
      const downloaded = await downloadMedia(resolvedUrl);
      if (downloaded) {
        if (this.isEncryptedFile(content.file)) {
          const decrypted = this.decryptAttachment(downloaded.data, content.file);
          if (!decrypted) {
            return [];
          }
          data = decrypted;
          size = decrypted.length;
        } else {
          data = downloaded.data;
          size = downloaded.size;
          effectiveMimeType = downloaded.mimeType || effectiveMimeType;
        }
      }
    }

    const type = content.msgtype === "m.file"
      ? mimeToAttachmentType(effectiveMimeType)
      : declaredType;

    const validation = validateMediaAttachment({
      mimeType: effectiveMimeType,
      size,
      type,
    });
    if (!validation.valid) {
      return [];
    }

    if (data && effectiveMimeType && !validateMagicBytes(data, effectiveMimeType)) {
      return [];
    }

    return [{
      type,
      name: content.body || this.defaultAttachmentName(type),
      url: resolvedUrl,
      mimeType: effectiveMimeType,
      size,
      data,
    }];
  }

  private resolveMediaUrl(content: MatrixMessageContent, client: MatrixClientLike): string | undefined {
    const rawUrl = typeof content.url === "string"
      ? content.url
      : typeof content.file?.url === "string"
        ? content.file.url
        : undefined;

    if (!rawUrl) return undefined;
    if (rawUrl.startsWith("mxc://")) {
      return client.mxcUrlToHttp?.(rawUrl) ?? undefined;
    }
    return rawUrl;
  }

  private defaultAttachmentName(type: Attachment["type"]): string {
    if (type === "audio") return "audio";
    if (type === "image") return "image";
    if (type === "video") return "video";
    return "file";
  }

  private isEncryptedFile(file?: MatrixEncryptedFileInfo): boolean {
    return Boolean(file?.key?.k || file?.iv || file?.hashes?.sha256);
  }

  private inferMimeTypeFromName(name?: string): string | undefined {
    const lowerName = name?.toLowerCase() ?? "";
    if (lowerName.endsWith(".mp3")) return "audio/mpeg";
    if (lowerName.endsWith(".m4a")) return "audio/mp4";
    if (lowerName.endsWith(".wav")) return "audio/wav";
    if (lowerName.endsWith(".ogg") || lowerName.endsWith(".oga")) return "audio/ogg";
    if (lowerName.endsWith(".webm")) return "audio/webm";
    if (lowerName.endsWith(".mp4")) return "video/mp4";
    if (lowerName.endsWith(".png")) return "image/png";
    if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
    if (lowerName.endsWith(".gif")) return "image/gif";
    if (lowerName.endsWith(".webp")) return "image/webp";
    if (lowerName.endsWith(".pdf")) return "application/pdf";
    if (lowerName.endsWith(".txt")) return "text/plain";
    if (lowerName.endsWith(".csv")) return "text/csv";
    return undefined;
  }

  private decryptAttachment(data: Buffer, file?: MatrixEncryptedFileInfo): Buffer | null {
    if (!file?.url || !file.key?.k || !file.iv || !file.hashes?.sha256) {
      return null;
    }
    if (file.key.alg !== "A256CTR") {
      return null;
    }

    try {
      const expectedHash = Buffer.from(file.hashes.sha256, "base64url");
      const actualHash = createHash("sha256").update(data).digest();
      if (!actualHash.equals(expectedHash)) {
        return null;
      }

      const key = Buffer.from(file.key.k, "base64url");
      const iv = Buffer.from(file.iv, "base64url");
      if (key.length !== 32 || iv.length !== 16) {
        return null;
      }

      const decipher = createDecipheriv("aes-256-ctr", key, iv);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      return null;
    }
  }

  private isAllowedInboundMessage(userId: string, roomId: string): boolean {
    return isAllowedByDualAllowlistPolicy({
      primaryId: userId,
      primaryAllowlist: this.allowedUserIds,
      secondaryId: roomId,
      secondaryAllowlist: this.allowedRoomIds,
      emptyAllowlistMode: this.allowOpenAccess ? "open" : "closed",
    });
  }

  /**
   * True only for live timeline events. Filters out backfilled/paginated
   * history (toStartOfTimeline), redaction/removal re-emits (removed), and any
   * event the SDK explicitly flags non-live (data.liveEvent === false).
   * Defaults to live when the flags are absent (older SDK / synthetic emits),
   * so real messages are never dropped.
   */
  private isLiveTimelineEvent(
    toStartOfTimeline?: boolean,
    removed?: boolean,
    data?: { liveEvent?: boolean },
  ): boolean {
    if (toStartOfTimeline || removed) return false;
    if (data && data.liveEvent === false) return false;
    return true;
  }
}

// Minimal type stubs to avoid hard matrix-js-sdk type dependency
type TimelineHandler = (
  event: MatrixEvent,
  room: unknown,
  toStartOfTimeline?: boolean,
  removed?: boolean,
  data?: { liveEvent?: boolean },
) => void;

type SyncHandler = (state: string) => void;

interface MatrixClientLike {
  on(event: "Room.timeline", handler: TimelineHandler): void;
  on(event: "sync", handler: SyncHandler): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: "Room.timeline", handler: TimelineHandler): void;
  removeListener?(event: "sync", handler: SyncHandler): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  startClient(opts: { initialSyncLimit: number }): Promise<void>;
  stopClient(): void;
  sendTextMessage(roomId: string, text: string): Promise<void>;
  sendHtmlMessage(roomId: string, text: string, html: string): Promise<void>;
  sendTyping(roomId: string, typing: boolean, timeout: number): Promise<void>;
  mxcUrlToHttp?(mxcUrl: string): string | null;
  uploadContent?(
    data: Buffer,
    opts?: { type?: string; name?: string },
  ): Promise<{ content_uri: string }>;
  sendMessage?(roomId: string, content: Record<string, unknown>): Promise<unknown>;
}

interface MatrixEvent {
  getType(): string;
  getSender(): string | undefined;
  getRoomId(): string | undefined;
  getTs(): number;
  getContent(): MatrixMessageContent;
}

interface MatrixMessageContent {
  msgtype: string;
  body?: string;
  url?: string;
  file?: MatrixEncryptedFileInfo;
  info?: {
    mimetype?: string;
    size?: number;
  };
  [key: string]: unknown;
}

interface MatrixEncryptedFileInfo {
  url?: string;
  mimetype?: string;
  iv?: string;
  hashes?: {
    sha256?: string;
  };
  key?: {
    k?: string;
    alg?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
