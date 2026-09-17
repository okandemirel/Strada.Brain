/**
 * Plan 4.6 / audit 13F2, bypass (a): the network policy is only as wide as the
 * route it installs, and service-worker requests never reach `context.route`
 * (Playwright's own note on `page.route` / `browserContext.route`,
 * microsoft/playwright#1090). A context created with the default
 * `serviceWorkers: "allow"` therefore had a network path with NO policy on it at
 * all: no resolved-target check, no pinned transport, no abort, not even the
 * post-hoc redirect-chain check.
 *
 * This file owns the one assertion the rest of the browser suite cannot make: it
 * mocks `playwright` so the options the tool hands `browser.newContext` are
 * observable. It lives apart from `browser-automation.test.ts` because that file
 * must keep the real `playwright` import for its EXTERNAL_TESTS block.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { newContextCalls, launchCalls, mockLookup, routeCalls, fakeContext, fakePage } = vi.hoisted(() => {
  const newContextCalls: unknown[] = [];
  const launchCalls: unknown[] = [];
  const routeCalls: string[] = [];
  const fakePage = {
    on: () => fakePage,
    goto: async () => undefined,
    url: () => "https://public.example/",
    title: async () => "T",
    setExtraHTTPHeaders: async () => undefined,
  };
  const fakeContext = {
    newPage: async () => fakePage,
    route: async (pattern: string) => {
      routeCalls.push(pattern);
    },
    routeWebSocket: async () => undefined,
    cookies: async () => [],
    addCookies: async () => undefined,
    on: () => fakeContext,
    close: async () => undefined,
  };
  return {
    newContextCalls,
    launchCalls,
    routeCalls,
    fakeContext,
    fakePage,
    mockLookup: vi.fn(),
  };
});

vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
vi.mock("playwright", () => ({
  chromium: {
    launch: async (options: unknown) => {
      launchCalls.push(options);
      return {
        newContext: async (options: unknown) => {
          newContextCalls.push(options);
          return fakeContext;
        },
        close: async () => undefined,
      };
    },
  },
}));

import { BrowserAutomationTool, POLICY_CONTEXT_OPTIONS } from "./browser-automation.js";
import type { ToolContext } from "./tool.interface.js";
import { createLogger } from "../../utils/logger.js";

createLogger("error", "/tmp/strada-test.log");

describe("BrowserAutomationTool session context — plan 4.6 (a) service workers", () => {
  let tool: BrowserAutomationTool;
  const context: ToolContext = {
    projectPath: "/tmp/test",
    workingDirectory: "/tmp/test-sw-context",
    readOnly: false,
  };

  beforeEach(() => {
    newContextCalls.length = 0;
    launchCalls.length = 0;
    routeCalls.length = 0;
    mockLookup.mockReset();
    mockLookup.mockImplementation(async () => [{ address: "93.184.216.34", family: 4 }]);
    tool = new BrowserAutomationTool();
  });

  afterEach(async () => {
    await tool?.dispose();
  });

  it("blocks service workers on the context it creates", async () => {
    const result = await tool.execute({ action: "navigate", url: "https://public.example/" }, context);
    expect(result.isError).toBeFalsy();

    expect(newContextCalls).toHaveLength(1);
    const options = newContextCalls[0] as { serviceWorkers?: string };
    expect(options.serviceWorkers).toBe("block");
  });

  // Guard: closing the bypass must not disturb the rest of the context, nor the
  // route the whole policy hangs off.
  it("still sets the viewport and user agent, and still installs the '**/*' route", async () => {
    await tool.execute(
      { action: "navigate", url: "https://public.example/", viewport: { width: 800, height: 600 } },
      context,
    );

    const options = newContextCalls[0] as {
      viewport?: { width: number; height: number };
      userAgent?: string;
    };
    expect(options.viewport).toEqual({ width: 800, height: 600 });
    expect(options.userAgent).toContain("Chrome/");
    expect(routeCalls).toContain("**/*");
  });

  it("the exported contract and the created context agree", async () => {
    await tool.execute({ action: "navigate", url: "https://public.example/" }, context);
    expect(newContextCalls[0]).toMatchObject(POLICY_CONTEXT_OPTIONS);
  });
});
