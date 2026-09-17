import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// DNS is mocked so the resolved-target policy (plan 0-B.6 / 4.6) runs without
// the network. Unknown hosts resolve to a public address. undici is mocked so
// the address-pinned transport (Codex round 6 #11 / #12) is observable: every
// Agent it builds is recorded, and its fetch is mockFetch. The global fetch is
// stubbed to a spy that must never be called.
const { mockLookup, mockFetch, mockGlobalFetch, agentInstances } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockFetch: vi.fn(),
  mockGlobalFetch: vi.fn(),
  agentInstances: [] as Array<{ options: unknown; closed: boolean; destroyed: boolean }>,
}));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
vi.mock("undici", () => {
  class Agent {
    readonly options: unknown;
    closed = false;
    destroyed = false;
    constructor(options: unknown) {
      this.options = options;
      agentInstances.push(this);
    }
    async close(): Promise<void> {
      this.closed = true;
    }
    async destroy(): Promise<void> {
      this.destroyed = true;
    }
  }
  return { Agent, fetch: mockFetch };
});
vi.stubGlobal("fetch", mockGlobalFetch);

import {
  BrowserAutomationTool,
  CrossOriginRedirectError,
  credentialHeadersForRequest,
  installNetworkPolicy,
  isLikelyPublicSuffix,
  POLICY_CONTEXT_OPTIONS,
  isSameSiteUrl,
  parseSetCookie,
  takeVettedDocument,
  type VettedDocument,
  type OriginCredentials,
  type PolicyContext,
  type PolicyJarCookie,
  type PolicyPage,
  type PolicyRequest,
  type PolicyResponse,
  type PolicyRoute,
  type PolicyWebSocketRoute,
} from "./browser-automation.js";
import type { ToolContext } from "./tool.interface.js";
import type { ResolvedAddress } from "../../security/browser-security.js";
import { createLogger } from "../../utils/logger.js";

// Initialize logger for tests
createLogger("error", "/tmp/strada-test.log");

const PUBLIC_V4 = "93.184.216.34";
const dnsTable = new Map<string, ResolvedAddress[]>();

beforeEach(() => {
  dnsTable.clear();
  mockLookup.mockReset();
  mockFetch.mockReset();
  mockGlobalFetch.mockReset();
  agentInstances.length = 0;
  mockLookup.mockImplementation(async (hostname: string) => dnsTable.get(hostname) ?? [{ address: PUBLIC_V4, family: 4 }]);
});

function redirectResponse(status: number, location: string) {
  return {
    ok: false,
    status,
    statusText: "Redirect",
    headers: new Headers({ location }),
    body: { cancel: vi.fn(() => Promise.resolve()) },
    text: () => Promise.resolve(""),
  };
}

function okResponse(text: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/html", ...headers }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    text: () => Promise.resolve(text),
  };
}

// ── Plan 4.6 (audit 13F2 / D64): every browser request and navigation is checked ──

interface FakeContext extends PolicyContext {
  jar: PolicyJarCookie[];
  routePattern?: string;
  routeHandler?: (route: PolicyRoute) => Promise<void> | void;
  wsPattern?: string;
  wsHandler?: (ws: PolicyWebSocketRoute) => Promise<void> | void;
  responseListeners: Array<(response: PolicyResponse) => void>;
  /** Pages the context opens after install (popups) — plan 4.6 bypass (b). */
  pageListeners: Array<(page: PolicyPage) => void>;
}

interface FakePage extends PolicyPage {
  listeners: Record<string, Array<(frame: { url(): string }) => void>>;
}

function fakeContext(): FakeContext {
  const ctx: FakeContext = {
    jar: [],
    responseListeners: [],
    pageListeners: [],
    cookies: vi.fn(async (_url: string) => ctx.jar),
    addCookies: vi.fn(async (cookies) => {
      ctx.jar.push(...cookies);
    }),
    route: vi.fn(async (pattern: string, handler: (route: PolicyRoute) => Promise<void> | void) => {
      ctx.routePattern = pattern;
      ctx.routeHandler = handler;
    }),
    routeWebSocket: vi.fn(async (pattern: string, handler: (ws: PolicyWebSocketRoute) => Promise<void> | void) => {
      ctx.wsPattern = pattern;
      ctx.wsHandler = handler;
    }),
    on: vi.fn(((event: string, listener: unknown) => {
      if (event === "page") {
        ctx.pageListeners.push(listener as (page: PolicyPage) => void);
      } else {
        ctx.responseListeners.push(listener as (response: PolicyResponse) => void);
      }
      return ctx;
    }) as unknown as PolicyContext["on"]),
  };
  return ctx;
}

function fakeRequest(
  url: string,
  extra: Partial<Omit<PolicyRequest, "url">> = {},
): PolicyRequest {
  return {
    url: () => url,
    isNavigationRequest: () => false,
    resourceType: () => "other",
    method: () => "GET",
    allHeaders: async () => ({}),
    postDataBuffer: () => null,
    redirectedFrom: () => null,
    ...extra,
  };
}

function fakePage(): FakePage {
  const page: FakePage = {
    listeners: {},
    on: vi.fn((event: string, listener: (frame: { url(): string }) => void) => {
      (page.listeners[event] ??= []).push(listener);
      return page;
    }),
  };
  return page;
}

function fakeRoute(url: string, request: Partial<Omit<PolicyRequest, "url">> = {}) {
  const req = fakeRequest(url, request);
  return {
    request: () => req,
    continue: vi.fn(async () => undefined),
    abort: vi.fn(async (_code?: string) => undefined),
    fulfill: vi.fn(async (_response: { status: number; headers: Record<string, string>; body: Buffer }) => undefined),
  };
}

/** A document (navigation) route: the #11 fulfil path. */
function documentRoute(url: string, request: Partial<Omit<PolicyRequest, "url">> = {}) {
  return fakeRoute(url, { isNavigationRequest: () => true, resourceType: () => "document", ...request });
}

describe("installNetworkPolicy (plan 4.6 / 13F2 / D64)", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("public.example", [{ address: PUBLIC_V4, family: 4 }]);
    table.set("internal.corp", [{ address: "10.0.0.5", family: 4 }]);
    table.set("meta.example", [{ address: "169.254.169.254", family: 4 }]);
  });

  it("routes every request through the policy: forbidden targets are aborted, public ones continue", async () => {
    const ctx = fakeContext();
    const page = fakePage();
    const blocked: string[] = [];
    await installNetworkPolicy(ctx, page, {
      resolver,
      onForbiddenNavigation: vi.fn(),
      onBlockedRequest: (url) => blocked.push(url),
    });

    expect(ctx.route).toHaveBeenCalledTimes(1);
    expect(ctx.routePattern).toBe("**/*");
    const handler = ctx.routeHandler!;

    const pub = fakeRoute("https://public.example/app.js");
    await handler(pub);
    expect(pub.continue).toHaveBeenCalledTimes(1);
    expect(pub.abort).not.toHaveBeenCalled();

    for (const url of [
      "http://internal.corp/api", // hostname -> private
      "http://meta.example/latest/meta-data/", // hostname -> link-local
      "http://127.0.0.1:8080/", // literal loopback
      "http://2130706433/", // decimal loopback
      "http://[fd00::1]/", // unique-local
      "http://localhost/", // RFC 6761
      "http://unknown.example/", // unresolvable -> fail closed
      "ftp://public.example/", // scheme
    ]) {
      const r = fakeRoute(url);
      await handler(r);
      expect(r.abort, url).toHaveBeenCalledWith("blockedbyclient");
      expect(r.continue, url).not.toHaveBeenCalled();
    }
    expect(blocked).toHaveLength(8);
  });

  it("lets non-network schemes (data:, blob:, about:) through the route without resolving", async () => {
    const ctx = fakeContext();
    await installNetworkPolicy(ctx, fakePage(), { resolver, onForbiddenNavigation: vi.fn() });
    for (const url of ["data:text/plain,hi", "blob:https://public.example/uuid", "about:blank"]) {
      const r = fakeRoute(url);
      await ctx.routeHandler!(r);
      expect(r.continue, url).toHaveBeenCalledTimes(1);
      expect(r.abort, url).not.toHaveBeenCalled();
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it("re-checks every frame navigation and tears down on a forbidden destination", async () => {
    const ctx = fakeContext();
    const page = fakePage();
    const onForbiddenNavigation = vi.fn(async () => undefined);
    await installNetworkPolicy(ctx, page, { resolver, onForbiddenNavigation });

    expect(page.on).toHaveBeenCalledWith("framenavigated", expect.any(Function));
    const [listener] = page.listeners["framenavigated"]!;

    listener!({ url: () => "https://public.example/page" });
    listener!({ url: () => "about:blank" });
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledWith("public.example"));
    expect(onForbiddenNavigation).not.toHaveBeenCalled();

    listener!({ url: () => "http://internal.corp/dashboard" });
    await vi.waitFor(() => expect(onForbiddenNavigation).toHaveBeenCalledTimes(1));
    expect(onForbiddenNavigation.mock.calls[0]?.[0]).toBe("http://internal.corp/dashboard");
    expect(String(onForbiddenNavigation.mock.calls[0]?.[1])).toContain("10.0.0.5");

    // Rebinding after the first navigation: the same host now answers private.
    table.set("public.example", [{ address: "127.0.0.1", family: 4 }]);
    listener!({ url: () => "https://public.example/page2" });
    await vi.waitFor(() => expect(onForbiddenNavigation).toHaveBeenCalledTimes(2));
  });
});

// ── Plan 4.6 / audit 13F2: the two places the route API was BYPASSED ──
//
// (a) Service-worker requests never reach context.route (Playwright's own note on
//     page.route/browserContext.route, microsoft/playwright#1090) — so a page
//     that registered a worker had an unpoliced network path out. The context
//     must therefore be created with serviceWorkers: "block".
// (b) context.route covers every page in the context, but the framenavigated
//     recheck was bound to the first page only, so a popup's navigations were
//     never re-resolved.

