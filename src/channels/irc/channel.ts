/**
 * IRC Channel - Internet Relay Chat adapter
 *
 * Requires: irc (npm install irc)
 * Config: IRC_SERVER, IRC_NICK, IRC_CHANNELS (comma-separated), IRC_ALLOWED_USERS, IRC_ALLOW_OPEN_ACCESS
 */

import type { IChannelAdapter } from "../channel.interface.js";
import type {
  IChannelInteractive,
  IChannelRichMessaging,
  ConfirmationRequest,
} from "../channel-core.interface.js";
import { limitIncomingText, type IncomingMessage, type Attachment } from "../channel-messages.interface.js";
import { getLogger } from "../../utils/logger.js";
import { isAllowedBySingleIdPolicy } from "../../security/access-policy.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * A confirmation awaiting an inbound reply. `chatId`/`userId` are lowercased so
 * the next reply can be correlated case-insensitively (IRC nicks/targets are
 * case-insensitive per RFC 2812).
 */
interface PendingIrcConfirmation {
  chatId: string;
  userId: string;
  options: string[];
  finalize: (value: string) => void;
}

/** No-reply timeout for IRC confirmations; resolves "timeout" so callers don't hang. */
const IRC_CONFIRMATION_TIMEOUT_MS = 120_000;

/** Callback for feedback reactions (thumbs up/down) from channel adapters. */
type FeedbackReactionCallback = (
  type: "thumbs_up" | "thumbs_down",
  instinctIds: string[],
  userId?: string,
  source?: "reaction" | "button",
) => void;

/** Patterns recognised as feedback input (text-based, since IRC has no native reactions). */
const FEEDBACK_UP_PATTERNS = ["\uD83D\uDC4D", "!feedback up"];
const FEEDBACK_DOWN_PATTERNS = ["\uD83D\uDC4E", "!feedback down"];

export class IRCChannel implements IChannelAdapter, IChannelInteractive, IChannelRichMessaging {
  readonly name = "irc";

  private handler: MessageHandler | null = null;
  private client: IRCClientLike | null = null;
  private healthy = false;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
  /**
   * Confirmation awaiting its inbound reply. IRC has no native interactive
   * widgets, so requestConfirmation is a text flow: the question + numbered
   * options are sent, and the NEXT inbound message from the same nick/chatId
   * resolves it. Only one confirmation is tracked at a time.
   */
  private pendingConfirmation: PendingIrcConfirmation | null = null;
  /** Per-chatId applied instinct IDs for feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();
  /**
   * Allowlist lowercased once at construction. IRC nicks are case-insensitive
   * (RFC 2812; the underlying lib compares nicks via toUpperCase()), so the
   * exact-case Set lookup in isAllowedBySingleIdPolicy would otherwise reject a
   * legitimate nick — or let allowlist enforcement be bypassed — on mere case
   * difference. Normalize both the stored allowlist and the inbound nick.
   */
  private readonly normalizedAllowedUsers: readonly string[];

