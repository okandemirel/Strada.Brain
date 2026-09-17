// ---------------------------------------------------------------------------
// Web Search bundled skill — fetch URL content and search the web via DuckDuckGo.
// ---------------------------------------------------------------------------

import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import {
  assertPublicTarget,
  ForbiddenTargetError,
  isRedirectStatus,
  type ResolvedTarget,
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

/** Redirect hops web_fetch_url will follow (each hop re-checked by the SSRF policy). */
const MAX_REDIRECTS = 5;

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

/**
 * An undici Agent whose socket connect uses ONLY the addresses the policy just
 * vetted, instead of resolving the hostname a second time. This closes the
 * check-then-connect (DNS rebinding) window: the address we classified is the
 * address the TCP connection goes to. TLS still verifies against the hostname
 * (servername is derived from the URL, not from the pinned address).
 *
 * Node's global fetch cannot pin: its RequestInit has no lookup hook and mixing
 * an npm undici Agent into the bundled fetch is version-fragile, so the request
 * goes through the npm `undici` fetch with this dispatcher.
 */
function pinnedDispatcher(target: ResolvedTarget): Agent {
  const pinned = target.addresses.map((a) => ({ address: a.address, family: a.family }));
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname.toLowerCase() !== target.hostname) {
      const err: NodeJS.ErrnoException = new Error(`Refusing to connect to unvetted host "${hostname}"`);
      err.code = "ENOTFOUND";
      callback(err, options.all ? [] : "");
      return;
    }
    const family =
      options.family === 4 || options.family === "IPv4" ? 4
      : options.family === 6 || options.family === "IPv6" ? 6
      : undefined;
    const candidates = family ? pinned.filter((a) => a.family === family) : pinned;
    if (candidates.length === 0) {
      const err: NodeJS.ErrnoException = new Error(`No vetted address of family ${family ?? "any"} for "${hostname}"`);
      err.code = "ENOTFOUND";
      callback(err, options.all ? [] : "");
      return;
    }
    if (options.all) {
      callback(null, candidates);
    } else {
      callback(null, candidates[0]!.address, candidates[0]!.family);
    }
  };
  return new Agent({ connect: { lookup } });
}

/**
 * GET `initialUrl`, following redirects by hand: every hop (the initial URL
 * and each Location) is passed through `assertPublicTarget` immediately
 * before its request and the connection is pinned to the vetted addresses.
 * A hop that lands on a forbidden address throws ForbiddenTargetError.
 */
async function fetchWithPolicy(
  initialUrl: string,
  signal: AbortSignal,
): Promise<{ response: Response; dispose: () => Promise<void> }> {
  const agents: Agent[] = [];
  const dispose = async (): Promise<void> => {
    await Promise.all(agents.splice(0).map((a) => a.close().catch(() => undefined)));
  };

  let currentUrl = initialUrl;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Re-resolve right before the request: a rebinding host that was public a
      // moment ago is re-checked, and the agent below connects only to what
      // this call vetted.
      const target = await assertPublicTarget(currentUrl);
      const agent = pinnedDispatcher(target);
      agents.push(agent);

      const response = (await undiciFetch(currentUrl, {
        signal,
        headers: { "User-Agent": "StradaBrain/1.0" },
        redirect: "manual",
        dispatcher: agent,
      })) as unknown as Response;

      if (!isRedirectStatus(response.status)) {
        return { response, dispose };
      }
      const location = response.headers.get("location");
      if (!location) {
        return { response, dispose };
      }
      await response.body?.cancel().catch(() => undefined);
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
  } catch (error) {
    await dispose();
    throw error;
  }
}

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
      const fetched = await fetchWithPolicy(validation.url, controller.signal);
      dispose = fetched.dispose;
      const response = fetched.response;

      if (!response.ok) {
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