describe("installNetworkPolicy — plan 4.6: the route API's own bypasses", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("public.example", [{ address: PUBLIC_V4, family: 4 }]);
    table.set("internal.corp", [{ address: "10.0.0.5", family: 4 }]);
  });

  it("(a) requires serviceWorkers: block, because a worker's requests never reach the route", () => {
    expect(POLICY_CONTEXT_OPTIONS.serviceWorkers).toBe("block");
  });

  it("(b) subscribes to every page the context opens", async () => {
    const ctx = fakeContext();
    await installNetworkPolicy(ctx, fakePage(), { resolver, onForbiddenNavigation: vi.fn() });
    expect(ctx.on).toHaveBeenCalledWith("page", expect.any(Function));
    expect(ctx.pageListeners).toHaveLength(1);
  });

  it("(b) re-checks a POPUP's frame navigation and tears the session down", async () => {
    const ctx = fakeContext();
    const onForbiddenNavigation = vi.fn(async () => undefined);
    await installNetworkPolicy(ctx, fakePage(), { resolver, onForbiddenNavigation });

    // window.open / target=_blank: a page the context opens AFTER install.
    const popup = fakePage();
    for (const open of ctx.pageListeners) open(popup);
    expect(popup.on).toHaveBeenCalledWith("framenavigated", expect.any(Function));

    const [listener] = popup.listeners["framenavigated"]!;
    listener!({ url: () => "http://internal.corp/dashboard" });

    await vi.waitFor(() => expect(onForbiddenNavigation).toHaveBeenCalledTimes(1));
    expect(onForbiddenNavigation.mock.calls[0]?.[0]).toBe("http://internal.corp/dashboard");
  });

  it("(b) a popup's rebound host is caught after the bytes were vetted", async () => {
    const ctx = fakeContext();
    const onForbiddenNavigation = vi.fn(async () => undefined);
    await installNetworkPolicy(ctx, fakePage(), { resolver, onForbiddenNavigation });
    const popup = fakePage();
    for (const open of ctx.pageListeners) open(popup);
    const [listener] = popup.listeners["framenavigated"]!;

    listener!({ url: () => "https://public.example/p" });
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledWith("public.example"));
    expect(onForbiddenNavigation).not.toHaveBeenCalled();

    table.set("public.example", [{ address: "127.0.0.1", family: 4 }]);
    listener!({ url: () => "https://public.example/p2" });
    await vi.waitFor(() => expect(onForbiddenNavigation).toHaveBeenCalledTimes(1));
  });

  // Guard: the recheck must not refuse a popup that goes somewhere public, and
  // the first page's own recheck must still be installed.
  it("(b) leaves a public popup navigation alone, and still rechecks the first page", async () => {
    const ctx = fakeContext();
    const page = fakePage();
    const onForbiddenNavigation = vi.fn(async () => undefined);
    await installNetworkPolicy(ctx, page, { resolver, onForbiddenNavigation });

    expect(page.listeners["framenavigated"]).toHaveLength(1);

    const popup = fakePage();
    for (const open of ctx.pageListeners) open(popup);
    for (const url of ["https://public.example/ok", "about:blank", ""]) {
      popup.listeners["framenavigated"]![0]!({ url: () => url });
    }
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledWith("public.example"));
    expect(onForbiddenNavigation).not.toHaveBeenCalled();

    page.listeners["framenavigated"]![0]!({ url: () => "http://internal.corp/x" });
    await vi.waitFor(() => expect(onForbiddenNavigation).toHaveBeenCalledTimes(1));
  });
});

// ── Codex round 6 (2026-09-17) #11–#13 on 09edbba6: what the route handler
// cannot see (redirect hops, the browser's own DNS, WebSockets) ──

describe("installNetworkPolicy — Codex round 6 #11–#13", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("public.example", [{ address: PUBLIC_V4, family: 4 }]);
    table.set("cdn.example", [{ address: "151.101.1.1", family: 4 }]);
    table.set("internal.corp", [{ address: "10.0.0.5", family: 4 }]);
  });

  async function install(overrides: Partial<Parameters<typeof installNetworkPolicy>[2]> = {}) {
    const ctx = fakeContext();
    const page = fakePage();
    const blocked: string[] = [];
    const onForbiddenRedirect = vi.fn(async () => undefined);
    await installNetworkPolicy(ctx, page, {
      resolver,
      onForbiddenNavigation: vi.fn(),
      onForbiddenRedirect,
      onBlockedRequest: (url) => blocked.push(url),
      ...overrides,
    });
    return { ctx, page, blocked, onForbiddenRedirect };
  }

  // #11 (documents): the route handler fetches through the pinned transport and
  // refuses at the hop — Chromium never gets to follow the redirect itself.
  it("#11 refuses a document request whose redirect lands on a private host at the hop, before the second fetch", async () => {
    const { ctx, blocked } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "http://internal.corp/admin"));
    mockFetch.mockResolvedValueOnce(okResponse("SHOULD NOT BE FETCHED"));

    const route = documentRoute("https://public.example/start");
    await ctx.routeHandler!(route);

    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "manual" }));
    expect(blocked).toEqual(["https://public.example/start"]);
    expect(resolver.mock.calls.map((c) => c[0])).toEqual(["public.example", "public.example", "internal.corp"]);
  });

  it("#11 fulfils a document request with the vetted response from its own URL (never route.continue)", async () => {
    // Round 8 #22: only a chain that ENDED on the requested URL may be
    // fulfilled; a redirect is restarted at the final URL instead.
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("<html>final</html>", { "content-encoding": "gzip", "x-served-by": "cdn" }));

    const route = documentRoute("https://public.example/start", {
      method: () => "GET",
      allHeaders: async () => ({ "user-agent": "UA/1", "accept-encoding": "gzip, br, zstd", host: "public.example" }),
    });
    await ctx.routeHandler!(route);

    expect(route.continue).not.toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    const fulfilled = route.fulfill.mock.calls[0]![0];
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.toString("utf8")).toBe("<html>final</html>");
    expect(fulfilled.headers).toEqual({ "content-type": "text/html", "x-served-by": "cdn" }); // wire-form headers dropped
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The hop is pinned to its vetted Agent; the browser's headers are
    // forwarded minus connection/encoding ones.
    expect(agentInstances).toHaveLength(1);
    expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      dispatcher: agentInstances[0],
      headers: { "user-agent": "UA/1" },
    }));
    expect(agentInstances.every((a) => a.closed)).toBe(true);
    expect(mockGlobalFetch).not.toHaveBeenCalled();
  });

  it("#11 keeps sub-resources on route.continue (no fetch of our own)", async () => {
    const { ctx } = await install();
    const route = fakeRoute("https://public.example/app.js", { resourceType: () => "script" });
    await ctx.routeHandler!(route);
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // #11 (sub-resources): the hops never reach the route handler; the response
  // event is the first place the chain is visible, so the check is post-hoc.
  it("#11 closes the session when a sub-resource's redirect chain contains a private hop (post-hoc response check)", async () => {
    const { ctx, onForbiddenRedirect } = await install();
    expect(ctx.on).toHaveBeenCalledWith("response", expect.any(Function));
    const [listener] = ctx.responseListeners;

    const origin = fakeRequest("https://public.example/pixel.gif");
    const hop1 = fakeRequest("http://internal.corp/collect", { redirectedFrom: () => origin });
    const final = fakeRequest("https://cdn.example/pixel.gif", { redirectedFrom: () => hop1 });
    listener!({ url: () => "https://cdn.example/pixel.gif", request: () => final });

    await vi.waitFor(() => expect(onForbiddenRedirect).toHaveBeenCalledTimes(1));
    expect(onForbiddenRedirect.mock.calls[0]?.[0]).toBe("http://internal.corp/collect");
    expect(String(onForbiddenRedirect.mock.calls[0]?.[1])).toContain("10.0.0.5");
  });

  it("#11 a public->public sub-resource chain, or a direct response, does not close the session", async () => {
    const { ctx, onForbiddenRedirect } = await install();
    const [listener] = ctx.responseListeners;

    const origin = fakeRequest("https://public.example/a.css");
    const final = fakeRequest("https://cdn.example/a.css", { redirectedFrom: () => origin });
    listener!({ url: () => "https://cdn.example/a.css", request: () => final });
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledWith("cdn.example"));

    listener!({ url: () => "https://public.example/direct", request: () => fakeRequest("https://public.example/direct") });
    await new Promise((r) => setTimeout(r, 10));
    expect(onForbiddenRedirect).not.toHaveBeenCalled();
  });

  // #13
  it("#13 refuses every WebSocket via routeWebSocket", async () => {
    const blockedWs: string[] = [];
    const { ctx } = await install({ onBlockedWebSocket: (url) => blockedWs.push(url) });

    expect(ctx.routeWebSocket).toHaveBeenCalledTimes(1);
    expect(ctx.wsPattern).toBe("**/*");
    const ws = { url: () => "wss://public.example/socket", close: vi.fn(async () => undefined) };
    await ctx.wsHandler!(ws);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ code: 1008 }));
    expect(blockedWs).toEqual(["wss://public.example/socket"]);
  });
});

// ── Codex round 7 (2026-09-17) #13–#15 on 59f7f9d1: what the fulfil path got
// wrong about origins and cookies ──

