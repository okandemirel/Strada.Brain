// ---------------------------------------------------------------------------
// Web Search bundled skill — fetch URL content and search the web via DuckDuckGo.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import {
  discardBody,
  fetchWithPolicy,
  ForbiddenTargetError,
} from "../../../security/browser-security.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters returned from a fetched URL. */
const MAX_CONTENT_LENGTH = 8000;

/** Fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

/** Maximum number of search results to return. */
const MAX_SEARCH_RESULTS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cheap synchronous shape check: non-empty string starting with http:// or
 * https://. The SSRF decision is NOT made here — `assertPublicTarget`
 * (src/security/browser-security.ts) classifies the resolved addresses of the
 * initial URL and of every redirect hop right before each request
 * (plan 0-B.6 / audit 13F1 / D63 + Codex #12).
 */
function validateUrl(url: string): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof url !== "string" || url.trim() === "") {
    return { ok: false, error: "URL parameter is required." };
  }
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: "Only http:// and https:// URLs are allowed." };
  }
  try {
    new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL format." };
  }
  return { ok: true, url: trimmed };
}

// The address-pinned, hop-by-hop transport (`fetchWithPolicy`) lives in
// src/security/browser-security.ts so web_fetch_url, the browser's document
// requests and its fallback download share ONE implementation (Codex round 6
// #11 / #12).

/**
 * Extract search result snippets from DuckDuckGo HTML response.
 * Looks for result snippet elements and extracts their text content.
 */
function extractSearchResults(html: string, maxResults: number): string[] {
  const results: string[] = [];

  // DuckDuckGo HTML search returns results in <a class="result__snippet"> elements
  // We use a simple regex to extract text from result snippets.
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = snippetRegex.exec(html)) !== null && results.length < maxResults) {
    // Strip HTML tags from the snippet text
    const raw = match[1] ?? "";
    const text = raw.replace(/<[^>]+>/g, "").trim();
    if (text) {
      results.push(text);
    }
  }

  // Fallback: try extracting from result__a (result titles) if no snippets found
  if (results.length === 0) {
    const titleRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = titleRegex.exec(html)) !== null && results.length < maxResults) {
      const raw = match[1] ?? "";
      const text = raw.replace(/<[^>]+>/g, "").trim();
      if (text) {
        results.push(text);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const webFetchUrl: ITool = {
  name: "web_fetch_url",
  description: "Fetch the text content of a URL. Returns the response body truncated to 8000 characters.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must start with http:// or https://)",
      },
    },
    required: ["url"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const urlInput = typeof input["url"] === "string" ? input["url"] : "";
    const validation = validateUrl(urlInput);
    if (!validation.ok) {
      return { content: `Error: ${validation.error}` };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let dispose: (() => Promise<void>) | undefined;
    try {
      const fetched = await fetchWithPolicy(validation.url, {
        signal: controller.signal,
        headers: { "User-Agent": "StradaBrain/1.0" },
      });
      dispose = fetched.dispose;
      const response = fetched.response;

      if (!response.ok) {
        // Codex round 6 #14: a body nobody reads keeps the request in flight and
        // `Agent.close()` (in dispose) would wait on it. Release it first.
        await discardBody(response);
        return { content: `Error: HTTP ${response.status} ${response.statusText}` };
      }

      const text = await response.text();
      const truncated = text.length > MAX_CONTENT_LENGTH
        ? text.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Truncated — ${text.length} chars total]`
        : text;

      return { content: truncated };
    } catch (error) {
      if (error instanceof ForbiddenTargetError) {
        return { content: `Error: Access to internal/private network addresses is blocked. ${error.message}` };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("abort")) {
        return { content: "Error: Request timed out after 10 seconds." };
      }
      return { content: `Error: ${message}` };
    } finally {
      clearTimeout(timeoutId);
      if (dispose) await dispose();
    }
  },
};

const webSearch: ITool = {
  name: "web_search",
  description: "Search the web via DuckDuckGo and return top 5 result snippets.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
    },
    required: ["query"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = typeof input["query"] === "string" ? input["query"] : "";
    if (!query.trim()) {
      return { content: "Error: query parameter is required." };
    }

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(searchUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "StradaBrain/1.0",
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return { content: `Error: Search request failed with HTTP ${response.status}` };
      }

      const html = await response.text();
      const results = extractSearchResults(html, MAX_SEARCH_RESULTS);

      if (results.length === 0) {
        return { content: "No results found." };
      }

      const formatted = results.map((r, i) => `${i + 1}. ${r}`).join("\n");
      return { content: `Search results for "${query.trim()}":\n${formatted}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("abort")) {
        return { content: "Error: Search request timed out after 10 seconds." };
      }
      return { content: `Error: ${message}` };
    }
  },
};

export const tools = [webFetchUrl, webSearch];
export default tools;
