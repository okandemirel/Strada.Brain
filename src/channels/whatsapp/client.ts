import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { getLogger } from "../../utils/logger.js";
import { downloadMedia, validateMediaAttachment, validateMagicBytes } from "../../utils/media-processor.js";
import { isAllowedBySingleIdPolicy } from "../../security/access-policy.js";
import { RateLimiter } from "../../security/rate-limiter.js";
import type { RateLimitConfig } from "../../security/rate-limiter.js";
import type {
  IChannelAdapter,
  IncomingMessage,
  Attachment,
  ConfirmationRequest,
} from "../channel.interface.js";
import { limitIncomingText } from "../channel-messages.interface.js";
import { chunkText } from "../chunk-text.js";
import { StreamingBuffer } from "../streaming-buffer.js";

// ---------- Constants ----------

/**
 * Conservative outbound message-length cap. WhatsApp's protocol body limit is
 * ~65,536 chars, but clients render long messages poorly, so we split well
 * under that. Long answers are chunked (never truncated/dropped) via chunkText.
 */
const WHATSAPP_MAX_CHARS = 4096;
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

/** Callback for feedback reactions (thumbs up/down) from channel adapters. */
type FeedbackReactionCallback = (
  type: "thumbs_up" | "thumbs_down",
  instinctIds: string[],
  userId?: string,
  source?: "reaction" | "button",
) => void;

// ---------- Internal types ----------

interface StreamingMessageState {
  chatId: string;
  messageKey: WhatsAppMessageKey;
  /** Shared throttled-streaming core. */
  buffer: StreamingBuffer;
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
    {
      resolve: (value: string) => void;
      options: string[];
      timer: ReturnType<typeof setTimeout>;
      userId?: string;
    }
  >();

  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
  /** Per-chatId applied instinct IDs for emoji-based feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();

  /**
   * Bounded FIFO set of recently-seen inbound message IDs, used to drop
   * duplicates (e.g. history-sync replays delivered again on reconnect, or the
   * same id redelivered within a batch). Insertion order is the eviction order.
   */
  private readonly seenMessageIds = new Set<string>();
  /** Maximum number of message IDs to remember for dedup. */
  private static readonly MAX_SEEN_MESSAGE_IDS = 1000;

  // 4.1 Streaming support
  private readonly streamingMessages = new Map<string, StreamingMessageState>();

  // 4.2 Session management
  private readonly sessions = new Map<string, SessionState>();
  private sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;

  // 4.3 Rate limiting
  private readonly rateLimiter: RateLimiter;

  // Baileys JID helpers captured from the dynamic import at connect time.
  // They are optional (older builds may not export them, and unit tests mock
  // baileys without them), so every use must be guarded — the allowlist check
  // degrades gracefully to a plain string strip when they are unavailable.
  private jidNormalizedUser?: (jid: string) => string;
  private jidDecode?: (jid: string) => { user?: string; server?: string } | undefined;

  // 4.5 Reconnection
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set true by disconnect() so a reconnect timer scheduled before shutdown
   * cannot resurrect a deliberately stopped channel. Reset by connect().
   */
  private stopped = false;

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
    // An intentional connect clears the stop flag set by a prior disconnect.
    this.stopped = false;
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

      // Capture Baileys' JID utilities (best-effort) so the allowlist check can
      // normalize device-suffixed and '<lid>@lid' senders to a comparable
      // identity. Guarded everywhere they are used so a build/mock without them
      // still works.
      this.jidNormalizedUser = baileys.jidNormalizedUser;
      this.jidDecode = baileys.jidDecode;

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
            this.scheduleReconnect(delay);
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
        // Only process new live messages. 'append' carries older/offline/
        // history-synced messages that are (re)delivered on (re)connect, which
        // must not be re-routed. An undefined type is treated as live.
        if (upsert.type === "append") return;

