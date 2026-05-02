import { getLoggerSafe } from '../utils/logger.js';

export interface ObsidianApiConfig {
  apiUrl: string;
  apiKey: string;
  certPath?: string;
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

  constructor(config: ObsidianApiConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, '');
    this.headers = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const opts: RequestInit = {
      method,
      headers: extraHeaders ? { ...this.headers, ...extraHeaders } : this.headers,
      // For self-signed certs on localhost; in production certPath should be used.
      // Node.js fetch in v18+ doesn't support agent option; we rely on the user
      // having set NODE_TLS_REJECT_UNAUTHORIZED=0 for local dev.
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(url, opts);
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
    const res = await fetch(`${this.baseUrl}/vault/${encoded}`, {
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
      ...this.headers,
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
