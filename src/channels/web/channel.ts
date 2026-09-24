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
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, extname, resolve, sep } from "node:path";
import { randomBytes, timingSafeEqual, randomUUID, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { isAllowedOrigin, normalizeOrigin } from "../../security/origin-validation.js";
import { isAllowedHostHeader, rejectDisallowedHost, resolveAllowedHosts } from "../../security/host-validation.js";
import { loadConfigSafe } from "../../config/config.js";
import { validateMediaAttachment, validateMagicBytes, normalizeMimeType } from "../../utils/media-processor.js";
import { SETUP_QUERY_PARAM, type PostSetupBootstrapContext } from "../../common/setup-contract.js";
import { resolveWebStaticDir } from "../../common/web-static-dir.js";
import { LRUCache } from "../../common/lru-cache.js";
import { WebAttachmentStore } from "./web-attachment-store.js";
import { WebIdentityStore, type WebIdentity } from "./web-identity-store.js";
import {
  WS_CLOSE_POLICY_VIOLATION,
  WS_CLOSE_SESSION_TAKEN,
  WS_CLOSE_SESSION_TAKEN_REASON,
  WS_MAX_PAYLOAD_BYTES,
  mergeDagTopology,
  nextStreamUpdate,
  type DagTopology,
} from "./ws-protocol.js";
import { detectCommand } from "../../tasks/command-detector.js";
import {
  commandPrivilege,
  decideInstanceAccess,
  instanceRoleOf,
  ownerOnlyProxySurface,
  type AccessDecision,
  type InstanceActor,
  type InstanceFacts,
  type InstanceResource,
  type InstanceSurface,
} from "./instance-access.js";
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
import { npmCheckCwd, npmCheckInvocation } from "../npm-check-command.js";
import { SingleFlightCache } from "../single-flight-cache.js";
import { classifyErrorMessage } from "../../utils/error-messages.js";
import { hasSecrets } from "../../security/secret-sanitizer.js";
import { resolveBindHost } from "../../core/bind-host.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Resolves a `taskId` → owning `chatId`, or null/undefined when the task is
 * unknown (ephemeral / transient). May be sync (in-memory Map lookup) or
 * async (SQLite checkpoint lookup). Used by `verify:*` WS handlers to
 * reject cross-chat spawn triggers (CWE-639).
 */
export type TaskOwnerResolver = (
  taskId: string,
) => string | null | undefined | Promise<string | null | undefined>;

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
  /** Heartbeat liveness flag: set true on each pong, cleared on each ping. */
  isAlive: boolean;
  /**
   * True once this socket completed `session_init` / `reconnect` (round 13 #9).
   * A socket that never did presented no identity at all, and must not exercise
   * a power just because the instance happens to have one identity.
   */
  sessionInitialized: boolean;
}

interface RecentlyDisconnectedSession {
  disconnectedAt: number;
  reconnectToken: string;
  /**
   * The identity that owned the chat (round 13 #12). A reconnect token is a CHAT
   * credential; without the identity beside it a parked session could be
   * reclaimed by whoever held the token once the LRU binding aged out.
   */
  profileId?: string;
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

/** An answered confirmation: who settled it, with what, and until when it is remembered. */
interface SettledConfirmation {
  chatId: string;
  option: string;
  expiresAt: number;
}

interface WebChannelOptions {
  dashboardAuthToken?: string;
  /** Address to bind; loopback unless BIND_HOST says otherwise (14F2/D71). */
  bindHost?: string;
  identityDbPath?: string;
  /**
   * Where attachment records live. In memory by default (tests, ephemeral
   * runs); a real path keeps every attachment link working across a restart
   * (plan 2.8).
   */
  attachmentDbPath?: string;
  /**
   * Complete origins (scheme + host + port) the portal is legitimately reached
   * through besides its own bound port — round 10 #19. The Vite dev proxy
   * (`http://localhost:5173`, proxying to this backend) and an HTTPS reverse
   * proxy in front of the daemon (`https://portal.example`) both keep their own
   * origin on the browser's WebSocket handshake and mutations, and trusting only
   * the bound port refused them. Defaults to the comma-separated
   * `WEB_TRUSTED_ORIGINS` environment variable; unset means "bound port only",
   * exactly as before.
   */
  trustedOrigins?: readonly string[];
  /**
   * Hostnames besides loopback and IP literals whose `Host` header this portal
   * answers (CHN-2). Defaults to `HTTP_ALLOWED_HOSTS`; the hostnames of
   * `trustedOrigins` are always served too.
   */
  allowedHosts?: readonly string[];
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

/**
 * Measured build status for the portal: campaign snapshot, guardian snapshot,
 * and (only when asked) the delivery-gate measurement, which walks Assets/.
 */
export type BuildStatusProvider = (opts: { readonly measure: boolean }) => Promise<object>;

const PACKAGED_STATIC_DIR = fileURLToPath(new URL("static/", import.meta.url));
// In a source checkout the line above points at src/channels/web/static, which
// only holds a placeholder index.html (the built portal is git-ignored there and
// the build only populates the dist mirror). Fall back to the dist mirror / raw
// portal build so the web UI loads when Strada runs straight from source.
const STATIC_DIR_FALLBACKS = [
  fileURLToPath(new URL("../../../dist/channels/web/static/", import.meta.url)),
  fileURLToPath(new URL("../../../web-portal/dist/", import.meta.url)),
];

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
  // Prefer the packaged static/ dir so a stale web-portal/dist can never shadow a
  // valid packaged build, but fall back to the build output when running from a
  // source checkout where the packaged dir only holds a placeholder index.html.
  return resolveWebStaticDir([PACKAGED_STATIC_DIR, ...STATIC_DIR_FALLBACKS]);
}

export function getCanonicalWebRedirectTarget(url: string): string | null {
  // CHN-12: the request target is only ever a PATH on this server. Parsing it
  // relative to a base let a leading "//" be read as an authority, and the
  // Location built from it could then name another host. Anchor it under a
  // fixed origin instead, and collapse any leading run of slashes in the
  // result so the redirect can only stay on this origin.
  let parsed: URL;
  try {
    parsed = new URL(`http://127.0.0.1${url.startsWith("/") ? "" : "/"}${url}`);
  } catch {
    return null;
  }
  const hadSetupQuery = parsed.searchParams.get(SETUP_QUERY_PARAM) === "1";

  if (!hadSetupQuery) {
    return null;
  }

  parsed.searchParams.delete(SETUP_QUERY_PARAM);
  parsed.searchParams.delete(SETUP_CACHE_BUST_PARAM);

  const nextSearch = parsed.searchParams.toString();
  const pathname = parsed.pathname.replace(/^\/+/, "/");
  return `${pathname}${nextSearch ? `?${nextSearch}` : ""}${parsed.hash}`;
}

/** The topology a cached monitor dag frame carries, when it is well-formed. */
function dagTopologyOf(payload: unknown): DagTopology | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const { nodes, edges = [] } = payload as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return undefined;
  const nodeOk = (n: unknown) => !!n && typeof (n as { id?: unknown }).id === "string";
  const edgeOk = (e: unknown) =>
    !!e && typeof (e as { source?: unknown }).source === "string" && typeof (e as { target?: unknown }).target === "string";
  return nodes.every(nodeOk) && edges.every(edgeOk) ? { nodes, edges } : undefined;
}

/**
 * The cached dag frame (`previous`) with a new dag_init's nodes and edges added, as one
 * dag_init frame; undefined when the two cannot be folded (not both dag frames, a
 * malformed topology, or a different origin — the replay filters frames per origin).
 */
function foldDagInitFrame(previous: string | undefined, next: Record<string, unknown>): string | undefined {
  if (previous === undefined) return undefined;
  let prev: Record<string, unknown>;
  try {
    prev = JSON.parse(previous) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (prev.type !== "monitor:dag_init" && prev.type !== "monitor:dag_restructure") return undefined;
  if (prev.origin !== next.origin) return undefined;
  const prevTopology = dagTopologyOf(prev.payload);
  const nextTopology = dagTopologyOf(next.payload);
  if (!prevTopology || !nextTopology) return undefined;
  return JSON.stringify({
    ...next,
    payload: {
      ...(prev.payload as Record<string, unknown>),
      ...(next.payload as Record<string, unknown>),
      ...mergeDagTopology(prevTopology, nextTopology),
    },
  });
}

/** Body cap for requests the portal proxies to the dashboard API. */
const PROXY_BODY_LIMIT = 64 * 1024;
/**
 * Canvas saves send the whole board, which the dashboard's canvas routes accept
 * up to 1 MB (src/dashboard/canvas-routes.ts); the general 64 KB cap made any
 * board past it unsaveable (CHN-11).
 */
const PROXY_CANVAS_BODY_LIMIT = 1_048_576;
/** How much of an over-limit upload is read and discarded so the 413 can reach the browser. */
const PROXY_DRAIN_LIMIT = 16 * 1024 * 1024;
const PROXY_DRAIN_TIMEOUT_MS = 10_000;

function proxyBodyLimit(pathOnly: string): number {
  return pathOnly.startsWith("/api/canvas/") ? PROXY_CANVAS_BODY_LIMIT : PROXY_BODY_LIMIT;
}

/**
 * Read a proxied request body into `chunks`, up to `limit` bytes. Past the limit
 * the rest of the upload is drained (bounded in bytes and time) rather than the
 * socket destroyed: a response written to a browser that is still sending, then a
 * reset connection, reaches it as a network error instead of the 413.
 */
function readProxyBody(
  req: HttpReq,
  limit: number,
  chunks: Buffer[],
): Promise<"complete" | "too-large" | "error"> {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: "complete" | "too-large" | "error") => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      resolve(outcome);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      if (!drainTimer) {
        chunks.length = 0;
        drainTimer = setTimeout(() => settle("too-large"), PROXY_DRAIN_TIMEOUT_MS);
      }
      if (size > limit + PROXY_DRAIN_LIMIT) settle("too-large");
    });
    req.on("end", () => settle(size > limit ? "too-large" : "complete"));
    req.on("error", () => settle(size > limit ? "too-large" : "error"));
    // An aborted upload may never emit "end".
    req.on("close", () => settle(size > limit ? "too-large" : "error"));
  });
}

/** Rate limit: max messages per window. */
const WS_RATE_LIMIT = 20;
/** Rate limit window duration in ms (10 seconds). */
const WS_RATE_WINDOW_MS = 10_000;

