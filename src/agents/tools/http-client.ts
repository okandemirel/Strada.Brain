/**
 * HTTP Client Tool for making HTTP requests
 * 
 * Features: All HTTP methods, headers, query params, response parsing
 * Security: URL validation, request size limits, rate limiting per host
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { validateUrlWithConfig, DEFAULT_SECURITY_CONFIG } from "../../security/browser-security.js";
import { validatePath } from "../../security/path-guard.js";
import { getLogger } from "../../utils/logger.js";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ─── Types ───────────────────────────────────────────────────────────────────

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

interface HttpClientInput {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  params?: Record<string, string>;
  timeout?: number;
  maxRedirects?: number;
  responseType?: "json" | "text" | "binary" | "auto";
  downloadPath?: string;
}

interface RateLimitEntry {
  timestamps: number[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MB_IN_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 100;
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes
const ONE_HOUR_MS = 3_600_000;
const TEXT_TRUNCATION_LIMIT = 50000;
const BASE64_DISPLAY_LIMIT = 1000;

// ─── Configuration ───────────────────────────────────────────────────────────

const getConfig = () => ({
  timeout: parseInt(process.env["HTTP_TIMEOUT_MS"] ?? String(DEFAULT_TIMEOUT_MS), 10),
  maxRedirects: parseInt(process.env["HTTP_MAX_REDIRECTS"] ?? String(DEFAULT_MAX_REDIRECTS), 10),
  rateLimitPerMinute: parseInt(process.env["HTTP_RATE_LIMIT_PER_MINUTE"] ?? String(DEFAULT_RATE_LIMIT_PER_MINUTE), 10),
  maxDownloadSizeMb: parseInt(process.env["BROWSER_DOWNLOAD_MAX_SIZE_MB"] ?? "50", 10),
});

// ─── HttpClientTool Class ────────────────────────────────────────────────────

export class HttpClientTool implements ITool {
  readonly name = "http_client";
  readonly description = "Make HTTP requests to external APIs and websites. Supports all HTTP methods, custom headers, query parameters, and response parsing.";
  
  readonly inputSchema = {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"], description: "HTTP method" },
      url: { type: "string", description: "Target URL" },
      headers: { type: "object", description: "Custom HTTP headers", additionalProperties: { type: "string" } },
      body: { oneOf: [{ type: "string" }, { type: "object" }], description: "Request body (string or JSON object)" },
      params: { type: "object", description: "Query parameters", additionalProperties: { type: "string" } },
      timeout: { type: "number", description: "Request timeout in milliseconds" },
      maxRedirects: { type: "number", description: "Maximum number of redirects to follow" },
      responseType: { type: "string", enum: ["json", "text", "binary", "auto"], description: "Expected response type" },
      downloadPath: { type: "string", description: "Local path to save response (for file downloads)" },
    },
    required: ["method", "url"],
  };

  private rateLimiter = new Map<string, RateLimitEntry>();
  private readonly logger = getLogger();
  private readonly config = getConfig();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupInterval();
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const typedInput = input as unknown as HttpClientInput;
    const { method, url } = typedInput;

    const validation = validateUrlWithConfig(url, DEFAULT_SECURITY_CONFIG);
    if (!validation.valid) {
      return { content: `URL validation failed: ${validation.reason}`, isError: true };
    }

    const host = new URL(url).hostname;
    const rateLimitCheck = this.checkRateLimit(host);
    if (!rateLimitCheck.allowed) {
      return {
        content: `Rate limit exceeded for ${host}. Try again in ${Math.ceil((rateLimitCheck.retryAfterMs ?? 60000) / 1000)} seconds.`,
        isError: true,
      };
    }

    try {
      return await this.makeRequest(typedInput, context);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("HTTP request error", { method, url, error: errorMessage });
      return { content: `HTTP request failed: ${errorMessage}`, isError: true };
    }
  }

  // ─── Request Handling ────────────────────────────────────────────────────────

  private async makeRequest(input: HttpClientInput, context: ToolContext): Promise<ToolExecutionResult> {
    const { method, url, headers = {}, body, params } = input;
    const timeout = input.timeout ?? this.config.timeout;
    const maxRedirects = input.maxRedirects ?? this.config.maxRedirects;
    const responseType = input.responseType ?? "auto";

    const fullUrl = this.buildUrl(url, params);
    const { requestBody, finalHeaders } = this.buildRequest(body, headers);

    const response = await this.fetchWithRedirects(fullUrl, { method, headers: finalHeaders, body: requestBody }, maxRedirects, timeout);

    if (input.downloadPath) {
      return this.handleDownload(response, input.downloadPath, context);
    }

    return this.parseResponse(response, responseType);
  }

  private buildUrl(baseUrl: string, params?: Record<string, string>): string {
    if (!params || Object.keys(params).length === 0) return baseUrl;
    
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }
    return url.toString();
  }

  private buildRequest(
    body: string | Record<string, unknown> | undefined,
    headers: Record<string, string>
  ): { requestBody: BodyInit | undefined; finalHeaders: Record<string, string> } {
    let requestBody: BodyInit | undefined;
    let finalHeaders = { ...headers };

    if (body !== undefined) {
      if (typeof body === "string") {
        requestBody = body;
      } else {
        requestBody = JSON.stringify(body);
        if (!finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
          finalHeaders["Content-Type"] = "application/json";
        }
      }
    }

    if (!finalHeaders["User-Agent"] && !finalHeaders["user-agent"]) {
      finalHeaders["User-Agent"] = "Mozilla/5.0 (compatible; StradaBot/1.0)";
    }

    return { requestBody, finalHeaders };
  }

  private async fetchWithRedirects(
    url: string,
    init: RequestInit,
    maxRedirects: number,
    timeout: number,
    redirectCount = 0
  ): Promise<Response> {
    if (redirectCount > maxRedirects) {
      throw new Error(`Maximum redirects (${maxRedirects}) exceeded`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
      clearTimeout(timeoutId);

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
          const redirectUrl = new URL(location, url).toString();
          const validation = validateUrlWithConfig(redirectUrl, DEFAULT_SECURITY_CONFIG);
          if (!validation.valid) {
            throw new Error(`Redirect to unsafe URL blocked: ${validation.reason}`);
          }

          this.logger.debug("Following redirect", { from: url, to: redirectUrl, status: response.status });
          return this.fetchWithRedirects(redirectUrl, init, maxRedirects, timeout, redirectCount + 1);
        }
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  // ─── Response Handling ───────────────────────────────────────────────────────

  private async handleDownload(response: Response, downloadPath: string, context: ToolContext): Promise<ToolExecutionResult> {
    const pathCheck = await validatePath(context.workingDirectory, downloadPath);
    if (!pathCheck.valid) {
      return { content: `Download path rejected: ${pathCheck.error}`, isError: true };
    }
    const fullPath = pathCheck.fullPath;
    await mkdir(dirname(fullPath), { recursive: true });

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const sizeMb = parseInt(contentLength, 10) / MB_IN_BYTES;
      if (sizeMb > this.config.maxDownloadSizeMb) {
        return { content: `Download size (${sizeMb.toFixed(2)}MB) exceeds limit`, isError: true };
      }
    }

    const body = response.body;
    if (!body) return { content: "Download failed: No response body", isError: true };

    await pipeline(Readable.fromWeb(body as import("stream/web").ReadableStream), createWriteStream(fullPath));
    const stats = await stat(fullPath);

    return {
      content: `Downloaded to: ${fullPath} (${stats.size} bytes)`,
      metadata: { path: fullPath, size: stats.size, contentType: response.headers.get("content-type") },
    };
  }

  private async parseResponse(response: Response, responseType: "json" | "text" | "binary" | "auto"): Promise<ToolExecutionResult> {
    const contentType = response.headers.get("content-type") ?? "";
    const finalType = responseType === "auto" ? this.detectContentType(contentType) : responseType;

    const metadata = this.buildMetadata(response);

    if (!response.ok) {
      const text = await response.text();
      return { content: `HTTP Error ${response.status}: ${response.statusText}\n\n${text}`, isError: true, metadata };
    }

    switch (finalType) {
      case "json": return this.parseJsonResponse(response, metadata);
      case "text": return this.parseTextResponse(response, metadata);
      case "binary": return this.parseBinaryResponse(response, metadata);
      default: return { content: `Unknown response type: ${finalType}`, isError: true };
    }
  }

  private detectContentType(contentType: string): "json" | "text" | "binary" {
    if (contentType.includes("application/json")) return "json";
    if (contentType.includes("text/")) return "text";
    return "binary";
  }

  private buildMetadata(response: Response): Record<string, unknown> {
    const headersObj: Record<string, string> = {};
    response.headers.forEach((value, key) => { headersObj[key] = value; });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: headersObj,
      contentType: response.headers.get("content-type") ?? "",
    };
  }

  private async parseJsonResponse(response: Response, metadata: Record<string, unknown>): Promise<ToolExecutionResult> {
    try {
      const data = await response.json();
      return { content: JSON.stringify(data, null, 2), metadata: { ...metadata, data } };
    } catch {
      const text = await response.text();
      return { content: `Failed to parse JSON response:\n${text}`, isError: true, metadata };
    }
  }

  private async parseTextResponse(response: Response, metadata: Record<string, unknown>): Promise<ToolExecutionResult> {
    const text = await response.text();
    const truncated = text.length > TEXT_TRUNCATION_LIMIT ? text.substring(0, TEXT_TRUNCATION_LIMIT) + "..." : text;
    
    return { content: truncated, metadata: { ...metadata, length: text.length, truncated: text.length > TEXT_TRUNCATION_LIMIT } };
  }

  private async parseBinaryResponse(response: Response, metadata: Record<string, unknown>): Promise<ToolExecutionResult> {
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const displayBase64 = base64.length > BASE64_DISPLAY_LIMIT ? base64.substring(0, BASE64_DISPLAY_LIMIT) + "..." : base64;
    
    return {
      content: `Binary response (${buffer.byteLength} bytes). Base64 encoded:\n${displayBase64}`,
      metadata: { ...metadata, size: buffer.byteLength, base64: base64.length > BASE64_DISPLAY_LIMIT ? undefined : base64 },
    };
  }

  // ─── Rate Limiting ───────────────────────────────────────────────────────────

  private checkRateLimit(host: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    let entry = this.rateLimiter.get(host);
    if (!entry) {
      entry = { timestamps: [] };
      this.rateLimiter.set(host, entry);
    }

    entry.timestamps = entry.timestamps.filter(t => t > oneMinuteAgo);

    if (entry.timestamps.length >= this.config.rateLimitPerMinute) {
      const retryAfterMs = entry.timestamps[0]! + 60_000 - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    entry.timestamps.push(now);
    return { allowed: true };
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const oneHourAgo = Date.now() - ONE_HOUR_MS;
      for (const [host, entry] of Array.from(this.rateLimiter.entries())) {
        entry.timestamps = entry.timestamps.filter(t => t > oneHourAgo);
        if (entry.timestamps.length === 0) {
          this.rateLimiter.delete(host);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.rateLimiter.clear();
  }
}
