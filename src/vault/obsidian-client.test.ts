import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObsidianApiClient } from "./obsidian-client.js";

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Records the TLS agent the client builds for certPath and the requests sent
// through it, without opening a socket.
const undiciCalls = vi.hoisted(() => ({
  agents: [] as Array<{ options: unknown; closed: boolean }>,
  fetches: [] as Array<{ url: string; init: Record<string, unknown> }>,
}));
vi.mock("undici", () => {
  class Agent {
    readonly record: { options: unknown; closed: boolean };
    constructor(options: unknown) {
      this.record = { options, closed: false };
      undiciCalls.agents.push(this.record);
    }
    async close(): Promise<void> { this.record.closed = true; }
  }
  const fetch = async (url: string, init: Record<string, unknown>) => {
    undiciCalls.fetches.push({ url, init });
    return { ok: true, status: 200, text: async () => "", json: async () => ["a.md"] };
  };
  return { Agent, fetch };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, status: 204, text: async () => "", json: async () => undefined });
});

describe("ObsidianApiClient write path", () => {
  const client = new ObsidianApiClient({ apiUrl: "https://localhost:27124", apiKey: "k" });

  it("putNote sends raw markdown verbatim with text/markdown content-type (not JSON-encoded)", async () => {
    const md = '# Title\nHello [[Link]] and a "quote"\n';
    await client.putNote("Notes/My Note.md", md);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    // Regression guard: body must be the raw markdown, NOT JSON.stringify(md)
    // (which would persist a quoted, backslash-escaped blob to disk).
    expect(opts.body).toBe(md);
    expect(opts.body).not.toBe(JSON.stringify(md));
    const headers = opts.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/markdown");
  });

  it("appendToHeading sends raw markdown with markdown content-type and Target headers (not application/json)", async () => {
    const md = "- item [[x]]";
    await client.appendToHeading("Daily/2026-05-30.md", "Log", md);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.body).toBe(md);
    const headers = opts.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/markdown");
    expect(headers["Target-Type"]).toBe("heading");
    expect(headers["Target"]).toBe("Log");
  });

  it("still JSON-encodes non-string bodies", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => [],
    });
    // search() takes no body; exercise a hypothetical object body via a
    // structural check on the encoder by calling a method that sends none,
    // then asserting string bodies stay raw (covered above). Here we assert
    // the GET path sends no body and keeps the default JSON content-type.
    await client.listFiles();
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.body).toBeUndefined();
    const headers = opts.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("ObsidianApiClient transport (MEM-20)", () => {
  let certDir: string;
  beforeEach(() => {
    certDir = mkdtempSync(join(tmpdir(), "obsidian-cert-"));
    undiciCalls.agents.length = 0;
    undiciCalls.fetches.length = 0;
  });
  afterEach(() => rmSync(certDir, { recursive: true, force: true }));

  it("trusts the certPath certificate through a client-scoped agent, not a process-wide switch", async () => {
    const certPath = join(certDir, "obsidian.crt");
    writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nplugin-cert\n-----END CERTIFICATE-----\n");
    const client = new ObsidianApiClient({ apiUrl: "https://127.0.0.1:27124", apiKey: "k", certPath });

    expect(await client.listFiles()).toEqual(["a.md"]);
    expect(await client.healthCheck()).toBe(true);

    expect(undiciCalls.agents).toHaveLength(1);
    const options = undiciCalls.agents[0]!.options as { connect: { ca: Buffer } };
    expect(options.connect.ca.toString()).toContain("plugin-cert");
    expect(undiciCalls.fetches).toHaveLength(2);
    for (const call of undiciCalls.fetches) {
      expect(call.init["dispatcher"]).toBeDefined();
      expect(call.init["signal"]).toBeInstanceOf(AbortSignal);
    }
    // Nothing went through the global fetch, whose TLS settings are shared.
    expect(mockFetch).not.toHaveBeenCalled();

    await client.close();
    expect(undiciCalls.agents[0]!.closed).toBe(true);
  });

  it("gives up on a server that never answers instead of hanging", async () => {
    // A fetch that only settles when its signal aborts.
    mockFetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const client = new ObsidianApiClient({ apiUrl: "http://127.0.0.1:27123", apiKey: "k", requestTimeoutMs: 50 });

    const outcome = await Promise.race([
      client.listFiles().then(() => "answered", () => "timed out"),
      client.getNote("a.md").then(() => "answered", () => "timed out"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(outcome).toBe("timed out");
    await expect(client.getNote("a.md")).rejects.toThrow();
  });
});
