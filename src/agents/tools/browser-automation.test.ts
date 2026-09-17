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
  parseSetCookie,
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
}

interface FakePage extends PolicyPage {
  listeners: Record<string, Array<(frame: { url(): string }) => void>>;
}

function fakeContext(): FakeContext {
  const ctx: FakeContext = {
    jar: [],
    responseListeners: [],
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
    on: vi.fn((_event: "response", listener: (response: PolicyResponse) => void) => {
      ctx.responseListeners.push(listener);
      return ctx;
    }),
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
    expect(onSameOriginRedirect).toHaveBeenCalledWith(
      "https://trusted.example/start",
      "https://trusted.example/login?next=%2Fstart",
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
  // gets the credentials — now added to THAT request rather than to the page.
  it("#11 a same-origin sub-resource still carries the credentials", async () => {
    const { ctx } = await install();
    const route = fakeRoute("https://trusted.example/logo.png", {
      resourceType: () => "image",
      allHeaders: async () => ({ "user-agent": "UA/1", "sec-fetch-site": "same-origin" }),
    });
    await ctx.routeHandler!(route);
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(continuedHeaders(route)).toEqual({
      "user-agent": "UA/1",
      "sec-fetch-site": "same-origin",
      Authorization: "Bearer secret",
    });
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