describe("installNetworkPolicy — Codex round 7 #13–#15", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("trusted.example", [{ address: PUBLIC_V4, family: 4 }]);
    table.set("evil.example", [{ address: "151.101.1.1", family: 4 }]);
  });

  async function install() {
    const ctx = fakeContext();
    const page = fakePage();
    const blocked: Array<{ url: string; reason: string }> = [];
    const onCrossOriginRedirect = vi.fn((_url: string, _finalUrl: string) => undefined);
    const onSameOriginRedirect = vi.fn((_url: string, _finalUrl: string) => undefined);
    await installNetworkPolicy(ctx, page, {
      resolver,
      onForbiddenNavigation: vi.fn(),
      onBlockedRequest: (url, reason) => blocked.push({ url, reason }),
      onCrossOriginRedirect,
      onSameOriginRedirect,
    });
    return { ctx, page, blocked, onCrossOriginRedirect, onSameOriginRedirect };
  }

  // #13: a fulfilled response keeps the requested URL, so foreign HTML would
  // execute as trusted.example. The route is aborted and the final URL exposed.
  it("#13 aborts a document whose redirect chain ends on another origin and names the final URL", async () => {
    const { ctx, blocked, onCrossOriginRedirect } = await install();
    const cancelFinalBody = vi.fn(async () => undefined);
    const final = { ...okResponse("<html>evil</html>"), body: { cancel: cancelFinalBody } };
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "https://evil.example/landing"));
    mockFetch.mockResolvedValueOnce(final);

    const route = documentRoute("https://trusted.example/start");
    await ctx.routeHandler!(route);

    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(onCrossOriginRedirect).toHaveBeenCalledWith("https://trusted.example/start", "https://evil.example/landing");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.reason).toContain("https://evil.example/landing");
    expect(blocked[0]!.reason).toContain("another origin");
    // The error the navigate action returns names the vetted final URL.
    const message = new CrossOriginRedirectError("https://trusted.example/start", "https://evil.example/landing").message;
    expect(message).toContain("Navigate to https://evil.example/landing explicitly");
    // The foreign body was discarded, not buffered, and every hop's agent closed.
    expect(cancelFinalBody).toHaveBeenCalledTimes(1);
    expect(agentInstances).toHaveLength(2);
    expect(agentInstances.every((a) => a.closed)).toBe(true);
  });

  it("#13 a scheme or port change is an origin change too", async () => {
    const { ctx, onCrossOriginRedirect } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(301, "https://trusted.example:8443/start"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>other port</html>"));
    const route = documentRoute("https://trusted.example/start");
    await ctx.routeHandler!(route);
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(onCrossOriginRedirect).toHaveBeenCalledWith("https://trusted.example/start", "https://trusted.example:8443/start");
  });

  it("#13 a same-origin redirect (path change) is walked and reported for a restart, not refused as cross-origin", async () => {
    const { ctx, onCrossOriginRedirect, onSameOriginRedirect } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "/login?next=%2Fstart"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>login</html>"));

    const route = documentRoute("https://trusted.example/start");
    await ctx.routeHandler!(route);

    // The chain is followed under the policy (round 7 #13) but its body is not
    // delivered under /start (round 8 #22).
    expect(mockFetch.mock.calls[1]?.[0]).toBe("https://trusted.example/login?next=%2Fstart");
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(onCrossOriginRedirect).not.toHaveBeenCalled();
    // Round 9 #14: the vetted response of the final hop rides along, so the
    // restart delivers it instead of requesting the URL a second time.
    expect(onSameOriginRedirect).toHaveBeenCalledWith(
      "https://trusted.example/start",
      "https://trusted.example/login?next=%2Fstart",
      expect.objectContaining({ status: 200 }),
    );
  });

  // #14: headers() omits the cookies Chromium adds late; the wire set comes from
  // allHeaders(), and the Cookie header itself is rebuilt per hop from the jar.
  it("#14 a navigation carries the context's cookies for that hop's URL (allHeaders + context.cookies), never the original Cookie header", async () => {
    const { ctx } = await install();
    const allHeaders = vi.fn(async () => ({
      "user-agent": "UA/1",
      cookie: "stale=from-browser",
      "sec-fetch-mode": "navigate",
    }));
    const sid = { name: "sid", value: "abc", domain: "trusted.example", path: "/" };
    const theme = { name: "theme", value: "dark", domain: "trusted.example", path: "/app" };
    (ctx.cookies as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
      url.startsWith("https://trusted.example/app") ? [sid, theme]
      : url.startsWith("https://trusted.example/") ? [sid]
      : [],
    );
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "https://trusted.example/app/home"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>home</html>"));

    const route = documentRoute("https://trusted.example/start", { allHeaders });
    await ctx.routeHandler!(route);

    expect(allHeaders).toHaveBeenCalledTimes(1);
    expect(ctx.cookies).toHaveBeenCalledWith("https://trusted.example/start");
    expect(ctx.cookies).toHaveBeenCalledWith("https://trusted.example/app/home");
    expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: { "user-agent": "UA/1", "sec-fetch-mode": "navigate", cookie: "sid=abc" },
    }));
    expect(mockFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: { "user-agent": "UA/1", "sec-fetch-mode": "navigate", cookie: "sid=abc; theme=dark" },
    }));
    // Round 8 #22: the chain ended on /app/home, so nothing is fulfilled at /start.
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
  });

  it("#14 a hop with no cookies in the jar sends no Cookie header at all", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));
    const route = documentRoute("https://trusted.example/start", {
      allHeaders: async () => ({ cookie: "stale=from-browser", "user-agent": "UA/1" }),
    });
    await ctx.routeHandler!(route);
    expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: { "user-agent": "UA/1" } }));
  });

  // #15: Headers.get("set-cookie") joins several cookies into one string, and a
  // fulfilled Set-Cookie would be scoped to the requested URL, not the hop.
  it("#15 two Set-Cookie headers on a redirect hop both land in the jar, scoped to that hop, and are not forwarded through fulfill", async () => {
    const { ctx } = await install();
    const hop = {
      ...redirectResponse(302, "/home"),
      headers: new Headers([
        ["location", "/home"],
        ["set-cookie", "sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax"],
        ["set-cookie", "theme=dark; Max-Age=3600"],
      ]),
    };
    const final = {
      ...okResponse("<html>home</html>"),
      headers: new Headers([
        ["content-type", "text/html"],
        ["set-cookie", "seen=1"],
      ]),
    };
    mockFetch.mockResolvedValueOnce(hop);
    mockFetch.mockResolvedValueOnce(final);

    const route = documentRoute("https://trusted.example/start");
    await ctx.routeHandler!(route);

    expect(ctx.addCookies).toHaveBeenCalledTimes(2);
    const first = (ctx.addCookies as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual(expect.objectContaining({ name: "sid", value: "abc", domain: "trusted.example", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }));
    expect(first[1]).toEqual(expect.objectContaining({ name: "theme", value: "dark", domain: "trusted.example", path: "/" }));
    expect(first[1]!["expires"]).toBeGreaterThan(Date.now() / 1000 + 3000);
    const second = (ctx.addCookies as ReturnType<typeof vi.fn>).mock.calls[1]![0] as Array<Record<string, unknown>>;
    expect(second).toEqual([expect.objectContaining({ name: "seen", value: "1", domain: "trusted.example", path: "/" })]);
    // The next hop's Cookie header was built AFTER the hop's cookies landed.
    expect(ctx.cookies).toHaveBeenNthCalledWith(2, "https://trusted.example/home");
    expect(mockFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ headers: { cookie: "sid=abc; theme=dark" } }));
    // The chain ended on /home, so nothing was fulfilled at /start (round 8 #22).
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it("#15 a Set-Cookie on the final response lands in the jar and is not forwarded through fulfill", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce({
      ...okResponse("<html>home</html>"),
      headers: new Headers([
        ["content-type", "text/html"],
        ["set-cookie", "seen=1; Path=/app"],
      ]),
    });

    const route = documentRoute("https://trusted.example/app/home");
    await ctx.routeHandler!(route);

    expect(ctx.addCookies).toHaveBeenCalledTimes(1);
    const added = (ctx.addCookies as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(added).toEqual([expect.objectContaining({ name: "seen", value: "1", domain: "trusted.example", path: "/app" })]);
    // The jar, not fulfill, carries it.
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    expect(Object.keys(route.fulfill.mock.calls[0]![0].headers)).not.toContain("set-cookie");
  });

  it("#15 parseSetCookie scopes to the hop: a Domain the host does not match is ignored, a matching one is honoured", () => {
    expect(parseSetCookie("a=1; Domain=evil.example", "https://trusted.example/x")).toBeNull();
    expect(parseSetCookie("a=1; Domain=.example", "https://trusted.example/x")).toEqual(
      expect.objectContaining({ name: "a", value: "1", domain: ".example", path: "/" }),
    );
    expect(parseSetCookie("a=1; Domain=trusted.example; Path=/app", "https://trusted.example/app/x")).toEqual(
      expect.objectContaining({ domain: ".trusted.example", path: "/app" }),
    );
    expect(parseSetCookie("a=1", "https://trusted.example/app/x?q=1")).toEqual({ name: "a", value: "1", domain: "trusted.example", path: "/app" });
    expect(parseSetCookie("a=1; Path=/app", "https://trusted.example/x?q=1")).toEqual({ name: "a", value: "1", domain: "trusted.example", path: "/app" });
    expect(parseSetCookie("=novalue", "https://trusted.example/")).toBeNull();
    expect(parseSetCookie("garbage", "https://trusted.example/")).toBeNull();
    expect(parseSetCookie("a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "https://trusted.example/")).toEqual(
      expect.objectContaining({ expires: Math.floor(Date.parse("Wed, 21 Oct 2026 07:28:00 GMT") / 1000) }),
    );
  });
});

