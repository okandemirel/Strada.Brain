/**
 * Matrix Channel - Decentralized chat via Matrix protocol
 *
 * Requires: matrix-js-sdk (npm install matrix-js-sdk)
 * Config: MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, MATRIX_USER_ID,
 *         MATRIX_ALLOWED_USER_IDS, MATRIX_ALLOWED_ROOM_IDS
 */

import type {
  IChannelAdapter,
  IChannelRichMessaging,
} from "../channel.interface.js";
import type { IncomingMessage, Attachment } from "../channel-messages.interface.js";
import { getLogger } from "../../utils/logger.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export class MatrixChannel implements IChannelAdapter, IChannelRichMessaging {
  readonly name = "matrix";

  private handler: MessageHandler | null = null;
  private client: unknown = null;
  private healthy = false;

  constructor(
    private readonly homeserver: string,
    private readonly accessToken: string,
    private readonly userId: string,
    private readonly allowedUserIds: readonly string[] = [],
    private readonly allowedRoomIds: readonly string[] = [],
  ) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    const logger = getLogger();
    // Dynamic import to avoid hard dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

      const content = event.getContent();
      if (content.msgtype !== "m.text") return;

      const msg: IncomingMessage = {
        channelType: "matrix",
        chatId: roomId,
        userId: sender,
        text: content.body,
        timestamp: new Date(event.getTs()),
      };

      this.handler?.(msg).catch(() => {});
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

  private isAllowedInboundMessage(userId: string, roomId: string): boolean {
    const userAllowed = this.allowedUserIds.length === 0 || this.allowedUserIds.includes(userId);
    const roomAllowed = this.allowedRoomIds.length === 0 || this.allowedRoomIds.includes(roomId);
    return userAllowed && roomAllowed;
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
}

interface MatrixEvent {
  getType(): string;
  getSender(): string;
  getRoomId(): string;
  getTs(): number;
  getContent(): { msgtype: string; body: string; [key: string]: unknown };
}
