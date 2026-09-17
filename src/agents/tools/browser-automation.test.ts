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
  installNetworkPolicy,
  type PolicyContext,
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
    responseListeners: [],
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
    headers: () => ({}),
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

  it("#11 fulfils a document request with the vetted final response of a public->public chain (never route.continue)", async () => {
    const { ctx } = await install();
    mockFetch.mockResolvedValueOnce(redirectResponse(301, "https://cdn.example/final"));
    mockFetch.mockResolvedValueOnce(okResponse("<html>final</html>", { "content-encoding": "gzip", "x-served-by": "cdn" }));

    const route = documentRoute("https://public.example/start", {
      method: () => "GET",
      headers: () => ({ "user-agent": "UA/1", "accept-encoding": "gzip, br, zstd", host: "public.example" }),
    });
    await ctx.routeHandler!(route);

    expect(route.continue).not.toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    const fulfilled = route.fulfill.mock.calls[0]![0];
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.toString("utf8")).toBe("<html>final</html>");
    expect(fulfilled.headers).toEqual({ "content-type": "text/html", "x-served-by": "cdn" }); // wire-form headers dropped
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[0]).toBe("https://cdn.example/final");
    // Every hop is pinned to its own vetted Agent; the browser's headers are
    // forwarded minus connection/encoding ones.
    expect(agentInstances).toHaveLength(2);
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