// #12: the fallback download used the global fetch (its own DNS, no pinning).
describe("BrowserAutomationTool.fallbackDownload — Codex round 6 #12", () => {
  let tool: BrowserAutomationTool;
  const scratch = process.env["TMPDIR"] ?? "/tmp";

  beforeEach(() => {
    tool = new BrowserAutomationTool();
  });

  afterAll(async () => {
    await tool?.dispose();
  });

  function fallback(url: string, target: string) {
    return (tool as unknown as { fallbackDownload(u: string, t: string): Promise<{ content: string; isError?: boolean }> })
      .fallbackDownload(url, target);
  }

  it("#12 downloads through the pinned undici transport, never the global fetch", async () => {
    dnsTable.set("files.example", [{ address: PUBLIC_V4, family: 4 }]);
    mockFetch.mockResolvedValueOnce(okResponse("payload-bytes"));
    const target = `${scratch}/strada-round6-download-${process.pid}.bin`;

    const result = await fallback("https://files.example/a.bin", target);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Downloaded to");
    expect(mockGlobalFetch).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(agentInstances).toHaveLength(1);
    expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      dispatcher: agentInstances[0],
      redirect: "manual",
    }));
    const lookup = (agentInstances[0]!.options as { connect: { lookup: (h: string, o: Record<string, unknown>, cb: (...a: unknown[]) => void) => void } }).connect.lookup;
    const pinned = await new Promise<unknown[]>((resolve) => lookup("files.example", { all: true }, (...a) => resolve(a)));
    expect(pinned[1]).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    expect(agentInstances[0]!.closed).toBe(true);
    const { unlink } = await import("node:fs/promises");
    await unlink(target).catch(() => undefined);
  });

  it("#12 refuses a download redirect into the network at the hop", async () => {
    dnsTable.set("internal.corp", [{ address: "10.0.0.5", family: 4 }]);
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "http://internal.corp/secret.bin"));
    mockFetch.mockResolvedValueOnce(okResponse("SHOULD NOT BE FETCHED"));

    const result = await fallback("https://files.example/a.bin", `${scratch}/strada-round6-never.bin`);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Download blocked");
    expect(result.content).toContain("10.0.0.5");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("#12 re-applies the block patterns to every redirect hop", async () => {
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "https://files.example/admin/dump.bin"));
    const result = await fallback("https://files.example/a.bin", `${scratch}/strada-round6-never.bin`);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked pattern");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserAutomationTool", () => {
  let tool: BrowserAutomationTool;
  let context: ToolContext;

  beforeEach(() => {
    tool = new BrowserAutomationTool();
    context = {
      projectPath: "/tmp/test",
      workingDirectory: "/tmp/test",
      readOnly: false,
    };
  });

  afterAll(async () => {
    await tool?.dispose();
  });

  describe("schema", () => {
    it("should have correct name", () => {
      expect(tool.name).toBe("browser_automation");
    });

    it("should have input schema defined", () => {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toHaveProperty("action");
    });
  });

  describe("security", () => {
    it("should block localhost URLs", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "http://localhost:8080/test" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Localhost");
    });

    it("should block file:// URLs", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "file:///etc/passwd" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("file://");
    });

    it("should block javascript:// URLs", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "javascript:alert(1)" },
        context
      );
      expect(result.isError).toBe(true);
    });

    it("should block private IP ranges", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "http://192.168.1.1/admin" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Private IP");
    });

    it("should block URLs matching blocked patterns", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "https://example.com/admin" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("blocked pattern");
    });

    // Plan 0-B.6 / 4.6: the hostname string is public-looking; what it resolves to is not.
    it("should block navigate to a hostname that resolves to a private address (resolved-target policy)", async () => {
      dnsTable.set("public-looking.example", [{ address: "10.0.0.1", family: 4 }]);
      const result = await tool.execute(
        { action: "navigate", url: "https://public-looking.example/" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("10.0.0.1");
      expect(mockLookup).toHaveBeenCalledWith("public-looking.example", expect.anything());
    });

    it("should block navigate to decimal/hex/octal loopback spellings", async () => {
      for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/"]) {
        const result = await tool.execute({ action: "navigate", url }, context);
        expect(result.isError, url).toBe(true);
      }
    });

    it("should block download from a hostname that resolves to link-local metadata", async () => {
      dnsTable.set("meta.example", [{ address: "169.254.169.254", family: 4 }]);
      const result = await tool.execute(
        { action: "download", url: "http://meta.example/latest/", downloadPath: "x.bin" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("169.254.169.254");
    });
  });

  describe("actions without navigation", () => {
    it("should require URL for navigate action", async () => {
      const result = await tool.execute({ action: "navigate" }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("URL is required");
    });

    it("should require selector for click action", async () => {
      const result = await tool.execute({ action: "click" }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Selector is required");
    });

    it("should require selector for type action", async () => {
      const result = await tool.execute({ action: "type", text: "hello" }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Selector is required");
    });

    it("should require text for type action", async () => {
      const result = await tool.execute({ action: "type", selector: "#input" }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Text is required");
    });

    it("should return error when no session exists", async () => {
      const result = await tool.execute(
        { action: "click", selector: "#button" },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No active browser session");
    });
  });

  describe("input validation", () => {
    it("should reject invalid URLs", async () => {
      const result = await tool.execute(
        { action: "navigate", url: "not-a-valid-url" },
        context
      );
      expect(result.isError).toBe(true);
    });

    it("should reject unknown actions", async () => {
      const result = await tool.execute(
        { action: "unknown_action" as never },
        context
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown action");
    });
  });
});

describe.skipIf(!process.env["EXTERNAL_TESTS"])("BrowserAutomationTool external", () => {
  let tool: BrowserAutomationTool;
  let context: ToolContext;

  beforeEach(() => {
    tool = new BrowserAutomationTool();
    context = {
      projectPath: "/tmp/test",
      workingDirectory: "/tmp/test",
      readOnly: false,
    };
  });

  afterAll(async () => {
    await tool?.dispose();
  });

  it("should navigate to external URLs", async () => {
    // Test with example.com (reliable test site)
    const result = await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("example.com");
  }, 30000);

  it("should get page content", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );

    const result = await tool.execute(
      { action: "get_content" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Example Domain");
  }, 30000);

  it("should evaluate JavaScript", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );

    const result = await tool.execute(
      { action: "evaluate", script: "document.title" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Example Domain");
  }, 30000);

  it("should block dangerous JavaScript", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );

    const result = await tool.execute(
      { action: "evaluate", script: "eval('alert(1)')" },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked patterns");
  }, 30000);

  it("should take screenshots", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      context
    );

    const result = await tool.execute(
      { action: "screenshot" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Screenshot saved");
    expect(result.metadata).toHaveProperty("path");
  }, 30000);
});

// ── Codex round 8 (2026-09-17) #19–#22: the cookie boundary the URL filter does
// not enforce, the paths the URL form rewrites, credentials that outlive their
// origin and the document URL a same-origin redirect must end on ──

describe("installNetworkPolicy — Codex round 8 #19/#20/#22", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("trusted.example", [{ address: PUBLIC_V4, family: 4 }]);
    table.set("evil.trusted.example", [{ address: "151.101.1.1", family: 4 }]);
    table.set("other.example", [{ address: "151.101.1.2", family: 4 }]);
  });

  async function install() {
    const ctx = fakeContext();
    const page = fakePage();
    const blocked: Array<{ url: string; reason: string }> = [];
    await installNetworkPolicy(ctx, page, {
      resolver,
      onForbiddenNavigation: vi.fn(),
      onBlockedRequest: (url, reason) => blocked.push({ url, reason }),
    });
    return { ctx, page, blocked };
  }

  function jar(ctx: FakeContext, cookies: Array<Record<string, unknown>>): void {
    (ctx.cookies as ReturnType<typeof vi.fn>).mockImplementation(async () => cookies);
  }

  function sentHeaders(call = 0): Record<string, string> {
    return (mockFetch.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers;
  }

  // #19: `context.cookies(url)` is a filter, not the RFC rule. A host-only
  // cookie for trusted.example must never reach evil.trusted.example.
  it("#19 does not send a host-only cookie to a subdomain", async () => {
    const { ctx } = await install();
    jar(ctx, [{ name: "sid", value: "abc", domain: "trusted.example", path: "/", secure: true, sameSite: "Lax" }]);
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));

    const route = documentRoute("https://evil.trusted.example/", { allHeaders: async () => ({ "user-agent": "UA/1" }) });
    await ctx.routeHandler!(route);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentHeaders()).toEqual({ "user-agent": "UA/1" });
  });

  it("#19 sends a domain cookie only on a label boundary", async () => {
    const { ctx } = await install();
    jar(ctx, [{ name: "sid", value: "abc", domain: ".trusted.example", path: "/", sameSite: "Lax" }]);
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));
    const sub = documentRoute("https://evil.trusted.example/", { allHeaders: async () => ({ "user-agent": "UA/1" }) });
    await ctx.routeHandler!(sub);
    expect(sentHeaders()).toEqual({ "user-agent": "UA/1", cookie: "sid=abc" });

    // "nottrusted.example" ends with the domain string but not on a label boundary.
    table.set("nottrusted.example", [{ address: "151.101.1.3", family: 4 }]);
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));
    const sibling = documentRoute("https://nottrusted.example/", { allHeaders: async () => ({ "user-agent": "UA/1" }) });
    await ctx.routeHandler!(sibling);
    expect(sentHeaders(1)).toEqual({ "user-agent": "UA/1" });
  });

  it("#19 applies the RFC 6265 path rule: /app matches /app and /app/x, never /application", async () => {
    const { ctx } = await install();
    jar(ctx, [{ name: "sid", value: "abc", domain: "trusted.example", path: "/app", sameSite: "Lax" }]);
    const headers = async () => ({ "user-agent": "UA/1" });

    for (const [i, path] of ["/application", "/app", "/app/x", "/appliance/x"].entries()) {
      mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));
      await ctx.routeHandler!(documentRoute(`https://trusted.example${path}`, { allHeaders: headers }));
      const expected = path === "/app" || path === "/app/x" ? { "user-agent": "UA/1", cookie: "sid=abc" } : { "user-agent": "UA/1" };
      expect(sentHeaders(i), path).toEqual(expected);
    }
  });

  it("#19 keeps SameSite=Strict/Lax cookies out of a cross-site request context", async () => {
    const { ctx } = await install();
    jar(ctx, [
      { name: "strict", value: "1", domain: "trusted.example", path: "/", sameSite: "Strict" },
      { name: "lax", value: "2", domain: "trusted.example", path: "/", sameSite: "Lax" },
      { name: "open", value: "3", domain: "trusted.example", path: "/", sameSite: "None", secure: true },
    ]);
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));

    const route = documentRoute("https://trusted.example/start", {
      method: () => "POST",
      postDataBuffer: () => Buffer.from("x=1"),
      allHeaders: async () => ({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }),
    });
    await ctx.routeHandler!(route);

    expect(sentHeaders()).toEqual({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", cookie: "open=3" });
  });

  // Opposite direction (the guard): a same-site top-level navigation still gets
  // every cookie that really applies, and a Secure cookie stays off plain http.
  it("#19 a same-site navigation still carries Strict, Lax and None cookies", async () => {
    const { ctx } = await install();
    jar(ctx, [
      { name: "strict", value: "1", domain: "trusted.example", path: "/", sameSite: "Strict" },
      { name: "lax", value: "2", domain: ".trusted.example", path: "/", sameSite: "Lax" },
      { name: "open", value: "3", domain: "trusted.example", path: "/", sameSite: "None", secure: true },
    ]);
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));
    await ctx.routeHandler!(documentRoute("https://trusted.example/start", {
      allHeaders: async () => ({ "sec-fetch-site": "none", "sec-fetch-dest": "document" }),
    }));
    expect(sentHeaders()).toEqual({
      "sec-fetch-site": "none",
      "sec-fetch-dest": "document",
      cookie: "strict=1; lax=2; open=3",
    });
  });

  it("#19 never sends a Secure cookie over http", async () => {
    const { ctx } = await install();
    jar(ctx, [{ name: "sid", value: "abc", domain: "trusted.example", path: "/", secure: true, sameSite: "Lax" }]);
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));
    await ctx.routeHandler!(documentRoute("http://trusted.example/start", { allHeaders: async () => ({ "user-agent": "UA/1" }) }));
    expect(sentHeaders()).toEqual({ "user-agent": "UA/1" });
  });

  // #20: the URL form rewrites the path ("/app" -> "/app/"), so a later
  // navigation to /app loses the cookie. Host-only cookies carry domain+path.
  it("#20 a host-only Set-Cookie keeps its exact Path and default-path", () => {
    expect(parseSetCookie("sid=x; Path=/app", "https://trusted.example/start")).toEqual({
      name: "sid",
      value: "x",
      domain: "trusted.example",
      path: "/app",
    });
    expect(parseSetCookie("sid=x", "https://trusted.example/app/page")).toEqual({
      name: "sid",
      value: "x",
      domain: "trusted.example",
      path: "/app",
    });
    expect(parseSetCookie("sid=x", "https://trusted.example/")).toEqual({
      name: "sid",
      value: "x",
      domain: "trusted.example",
      path: "/",
    });
  });

  it("#20 the cookie a Path=/app header set is sent to /app itself", async () => {
    const { ctx } = await install();
    const stored = parseSetCookie("sid=x; Path=/app", "https://trusted.example/start")!;
    jar(ctx, [stored as unknown as Record<string, unknown>]);
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));
    await ctx.routeHandler!(documentRoute("https://trusted.example/app", { allHeaders: async () => ({}) }));
    expect(sentHeaders()).toEqual({ cookie: "sid=x" });
  });

  // #22: fulfilling at the requested URL leaves the document URL at /start, so
  // "main.js" resolves to /main.js. The final URL must be navigated to instead.
  it("#22 does not fulfil a same-origin redirect at the requested URL", async () => {
    const { ctx, blocked } = await install();
    const cancel = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "/app/index.html"));
    mockFetch.mockResolvedValueOnce({ ...okResponse('<html><script src="main.js"></script></html>'), body: { cancel } });

    const route = documentRoute("https://trusted.example/start");
    await ctx.routeHandler!(route);

    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.reason).toContain("https://trusted.example/app/index.html");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("#22 a document that did not redirect is still fulfilled at its own URL", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("<html>home</html>"));
    const route = documentRoute("https://trusted.example/app/index.html");
    await ctx.routeHandler!(route);
    expect(route.abort).not.toHaveBeenCalled();
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    expect(route.fulfill.mock.calls[0]![0].body.toString("utf8")).toBe("<html>home</html>");
  });
});

