/**
 * Browser Automation Tool using Playwright
 *
 * Provides: navigation, interaction, screenshots, downloads, JS evaluation
 * Security: URL validation, rate limiting, size limits
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import {
  assertPublicTarget,
  discardBody,
  fetchWithPolicy,
  validateUrlWithConfig,
  BrowserRateLimiter,
  BrowserSessionManager,
  DEFAULT_SECURITY_CONFIG,
  ForbiddenTargetError,
  type BrowserSecurityConfig,
  type TargetResolver,
} from "../../security/browser-security.js";
import { getLogger } from "../../utils/logger.js";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ─── Types ───────────────────────────────────────────────────────────────────

type BrowserAction =
  | "navigate"
  | "click"
  | "type"
  | "fill"
  | "select"
  | "scroll"
  | "screenshot"
  | "evaluate"
  | "wait"
  | "get_content"
  | "download";

interface BrowserInput {
  action: BrowserAction;
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  option?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  waitFor?: string;
  timeout?: number;
  fullPage?: boolean;
  script?: string;
  downloadPath?: string;
  headers?: Record<string, string>;
  viewport?: { width: number; height: number };
}

interface SessionState {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsed: number;
  /**
   * Document requests the policy refused because the redirect chain left the
   * requested origin (Codex round 7 #13): requested URL -> vetted final URL.
   * Read by handleNavigate to tell the agent where to navigate instead.
   */
  crossOriginRedirects: Map<string, string>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MB_IN_BYTES = 1024 * 1024;
const MAX_CONTENT_LENGTH = 10000;
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const SCRIPT_EVAL_TIMEOUT_MS = 5000;

function looksLikeExpression(script: string): boolean {
  const trimmed = script.trim();
  if (!trimmed) return false;

  return (
    !/[;{}]/.test(trimmed) &&
    !/\b(return|const|let|var|if|for|while|switch|try|throw|function|class)\b/.test(trimmed)
  );
}

// ─── Network policy (plan 4.6 / audit 13F2 / D64; Codex round 6 #11–#13, round 7 #13–#17) ────
//
// Validating the first URL is not enough: a page can redirect, embed
// sub-resources, open frames or navigate itself to an internal address after
// the initial check. The SAME resolved-target policy (`assertPublicTarget`,
// src/security/browser-security.ts) is applied to every request the context
// makes, and a forbidden destination closes the session.
//
// What the browser lets us enforce, and where (Codex round 6):
//
//  #11  Playwright does NOT invoke the route handler for redirected requests:
//       Chromium follows the redirect inside the same request and Playwright
//       auto-continues it (coreBundle `_onRequest`: a request carrying
//       `redirectResponse` is `Fetch.continueRequest`ed with no route — a
//       fulfilled 3xx is followed the same way). So a public resource that
//       redirects to an internal endpoint would pass a request-time check.
//       - Document (navigation) requests: the handler performs the request
//         ITSELF through `fetchWithPolicy` — the address-pinned undici
//         transport shared with web_fetch_url — which walks the redirect chain
//         hop by hop, refusing at the first forbidden hop, and `route.fulfill`s
//         the vetted final response. `route.fetch` cannot pin the connection,
//         hence the separate transport. `fulfill` cannot change the page's
//         URL, so (round 7 #13) a chain whose final URL is on ANOTHER ORIGIN
//         is not fulfilled — the foreign HTML would run as the requested
//         origin, its relative URLs would resolve against the wrong location
//         and `framenavigated` would check the wrong host. The route is
//         aborted and the final URL is reported to the agent, which may
//         navigate to it explicitly; a same-origin redirect (a path change)
//         is fulfilled. Cookies (round 7 #14/#15): the browser's own Cookie
//         header is not forwarded; each hop carries the context's cookies for
//         THAT hop's URL, and every hop's Set-Cookie headers land in the
//         context's jar scoped to that hop (never through `fulfill`).
//       - Sub-resources keep the request-time route check, plus a POST-HOC
//         `response` listener that walks `response.request().redirectedFrom()`
//         and closes the session when any hop fails the policy. It is post-hoc
//         because the redirect hops never reach the route handler (above); by
//         the time the response event fires the bytes have already been
//         fetched, so the only remaining defence is to tear the session down
//         before a script can read them. A request that got no response (the
//         internal host is down) leaves no event, which is harmless.
//  #12  The browser resolves DNS itself, so a request the route continues is
//       not pinned to the vetted addresses (a rebinding host can answer
//       public to us and private to Chromium). Documents are covered by the
//       fulfil path above (pinned), fallback downloads go through the same
//       transport; sub-resource connections remain the browser's own.
//  #13  WebSockets never pass through `context.route`; they are refused
//       outright (`routeWebSocket`) until an address-pinned implementation
//       exists.
//
// The complete fix for the sub-resource residuals is a controlled proxy that
// owns every connection the browser makes (plan 4.6b). Until it exists,
// sub-resource SSRF remains (Codex round 7 #17): an image, script, frame or
// fetch() the page issues is resolved and connected by Chromium itself, so a
// rebinding host or a redirect hop can still reach an internal address and the
// post-hoc check only tears the session down after the bytes have arrived.

