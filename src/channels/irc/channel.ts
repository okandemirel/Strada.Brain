/**
 * IRC Channel - Internet Relay Chat adapter
 *
 * Requires: irc (npm install irc)
 * Config: IRC_SERVER, IRC_NICK, IRC_CHANNELS (comma-separated), IRC_ALLOWED_USERS, IRC_ALLOW_OPEN_ACCESS
 */

import type { IChannelAdapter } from "../channel.interface.js";
import { limitIncomingText, type IncomingMessage } from "../channel-messages.interface.js";
import { getLogger } from "../../utils/logger.js";
import { isAllowedBySingleIdPolicy } from "../../security/access-policy.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

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

export class IRCChannel implements IChannelAdapter {
  readonly name = "irc";

  private handler: MessageHandler | null = null;
  private client: IRCClientLike | null = null;
  private healthy = false;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
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
      if (!line.trim()) continue;
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