// ── Codex round 8 #21/#22 at the navigate action: credentials are scoped to the
// origin they were given for, and a same-origin redirect restarts there ──

interface FakeNavSession {
  browser: { close: () => Promise<void> };
  context: { close: () => Promise<void> };
  page: {
    goto: ReturnType<typeof vi.fn>;
    url: () => string;
    title: () => Promise<string>;
    setExtraHTTPHeaders: ReturnType<typeof vi.fn>;
  };
  createdAt: number;
  lastUsed: number;
  crossOriginRedirects: Map<string, string>;
  sameOriginRedirects: Map<string, string>;
  credentials: { current?: OriginCredentials };
  policyInstalled: boolean;
  vettedDocument: { current?: unknown };
}

describe("BrowserAutomationTool.navigate — Codex round 8 #21/#22", () => {
  let tool: BrowserAutomationTool;
  const context: ToolContext = { projectPath: "/tmp/test", workingDirectory: "/tmp/test-nav", readOnly: false };

  beforeEach(() => {
    tool = new BrowserAutomationTool();
  });

  afterAll(async () => {
    await tool?.dispose();
  });

  /** A session state the navigate handler can drive without a real browser. */
  function fakeSession(goto: (url: string) => Promise<void>): FakeNavSession {
    let current = "about:blank";
    const session: FakeNavSession = {
      browser: { close: async () => undefined },
      context: { close: async () => undefined },
      page: {
        goto: vi.fn(async (url: string) => {
          await goto(url);
          current = url;
        }),
        url: () => current,
        title: async () => "T",
        setExtraHTTPHeaders: vi.fn(async (_headers: Record<string, string>) => undefined),
      },
      createdAt: Date.now(),
      lastUsed: Date.now(),
      crossOriginRedirects: new Map(),
      sameOriginRedirects: new Map(),
      credentials: {},
      policyInstalled: true,
      vettedDocument: {},
    };
    (tool as unknown as { sessions: Map<string, unknown> }).sessions.set(context.workingDirectory, session);
    return session;
  }

  function appliedHeaders(session: FakeNavSession): Array<Record<string, string>> {
    return session.page.setExtraHTTPHeaders.mock.calls.map((c) => c[0] as Record<string, string>);
  }

  // #21/round 9 #11: setExtraHTTPHeaders is persistent AND page-wide, so the
  // Authorization given for trusted.example rode along to the origin the
  // redirect recovery suggested AND to every sub-resource the page fetched.
  // The page-wide set is now always empty; the credentials are handed to the
  // network policy, which adds them to the requests that belong to the origin.
  it("#21/#11 never installs credentials page-wide, and remembers the origin they belong to", async () => {
    const session = fakeSession(async () => undefined);

    const first = await tool.execute(
      { action: "navigate", url: "https://trusted.example/app", headers: { Authorization: "Bearer t" } },
      context,
    );
    expect(first.isError).toBeFalsy();
    expect(session.credentials.current).toEqual({
      origin: "https://trusted.example",
      headers: { Authorization: "Bearer t" },
    });

    const second = await tool.execute({ action: "navigate", url: "https://other.example/landing" }, context);
    expect(second.isError).toBeFalsy();

    // Every page-wide application is empty, on both navigations.
    for (const applied of appliedHeaders(session)) expect(applied).toEqual({});
    // And the credentials stay bound to the origin they were given for.
    expect(credentialHeadersForRequest(session.credentials.current, "https://other.example/landing", "none")).toBeUndefined();
  });

  it("#21 the origin's credentials still reach a same-origin navigation", async () => {
    const session = fakeSession(async () => undefined);
    await tool.execute(
      { action: "navigate", url: "https://trusted.example/app", headers: { Authorization: "Bearer t" } },
      context,
    );
    await tool.execute({ action: "navigate", url: "https://trusted.example/other" }, context);
    expect(
      credentialHeadersForRequest(session.credentials.current, "https://trusted.example/other", "none"),
    ).toEqual({ Authorization: "Bearer t" });
  });

  // #22 recovery: the policy refused the fulfil at the old URL and named the
  // final one; navigate goes there itself, under the same policy.
  it("#22 restarts the navigation at the final URL of a same-origin redirect", async () => {
    let session: FakeNavSession;
    session = fakeSession(async (url) => {
      if (url === "https://trusted.example/start") {
        session.sameOriginRedirects.set("https://trusted.example/start", "https://trusted.example/app/index.html");
        throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
      }
    });

    const result = await tool.execute({ action: "navigate", url: "https://trusted.example/start" }, context);

    expect(result.isError).toBeFalsy();
    expect(session.page.goto.mock.calls.map((c) => c[0])).toEqual([
      "https://trusted.example/start",
      "https://trusted.example/app/index.html",
    ]);
    expect(result.content).toContain("https://trusted.example/app/index.html");
  });

  it("#22 a same-origin restart still runs the URL policy (blocked patterns)", async () => {
    let session: FakeNavSession;
    session = fakeSession(async (url) => {
      if (url === "https://trusted.example/start") {
        session.sameOriginRedirects.set("https://trusted.example/start", "https://trusted.example/admin/dump");
        throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
      }
    });

    const result = await tool.execute({ action: "navigate", url: "https://trusted.example/start" }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked pattern");
    expect(session.page.goto).toHaveBeenCalledTimes(1);
  });

  it("#22 a redirect that keeps redirecting is bounded, not looped", async () => {
    let session: FakeNavSession;
    let n = 0;
    session = fakeSession(async (url) => {
      session.sameOriginRedirects.set(url, `https://trusted.example/hop${++n}`);
      throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
    });

    const result = await tool.execute({ action: "navigate", url: "https://trusted.example/start" }, context);

    expect(result.isError).toBe(true);
    expect(session.page.goto.mock.calls.length).toBeLessThanOrEqual(5);
  });

  // The opposite direction: a cross-origin redirect is reported, never followed.
  it("#22 a cross-origin redirect is reported and not followed", async () => {
    let session: FakeNavSession;
    session = fakeSession(async (url) => {
      if (url === "https://trusted.example/start") {
        session.crossOriginRedirects.set("https://trusted.example/start", "https://other.example/landing");
        throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
      }
    });

    const result = await tool.execute({ action: "navigate", url: "https://trusted.example/start" }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigate to https://other.example/landing explicitly");
    expect(session.page.goto).toHaveBeenCalledTimes(1);
  });
});

// ── Codex round 9 (2026-09-17) #11: the agent's credentials are injected per
// REQUEST for the origin they belong to. `setExtraHTTPHeaders` installs them on
// the PAGE, so an image, iframe, clicked link or scripted navigation to another
// origin carried them — none of those pass through handleNavigate's reset. ──

describe("installNetworkPolicy — Codex round 9 #11 (per-request credentials)", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("trusted.example", [{ address: PUBLIC_V4, family: 4 }]);
    table.set("evil.trusted.example", [{ address: "151.101.1.1", family: 4 }]);
    table.set("other.example", [{ address: "151.101.1.2", family: 4 }]);
  });

  const CREDENTIALS: OriginCredentials = {
    origin: "https://trusted.example",
    headers: { Authorization: "Bearer secret" },
  };

  async function install(credentials: OriginCredentials | null = CREDENTIALS) {
    const ctx = fakeContext();
    const page = fakePage();
    await installNetworkPolicy(ctx, page, {
      resolver,
      onForbiddenNavigation: vi.fn(),
      originCredentials: () => credentials ?? undefined,
    });
    return { ctx, page };
  }

  function continuedHeaders(route: ReturnType<typeof fakeRoute>): Record<string, string> | undefined {
    const options = route.continue.mock.calls[0]?.[0] as { headers?: Record<string, string> } | undefined;
    return options?.headers;
  }

  // The leaking half: a page-initiated request to ANOTHER origin must not carry
  // the credentials the agent gave for the first one.
  it("#11 a cross-origin image, frame or script carries no credentials", async () => {
    for (const resourceType of ["image", "stylesheet", "script", "xhr"]) {
      const { ctx } = await install();
      const route = fakeRoute("https://other.example/pixel.gif", {
        resourceType: () => resourceType,
        allHeaders: async () => ({ "user-agent": "UA/1", "sec-fetch-site": "cross-site" }),
      });
      await ctx.routeHandler!(route);
      expect(route.continue, resourceType).toHaveBeenCalledTimes(1);
      expect(continuedHeaders(route)?.["Authorization"], resourceType).toBeUndefined();
    }
  });

  it("#11 a cross-origin iframe document carries no credentials", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("<html>frame</html>"));
    await ctx.routeHandler!(
      documentRoute("https://other.example/frame.html", {
        allHeaders: async () => ({ "user-agent": "UA/1", "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" }),
      }),
    );
    const sent = (mockFetch.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(sent["Authorization"]).toBeUndefined();
  });

  // A subdomain is another ORIGIN: the credentials were given for one origin.
  it("#11 a sibling/subdomain origin carries no credentials", async () => {
    const { ctx } = await install();
    const route = fakeRoute("https://evil.trusted.example/pixel.gif", {
      resourceType: () => "image",
      allHeaders: async () => ({ "sec-fetch-site": "same-site" }),
    });
    await ctx.routeHandler!(route);
    expect(continuedHeaders(route)?.["Authorization"]).toBeUndefined();
  });

  // A tool-initiated navigation (Sec-Fetch-Site: none) to another origin: the
  // initiator check does not apply, so only the origin check can withhold them.
  it("#11 a tool-initiated navigation to another origin carries no credentials", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("<html>landing</html>"));
    await ctx.routeHandler!(
      documentRoute("https://other.example/landing", {
        allHeaders: async () => ({ "user-agent": "UA/1", "sec-fetch-site": "none", "sec-fetch-dest": "document" }),
      }),
    );
    const sent = (mockFetch.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(sent["Authorization"]).toBeUndefined();
  });

  // Narrower than the page-wide set was: a request another SITE initiated does
  // not carry the credentials even when it targets their origin.
  it("#11 a cross-site initiator carries no credentials even when it targets the credential origin", async () => {
    const { ctx } = await install();
    const route = fakeRoute("https://trusted.example/logo.png", {
      resourceType: () => "image",
      allHeaders: async () => ({ "sec-fetch-site": "cross-site" }),
    });
    await ctx.routeHandler!(route);
    expect(continuedHeaders(route)?.["Authorization"]).toBeUndefined();
  });

  // The guard: correct traffic keeps working. A same-origin sub-resource still
  // gets the credentials — since round 10 #1 through the policy transport rather
  // than a `continue` override, because an override rides along Chromium's own
  // redirect following and those hops never come back to the handler.
  it("#11 a same-origin sub-resource still carries the credentials", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("PNGDATA"));
    const route = fakeRoute("https://trusted.example/logo.png", {
      resourceType: () => "image",
      allHeaders: async () => ({ "user-agent": "UA/1", "sec-fetch-site": "same-origin" }),
    });
    await ctx.routeHandler!(route);
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    expect(route.fulfill.mock.calls[0]![0].body.toString()).toBe("PNGDATA");
    const sent = (mockFetch.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(sent["Authorization"]).toBe("Bearer secret");
    expect(sent["user-agent"]).toBe("UA/1");
  });

  it("#11 the document request for the credential origin carries them", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("<html>ok</html>"));
    await ctx.routeHandler!(
      documentRoute("https://trusted.example/app", {
        allHeaders: async () => ({ "user-agent": "UA/1", "sec-fetch-site": "none", "sec-fetch-dest": "document" }),
      }),
    );
    const sent = (mockFetch.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(sent["Authorization"]).toBe("Bearer secret");
  });

  it("#11 no credentials configured leaves every request untouched", async () => {
    const { ctx } = await install(null);
    const route = fakeRoute("https://trusted.example/logo.png", { resourceType: () => "image" });
    await ctx.routeHandler!(route);
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.continue.mock.calls[0]?.[0]).toBeUndefined();
  });
});