/** Structural subset of Playwright's Request used by the policy (fake-able in tests). */
export interface PolicyRequest {
  url(): string;
  isNavigationRequest(): boolean;
  resourceType(): string;
  method(): string;
  /** The headers as sent on the wire, cookies included (round 7 #14). */
  allHeaders(): Promise<Record<string, string>>;
  postDataBuffer(): Buffer | null;
  redirectedFrom(): PolicyRequest | null;
}

/** Structural subset of Playwright's Route. */
export interface PolicyRoute {
  request(): PolicyRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
}

/** Structural subset of Playwright's Response. */
export interface PolicyResponse {
  url(): string;
  request(): PolicyRequest;
}

/** Structural subset of Playwright's WebSocketRoute. */
export interface PolicyWebSocketRoute {
  url(): string;
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

/** A cookie as `BrowserContext.addCookies` accepts it (`url` XOR `domain`+`path`). */
export interface PolicyCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Structural subset of Playwright's BrowserContext. */
export interface PolicyContext {
  route(url: string, handler: (route: PolicyRoute) => Promise<void> | void): Promise<unknown>;
  /** The jar's cookies that apply to `url` (round 7 #14). */
  cookies(url: string): Promise<Array<{ name: string; value: string }>>;
  /** Add cookies to the jar (round 7 #15). */
  addCookies(cookies: ReadonlyArray<PolicyCookie>): Promise<void>;
  routeWebSocket(url: string, handler: (ws: PolicyWebSocketRoute) => Promise<void> | void): Promise<unknown>;
  on(event: "response", listener: (response: PolicyResponse) => void): unknown;
}

/** Structural subset of Playwright's Page. */
export interface PolicyPage {
  on(event: "framenavigated", listener: (frame: { url(): string }) => void): unknown;
}

export interface NetworkPolicyOptions {
  /** Injectable resolver (tests); defaults to dns.lookup. */
  resolver?: TargetResolver;
  /** Called when a frame has navigated to a forbidden destination. Should tear the session down. */
  onForbiddenNavigation: (url: string, reason: string) => Promise<void> | void;
  /**
   * Called when a sub-resource's redirect chain contains a forbidden hop
   * (post-hoc, see #11 above). Defaults to `onForbiddenNavigation`.
   */
  onForbiddenRedirect?: (url: string, reason: string) => Promise<void> | void;
  /** Called for every aborted request (logging). */
  onBlockedRequest?: (url: string, reason: string) => void;
  /**
   * Called when a document request was aborted because its redirect chain
   * ended on another origin (round 7 #13), with the vetted final URL the
   * session may navigate to explicitly.
   */
  onCrossOriginRedirect?: (url: string, finalUrl: string) => void;
  /** Called for every refused WebSocket (logging). */
  onBlockedWebSocket?: (url: string) => void;
  /** Bound on one document fetch (all hops); defaults to DOCUMENT_FETCH_TIMEOUT_MS. */
  documentTimeoutMs?: number;
}

/** Schemes that never touch the network from the browser; nothing to resolve. */
const NON_NETWORK_SCHEMES = new Set(["about:", "blob:", "data:"]);

/** Bound on one document fetch through the pinned transport (all redirect hops). */
const DOCUMENT_FETCH_TIMEOUT_MS = 30_000;

/** Largest document body the fulfil path buffers (documents are fetched into memory). */
const DOCUMENT_MAX_BYTES = 32 * MB_IN_BYTES;

/**
 * Request headers the browser sets that must not be forwarded by the pinned
 * transport: connection management belongs to undici, the length is derived
 * from the body we send, undici negotiates (and decodes) its own encodings,
 * and the Cookie header is rebuilt per hop from the context's jar (round 7
 * #14) so the first hop's cookies never travel to another host.
 */
const DOCUMENT_REQUEST_HEADERS_DROPPED = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Response headers that describe the wire form we no longer deliver: the body
 * handed to `fulfill` is decoded and complete. Set-Cookie is applied to the
 * context's jar per hop instead (round 7 #15): `fulfill` would collapse the
 * headers to one and scope them to the requested URL, not the hop that set them.
 */
const DOCUMENT_RESPONSE_HEADERS_DROPPED = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

/** A document request whose redirect chain ended on another origin (round 7 #13). */
export class CrossOriginRedirectError extends Error {
  constructor(
    readonly requestedUrl: string,
    readonly finalUrl: string,
  ) {
    super(
      `Navigation to ${requestedUrl} was redirected to another origin (${finalUrl}); the redirect was not followed under the original origin. Navigate to ${finalUrl} explicitly to continue.`,
    );
    this.name = "CrossOriginRedirectError";
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Cookie header for one hop: the jar's cookies for exactly that URL (round 7 #14). */
async function cookieHeaderFor(context: PolicyContext, url: string): Promise<Record<string, string> | undefined> {
  const cookies = await context.cookies(url);
  if (cookies.length === 0) return undefined;
  return { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}

/** RFC 6265 §5.1.4 default-path of a URL. */
function defaultCookiePath(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash);
}

/**
 * One Set-Cookie header -> an addCookies entry scoped to the hop that sent it
 * (round 7 #15). Without a Domain attribute the cookie is host-only for the hop
 * URL (Playwright derives host and default path from `url`; a Path attribute
 * is folded into that URL). A Domain attribute is honoured only when the hop's
 * host domain-matches it (RFC 6265 §5.3 step 6); otherwise the cookie is
 * ignored rather than widened. Returns null for malformed or rejected cookies.
 */
export function parseSetCookie(header: string, hopUrl: string): PolicyCookie | null {
  const [pair, ...attributes] = header.split(";");
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  let hop: URL;
  try {
    hop = new URL(hopUrl);
  } catch {
    return null;
  }

  const cookie: PolicyCookie = { name, value };
  let domain: string | undefined;
  let path: string | undefined;
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const raw of attributes) {
    const sep = raw.indexOf("=");
    const attr = (sep === -1 ? raw : raw.slice(0, sep)).trim().toLowerCase();
    const attrValue = sep === -1 ? "" : raw.slice(sep + 1).trim();
    switch (attr) {
      case "domain": {
        const candidate = attrValue.replace(/^\./, "").toLowerCase();
        if (!candidate) break;
        const host = hop.hostname.toLowerCase();
        if (host !== candidate && !host.endsWith(`.${candidate}`)) return null;
        domain = `.${candidate}`;
        break;
      }
      case "path":
        if (attrValue.startsWith("/")) path = attrValue;
        break;
      case "max-age": {
        const seconds = Number(attrValue);
        if (Number.isFinite(seconds)) maxAge = seconds;
        break;
      }
      case "expires": {
        const at = Date.parse(attrValue);
        if (Number.isFinite(at)) expires = Math.floor(at / 1000);
        break;
      }
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite": {
        const mode = attrValue.toLowerCase();
        if (mode === "strict") cookie.sameSite = "Strict";
        else if (mode === "lax") cookie.sameSite = "Lax";
        else if (mode === "none") cookie.sameSite = "None";
        break;
      }
      default:
        break;
    }
  }
  if (maxAge !== undefined) cookie.expires = Math.floor(Date.now() / 1000) + maxAge;
  else if (expires !== undefined) cookie.expires = expires;

