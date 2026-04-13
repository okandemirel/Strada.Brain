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
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
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
  /** Cached monitor state for replaying to reconnecting clients. */
  private lastMonitorSnapshot: string[] = [];

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private static readonly RECONNECT_TTL_MS = 5 * 60 * 1000;
  private static readonly MAX_MONITOR_SNAPSHOT_MESSAGES = 200;
  private static readonly CACHEABLE_MONITOR_TYPES = new Set([
    "monitor:task_update",
    "monitor:substep",
    "monitor:review_result",
    "monitor:agent_activity",
    "progress:narrative",
    "supervisor:activated",
    "supervisor:plan_ready",
    "supervisor:wave_start",
    "supervisor:node_start",
    "supervisor:node_complete",
    "supervisor:complete",
  ]);

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
    this.server = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
        getLoggerSafe().error('Unhandled HTTP error', { error: String(err) });
      });
    });

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

  /**
   * Per-chat in-flight `verify:check_criterion` spawn guard. Each chatId may
   * have at most one concurrent npm child process for build/test checks.
   * Prevents a malicious or buggy client from fan-out spawning unbounded
   * `npm run build` processes (DoS — CPU/disk/fd exhaustion).
   */
  private readonly inflightVerifyByChat = new Map<string, { checkType: string; startedAt: number }>();
  private static readonly MAX_CONCURRENT_VERIFY_PER_PROCESS = 4;

  /**
   * Build a scrubbed environment for `verify:*` npm child processes.
   * Strips env vars that match known provider-secret patterns so a compromised
   * build/test script (or a rogue postinstall) can't exfiltrate API keys.
   * Whitelisting PATH/HOME/USER/LANG/NODE_ENV is enough for `npm run build|test`.
   */
  private buildVerifySpawnEnv(): NodeJS.ProcessEnv {
    const allowPrefixes = ["PATH", "HOME", "USER", "LANG", "LC_", "TZ", "NODE_", "npm_", "TERM"];
    const blockPatterns = [
      /_API_KEY$/i,
      /_TOKEN$/i,
      /_SECRET$/i,
      /^OPENAI/i,
      /^ANTHROPIC/i,
      /^GEMINI/i,
      /^GOOGLE/i,
      /^KIMI/i,
      /^GROQ/i,
      /^MISTRAL/i,
      /^COHERE/i,
      /^DEEPSEEK/i,
      /^XAI/i,
      /^HF_/i,
      /PASSWORD/i,
      /CREDENTIAL/i,
    ];
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (blockPatterns.some((re) => re.test(k))) continue;
      if (allowPrefixes.some((p) => k.startsWith(p))) {
        out[k] = v;
      }
    }
    return out;
  }

  async disconnect(): Promise<void> {
    this.healthy = false;

    if (this._reconnectCleanupInterval) {
      clearInterval(this._reconnectCleanupInterval);
    }
    this.recentlyDisconnected.clear();
    this.inflightVerifyByChat.clear();
    this.lastMonitorSnapshot = [];

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
    // Cache monitor messages for replay on reconnect
    try {
      const parsed = JSON.parse(message);
      const type = parsed?.type;
      if (type === "monitor:dag_init" || type === "monitor:dag_restructure") {
        // DAG init/restructure replaces all previous monitor state
        this.lastMonitorSnapshot = [message];
      } else if (type === "monitor:clear") {
        this.lastMonitorSnapshot = [];
      } else if (typeof type === "string" && WebChannel.CACHEABLE_MONITOR_TYPES.has(type)) {
        if (this.lastMonitorSnapshot.length >= WebChannel.MAX_MONITOR_SNAPSHOT_MESSAGES) {
          // Evict the oldest incremental message (preserve index 0 = dag_init/restructure)
          this.lastMonitorSnapshot.splice(1, 1);
        }
        this.lastMonitorSnapshot.push(message);
      }
    } catch {
      // Not JSON — don't cache
    }

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

  /**
   * Replay cached monitor state to a single WebSocket client.
   * Called after session init so reconnecting clients see the current DAG.
   */
  private replayMonitorState(ws: WebSocket): void {
    for (const msg of this.lastMonitorSnapshot) {
      try {
        if (ws.readyState === 1) {
          ws.send(msg);
        }
      } catch {
        break; // Connection lost during replay
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

  async sendSystemMessage(chatId: string, text: string): Promise<void> {
    this.sendToClient(chatId, {
      type: "system",
      text,
      messageId: randomUUID(),
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

  // NOTE: streamSentLengths entries are only cleaned in finalizeStreamingMessage.
  // If a stream is abandoned (e.g. provider error before finalize), the entry
  // will leak until the next server restart. A periodic cleanup timer could be
  // added if this becomes a measurable issue in long-running instances.
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
    if (url === "/health" || url === "/api/health") {
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

        // Clean up per-session state that would otherwise leak
        this.appliedInstinctIds.delete(chatId);
        const pending = this.pendingConfirmations.get(chatId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve("timeout");
          this.pendingConfirmations.delete(chatId);
        }
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

    // Replay cached monitor state so reconnecting clients see the current DAG
    this.replayMonitorState(ws);

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
        const safeProvider = provider.replace(/[^a-zA-Z0-9._\-]/g, '');
        const safeModel = model.replace(/[^a-zA-Z0-9._:\-\/]/g, '');
        const hardPin = data.hardPin === true || data.selectionMode === "strada-hard-pin";
        const selection = `${safeProvider}${safeModel ? "/" + safeModel : ""}`;
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
        ).slice(0, 50) : [];
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
      case "monitor:move_task": {
        if (!this.workspaceBusEmitter) {
          this.sendToClient(chatId, {
            type: "text",
            text: "Monitor bridge is not available. Please try again.",
          });
          break;
        }
        const moveTaskId = String(data.taskId ?? "");
        const safeMove = /^[a-zA-Z0-9_-]+$/.test(moveTaskId) ? moveTaskId : "";
        const moveRootId = String(data.rootId ?? "");
        const safeRootMove = /^[a-zA-Z0-9_-]+$/.test(moveRootId) ? moveRootId : "";
        const moveNodeId = String(data.nodeId ?? "");
        const safeNodeMove = /^[a-zA-Z0-9_-]+$/.test(moveNodeId) ? moveNodeId : "";
        const toColumn = typeof data.toColumn === "string" ? data.toColumn.slice(0, 64) : "";
        const fromColumn = typeof data.fromColumn === "string" ? data.fromColumn.slice(0, 64) : "";
        const newStatus = typeof data.newStatus === "string" ? data.newStatus.slice(0, 64) : "";
        const newReviewStatus = typeof data.newReviewStatus === "string" ? data.newReviewStatus.slice(0, 64) : "";
        if (!safeMove) {
          getLoggerSafe().warn("monitor:move_task rejected — invalid taskId", { raw: moveTaskId });
          break;
        }
        this.workspaceBusEmitter("monitor:move_task", {
          type: "monitor:move_task",
          taskId: safeMove,
          ...(safeRootMove && { rootId: safeRootMove }),
          ...(safeNodeMove && { nodeId: safeNodeMove }),
          ...(toColumn && { toColumn }),
          ...(fromColumn && { fromColumn }),
          ...(newStatus && { newStatus }),
          ...(newReviewStatus && { newReviewStatus }),
        });
        break;
      }
      case "monitor:retry_task": {
        if (!this.workspaceBusEmitter) {
          this.sendToClient(chatId, {
            type: "text",
            text: "Monitor bridge is not available. Please try again.",
          });
          break;
        }
        const retryTaskId = String(data.taskId ?? "");
        const safeRetry = /^[a-zA-Z0-9_-]+$/.test(retryTaskId) ? retryTaskId : "";
        if (!safeRetry) {
          getLoggerSafe().warn("monitor:retry_task rejected — invalid taskId", { raw: retryTaskId });
          break;
        }
        const retryRootId = String(data.rootId ?? "");
        const safeRetryRoot = /^[a-zA-Z0-9_-]+$/.test(retryRootId) ? retryRootId : "";
        const retryNodeId = String(data.nodeId ?? "");
        const safeRetryNode = /^[a-zA-Z0-9_-]+$/.test(retryNodeId) ? retryNodeId : "";
        this.workspaceBusEmitter("monitor:retry_task", {
          type: "monitor:retry_task",
          taskId: safeRetry,
          ...(safeRetryRoot && { rootId: safeRetryRoot }),
          ...(safeRetryNode && { nodeId: safeRetryNode }),
        });
        break;
      }
      case "monitor:resume_task": {
        if (!this.workspaceBusEmitter) {
          this.sendToClient(chatId, {
            type: "text",
            text: "Monitor bridge is not available. Please try again.",
          });
          break;
        }
        const resumeTaskId = String(data.taskId ?? "");
        const safeResume = /^[a-zA-Z0-9_-]+$/.test(resumeTaskId) ? resumeTaskId : "";
        if (!safeResume) {
          getLoggerSafe().warn("monitor:resume_task rejected — invalid taskId", { raw: resumeTaskId });
          break;
        }
        const resumeRootId = String(data.rootId ?? "");
        const safeResumeRoot = /^[a-zA-Z0-9_-]+$/.test(resumeRootId) ? resumeRootId : "";
        const resumeNodeId = String(data.nodeId ?? "");
        const safeResumeNode = /^[a-zA-Z0-9_-]+$/.test(resumeNodeId) ? resumeNodeId : "";
        this.workspaceBusEmitter("monitor:resume_task", {
          type: "monitor:resume_task",
          taskId: safeResume,
          ...(safeResumeRoot && { rootId: safeResumeRoot }),
          ...(safeResumeNode && { nodeId: safeResumeNode }),
        });
        break;
      }
      case "monitor:cancel_task": {
        if (!this.workspaceBusEmitter) {
          this.sendToClient(chatId, {
            type: "text",
            text: "Monitor bridge is not available. Please try again.",
          });
          break;
        }
        const cancelBusTaskId = String(data.taskId ?? "");
        const safeCancelBus = /^[a-zA-Z0-9_-]+$/.test(cancelBusTaskId) ? cancelBusTaskId : "";
        if (!safeCancelBus) {
          getLoggerSafe().warn("monitor:cancel_task rejected — invalid taskId", { raw: cancelBusTaskId });
          break;
        }
        const cancelRootId = String(data.rootId ?? "");
        const safeCancelRoot = /^[a-zA-Z0-9_-]+$/.test(cancelRootId) ? cancelRootId : "";
        const cancelNodeId = String(data.nodeId ?? "");
        const safeCancelNode = /^[a-zA-Z0-9_-]+$/.test(cancelNodeId) ? cancelNodeId : "";
        this.workspaceBusEmitter("monitor:cancel_task", {
          type: "monitor:cancel_task",
          taskId: safeCancelBus,
          ...(safeCancelRoot && { rootId: safeCancelRoot }),
          ...(safeCancelNode && { nodeId: safeCancelNode }),
        });
        break;
      }
      case "monitor:pause":
      case "monitor:resume":
      case "monitor:skip_task":
      case "monitor:approve_gate":
      case "monitor:reject_gate": {
        const payloadSize = JSON.stringify(data).length;
        if (payloadSize > MAX_CONTROL_MESSAGE_BYTES) break;
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter(data.type as string, data);
        }
        break;
      }

      // Level Completion Verifier — run acceptance-criteria check for a task
      case "verify:check_criterion": {
        const payloadSize = JSON.stringify(data).length;
        if (payloadSize > MAX_CONTROL_MESSAGE_BYTES) break;
        const rawTaskId = typeof data.taskId === "string" ? data.taskId.trim() : "";
        const safeTaskId = /^[a-zA-Z0-9_-]+$/.test(rawTaskId) ? rawTaskId : "";
        const rawCriterionId = typeof data.criterionId === "string" ? data.criterionId.trim() : "";
        const safeCriterionId = /^[a-zA-Z0-9_-]+$/.test(rawCriterionId) ? rawCriterionId : "";
        const checkType = typeof data.checkType === "string" ? data.checkType : "";
        if (!safeTaskId || !safeCriterionId || !["build", "test", "manual"].includes(checkType)) {
          getLoggerSafe().warn("verify:check_criterion rejected — invalid payload", {
            taskId: rawTaskId,
            criterionId: rawCriterionId,
            checkType,
          });
          this.sendToClient(chatId, {
            type: "verify:check_result",
            taskId: safeTaskId || rawTaskId,
            criterionId: safeCriterionId || rawCriterionId,
            status: "fail",
            error: "Invalid verification request",
          });
          break;
        }

        if (checkType === "manual") {
          // Manual criteria are user-driven — instant pass ack
          this.sendToClient(chatId, {
            type: "verify:check_result",
            taskId: safeTaskId,
            criterionId: safeCriterionId,
            status: "pass",
            evidence: "Manual check acknowledged.",
          });
          break;
        }

        // DoS guard: at most one in-flight verify spawn per chat, and bounded
        // total concurrent spawns across the process. Reject fast with a
        // user-visible error instead of fan-out spawning npm processes.
        const existing = this.inflightVerifyByChat.get(chatId);
        if (existing) {
          this.sendToClient(chatId, {
            type: "verify:check_result",
            taskId: safeTaskId,
            criterionId: safeCriterionId,
            status: "fail",
            error: `Another verification (${existing.checkType}) is already running for this session. Wait for it to finish.`,
          });
          break;
        }
        if (this.inflightVerifyByChat.size >= WebChannel.MAX_CONCURRENT_VERIFY_PER_PROCESS) {
          this.sendToClient(chatId, {
            type: "verify:check_result",
            taskId: safeTaskId,
            criterionId: safeCriterionId,
            status: "fail",
            error: "Server is busy running other verifications. Try again shortly.",
          });
          break;
        }
        this.inflightVerifyByChat.set(chatId, { checkType, startedAt: Date.now() });

        // Spawn npm with a constrained allowlist (build/test), 30s timeout.
        // Resolve cwd once up-front and verify package.json exists — refuses
        // to spawn if the process was launched from an unexpected directory,
        // which would otherwise execute an unrelated project's npm scripts.
        const spawnCwd = process.cwd();
        Promise.all([
          import("node:child_process"),
          import("node:fs/promises"),
          import("node:path"),
        ]).then(async ([cp, fsp, pathMod]) => {
          try {
            await fsp.access(pathMod.join(spawnCwd, "package.json"));
          } catch {
            this.inflightVerifyByChat.delete(chatId);
            this.sendToClient(chatId, {
              type: "verify:check_result",
              taskId: safeTaskId,
              criterionId: safeCriterionId,
              status: "fail",
              error: "No package.json at server cwd — cannot run build/test.",
            });
            return;
          }
          const args = checkType === "build" ? ["run", "build"] : ["run", "test"];
          let stdoutBuf = "";
          let stderrBuf = "";
          const MAX_OUTPUT = 32 * 1024;
          let settled = false;

          const finish = (status: "pass" | "warn" | "fail", evidence?: string, error?: string) => {
            if (settled) return;
            settled = true;
            // Release the per-chat in-flight slot so the next verify request
            // can proceed. Must fire on every terminal branch (pass/warn/fail/
            // spawn-error/timeout) — hence single source of truth here.
            this.inflightVerifyByChat.delete(chatId);
            this.sendToClient(chatId, {
              type: "verify:check_result",
              taskId: safeTaskId,
              criterionId: safeCriterionId,
              status,
              ...(evidence ? { evidence: evidence.slice(0, 4000) } : {}),
              ...(error ? { error: error.slice(0, 2000) } : {}),
            });
          };

          try {
            const child = cp.spawn("npm", args, {
              shell: false,
              cwd: spawnCwd,
              timeout: 30_000,
              killSignal: "SIGTERM",
              stdio: ["ignore", "pipe", "pipe"],
              // Pass through env minus inherited secrets we don't need for npm scripts.
              // npm requires PATH + HOME + USER; we drop API keys by default.
              env: this.buildVerifySpawnEnv(),
            });

            child.stdout?.on("data", (chunk: Buffer) => {
              if (stdoutBuf.length < MAX_OUTPUT) {
                stdoutBuf += chunk.toString().slice(0, MAX_OUTPUT - stdoutBuf.length);
              }
            });
            child.stderr?.on("data", (chunk: Buffer) => {
              if (stderrBuf.length < MAX_OUTPUT) {
                stderrBuf += chunk.toString().slice(0, MAX_OUTPUT - stderrBuf.length);
              }
            });
            child.on("error", (err) => {
              finish("fail", undefined, `spawn error: ${err.message}`);
            });
            child.on("close", (code, signal) => {
              if (signal === "SIGTERM") {
                finish("fail", undefined, `Check timed out after 30s (${checkType})`);
                return;
              }
              const tail = (s: string) => s.split(/\r?\n/).slice(-20).join("\n");
              if (code === 0) {
                finish("pass", tail(stdoutBuf) || `${checkType} passed`);
              } else {
                finish("fail", tail(stdoutBuf), tail(stderrBuf) || `Exit code ${code}`);
              }
            });
          } catch (err) {
            finish("fail", undefined, err instanceof Error ? err.message : String(err));
          }
        }).catch((err) => {
          // Import failed — release slot before replying so the chat isn't wedged.
          this.inflightVerifyByChat.delete(chatId);
          getLoggerSafe().warn("verify:check_criterion import failed", { error: String(err) });
          this.sendToClient(chatId, {
            type: "verify:check_result",
            taskId: safeTaskId,
            criterionId: safeCriterionId,
            status: "fail",
            error: "Spawn subsystem unavailable",
          });
        });
        break;
      }

      case "verify:gate_decision": {
        const payloadSize = JSON.stringify(data).length;
        if (payloadSize > MAX_CONTROL_MESSAGE_BYTES) break;
        const rawTaskId = typeof data.taskId === "string" ? data.taskId.trim() : "";
        const safeTaskId = /^[a-zA-Z0-9_-]+$/.test(rawTaskId) ? rawTaskId : "";
        const verdict = typeof data.verdict === "string" ? data.verdict : "";
        const allowedVerdicts = ["approve", "request_changes", "escalate"];
        const note = typeof data.note === "string" ? data.note.slice(0, 2000) : "";
        if (!safeTaskId || !allowedVerdicts.includes(verdict)) {
          getLoggerSafe().warn("verify:gate_decision rejected — invalid payload", {
            taskId: rawTaskId,
            verdict,
          });
          this.sendToClient(chatId, {
            type: "verify:gate_ack",
            taskId: safeTaskId || rawTaskId,
            accepted: false,
            supervisorVerdict: "invalid_request",
          });
          break;
        }
        getLoggerSafe().info("verify:gate_decision received", {
          taskId: safeTaskId,
          verdict,
          noteLength: note.length,
        });
        // TODO: Integrate with src/supervisor/supervisor-verification.ts when reachable
        // from this context. For MVP we acknowledge receipt so the frontend state
        // transitions out of the pending banner.
        this.sendToClient(chatId, {
          type: "verify:gate_ack",
          taskId: safeTaskId,
          // Only an explicit "approve" verdict is an acceptance — "request_changes"
          // and "escalate" must surface as a non-green banner so operators aren't
          // misled into thinking an escalation was auto-approved.
          accepted: verdict === "approve",
          supervisorVerdict: verdict,
        });
        break;
      }
      // Canvas commands from frontend (Phase 4)
      case "canvas:user_shapes": {
        const snapshot = typeof data.snapshot === "string" ? data.snapshot : "";
        if (!snapshot || snapshot.length > 256_000) {
          if (!snapshot) getLoggerSafe().warn("canvas:user_shapes rejected — missing or invalid snapshot");
          break;
        }
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter("canvas:user_shapes", {
            type: "canvas:user_shapes",
            snapshot,
          });
        }
        break;
      }
      case "canvas:save": {
        const saveSessionId = typeof data.sessionId === "string" ? data.sessionId : "";
        const safeSaveSession = /^[a-zA-Z0-9_-]+$/.test(saveSessionId) ? saveSessionId : "";
        if (!safeSaveSession) {
          getLoggerSafe().warn("canvas:save rejected — invalid sessionId", { raw: saveSessionId });
          break;
        }
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter("canvas:save", {
            type: "canvas:save",
            sessionId: safeSaveSession,
          });
        }
        break;
      }
      // Code commands from frontend (Phase 5)
      case "code:accept_diff": {
        const acceptPath = typeof data.path === "string" ? data.path : "";
        const acceptHunk = typeof data.hunkIndex === "number" && Number.isFinite(data.hunkIndex)
          ? Math.floor(data.hunkIndex) : -1;
        if (!acceptPath || acceptHunk < 0) {
          getLoggerSafe().warn("code:accept_diff rejected — invalid path or hunkIndex", { path: acceptPath, hunkIndex: data.hunkIndex });
          break;
        }
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter("code:accept_diff", {
            type: "code:accept_diff",
            path: acceptPath,
            hunkIndex: acceptHunk,
          });
        }
        break;
      }
      case "code:reject_diff": {
        const rejectPath = typeof data.path === "string" ? data.path : "";
        const rejectHunk = typeof data.hunkIndex === "number" && Number.isFinite(data.hunkIndex)
          ? Math.floor(data.hunkIndex) : -1;
        if (!rejectPath || rejectHunk < 0) {
          getLoggerSafe().warn("code:reject_diff rejected — invalid path or hunkIndex", { path: rejectPath, hunkIndex: data.hunkIndex });
          break;
        }
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter("code:reject_diff", {
            type: "code:reject_diff",
            path: rejectPath,
            hunkIndex: rejectHunk,
          });
        }
        break;
      }
      case "code:request_file": {
        const reqFilePath = typeof data.path === "string" ? data.path : "";
        if (!reqFilePath) {
          getLoggerSafe().warn("code:request_file rejected — missing path");
          break;
        }
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter("code:request_file", {
            type: "code:request_file",
            path: reqFilePath,
          });
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
    "/api/providers/available",
    "/api/providers/active",
    "/api/deployment/check",
  ]);

  /** Prefix-based proxy allowlist — any path starting with these is proxied. */
  private static readonly ALLOWED_PROXY_PREFIXES: readonly string[] = [
    "/api/goals", "/api/agent-metrics", "/api/triggers",
    "/api/personality/profiles/",
    "/api/canvas", "/api/workspace", "/api/skills",
    "/api/providers/intelligence/",
    "/api/chat/",
    "/api/monitor/", "/api/settings/",
    "/api/daemon/approvals/",
  ];

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
    "/api/deployment/check",
    "/api/models/refresh",
  ]);

  /** Prefix-based mutable allowlist — POST/DELETE/PUT allowed for paths starting with these. */
  private static readonly MUTABLE_PROXY_PREFIXES: readonly string[] = [
    "/api/personality/profiles/",
    "/api/canvas", "/api/skills/",
    "/api/settings/", "/api/monitor/",
  ];

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
      WebChannel.ALLOWED_PROXY_PREFIXES.some((p) =>
        p.endsWith("/") ? pathOnly.startsWith(p) : (pathOnly === p || pathOnly.startsWith(p + "/")),
      );

    if (!isAllowed) {
      res.writeHead(403, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    // Method check: GET always allowed, POST/DELETE/PUT only for mutable paths
    const isMutable =
      WebChannel.MUTABLE_PROXY_PATHS.has(pathOnly) ||
      WebChannel.MUTABLE_PROXY_PREFIXES.some((p) =>
        p.endsWith("/") ? pathOnly.startsWith(p) : (pathOnly === p || pathOnly.startsWith(p + "/")),
      );
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
