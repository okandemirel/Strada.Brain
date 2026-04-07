/**
 * Web Channel - Browser-based chat interface
 *
 * HTTP server for static files + WebSocket for real-time communication.
 * Binds to 127.0.0.1 only (local access).
 */

import {
  createServer,
  type Server,
  type IncomingMessage as HttpReq,
  type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { isAllowedOrigin } from "../../security/origin-validation.js";
import { loadConfigSafe } from "../../config/config.js";
import { validateMediaAttachment, validateMagicBytes, normalizeMimeType } from "../../utils/media-processor.js";
import { SETUP_QUERY_PARAM, type PostSetupBootstrapContext } from "../../common/setup-contract.js";
import { WebIdentityStore, type WebIdentity } from "./web-identity-store.js";
import { getLoggerSafe } from "../../utils/logger.js";
import type {
  IChannelAdapter,
  IChannelStreaming,
  IChannelRichMessaging,
  IChannelInteractive,
  ConfirmationRequest,
  Attachment,
} from "../channel.interface.js";
import { limitIncomingText, type IncomingMessage } from "../channel-messages.interface.js";
import { classifyErrorMessage } from "../../utils/error-messages.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/** Callback for feedback reactions (thumbs up/down) from channel adapters. */
export type FeedbackReactionCallback = (
  type: "thumbs_up" | "thumbs_down",
  instinctIds: string[],
  userId?: string,
  source?: "reaction" | "button",
) => void;

interface WsClient {
  ws: WebSocket;
  chatId: string;
  reconnectToken: string;
  profileId: string;
  /** Message count in current rate-limit window. */
  msgCount: number;
  /** Timestamp (ms) when current rate-limit window started. */
  windowStart: number;
}

interface RecentlyDisconnectedSession {
  disconnectedAt: number;
  reconnectToken: string;
  /** Carry rate-limit state across reconnects to prevent bypass. */
  msgCount?: number;
  windowStart?: number;
}

interface SessionReclaimResult {
  chatId: string;
  reconnectToken: string;
}

interface PendingConfirmation {
  resolve: (value: string) => void;
  timer: ReturnType<typeof setTimeout>;
  /** chatId of the session that owns this confirmation. */
  chatId?: string;
}

interface WebChannelOptions {
  dashboardAuthToken?: string;
  identityDbPath?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGED_STATIC_DIR = fileURLToPath(new URL("static/", import.meta.url));
const SOURCE_BUILD_STATIC_DIR = resolve(MODULE_DIR, "../../../web-portal/dist");
const SETUP_CACHE_BUST_PARAM = "t";
const WEB_PLACEHOLDER_TEXTS = new Set([
  // Voice message placeholders (all supported languages)
  "(voice message)",
  "(sesli mesaj)",
  "(mensaje de voz)",
  "(sprachnachricht)",
  "(음성 메시지)",
  "(message vocal)",
  "（语音消息）",
  "(音声メッセージ)",
  // File attachment placeholders (all supported languages)
  "(file attachment)",
  "(dosya eki)",
  "(archivo adjunto)",
  "(dateianhang)",
  "(파일 첨부)",
  "(piece jointe)",
  "（文件附件）",
  "(ファイル添付)",
]);

function isFrontendPlaceholderText(text: string): boolean {
  return WEB_PLACEHOLDER_TEXTS.has(text.trim().toLowerCase());
}

function resolveStaticDir(): string {
  if (existsSync(SOURCE_BUILD_STATIC_DIR)) {
    return SOURCE_BUILD_STATIC_DIR;
  }
  return PACKAGED_STATIC_DIR;
}

export function getCanonicalWebRedirectTarget(url: string): string | null {
  const parsed = new URL(url, "http://127.0.0.1");
  const hadSetupQuery = parsed.searchParams.get(SETUP_QUERY_PARAM) === "1";

  if (!hadSetupQuery) {
    return null;
  }

  parsed.searchParams.delete(SETUP_QUERY_PARAM);
  parsed.searchParams.delete(SETUP_CACHE_BUST_PARAM);

  const nextSearch = parsed.searchParams.toString();
  return `${parsed.pathname}${nextSearch ? `?${nextSearch}` : ""}${parsed.hash}`;
}

/** Rate limit: max messages per window. */
const WS_RATE_LIMIT = 20;
/** Rate limit window duration in ms (10 seconds). */
const WS_RATE_WINDOW_MS = 10_000;

export class WebChannel
  implements IChannelAdapter, IChannelStreaming, IChannelRichMessaging, IChannelInteractive
{
  readonly name = "web";

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private handler: MessageHandler | null = null;
  private healthy = false;
  private clients = new Map<string, WsClient>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  /** Recently disconnected chatIds eligible for reconnect (5 min TTL) */
  private recentlyDisconnected = new Map<string, RecentlyDisconnectedSession>();
  private postSetupBootstrapHandler: ((context: PostSetupBootstrapContext) => Promise<void> | void) | null = null;
  private postSetupBootstrapConsumed = false;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
  /** Per-chatId applied instinct IDs so responses can carry them for feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();
  /** Tracks the length of text already sent for each active stream to enable delta protocol. */
  private readonly streamSentLengths = new Map<string, number>();
  private readonly staticDir = resolveStaticDir();
  private readonly identityStore: WebIdentityStore;
  /** Optional emitter for workspace bus events from frontend monitor commands. */
  private workspaceBusEmitter: ((event: string, payload: unknown) => void) | null = null;

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private static readonly RECONNECT_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly port: number = 3000,
    private readonly dashboardPort: number = 3100,
    private readonly options: WebChannelOptions = {},
  ) {
    this.identityStore = new WebIdentityStore(options.identityDbPath ?? ":memory:");
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register a callback for feedback reactions (thumbs up/down). */
  setFeedbackHandler(callback: FeedbackReactionCallback | null): void {
    this.feedbackReactionCallback = callback;
  }

  /** Register an emitter for workspace bus events from frontend monitor commands. */
  setWorkspaceBusEmitter(emitter: ((event: string, payload: unknown) => void) | null): void {
    this.workspaceBusEmitter = emitter;
  }

  /** Set the applied instinct IDs for a chat so outgoing messages include them for feedback. */
  setAppliedInstinctIds(chatId: string, instinctIds: string[]): void {
    if (instinctIds.length > 0) {
      this.appliedInstinctIds.set(chatId, instinctIds);
    } else {
      this.appliedInstinctIds.delete(chatId);
    }
  }

  setPostSetupBootstrapHandler(handler: ((context: PostSetupBootstrapContext) => Promise<void> | void) | null): void {
    this.postSetupBootstrapHandler = handler;
    this.postSetupBootstrapConsumed = false;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleHttp(req, res));

    // maxPayload: 25 MiB accommodates the 20 MB media validation limit with
    // room for base64 overhead (~33% inflation).
    // verifyClient: reject WebSocket connections whose Origin header does not
    // match localhost, blocking cross-origin WebSocket hijacking from a
    // malicious page open in the same browser.
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: 25 * 1024 * 1024,
      verifyClient: ({ req }: { req: HttpReq }) => isAllowedOrigin(req.headers.origin),
    });
    this.wss.on("connection", (ws) => this.handleWsConnection(ws));

    await new Promise<void>((res, rej) => {
      const onError = (error: Error) => {
        this.server?.off("error", onError);
        rej(error);
      };
      try {
        this.server!.once("error", onError);
        this.server!.listen(this.port, "127.0.0.1", () => {
          this.server?.off("error", onError);
          res();
        });
      } catch (error) {
        this.server?.off("error", onError);
        rej(error as Error);
      }
    });

    this.healthy = true;

    // Periodically prune expired entries from the reconnect map
    this._reconnectCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.recentlyDisconnected) {
        if (now - session.disconnectedAt > WebChannel.RECONNECT_TTL_MS) {
          this.recentlyDisconnected.delete(id);
        }
      }
    }, WebChannel.RECONNECT_TTL_MS);

    console.log(`Web channel running at http://127.0.0.1:${this.port}`);
  }

  private _reconnectCleanupInterval: ReturnType<typeof setInterval> | undefined;

  async disconnect(): Promise<void> {
    this.healthy = false;

    if (this._reconnectCleanupInterval) {
      clearInterval(this._reconnectCleanupInterval);
    }
    this.recentlyDisconnected.clear();

    for (const [, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timer);
      pending.resolve("timeout");
    }
    this.pendingConfirmations.clear();

    for (const [, client] of this.clients) {
      client.ws.close(1000, "Server shutting down");
    }
    this.clients.clear();
    this.identityStore.close();

    this.wss?.close();
    await new Promise<void>((res) => {
      if (this.server) {
        this.server.close(() => res());
      } else {
        res();
      }
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Broadcast a pre-serialised message string to every connected WS client.
   * Used by the monitor bridge to fan-out workspace events.
   */
  broadcastRaw(message: string): void {
    for (const [, client] of this.clients) {
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(message);
        } catch {
          // Connection may have closed between readyState check and send
        }
      }
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const instinctIds = this.appliedInstinctIds.get(chatId);
    this.sendToClient(chatId, {
      type: "text",
      text,
      messageId: randomUUID(),
      ...(instinctIds && instinctIds.length > 0 ? { instinctIds } : {}),
    });
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    const instinctIds = this.appliedInstinctIds.get(chatId);
    this.sendToClient(chatId, {
      type: "markdown",
      text: markdown,
      messageId: randomUUID(),
      ...(instinctIds && instinctIds.length > 0 ? { instinctIds } : {}),
    });
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    this.sendToClient(chatId, { type: "typing", active: true });
  }

  sendTypingStop(chatId: string): void {
    this.sendToClient(chatId, { type: "typing", active: false, messageId: "" });
  }

  async sendAttachment(chatId: string, attachment: Attachment): Promise<void> {
    this.sendToClient(chatId, {
      type: "text",
      text: `[Attachment: ${attachment.name}]`,
      messageId: randomUUID(),
    });
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const confirmId = randomUUID();

    this.sendToClient(req.chatId, {
      type: "confirmation",
      confirmId,
      question: req.question,
      options: req.options,
      details: req.details,
    });

    return new Promise<string>((done) => {
      const timer = setTimeout(
        () => {
          this.pendingConfirmations.delete(confirmId);
          done("timeout");
        },
        5 * 60 * 1000,
      );

      this.pendingConfirmations.set(confirmId, { resolve: done, timer, chatId: req.chatId });
    });
  }

  async startStreamingMessage(chatId: string): Promise<string | undefined> {
    const streamId = randomUUID();
    this.streamSentLengths.set(streamId, 0);
    this.sendToClient(chatId, { type: "stream_start", streamId, text: "" });
    return streamId;
  }

  async updateStreamingMessage(
    chatId: string,
    streamId: string,
    accumulatedText: string,
  ): Promise<void> {
    const lastLen = this.streamSentLengths.get(streamId) ?? 0;
    const delta = accumulatedText.slice(lastLen);
    if (delta.length === 0) return; // Nothing new to send
    this.streamSentLengths.set(streamId, accumulatedText.length);
    this.sendToClient(chatId, { type: "stream_update", streamId, delta });
  }

  async finalizeStreamingMessage(
    chatId: string,
    streamId: string,
    finalText: string,
  ): Promise<void> {
    this.streamSentLengths.delete(streamId);
    const instinctIds = this.appliedInstinctIds.get(chatId);
    this.sendToClient(chatId, {
      type: "stream_end",
      streamId,
      text: finalText,
      ...(instinctIds && instinctIds.length > 0 ? { instinctIds } : {}),
    });
  }

  // ===========================================================================
  // HTTP Handler
  // ===========================================================================

  /** Security headers sent with every HTTP response. */
  private static readonly SECURITY_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; " +
      "script-src 'self' https://cdn.jsdelivr.net blob:; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*; " +
      "img-src 'self' data: blob:; " +
      "font-src 'self' data: https://cdn.jsdelivr.net; " +
      "worker-src blob:; " +
      "object-src 'none'; " +
      "base-uri 'none'; " +
      "frame-ancestors 'none';",
  };
  private static readonly NO_CACHE_HEADERS: Record<string, string> = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  };

  private async handleHttp(req: HttpReq, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const canonicalRedirectTarget = getCanonicalWebRedirectTarget(url);

    if (req.method === "GET" && canonicalRedirectTarget) {
      res.writeHead(302, {
        ...WebChannel.SECURITY_HEADERS,
        Location: canonicalRedirectTarget,
        ...WebChannel.NO_CACHE_HEADERS,
      });
      res.end();
      return;
    }

    // Health endpoint for Docker/K8s liveness probes
    if (url === "/health") {
      const body = JSON.stringify({
        status: this.healthy ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        channel: "web",
        uptime: process.uptime(),
        clients: this.clients.size,
      });
      res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Proxy /api/* requests to the dashboard server (same-origin solution)
    if (url.startsWith("/api/")) {
      await this.proxyToDashboard(req, res, url);
      return;
    }

    // Only allow GET for static files
    if (req.method !== "GET") {
      res.writeHead(405, WebChannel.SECURITY_HEADERS);
      res.end("Method Not Allowed");
      return;
    }

    const rawSegment = url.split("?")[0]!;

    // Try to serve the exact static file first
    if (rawSegment !== "/") {
      const candidate = resolve(join(this.staticDir, rawSegment));
      const safeRoot = resolve(this.staticDir);
      if (!candidate.startsWith(safeRoot + sep) && candidate !== safeRoot) {
        res.writeHead(403, WebChannel.SECURITY_HEADERS);
        res.end("Forbidden");
        return;
      }
      try {
        const data = await readFile(candidate);
        const ext = extname(candidate);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": contentType });
        res.end(data);
        return;
      } catch {
        // File not found — fall through to SPA fallback
      }
    }

    // SPA fallback: serve index.html for all non-file routes (client-side routing)
    try {
      const data = await readFile(join(this.staticDir, "index.html"));
      res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    } catch {
      res.writeHead(404, WebChannel.SECURITY_HEADERS);
      res.end("Not Found");
    }
  }

  // ===========================================================================
  // WebSocket Handler
  // ===========================================================================

  private handleWsConnection(ws: WebSocket): void {
    let chatId: string = randomUUID();
    let assignedId = false;
    const client: WsClient = {
      ws,
      chatId,
      reconnectToken: this.generateReconnectToken(),
      profileId: chatId,
      msgCount: 0,
      windowStart: Date.now(),
    };
    this.clients.set(chatId, client);

    // Note: A temporary 'connected' event is sent immediately, then replaced
    // by the full 'connected' event after session_init with profileId/language.
    this.sendJson(ws, { type: "connected", chatId, reconnectToken: client.reconnectToken });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;

        if (!assignedId && (data.type === "session_init" || data.type === "reconnect")) {
          const initialized = this.initializeSession(ws, client, data);
          chatId = initialized.chatId;
          assignedId = true;
          return;
        }
        assignedId = true;

        this.handleWsMessage(chatId, data);
      } catch {
        // Ignore malformed messages
      }
    });

    const handleDisconnect = () => {
      const current = this.clients.get(chatId);
      if (current && current.ws === ws) {
        this.clients.delete(chatId);
        // Allow reconnect within TTL window; carry rate-limit state
        this.recentlyDisconnected.set(chatId, {
          disconnectedAt: Date.now(),
          reconnectToken: current.reconnectToken,
          msgCount: current.msgCount,
          windowStart: current.windowStart,
        });
      }
    };

    ws.on("close", handleDisconnect);
    ws.on("error", handleDisconnect);
  }

  private tryReclaimSession(
    client: WsClient,
    oldId: string,
    presentedToken: string,
  ): SessionReclaimResult | null {
    if (!WebChannel.UUID_RE.test(oldId)) {
      return null;
    }

    const now = Date.now();
    const disconnectedSession = this.recentlyDisconnected.get(oldId);
    const disconnectedWithinTtl = disconnectedSession
      ? (now - disconnectedSession.disconnectedAt) < WebChannel.RECONNECT_TTL_MS
      : false;
    const disconnectedTokenMatches = disconnectedSession
      ? this.safeTokenEquals(presentedToken, disconnectedSession.reconnectToken)
      : false;

    const activeSession = this.clients.get(oldId);
    const activeTokenMatches = activeSession && activeSession.ws !== client.ws
      ? this.safeTokenEquals(presentedToken, activeSession.reconnectToken)
      : false;

    if (!((disconnectedWithinTtl && disconnectedTokenMatches) || activeTokenMatches)) {
      return null;
    }

    if (activeSession && activeSession.ws !== client.ws) {
      this.clients.delete(oldId);
      try {
        activeSession.ws.close(1000, "Session resumed elsewhere");
      } catch {
        // Connection may already be closing.
      }
    }

    // Restore rate-limit state from disconnected session to prevent bypass via reconnect
    if (disconnectedSession?.msgCount != null) {
      const windowStillActive = disconnectedSession.windowStart != null
        && (now - disconnectedSession.windowStart) < WS_RATE_WINDOW_MS;
      if (windowStillActive) {
        client.msgCount = disconnectedSession.msgCount;
        client.windowStart = disconnectedSession.windowStart!;
      }
    }

    this.recentlyDisconnected.delete(oldId);
    this.clients.delete(client.chatId);

    const reconnectToken = this.generateReconnectToken();
    client.chatId = oldId;
    client.reconnectToken = reconnectToken;
    this.clients.set(oldId, client);

    return { chatId: oldId, reconnectToken };
  }

  private initializeSession(
    ws: WebSocket,
    client: WsClient,
    data: Record<string, unknown>,
  ): SessionReclaimResult {
    const requestedChatId = typeof data.chatId === "string" ? data.chatId : "";
    const requestedReconnectToken = typeof data.reconnectToken === "string" ? data.reconnectToken : "";

    let chatId = client.chatId;
    let reconnectToken = client.reconnectToken;
    if (requestedChatId && requestedReconnectToken) {
      const reclaimed = this.tryReclaimSession(client, requestedChatId, requestedReconnectToken);
      if (reclaimed) {
        chatId = reclaimed.chatId;
        reconnectToken = reclaimed.reconnectToken;
        // TODO: DAG replay on reconnect — if there's an active goal tree,
        // re-emit monitor:dag_init + current node statuses so the portal
        // can reconstruct the monitor view. Currently the client gets a
        // blank monitor until the next DAG event arrives.
      }
    }

    const identity = this.resolveWebIdentity(data);
    client.profileId = identity.profileId;
    const cfgResult = loadConfigSafe();
    if (cfgResult.kind === "err") {
      getLoggerSafe().warn("Failed to load config for language preference, defaulting to en", { error: cfgResult.error });
    }
    const language = cfgResult.kind === "ok" ? cfgResult.value.language : "en";
    this.sendJson(ws, {
      type: "connected",
      chatId,
      reconnectToken,
      profileId: identity.profileId,
      profileToken: identity.profileToken,
      language,
    });

    void this.consumePostSetupBootstrap({ chatId, profileId: identity.profileId, profileToken: identity.profileToken });

    return { chatId, reconnectToken };
  }

  private handleWsMessage(chatId: string, data: Record<string, unknown>): void {
    const client = this.clients.get(chatId);
    if (client) {
      const now = Date.now();
      if (now - client.windowStart > WS_RATE_WINDOW_MS) {
        client.msgCount = 0;
        client.windowStart = now;
      }
      client.msgCount++;
      if (client.msgCount > WS_RATE_LIMIT) {
        this.sendToClient(chatId, {
          type: "text",
          text: "Rate limit exceeded. Please slow down.",
          messageId: randomUUID(),
        });
        client.ws.close(1008, "Rate limit exceeded");
        this.clients.delete(chatId);
        return;
      }
    }

    switch (data.type) {
      case "message": {
        const text = String(data.text ?? "").trim();
        const clientMessageId = typeof data.clientMessageId === "string"
          ? data.clientMessageId.trim()
          : "";
        const rawAttachments = data.attachments as Array<{
          type?: string;
          name?: string;
          mimeType?: string;
          data?: string; // base64
          size?: number;
        }> | undefined;

        if (!text && (!rawAttachments || rawAttachments.length === 0)) return;
        if (!this.handler) return;

        // Convert base64 attachments to Attachment[] with validation
        const attachments: Attachment[] = [];
        if (rawAttachments && Array.isArray(rawAttachments)) {
          for (const raw of rawAttachments.slice(0, 5)) { // Max 5 attachments per message
            const mimeType = normalizeMimeType(raw.mimeType || raw.type); // Frontend sends "type", normalize to mimeType
            if (!raw.name || !mimeType) continue;
            const buf = typeof raw.data === "string" ? Buffer.from(raw.data, "base64") : undefined;
            const size = buf?.length ?? raw.size ?? 0;

            // Validate before accepting
            const attachType = mimeType.startsWith("image/") ? "image"
              : mimeType.startsWith("video/") ? "video"
              : mimeType.startsWith("audio/") ? "audio" : "file";
            const validation = validateMediaAttachment({ mimeType, size, type: attachType });
            if (!validation.valid) {
              this.sendToClient(chatId, {
                type: "text",
                text: `File "${raw.name || 'attachment'}" was rejected: unsupported format or invalid content.`,
                messageId: randomUUID(),
              });
              continue;
            }
            if (buf && !validateMagicBytes(buf, mimeType)) {
              this.sendToClient(chatId, {
                type: "text",
                text: `File "${raw.name || 'attachment'}" was rejected: unsupported format or invalid content.`,
                messageId: randomUUID(),
              });
              continue;
            }

            attachments.push({
              type: attachType as Attachment["type"],
              name: typeof raw.name === "string"
                ? raw.name.replace(/[/\\:*?"<>|]/g, "_").slice(0, 255)
                : "unnamed",
              mimeType,
              data: buf,
              size,
            });
          }
        }

        // ACK after attachment validation so the client knows the message was accepted
        if (clientMessageId) {
          this.sendToClient(chatId, {
            type: "message_received",
            clientMessageId,
          });
        }

        const normalizedText = limitIncomingText(text || "");
        if (!normalizedText && attachments.length === 0) {
          return;
        }
        if (attachments.length === 0 && isFrontendPlaceholderText(normalizedText)) {
          return;
        }

        const msg: IncomingMessage = {
          channelType: "web",
          chatId,
          conversationId: client?.profileId ?? chatId,
          userId: client?.profileId ?? chatId,
          text: normalizedText,
          attachments: attachments.length > 0 ? attachments : undefined,
          timestamp: new Date(),
        };

        this.handler(msg).catch((err) => {
          this.sendToClient(chatId, {
            type: "text",
            text: classifyErrorMessage(err),
            messageId: randomUUID(),
          });
        });
        break;
      }

      case "confirmation_response": {
        const confirmId = String(data.confirmId ?? "");
        const option = String(data.option ?? "");
        const pending = this.pendingConfirmations.get(confirmId);
        if (!pending) break;
        // Verify the confirmation belongs to this client's session
        if (pending.chatId && pending.chatId !== chatId) {
          this.sendToClient(chatId, {
            type: "text",
            text: "Confirmation does not belong to this session.",
            messageId: randomUUID(),
          });
          break;
        }
        clearTimeout(pending.timer);
        this.pendingConfirmations.delete(confirmId);
        pending.resolve(option);
        break;
      }

      case "provider_switch": {
        const provider = String(data.provider ?? "").trim();
        if (!provider || !this.handler) break;
        const model = typeof data.model === "string" ? data.model.trim() : "";
        const hardPin = data.hardPin === true || data.selectionMode === "strada-hard-pin";
        const selection = `${provider}${model ? "/" + model : ""}`;
        const text = hardPin ? `/model pin ${selection}` : `/model ${selection}`;
        const msg: IncomingMessage = {
          channelType: "web",
          chatId,
          conversationId: client?.profileId ?? chatId,
          userId: client?.profileId ?? chatId,
          text: limitIncomingText(text),
          timestamp: new Date(),
        };
        this.handler(msg).catch(() => {
          this.sendToClient(chatId, {
            type: "text",
            text: "Failed to switch provider. Please try again.",
            messageId: randomUUID(),
          });
        });
        break;
      }

      case "feedback": {
        const feedbackType = String(data.feedbackType ?? "");
        const instinctIds = Array.isArray(data.instinctIds) ? data.instinctIds.filter(
          (id: unknown): id is string => typeof id === "string",
        ) : [];
        if (
          (feedbackType === "thumbs_up" || feedbackType === "thumbs_down") &&
          this.feedbackReactionCallback
        ) {
          this.feedbackReactionCallback(
            feedbackType,
            instinctIds,
            client?.profileId ?? chatId,
            "button",
          );
        }
        break;
      }

      case "autonomous_toggle": {
        const enabled = Boolean(data.enabled);
        if (!this.handler) break;
        const hours = typeof data.hours === "number" && data.hours > 0 ? data.hours : undefined;
        const text = `/autonomous ${enabled ? "on" : "off"}${hours ? " " + hours : ""}`;
        const msg: IncomingMessage = {
          channelType: "web",
          chatId,
          conversationId: client?.profileId ?? chatId,
          userId: client?.profileId ?? chatId,
          text: limitIncomingText(text),
          timestamp: new Date(),
        };
        this.handler(msg).catch(() => {
          this.sendToClient(chatId, {
            type: "text",
            text: "Failed to toggle autonomous mode. Please try again.",
            messageId: randomUUID(),
          });
        });
        break;
      }

      // Chat-context cancel: routes to /cancel command for the active task
      case "cancel_task": {
        if (!this.handler) break;
        const rawTaskId = typeof data.taskId === "string" ? data.taskId.trim() : "";
        const safeTaskId = /^[a-zA-Z0-9_-]+$/.test(rawTaskId) ? rawTaskId : "";
        const msg: IncomingMessage = {
          channelType: "web",
          chatId,
          conversationId: client?.profileId ?? chatId,
          userId: client?.profileId ?? chatId,
          text: safeTaskId ? `/cancel ${safeTaskId}` : "/cancel",
          timestamp: new Date(),
        };
        this.handler(msg).catch(() => {
          this.sendToClient(chatId, {
            type: "text",
            text: "Failed to cancel task.",
            messageId: randomUUID(),
          });
        });
        break;
      }

      // Workspace monitor commands from frontend
      case "monitor:pause":
      case "monitor:resume":
      case "monitor:retry_task":
      case "monitor:resume_task":
      case "monitor:skip_task":
      case "monitor:move_task":
      case "monitor:cancel_task":
      case "monitor:approve_gate":
      case "monitor:reject_gate":
      // Canvas commands from frontend (Phase 4)
      case "canvas:user_shapes":
      case "canvas:save":
      // Code commands from frontend (Phase 5)
      case "code:accept_diff":
      case "code:reject_diff":
      case "code:request_file": {
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter(data.type as string, data);
        }
        break;
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private sendToClient(chatId: string, data: Record<string, unknown>): void {
    const client = this.clients.get(chatId);
    if (!client || client.ws.readyState !== 1) {
      if (!client) {
        getLoggerSafe().debug("sendToClient: no active WS client for chatId, response may be lost", { chatId, type: data.type });
      }
      return;
    }
    this.sendJson(client.ws, data);
  }

  private sendJson(ws: WebSocket, data: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      getLoggerSafe().debug("WebSocket send failed", {
        readyState: ws.readyState,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async consumePostSetupBootstrap(context: PostSetupBootstrapContext): Promise<void> {
    if (this.postSetupBootstrapConsumed || !this.postSetupBootstrapHandler) {
      return;
    }

    this.postSetupBootstrapConsumed = true;

    try {
      await this.postSetupBootstrapHandler(context);
    } catch {
      // Bootstrap is best-effort; the first resolved session should not be retried.
    }
  }

  private resolveWebIdentity(data: Record<string, unknown>): WebIdentity {
    const profileId = typeof data.profileId === "string" ? data.profileId.trim() : "";
    const profileToken = typeof data.profileToken === "string" ? data.profileToken.trim() : "";
    if (
      WebChannel.UUID_RE.test(profileId) &&
      profileToken.length > 0 &&
      this.identityStore.verify(profileId, profileToken)
    ) {
      return { profileId, profileToken };
    }

    const legacyProfileId = this.resolveLegacyProfileId(data);
    if (legacyProfileId) {
      return this.identityStore.issue(legacyProfileId);
    }

    return this.identityStore.issue();
  }

  private resolveLegacyProfileId(data: Record<string, unknown>): string | undefined {
    const legacyProfileId = typeof data.legacyProfileChatId === "string"
      ? data.legacyProfileChatId.trim()
      : typeof data.profileChatId === "string"
        ? data.profileChatId.trim()
        : "";
    return WebChannel.UUID_RE.test(legacyProfileId) ? legacyProfileId : undefined;
  }

  private generateReconnectToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private safeTokenEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  /** Allowlisted dashboard API paths for proxy forwarding. */
  private static readonly ALLOWED_PROXY_PATHS = new Set([
    "/api/metrics",
    "/api/daemon",
    "/api/maintenance",
    "/api/chain-resilience",
    "/api/agents",
    "/api/delegations",
    "/api/consolidation",
    "/api/deployment",
    "/api/config",
    "/api/tools",
    "/api/channels",
    "/api/sessions",
    "/api/logs",
    "/api/identity",
    "/api/personality",
    "/api/personality/profiles",
    "/api/personality/switch",
    "/api/memory",
    "/api/providers/intelligence",
    "/api/providers/capabilities",
    "/api/providers/switch",
    "/api/models/refresh",
    "/api/daemon/start",
    "/api/daemon/stop",
    "/api/agent-activity",
    "/api/routing/preset",
    "/api/budget",
    "/api/budget/history",
    "/api/budget/config",
    "/api/learning/health",
    "/api/learning/decisions",
    "/api/user/autonomous",
    "/api/rag/status",
    "/api/system/boot",
  ]);

  /** Paths that accept POST or DELETE in addition to GET. */
  private static readonly MUTABLE_PROXY_PATHS = new Set([
    "/api/personality/profiles",
    "/api/personality/switch",
    "/api/user/autonomous",
    "/api/providers/switch",
    "/api/daemon/start",
    "/api/daemon/stop",
    "/api/routing/preset",
    "/api/budget/config",
  ]);

  private getSingleHeader(
    header: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(header) ? header[0] : header;
  }

  private isTrustedMutableProxyRequest(req: HttpReq): boolean {
    const origin = this.getSingleHeader(req.headers.origin);
    if (origin !== undefined) {
      return isAllowedOrigin(origin);
    }

    const referer = this.getSingleHeader(req.headers.referer);
    if (referer !== undefined) {
      return isAllowedOrigin(referer);
    }

    // Only trust Authorization header if a dashboard token is configured
    // and the header value matches it — prevents CSRF bypass via arbitrary auth headers.
    if (this.options.dashboardAuthToken) {
      const authHeader = this.getSingleHeader(req.headers.authorization);
      if (authHeader) {
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : authHeader;
        return this.safeTokenEquals(token, this.options.dashboardAuthToken);
      }
    }

    return false;
  }

  /**
   * Proxy /api/* requests to the dashboard server (same-origin solution).
   * GET is allowed for all allowlisted paths; POST/DELETE only for mutable paths.
   */
  private async proxyToDashboard(req: HttpReq, res: ServerResponse, url: string): Promise<void> {
    const method = req.method ?? "GET";

    // Allowlist check (strip query string for matching)
    const pathOnly = url.split("?")[0]!;
    const isAllowed =
      WebChannel.ALLOWED_PROXY_PATHS.has(pathOnly) ||
      pathOnly === "/api/goals" || pathOnly.startsWith("/api/goals/") ||
      pathOnly === "/api/agent-metrics" || pathOnly.startsWith("/api/agent-metrics/") ||
      pathOnly === "/api/triggers" || pathOnly.startsWith("/api/triggers/") ||
      pathOnly.startsWith("/api/personality/profiles/") ||
      pathOnly === "/api/canvas" || pathOnly.startsWith("/api/canvas/") ||
      pathOnly === "/api/workspace" || pathOnly.startsWith("/api/workspace/") ||
      pathOnly === "/api/skills" || pathOnly.startsWith("/api/skills/") ||
      pathOnly === "/api/providers/available" ||
      pathOnly === "/api/providers/active" ||
      pathOnly.startsWith("/api/providers/intelligence/");

    if (!isAllowed) {
      res.writeHead(403, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    // Method check: GET always allowed, POST/DELETE/PUT only for mutable paths
    const isMutable =
      WebChannel.MUTABLE_PROXY_PATHS.has(pathOnly) ||
      pathOnly.startsWith("/api/personality/profiles/") ||
      pathOnly === "/api/canvas" || pathOnly.startsWith("/api/canvas/") ||
      pathOnly.startsWith("/api/skills/") ||
      pathOnly === "/api/models/refresh";
    if (method !== "GET" && !(isMutable && (method === "POST" || method === "DELETE" || method === "PUT"))) {
      res.writeHead(405, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    if (method !== "GET" && !this.isTrustedMutableProxyRequest(req)) {
      res.writeHead(403, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    try {
      // Defense-in-depth: validate constructed URL points to expected target
      const target = new URL(url, `http://127.0.0.1:${this.dashboardPort}`);
      if (target.hostname !== "127.0.0.1" || target.port !== String(this.dashboardPort)) {
        res.writeHead(400, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request" }));
        return;
      }

      const controller = new AbortController();
      const timeoutMs = method === "GET" ? 15_000 : 20_000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      // Forward auth header if present (so dashboard token works through proxy)
      const proxyHeaders: Record<string, string> = {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      };
      const authHeader = this.getSingleHeader(req.headers.authorization);
      const originHeader = this.getSingleHeader(req.headers.origin);
      const refererHeader = this.getSingleHeader(req.headers.referer);
      if (authHeader) {
        proxyHeaders["Authorization"] = authHeader;
      } else if (this.options.dashboardAuthToken) {
        proxyHeaders["Authorization"] = `Bearer ${this.options.dashboardAuthToken}`;
      }
      if (originHeader && isAllowedOrigin(originHeader)) {
        proxyHeaders["Origin"] = originHeader;
      }
      if (refererHeader && isAllowedOrigin(refererHeader)) {
        proxyHeaders["Referer"] = refererHeader;
      }

      const fetchOpts: RequestInit = {
        method,
        signal: controller.signal,
        headers: proxyHeaders,
        cache: "no-store",
      };
      if (method === "POST" || method === "DELETE" || method === "PUT") {
        fetchOpts.headers = { ...proxyHeaders, "Content-Type": "application/json" };
        const bodyChunks: Buffer[] = [];
        let bodySize = 0;
        const PROXY_BODY_LIMIT = 64 * 1024; // 64KB
        let bodyReadAborted = false;
        await new Promise<void>((resolve, reject) => {
          req.on("data", (chunk: Buffer) => {
            bodySize += chunk.length;
            if (bodySize > PROXY_BODY_LIMIT) {
              req.destroy();
              reject(new Error("Body too large"));
              return;
            }
            bodyChunks.push(chunk);
          });
          req.on("end", () => resolve());
          req.on("error", reject);
        }).catch(() => {
          bodyReadAborted = true;
          clearTimeout(timeout);
          res.writeHead(413, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        });
        if (bodyReadAborted) return;
        if (bodyChunks.length > 0) {
          fetchOpts.body = Buffer.concat(bodyChunks).toString();
        }
      }

      const response = await fetch(target.href, fetchOpts);
      clearTimeout(timeout);

      const body = await response.text();
      res.writeHead(response.status, {
        ...WebChannel.SECURITY_HEADERS,
        ...WebChannel.NO_CACHE_HEADERS,
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      });
      res.end(body);
    } catch {
      res.writeHead(503, {
        ...WebChannel.SECURITY_HEADERS,
        ...WebChannel.NO_CACHE_HEADERS,
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Dashboard API unavailable", hint: "Set DASHBOARD_ENABLED=true" }));
    }
  }
}