// ── Codex round 10 #1: a `continue` override is carried through Chromium's own
// redirect following, and those hops never reach the route handler. A
// credential-bearing SUB-RESOURCE that answered "302 https://other.example/…"
// therefore handed the header to that other origin: the initial origin check had
// passed, and the post-hoc response listener only sees the chain afterwards. The
// credentialed sub-resource is fetched by the same hop-by-hop transport the
// documents use, so every hop's OUTBOUND HEADERS are ours to observe — this is
// no longer an assertion about what Playwright does with an override. ──

describe("installNetworkPolicy — Codex round 10 #1 (credentialed sub-resource redirects)", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("trusted.example", [{ address: PUBLIC_V4, family: 4 }]);
    table.set("other.example", [{ address: "151.101.1.2", family: 4 }]);
  });

  /** The finding's own credential: a custom header the RFC strip knows nothing about. */
  const API_KEY: OriginCredentials = {
    origin: "https://trusted.example",
    headers: { "X-Api-Key": "k-live-0001" },
  };

  async function install(credentials: OriginCredentials = API_KEY) {
    const ctx = fakeContext();
    const blocked: Array<{ url: string; reason: string }> = [];
    await installNetworkPolicy(ctx, fakePage(), {
      resolver,
      onForbiddenNavigation: vi.fn(),
      onBlockedRequest: (url, reason) => blocked.push({ url, reason }),
      originCredentials: () => credentials,
    });
    return { ctx, blocked };
  }

  function subresource(url: string, extra: Record<string, string> = {}, resourceType = "image") {
    return fakeRoute(url, {
      resourceType: () => resourceType,
      allHeaders: async () => ({ "user-agent": "UA/1", "sec-fetch-site": "same-origin", ...extra }),
    });
  }

  /** The headers each hop actually went out with. */
  function hopHeaders(): Array<Record<string, string>> {
    return mockFetch.mock.calls.map((c) => (c[1] as { headers: Record<string, string> }).headers);
  }

  // THE FINDING: origin A's /resource, fetched with A's key, answers a redirect
  // to origin B. B must not see the key.
  it("#1 a sub-resource redirected to another origin does not hand over the credential", async () => {
    const { ctx, blocked } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "https://other.example/collect"));
    mockFetch.mockResolvedValueOnce(okResponse("tracked"));

    const route = subresource("https://trusted.example/resource", {}, "xhr");
    await ctx.routeHandler!(route);

    const hops = hopHeaders();
    expect(hops).toHaveLength(2);
    expect(hops[0]!["X-Api-Key"]).toBe("k-live-0001");
    // The hop that left the origin: no credential, in any casing.
    for (const name of Object.keys(hops[1]!)) expect(name.toLowerCase()).not.toBe("x-api-key");
    // Nothing from the other origin is delivered as the requested URL either —
    // the browser re-issues the request itself, with no override to carry.
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.continue.mock.calls[0]?.[0]).toBeUndefined();
    expect(blocked.map((b) => b.reason).join(" ")).toContain("another origin");
  });

  // The document half of the same defect: fetchWithPolicy's cross-origin strip
  // only knows authorization / proxy-authorization / cookie, so a custom
  // credential in the chain-wide headers was SENT on the foreign hop before the
  // chain was refused. It is supplied per hop now.
  it("#1 a document redirected to another origin does not hand over the credential either", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "https://other.example/landing"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>landing</html>"));

    await ctx.routeHandler!(
      documentRoute("https://trusted.example/start", {
        allHeaders: async () => ({ "user-agent": "UA/1", "sec-fetch-site": "none", "sec-fetch-dest": "document" }),
      }),
    );

    const hops = hopHeaders();
    expect(hops[0]!["X-Api-Key"]).toBe("k-live-0001");
    for (const name of Object.keys(hops[1] ?? {})) expect(name.toLowerCase()).not.toBe("x-api-key");
  });

  // ── Guards: the traffic this must not break ──

  it("#1 a same-origin redirect keeps the credential and delivers the body", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "https://trusted.example/logo-v2.png"));
    mockFetch.mockResolvedValueOnce(okResponse("PNG-V2", { "x-served-by": "cdn", "content-encoding": "gzip" }));

    const route = subresource("https://trusted.example/logo.png");
    await ctx.routeHandler!(route);

    const hops = hopHeaders();
    expect(hops).toHaveLength(2);
    expect(hops[0]!["X-Api-Key"]).toBe("k-live-0001");
    expect(hops[1]!["X-Api-Key"]).toBe("k-live-0001");
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    expect(route.fulfill.mock.calls[0]![0].body.toString()).toBe("PNG-V2");
    // Wire-form response headers are dropped; the body handed over is decoded.
    expect(route.fulfill.mock.calls[0]![0].headers).toEqual({ "content-type": "text/html", "x-served-by": "cdn" });
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("#1 a sub-resource that is not the credential origin's is still a plain continue", async () => {
    const { ctx } = await install();
    const route = subresource("https://other.example/pixel.gif", { "sec-fetch-site": "cross-site" });
    await ctx.routeHandler!(route);
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.continue.mock.calls[0]?.[0]).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("#1 a body too large to buffer is re-issued by the browser without the credential", async () => {
    const { ctx, blocked } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("small but lying", { "content-length": String(64 * 1024 * 1024) }));

    const route = subresource("https://trusted.example/4k-trailer.mp4", {}, "media");
    await ctx.routeHandler!(route);

    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.continue.mock.calls[0]?.[0]).toBeUndefined();
    expect(blocked.map((b) => b.reason).join(" ")).toContain("without credentials");
  });

  // An unsafe method cannot be handed back: re-issuing a POST is not ours to do
  // twice. It is refused instead — and only when the chain actually left the
  // origin; a POST that stays put is delivered.
  it("#1 a credentialed POST that leaves the origin is aborted, not replayed", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(307, "https://other.example/collect"));
    mockFetch.mockResolvedValueOnce(okResponse("collected"));

    const route = fakeRoute("https://trusted.example/api/order", {
      resourceType: () => "xhr",
      method: () => "POST",
      postDataBuffer: () => Buffer.from('{"qty":1}'),
      allHeaders: async () => ({ "sec-fetch-site": "same-origin", "content-type": "application/json" }),
    });
    await ctx.routeHandler!(route);

    for (const name of Object.keys(hopHeaders()[1] ?? {})) expect(name.toLowerCase()).not.toBe("x-api-key");
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.abort).toHaveBeenCalledWith("failed");
  });

  it("#1 a credentialed POST that stays on the origin is delivered", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse('{"ok":true}'));

    const route = fakeRoute("https://trusted.example/api/order", {
      resourceType: () => "xhr",
      method: () => "POST",
      postDataBuffer: () => Buffer.from('{"qty":1}'),
      allHeaders: async () => ({ "sec-fetch-site": "same-origin", "content-type": "application/json" }),
    });
    await ctx.routeHandler!(route);

    expect(mockFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
    expect(hopHeaders()[0]!["X-Api-Key"]).toBe("k-live-0001");
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    expect(route.fulfill.mock.calls[0]![0].body.toString()).toBe('{"ok":true}');
  });

  it("#1 a forbidden hop in a credentialed sub-resource chain is refused at the hop", async () => {
    table.set("internal.corp", [{ address: "10.0.0.5", family: 4 }]);
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "http://internal.corp/admin"));
    mockFetch.mockResolvedValueOnce(okResponse("SHOULD NOT BE FETCHED"));

    const route = subresource("https://trusted.example/resource", {}, "xhr");
    await ctx.routeHandler!(route);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it("#1 the jar gets the cookies a credentialed sub-resource hop set", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(okResponse("PNG", { "set-cookie": "sid=abc; Path=/" }));

    await ctx.routeHandler!(subresource("https://trusted.example/logo.png"));

    expect(ctx.addCookies).toHaveBeenCalledTimes(1);
    expect(ctx.jar[0]).toMatchObject({ name: "sid", value: "abc", domain: "trusted.example" });
  });
});

