import { EventEmitter } from "node:events";
import { getLogger } from "../../utils/logger.js";
import type {
  IChannelAdapter,
  IncomingMessage,
  ConfirmationRequest,
} from "../channel.interface.js";

/**
 * WhatsApp channel adapter using the Baileys library.
 *
 * Connects to WhatsApp Web via QR code or stored session.
 * Requires: @whiskeysockets/baileys (peer dependency).
 *
 * Setup:
 *   1. Set WHATSAPP_SESSION_PATH in .env (default: .whatsapp-session)
 *   2. On first run, scan the QR code from the terminal
 *   3. Session is persisted for reconnection
 */
export class WhatsAppChannel extends EventEmitter implements IChannelAdapter {
  readonly name = "whatsapp";
  private sock: WhatsAppSocket | null = null;
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private healthy = false;
  private readonly sessionPath: string;
  private readonly allowedNumbers: Set<string>;
  private readonly pendingConfirmations = new Map<
    string,
    { resolve: (value: string) => void; options: string[] }
  >();

  constructor(
    sessionPath = ".whatsapp-session",
    allowedNumbers: string[] = []
  ) {
    super();
    this.sessionPath = sessionPath;
    this.allowedNumbers = new Set(allowedNumbers);
  }

  async connect(): Promise<void> {
    const logger = getLogger();

    try {
      // Dynamic import to make baileys an optional dependency
      // @ts-expect-error — baileys is an optional peer dependency
      const baileys = await import("@whiskeysockets/baileys");
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
      }) as WhatsAppSocket;

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", (update: ConnectionUpdate) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as BoomError)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect) {
            logger.warn("WhatsApp connection lost, reconnecting...");
            void this.connect();
          } else {
            logger.error("WhatsApp logged out. Delete session and re-scan QR.");
            this.healthy = false;
          }
        } else if (connection === "open") {
          logger.info("WhatsApp connected!");
          this.healthy = true;
        }
      });

      this.sock.ev.on("messages.upsert", (upsert: MessagesUpsert) => {
        for (const msg of upsert.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const chatId = msg.key.remoteJid ?? "";
          const senderId = msg.key.participant ?? chatId;
          const text = msg.message.conversation
            ?? msg.message.extendedTextMessage?.text
            ?? "";

          if (!text) continue;

          // Auth check
          if (this.allowedNumbers.size > 0) {
            const normalized = senderId.replace(/@.*$/, "");
            if (!this.allowedNumbers.has(normalized)) {
              logger.warn("WhatsApp: unauthorized number", { senderId });
              void this.sendText(chatId, "Unauthorized. Contact the admin.");
              continue;
            }
          }

          // Check if this is a confirmation response
          const pending = this.pendingConfirmations.get(chatId);
          if (pending) {
            const idx = parseInt(text, 10) - 1;
            if (idx >= 0 && idx < pending.options.length) {
              pending.resolve(pending.options[idx]!);
            } else {
              pending.resolve(pending.options[0]!);
            }
            this.pendingConfirmations.delete(chatId);
            continue;
          }

          const incoming: IncomingMessage = {
            channelType: "whatsapp",
            chatId,
            userId: senderId,
            text,
            timestamp: new Date(
              (msg.messageTimestamp as number) * 1000
            ),
          };

          if (this.messageHandler) {
            void this.messageHandler(incoming);
          }
        }
      });
    } catch (error) {
      const logger = getLogger();
      if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
        logger.error(
          "WhatsApp channel requires @whiskeysockets/baileys. " +
          "Install it: npm install @whiskeysockets/baileys"
        );
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.healthy = false;
    this.pendingConfirmations.clear();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    await this.sock.sendMessage(chatId, { text });
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    // WhatsApp supports basic formatting: *bold*, _italic_, ~strikethrough~, ```code```
    // Convert markdown to WhatsApp format
    const formatted = markdown
      .replace(/\*\*(.+?)\*\*/g, "*$1*")     // **bold** → *bold*
      .replace(/`([^`]+)`/g, "```$1```")      // `code` → ```code```
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");  // # Header → *Header*

    await this.sendText(chatId, formatted);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("composing", chatId);
    } catch {
      // Non-critical
    }
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const optionText = req.options
      .map((opt, i) => `${i + 1}. ${opt}`)
      .join("\n");

    const message = [
      req.question,
      req.details ? `\n${req.details}` : "",
      `\n${optionText}`,
      "\nReply with the number of your choice.",
    ].join("");

    await this.sendText(req.chatId, message);

    return new Promise<string>((resolve) => {
      this.pendingConfirmations.set(req.chatId, {
        resolve,
        options: req.options,
      });

      // Timeout after 2 minutes
      setTimeout(() => {
        if (this.pendingConfirmations.has(req.chatId)) {
          this.pendingConfirmations.delete(req.chatId);
          resolve(req.options[0]!);
        }
      }, 120_000);
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }
}

// Minimal type definitions for baileys to avoid full dependency
/* eslint-disable @typescript-eslint/no-explicit-any */
interface WhatsAppSocket {
  ev: {
    on(event: string, handler: (...args: any[]) => void): void;
  };
  sendMessage(jid: string, content: { text: string }): Promise<any>;
  sendPresenceUpdate(type: string, jid: string): Promise<void>;
  end(reason: any): void;
}

interface ConnectionUpdate {
  connection?: "open" | "close" | "connecting";
  lastDisconnect?: { error?: Error };
}

interface BoomError extends Error {
  output?: { statusCode: number };
}

interface MessagesUpsert {
  messages: Array<{
    key: { remoteJid?: string; fromMe?: boolean; participant?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
    };
    messageTimestamp?: number;
  }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