  constructor(
    private readonly server: string,
    private readonly nick: string,
    private readonly channels: string[],
    allowedUsers: readonly string[] = [],
    private readonly allowOpenAccess: boolean = false,
  ) {
    this.normalizedAllowedUsers = allowedUsers.map((u) => u.toLowerCase());
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register a callback for feedback reactions (thumbs up/down). */
  setFeedbackHandler(callback: FeedbackReactionCallback | null): void {
    this.feedbackReactionCallback = callback;
  }

  /** Set the applied instinct IDs for a channel so feedback can be attributed. */
  setAppliedInstinctIds(chatId: string, instinctIds: string[]): void {
    if (instinctIds.length > 0) {
      this.appliedInstinctIds.set(chatId, instinctIds);
    } else {
      this.appliedInstinctIds.delete(chatId);
    }
  }

  async connect(): Promise<void> {
    const logger = getLogger();
    const irc = await import("irc" as string);

    this.client = new irc.Client(this.server, this.nick, {
      channels: this.channels,
      autoRejoin: true,
      retryCount: 5,
      retryDelay: 5000,
    }) as unknown as IRCClientLike;

    this.client.addListener("message", ((...args: unknown[]) => {
      const [from, to, text] = args as [string, string, string];
      // Only respond to messages directed at the bot (mention or PM). IRC nicks
      // are case-insensitive (RFC 2812), so compare case-insensitively: the
      // server may echo the nick in a different case than configured, which
      // would otherwise drop legitimate PMs and channel mentions.
      const isDirectMessage = to.toLowerCase() === this.nick.toLowerCase();
      // IRC has no protocol-level mentions; addressing the bot is convention.
      // Recognise the common highlight forms 'nick:', 'nick,', and 'nick '
      // case-insensitively, and strip the matched prefix.
      const mentionMatch = isDirectMessage ? null : text.match(IRCChannel.buildMentionRegex(this.nick));
      const isMention = mentionMatch !== null;

      if (!isDirectMessage && !isMention) return;
      if (!this.isAllowedInboundUser(from)) return;

      const stripped = mentionMatch ? text.slice(mentionMatch[0].length).trim() : text;
      const cleanText = limitIncomingText(stripped.slice(0, 4096));
      const chatId = isDirectMessage ? from : to;

      // Pending confirmation: the NEXT reply from the same nick/chatId resolves
      // the open requestConfirmation() text flow. Correlated case-insensitively
      // (RFC 2812) and consumed here so it is not also routed as a message.
      if (this.tryResolvePendingConfirmation(from, chatId, cleanText)) return;

      // Feedback detection — intercept standalone emoji or !feedback commands
      const trimmedText = cleanText.trim();
      if (this.feedbackReactionCallback) {
        let feedbackType: "thumbs_up" | "thumbs_down" | null = null;
        if (FEEDBACK_UP_PATTERNS.includes(trimmedText)) {
          feedbackType = "thumbs_up";
        } else if (FEEDBACK_DOWN_PATTERNS.includes(trimmedText)) {
          feedbackType = "thumbs_down";
        }
        if (feedbackType) {
          const instinctIds = this.appliedInstinctIds.get(chatId);
          if (instinctIds && instinctIds.length > 0) {
            this.feedbackReactionCallback(feedbackType, instinctIds, from, "reaction");
            return; // consumed as feedback
          }
          // No instinctIds — fall through to normal message routing
        }
      }

      const msg: IncomingMessage = {
        channelType: "irc",
        chatId: chatId.slice(0, 200),
        userId: from.slice(0, 200),
        text: cleanText,
        timestamp: new Date(),
      };

      this.handler?.(msg).catch((err) => {
        getLogger().warn("Message handler failed", { error: err instanceof Error ? err.message : String(err) });
      });
    }) as (...args: unknown[]) => void);

    this.client.addListener("registered", () => {
      this.healthy = true;
      logger.info("IRC channel connected", { nick: this.nick, server: this.server });
    });

    this.client.addListener("error", ((...args: unknown[]) => {
      const err = args[0] as Error;
      this.healthy = false;
      logger.warn("IRC error", { error: err.message });
    }) as (...args: unknown[]) => void);

    // Connection-loss events: socket failures (netError) and exhausted reconnect
    // retries (abort) must flip healthy=false so isHealthy() stops reporting a
    // dead link as up. A successful reconnect re-emits "registered", which sets
    // healthy=true again, so health self-heals.
    this.client.addListener("netError", ((...args: unknown[]) => {
      const err = args[0] as Error | undefined;
      this.healthy = false;
      logger.warn("IRC netError", { error: err?.message ?? "socket error" });
    }) as (...args: unknown[]) => void);

    this.client.addListener("abort", (() => {
      this.healthy = false;
      logger.warn("IRC connection aborted (retries exhausted)");
    }) as (...args: unknown[]) => void);
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    // Resolve any open confirmation so its awaiting tool promise doesn't hang
    // past shutdown; "timeout" is treated as "do not proceed".
    this.pendingConfirmation?.finalize("timeout");
    const client = this.client;
    if (client) {
      // Remove the listeners added in connect() and drop the client reference so
      // a subsequent connect() can't double-register handlers on a stale client.
      client.disconnect("Shutting down", () => {});
      client.removeAllListeners?.();
      this.client = null;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const client = this.client;
    // client.say() in node-irc is fire-and-forget: send() silently skips the
    // socket write when the link is unavailable and never throws, so a "success"
    // here would otherwise mask total non-delivery. Gate on the connection being
    // live and surface a failure to the caller (which can retry) when it is not.
    if (!client || !this.healthy) {
      throw new Error("IRC link down: cannot send message (not connected)");
    }
    // IRC enforces a ~512-byte line limit (incl. the PRIVMSG framing + CRLF), so
    // SPLIT — never truncate — each logical line into byte-bounded chunks. The
    // previous `line.slice(0, 450)` silently dropped everything past 450 chars.
    for (const line of text.split("\n")) {
      // Blank/whitespace-only lines were previously dropped, collapsing
      // paragraph breaks. IRC servers reject a PRIVMSG with an empty trailing
      // parameter, so emit a single space to preserve the visual break instead.
      if (!line.trim()) {
        client.say(chatId, " ");
        continue;
      }
      for (const chunk of IRCChannel.splitIrcLine(line, IRCChannel.IRC_MAX_BYTES)) {
        client.say(chatId, chunk);
      }
    }
  }

  /** IRC's 512-byte line limit minus headroom for PRIVMSG framing + CRLF. */
  private static readonly IRC_MAX_BYTES = 400;

  /**
   * Build a case-insensitive regex matching the leading "nick" highlight prefix
   * in a channel message. Recognises the conventional separators ':' , ',' or a
   * bare space (e.g. 'nick: hi', 'nick, hi', 'NICK hi'). The nick is escaped so
   * regex metacharacters in a nick (IRC allows e.g. []\\`^{}|) are literal.
   */
  private static buildMentionRegex(nick: string): RegExp {
    const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\s*${escaped}\\s*[:,]?\\s+`, "i");
  }

  /**
   * Split one logical line into IRC-safe chunks, each within the UTF-8 byte
   * budget and never breaking a multi-byte code point (iterating by code point
   * guarantees this). Oversize lines are emitted as multiple say() calls rather
   * than truncated, so no content is lost.
   */
  private static splitIrcLine(line: string, maxBytes: number): string[] {
    const chunks: string[] = [];
    let buf = "";
    let bytes = 0;
    for (const ch of line) {
      const chBytes = Buffer.byteLength(ch, "utf8");
      if (bytes + chBytes > maxBytes && buf.length > 0) {
        chunks.push(buf);
        buf = "";
        bytes = 0;
      }
      buf += ch;
      bytes += chBytes;
    }
    if (buf.length > 0) chunks.push(buf);
    return chunks;
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    // IRC doesn't support markdown — strip formatting
    const plain = markdown
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/`{3}[\s\S]*?`{3}/g, "[code block]")
      .replace(/`(.*?)`/g, "$1");
    await this.sendText(chatId, plain);
  }

  /**
   * Ask the user to pick an option over IRC. Since IRC has no native interactive
   * widgets, this is a text flow: the question (and any details) plus a numbered
   * option list are sent, and the NEXT inbound reply from the same nick/chatId
   * (case-insensitive) resolves the promise. The reply may be the option's
   * 1-based number or its literal text (case-insensitive); an unrecognised or
   * absent reply resolves "timeout" so callers (write-gate/ask-user) treat it as
   * "do not proceed" rather than silently selecting the first option.
   */
  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    if (!this.client || !this.healthy) {
      // No live link to ask over: never auto-approve.
      return "timeout";
    }

    // Resolve any prior pending confirmation as a timeout so its awaiting promise
    // doesn't leak; only one confirmation is tracked at a time.
    this.pendingConfirmation?.finalize("timeout");

    const chatId = req.chatId;
    const replyTarget = req.userId ?? chatId;

    return new Promise<string>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const finalize = (value: string): void => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (this.pendingConfirmation?.finalize === finalize) {
          this.pendingConfirmation = null;
        }
        resolve(value);
      };

      this.pendingConfirmation = {
        chatId: chatId.toLowerCase(),
        userId: replyTarget.toLowerCase(),
        options: req.options,
        finalize,
      };

      timeoutId = setTimeout(() => finalize("timeout"), IRC_CONFIRMATION_TIMEOUT_MS);

      const optionLines = req.options.map((o, i) => `${i + 1}) ${o}`).join("\n");
      const body = [req.question, req.details, optionLines]
        .filter((part): part is string => Boolean(part && part.length > 0))
        .join("\n");
      // Send best-effort; if the link drops mid-send the timeout still fires.
      this.sendText(chatId, body).catch((err) => {
        getLogger().warn("IRC confirmation prompt failed to send", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  /**
   * If a confirmation is pending for this nick/chatId, resolve it from `reply`
   * and return true (the message is consumed). Returns false when there is no
   * matching pending confirmation, so normal routing proceeds.
   */
  private tryResolvePendingConfirmation(from: string, chatId: string, reply: string): boolean {
    const pending = this.pendingConfirmation;
    if (!pending) return false;
    if (pending.userId !== from.toLowerCase() || pending.chatId !== chatId.toLowerCase()) {
      return false;
    }
    pending.finalize(IRCChannel.matchOption(reply, pending.options));
    return true;
  }

  /**
   * Map a free-text reply to one of `options`. Accepts a 1-based number or the
   * literal option text (case-insensitive, trimmed). Unrecognised input yields
   * "timeout" so the caller does not proceed on an ambiguous answer.
   */
  private static matchOption(reply: string, options: string[]): string {
    const trimmed = reply.trim();
    if (/^\d+$/.test(trimmed)) {
      const idx = Number.parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < options.length) return options[idx]!;
      return "timeout";
    }
    const match = options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
    return match ?? "timeout";
  }

  /**
   * No-op typing indicator. IRC has no protocol-level "typing" notification, so
   * there is nothing honest to send; the method exists only so the capability
   * (IChannelRichMessaging) is reported truthfully via supportsRichMessaging().
   */
  async sendTypingIndicator(_chatId: string): Promise<void> {
    // Intentionally empty: IRC has no typing notification.
  }

  /**
   * IRC cannot transfer binary attachments over the chat protocol; surface a
   * text placeholder so the user is at least notified rather than silently
   * dropping the attachment.
   */
  async sendAttachment(chatId: string, attachment: Attachment): Promise<void> {
    await this.sendText(chatId, `[Attachment: ${attachment.name}]`);
  }

  private isAllowedInboundUser(userId: string): boolean {
    return isAllowedBySingleIdPolicy(
      userId.toLowerCase(),
      this.normalizedAllowedUsers,
      this.allowOpenAccess ? "open" : "closed",
    );
  }
}

// Minimal type stubs
interface IRCClientLike {
  addListener(event: string, handler: (...args: unknown[]) => void): void;
  removeAllListeners?(): void;
  say(target: string, message: string): void;
  disconnect(message: string, callback: () => void): void;
}