// ── Codex round 9 #12: the SameSite "site" is schemeful and stops at the
// registrable domain. Comparing hostnames alone let a non-Secure Strict cookie
// follow an https -> http redirect on the same host, and treated a public
// suffix (github.io, co.uk) as if it were a site of its own. ──

describe("isSameSiteUrl — Codex round 9 #12", () => {
  // Schemeful same-site: http and https are DIFFERENT sites, so a non-Secure
  // Strict cookie must not survive a downgrade to http on the same host.
  it("#12 a scheme change is a site change", () => {
    expect(isSameSiteUrl("http://trusted.example/next", "https://trusted.example/start")).toBe(false);
    expect(isSameSiteUrl("https://trusted.example/next", "http://trusted.example/start")).toBe(false);
    expect(isSameSiteUrl("http://trusted.example/next", "http://trusted.example/start")).toBe(true);
  });

  // Public-suffix boundary: github.io is not a site, so foo.github.io and
  // github.io (or bar.github.io) are cross-site — a browser says the same.
  it("#12 a public suffix is not a site of its own", () => {
    expect(isSameSiteUrl("https://foo.github.io/a", "https://github.io/b")).toBe(false);
    expect(isSameSiteUrl("https://github.io/b", "https://foo.github.io/a")).toBe(false);
    expect(isSameSiteUrl("https://shop.example.co.uk/a", "https://example.co.uk/b")).toBe(true);
    expect(isSameSiteUrl("https://example.co.uk/a", "https://co.uk/b")).toBe(false);
    expect(isSameSiteUrl("https://example.com/a", "https://com/b")).toBe(false);
    expect(isSameSiteUrl("https://bucket.s3.amazonaws.com/a", "https://s3.amazonaws.com/b")).toBe(false);
  });

  it("#12 isLikelyPublicSuffix classifies the ancestors the rule depends on", () => {
    for (const host of ["com", "uk", "co.uk", "com.au", "ac.uk", "github.io", "vercel.app", "s3.amazonaws.com"]) {
      expect(isLikelyPublicSuffix(host), host).toBe(true);
    }
    for (const host of ["example.com", "example.co.uk", "foo.github.io", "trusted.example", "a.b.example.com"]) {
      expect(isLikelyPublicSuffix(host), host).toBe(false);
    }
  });

  // The guard: correct traffic still counts as same-site.
  it("#12 a registrable domain and its subdomains are one site", () => {
    expect(isSameSiteUrl("https://www.example.com/a", "https://example.com/b")).toBe(true);
    expect(isSameSiteUrl("https://example.com/a", "https://deep.www.example.com/b")).toBe(true);
    expect(isSameSiteUrl("https://trusted.example/a", "https://trusted.example/b")).toBe(true);
    expect(isSameSiteUrl("https://a.example.com:8443/a", "https://example.com/b")).toBe(true);
  });

  // Documented narrowing: no public-suffix list is available offline, so
  // siblings under one registrable domain are treated as cross-site. A browser
  // calls them same-site; withholding a cookie is the safe direction.
  it("#12 sibling subdomains stay cross-site (narrower than a browser, by choice)", () => {
    expect(isSameSiteUrl("https://a.example.com/x", "https://b.example.com/y")).toBe(false);
  });

  it("#12 a garbage URL is never same-site", () => {
    expect(isSameSiteUrl("not a url", "https://trusted.example/")).toBe(false);
    expect(isSameSiteUrl("https://trusted.example/", "not a url")).toBe(false);
  });
});