  if (domain) {
    cookie.domain = domain;
    cookie.path = path ?? defaultCookiePath(hop.pathname);
  } else if (path) {
    const scoped = new URL(hop.toString());
    scoped.pathname = path.endsWith("/") ? path : `${path}/`;
    scoped.search = "";
    scoped.hash = "";
    cookie.url = scoped.toString();
  } else {
    cookie.url = hop.toString();
  }
  return cookie;
}

/** The URL as Chromium reports it in a request (e.g. "https://a.example" -> "https://a.example/"). */
function normalizeUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(url);
  return match ? match[1]!.toLowerCase() : "";
}

function isDocumentRequest(request: PolicyRequest): boolean {
  return request.isNavigationRequest() || request.resourceType() === "document";
}

/** Read a body fully, refusing past DOCUMENT_MAX_BYTES (cancels the stream). */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    await discardBody(response);
    throw new Error(`Document exceeds ${maxBytes} bytes (content-length ${declared})`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Document exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * #11 (documents): perform the navigation request ourselves through the
 * pinned, hop-by-hop transport and fulfil the route with the vetted response.
 * Throws ForbiddenTargetError when any hop is refused and
 * CrossOriginRedirectError when the chain ends on another origin (round 7
 * #13); other failures throw too (the caller aborts the route).
 */
async function fulfillDocumentUnderPolicy(
  context: PolicyContext,
  route: PolicyRoute,
  options: NetworkPolicyOptions,
): Promise<void> {
  const request = route.request();
  const requestedUrl = request.url();
  const headers: Record<string, string> = {};
  // #14: allHeaders() is the wire set (headers() omits what the browser adds
  // late, cookies among them); the Cookie header itself is dropped and rebuilt
  // per hop from the jar below.
  for (const [name, value] of Object.entries(await request.allHeaders())) {
    if (!DOCUMENT_REQUEST_HEADERS_DROPPED.has(name.toLowerCase())) headers[name] = value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.documentTimeoutMs ?? DOCUMENT_FETCH_TIMEOUT_MS);
  timer.unref?.();
  let dispose: (() => Promise<void>) | undefined;
  try {
    const fetched = await fetchWithPolicy(requestedUrl, {
      signal: controller.signal,
      method: request.method(),
      headers,
      body: request.postDataBuffer(),
      hopHeaders: (hopUrl) => cookieHeaderFor(context, hopUrl),
      onSetCookie: async (hopUrl, setCookies) => {
        const parsed = setCookies.map((h) => parseSetCookie(h, hopUrl)).filter((c): c is PolicyCookie => c !== null);
        if (parsed.length > 0) await context.addCookies(parsed);
      },
      ...(options.resolver ? { resolver: options.resolver } : {}),
    });
    dispose = fetched.dispose;
    const response = fetched.response;
    // #13: fulfil only what belongs to the requested origin. A same-origin
    // redirect (path change) is fine — the page keeps the requested URL, the
    // content is that origin's own; a cross-origin one is not.
    if (originOf(fetched.finalUrl) !== originOf(requestedUrl)) {
      await discardBody(response);
      throw new CrossOriginRedirectError(requestedUrl, fetched.finalUrl);
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!DOCUMENT_RESPONSE_HEADERS_DROPPED.has(name.toLowerCase())) responseHeaders[name] = value;
    });
    const body = await readBounded(response, DOCUMENT_MAX_BYTES);
    await route.fulfill({ status: response.status, headers: responseHeaders, body });
  } finally {
    clearTimeout(timer);
    if (dispose) await dispose();
  }
}

