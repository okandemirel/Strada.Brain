import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { getLogger } from "../../utils/logger.js";
import { downloadMedia, validateMediaAttachment, validateMagicBytes } from "../../utils/media-processor.js";
import { RateLimiter } from "../../security/rate-limiter.js";
import type { RateLimitConfig } from "../../security/rate-limiter.js";
import type {
  IChannelAdapter,
  IncomingMessage,
  Attachment,
  ConfirmationRequest,
} from "../channel.interface.js";

// ---------- Constants ----------

/** Minimum interval between streaming message edits (ms). */
const STREAM_THROTTLE_MS = 1000;
/** Default session inactivity timeout (ms). */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
/** Interval for cleaning up expired sessions (ms). */
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/** Maximum reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 10;
/** Maximum reconnect delay (ms). */
const MAX_RECONNECT_DELAY_MS = 60_000;
/** Base reconnect delay (ms). */
const BASE_RECONNECT_DELAY_MS = 1000;

// ---------- Internal types ----------

interface StreamingMessageState {
  chatId: string;
  messageKey: WhatsAppMessageKey;
  accumulatedText: string;
  lastUpdate: number;
  updateQueued: boolean;
  throttleTimer?: ReturnType<typeof setTimeout>;
}

interface SessionState {
  userId: string;
  startedAt: number;
  lastActivity: number;
  messageCount: number;
}