        for (const msg of upsert.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          // Dedup by message id so a redelivered/duplicate message is processed
          // at most once (bounded FIFO eviction keeps memory constant).
          const messageId = msg.key.id;
          if (messageId) {
            if (this.seenMessageIds.has(messageId)) continue;
            this.seenMessageIds.add(messageId);
            if (this.seenMessageIds.size > WhatsAppChannel.MAX_SEEN_MESSAGE_IDS) {
              const oldest = this.seenMessageIds.values().next().value;
              if (oldest !== undefined) this.seenMessageIds.delete(oldest);
            }
          }

          const chatId = msg.key.remoteJid ?? "";
          const senderId = msg.key.participant ?? chatId;

          // Extract text from various message types
          const text =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            msg.message.imageMessage?.caption ??
            msg.message.videoMessage?.caption ??
            "";

          // Auth check — empty allowlist means no restriction, matching Slack-style open access
          {
            // A sender JID can arrive in several shapes: a plain number, a
            // device-suffixed phone JID ('5511999990000:12@s.whatsapp.net'), or
            // the newer LID addressing ('<lid>@lid'). Build the set of identities
            // a single allowlist entry could legitimately match against, then
            // accept if ANY of them is allowed. This lets operators store either
            // bare numbers or raw LIDs in the allowlist.
            const candidates = this.allowlistCandidates(senderId);
            const allowed = candidates.some((candidate) =>
              isAllowedBySingleIdPolicy(candidate, this.allowedNumbers, "open"),
            );
            if (!allowed) {
              logger.warn("WhatsApp: unauthorized number", { senderId });
              this.safeSend(chatId, "Unauthorized. Contact the admin.");
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
            this.safeSend(
              chatId,
              `Rate limited. ${rateResult.reason ?? "Please wait before sending more messages."}`,
            );
            continue;
          }

          // Check if this is a confirmation response
          const pending = this.pendingConfirmations.get(chatId);
          if (pending && text) {
            if (pending.userId && senderId !== pending.userId) {
              await this.sendText(
                chatId,
                "Only the original requester can respond to this confirmation.",
              );
              continue;
            }

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

          // Detect standalone emoji feedback (thumbs up/down)
          if (this.feedbackReactionCallback && attachments.length === 0) {
            const trimmed = text.trim();
            let feedbackType: "thumbs_up" | "thumbs_down" | null = null;
            if (trimmed === "\uD83D\uDC4D" || trimmed === "\uD83D\uDC4D\uD83C\uDFFB" || trimmed === "\uD83D\uDC4D\uD83C\uDFFC" || trimmed === "\uD83D\uDC4D\uD83C\uDFFD" || trimmed === "\uD83D\uDC4D\uD83C\uDFFE" || trimmed === "\uD83D\uDC4D\uD83C\uDFFF") {
              feedbackType = "thumbs_up";
            } else if (trimmed === "\uD83D\uDC4E" || trimmed === "\uD83D\uDC4E\uD83C\uDFFB" || trimmed === "\uD83D\uDC4E\uD83C\uDFFC" || trimmed === "\uD83D\uDC4E\uD83C\uDFFD" || trimmed === "\uD83D\uDC4E\uD83C\uDFFE" || trimmed === "\uD83D\uDC4E\uD83C\uDFFF") {
              feedbackType = "thumbs_down";
            }

            if (feedbackType) {
              const instinctIds = this.appliedInstinctIds.get(chatId);
              if (instinctIds && instinctIds.length > 0) {
                this.feedbackReactionCallback(feedbackType, instinctIds, senderId, "reaction");
                this.safeSend(chatId, feedbackType === "thumbs_up" ? "Thanks for the positive feedback!" : "Thanks for the feedback. I'll try to improve.");
                continue;
              }
            }
          }

          // 4.2 Track session
          this.touchSession(chatId, senderId);

          const incoming: IncomingMessage = {
            channelType: "whatsapp",
            chatId,
            userId: senderId,
            text: limitIncomingText(text),
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

  /**
   * Schedule a reconnect. The timer handle is stored so disconnect() can cancel
   * it, and the callback re-checks `stopped` so a timer that already fired after
   * disconnect cannot resurrect a stopped channel.
   */
  private scheduleReconnect(delay: number): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      // If connect() itself throws before a socket/'close' handler exists (e.g.
      // useMultiFileAuthState() fails transiently), the 'close' handler never
      // runs, so attempt-increment and re-scheduling must happen here too.
      // Otherwise the rejection would float as an unhandled promise rejection
      // and reconnection would silently stop.
      this.connect().catch((error) => {
        if (this.stopped) return;
        if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const nextDelay = Math.min(
            BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            MAX_RECONNECT_DELAY_MS,
          );
          this.reconnectAttempts++;
          getLogger().warn("WhatsApp reconnect attempt failed, retrying...", {
            attempt: this.reconnectAttempts,
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
            delayMs: nextDelay,
            error,
          });
          this.scheduleReconnect(nextDelay);
        } else {
          getLogger().error("WhatsApp max reconnect attempts reached, giving up.", {
            attempts: this.reconnectAttempts,
          });
        }
      });
    }, delay);
  }

  async disconnect(): Promise<void> {
    // Prevent any pending reconnect timer from resurrecting the channel.
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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
    for (const { resolve, timer } of this.pendingConfirmations.values()) {
      clearTimeout(timer);
      resolve("cancelled");
    }
    this.pendingConfirmations.clear();
    // Cancel any pending streaming throttle timers before dropping the states,
    // otherwise they fire after teardown (and keep the event loop alive).
    for (const state of this.streamingMessages.values()) {
      state.buffer.clearOnDisconnect();
    }
    this.streamingMessages.clear();
    this.seenMessageIds.clear();
    this.sessions.clear();
  }