/**
 * Install the resolved-target policy on a browser context: every request goes
 * through `assertPublicTarget` (abort on refusal), document requests are
 * fetched by the pinned transport and fulfilled, sub-resource redirect chains
 * are checked post-hoc, WebSockets are refused, and every frame navigation is
 * re-checked (close on refusal).
 */
export async function installNetworkPolicy(
  context: PolicyContext,
  page: PolicyPage,
  options: NetworkPolicyOptions,
): Promise<void> {
  const policyOptions = options.resolver ? { resolver: options.resolver } : {};
  const onForbiddenRedirect = options.onForbiddenRedirect ?? options.onForbiddenNavigation;

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const scheme = schemeOf(url);
    if (NON_NETWORK_SCHEMES.has(scheme)) {
      await route.continue();
      return;
    }
    try {
      await assertPublicTarget(url, policyOptions);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onBlockedRequest?.(url, reason);
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    if (!isDocumentRequest(request)) {
      await route.continue();
      return;
    }
    // #11: documents are fetched hop by hop under the policy and fulfilled.
    try {
      await fulfillDocumentUnderPolicy(context, route, options);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ForbiddenTargetError) {
        options.onBlockedRequest?.(url, reason);
        await route.abort("blockedbyclient").catch(() => undefined);
      } else if (error instanceof CrossOriginRedirectError) {
        options.onBlockedRequest?.(url, reason);
        options.onCrossOriginRedirect?.(url, error.finalUrl);
        await route.abort("blockedbyclient").catch(() => undefined);
      } else {
        await route.abort("failed").catch(() => undefined);
      }
    }
  });

  // #13: WebSockets bypass `route`; refuse them all. Playwright 1.60 (the pinned
  // version) has `routeWebSocket`; a handler that never calls
  // `connectToServer()` leaves the page talking to a mock, and `close()` ends
  // that. An init script replacing `window.WebSocket` was the alternative and is
  // weaker (a worker or a saved reference gets the original constructor).
  await context.routeWebSocket("**/*", async (ws) => {
    options.onBlockedWebSocket?.(ws.url());
    await ws.close({ code: 1008, reason: "WebSocket connections are blocked by the network policy" }).catch(() => undefined);
  });

  // #11 (sub-resources), post-hoc: redirect hops never reach the route handler
  // (see the section comment), so the chain is inspected when the response
  // arrives and a forbidden hop tears the session down.
  context.on("response", (response) => {
    const hops: string[] = [];
    for (let req: PolicyRequest | null = response.request(); req?.redirectedFrom(); req = req.redirectedFrom()) {
      hops.push(req.url());
    }
    if (hops.length === 0) return;
    void (async () => {
      for (const hop of hops) {
        if (NON_NETWORK_SCHEMES.has(schemeOf(hop))) continue;
        try {
          await assertPublicTarget(hop, policyOptions);
        } catch (error) {
          const reason = error instanceof ForbiddenTargetError ? error.message : String(error);
          await onForbiddenRedirect(hop, reason);
          return;
        }
      }
    })();
  });

  page.on("framenavigated", (frame) => {
    const url = frame.url();
    const scheme = schemeOf(url);
    if (NON_NETWORK_SCHEMES.has(scheme) || url === "") return;
    void assertPublicTarget(url, policyOptions).catch(async (error: unknown) => {
      const reason = error instanceof ForbiddenTargetError ? error.message : String(error);
      await options.onForbiddenNavigation(url, reason);
    });
  });
}

// ─── Configuration ───────────────────────────────────────────────────────────

function loadConfig(): BrowserSecurityConfig {
  return {
    ...DEFAULT_SECURITY_CONFIG,
    maxNavigationTimeMs: parseInt(process.env["BROWSER_TIMEOUT_MS"] ?? "30000", 10),
    maxScreenshotSizeMb: parseInt(process.env["BROWSER_SCREENSHOT_MAX_SIZE_MB"] ?? "10", 10),
    maxDownloadSizeMb: parseInt(process.env["BROWSER_DOWNLOAD_MAX_SIZE_MB"] ?? "50", 10),
    maxConcurrentSessions: parseInt(process.env["BROWSER_MAX_CONCURRENT"] ?? "5", 10),
    maxOperationsPerMinute: 60,
  };
}

// ─── BrowserAutomationTool Class ─────────────────────────────────────────────

