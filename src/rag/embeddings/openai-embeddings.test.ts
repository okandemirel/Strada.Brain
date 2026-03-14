import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIEmbeddingProvider } from "./openai-embeddings.js";

// ---------------------------------------------------------------------------
// Logger mock — the provider calls getLogger() so we stub out winston before
// any test code imports the real module.
// ---------------------------------------------------------------------------
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../security/secret-sanitizer.js", () => ({
  sanitizeSecrets: (text: string) => text,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmbedding(dims: number, seed: number): number[] {
  return Array.from({ length: dims }, (_, i) => (seed + i) / 1000);
}

function makeFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeOpenAIResponse(embeddings: number[][], totalTokens = 10): object {
  return {
    data: embeddings.map((embedding, index) => ({ embedding, index })),
    usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIEmbeddingProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  it("uses default model and dimensions when none are supplied", () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });
    expect(provider.name).toBe("OpenAI:text-embedding-3-small");
    expect(provider.dimensions).toBe(1536);
  });

  it("resolves dimensions from the known-models map for text-embedding-3-large", () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-large",
    });
    expect(provider.dimensions).toBe(3072);
  });

  it("respects an explicit dimensions override", () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 512,
    });
    expect(provider.dimensions).toBe(512);
  });

  it("falls back to 1536 for an unknown model", () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "custom-model-xyz",
    });
    expect(provider.dimensions).toBe(1536);
  });

  // -------------------------------------------------------------------------
  // Empty input
  // -------------------------------------------------------------------------

  it("returns empty embeddings and zero tokens for empty input", async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });
    const result = await provider.embed([]);
    expect(result.embeddings).toHaveLength(0);
    expect(result.usage.totalTokens).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Successful single-batch embed
  // -------------------------------------------------------------------------

  it("embeds a single text successfully", async () => {
    const embedding = makeEmbedding(1536, 1);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeFetchResponse(makeOpenAIResponse([embedding], 7)),
    );

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });
    const result = await provider.embed(["hello world"]);

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toEqual(embedding);
    expect(result.usage.totalTokens).toBe(7);
  });

  it("embeds multiple texts within a single batch", async () => {
    const embeddings = [makeEmbedding(1536, 1), makeEmbedding(1536, 2)];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeFetchResponse(makeOpenAIResponse(embeddings, 14)),
    );

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });
    const result = await provider.embed(["foo", "bar"]);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual(embeddings[0]);
    expect(result.embeddings[1]).toEqual(embeddings[1]);
    expect(result.usage.totalTokens).toBe(14);
  });

  it("sends correct Authorization header and Content-Type", async () => {
    const embedding = makeEmbedding(1536, 1);
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse([embedding])));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-abc123" });
    await provider.embed(["test"]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-abc123");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("uses a custom baseUrl when provided", async () => {
    const embedding = makeEmbedding(1536, 1);
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse([embedding])));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      baseUrl: "https://my-proxy.example.com/v1",
    });
    await provider.embed(["test"]);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://my-proxy.example.com/v1/embeddings");
  });

  // -------------------------------------------------------------------------
  // Batch splitting (>100 texts per batch)
  // -------------------------------------------------------------------------

  it("splits 150 texts into two batches of 100 and 50", async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const batch1Embeddings = Array.from({ length: 100 }, (_, i) => makeEmbedding(1536, i));
    const batch2Embeddings = Array.from({ length: 50 }, (_, i) => makeEmbedding(1536, i + 100));

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse(batch1Embeddings, 500)))
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse(batch2Embeddings, 250)));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });
    const result = await provider.embed(texts);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.embeddings).toHaveLength(150);
    expect(result.usage.totalTokens).toBe(750);

    // Verify the request bodies contain the right batch sizes
    const firstBody = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { input: string[] };
    const secondBody = JSON.parse(
      (mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as { input: string[] };
    expect(firstBody.input).toHaveLength(100);
    expect(secondBody.input).toHaveLength(50);
  });

  it("splits exactly 200 texts into two batches of 100 each", async () => {
    const texts = Array.from({ length: 200 }, (_, i) => `t${i}`);
    const batchEmbeddings = Array.from({ length: 100 }, (_, i) => makeEmbedding(1536, i));

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse(batchEmbeddings, 100)))
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse(batchEmbeddings, 100)));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });
    const result = await provider.embed(texts);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.embeddings).toHaveLength(200);
    expect(result.usage.totalTokens).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Retry on 429 (rate-limit)
  // -------------------------------------------------------------------------

  it("retries on HTTP 429 and succeeds on the second attempt", async () => {
    const embedding = makeEmbedding(1536, 1);
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse({ error: "rate limited" }, 429))
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse([embedding], 5)));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });

    // Kick off the embed — it will hit the 429 then schedule a retry with a
    // setTimeout. We must advance timers to let the delay resolve.
    const embedPromise = provider.embed(["hello"]);
    await vi.runAllTimersAsync();
    const result = await embedPromise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.embeddings[0]).toEqual(embedding);
  });

  it("retries on HTTP 429 and succeeds on the third attempt", async () => {
    const embedding = makeEmbedding(1536, 1);
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse({ error: "rate limited" }, 429))
      .mockResolvedValueOnce(makeFetchResponse({ error: "rate limited" }, 429))
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse([embedding], 5)));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });

    const embedPromise = provider.embed(["hello"]);
    await vi.runAllTimersAsync();
    const result = await embedPromise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.embeddings[0]).toEqual(embedding);
  });

  // -------------------------------------------------------------------------
  // Retry on 5xx errors
  // -------------------------------------------------------------------------

  it("retries on HTTP 500 and succeeds on the second attempt", async () => {
    const embedding = makeEmbedding(1536, 1);
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeFetchResponse({ error: "internal server error" }, 500))
      .mockResolvedValueOnce(makeFetchResponse(makeOpenAIResponse([embedding], 5)));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });

    const embedPromise = provider.embed(["hello"]);
    await vi.runAllTimersAsync();
    const result = await embedPromise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.embeddings[0]).toEqual(embedding);
  });

  it("throws after exhausting all retries on persistent HTTP 500", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ error: "internal server error" }, 500));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });

    const embedPromise = provider.embed(["hello"]);
    // Prevent unhandled rejection warning — the promise rejects during
    // runAllTimersAsync before the .rejects handler is attached.
    embedPromise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(embedPromise).rejects.toThrow(/API error 500/);
    // Initial attempt + 3 retries = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("throws after exhausting all retries on persistent HTTP 429", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse({ error: "rate limited" }, 429));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });

    const embedPromise = provider.embed(["hello"]);
    embedPromise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(embedPromise).rejects.toThrow(/API error 429/);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // Non-retryable errors (4xx other than 429)
  // -------------------------------------------------------------------------

  it("throws immediately on HTTP 401 without retrying", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse({ error: "unauthorized" }, 401));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-bad" });

    await expect(provider.embed(["hello"])).rejects.toThrow(/API error 401/);
    // Must not retry a 401
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on HTTP 400 without retrying", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse({ error: "bad request" }, 400));
    globalThis.fetch = mockFetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });

    await expect(provider.embed(["hello"])).rejects.toThrow(/API error 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Result ordering
  // -------------------------------------------------------------------------

  it("preserves input order even when the API returns data out of order", async () => {
    // Simulate the API returning items in reverse index order
    const embed1 = makeEmbedding(1536, 1);
    const embed2 = makeEmbedding(1536, 2);
    const shuffledResponse = {
      data: [
        { embedding: embed2, index: 1 },
        { embedding: embed1, index: 0 },
      ],
      usage: { prompt_tokens: 10, total_tokens: 10 },
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeFetchResponse(shuffledResponse),
    );

    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });
    const result = await provider.embed(["first", "second"]);

    expect(result.embeddings[0]).toEqual(embed1);
    expect(result.embeddings[1]).toEqual(embed2);
  });
});