  /**
   * Produce the set of comparable identities a sender JID could match in the
   * allowlist. Best-effort and order-stable:
   *   1. The bare local part — strips the device suffix (':12') and domain
   *      ('@...') so '5511999990000:12@s.whatsapp.net' -> '5511999990000'.
   *      For a LID this yields the numeric lid (e.g. '12345' from '12345@lid').
   *   2. Baileys' jidNormalizedUser(jid) — collapses a device-suffixed JID to a
   *      canonical user JID; helps when operators store full JIDs.
   *   3. Baileys' jidDecode(jid).user — the decoded user part for either the
   *      's.whatsapp.net' or 'lid' server, so a raw LID stored in the allowlist
   *      still matches.
   *   4. The raw senderId — so an allowlist entry kept verbatim (e.g. the exact
   *      '<lid>@lid' string) matches too.
   * Duplicates are removed while preserving order; Baileys helpers are guarded
   * since they may be absent (older builds / test mocks).
   */
  private allowlistCandidates(senderId: string): string[] {
    const candidates: string[] = [];
    const add = (value: string | undefined | null): void => {
      if (value && !candidates.includes(value)) candidates.push(value);
    };

    // Plain strip — device suffix (':') and domain ('@') removed.
    add(senderId.replace(/[:@].*$/, ""));

    // Baileys normalization (best-effort; guard against missing util / throws).
    try {
      add(this.jidNormalizedUser?.(senderId));
    } catch {
      // Ignore — fall back to the other candidates.
    }
    try {
      add(this.jidDecode?.(senderId)?.user);
    } catch {
      // Ignore — fall back to the other candidates.
    }

    // Raw JID last, so a verbatim allowlist entry (e.g. '<lid>@lid') matches.
    add(senderId);

    return candidates;
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /** Register a callback for feedback reactions (thumbs up/down). */
  setFeedbackHandler(callback: FeedbackReactionCallback | null): void {
    this.feedbackReactionCallback = callback;
  }

  /** Set the applied instinct IDs for a chat so emoji feedback can be attributed. */
  setAppliedInstinctIds(chatId: string, instinctIds: string[]): void {
    if (instinctIds.length > 0) {
      this.appliedInstinctIds.set(chatId, instinctIds);
    } else {
      this.appliedInstinctIds.delete(chatId);
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    // Long answers must be split into multiple messages rather than sent as a
    // single oversize body (which the server/client rejects). chunkText prefers
    // newline/space boundaries and never drops content; empty chunks are skipped.
    for (const chunk of chunkText(text, WHATSAPP_MAX_CHARS)) {
      if (!chunk) continue;
      await this.sock.sendMessage(chatId, { text: chunk });
    }
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    // WhatsApp supports basic formatting: *bold*, _italic_, ~strikethrough~,
    // and ```fenced``` code blocks. Inline single-backtick `code` is left as-is:
    // mapping it to ```...``` (a forced multiline block) breaks inline code and
    // produces malformed nesting when the input already contains fenced blocks.
    const formatted = markdown
      .replace(/\*\*(.+?)\*\*/g, "*$1*") // **bold** -> *bold*
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*"); // # Header -> *Header*

    await this.sendText(chatId, formatted);
  }

  /**
   * Best-effort send used by fire-and-forget notices (unauthorized, rate-limit,
   * feedback ack). Swallows failures (e.g. socket null during a reconnect
   * window) so they never surface as unhandled promise rejections.
   */
  private safeSend(chatId: string, text: string): void {
    this.sendText(chatId, text).catch((error) => {
      getLogger().debug("WhatsApp: safeSend failed", { chatId, error });
    });
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
      const messageKey = sent.key;

      const buffer = new StreamingBuffer({
        throttleMs: STREAM_THROTTLE_MS,
        onFlush: async (text) => {
          const state = this.streamingMessages.get(streamId);
          if (!state || !this.sock) return;
          try {
            await this.sock.sendMessage(state.chatId, {
              text: text || "...",
              edit: state.messageKey,
            });
          } catch {
            // Ignore update errors — non-critical
          }
        },
        onFinalize: async (text) => {
          const state = this.streamingMessages.get(streamId);
          if (!state) return;
          try {
            if (!this.sock) throw new Error("WhatsApp not connected");
            await this.sock.sendMessage(state.chatId, {
              text,
              edit: state.messageKey,
            });
          } catch {
            // Fallback: send as a new message
            try {
              await this.sendMarkdown(chatId, text);
            } catch {
              getLogger().error("Failed to finalize streaming message");
            }
          } finally {
            this.streamingMessages.delete(streamId);
          }
        },
      });

      this.streamingMessages.set(streamId, { chatId, messageKey, buffer });
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
    await state.buffer.update(accumulatedText);
  }

  /**
   * Finalize a streaming message with the complete text.
   */
  async finalizeStreamingMessage(
    _chatId: string,
    streamId: string,
    finalText: string,
  ): Promise<void> {
    const state = this.streamingMessages.get(streamId);
    if (!state) return;
    await state.buffer.finalize(finalText);
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
        userId: req.userId,
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
  /**
   * 'notify' for new live messages, 'append' for older/offline/history-synced
   * messages (re)delivered on (re)connect. Older baileys builds may omit it.
   */
  type?: "notify" | "append";
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