export class BrowserAutomationTool implements ITool {
  readonly name = "browser_automation";
  readonly description = `Automate browser actions using Playwright. Actions: navigate, click, type, fill, select, scroll, screenshot, evaluate, wait, get_content, download.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "navigate",
          "click",
          "type",
          "fill",
          "select",
          "scroll",
          "screenshot",
          "evaluate",
          "wait",
          "get_content",
          "download",
        ],
        description: "The browser action to perform",
      },
      url: { type: "string", description: "URL for navigate or download actions" },
      selector: { type: "string", description: "CSS selector for element interactions" },
      text: { type: "string", description: "Text to type (for type action)" },
      value: { type: "string", description: "Value to fill (for fill action)" },
      option: { type: "string", description: "Option value to select (for select action)" },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
        description: "Scroll direction",
      },
      amount: { type: "number", description: "Scroll amount in pixels or wait time in ms" },
      waitFor: { type: "string", description: "Selector to wait for (for wait action)" },
      timeout: { type: "number", description: "Timeout in milliseconds" },
      fullPage: { type: "boolean", description: "Take full page screenshot" },
      script: { type: "string", description: "JavaScript to evaluate" },
      downloadPath: { type: "string", description: "Local path to save downloaded file" },
      headers: { type: "object", description: "Custom headers for navigation" },
      viewport: {
        type: "object",
        properties: { width: { type: "number" }, height: { type: "number" } },
        description: "Viewport dimensions",
      },
    },
    required: ["action"],
  };

  private sessions = new Map<string, SessionState>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private rateLimiter: BrowserRateLimiter;
  private sessionManager: BrowserSessionManager;
  private config: BrowserSecurityConfig;
  private readonly logger = getLogger();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.config = loadConfig();
    this.rateLimiter = new BrowserRateLimiter(this.config.maxOperationsPerMinute);
    this.sessionManager = new BrowserSessionManager(this.config.maxConcurrentSessions);
    this.startCleanupInterval();
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const sessionId = context.workingDirectory;
    const typedInput = input as unknown as BrowserInput;

    const rateLimitCheck = this.rateLimiter.checkLimit(sessionId);
    if (!rateLimitCheck.allowed) {
      return {
        content: `Rate limit exceeded. Try again in ${Math.ceil((rateLimitCheck.retryAfterMs ?? 60000) / 1000)} seconds.`,
        isError: true,
      };
    }

    try {
      return await this.executeAction(typedInput, sessionId, context);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Browser automation error", {
        action: typedInput.action,
        error: errorMessage,
      });
      return { content: `Browser automation error: ${errorMessage}`, isError: true };
    }
  }

  // ─── Action Router ───────────────────────────────────────────────────────────

  private async executeAction(
    input: BrowserInput,
    sessionId: string,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    switch (input.action) {
      case "navigate":
        return this.handleNavigate(input, sessionId);
      case "click":
        return this.handleClick(input, sessionId);
      case "type":
        return this.handleType(input, sessionId);
      case "fill":
        return this.handleFill(input, sessionId);
      case "select":
        return this.handleSelect(input, sessionId);
      case "scroll":
        return this.handleScroll(input, sessionId);
      case "screenshot":
        return this.handleScreenshot(input, sessionId, context);
      case "evaluate":
        return this.handleEvaluate(input, sessionId);
      case "wait":
        return this.handleWait(input, sessionId);
      case "get_content":
        return this.handleGetContent(sessionId);
      case "download":
        return this.handleDownload(input, sessionId, context);
      default:
        return { content: `Unknown action: ${String(input.action)}`, isError: true };
    }
  }

  // ─── Action Handlers ─────────────────────────────────────────────────────────

  private async handleNavigate(
    input: BrowserInput,
    sessionId: string,
  ): Promise<ToolExecutionResult> {
    if (!input.url) return { content: "URL is required for navigate action", isError: true };

    const validation = validateUrlWithConfig(input.url, this.config);
    if (!validation.valid)
      return { content: `URL validation failed: ${validation.reason}`, isError: true };

    const targetCheck = await this.checkResolvedTarget(input.url);
    if (targetCheck) return targetCheck;

    if (!this.sessionManager.acquireSession(sessionId)) {
      return {
        content: `Maximum concurrent browser sessions (${this.config.maxConcurrentSessions}) reached.`,
        isError: true,
      };
    }

    const session = await this.withSessionLock(sessionId, () =>
      this.getOrCreateSession(sessionId, input.viewport),
    );
    const timeout = input.timeout ?? this.config.maxNavigationTimeMs;
    session.crossOriginRedirects.clear();

    try {
      if (input.headers && Object.keys(input.headers).length > 0) {
        await session.page.setExtraHTTPHeaders(input.headers);
      }

      await session.page.goto(input.url, { waitUntil: "networkidle", timeout });
      return {
        content: `Successfully navigated to: ${session.page.url()}\nPage title: ${await session.page.title()}`,
        metadata: { url: session.page.url(), title: await session.page.title() },
      };
    } catch (error) {
      this.sessionManager.releaseSession(sessionId);
      // Round 7 #13: the policy aborted the document because its redirect
      // chain left the origin; name the vetted final URL so the agent can go
      // there explicitly.
      const redirectedTo = session.crossOriginRedirects.get(normalizeUrl(input.url));
      if (redirectedTo) {
        session.crossOriginRedirects.clear();
        return {
          content: new CrossOriginRedirectError(input.url, redirectedTo).message,
          isError: true,
          metadata: { url: input.url, redirectedTo },
        };
      }
      throw error;
    }
  }

  private async handleClick(input: BrowserInput, sessionId: string): Promise<ToolExecutionResult> {
    if (!input.selector) return { content: "Selector is required for click action", isError: true };
    const session = this.requireSession(sessionId);

    await session.page.click(input.selector);
    return { content: `Clicked element: ${input.selector}` };
  }

  private async handleType(input: BrowserInput, sessionId: string): Promise<ToolExecutionResult> {
    if (!input.selector) return { content: "Selector is required for type action", isError: true };
    if (input.text === undefined)
      return { content: "Text is required for type action", isError: true };
    const session = this.requireSession(sessionId);

    await session.page.type(input.selector, input.text);
    return { content: `Typed "${input.text}" into: ${input.selector}` };
  }

  private async handleFill(input: BrowserInput, sessionId: string): Promise<ToolExecutionResult> {
    if (!input.selector) return { content: "Selector is required for fill action", isError: true };
    if (input.value === undefined)
      return { content: "Value is required for fill action", isError: true };
    const session = this.requireSession(sessionId);

    await session.page.fill(input.selector, input.value);
    return { content: `Filled "${input.value}" into: ${input.selector}` };
  }

  private async handleSelect(input: BrowserInput, sessionId: string): Promise<ToolExecutionResult> {
    const session = this.requireSession(sessionId);
    if (!input.selector)
      return { content: "Selector is required for select action", isError: true };
    if (!input.option) return { content: "Option is required for select action", isError: true };

    await session.page.selectOption(input.selector, input.option);
    return { content: `Selected "${input.option}" in: ${input.selector}` };
  }

  private async handleScroll(input: BrowserInput, sessionId: string): Promise<ToolExecutionResult> {
    const session = this.requireSession(sessionId);
    const direction = input.direction ?? "down";
    const amount = input.amount ?? 500;

    const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;

    await session.page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: deltaX, y: deltaY });
    return { content: `Scrolled ${direction} by ${amount}px` };
  }

  private async handleScreenshot(
    input: BrowserInput,
    sessionId: string,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const session = this.requireSession(sessionId);
    const fullPage = input.fullPage ?? false;

    const buffer = await session.page.screenshot({ fullPage, type: "png" });
    const sizeMb = buffer.length / MB_IN_BYTES;

    if (sizeMb > this.config.maxScreenshotSizeMb) {
      return { content: `Screenshot size (${sizeMb.toFixed(2)}MB) exceeds limit`, isError: true };
    }

    const screenshotPath = join(context.workingDirectory, `.screenshot-${Date.now()}.png`);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, buffer);

    return {
      content: `Screenshot saved to: ${screenshotPath} (${buffer.length} bytes)`,
      metadata: { path: screenshotPath, size: buffer.length },
    };
  }

  /**
   * Defense-in-depth script validation. This is NOT a security boundary --
   * the browser context itself is the sandbox. This blocklist reduces the
   * attack surface by rejecting obviously dangerous patterns before they
   * reach the page context.
   */
  private validateScript(script: string): string | null {
    const stripped = script
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '""');

    const dangerousPatterns: [RegExp, string][] = [
      [/\beval\s*\(/i, "eval()"],
      [/\bnew\s+Function\s*\(/i, "new Function()"],
      [/\bimport\s*\(/i, "dynamic import()"],
      [/\bfetch\s*\(/i, "fetch()"],
      [/\bXMLHttpRequest\b/i, "XMLHttpRequest"],
      [/\bWebSocket\b/i, "WebSocket"],
      [/\bdocument\.cookie\b/i, "document.cookie"],
      [/\bdocument\.write\b/i, "document.write"],
      [/\.innerHTML\s*=/i, "innerHTML assignment"],
      [/\.outerHTML\s*=/i, "outerHTML assignment"],
      [/\bwindow\.open\s*\(/i, "window.open()"],
      [/\blocation\s*[.=]/i, "location manipulation"],
      [/\bnavigator\.sendBeacon\s*\(/i, "navigator.sendBeacon()"],
      [/\bpostMessage\s*\(/i, "postMessage()"],
      [/__proto__/i, "__proto__ access"],
      [/\bconstructor\s*\[/i, "constructor bracket access"],
      // Block bracket-notation property access with string literals (bypass for dot-notation blocks)
      [/\[['"`].*['"`]\]/i, "computed property access with string literal"],
      // Block alternative global references that bypass 'window.' checks
      [/\bglobalThis\b/i, "globalThis access"],
      [/\bself\b/i, "self access"],
      [/\btop\b/i, "top frame access"],
      [/\bparent\b/i, "parent frame access"],
      [/\bframes\b/i, "frames access"],
      // Block destructuring from document/window (e.g. const { cookie } = document)
      [/\{[^}]*\}\s*=\s*(document|window)/i, "destructuring from document/window"],
    ];

    for (const [pattern, label] of dangerousPatterns) {
      if (pattern.test(stripped)) {
        return `Script contains blocked pattern: ${label}`;
      }
    }

    return null;
  }

  private async handleEvaluate(
    input: BrowserInput,
    sessionId: string,
  ): Promise<ToolExecutionResult> {
    const session = this.requireSession(sessionId);
    if (!input.script) return { content: "Script is required for evaluate action", isError: true };

    const validationError = this.validateScript(input.script);
    if (validationError) {
      return { content: validationError, isError: true };
    }

    const timeout = input.timeout ?? SCRIPT_EVAL_TIMEOUT_MS;
    const code = input.script;

    // Use Promise.race with proper cleanup. Note: Playwright's page.evaluate
    // does not accept a third options argument for timeout, so we use a manual
    // timer. The timer is always cleaned up in the finally block. If the timeout
    // fires, the page.evaluate CDP call is NOT cancelled -- consider closing and
    // recreating the page if this becomes a problem in practice.
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Script evaluation timed out")), timeout);
    });

    let result: unknown;
    try {
      result = await Promise.race([
        session.page.evaluate(({ source, asExpression }: { source: string; asExpression: boolean }) => {
          const target = document.head ?? document.documentElement;
          if (!target) {
            throw new Error("Document is not ready for script execution");
          }

          const stradaWindow = window as typeof window & {
            __stradaEvalResult?: unknown;
            __stradaEvalError?: string;
          };

          delete stradaWindow.__stradaEvalResult;
          delete stradaWindow.__stradaEvalError;

          const wrappedSource = asExpression
            ? `window.__stradaEvalResult = (() => (${source}))();`
            : `window.__stradaEvalResult = (() => {\n${source}\n})();`;
          const script = document.createElement("script");
          script.textContent = `
            try {
              ${wrappedSource}
            } catch (error) {
              window.__stradaEvalError = error instanceof Error ? error.message : String(error);
            }
          `;
          target.appendChild(script);
          script.remove();

          if (stradaWindow.__stradaEvalError) {
            throw new Error(stradaWindow.__stradaEvalError);
          }

          return stradaWindow.__stradaEvalResult;
        }, {
          source: code,
          asExpression: looksLikeExpression(code),
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) {
        return { content: "Script evaluation timed out", isError: true };
      }
      throw error;
    } finally {
      clearTimeout(timer!);
    }
    const resultStr = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);

    return {
      content: `Script executed successfully.\nResult:\n${resultStr}`,
      metadata: { result },
    };
  }

  private async handleWait(input: BrowserInput, sessionId: string): Promise<ToolExecutionResult> {
    const session = this.requireSession(sessionId);
    const timeout = input.timeout ?? 1000;

    if (input.waitFor) {
      await session.page.waitForSelector(input.waitFor, { timeout });
      return { content: `Waited for selector: ${input.waitFor}` };
    }

    await session.page.waitForTimeout(input.amount ?? timeout);
    return { content: `Waited for ${input.amount ?? timeout}ms` };
  }

  private async handleGetContent(sessionId: string): Promise<ToolExecutionResult> {
    const session = this.requireSession(sessionId);
    const content = await session.page.content();
    const text = await session.page.evaluate(() => document.body.innerText);
    const truncated =
      text.length > MAX_CONTENT_LENGTH ? text.substring(0, MAX_CONTENT_LENGTH) + "..." : text;

    return {
      content: `Page content:\n${truncated}`,
      metadata: {
        textLength: text.length,
        htmlLength: content.length,
        truncated: text.length > MAX_CONTENT_LENGTH,
      },
    };
  }

  private async handleDownload(
    input: BrowserInput,
    sessionId: string,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (!input.url) return { content: "URL is required for download action", isError: true };
    if (!input.downloadPath) return { content: "Download path is required", isError: true };

    const validation = validateUrlWithConfig(input.url, this.config);
    if (!validation.valid)
      return { content: `URL validation failed: ${validation.reason}`, isError: true };

    const targetCheck = await this.checkResolvedTarget(input.url);
    if (targetCheck) return targetCheck;

    const session = this.requireSession(sessionId);
    const candidate = resolve(join(context.workingDirectory, input.downloadPath));
    const safeRoot = resolve(context.workingDirectory);
    if (!candidate.startsWith(safeRoot + sep) && candidate !== safeRoot) {
      return { content: "Download path traversal blocked: path must be within working directory", isError: true };
    }
    const fullPath = candidate;
    await mkdir(dirname(fullPath), { recursive: true });

    try {
      return await this.downloadViaBrowser(session, input.url, fullPath);
    } catch {
      return this.fallbackDownload(input.url, fullPath);
    }
  }

  private async downloadViaBrowser(
    session: SessionState,
    url: string,
    targetPath: string,
  ): Promise<ToolExecutionResult> {
    const page = await session.context.newPage();
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.evaluate((downloadUrl) => {
          const a = document.createElement("a");
          a.href = downloadUrl;
          a.download = "";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }, url),
      ]);

      const suggestedFilename = download.suggestedFilename();
      const finalPath =
        targetPath.endsWith("/") || (await this.isDirectory(targetPath))
          ? join(targetPath, suggestedFilename)
          : targetPath;

      await download.saveAs(finalPath);

      const stats = await stat(finalPath);
      const sizeMb = stats.size / MB_IN_BYTES;

      if (sizeMb > this.config.maxDownloadSizeMb) {
        await unlink(finalPath);
        return { content: `Download size (${sizeMb.toFixed(2)}MB) exceeds limit`, isError: true };
      }

      return {
        content: `Downloaded to: ${finalPath} (${stats.size} bytes)`,
        metadata: { path: finalPath, size: stats.size, filename: suggestedFilename },
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async fallbackDownload(url: string, targetPath: string): Promise<ToolExecutionResult> {
    // Codex round 6 #12: the download goes through the SAME address-pinned,
    // hop-by-hop transport as web_fetch_url (fetchWithPolicy): every redirect
    // hop is re-validated against the block patterns (onHop) and the resolved-
    // target policy, and each connection goes to the vetted addresses only —
    // the global fetch resolved DNS on its own and could follow a rebinding
    // host into the network.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.maxNavigationTimeMs);
    timer.unref?.();
    let dispose: (() => Promise<void>) | undefined;
    try {
      const fetched = await fetchWithPolicy(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; StradaBot/1.0)" },
        onHop: (hopUrl) => {
          const hopValidation = validateUrlWithConfig(hopUrl, this.config);
          if (!hopValidation.valid) {
            throw new Error(`URL validation failed: ${hopValidation.reason}`);
          }
        },
      });
      dispose = fetched.dispose;
      const response = fetched.response;

      if (response.status >= 300 && response.status < 400) {
        await discardBody(response);
        return { content: "Download failed: redirect without a Location", isError: true };
      }
      if (!response.ok) {
        await discardBody(response);
        return { content: `Download failed: HTTP ${response.status}`, isError: true };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const sizeMb = parseInt(contentLength, 10) / MB_IN_BYTES;
        if (sizeMb > this.config.maxDownloadSizeMb) {
          await discardBody(response);
          return { content: `Download size (${sizeMb.toFixed(2)}MB) exceeds limit`, isError: true };
        }
      }

      const body = response.body;
      if (!body) return { content: "Download failed: No response body", isError: true };

      await pipeline(
        Readable.fromWeb(body as import("stream/web").ReadableStream),
        createWriteStream(targetPath),
      );
      const stats = await stat(targetPath);

      return {
        content: `Downloaded to: ${targetPath} (${stats.size} bytes)`,
        metadata: { path: targetPath, size: stats.size },
      };
    } catch (error) {
      if (error instanceof ForbiddenTargetError) {
        return { content: `Download blocked: ${error.message}`, isError: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Too many redirects")) {
        return { content: "Download failed: too many redirects", isError: true };
      }
      if (message.startsWith("URL validation failed")) {
        return { content: `Download blocked (${message})`, isError: true };
      }
      return { content: `Download failed: ${message}`, isError: true };
    } finally {
      clearTimeout(timer);
      if (dispose) await dispose();
    }
  }

  // ─── Session Management ──────────────────────────────────────────────────────

  private async getOrCreateSession(
    sessionId: string,
    viewport?: { width: number; height: number },
  ): Promise<SessionState> {
    let session = this.sessions.get(sessionId);
    if (session) {
      session.lastUsed = Date.now();
      return session;
    }

    const headless = process.env["BROWSER_HEADLESS"] !== "false";
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      browser = await chromium.launch({ headless });

      context = await browser.newContext({
        viewport: viewport ?? { width: 1280, height: 720 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      const page = await context.newPage();
      const crossOriginRedirects = new Map<string, string>();

      if (this.config.blockLocalhost) {
        await installNetworkPolicy(context, page, {
          documentTimeoutMs: this.config.maxNavigationTimeMs,
          onBlockedRequest: (url, reason) =>
            this.logger.warn("Browser request blocked by network policy", { sessionId, url, reason }),
          onCrossOriginRedirect: (url, finalUrl) => crossOriginRedirects.set(normalizeUrl(url), finalUrl),
          onBlockedWebSocket: (url) =>
            this.logger.warn("Browser WebSocket refused by network policy", { sessionId, url }),
          onForbiddenRedirect: async (url, reason) => {
            this.logger.warn("Browser sub-resource redirect chain hit a forbidden hop; closing session", {
              sessionId,
              url,
              reason,
            });
            await this.closeSession(sessionId);
          },
          onForbiddenNavigation: async (url, reason) => {
            this.logger.warn("Browser navigated to a forbidden destination; closing session", {
              sessionId,
              url,
              reason,
            });
            await this.closeSession(sessionId);
          },
        });
      }

      session = { browser, context, page, createdAt: Date.now(), lastUsed: Date.now(), crossOriginRedirects };
      this.sessions.set(sessionId, session);
      this.logger.info("Created new browser session", { sessionId });

      return session;
    } catch (error) {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Resolved-target policy for tool-supplied URLs (navigate / download / every
   * download redirect hop). Returns an error result when the URL's hostname
   * resolves to a forbidden address, null when it is public.
   */
  private async checkResolvedTarget(url: string): Promise<ToolExecutionResult | null> {
    if (!this.config.blockLocalhost) return null;
    try {
      await assertPublicTarget(url);
      return null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { content: `URL validation failed: ${reason}`, isError: true };
    }
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("No active browser session. Navigate to a page first.");
    }
    session.lastUsed = Date.now();
    return session;
  }

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let releaseLock: () => void;
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.sessionLocks.set(sessionId, lock);
    try {
      await prev;
      return await fn();
    } finally {
      releaseLock!();
      // Clean up if no subsequent lock replaced this one
      if (this.sessionLocks.get(sessionId) === lock) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions) {
        if (now - session.lastUsed > SESSION_IDLE_TIMEOUT_MS) {
          this.logger.info("Closing inactive browser session", { sessionId });
          await this.closeSession(sessionId);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.withSessionLock(sessionId, () => this.closeSessionUnsafe(sessionId));
  }

  private async closeSessionUnsafe(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await session.context.close();
      await session.browser.close();
    } catch (error) {
      this.logger.error("Error closing browser session", { sessionId, error });
    }

    this.sessions.delete(sessionId);
    this.sessionManager.releaseSession(sessionId);
    this.rateLimiter.resetSession(sessionId);
  }

  async dispose(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.closeSession(sessionId);
    }

    this.rateLimiter.dispose();
  }
}