export class WebChannel
  implements IChannelAdapter, IChannelStreaming, IChannelRichMessaging, IChannelInteractive
{
  readonly name = "web";

  /** A live or recently disconnected client, or a UUID-shaped id this channel would have minted. */
  claimsChatId(chatId: string): boolean {
    return (
      this.clients.has(chatId) ||
      this.recentlyDisconnected.has(chatId) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)
    );
  }

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private handler: MessageHandler | null = null;
  private healthy = false;
  /**
   * Set true at the start of disconnect() so the asynchronous ws 'close'/'error'
   * events (which the real ws library fires AFTER disconnect() returns) cannot
   * repopulate per-instance maps (e.g. recentlyDisconnected) after teardown.
   */
  private shuttingDown = false;
  private clients = new Map<string, WsClient>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  /**
   * Confirmations already answered (confirmId → owner chat + option), kept for
   * CONFIRMATION_TTL_MS and capped at MAX_SETTLED_CONFIRMATIONS, so a reply the
   * client re-sends after losing the ack is acked "accepted" again instead of
   * "unknown" (which the portal shows as expired). Codex wave 0-A review
   * 2026-09-17 #6. The record keeps who answered and what, so only the
   * identical reply from the owning chat is acked "accepted"; a different
   * option or another chat gets "unknown" (Codex 2026-09-17 round 3 #5).
   */
  private settledConfirmations = new Map<string, SettledConfirmation>();
  /** Recently disconnected chatIds eligible for reconnect (5 min TTL) */
  private recentlyDisconnected = new Map<string, RecentlyDisconnectedSession>();
  private postSetupBootstrapHandler: ((context: PostSetupBootstrapContext) => Promise<void> | void) | null = null;
  private postSetupBootstrapConsumed = false;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
  /** Per-chatId applied instinct IDs so responses can carry them for feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();
  /** The text the client already has for each active stream, so an update can be sent as a delta. */
  private readonly streamSentTexts = new Map<string, string>();
  /** Maps streamId → chatId so abandoned streams can be cleaned up on disconnect. */
  private readonly streamChatIds = new Map<string, string>();
  private readonly staticDir = resolveStaticDir();
  private readonly identityStore: WebIdentityStore;
  /** Attachment records, by token: rows, so a restart does not break the links. */
  private readonly attachmentStore: WebAttachmentStore;
  /** Optional emitter for workspace bus events from frontend monitor commands. */
  /**
   * Emits a frontend command onto the workspace bus. Returns true only when at
   * least one consumer was subscribed to that event at emit time, so acks can
   * report enforcement honestly; a void return means "unknown" (treated as no
   * consumer). (audited 2026-09-02)
   */
  private workspaceBusEmitter: ((event: string, payload: unknown) => boolean | void) | null = null;
  private buildStatusProvider: BuildStatusProvider | null = null;
  /** CHN-8: one delivery measurement at a time, reused for 10 s. */
  private readonly measuredBuildStatus = new SingleFlightCache<object>(10_000);
  /**
   * Cached monitor state for replaying to reconnecting clients, keyed PER DAG ROOT (episode).
   * The frontend monitor store is multi-root (rootsById, MAX_ROOTS); a single flat snapshot
   * lost every prior root's board on reconnect (BUG#5 P1) because each new dag_init clobbered
   * it. Each root keeps its own bounded frame list (index 0 = dag_init/restructure). The LRUCache
   * caps distinct roots at MAX_MONITOR_ROOTS (least-recently-touched evicted; an active root stays
   * hot because appending an incremental reads — and so bumps — its bucket), mirroring the store.
   */
  private readonly lastMonitorSnapshotByRoot: LRUCache<string, string[]>;
  /** The most-recently-opened monitor root — routes rootId-less (or evicted-root) incrementals. */
  private lastMonitorRootKey: string | undefined;
  /**
   * Per-chatId buffer of answer-bearing frames (markdown/text/system) that could
   * NOT be delivered because no live socket was present at send time. Flushed to
   * the socket on the next session-init/reconnect (next to replayMonitorState) so
   * a background final produced while the client was offline is still surfaced.
   * Bounded per chat (MAX_PENDING_DELIVERY_FRAMES, oldest-evicted) so it cannot
   * grow without limit. The client dedups by the frame's stable messageId, so a
   * frame both replayed here and previously received live renders only once.
   */
  private readonly pendingDelivery = new Map<string, Record<string, unknown>[]>();

  /**
   * chatId → the profile identity that owns it, kept past disconnect so an
   * attachment or a frame produced while the browser is away is still
   * attributable (plan 6.14). Bounded; least-recently-touched evicted.
   */
  private readonly profileByChat = new LRUCache<string, string>(500);
  /**
   * A browser cannot put a profile header on an `<img src>`, so the href this
   * server hands to the owning socket carries its own proof:
   * `?v=HMAC(token, ownerProfileId)`. Only the owner's socket ever received that
   * href, so presenting it IS the owner's claim — and a guest with the bare
   * token has nothing to present.
   *
   * WHOSE attachment it is, and the key that signs that proof, both live in the
   * attachment store's database now. They were an in-process LRU and a
   * per-process key until 6.14's durable half, so after a restart the same link
   * was unattributable — served on a single-identity instance and refused on a
   * shared one, i.e. readable or not depending on when the daemon last booted.
   */
  private linkScopeKeyCache: Buffer | undefined;

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private static readonly RECONNECT_TTL_MS = 5 * 60 * 1000;
  /** How long a confirmation prompt waits for an answer; settled ids are remembered as long. */
  private static readonly CONFIRMATION_TTL_MS = 5 * 60 * 1000;
  private static readonly MAX_SETTLED_CONFIRMATIONS = 100;
  /** Interval between WebSocket liveness pings (terminates dead half-open sockets). */
  private static readonly WS_HEARTBEAT_MS = 30 * 1000;
  private static readonly MAX_MONITOR_SNAPSHOT_MESSAGES = 200;
  /** Max distinct DAG roots retained for reconnect replay (mirrors the portal store's MAX_ROOTS). */
  private static readonly MAX_MONITOR_ROOTS = 20;
  /** Fallback root key for a dag_init/restructure that arrives without a rootId (defensive). */
  private static readonly DEFAULT_MONITOR_ROOT = "__default__";
  /** Max buffered undelivered answer frames per chat before oldest is evicted. */
  private static readonly MAX_PENDING_DELIVERY_FRAMES = 20;
  /**
   * Frame types worth buffering for offline replay (answer-bearing only, plus
   * confirmation_ack: the terminal verdict on an answer the client is holding
   * a dialog open for — Codex wave 0-A review 2026-09-17 #6).
   */
  private static readonly REPLAYABLE_FRAME_TYPES = new Set(["markdown", "text", "system", "confirmation_ack", "attachment"]);
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
    // Terminal / negative supervisor frames. These were missing, so a reconnect
    // (heartbeat terminate, laptop sleep, refresh) replayed node_start without
    // the node_failed that superseded it: SupervisorPanel showed the failed
    // node as "running", its alert feed empty, and an aborted run with no
    // summary. A replayed board must never be greener than the live one
    // (audited 2026-09-02). Toast-only frames (budget:*, workspace:notification)
    // stay uncached on purpose — replaying them would re-fire stale toasts.
    "supervisor:node_failed",
    "supervisor:escalation",
    "supervisor:wave_done",
    "supervisor:verify_start",
    "supervisor:verify_done",
    "supervisor:aborted",
  ]);

  /** Address this channel binds to (14F2/D71). */
  private readonly bindHost: string;

  /** Extra Host names this portal answers for (CHN-2). */
  private readonly allowedHosts: readonly string[];

  constructor(
    private readonly port: number = 3000,
    private readonly dashboardPort: number = 3100,
    private readonly options: WebChannelOptions = {},
  ) {
    this.allowedHosts = options.allowedHosts ?? resolveAllowedHosts();
    this.identityStore = new WebIdentityStore(options.identityDbPath ?? ":memory:");
    this.attachmentStore = new WebAttachmentStore(
      options.attachmentDbPath ?? ":memory:",
      WebChannel.ATTACHMENT_TTL_MS,
      WebChannel.MAX_SERVED_ATTACHMENTS,
    );
    this.lastMonitorSnapshotByRoot = new LRUCache(WebChannel.MAX_MONITOR_ROOTS);
    this.bindHost = options.bindHost ?? resolveBindHost();
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register a callback for feedback reactions (thumbs up/down). */
  setFeedbackHandler(callback: FeedbackReactionCallback | null): void {
    this.feedbackReactionCallback = callback;
  }

  /**
   * Register an emitter for workspace bus events from frontend monitor commands.
   * The emitter should return whether a consumer was subscribed to the event.
   */
  setWorkspaceBusEmitter(emitter: ((event: string, payload: unknown) => boolean | void) | null): void {
    this.workspaceBusEmitter = emitter;
  }

  /**
   * Register the daemon's measured build status (campaign + guardian + on
   * demand the delivery measurement). Served at GET /api/campaign, pushed as a
   * `campaign:status` frame on every session init, and re-pushed by
   * `broadcastBuildStatus()` whenever the campaign or guardian speaks.
   */
  setBuildStatusProvider(provider: BuildStatusProvider | null): void {
    this.buildStatusProvider = provider;
    this.measuredBuildStatus.clear();
  }

  /** Push the current build status to every connected client (no-op without a provider). */
  async broadcastBuildStatus(): Promise<void> {
    if (!this.buildStatusProvider || this.clients.size === 0) return;
    try {
      const status = await this.buildStatusProvider({ measure: false });
      this.broadcastRaw(JSON.stringify({ type: "campaign:status", payload: status, timestamp: Date.now() }));
    } catch (err) {
      getLoggerSafe().warn("[WebChannel] build status broadcast failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

    // maxPayload: shared with the portal (ws-protocol.ts), which keeps a
    // message's base64 attachments inside it instead of having the socket
    // closed with 1009 (WEB-3).
    // verifyClient: reject WebSocket connections whose Origin header is not
    // THIS portal's own origin, blocking cross-origin WebSocket hijacking from a
    // malicious page open in the same browser — including one served by another
    // process on another loopback port (audit 13F6 / plan 4.8).
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      verifyClient: ({ req }: { req: HttpReq }) => this.acceptsHost(req) && this.acceptsWsOrigin(req),
    });
    this.wss.on("connection", (ws) => this.handleWsConnection(ws));

    await new Promise<void>((res, rej) => {
      const onError = (error: Error) => {
        this.server?.off("error", onError);
        rej(error);
      };
      try {
        this.server!.once("error", onError);
        this.server!.listen(this.port, this.bindHost, () => {
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
      // Evict buffered finals for chats that can no longer reconnect (no live
      // socket AND past the reconnect window) so the pending buffer cannot
      // accumulate orphaned keys over long uptimes. A chat that is still
      // connected or reconnect-eligible is kept (flush is still possible).
      for (const id of this.pendingDelivery.keys()) {
        if (!this.clients.has(id) && !this.recentlyDisconnected.has(id)) {
          this.pendingDelivery.delete(id);
        }
      }
    }, WebChannel.RECONNECT_TTL_MS);

    // Heartbeat: ping each client every tick and terminate any that did not
    // pong since the previous tick. A half-open TCP socket (client vanished
    // without FIN/RST) never fires 'close', so without this its WsClient leaks
    // in this.clients indefinitely. terminate() fires 'close' → handleDisconnect
    // does the normal map/session cleanup.
    this._wsHeartbeatInterval = setInterval(() => this.wsHeartbeatTick(), WebChannel.WS_HEARTBEAT_MS);

    console.log(`Web channel running at http://${this.bindHost}:${this.port}`);
  }

  private _reconnectCleanupInterval: ReturnType<typeof setInterval> | undefined;
  private _wsHeartbeatInterval: ReturnType<typeof setInterval> | undefined;

  /**
   * One heartbeat round: terminate clients that didn't pong since the last
   * tick, then ping the rest (clearing isAlive until their pong arrives).
   * Extracted from the interval so it can be driven deterministically in tests.
   */
  private wsHeartbeatTick(): void {
    for (const [, client] of this.clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      try { client.ws.ping(); } catch { /* socket already closing */ }
    }
  }

  /**
   * Per-chat in-flight `verify:check_criterion` spawn guard. Each chatId may
   * have at most one concurrent npm child process for build/test checks.
   * Prevents a malicious or buggy client from fan-out spawning unbounded
   * `npm run build` processes (DoS — CPU/disk/fd exhaustion).
   */
  private readonly inflightVerifyByChat = new Map<string, { checkType: string; startedAt: number }>();
  private static readonly MAX_CONCURRENT_VERIFY_PER_PROCESS = 4;

  /**
   * Optional resolver mapping a taskId to its owning chatId. Used by the
   * `verify:check_criterion` / `verify:gate_decision` handlers to reject
   * cross-chat spawn/decision attempts (CWE-639; precedent: the
   * `confirmation_response` ownership check at commit 6660012).
   *
   * When unset or when the resolver returns `null`/`undefined` for an
   * unknown/transient task we allow-and-log — the portal uses ephemeral
   * task ids that may never hit a persistent store, so strict rejection
   * would regress the MVP flow.
   */
  private taskOwnerResolver: TaskOwnerResolver | null = null;

  /**
   * Wire a task → chatId ownership resolver. Optional. The resolver MAY be
   * async (returns a Promise) — bootstrap typically wires it to an SQLite
   * checkpoint lookup. Implementations should still aim for O(1) / short
   * latency because this sits on the hot `verify:*` WS handler path.
   *
   * NOTE: we intentionally accept both sync and async variants so the
   * existing sync in-memory cache pattern keeps working while the
   * bootstrap-wired TaskCheckpointStore lookup (async) is also supported.
   */
  setTaskOwnerResolver(resolver: TaskOwnerResolver | null): void {
    this.taskOwnerResolver = resolver;
  }

  /**
   * Task ↔ chat ownership check for `verify:*` handlers.
   * - unknown task (resolver unwired or returns null/undefined): allow, log
   *   at info level (portal fires verify on ephemeral tasks).
   * - known task owned by a DIFFERENT chat: reject.
   * - known task owned by THIS chat: allow.
   */
  private async checkTaskOwnership(
    taskId: string,
    chatId: string,
    context: string,
  ): Promise<{ allowed: boolean; owner: string | null; reason?: string }> {
    if (!this.taskOwnerResolver) return { allowed: true, owner: null };
    let owner: string | null | undefined;
    try {
      // `await` transparently unwraps both sync return values and Promises,
      // and catches both synchronous throws from the resolver and rejected
      // promises. The WS handler must stay live even when the persistent
      // store is down, so any failure falls through to allow-and-log.
      owner = await this.taskOwnerResolver(taskId);
    } catch (err) {
      getLoggerSafe().warn("task ownership resolver threw — asking the model instead", {
        context,
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.decideUnownedTask(taskId, chatId, context);
    }
    if (owner == null) {
      return this.decideUnownedTask(taskId, chatId, context);
    }
    if (owner !== chatId) {
      getLoggerSafe().warn("task ownership mismatch — cross-chat action rejected", {
        context,
        taskId,
        chatId,
        owner,
      });
      return { allowed: false, owner };
    }
    return { allowed: true, owner };
  }

  /**
   * ROUND 15 #4 — AN UNKNOWN OWNER IS NOT A GRANT.
   *
   * The resolver bootstrap wires is a CHECKPOINT lookup, and a task has no
   * checkpoint until one is written: for a freshly queued task it answers null.
   * "null ⇒ allow, it is probably a portal-ephemeral id" therefore handed a guest
   * the owner's brand-new task — through /cancel, /goal cancel, monitor:retry_task
   * and every other task route — and the hole was widest exactly when the task was
   * most worth cancelling. A resolver that is DOWN said the same thing.
   *
   * The model already answers this: `task:control` is own-identity and a task no
   * identity can be shown to own is instance traffic, which the instance owner
   * controls (`unattributedIsInstanceTraffic`). So the guest is refused, the owner
   * keeps working, and nothing depends on whether a checkpoint has been written.
   */
  private decideUnownedTask(
    taskId: string,
    chatId: string,
    context: string,
  ): { allowed: boolean; owner: null; reason?: string } {
    const facts = this.instanceFacts();
    const decision = this.decide("task:control", this.actorForChat(chatId, facts), {
      facts,
      resource: {},
      what: taskId,
    });
    if (!decision.allowed) {
      getLoggerSafe().warn("task ownership unknown — refused by the shared-instance model", {
        context,
        taskId,
        chatId,
        code: decision.code,
      });
      return { allowed: false, owner: null, reason: decision.reason };
    }
    return { allowed: true, owner: null };
  }

  private async checkVerifyTaskOwnership(
    taskId: string,
    chatId: string,
  ): Promise<{ allowed: boolean; owner: string | null; reason?: string }> {
    return this.checkTaskOwnership(taskId, chatId, "verify");
  }

  private async checkMonitorTaskOwnership(taskId: string, chatId: string, context: string): Promise<boolean> {
    const ownership = await this.checkTaskOwnership(taskId, chatId, context);
    if (ownership.allowed) return true;
    this.sendToClient(chatId, {
      type: "text",
      // The model's own reason when it made the decision (an unowned task), else
      // the cross-chat wording with the owning identity named.
      text: `Refused: ${ownership.reason ?? this.taskRefusalReason(taskId, chatId, ownership.owner, context)}.`,
      messageId: randomUUID(),
    });
    return false;
  }

  /**
   * Plan 6.14, surface task:control: a refusal names the identity that was
   * refused and what it tried, not just "does not belong to this chat" — on a
   * shared instance the person reading it needs to know WHICH identity was
   * turned away. Also logs the refusal.
   */
  private taskRefusalReason(
    taskId: string,
    chatId: string,
    owner: string | null,
    context: string,
  ): string {
    const facts = this.instanceFacts();
    const actor = this.actorForChat(chatId, facts);
    const ownerProfileId = owner ? this.profileByChat.get(owner) : undefined;
    const refusedWho = actor.profileId ? `${actor.role} identity ${actor.profileId}` : `unidentified caller (chat ${chatId})`;
    const belongsTo = ownerProfileId ? `identity ${ownerProfileId}` : `chat ${owner}`;
    const reason = `${refusedWho} may not control this task "${taskId}": it belongs to ${belongsTo}`;
    getLoggerSafe().warn("[WebChannel] instance access refused", {
      surface: "task:control" satisfies InstanceSurface,
      code: "deny:other-identity",
      context,
      profileId: actor.profileId ?? null,
      chatId,
      reason,
    });
    return reason;
  }

  /**
   * Build a scrubbed environment for `verify:*` npm child processes.
   * Strips env vars that match known provider-secret patterns so a compromised
   * build/test script (or a rogue postinstall) can't exfiltrate API keys.
   * Whitelisting PATH/HOME/USER/LANG/NODE_ENV is enough for `npm run build|test`.
   *
   * Defense-in-depth:
   *   1. Local block patterns (fast, provider-focused) catch obvious keys.
   *   2. Canonical `hasSecrets` from `security/secret-sanitizer` inspects
   *      `KEY=VALUE` and catches GH_/GHP_/GHO_, XOX*, AWS_*, DATABASE_URL,
   *      JWT, Anthropic sk-ant-, GCP AIza*, Telegram, Discord, etc.
   *   Either gate positive ⇒ drop the variable. A canonical-sanitizer
   *   failure cannot WIDEN the allowlist; it degrades to "drop".
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
      /^GH[POUSR]_/i,
      /^AWS_/i,
      /^DATABASE_URL$/i,
      /^JWT_/i,
      /^XOX[BPAS]_?/i,
      /PASSWORD/i,
      /CREDENTIAL/i,
    ];
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      // Local fast-path block (provider + common creds).
      if (blockPatterns.some((re) => re.test(k))) continue;
      // Allowlist prefix gate — drops everything we don't explicitly want.
      if (!allowPrefixes.some((p) => k.startsWith(p))) continue;
      // Canonical secret scrubber as defense-in-depth. Catches values that
      // look like API keys / JWTs / connection strings even when the name
      // slipped past the allowlist prefix (e.g. npm_package_config_* that
      // a malicious package.json could set).
      try {
        if (hasSecrets(`${k}=${v}`)) continue;
      } catch {
        // Sanitizer errors must never widen the allowlist — drop on failure.
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    // Signal teardown BEFORE closing sockets so the async ws 'close'/'error'
    // events (which fire after this method returns with the real ws library)
    // early-return in handleDisconnect instead of repopulating recentlyDisconnected
    // (and other per-instance maps) after they have been cleared below.
    this.shuttingDown = true;

    if (this._reconnectCleanupInterval) {
      clearInterval(this._reconnectCleanupInterval);
    }
    if (this._wsHeartbeatInterval) {
      clearInterval(this._wsHeartbeatInterval);
    }
    this.recentlyDisconnected.clear();
    // Intentionally NOT clearing inflightVerifyByChat here. Each spawn owns
    // its own slot and releases it in the terminal `finish()` callback
    // (pass/warn/fail/timeout/spawn-error/import-error). Clearing on
    // disconnect would allow a reconnect to trigger a second concurrent
    // child process while the first is still running — a DoS/rate-limit
    // bypass (precedent: fix commit 6660012). Slot lifetime is
    // process-level, not chat-level.
    this.lastMonitorSnapshotByRoot.clear();
    this.lastMonitorRootKey = undefined;
    this.pendingDelivery.clear();

    for (const [, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timer);
      pending.resolve("timeout");
    }
    this.pendingConfirmations.clear();
    this.settledConfirmations.clear();
    this.streamSentTexts.clear();
    this.streamChatIds.clear();

    for (const [, client] of this.clients) {
      client.ws.close(1000, "Server shutting down");
    }
    this.clients.clear();
    this.identityStore.close();
    // Releases the attachment database AND its idle retention sweep; an
    // in-memory store also drops the temp spool it owns (round 11 #14).
    this.attachmentStore.close();

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
    // Cache monitor messages PER ROOT for replay on reconnect (rootId lives at payload.rootId —
    // the monitor-bridge envelope is {type, payload, origin?, timestamp}).
    let origin: string | undefined;
    try {
      const parsed = JSON.parse(message);
      origin = typeof parsed?.origin === "string" ? (parsed.origin as string) : undefined;
      const type = parsed?.type;
      const rootId =
        typeof parsed?.payload?.rootId === "string" ? (parsed.payload.rootId as string) : undefined;
      if (type === "monitor:dag_init" || type === "monitor:dag_restructure") {
        // A restructure resets ONLY this root's board (index 0 = the dag frame); the LRUCache
        // evicts the oldest OTHER root past the cap (never this just-touched one). A dag_init
        // ADDS to the board, as the portal applies it (WEB-6): it is folded into index 0 and the
        // root's incrementals are kept, so a replay rebuilds the same board as the live stream.
        const key = rootId ?? WebChannel.DEFAULT_MONITOR_ROOT;
        const cached = this.lastMonitorSnapshotByRoot.get(key);
        const folded = type === "monitor:dag_init" && cached ? foldDagInitFrame(cached[0], parsed) : undefined;
        if (cached && folded) {
          cached[0] = folded;
          this.lastMonitorSnapshotByRoot.set(key, cached);
        } else {
          this.lastMonitorSnapshotByRoot.set(key, [message]);
        }
        this.lastMonitorRootKey = key;
      } else if (type === "monitor:clear") {
        this.lastMonitorSnapshotByRoot.clear();
        this.lastMonitorRootKey = undefined;
      } else if (typeof type === "string" && WebChannel.CACHEABLE_MONITOR_TYPES.has(type)) {
        // Route the incremental to its root's board (see resolveIncrementalRoot — preserves the
        // prior flat-cache behavior of retaining a pre-dag_init incremental).
        const target = this.resolveIncrementalRoot(rootId);
        if (target.length >= WebChannel.MAX_MONITOR_SNAPSHOT_MESSAGES) {
          // Evict the oldest incremental message (preserve index 0 = dag_init/restructure)
          target.splice(1, 1);
        }
        target.push(message);
      }
    } catch {
      // Not JSON — don't cache
    }

    // One instance snapshot for the whole fan-out: the visibility rule is the
    // same for every socket in this broadcast and the store must not be read
    // per client per frame.
    const facts = origin === undefined ? undefined : this.instanceFacts();
    for (const [, client] of this.clients) {
      if (client.ws.readyState !== 1) continue;
      if (!this.monitorFrameVisibleTo(origin, client.profileId, facts)) continue;
      try {
        client.ws.send(message);
      } catch {
        // Connection may have closed between readyState check and send
      }
    }
  }

  // ===========================================================================
  // Shared-instance management model (plan 6.14) — see ./instance-access.ts
  // ===========================================================================

  /** What this instance is: its owner, and whether more than one identity lives here. */
  private instanceFacts(): InstanceFacts {
    try {
      const ownerProfileId = this.identityStore.ownerProfileId();
      return { shared: this.identityStore.count() > 1, ...(ownerProfileId ? { ownerProfileId } : {}) };
    } catch (err) {
      // A store failure must not silently widen access: an instance whose owner
      // cannot be read is treated as shared with an unknown owner, so every
      // owner-only surface refuses instead of falling through to "allowed".
      getLoggerSafe().warn("[WebChannel] identity store unreadable — treating instance as shared", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { shared: true };
    }
  }

  /** The actor a live socket represents: its profile identity and its role here. */
  private actorFor(profileId: string | undefined, chatId: string | undefined, facts: InstanceFacts): InstanceActor {
    const role = instanceRoleOf(profileId, facts, (candidate) => this.isIssuedProfileId(candidate));
    return {
      role,
      ...(role === "unidentified" ? {} : { profileId: profileId! }),
      ...(chatId ? { chatId } : {}),
    };
  }

  /** The actor behind a chatId, whether or not its socket is live right now. */
  private actorForChat(chatId: string, facts: InstanceFacts): InstanceActor {
    const profileId = this.clients.get(chatId)?.profileId ?? this.profileByChat.get(chatId);
    // Before session_init a client's profileId is its own chatId, which the
    // identity store never issued — instanceRoleOf then reports "unidentified".
    return this.actorFor(profileId, chatId, facts);
  }

  /**
   * Ask the model, log every refusal with the identity and the reason, and hand
   * the decision back. The reason is never dropped: a caller either forwards it
   * to the refused client or puts it in the HTTP body.
   */
  private decide(
    surface: InstanceSurface,
    actor: InstanceActor,
    opts: { resource?: InstanceResource; what?: string; facts?: InstanceFacts } = {},
  ): AccessDecision {
    const decision = decideInstanceAccess({
      surface,
      actor,
      instance: opts.facts ?? this.instanceFacts(),
      ...(opts.resource ? { resource: opts.resource } : {}),
      ...(opts.what ? { what: opts.what } : {}),
    });
    if (!decision.allowed) {
      getLoggerSafe().warn("[WebChannel] instance access refused", {
        surface,
        code: decision.code,
        profileId: actor.profileId ?? null,
        chatId: actor.chatId ?? null,
        reason: decision.reason,
      });
    }
    return decision;
  }

  /**
   * WS frames that EXERCISE something — the instance, or one named task — and
   * therefore need a socket that has said who it is (round 13 #9).
   *
   * THE DEFECT. A socket is in `clients` the moment it connects, with its own
   * chatId standing in for a profileId, and nothing required `session_init`
   * before a control frame. Sending `monitor:pause` first left the socket
   * unidentified, kept the identity count at one, and the model's
   * "single identity, nobody to be separated from" grant handed it the run.
   * The model no longer grants that once an owner exists; this set is the other
   * half, and it holds even on an instance that has no owner yet: a frame that
   * acts arrives after the caller has an identity, or it does not arrive.
   *
   * `message`, `ping` and the read frames are deliberately absent — an
   * uninitialized socket may still talk, and a privileged COMMAND typed into it
   * is refused by the model in `allowChatCommand`.
   */
  private static readonly SESSION_REQUIRED_WS_TYPES: ReadonlySet<string> = new Set([
    // instance:control
    "provider_switch",
    "autonomous_toggle",
    "monitor:pause",
    "monitor:resume",
    // task:control
    "cancel_task",
    "monitor:move_task",
    "monitor:retry_task",
    "monitor:resume_task",
    "monitor:cancel_task",
    "monitor:skip_task",
    "monitor:approve_gate",
    "monitor:reject_gate",
    "verify:check_criterion",
    "verify:gate_decision",
    // writes into the shared project
    "code:accept_diff",
    "code:reject_diff",
  ]);

  /**
   * Whether a frame that acts may be acted on: the socket must have completed
   * `session_init` / `reconnect`. On refusal the caller is told, by name.
   */
  private hasInitializedSession(chatId: string, frameType: string): boolean {
    if (this.clients.get(chatId)?.sessionInitialized === true) return true;
    const reason =
      `unidentified caller (chat ${chatId}) may not "${frameType}": this socket has not completed ` +
      `session_init, so it presents no identity this instance issued`;
    getLoggerSafe().warn("[WebChannel] instance access refused", {
      surface: "instance:control" satisfies InstanceSurface,
      code: "deny:unidentified",
      chatId,
      frameType,
      reason,
    });
    this.sendToClient(chatId, { type: "text", text: `Refused: ${reason}`, messageId: randomUUID() });
    return false;
  }

  /**
   * ROUND 13 #11 — the same powers, typed instead of framed.
   *
   * THE DEFECT. Every owner-only power also has a chat command, and
   * `{type:"message",text:"/daemon stop"}` is not a control frame: it went
   * straight to the channel-agnostic command handler, which knows nothing about
   * web identities and called `heartbeatLoopRef.stop()`. `provider_switch` was
   * gated and `/model pin …` was not; `autonomous_toggle` was gated and
   * `/autonomous on` was not; the WS `cancel_task` checked task ownership and
   * `/cancel <someone else's task>` did not.
   *
   * So the gate sits where every typed line passes, and uses the SAME model and
   * the same detector the dispatcher does (`detectCommand` →
   * `commandPrivilege`), rather than a second list of strings to drift from it.
   * Reads stay open: `/daemon status`, `/model list`, `/status` are a guest's
   * business.
   */
  private async allowChatCommand(chatId: string, text: string): Promise<boolean> {
    const parsed = detectCommand(text);
    if (parsed.type !== "command") return true;
    const privilege = commandPrivilege(parsed.command, parsed.args);
    if (privilege.kind === "open") return true;
    const what = `/${parsed.command} ${parsed.args.join(" ")}`.trim();

    // ROUND 14 #4: the same requirement the control FRAMES have. Round 13 closed
    // the frames and the model, and left this gap between them: on an instance
    // with no owner recorded, `allow:sole-identity` admitted a privileged command
    // typed by a socket that had never identified itself, while the equivalent
    // `monitor:pause` frame from that same socket was refused. One power must not
    // have two answers depending on the shape the caller chose.
    if (!this.hasInitializedSession(chatId, what)) return false;

    if (privilege.kind === "task") {
      // The command names ONE task: the question is whose it is, exactly as for
      // the dedicated control frames. The classifier says which argument it is —
      // `/goal cancel <id>` names it second (round 14 #3).
      const safeTaskId = /^[a-zA-Z0-9_-]+$/.test(privilege.taskId) ? privilege.taskId : "";
      if (!safeTaskId) return true; // not a task id at all — the handler will say so
      return await this.checkMonitorTaskOwnership(safeTaskId, chatId, `command ${what}`);
    }
    return this.allowWsAction(privilege.surface, chatId, { what });
  }

  /**
   * Gate a WS control message on `surface`. On refusal the client is told which
   * identity was refused and why, and the handler must `break`.
   */
  private allowWsAction(
    surface: InstanceSurface,
    chatId: string,
    opts: { resource?: InstanceResource; what?: string } = {},
  ): boolean {
    const facts = this.instanceFacts();
    const decision = this.decide(surface, this.actorForChat(chatId, facts), { ...opts, facts });
    if (decision.allowed) return true;
    this.sendToClient(chatId, {
      type: "text",
      text: `Refused: ${decision.reason}`,
      messageId: randomUUID(),
    });
    return false;
  }

  /**
   * Audit 13F5 / plan 4.7 — whether a monitor frame stamped with `origin` may
   * reach the client of `profileId`.
   *
   * The workspace bus is process-wide and this channel fans every frame out to
   * every socket, so before this every portal profile saw every other profile's
   * monitor traffic: its DAG, its Kanban cards and the request text those cards
   * are labelled with. The monitor bridge now stamps each frame with the
   * conversation scope it was emitted under; for the web channel that scope IS
   * the profileId (handleWsMessage sends `conversationId: client.profileId`).
   *
   * The rule, and why it is exactly this narrow — a stricter one would blank
   * boards that legitimately belong to everyone:
   *   - no origin ⇒ not attributable (canvas, code, budget, supervisor frames
   *     that carry no scope): broadcast, as before;
   *   - origin === the recipient's own profile ⇒ theirs;
   *   - origin is some OTHER identity this channel issued ⇒ it is another
   *     profile's private traffic, withheld;
   *   - origin is not a web profile at all (a Telegram chat id, a CLI or daemon
   *     scope) ⇒ nobody's private traffic, so it stays visible. The portal is
   *     still the operator's window onto the other channels' activity.
   *
   * Chosen over an "admin profile that sees everything": the instance owner
   * configures and controls the instance (plan 6.14) but is deliberately given
   * no power to read another identity's boards, so "shared instance" never
   * means "the operator reads everyone's chat".
   *
   * Since plan 6.14 the rule is stated by the instance-access model
   * (`monitor:frames`, scope own-identity) rather than inline here: an origin
   * that is another identity on this instance is that identity's own traffic,
   * and an origin belonging to nobody here is nobody's private traffic.
   */
  private monitorFrameVisibleTo(origin: string | undefined, profileId: string, facts?: InstanceFacts): boolean {
    if (origin === undefined) return true;
    if (origin === profileId) return true;
    const instance = facts ?? this.instanceFacts();
    // Only an origin this channel issued names an identity to be separated from;
    // anything else (a Telegram chat id, a CLI scope) is nobody's private traffic.
    const resource: InstanceResource = this.isIssuedProfileId(origin) ? { profileId: origin } : {};
    // The socket's scope is always named, even before session_init (where it is
    // the chatId): a frame belonging to SOME identity is never handed to a
    // different scope, whether or not a second identity exists yet.
    const actor: InstanceActor = {
      role: instanceRoleOf(profileId, instance, (candidate) => this.isIssuedProfileId(candidate)),
      profileId,
    };
    return decideInstanceAccess({ surface: "monitor:frames", actor, resource, instance }).allowed;
  }

  /**
   * True when `candidate` is a profile id THIS channel issued. A store error is
   * reported as "yes, a profile" so the visibility rule fails CLOSED (the frame
   * is withheld) rather than leaking on a lookup failure.
   */
  private isIssuedProfileId(candidate: string): boolean {
    try {
      return this.identityStore.has(candidate);
    } catch {
      return true;
    }
  }

  /**
   * The frame list an incremental monitor frame belongs to: its own root when present, else the
   * most-recently-opened root, else a freshly-opened default bucket — so a pre-dag_init incremental
   * (a degenerate ordering) is still retained for replay, matching the prior flat-cache behavior.
   */
  private resolveIncrementalRoot(rootId: string | undefined): string[] {
    const own = rootId ? this.lastMonitorSnapshotByRoot.get(rootId) : undefined;
    if (own) return own;
    const recent = this.lastMonitorRootKey
      ? this.lastMonitorSnapshotByRoot.get(this.lastMonitorRootKey)
      : undefined;
    if (recent) return recent;
    const fresh: string[] = [];
    this.lastMonitorSnapshotByRoot.set(WebChannel.DEFAULT_MONITOR_ROOT, fresh);
    this.lastMonitorRootKey = WebChannel.DEFAULT_MONITOR_ROOT;
    return fresh;
  }

  /**
   * Replay cached monitor state to a single WebSocket client.
   * Called after session init so reconnecting clients see the current DAG. Replays EVERY retained
   * root's board (insertion order) — the frontend store keys by rootId, so cross-root ordering is
   * irrelevant; within a root, index 0 (dag_init) precedes its incrementals.
   */
  private replayMonitorState(ws: WebSocket, profileId: string): void {
    const facts = this.instanceFacts();
    for (const frames of this.lastMonitorSnapshotByRoot.values()) {
      for (const msg of frames) {
        if (ws.readyState !== 1) return;
        // 13F5 / 4.7: the cache is process-wide, so replay applies the same
        // per-profile boundary as the live fan-out. Without this a reconnecting
        // profile was handed EVERY retained root's board, including the ones a
        // live broadcast would already have withheld.
        if (!this.monitorFrameVisibleTo(this.frameOrigin(msg), profileId, facts)) continue;
        try {
          ws.send(msg);
        } catch {
          return; // Connection lost during replay
        }
      }
    }
  }

  /** The `origin` stamped on a cached monitor frame, or undefined. */
  private frameOrigin(message: string): string | undefined {
    try {
      const parsed = JSON.parse(message) as { origin?: unknown };
      return typeof parsed.origin === "string" ? parsed.origin : undefined;
    } catch {
      return undefined;
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

  /**
   * Did this markdown actually LEAVE, or is it only queued for the next
   * reconnect?
   *
   * `sendMarkdown` resolves either way, so a delivery report produced while
   * the browser was offline was recorded as delivered — and a restart or a
   * reconnect expiry then removed it, with nobody having read it (Codex
   * 2026-09-13 AG#13). A caller that records "the person was told" asks this
   * instead.
   */
  async sendMarkdownDelivered(chatId: string, markdown: string): Promise<boolean> {
    const instinctIds = this.appliedInstinctIds.get(chatId);
    return this.sendToClient(chatId, {
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
    // Mirror sendTypingIndicator's shape exactly (apart from the active flag);
    // the previous `messageId: ""` was meaningless noise and a latent footgun
    // for any client that dedupes/routes off messageId.
    this.sendToClient(chatId, { type: "typing", active: false });
  }

  /**
   * Deliver a file to the portal (2026-09-10). Until now this sent the text
   * "[Attachment: name]" and nothing else, so a gameplay frame, a HOW_TO_RUN or
   * a recording never reached the web chat. The file is registered under a
   * one-time token and served by GET /attachments/<token>; the chat receives a
   * markdown link (an image inline) that the client renders. Only files the
   * daemon holds — a local path or bytes — ever travel; nothing is fetched
   * from a URL on anyone's say-so.
   */
  async sendAttachment(chatId: string, attachment: Attachment): Promise<void> {
    const token = this.registerAttachment(attachment, chatId);
    if (token === null) {
      this.sendToClient(chatId, {
        type: "text",
        text: `[Attachment: ${attachment.name} — not deliverable: it names neither a local file nor bytes]`,
        messageId: randomUUID(),
      });
      return;
    }
    // Plan 6.14: the link is scoped to the identity it is delivered to. A
    // browser cannot put a profile header on an `<img src>`, so the href itself
    // carries the owner's proof; a guest holding the bare token has none.
    const href = `/attachments/${token}${this.attachmentLinkSuffix(token)}`;
    const size = typeof attachment.size === "number" ? ` (${(attachment.size / 1024).toFixed(0)} KB)` : "";
    const kind = attachment.type === "image" ? "image" : "file";
    // The markdown text every existing renderer already handles stays as the
    // fallback (audit 11.1 / D31: a "text" frame arrived as literal markup).
    const text = kind === "image"
      ? `![${attachment.name}](${href})\n[${attachment.name}](${href})${size}`
      : `📎 [${attachment.name}](${href})${size}`;
    // A STRUCTURED FRAME (plan 2.8): the client no longer parses a markdown
    // link to learn what arrived — name, href, kind, mime type and size are
    // fields, and text is the fallback rendering.
    this.sendToClient(chatId, {
      type: "attachment",
      messageId: randomUUID(),
      name: attachment.name,
      href,
      kind,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(typeof attachment.size === "number" ? { sizeBytes: attachment.size } : {}),
      text,
    });
  }


  private static readonly ATTACHMENT_TTL_MS = 24 * 60 * 60_000;
  private static readonly MAX_SERVED_ATTACHMENTS = 200;

  /** Register a local file or bytes; null when the attachment names neither. */
  private registerAttachment(attachment: Attachment, chatId?: string): string | null {
    const localPath = attachment.url && /^(?:\/|[A-Za-z]:[\\/])/.test(attachment.url) ? attachment.url : undefined;
    if (!localPath && !attachment.data) return null;
    // The owning identity goes on the ROW (plan 6.14), so the link means the
    // same thing in the next process as it does in this one.
    const ownerProfileId = chatId ? this.chatOwnerProfileId(chatId) : undefined;
    return this.attachmentStore.register({
      name: attachment.name,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(localPath ? { path: localPath } : {}),
      ...(attachment.data ? { data: attachment.data } : {}),
      ...(chatId ? { chatId } : {}),
      ...(ownerProfileId ? { ownerProfileId } : {}),
    });
  }

  /** The identity behind a chat, when it is one this channel issued. */
  private chatOwnerProfileId(chatId: string): string | undefined {
    const profileId = this.clients.get(chatId)?.profileId ?? this.profileByChat.get(chatId);
    return profileId && this.isIssuedProfileId(profileId) ? profileId : undefined;
  }

  /**
   * The query suffix that proves who owns `token` (`?v=…`), read from the row
   * the registration just wrote. Empty when the row records no owner (a
   * daemon-side chat that never completed session_init): such an attachment is
   * unattributable, which the model refuses on a shared instance rather than
   * granting to whoever asks.
   */
  private attachmentLinkSuffix(token: string): string {
    const ownerProfileId = this.attachmentStore.ownerProfileIdOf(token);
    if (!ownerProfileId) return "";
    return `?v=${this.attachmentLinkSignature(token, ownerProfileId)}`;
  }

  /**
   * HMAC binding an attachment token to the identity it was delivered to, under
   * the key the attachment store keeps beside its rows — so a link minted before
   * a restart still verifies after it.
   */
  private attachmentLinkSignature(token: string, profileId: string): string {
    this.linkScopeKeyCache ??= this.attachmentStore.linkScopeKey();
    return createHmac("sha256", this.linkScopeKeyCache)
      .update(`${token}\u0000${profileId}`)
      .digest("base64url");
  }

  /**
   * Who may GET this attachment (plan 6.14, surface `attachment:read`). The
   * owning identity is the one recorded ON THE ROW at delivery — durable, so the
   * answer no longer depends on when the daemon last booted, and a row with no
   * owner reads as unattributable (refused on a shared instance) rather than as
   * "anyone may read it";
   * the request proves it either with the signed link this server handed to
   * that identity's socket, or with the profile headers a non-browser caller
   * can send. A verified identity that is NOT the owner is refused even when it
   * presents a valid signature, so a leaked link stops working for anyone who
   * has an identity of their own.
   */
  private decideAttachmentAccess(req: HttpReq | undefined, token: string, query: string): AccessDecision {
    const facts = this.instanceFacts();
    const owner = this.attachmentStore.ownerProfileIdOf(token);
    const headerProfileId = req ? this.getSingleHeader(req.headers["x-strada-profile-id"]) : undefined;
    const headerToken = req ? this.getSingleHeader(req.headers["x-strada-profile-token"]) : undefined;
    const verifiedHeaderProfile =
      headerProfileId && headerToken && this.identityStore.verify(headerProfileId, headerToken)
        ? headerProfileId
        : undefined;

    const presented = new URLSearchParams(query).get("v") ?? "";
    const signatureNamesOwner =
      owner !== undefined &&
      presented.length > 0 &&
      this.safeTokenEquals(presented, this.attachmentLinkSignature(token, owner));

    // The actor: a verified header identity if one was sent, else the identity
    // the signed link names, else nobody.
    const actorProfileId = verifiedHeaderProfile ?? (signatureNamesOwner ? owner : undefined);
    const actor = this.actorFor(actorProfileId, undefined, facts);
    return this.decide("attachment:read", actor, {
      facts,
      what: token,
      ...(owner ? { resource: { profileId: owner } } : {}),
    });
  }

  /** GET /attachments/<token> — the registered file, or 404. */
  private async serveAttachment(
    res: ServerResponse,
    token: string,
    query: string = "",
    req?: HttpReq,
  ): Promise<void> {
    const access = this.decideAttachmentAccess(req, token, query);
    if (!access.allowed) {
      // 403, not 404: the refusal names the identity that was refused, so a
      // shared instance can be debugged instead of silently losing files.
      res.writeHead(403, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json", ...WebChannel.NO_CACHE_HEADERS });
      res.end(JSON.stringify({ error: "Forbidden", reason: access.reason, surface: access.surface, code: access.code }));
      return;
    }
    const entry = this.attachmentStore.get(token);
    if (!entry) {
      res.writeHead(404, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const contentType = entry.mimeType ?? MIME_TYPES[extname(entry.name).toLowerCase()] ?? "application/octet-stream";
    const disposition = `${contentType.startsWith("image/") ? "inline" : "attachment"}; filename="${entry.name.replace(/["\\\r\n]/g, "_")}"`;
    if (entry.data) {
      res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": contentType, "Content-Length": String(entry.data.length), "Content-Disposition": disposition, ...WebChannel.NO_CACHE_HEADERS });
      res.end(entry.data);
      return;
    }
    // A by-reference record (a file too large to snapshot — since round 10 #2 the
    // store's own immutable copy of it) is served from ONE verified file
    // descriptor: same size, same SHA-256, no symlink, and the bytes streamed
    // out of the very fd those checks were made on. Checking a path and then
    // opening it again was a race — a file replaced in between was streamed
    // under the verified length — and before round 9 #24 the path was not
    // checked at all.
    const open = this.attachmentStore.openStoredFile(entry);
    if (open) {
      res.writeHead(200, {
        ...WebChannel.SECURITY_HEADERS,
        "Content-Type": contentType,
        "Content-Length": String(open.sizeBytes),
        "Content-Disposition": disposition,
        ...WebChannel.NO_CACHE_HEADERS,
      });
      // The stream owns the fd from here (autoClose), including on a client
      // that hangs up mid-download.
      await pipeline(createReadStream("", { fd: open.fd, start: 0, autoClose: true }), res);
      return;
    }
    res.writeHead(404, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const confirmId = randomUUID();

    const delivered = this.sendToClient(req.chatId, {
      type: "confirmation",
      confirmId,
      question: req.question,
      options: req.options,
      details: req.details,
    });

    // If there is no live socket the confirmation prompt was never delivered;
    // registering a 5-minute pending entry would block the awaiting orchestrator
    // for the full timeout with no way for the (absent) user to respond. Resolve
    // immediately with the non-approving "timeout" sentinel that callers already
    // treat as "do not proceed".
    if (!delivered) {
      getLoggerSafe().debug("requestConfirmation: no live client; resolving as timeout", {
        chatId: req.chatId,
      });
      return "timeout";
    }

    return new Promise<string>((done) => {
      const timer = setTimeout(
        () => {
          this.pendingConfirmations.delete(confirmId);
          done("timeout");
          // Codex wave 0-A review 2026-09-17 #6: tell the client the question
          // is dead so a dialog still waiting on its ack is released. The
          // frame is replayable, so an offline client gets it on reconnect.
          this.sendToClient(req.chatId, { type: "confirmation_ack", confirmId, status: "unknown" });
        },
        WebChannel.CONFIRMATION_TTL_MS,
      );

      this.pendingConfirmations.set(confirmId, { resolve: done, timer, chatId: req.chatId });
    });
  }

  /** Remember an answered confirmation so a re-sent reply is acked idempotently. */
  private recordSettledConfirmation(confirmId: string, chatId: string, option: string): void {
    const now = Date.now();
    for (const [id, entry] of this.settledConfirmations) {
      if (entry.expiresAt <= now) this.settledConfirmations.delete(id);
    }
    while (this.settledConfirmations.size >= WebChannel.MAX_SETTLED_CONFIRMATIONS) {
      const oldest = this.settledConfirmations.keys().next().value;
      if (oldest === undefined) break;
      this.settledConfirmations.delete(oldest);
    }
    this.settledConfirmations.set(confirmId, { chatId, option, expiresAt: now + WebChannel.CONFIRMATION_TTL_MS });
  }

  private getSettledConfirmation(confirmId: string): SettledConfirmation | undefined {
    const entry = this.settledConfirmations.get(confirmId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.settledConfirmations.delete(confirmId);
      return undefined;
    }
    return entry;
  }

  async startStreamingMessage(chatId: string): Promise<string | undefined> {
    const streamId = randomUUID();
    this.streamSentTexts.set(streamId, "");
    this.streamChatIds.set(streamId, chatId);
    this.sendToClient(chatId, { type: "stream_start", streamId, text: "" });
    return streamId;
  }

  async updateStreamingMessage(
    chatId: string,
    streamId: string,
    accumulatedText: string,
  ): Promise<void> {
    // A delta only when the new text extends what the client has; a replaced
    // status line, or a stream whose state a disconnect dropped, is sent whole
    // as `text` so the client replaces instead of appending (WEB-2).
    const update = nextStreamUpdate(this.streamSentTexts.get(streamId), accumulatedText);
    if (!update) return; // Nothing new to send
    if (this.sendToClient(chatId, { type: "stream_update", streamId, ...update })) {
      this.streamSentTexts.set(streamId, accumulatedText);
    } else {
      // Not delivered (stream frames are not buffered): the next update must
      // not be a delta against text the client never got.
      this.streamSentTexts.delete(streamId);
    }
  }

  async finalizeStreamingMessage(
    chatId: string,
    streamId: string,
    finalText: string,
  ): Promise<void> {
    this.streamSentTexts.delete(streamId);
    this.streamChatIds.delete(streamId);
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
      "script-src 'self' https://cdn.jsdelivr.net blob: 'sha256-j7tZRAs1sYPSt7kkaOUXN3/joaG0F8R/arqlxeLc/50='; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*; " +
      "img-src 'self' data: blob:; " +
      "font-src 'self' data: https://cdn.jsdelivr.net; " +
      // 'self': the bundler emits the portal's module workers (speech-to-text,
      // graph layout) as same-origin asset URLs, not blob: ones (WEB-4).
      "worker-src 'self' blob:; " +
      "object-src 'none'; " +
      "base-uri 'none'; " +
      "frame-ancestors 'none';",
  };
  private static readonly NO_CACHE_HEADERS: Record<string, string> = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  };

  private async serveBuildStatus(req: HttpReq, res: ServerResponse, url: string): Promise<void> {
    const headers = { ...WebChannel.SECURITY_HEADERS, ...WebChannel.NO_CACHE_HEADERS, "Content-Type": "application/json" };
    if ((req.method ?? "GET") !== "GET") {
      res.writeHead(405, headers);
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    // CHN-8: this route is answered before the proxy, so it applies the
    // proxy's GET rule itself — a page on another origin may not drive it.
    if (!this.isAllowedGetProxyRequest(req)) {
      res.writeHead(403, headers);
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }
    const provider = this.buildStatusProvider;
    if (!provider) {
      res.writeHead(503, headers);
      res.end(JSON.stringify({ error: "Build status is not available: no campaign layer is registered on this channel." }));
      return;
    }
    const query = url.split("?")[1] ?? "";
    const measure = /(^|&)measure=(1|true)(&|$)/.test(query);
    try {
      // The measurement walks the project tree: never more than one at a time.
      const status = measure
        ? await this.measuredBuildStatus.run(() => provider({ measure: true }))
        : await provider({ measure: false });
      res.writeHead(200, headers);
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, headers);
      res.end(JSON.stringify({ error: `Build status failed: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  private async handleHttp(req: HttpReq, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    getLoggerSafe().debug("[WebChannel] handleHttp", { url, method: req.method });

    // CHN-2: a Host this portal does not answer for is refused before any
    // route — loopback binding alone does not stop a rebound page, and the
    // proxy below adds the dashboard token to what it forwards.
    if (!this.acceptsHost(req)) {
      rejectDisallowedHost(res, WebChannel.SECURITY_HEADERS);
      return;
    }
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

    // Measured build status — served in-daemon (the dashboard process has no
    // campaign or guardian), so it is answered before the /api/ proxy below.
    if (url === "/api/campaign" || url.startsWith("/api/campaign?")) {
      await this.serveBuildStatus(req, res, url);
      return;
    }

    // A file the daemon handed to this chat (see sendAttachment).
    if (req.method === "GET" && url.startsWith("/attachments/")) {
      const rest = url.slice("/attachments/".length);
      const queryStart = rest.indexOf("?");
      const attachmentToken = queryStart >= 0 ? rest.slice(0, queryStart) : rest;
      const attachmentQuery = queryStart >= 0 ? rest.slice(queryStart + 1) : "";
      await this.serveAttachment(res, attachmentToken, attachmentQuery, req);
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
      // createReadStream does NOT throw synchronously on ENOENT — it emits
      // `error` later — so the previous try/catch around it never caught a
      // missing file: the 200 was already committed, pipeline tore the socket,
      // and every deep link / refresh on a BrowserRouter route (/setup,
      // /admin/*) died with ERR_EMPTY_RESPONSE while the SPA fallback below
      // was unreachable. Probe with stat() BEFORE committing a status so a
      // missing (or non-file) path falls through as intended (audited 2026-09-02).
      if (await this.isServableFile(candidate)) {
        const ext = extname(candidate);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": contentType });
        await pipeline(createReadStream(candidate), res).catch(() => undefined);
        return;
      }
      // Not a file on disk — fall through to SPA fallback
    }

    // SPA fallback: serve index.html for all non-file routes (client-side routing)
    const indexPath = join(this.staticDir, "index.html");
    if (await this.isServableFile(indexPath)) {
      res.writeHead(200, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      await pipeline(createReadStream(indexPath), res).catch(() => undefined);
      return;
    }
    getLoggerSafe().warn("Web channel: portal index.html missing — cannot serve SPA route", {
      url: rawSegment,
      staticDir: this.staticDir,
    });
    res.writeHead(404, WebChannel.SECURITY_HEADERS);
    res.end("Not Found");
  }

  /** True when `path` exists and is a regular file (the only thing the static branch may stream). */
  private async isServableFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
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
      isAlive: true,
      sessionInitialized: false,
    };
    this.clients.set(chatId, client);

    // Mark live on each pong. Bind to the stable `client` object (not chatId,
    // which can be reassigned on session_init / reconnect re-keying).
    ws.on("pong", () => { client.isAlive = true; });

    // Note: A temporary 'connected' event is sent immediately, then replaced
    // by the full 'connected' event after session_init with profileId/language.
    this.sendJson(ws, { type: "connected", chatId, reconnectToken: client.reconnectToken });

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;

        if (!assignedId && (data.type === "session_init" || data.type === "reconnect")) {
          const initialized = this.initializeSession(ws, client, data);
          chatId = initialized.chatId;
          assignedId = true;
          return;
        }
        assignedId = true;

        await this.handleWsMessage(chatId, data);
      } catch (err) {
        // SyntaxError = truly malformed JSON — ignore silently (was the
        // original intent). Anything else is an async throw from
        // handleWsMessage (ownership check, verify handler, etc.) and
        // must be visible so silent failures stop being silent.
        if (!(err instanceof SyntaxError)) {
          getLoggerSafe().warn("WebSocket message handler error", {
            chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    const handleDisconnect = () => {
      // During shutdown the maps have already been cleared by disconnect();
      // skip so a late async 'close'/'error' can't repopulate recentlyDisconnected.
      if (this.shuttingDown) return;
      const current = this.clients.get(chatId);
      if (current && current.ws === ws) {
        this.clients.delete(chatId);
        // Allow reconnect within TTL window; carry rate-limit state
        this.recentlyDisconnected.set(chatId, {
          disconnectedAt: Date.now(),
          reconnectToken: current.reconnectToken,
          msgCount: current.msgCount,
          windowStart: current.windowStart,
          // The identity parks with the session (round 13 #12).
          profileId: current.profileId,
        });

        // Clean up per-session state that would otherwise leak
        this.appliedInstinctIds.delete(chatId);
        for (const [sid, cid] of this.streamChatIds) {
          if (cid === chatId) {
            this.streamSentTexts.delete(sid);
            this.streamChatIds.delete(sid);
          }
        }
        // Pending confirmations are deliberately NOT cancelled here. A
        // disconnect is usually transient and the chatId can be reclaimed
        // within RECONNECT_TTL_MS; the prompt keeps its own 5-minute window
        // (requestConfirmation) and only that expiry resolves it "timeout".
        // Cancelling on disconnect made an answer given during a reconnect
        // land on nothing while the client believed it was delivered
        // (Codex review of 0-A.26).
      }
    };

    ws.on("close", handleDisconnect);
    ws.on("error", handleDisconnect);
  }

  /**
   * May `profileId` take over chat `chatId` (plan 6.14, surface chat:frames)?
   * Yes while the chat belongs to no identity this process has seen, or to this
   * very identity; no when it belongs to another one — the reclaim is dropped
   * and the caller keeps its fresh chat instead of inheriting a stranger's
   * replayed board and buffered answers.
   */
  private mayReclaimChat(chatId: string, profileId: string): boolean {
    // ROUND 13 #12: OWNERSHIP OUTLIVES THE BINDING.
    //
    // `profileByChat` is a 500-entry LRU and this read used to treat a MISSING
    // entry as "belongs to nobody, help yourself". On a busy instance 500 newer
    // chats evict an ACTIVE chat's binding, and any profile holding that chat's
    // reconnect token then displaced its owner and inherited the chat — the
    // board replayed on reclaim and the answers buffered for it. The session
    // itself carries the identity, so ask the session first: a live client's
    // profileId, then the parked one a disconnected session kept, and only then
    // the LRU's memory of it.
    // Only an issued identity counts: before `session_init` a client's
    // profileId is its own chatId, which owns nothing.
    const issuedOnly = (candidate: string | undefined): string | undefined =>
      candidate && this.isIssuedProfileId(candidate) ? candidate : undefined;
    const recorded =
      issuedOnly(this.clients.get(chatId)?.profileId)
      ?? issuedOnly(this.recentlyDisconnected.get(chatId)?.profileId)
      ?? this.profileByChat.get(chatId);
    if (recorded === profileId) return true;
    // No identity has ever owned this chat (a socket that talked without ever
    // completing session_init). There is no identity's traffic to be separated
    // from, and the chat's reconnect token — which `tryReclaimSession` still
    // demands — is that chat's own credential, so the reclaim stands.
    if (recorded === undefined) return true;
    const facts = this.instanceFacts();
    // The actor names no chatId here: the chat in question is the RESOURCE, and
    // an actor carrying it would match itself.
    return this.decide("chat:frames", this.actorFor(profileId, undefined, facts), {
      facts,
      resource: { profileId: recorded },
      what: `chat ${chatId}`,
    }).allowed;
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
        // A dedicated code, not 1000: the portal auto-reconnects on a normal
        // close, so two tabs sharing one reconnect token took the chat from
        // each other every second, forever (WEB-1).
        activeSession.ws.close(WS_CLOSE_SESSION_TAKEN, WS_CLOSE_SESSION_TAKEN_REASON);
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

    // The identity is resolved BEFORE the reclaim (plan 6.14): a reconnect token
    // is a CHAT credential, a profile token an IDENTITY one, and the chat's
    // replayed board plus its buffered answers belong to the identity that owns
    // the chat. Reclaiming chat X while authenticating as a different identity
    // would hand X's history to whoever holds only X's chat token.
    const identity = this.resolveWebIdentity(data);
    client.profileId = identity.profileId;
    // From here this socket has an identity this channel issued (round 13 #9).
    client.sessionInitialized = true;

    let chatId = client.chatId;
    let reconnectToken = client.reconnectToken;
    if (requestedChatId && requestedReconnectToken && this.mayReclaimChat(requestedChatId, identity.profileId)) {
      const reclaimed = this.tryReclaimSession(client, requestedChatId, requestedReconnectToken);
      if (reclaimed) {
        chatId = reclaimed.chatId;
        reconnectToken = reclaimed.reconnectToken;
      }
    }
    // Remember which identity owns this chat past its disconnect, so anything
    // produced for the chat while the browser is away is still attributable to
    // an identity (plan 6.14).
    this.profileByChat.set(chatId, identity.profileId);
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
    // (their own boards only — 13F5 / 4.7).
    this.replayMonitorState(ws, identity.profileId);

    // Flush any answer frames that were buffered while this chat had no live
    // socket (e.g. a background final that arrived offline). Client dedups by
    // messageId so frames already received live are not re-rendered.
    this.flushPendingDelivery(chatId, ws);

    void this.consumePostSetupBootstrap({ chatId, profileId: identity.profileId, profileToken: identity.profileToken });

    // The measured build status, so a fresh portal shows the campaign without
    // waiting for the next notice.
    if (this.buildStatusProvider) {
      void this.buildStatusProvider({ measure: false })
        .then((status) => this.sendJson(ws, { type: "campaign:status", payload: status, timestamp: Date.now() }))
        .catch((err: unknown) => {
          getLoggerSafe().warn("[WebChannel] build status push failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    return { chatId, reconnectToken };
  }

  private async handleWsMessage(chatId: string, data: Record<string, unknown>): Promise<void> {
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
        // Let the 'close' handler (handleDisconnect) own teardown — it deletes the
        // client AND runs per-chat cleanup (appliedInstinctIds, recentlyDisconnected,
        // streams, pendingConfirmations). Deleting here first made handleDisconnect's
        // `clients.get(chatId) === ws` guard fail, skipping all of that cleanup.
        client.ws.close(WS_CLOSE_POLICY_VIOLATION, "Rate limit exceeded");
        return;
      }
    }

    // ROUND 13 #9: a frame that ACTS needs a socket that said who it is.
    if (WebChannel.SESSION_REQUIRED_WS_TYPES.has(String(data.type)) && !this.hasInitializedSession(chatId, String(data.type))) {
      return;
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

            // Require decodable bytes for every non-URL attachment. An object
            // declaring name/mimeType with no `data` field would otherwise fall
            // back to a client-claimed `raw.size` and skip the magic-byte check,
            // letting an unvalidated/spoofed attachment through. Derive size
            // ONLY from the decoded bytes — never trust raw.size.
            if (!buf || buf.length === 0) {
              this.sendToClient(chatId, {
                type: "text",
                text: `File "${raw.name || 'attachment'}" was rejected: unsupported format or invalid content.`,
                messageId: randomUUID(),
              });
              continue;
            }
            const size = buf.length;

            // Validate before accepting
            const attachType = mimeType.startsWith("image/") ? "image"
              : mimeType.startsWith("video/") ? "video"
              : mimeType.startsWith("audio/") ? "audio" : "file";
            const validation = validateMediaAttachment({ mimeType, size, type: attachType });
            if (!validation.valid) {
              // Say which limit it hit ("... exceeds 10MB limit"): the generic
              // "unsupported format" was wrong for a file that is only too big.
              this.sendToClient(chatId, {
                type: "text",
                text: `File "${raw.name || 'attachment'}" was rejected: ${validation.reason ?? "unsupported format or invalid content"}.`,
                messageId: randomUUID(),
              });
              continue;
            }
            if (!validateMagicBytes(buf, mimeType)) {
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
        // ROUND 13 #11: a privileged command typed as chat text is the same
        // power as the control frame, and is authorized the same way.
        if (normalizedText && !(await this.allowChatCommand(chatId, normalizedText))) {
          break;
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
        if (!pending) {
          // Already answered (the client lost our ack and re-sent the reply):
          // ack it again, idempotently — but only the identical reply from the
          // chat that settled it. A different option, or another chat, did not
          // reach the orchestrator and must not be told it did (Codex wave 0-A
          // review 2026-09-17 #6; Codex 2026-09-17 round 3 #5).
          const settled = this.getSettledConfirmation(confirmId);
          if (settled !== undefined && settled.chatId === chatId && settled.option === option) {
            this.sendToClient(chatId, { type: "confirmation_ack", confirmId, status: "accepted" });
            break;
          }
          // Expired (5-minute window) or never ours: say so instead of
          // ignoring it, so the client can stop showing the answer as sent.
          this.sendToClient(chatId, { type: "confirmation_ack", confirmId, status: "unknown" });
          break;
        }
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
        this.recordSettledConfirmation(confirmId, chatId, option);
        pending.resolve(option);
        // The awaiting orchestrator has the answer: only now may the client
        // drop its dialog.
        this.sendToClient(chatId, { type: "confirmation_ack", confirmId, status: "accepted" });
        break;
      }

      case "provider_switch": {
        const provider = String(data.provider ?? "").trim();
        if (!provider || !this.handler) break;
        // Plan 6.14, surface instance:control — one daemon, one provider/model
        // selection. A guest switching it changes what EVERY identity on this
        // instance runs on (and what it costs the owner).
        if (!this.allowWsAction("instance:control", chatId, { what: `provider switch to ${provider}` })) break;
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
        // Plan 6.14, surface instance:control: autonomous mode is a property of
        // the daemon, not of one chat.
        if (!this.allowWsAction("instance:control", chatId, { what: `autonomous ${enabled ? "on" : "off"}` })) break;
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
        // Plan 6.14, surface task:control. The monitor:* commands have checked
        // task↔chat ownership since the CWE-639 fix; THIS handler did not, so a
        // guest on a shared instance could cancel the owner's named task from
        // the chat surface — the same power by the shorter route. A bare
        // /cancel (no taskId) still acts only on this chat's own active task.
        if (safeTaskId && !await this.checkMonitorTaskOwnership(safeTaskId, chatId, "cancel_task")) break;
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
        if (!await this.checkMonitorTaskOwnership(safeMove, chatId, "monitor:move_task")) break;
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
        if (!await this.checkMonitorTaskOwnership(safeRetry, chatId, "monitor:retry_task")) break;
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
        if (!await this.checkMonitorTaskOwnership(safeResume, chatId, "monitor:resume_task")) break;
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
        if (!await this.checkMonitorTaskOwnership(safeCancelBus, chatId, "monitor:cancel_task")) break;
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
      case "monitor:resume": {
        const payloadSize = JSON.stringify(data).length;
        if (payloadSize > MAX_CONTROL_MESSAGE_BYTES) break;
        // Plan 6.14, surface instance:control. Unlike every other monitor:*
        // command these name no task: they pause and resume the whole run, for
        // everyone. Owner-only.
        if (!this.allowWsAction("instance:control", chatId, { what: String(data.type) })) break;
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter(data.type as string, data);
        }
        break;
      }
      case "monitor:skip_task":
      case "monitor:approve_gate":
      case "monitor:reject_gate": {
        const payloadSize = JSON.stringify(data).length;
        if (payloadSize > MAX_CONTROL_MESSAGE_BYTES) break;
        const rawTaskId = typeof data.taskId === "string" ? data.taskId.trim() : "";
        const safeTaskId = /^[a-zA-Z0-9_-]+$/.test(rawTaskId) ? rawTaskId : "";
        if (!safeTaskId) {
          getLoggerSafe().warn(`${String(data.type)} rejected — invalid taskId`, { raw: rawTaskId });
          break;
        }
        if (!await this.checkMonitorTaskOwnership(safeTaskId, chatId, String(data.type))) break;
        if (this.workspaceBusEmitter) {
          this.workspaceBusEmitter(data.type as string, { ...data, taskId: safeTaskId });
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

        // Task ↔ chat ownership check. Blocks cross-chat spawn triggers
        // (CWE-639). Unknown/transient tasks allow-and-log so the portal's
        // ephemeral-task flow keeps working. Precedent: 6660012 fix(ws+monitor).
        const ownershipCheck = await this.checkVerifyTaskOwnership(safeTaskId, chatId);
        if (!ownershipCheck.allowed) {
          this.sendToClient(chatId, {
            type: "verify:check_result",
            taskId: safeTaskId,
            criterionId: safeCriterionId,
            status: "fail",
            // Plan 6.14: the refusal names the identity that was refused.
            error: `Refused: ${this.taskRefusalReason(safeTaskId, chatId, ownershipCheck.owner, "verify:check_criterion")}`,
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
        // Resolve cwd once up-front and verify package.json exists. CHN-9: the
        // cwd is the configured project (not the daemon's launch directory)
        // and the invocation is Windows-safe — see npm-check-command.ts.
        const spawnCwd = npmCheckCwd();
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
              error: "No package.json in the project directory — cannot run build/test.",
            });
            return;
          }
          const invocation = npmCheckInvocation(checkType === "build" ? "build" : "test");
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
            const child = cp.spawn(invocation.command, [...invocation.args], {
              shell: invocation.shell,
              windowsHide: true,
              cwd: spawnCwd,
              timeout: 30_000,
              killSignal: "SIGTERM",
              stdio: ["ignore", "pipe", "pipe"],
              // Pass through env minus inherited secrets we don't need for npm scripts.
              // npm requires PATH + HOME + USER; we drop API keys by default.
              env: this.buildVerifySpawnEnv(),
            });
            const killTimer = setTimeout(() => child.kill("SIGKILL"), 35_000);

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
              clearTimeout(killTimer);
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

        // Task ↔ chat ownership check — see verify:check_criterion above.
        // Reject cross-chat gate decisions so a hostile client can't approve
        // another user's pending supervisor gate (CWE-639).
        const gateOwnership = await this.checkVerifyTaskOwnership(safeTaskId, chatId);
        if (!gateOwnership.allowed) {
          this.sendToClient(chatId, {
            type: "verify:gate_ack",
            taskId: safeTaskId,
            accepted: false,
            supervisorVerdict: "invalid_request",
            // Plan 6.14: the refusal names the identity that was refused.
            reason: `Refused: ${this.taskRefusalReason(safeTaskId, chatId, gateOwnership.owner, "verify:gate_decision")}`,
          });
          break;
        }

        getLoggerSafe().info("verify:gate_decision received", {
          taskId: safeTaskId,
          verdict,
          noteLength: note.length,
        });
        // Forward the operator's verdict onto the workspace bus so the supervisor
        // verification subsystem (src/supervisor/supervisor-verification.ts) can
        // resolve the pending gate by taskId and apply it. The wiring of that
        // consumer lives outside this channel; when no consumer is attached the
        // decision is NOT enforced, so we must not pretend it was.
        //
        // Was `Boolean(this.workspaceBusEmitter)` — that measured "an emitter is
        // installed" (bootstrap always installs one), not "a consumer received
        // the verdict", so production acked every approval as enforced while
        // nothing subscribed to verify:gate_decision. Only an emitter that
        // reports a subscribed consumer counts as forwarded (audited 2026-09-02).
        let gateForwarded = false;
        if (this.workspaceBusEmitter) {
          gateForwarded = this.workspaceBusEmitter("verify:gate_decision", {
            type: "verify:gate_decision",
            taskId: safeTaskId,
            verdict,
            note,
          }) === true;
        }
        if (!gateForwarded) {
          getLoggerSafe().warn("verify:gate_decision has no consumer — verdict NOT enforced", {
            taskId: safeTaskId,
            verdict,
            emitterInstalled: Boolean(this.workspaceBusEmitter),
          });
        }
        this.sendToClient(chatId, {
          type: "verify:gate_ack",
          taskId: safeTaskId,
          // Only an explicit "approve" verdict that was actually forwarded for
          // enforcement is an acceptance — "request_changes"/"escalate" must
          // surface as a non-green banner, and an unforwarded decision must NOT
          // clear the pending banner as if it took effect.
          accepted: gateForwarded && verdict === "approve",
          supervisorVerdict: verdict,
          // Tells the frontend whether the verdict was actually routed for
          // enforcement; when false the pending gate is unresolved (no consumer
          // wired) and the UI should keep an explicit "not yet enforced" state
          // rather than transitioning out of the pending banner.
          enforced: gateForwarded,
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
        // ROUND 15 #1, THE SAME SHAPE ON THIS TRANSPORT. The frame carried a
        // client-named `sessionId` and this handler passed it on: a guest naming
        // the owner's session would have had the owner's canvas saved for it, the
        // way a body `id` retargeted the REST write. Nothing consumes this event
        // today, which is precisely why it is worth fixing now rather than after
        // something does.
        //
        // A canvas session IS the portal's profile id (useCanvasStore.setSessionId),
        // so the session that acts is the socket's own identity. A frame naming a
        // different one is refused rather than silently rewritten, so a portal that
        // disagrees with the server about who it is says so out loud.
        const saveSessionId = typeof data.sessionId === "string" ? data.sessionId : "";
        const safeSaveSession = /^[a-zA-Z0-9_-]+$/.test(saveSessionId) ? saveSessionId : "";
        if (!safeSaveSession) {
          getLoggerSafe().warn("canvas:save rejected — invalid sessionId", { raw: saveSessionId });
          break;
        }
        const ownSession = client?.profileId ?? chatId;
        if (safeSaveSession !== ownSession) {
          if (!this.allowWsAction("canvas:state", chatId, { resource: { profileId: safeSaveSession }, what: `canvas ${safeSaveSession}` })) break;
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

  /**
   * Send a JSON frame to the connected client for `chatId`.
   * Returns `false` when no live socket is available (client gone, never
   * connected, or socket not OPEN) so callers that need a delivery guarantee
   * — e.g. requestConfirmation — can react instead of silently blocking.
   */
  private sendToClient(chatId: string, data: Record<string, unknown>): boolean {
    const client = this.clients.get(chatId);
    if (!client || client.ws.readyState !== 1) {
      // Buffer answer-bearing frames so a final produced while the client is
      // offline survives to the next reconnect (flushed by flushPendingDelivery
      // next to replayMonitorState). Transient frames (typing/stream_*/etc) and
      // confirmations are intentionally NOT buffered.
      if (typeof data.type === "string" && WebChannel.REPLAYABLE_FRAME_TYPES.has(data.type)) {
        this.bufferPendingDelivery(chatId, data);
      } else if (!client) {
        getLoggerSafe().debug("sendToClient: no active WS client for chatId, response may be lost", { chatId, type: data.type });
      }
      return false;
    }
    this.sendJson(client.ws, data);
    return true;
  }

  /**
   * Append an undeliverable answer frame to the per-chat pending buffer, evicting
   * the oldest when the per-chat cap is reached (bounded growth).
   */
  private bufferPendingDelivery(chatId: string, data: Record<string, unknown>): void {
    const queue = this.pendingDelivery.get(chatId) ?? [];
    queue.push(data);
    if (queue.length > WebChannel.MAX_PENDING_DELIVERY_FRAMES) {
      queue.splice(0, queue.length - WebChannel.MAX_PENDING_DELIVERY_FRAMES);
    }
    this.pendingDelivery.set(chatId, queue);
  }

  /**
   * Flush + clear any frames buffered while `chatId` had no live socket onto the
   * (now reconnected) socket. The client dedups by messageId, so any frame the
   * client already received live is dropped client-side rather than re-rendered.
   */
  private flushPendingDelivery(chatId: string, ws: WebSocket): void {
    const queue = this.pendingDelivery.get(chatId);
    if (!queue || queue.length === 0) {
      return;
    }
    this.pendingDelivery.delete(chatId);
    for (const frame of queue) {
      if (ws.readyState !== 1) {
        break;
      }
      this.sendJson(ws, frame);
    }
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
    // Only adopt a legacy profileId that is NOT already registered. profileId is
    // a public value (sent to clients, stored in localStorage), so without this
    // guard an unauthenticated request supplying a known profileId would
    // overwrite that profile's token via issue()'s blind upsert — a profile
    // takeover. An already-claimed id must present a valid token (handled above);
    // otherwise fall back to a fresh identity.
    if (legacyProfileId && !this.identityStore.has(legacyProfileId)) {
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
    "/api/providers/models",
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
    "/api/vaults", // vault feature (Phase 1)
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
    // Vault register endpoint — POST creates a new codebase vault at runtime.
    // CSRF-protected via the same origin/referer/bearer check as other mutable
    // paths (isTrustedMutableProxyRequest). Dashboard layer then re-validates
    // name/path/realpath before touching disk.
    "/api/vaults",
  ]);

  /** Prefix-based mutable allowlist — POST/DELETE/PUT allowed for paths starting with these. */
  private static readonly MUTABLE_PROXY_PREFIXES: readonly string[] = [
    "/api/personality/profiles/",
    "/api/canvas", "/api/skills/",
    "/api/settings/", "/api/monitor/",
    // NOTE: change-review is NOT a prefix — see MUTABLE_PROXY_ROUTES. A
    // prefix made every suffix and every write method mutable (round 12 #11).
    // Vault mutations: POST /api/vaults/:id/{search,sync} and DELETE /api/vaults/:id.
    // search is read-only; sync re-indexes the internal SQLite store; DELETE
    // removes a registration but does NOT touch user files. No CSRF amplification
    // against the user's project. Root POST /api/vaults (register) is handled via
    // MUTABLE_PROXY_PATHS above.
    "/api/vaults/",
  ];

  /**
   * Writes authorized as an EXACT method + route, not a prefix.
   *
   * Codex round 12 #11: `/api/workspace/change-review/` as a prefix made every
   * descendant writable by POST, PUT and DELETE — the bare prefix, an id on its
   * own, arbitrary sub-paths. Only the one route the portal's accept/reject
   * actually calls may mutate; a new mutable route must be added here
   * deliberately, by name.
   */
  private static readonly MUTABLE_PROXY_ROUTES: readonly { readonly method: string; readonly pattern: RegExp }[] = [
    { method: "POST", pattern: /^\/api\/workspace\/change-review\/[A-Za-z0-9_.-]{1,128}\/decisions$/ },
  ];

  /**
   * A request path this proxy may reason about, or undefined.
   *
   * THE PATH WE CHECK MUST BE THE PATH THAT ACTS (Codex round 12 #11).
   * `/api/workspace/change-review/../../update` matched a mutable prefix and
   * then became `/api/update` downstream, so authorization and effect were
   * about two different routes. Rather than normalizing and hoping the
   * normalizations agree, anything that is not already canonical is refused:
   * dot segments, empty segments, backslashes, control characters, encoded
   * separators, and any percent-escape that does not decode.
   */
  private static canonicalProxyPath(pathOnly: string): string | undefined {
    if (!pathOnly.startsWith("/") || pathOnly.length > 2048) return undefined;
    if (pathOnly.includes("\\") || pathOnly.includes("//")) return undefined;
    for (const ch of pathOnly) {
      const code = ch.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f) return undefined;
    }
    if (/%(2e%2e|2f|5c|00)/i.test(pathOnly)) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathOnly);
    } catch {
      return undefined;
    }
    if (decoded.includes("\\") || decoded.includes("\0")) return undefined;
    for (const segment of decoded.split("/").slice(1)) {
      if (segment === "." || segment === "..") return undefined;
    }
    if (decoded.endsWith("/") && decoded !== "/") {
      // A trailing slash is a different route downstream; keep one meaning.
      return undefined;
    }
    return pathOnly;
  }

  private getSingleHeader(
    header: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(header) ? header[0] : header;
  }

  /**
   * True when `value` is an Origin/Referer this portal serves itself: a loopback
   * host on THIS channel's own port. Audit 13F6 / plan 4.8: the check used to
   * compare the hostname only, so `http://localhost:<any other port>` — a page
   * from any other process on the machine — was treated as the portal's own.
   */
  /**
   * The port this server is actually reachable on: the bound address once
   * listening, else the configured one. Port 0 means "any free port", so the
   * configured value is NOT the origin a browser would send — the self-origin
   * check (13F6 / 4.8) has to compare the bound port or it would refuse this
   * server's own page.
   */
  private get boundPort(): number {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address.port : this.port;
  }

  /**
   * The origins this portal is legitimately served from besides its bound port
   * (round 10 #19): the constructor option, else `WEB_TRUSTED_ORIGINS`. Parsed
   * once — an operator does not change it while the process runs — and every
   * entry must be a complete, parseable origin, so a typo ("localhost:5173"
   * without a scheme) is DROPPED rather than widening the check to a hostname.
   */
  private get trustedOrigins(): readonly string[] {
    if (this.trustedOriginsCache === undefined) {
      const configured =
        this.options.trustedOrigins ??
        (process.env["WEB_TRUSTED_ORIGINS"] ?? "").split(",");
      this.trustedOriginsCache = configured
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && normalizeOrigin(entry) !== undefined);
    }
    return this.trustedOriginsCache;
  }
  private trustedOriginsCache: readonly string[] | undefined;

  /**
   * Whether an Origin/Referer may talk to this portal: its own bound origin, or
   * one of the configured `trustedOrigins`. An unrelated loopback port is still
   * another process and is still refused (13F6 / 4.8).
   */
  private isSelfOrigin(value: string): boolean {
    return isAllowedOrigin(value, { selfPort: this.boundPort, trustedOrigins: this.trustedOrigins });
  }

  /**
   * Whether an Origin/Referer is this server's OWN bound origin — the only one
   * that may be forwarded to the dashboard. A configured proxy origin is trusted
   * to talk to the portal, but the dashboard's own gate knows nothing about it,
   * so forwarding it would turn a legitimate proxy topology into a 403 one hop
   * later. The header is dropped instead and the dashboard sees the portal's
   * header-less server-to-server read.
   */
  private isOwnBoundOrigin(value: string): boolean {
    return isAllowedOrigin(value, { selfPort: this.boundPort });
  }

  /**
   * Whether the request's Host names this portal (CHN-2): loopback, an IP
   * literal, `allowedHosts`, or the hostname of a configured trusted origin.
   */
  private acceptsHost(req: HttpReq): boolean {
    return isAllowedHostHeader(req.headers.host, {
      allowedHosts: this.allowedHosts,
      trustedOrigins: this.trustedOrigins,
    });
  }

  /**
   * The chat WebSocket handshake gate. An absent Origin is a non-browser client
   * (allowed, as before); a present one must be this portal's own origin, port
   * included.
   */
  private acceptsWsOrigin(req: HttpReq): boolean {
    const origin = this.getSingleHeader(req.headers.origin);
    if (origin === undefined) return true;
    return this.isSelfOrigin(origin);
  }

  /**
   * True when the caller presents a web profile identity THIS channel issued
   * (the pair handed out in the `connected` frame). Audit 13F6 / plan 4.8, the
   * second half: the proxy's Authorization fallback used to accept the dashboard
   * token from ANY holder, so a token read out of the environment, a log or a
   * config file was a complete credential. It is now only half of one — the
   * caller must also name a session the server knows.
   */
  private hasVerifiedProfileIdentity(req: HttpReq): boolean {
    const profileId = this.getSingleHeader(req.headers["x-strada-profile-id"]);
    const profileToken = this.getSingleHeader(req.headers["x-strada-profile-token"]);
    if (!profileId || !profileToken) return false;
    return this.identityStore.verify(profileId, profileToken);
  }

  private isTrustedMutableProxyRequest(req: HttpReq): boolean {
    const origin = this.getSingleHeader(req.headers.origin);
    if (origin !== undefined) {
      return this.isSelfOrigin(origin);
    }

    const referer = this.getSingleHeader(req.headers.referer);
    if (referer !== undefined) {
      return this.isSelfOrigin(referer);
    }

    // Header-less (non-browser) caller: the configured dashboard token AND an
    // identity this server issued. The token alone is not an identity.
    if (this.options.dashboardAuthToken) {
      const authHeader = this.getSingleHeader(req.headers.authorization);
      if (authHeader) {
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : authHeader;
        return (
          this.safeTokenEquals(token, this.options.dashboardAuthToken) &&
          this.hasVerifiedProfileIdentity(req)
        );
      }
    }

    return false;
  }

  /**
   * Gate for read-only (GET) proxy requests. Rejects only when a browser
   * supplies an Origin/Referer header that is NOT an allowed origin — blocking
   * cross-origin GETs from a hostile same-browser page while still allowing the
   * header-less non-browser case (e.g. curl, server-to-server reads).
   */
  private isAllowedGetProxyRequest(req: HttpReq): boolean {
    const origin = this.getSingleHeader(req.headers.origin);
    if (origin !== undefined) {
      return this.isSelfOrigin(origin);
    }

    const referer = this.getSingleHeader(req.headers.referer);
    if (referer !== undefined) {
      return this.isSelfOrigin(referer);
    }

    // No Origin/Referer header — not a browser cross-origin request; allow.
    return true;
  }

  /**
   * Proxy /api/* requests to the dashboard server (same-origin solution).
   * GET is allowed for all allowlisted paths; POST/DELETE only for mutable paths.
   */
  private async proxyToDashboard(req: HttpReq, res: ServerResponse, url: string): Promise<void> {
    const method = req.method ?? "GET";
    getLoggerSafe().debug("[WebChannel] proxyToDashboard", { url, method, dashboardPort: this.dashboardPort });

    // Allowlist check (strip query string for matching). The path must already
    // be canonical: what is authorized here is what the dashboard will act on.
    const rawPath = url.split("?")[0]!;
    const pathOnly = WebChannel.canonicalProxyPath(rawPath);
    if (pathOnly === undefined) {
      res.writeHead(400, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad Request" }));
      return;
    }
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
      ) ||
      WebChannel.MUTABLE_PROXY_ROUTES.some((r) => r.method === method && r.pattern.test(pathOnly));
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

    // Plan 6.14: the origin check above proves the request came from THIS
    // portal — it says nothing about WHICH of the instance's identities sent it.
    // Setup/settings writes and daemon control are owner-only, so a guest's
    // mutation is refused here even though its origin is impeccable.
    if (method !== "GET") {
      const ownerOnly = ownerOnlyProxySurface(pathOnly);
      if (ownerOnly) {
        const facts = this.instanceFacts();
        const profileId = this.getSingleHeader(req.headers["x-strada-profile-id"]);
        const profileToken = this.getSingleHeader(req.headers["x-strada-profile-token"]);
        const verified = profileId && profileToken && this.identityStore.verify(profileId, profileToken)
          ? profileId
          : undefined;
        const decision = this.decide(ownerOnly, this.actorFor(verified, undefined, facts), {
          facts,
          what: `${method} ${pathOnly}`,
        });
        if (!decision.allowed) {
          res.writeHead(403, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Forbidden", reason: decision.reason, surface: decision.surface, code: decision.code }));
          return;
        }
      }
    }

    // GET requests are read-only but still browser-reachable, so a cross-origin
    // page could trigger them (CSRF-style). When an Origin/Referer header IS
    // present it must be an allowed origin; the genuinely header-less case
    // (non-browser clients like curl) is still permitted so server-to-server
    // reads keep working.
    if (method === "GET" && !this.isAllowedGetProxyRequest(req)) {
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
      } else if (this.options.dashboardAuthToken && this.acceptsHost(req)) {
        // The token is this server's credential, so it is only ever added on
        // behalf of a request whose Host is verified (CHN-2) — never for a
        // page that merely reached the port.
        proxyHeaders["Authorization"] = `Bearer ${this.options.dashboardAuthToken}`;
      }
      // Only this portal's own origin is forwarded, so the dashboard's own
      // same-origin gate never sees a foreign loopback port laundered through
      // the proxy (13F6 / 4.8).
      if (originHeader && this.isOwnBoundOrigin(originHeader)) {
        proxyHeaders["Origin"] = originHeader;
      }
      // WHO IS ASKING travels to the dashboard (round 12 #10). The routes
      // behind this proxy decide per identity — a change-review decision is
      // the instance owner's — and a request that arrives unattributed is
      // refused on a shared instance. Only a pair this channel's own store
      // VERIFIES is forwarded, so a caller cannot claim someone else's id.
      const claimedProfileId = this.getSingleHeader(req.headers["x-strada-profile-id"]);
      const claimedProfileToken = this.getSingleHeader(req.headers["x-strada-profile-token"]);
      if (
        claimedProfileId &&
        claimedProfileToken &&
        this.identityStore.verify(claimedProfileId, claimedProfileToken)
      ) {
        proxyHeaders["x-strada-profile-id"] = claimedProfileId;
        proxyHeaders["x-strada-profile-token"] = claimedProfileToken;
      }
      if (refererHeader && this.isOwnBoundOrigin(refererHeader)) {
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
        const bodyLimit = proxyBodyLimit(pathOnly);
        const outcome = await readProxyBody(req, bodyLimit, bodyChunks);
        if (outcome !== "complete") {
          clearTimeout(timeout);
          if (outcome === "too-large") {
            // CHN-11: the socket used to be destroyed BEFORE this was written, so
            // the browser saw a network error ("offline") instead of a 413.
            // readProxyBody drained the upload first; the connection closes after.
            res.writeHead(413, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json", "Connection": "close" });
            res.end(JSON.stringify({ error: "Request body too large", limitBytes: bodyLimit }));
          } else {
            res.writeHead(400, { ...WebChannel.SECURITY_HEADERS, "Content-Type": "application/json", "Connection": "close" });
            res.end(JSON.stringify({ error: "Request body could not be read" }));
          }
          return;
        }
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
    } catch (error) {
      getLoggerSafe().warn("[WebChannel] proxyToDashboard failed", {
        url,
        dashboardPort: this.dashboardPort,
        error: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(503, {
        ...WebChannel.SECURITY_HEADERS,
        ...WebChannel.NO_CACHE_HEADERS,
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Dashboard API unavailable", hint: "Set DASHBOARD_ENABLED=true" }));
    }
  }
}
