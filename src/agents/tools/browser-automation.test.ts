import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// DNS is mocked so the resolved-target policy (plan 0-B.6 / 4.6) runs without
// the network. Unknown hosts resolve to a public address.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));

import {
  BrowserAutomationTool,
  installNetworkPolicy,
  type PolicyContext,
  type PolicyPage,
  type PolicyRoute,
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
  mockLookup.mockImplementation(async (hostname: string) => dnsTable.get(hostname) ?? [{ address: PUBLIC_V4, family: 4 }]);
});

// ── Plan 4.6 (audit 13F2 / D64): every browser request and navigation is checked ──

interface FakeContext extends PolicyContext {
  routePattern?: string;
  routeHandler?: (route: PolicyRoute) => Promise<void> | void;
}

interface FakePage extends PolicyPage {
  listeners: Record<string, Array<(frame: { url(): string }) => void>>;
}

function fakeContext(): FakeContext {
  const ctx: FakeContext = {
    route: vi.fn(async (pattern: string, handler: (route: PolicyRoute) => Promise<void> | void) => {
      ctx.routePattern = pattern;
      ctx.routeHandler = handler;
    }),
  };
  return ctx;
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

function fakeRoute(url: string) {
  return {
    request: () => ({ url: () => url }),
    continue: vi.fn(async () => undefined),
    abort: vi.fn(async (_code?: string) => undefined),
  };
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
