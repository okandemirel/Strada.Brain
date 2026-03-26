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
import { getLogger } from "../../utils/logger.js";
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

export class MatrixChannel implements IChannelAdapter, IChannelRichMessaging {
  readonly name = "matrix";

  private handler: MessageHandler | null = null;
  private client: unknown = null;
  private healthy = false;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
  /** Per-roomId applied instinct IDs for feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();

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

    client.on("Room.timeline", (event: MatrixEvent) => {
      if (event.getType() !== "m.room.message") return;
      const sender = event.getSender();
      const roomId = event.getRoomId();
      if (sender === this.userId) return;
      if (!this.isAllowedInboundMessage(sender, roomId)) return;
      void this.handleTimelineEvent(event, client);
    });

    await client.startClient({ initialSyncLimit: 0 });
    this.healthy = true;
    logger.info("Matrix channel connected", { userId: this.userId });
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    const client = this.client as MatrixClientLike | null;
    if (client) {
      client.stopClient();
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const client = this.client as MatrixClientLike;
    await client.sendTextMessage(chatId, text);
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    const client = this.client as MatrixClientLike;
    // Matrix m.room.message with format=org.matrix.custom.html
    // Plain text fallback strips markdown, HTML body preserves it
    const plainText = markdown
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/`(.*?)`/g, "$1");
    await client.sendHtmlMessage(chatId, plainText, markdown);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    const client = this.client as MatrixClientLike;
    await client.sendTyping(chatId, true, 5000);
  }

  async sendAttachment(chatId: string, attachment: Attachment): Promise<void> {
    await this.sendText(chatId, `[Attachment: ${attachment.name}]`);
  }

  private async handleTimelineEvent(event: MatrixEvent, client: MatrixClientLike): Promise<void> {
    const content = event.getContent();

    if (content.msgtype === "m.text") {
      const trimmedBody = (content.body ?? "").trim();
      if (this.feedbackReactionCallback) {
        let feedbackType: "thumbs_up" | "thumbs_down" | null = null;
        if (FEEDBACK_UP_PATTERNS.includes(trimmedBody)) {
          feedbackType = "thumbs_up";
        } else if (FEEDBACK_DOWN_PATTERNS.includes(trimmedBody)) {
          feedbackType = "thumbs_down";
        }
        if (feedbackType) {
          const instinctIds = this.appliedInstinctIds.get(event.getRoomId());
          if (instinctIds && instinctIds.length > 0) {
            this.feedbackReactionCallback(feedbackType, instinctIds, event.getSender(), "reaction");
            return;
          }
        }
      }
    }

    const msg = await this.toIncomingMessage(event, client);
    if (!msg) return;
    this.handler?.(msg).catch(() => {});
  }

  private async toIncomingMessage(
    event: MatrixEvent,
    client: MatrixClientLike,
  ): Promise<IncomingMessage | null> {
    const content = event.getContent();
    const attachments = await this.extractAttachments(content, client);

    let text = content.msgtype === "m.text"
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
      chatId: event.getRoomId(),
      userId: event.getSender(),
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
}

// Minimal type stubs to avoid hard matrix-js-sdk type dependency
interface MatrixClientLike {
  on(event: string, handler: (event: MatrixEvent) => void): void;
  startClient(opts: { initialSyncLimit: number }): Promise<void>;
  stopClient(): void;
  sendTextMessage(roomId: string, text: string): Promise<void>;
  sendHtmlMessage(roomId: string, text: string, html: string): Promise<void>;
  sendTyping(roomId: string, typing: boolean, timeout: number): Promise<void>;
  mxcUrlToHttp?(mxcUrl: string): string | null;
}

interface MatrixEvent {
  getType(): string;
  getSender(): string;
  getRoomId(): string;
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
