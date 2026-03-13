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
  validateUrlWithConfig,
  BrowserRateLimiter,
  BrowserSessionManager,
  DEFAULT_SECURITY_CONFIG,
  type BrowserSecurityConfig,
} from "../../security/browser-security.js";
import { getLogger } from "../../utils/logger.js";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MB_IN_BYTES = 1024 * 1024;
const MAX_CONTENT_LENGTH = 10000;
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const SCRIPT_EVAL_TIMEOUT_MS = 5000;

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
        session.page.evaluate((c: string) => {
          "use strict";
          const fn = new Function('"use strict";' + c);
          return fn();
        }, code),
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

    const session = this.requireSession(sessionId);
    const fullPath = join(context.workingDirectory, input.downloadPath);
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
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; StradaBot/1.0)" },
      });

      if (!response.ok) {
        return { content: `Download failed: HTTP ${response.status}`, isError: true };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const sizeMb = parseInt(contentLength, 10) / MB_IN_BYTES;
        if (sizeMb > this.config.maxDownloadSizeMb) {
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
      return {
        content: `Download failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
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

      session = { browser, context, page, createdAt: Date.now(), lastUsed: Date.now() };
      this.sessions.set(sessionId, session);
      this.logger.info("Created new browser session", { sessionId });

      return session;
    } catch (error) {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      throw error;
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