/**
 * WhatsApp channel adapter using the Baileys library.
 *
 * Connects to WhatsApp Web via QR code or stored session.
 * Requires: @whiskeysockets/baileys (peer dependency).
 *
 * Features:
 * - Streaming message support (edit-in-place with throttling)
 * - Session tracking per chat with auto-expiry
 * - Per-user rate limiting via shared RateLimiter
 * - Media sending (image, document)
 * - Exponential backoff reconnection
 * - Typing indicator lifecycle (composing / paused)
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
    { resolve: (value: string) => void; options: string[]; timer: ReturnType<typeof setTimeout> }
  >();

  // 4.1 Streaming support
  private readonly streamingMessages = new Map<string, StreamingMessageState>();

  // 4.2 Session management
  private readonly sessions = new Map<string, SessionState>();
  private sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;

  // 4.3 Rate limiting
  private readonly rateLimiter: RateLimiter;

  // 4.5 Reconnection
  private reconnectAttempts = 0;

  constructor(
    sessionPath = ".whatsapp-session",
    allowedNumbers: string[] = [],
    rateLimitConfig?: Partial<RateLimitConfig>,
  ) {
    super();
    this.sessionPath = sessionPath;
    this.allowedNumbers = new Set(allowedNumbers);
    this.rateLimiter = new RateLimiter({
      messagesPerMinute: rateLimitConfig?.messagesPerMinute ?? 20,
      messagesPerHour: rateLimitConfig?.messagesPerHour ?? 200,
    });
  }

  async connect(): Promise<void> {
    // Clean up previous socket if reconnecting
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore cleanup errors during reconnect
      }
      this.sock = null;
    }

    const logger = getLogger();

    try {
      // Dynamic import to make baileys an optional dependency
      // @ts-expect-error -- baileys is an optional peer dependency
      const baileys = await import("@whiskeysockets/baileys");
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
      }) as WhatsAppSocket;

      this.sock.ev.on("creds.update", saveCreds);

      // --- connection.update with exponential backoff (4.5) ---
      this.sock.ev.on("connection.update", (update: ConnectionUpdate) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
          this.healthy = false;
          const statusCode = (lastDisconnect?.error as BoomError)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(
              BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
              MAX_RECONNECT_DELAY_MS,
            );
            this.reconnectAttempts++;
            logger.warn("WhatsApp connection lost, reconnecting...", {
              attempt: this.reconnectAttempts,
              maxAttempts: MAX_RECONNECT_ATTEMPTS,
              delayMs: delay,
              statusCode,
            });
            setTimeout(() => void this.connect(), delay);
          } else if (!shouldReconnect) {
            logger.error("WhatsApp logged out. Delete session and re-scan QR.");
          } else {
            logger.error("WhatsApp max reconnect attempts reached, giving up.", {
              attempts: this.reconnectAttempts,
            });
          }
        } else if (connection === "open") {
          logger.info("WhatsApp connected!");
          this.healthy = true;
          this.reconnectAttempts = 0; // Reset on successful connection
          this.startSessionCleanup();
        }
      });

      // --- messages.upsert with rate limiting, media, and session tracking ---
      this.sock.ev.on("messages.upsert", async (upsert: MessagesUpsert) => {
        for (const msg of upsert.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const chatId = msg.key.remoteJid ?? "";
          const senderId = msg.key.participant ?? chatId;

          // Extract text from various message types
          const text =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            msg.message.imageMessage?.caption ??
            msg.message.videoMessage?.caption ??
            "";

          // Auth check — deny all if no allowed numbers configured (like Discord's pattern)
          {
            const normalized = senderId.replace(/@.*$/, "");
            if (this.allowedNumbers.size === 0) {
              logger.warn("WhatsApp: no allowed numbers configured, denying all", { senderId });
              void this.sendText(chatId, "Unauthorized. Contact the admin.");
              continue;
            }
            if (!this.allowedNumbers.has(normalized)) {
              logger.warn("WhatsApp: unauthorized number", { senderId });
              void this.sendText(chatId, "Unauthorized. Contact the admin.");
              continue;
            }
          }

          // 4.4 Detect media attachments
          const attachments: Attachment[] = [];
          const mediaEntries: Array<{
            type: Attachment["type"];
            name: string;
            mime: string;
            url: string | undefined;
          }> = [];

          if (msg.message.imageMessage) {
            mediaEntries.push({
              type: "image",
              name: "image",
              mime: msg.message.imageMessage.mimetype ?? "image/jpeg",
              url: msg.message.imageMessage.url,
            });
          }
          if (msg.message.documentMessage) {
            mediaEntries.push({
              type: "document",
              name: msg.message.documentMessage.fileName ?? "document",
              mime: msg.message.documentMessage.mimetype ?? "application/octet-stream",
              url: msg.message.documentMessage.url,
            });
          }
          if (msg.message.videoMessage) {
            mediaEntries.push({
              type: "video",
              name: "video.mp4",
              mime: msg.message.videoMessage.mimetype ?? "video/mp4",
              url: msg.message.videoMessage.url,
            });
          }
          if (msg.message.audioMessage) {
            mediaEntries.push({
              type: "audio",
              name: "audio.ogg",
              mime: msg.message.audioMessage.mimetype ?? "audio/ogg",
              url: msg.message.audioMessage.url,
            });
          }

          for (const entry of mediaEntries) {
            let data: Buffer | undefined;
            if (entry.url) {
              try {
                const downloaded = await downloadMedia(entry.url);
                if (downloaded) {
                  // Use server-returned MIME for consistent validation (not WhatsApp-declared)
                  const effectiveMime = downloaded.mimeType || entry.mime;
                  const v = validateMediaAttachment({ mimeType: effectiveMime, size: downloaded.size, type: entry.type });
                  if (v.valid && validateMagicBytes(downloaded.data, effectiveMime)) {
                    data = downloaded.data;
                  }
                }
              } catch {
                // Non-critical -- proceed with URL only
              }
            }
            if (data || entry.url) {
              attachments.push({
                type: entry.type,
                name: entry.name,
                mimeType: entry.mime,
                url: entry.url ?? undefined,
                data,
                size: data?.length,
              });
            }
          }

          // Skip messages with no text and no attachments
          if (!text && attachments.length === 0) continue;

          // 4.3 Rate limit check
          const rateResult = this.rateLimiter.checkMessageRate(senderId);
          if (!rateResult.allowed) {
            logger.warn("WhatsApp: rate limited", { senderId, reason: rateResult.reason });
            void this.sendText(
              chatId,
              `Rate limited. ${rateResult.reason ?? "Please wait before sending more messages."}`,
            );
            continue;
          }

          // Check if this is a confirmation response
          const pending = this.pendingConfirmations.get(chatId);
          if (pending && text) {
            const idx = parseInt(text, 10) - 1;
            if (idx >= 0 && idx < pending.options.length) {
              clearTimeout(pending.timer);
              this.pendingConfirmations.delete(chatId);
              pending.resolve(pending.options[idx]!);
            } else {
              await this.sendText(
                chatId,
                `Invalid choice. Reply with a number between 1 and ${pending.options.length}.`,
              );
            }
            continue;
          }

          // 4.2 Track session
          this.touchSession(chatId, senderId);

          const incoming: IncomingMessage = {
            channelType: "whatsapp",
            chatId,
            userId: senderId,
            text,
            attachments: attachments.length > 0 ? attachments : undefined,
            timestamp: msg.messageTimestamp != null
              ? new Date((msg.messageTimestamp as number) * 1000)
              : new Date(),
          };

          if (this.messageHandler) {
            // 4.6 Send typing indicator when processing starts
            void this.sendTypingIndicator(chatId);
            void this.messageHandler(incoming).finally(() => {
              // 4.6 Stop composing indicator when done
              void this.stopTypingIndicator(chatId);
            });
          }
        }
      });
    } catch (error) {
      const logger = getLogger();
      if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
        logger.error(
          "WhatsApp channel requires @whiskeysockets/baileys. " +
            "Install it: npm install @whiskeysockets/baileys",
        );
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Stop session cleanup
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
      this.sessionCleanupInterval = null;
    }

    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.healthy = false;
    for (const { timer } of this.pendingConfirmations.values()) {
      clearTimeout(timer);
    }
    this.pendingConfirmations.clear();
    this.streamingMessages.clear();
    this.sessions.clear();
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
      .replace(/\*\*(.+?)\*\*/g, "*$1*") // **bold** -> *bold*
      .replace(/`([^`]+)`/g, "```$1```") // `code` -> ```code```
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*"); // # Header -> *Header*

    await this.sendText(chatId, formatted);
  }

  // ---- 4.6 Typing Indicators ----

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("composing", chatId);
    } catch {
      // Non-critical
    }
  }

  async stopTypingIndicator(chatId: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("paused", chatId);
    } catch {
      // Non-critical
    }
  }

  // ---- 4.1 Streaming Support ----

  /**
   * Start a streaming message by sending a "Thinking..." placeholder.
   * Returns a stream ID for subsequent updates.
   */
  async startStreamingMessage(chatId: string): Promise<string | undefined> {
    if (!this.sock) return undefined;
    try {
      const sent = await this.sock.sendMessage(chatId, { text: "Thinking..." });
      if (!sent?.key) return undefined;

      const streamId = randomUUID();
      this.streamingMessages.set(streamId, {
        chatId,
        messageKey: sent.key,
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

  /**
   * Update a streaming message with accumulated text.
   * Throttled to max 1 update per second to avoid WhatsApp rate limits.
   */
  async updateStreamingMessage(
    _chatId: string,
    streamId: string,
    accumulatedText: string,
  ): Promise<void> {
    const state = this.streamingMessages.get(streamId);
    if (!state) return;

    state.accumulatedText = accumulatedText;

    const now = Date.now();
    if (now - state.lastUpdate < STREAM_THROTTLE_MS) {
      if (!state.updateQueued) {
        state.updateQueued = true;
        state.throttleTimer = setTimeout(
          () => {
            state.throttleTimer = undefined;
            state.updateQueued = false;
            void this.performStreamUpdate(streamId);
          },
          STREAM_THROTTLE_MS - (now - state.lastUpdate),
        );
      }
      return;
    }

    await this.performStreamUpdate(streamId);
  }

  /**
   * Finalize a streaming message with the complete text.
   */
  async finalizeStreamingMessage(
    chatId: string,
    streamId: string,
    finalText: string,
  ): Promise<void> {
    const state = this.streamingMessages.get(streamId);
    if (!state) return;

    // Cancel pending throttled update immediately before sending final
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = undefined;
      state.updateQueued = false;
    }

    try {
      if (!this.sock) throw new Error("WhatsApp not connected");
      await this.sock.sendMessage(state.chatId, {
        text: finalText,
        edit: state.messageKey,
      });
    } catch {
      // Fallback: send as a new message
      try {
        await this.sendMarkdown(chatId, finalText);
      } catch {
        getLogger().error("Failed to finalize streaming message");
      }
    } finally {
      this.streamingMessages.delete(streamId);
    }
  }

  private async performStreamUpdate(streamId: string): Promise<void> {
    const state = this.streamingMessages.get(streamId);
    if (!state || !this.sock) return;

    try {
      const text = state.accumulatedText || "...";
      await this.sock.sendMessage(state.chatId, {
        text,
        edit: state.messageKey,
      });
      state.lastUpdate = Date.now();
    } catch {
      // Ignore update errors — non-critical
    }
  }

  // ---- 4.4 Media Support ----

  /**
   * Send an image message with an optional caption.
   */
  async sendImage(chatId: string, url: string, caption?: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    await this.sock.sendMessage(chatId, {
      image: { url },
      ...(caption ? { caption } : {}),
    });
  }

  /**
   * Send a document message with an optional filename.
   */
  async sendDocument(chatId: string, url: string, fileName?: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    await this.sock.sendMessage(chatId, {
      document: { url },
      ...(fileName ? { fileName } : {}),
    });
  }

  // ---- 4.2 Session Management ----

  /**
   * Get the number of currently active (non-expired) sessions.
   */
  getActiveSessionCount(): number {
    const now = Date.now();
    let count = 0;
    for (const [, session] of this.sessions) {
      if (now - session.lastActivity < SESSION_TIMEOUT_MS) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get session info for a specific chat, or undefined if no active session.
   */
  getSession(chatId: string): SessionState | undefined {
    const session = this.sessions.get(chatId);
    if (!session) return undefined;
    if (Date.now() - session.lastActivity >= SESSION_TIMEOUT_MS) {
      this.sessions.delete(chatId);
      return undefined;
    }
    return session;
  }

  private touchSession(chatId: string, userId: string): void {
    const now = Date.now();
    const existing = this.sessions.get(chatId);
    if (existing && now - existing.lastActivity < SESSION_TIMEOUT_MS) {
      existing.lastActivity = now;
      existing.messageCount++;
    } else {
      this.sessions.set(chatId, {
        userId,
        startedAt: now,
        lastActivity: now,
        messageCount: 1,
      });
    }
  }

  private startSessionCleanup(): void {
    // Avoid duplicate intervals
    if (this.sessionCleanupInterval) return;

    this.sessionCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [chatId, session] of this.sessions) {
        if (now - session.lastActivity >= SESSION_TIMEOUT_MS) {
          this.sessions.delete(chatId);
        }
      }
    }, SESSION_CLEANUP_INTERVAL_MS);
    this.sessionCleanupInterval.unref();
  }

  // ---- Existing methods ----

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const optionText = req.options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");

    const message = [
      req.question,
      req.details ? `\n${req.details}` : "",
      `\n${optionText}`,
      "\nReply with the number of your choice.",
    ].join("");

    await this.sendText(req.chatId, message);

    return new Promise<string>((resolve) => {
      const previous = this.pendingConfirmations.get(req.chatId);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve("timeout");
      }

      // Timeout after 2 minutes
      const timer = setTimeout(() => {
        if (this.pendingConfirmations.has(req.chatId)) {
          this.pendingConfirmations.delete(req.chatId);
          resolve("timeout");
        }
      }, 120_000);

      this.pendingConfirmations.set(req.chatId, {
        resolve,
        options: req.options,
        timer,
      });
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }
}

// Minimal type definitions for baileys to avoid full dependency
/* eslint-disable @typescript-eslint/no-explicit-any */
interface WhatsAppMessageKey {
  remoteJid?: string;
  fromMe?: boolean;
  id?: string;
  participant?: string;
}

interface WhatsAppSocket {
  ev: {
    on(event: string, handler: (...args: any[]) => void): void;
  };
  sendMessage(
    jid: string,
    content:
      | { text: string; edit?: WhatsAppMessageKey }
      | { image: { url: string }; caption?: string }
      | { document: { url: string }; fileName?: string },
  ): Promise<{ key: WhatsAppMessageKey } | undefined>;
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
    key: WhatsAppMessageKey;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: {
        url?: string;
        caption?: string;
        mimetype?: string;
      };
      documentMessage?: {
        url?: string;
        fileName?: string;
        mimetype?: string;
      };
      videoMessage?: {
        url?: string;
        caption?: string;
        mimetype?: string;
      };
      audioMessage?: {
        url?: string;
        mimetype?: string;
      };
    };
    messageTimestamp?: number;
  }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