describe("installNetworkPolicy — Codex round 9 #12/#13 at the hop", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("trusted.example", [{ address: PUBLIC_V4, family: 4 }]);
  });

  async function install() {
    const ctx = fakeContext();
    const page = fakePage();
    await installNetworkPolicy(ctx, page, { resolver, onForbiddenNavigation: vi.fn(), onBlockedRequest: vi.fn() });
    return { ctx };
  }

  function jar(ctx: FakeContext, cookies: Array<Record<string, unknown>>): void {
    (ctx.cookies as ReturnType<typeof vi.fn>).mockImplementation(async () => cookies);
  }

  function sentHeaders(call: number): Record<string, string> {
    return (mockFetch.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers;
  }

  // #12: an https document redirected to http on the SAME host is a site
  // change, so a non-Secure Strict cookie must not travel on the second hop.
  it("#12 a Strict cookie does not follow an https -> http redirect on the same host", async () => {
    const { ctx } = await install();
    jar(ctx, [
      { name: "strict", value: "1", domain: "trusted.example", path: "/", sameSite: "Strict" },
      { name: "lax", value: "2", domain: "trusted.example", path: "/", sameSite: "Lax" },
    ]);
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "http://trusted.example/next"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>next</html>"));

    await ctx.routeHandler!(
      documentRoute("https://trusted.example/start", {
        allHeaders: async () => ({ "sec-fetch-site": "none", "sec-fetch-dest": "document" }),
      }),
    );

    expect(sentHeaders(0)["cookie"]).toBe("strict=1; lax=2");
    // Second hop: another site, and a safe top-level navigation -> Lax only.
    expect(sentHeaders(1)["cookie"]).toBe("lax=2");
  });

  // #13: fetchWithPolicy turns the POST into a GET at a 303, so the landing
  // request is a safe top-level navigation and its Lax cookie is eligible. The
  // cookie context used to keep the ORIGINAL method and withheld it.
  it("#13 a cross-site POST -> 303 -> GET landing receives the Lax cookie", async () => {
    const { ctx } = await install();
    jar(ctx, [{ name: "lax", value: "2", domain: "trusted.example", path: "/", sameSite: "Lax" }]);
    mockFetch.mockResolvedValueOnce(redirectResponse(303, "/landing"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>landing</html>"));

    await ctx.routeHandler!(
      documentRoute("https://trusted.example/submit", {
        method: () => "POST",
        postDataBuffer: () => Buffer.from("x=1"),
        allHeaders: async () => ({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" }),
      }),
    );

    expect(sentHeaders(0)["cookie"]).toBeUndefined(); // the POST itself: unsafe method
    expect(sentHeaders(1)["cookie"]).toBe("lax=2"); // the GET the 303 produced
    expect(mockFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "GET" }));
  });

  // The opposite direction: a 307 preserves the method, so the second hop is
  // still an unsafe cross-site POST and the Lax cookie stays home.
  it("#13 a cross-site POST -> 307 -> POST receives no Lax cookie", async () => {
    const { ctx } = await install();
    jar(ctx, [{ name: "lax", value: "2", domain: "trusted.example", path: "/", sameSite: "Lax" }]);
    mockFetch.mockResolvedValueOnce(redirectResponse(307, "/landing"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>landing</html>"));

    await ctx.routeHandler!(
      documentRoute("https://trusted.example/submit", {
        method: () => "POST",
        postDataBuffer: () => Buffer.from("x=1"),
        allHeaders: async () => ({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" }),
      }),
    );

    expect(sentHeaders(0)["cookie"]).toBeUndefined();
    expect(sentHeaders(1)["cookie"]).toBeUndefined();
    expect(mockFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
  });
});

// ── Codex round 9 #14: the vetted response of a refused same-origin redirect is
// kept and delivered at the restart, and a click- or form-initiated navigation
// gets the same recovery a `navigate` action does. ──

describe("installNetworkPolicy — Codex round 9 #14 (the vetted response is reused)", () => {
  const table = new Map<string, ResolvedAddress[]>();
  const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const hit = table.get(hostname);
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  });

  beforeEach(() => {
    table.clear();
    resolver.mockClear();
    table.set("trusted.example", [{ address: PUBLIC_V4, family: 4 }]);
    table.set("other.example", [{ address: "151.101.1.2", family: 4 }]);
  });

  /** The session's single-slot stash, wired exactly as the tool wires it. */
  async function install() {
    const ctx = fakeContext();
    const page = fakePage();
    const slot: { current?: { url: string; document: VettedDocument; storedAt: number } } = {};
    const reported: Array<{ url: string; finalUrl: string; hasDocument: boolean }> = [];
    await installNetworkPolicy(ctx, page, {
      resolver,
      onForbiddenNavigation: vi.fn(),
      onBlockedRequest: vi.fn(),
      onSameOriginRedirect: (url, finalUrl, document) => {
        reported.push({ url, finalUrl, hasDocument: document !== undefined });
        slot.current = document ? { url: finalUrl, document, storedAt: Date.now() } : undefined;
      },
      takeVettedDocument: (url) => takeVettedDocument(slot, url),
    });
    return { ctx, slot, reported };
  }

  // The receipt is single-use: the policy fetch spent it, so asking again gets
  // 410. The kept response must be what the restart delivers.
  it("#14 a single-use destination is requested once and its vetted body is delivered at the restart", async () => {
    const { ctx, reported } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "/receipt/once"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>receipt</html>", { "x-served-by": "app" }));

    const start = documentRoute("https://trusted.example/start");
    await ctx.routeHandler!(start);
    expect(start.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(reported).toEqual([
      { url: "https://trusted.example/start", finalUrl: "https://trusted.example/receipt/once", hasDocument: true },
    ]);

    // What the restart would get if it asked again: gone.
    mockFetch.mockResolvedValueOnce({ ...okResponse("GONE — MUST NOT BE FETCHED"), ok: false, status: 410 });
    const restart = documentRoute("https://trusted.example/receipt/once");
    await ctx.routeHandler!(restart);

    expect(mockFetch).toHaveBeenCalledTimes(2); // no second request for the receipt
    expect(restart.abort).not.toHaveBeenCalled();
    expect(restart.fulfill).toHaveBeenCalledTimes(1);
    const fulfilled = restart.fulfill.mock.calls[0]![0];
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.toString("utf8")).toBe("<html>receipt</html>");
    expect(fulfilled.headers).toEqual({ "content-type": "text/html", "x-served-by": "app" });
  });

  it("#14 the kept response is delivered once; a later request for the same URL is fetched", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "/receipt/once"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>receipt</html>"));
    await ctx.routeHandler!(documentRoute("https://trusted.example/start"));

    await ctx.routeHandler!(documentRoute("https://trusted.example/receipt/once"));
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockResolvedValueOnce(okResponse("<html>fresh</html>"));
    const again = documentRoute("https://trusted.example/receipt/once");
    await ctx.routeHandler!(again);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(again.fulfill.mock.calls[0]![0].body.toString("utf8")).toBe("<html>fresh</html>");
  });

  it("#14 the kept response is only delivered at its own URL", async () => {
    const { ctx, slot } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "/receipt/once"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>receipt</html>"));
    await ctx.routeHandler!(documentRoute("https://trusted.example/start"));
    expect(slot.current?.url).toBe("https://trusted.example/receipt/once");

    mockFetch.mockResolvedValueOnce(okResponse("<html>elsewhere</html>"));
    const other = documentRoute("https://trusted.example/elsewhere");
    await ctx.routeHandler!(other);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(other.fulfill.mock.calls[0]![0].body.toString("utf8")).toBe("<html>elsewhere</html>");
  });

  // A cross-origin chain keeps the round 7 #13 behaviour: nothing is kept, the
  // agent must navigate to the other origin itself under its own context.
  it("#14 a cross-origin redirect keeps nothing", async () => {
    const { ctx, slot, reported } = await install();
    const cancel = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce(redirectResponse(302, "https://other.example/landing"));
    mockFetch.mockResolvedValueOnce({ ...okResponse("<html>landing</html>"), body: { cancel } });

    await ctx.routeHandler!(documentRoute("https://trusted.example/start"));
    expect(reported).toEqual([]);
    expect(slot.current).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserAutomationTool.click — Codex round 9 #14", () => {
  let tool: BrowserAutomationTool;
  const context: ToolContext = { projectPath: "/tmp/test", workingDirectory: "/tmp/test-click", readOnly: false };

  beforeEach(() => {
    tool = new BrowserAutomationTool();
  });

  afterAll(async () => {
    await tool?.dispose();
  });

  /** A session whose click can trigger a policy-refused document redirect. */
  function fakeSession(onClick: (session: FakeClickSession) => void | Promise<void>) {
    let current = "https://trusted.example/start";
    const session = {
      browser: { close: async () => undefined },
      context: { close: async () => undefined },
      page: {
        click: vi.fn(async (_selector: string) => {
          await onClick(session);
        }),
        goto: vi.fn(async (url: string) => {
          current = url;
        }),
        waitForLoadState: vi.fn(async () => undefined),
        url: () => current,
        title: async () => "T",
        setExtraHTTPHeaders: vi.fn(async () => undefined),
      },
      createdAt: Date.now(),
      lastUsed: Date.now(),
      crossOriginRedirects: new Map<string, string>(),
      sameOriginRedirects: new Map<string, string>(),
      credentials: {},
      policyInstalled: true,
      vettedDocument: {} as { current?: unknown },
    };
    (tool as unknown as { sessions: Map<string, unknown> }).sessions.set(context.workingDirectory, session);
    return session;
  }
  type FakeClickSession = ReturnType<typeof fakeSession>;

  // The clicked link's document was aborted by the policy and handleClick never
  // looked at the redirect map, so the page stayed on an error with no recovery.
  it("#14 a clicked link whose same-origin redirect was refused commits the final document", async () => {
    const session = fakeSession((s) => {
      s.sameOriginRedirects.set("https://trusted.example/start", "https://trusted.example/app/index.html");
    });

    const result = await tool.execute({ action: "click", selector: "a#go" }, context);

    expect(result.isError).toBeFalsy();
    expect(session.page.goto.mock.calls.map((c) => c[0])).toEqual(["https://trusted.example/app/index.html"]);
    expect(result.content).toContain("https://trusted.example/app/index.html");
    expect(result.metadata).toEqual(expect.objectContaining({ url: "https://trusted.example/app/index.html" }));
  });

  it("#14 a submitted form's same-origin redirect is recovered the same way", async () => {
    const session = fakeSession((s) => {
      s.sameOriginRedirects.set("https://trusted.example/submit", "https://trusted.example/receipt/once");
    });

    const result = await tool.execute({ action: "click", selector: "button[type=submit]" }, context);

    expect(result.isError).toBeFalsy();
    expect(session.page.goto).toHaveBeenCalledWith("https://trusted.example/receipt/once", expect.anything());
  });

  it("#14 a clicked link that left the origin is reported, not followed", async () => {
    const session = fakeSession((s) => {
      s.crossOriginRedirects.set("https://trusted.example/start", "https://other.example/landing");
    });

    const result = await tool.execute({ action: "click", selector: "a#go" }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigate to https://other.example/landing explicitly");
    expect(session.page.goto).not.toHaveBeenCalled();
  });

  it("#14 the recovery target still runs the URL policy", async () => {
    const session = fakeSession((s) => {
      s.sameOriginRedirects.set("https://trusted.example/start", "https://trusted.example/admin/dump");
    });

    const result = await tool.execute({ action: "click", selector: "a#go" }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked pattern");
    expect(session.page.goto).not.toHaveBeenCalled();
  });

  // The guard: an ordinary click is unchanged — no navigation of our own.
  it("#14 a click with no refused redirect behaves as before", async () => {
    const session = fakeSession(() => undefined);
    const result = await tool.execute({ action: "click", selector: "a#go" }, context);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("Clicked element: a#go");
    expect(session.page.goto).not.toHaveBeenCalled();
  });
});
