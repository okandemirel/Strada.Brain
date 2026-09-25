import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import { getLoggerSafe } from '../utils/logger.js';

/** Per-request bound: a hung Obsidian used to stall init(), writeNote and sync (which holds the write lock). */
export const OBSIDIAN_REQUEST_TIMEOUT_MS = 10_000;

export interface ObsidianApiConfig {
  apiUrl: string;
  apiKey: string;
  /** PEM certificate the Local REST API serves (it is self-signed); trusted by this client only. */
  certPath?: string;
  /** Per-request timeout in ms; defaults to {@link OBSIDIAN_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
}

export interface ObsidianNote {
  path: string;
  content: string;
}

export interface ObsidianSearchResult {
  filename: string;
  score: number;
  matches: string[];
}

/**
 * Typed HTTP client for Obsidian Local REST API.
 * Supports: file CRUD, search, active file, periodic notes.
 *
 * Docs: https://github.com/coddingtonbear/obsidian-local-rest-api
 */
export class ObsidianApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private readonly timeoutMs: number;
  /** Set when certPath is configured: a TLS agent that trusts exactly that certificate. */
  private readonly dispatcher: Agent | null = null;

  constructor(config: ObsidianApiConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, '');
    this.headers = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    };
    this.timeoutMs = config.requestTimeoutMs ?? OBSIDIAN_REQUEST_TIMEOUT_MS;
    // The plugin's certificate is self-signed. It is trusted for THIS client
    // through certPath; turning certificate checks off process-wide would also
    // expose every other outbound request (MEM-20).
    if (config.certPath) {
      try {
        this.dispatcher = new Agent({ connect: { ca: readFileSync(config.certPath) } });
      } catch (err) {
        getLoggerSafe().warn('[obsidian-client] certPath could not be read; HTTPS calls will use the default trust store', {
          certPath: config.certPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Every call goes through here: bounded by the timeout, and with the certPath agent when one is set. */
  private send(url: string, init: RequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    if (this.dispatcher) {
      // The npm undici fetch, not the bundled one: handing an npm Agent to the
      // bundled fetch is version-fragile (see fetchWithPolicy).
      return undiciFetch(url, {
        method: init.method,
        headers: init.headers as Record<string, string> | undefined,
        body: typeof init.body === 'string' ? init.body : undefined,
        signal,
        dispatcher: this.dispatcher,
      }) as unknown as Promise<Response>;
    }
    return fetch(url, { ...init, signal });
  }

  /** Release the certPath agent's sockets. */
  async close(): Promise<void> {
    await this.dispatcher?.close().catch(() => undefined);
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = { ...this.headers, ...(extraHeaders ?? {}) };
    const opts: RequestInit = { method };
    if (body !== undefined) {
      if (typeof body === "string") {
        // Markdown/plain payloads must be sent verbatim — the Local REST API
        // writes the request body as the file content. JSON.stringify would
        // persist a quoted, backslash-escaped blob instead of real markdown.
        opts.body = body;
        const callerSetContentType = extraHeaders
          ? Object.keys(extraHeaders).some((k) => k.toLowerCase() === "content-type")
          : false;
        if (!callerSetContentType) {
          headers["Content-Type"] = "text/markdown";
        }
      } else {
        opts.body = JSON.stringify(body);
      }
    }
    opts.headers = headers;

    try {
      const res = await this.send(url, opts);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Obsidian API ${method} ${endpoint} failed: ${res.status} ${res.statusText} — ${text}`);
      }
      // Some endpoints return 204 No Content
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (err) {
      getLoggerSafe().warn(`[obsidian-client] request failed: ${method} ${endpoint}`, { err });
      throw err;
    }
  }

  /** Read a note by vault-relative path. */
  async getNote(path: string): Promise<string> {
    const encoded = encodeURIComponent(path);
    const res = await this.send(`${this.baseUrl}/vault/${encoded}`, {
      headers: { ...this.headers, Accept: 'text/markdown' },
    });
    if (!res.ok) {
      throw new Error(`Obsidian API GET /vault/${path} failed: ${res.status}`);
    }
    return res.text();
  }

  /** Write or overwrite a note. */
  async putNote(path: string, content: string): Promise<void> {
    const encoded = encodeURIComponent(path);
    await this.request<void>('PUT', `/vault/${encoded}`, content);
  }

  /** Delete a note. */
  async deleteNote(path: string): Promise<void> {
    const encoded = encodeURIComponent(path);
    await this.request<void>('DELETE', `/vault/${encoded}`);
  }

  /** Search notes using Obsidian's built-in fuzzy search. */
  async search(query: string): Promise<ObsidianSearchResult[]> {
    return this.request<ObsidianSearchResult[]>('POST', `/search/simple/?query=${encodeURIComponent(query)}`);
  }

  /** List all files in the vault. */
  async listFiles(): Promise<string[]> {
    return this.request<string[]>('GET', '/vault/');
  }

  /** Get the currently active (open) note. */
  async getActiveNote(): Promise<ObsidianNote | null> {
    try {
      const content = await this.request<string>('GET', '/active/');
      // The API returns the note content; we don't get the path directly.
      // This is a limitation of the simple REST API.
      return { path: '', content };
    } catch {
      return null;
    }
  }

  /** Append content to a specific heading in a note. */
  async appendToHeading(path: string, heading: string, content: string): Promise<void> {
    const encoded = encodeURIComponent(path);
    await this.request<void>('POST', `/vault/${encoded}`, content, {
      'Target-Type': 'heading',
      'Target': heading,
    });
  }

  /** Check if the Obsidian API is reachable. */
  async healthCheck(): Promise<boolean> {
    try {
      await this.request<string[]>('GET', '/vault/');
      return true;
    } catch {
      return false;
    }
  }
}
