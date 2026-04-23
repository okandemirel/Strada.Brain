import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaEmbeddingProvider } from "./ollama-embeddings.js";

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
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

/** Build a response for POST /api/embed (batch endpoint) */
function makeEmbedBatchResponse(
  embeddings: number[][],
  promptEvalCount?: number
): object {
  const resp: Record<string, unknown> = { embeddings };
  if (promptEvalCount !== undefined) {
    resp["prompt_eval_count"] = promptEvalCount;
  }
  return resp;
}

/** Build a response for POST /api/embeddings (single-text legacy endpoint) */
function makeEmbeddingsSingleResponse(embedding: number[]): object {
  return { embedding };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OllamaEmbeddingProvider", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  it("uses default model and baseUrl when none are supplied", () => {
    const provider = new OllamaEmbeddingProvider();
    expect(provider.name).toBe("ollama:nomic-embed-text");
    expect(provider.dimensions).toBe(768);
  });

  it("resolves dimensions for mxbai-embed-large", () => {
    const provider = new OllamaEmbeddingProvider({ model: "mxbai-embed-large" });
    expect(provider.name).toBe("ollama:mxbai-embed-large");
    expect(provider.dimensions).toBe(1024);
  });

  it("resolves dimensions for all-minilm", () => {
    const provider = new OllamaEmbeddingProvider({ model: "all-minilm" });
    expect(provider.dimensions).toBe(384);
  });

  it("resolves dimensions for bge-m3", () => {
    const provider = new OllamaEmbeddingProvider({ model: "bge-m3" });
    expect(provider.dimensions).toBe(1024);
  });

  it("strips ':tag' suffix when resolving dimensions (e.g. bge-m3:latest)", () => {
    const provider = new OllamaEmbeddingProvider({ model: "bge-m3:latest" });
    expect(provider.dimensions).toBe(1024);
    expect(provider.name).toBe("ollama:bge-m3:latest");
  });

  it("falls back to 768 dimensions for an unknown model", () => {
    const provider = new OllamaEmbeddingProvider({ model: "custom-llm" });
    expect(provider.dimensions).toBe(768);
  });

  it("accepts a custom baseUrl", () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: "http://remote-host:11434",
    });
    expect(provider.name).toBe("ollama:nomic-embed-text");
  });

  // -------------------------------------------------------------------------
  // Empty input
  // -------------------------------------------------------------------------

  it("returns empty embeddings and zero tokens for empty input", async () => {
    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed([]);
    expect(result.embeddings).toHaveLength(0);
    expect(result.usage.totalTokens).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Successful embed via /api/embed (batch endpoint)
  // -------------------------------------------------------------------------

  it("embeds a single text via the /api/embed endpoint", async () => {
    const embedding = makeEmbedding(768, 1);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeFetchResponse(makeEmbedBatchResponse([embedding], 5))
    );

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(["hello"]);

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toEqual(embedding);
    expect(result.usage.totalTokens).toBe(5);
  });

  it("embeds multiple texts via the /api/embed endpoint", async () => {
    const embeddings = [makeEmbedding(768, 1), makeEmbedding(768, 2)];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeFetchResponse(makeEmbedBatchResponse(embeddings, 12))
    );

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(["foo", "bar"]);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual(embeddings[0]);
    expect(result.embeddings[1]).toEqual(embeddings[1]);
    expect(result.usage.totalTokens).toBe(12);
  });

  it("sends the model and input array in the /api/embed request body", async () => {
    const embedding = makeEmbedding(768, 1);
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(makeEmbedBatchResponse([embedding]))
    );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider({ model: "nomic-embed-text" });
    await provider.embed(["test text"]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/embed");
    const body = JSON.parse(init.body as string) as {
      model: string;
      input: string[];
    };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["test text"]);
  });

  it("uses a custom baseUrl for the /api/embed call", async () => {
    const embedding = makeEmbedding(768, 1);
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(makeEmbedBatchResponse([embedding]))
    );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider({
      baseUrl: "http://gpu-box:11434",
    });
    await provider.embed(["test"]);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gpu-box:11434/api/embed");
  });

  it("returns zero totalTokens when prompt_eval_count is absent from the batch response", async () => {
    const embedding = makeEmbedding(768, 1);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeFetchResponse(makeEmbedBatchResponse([embedding]))
    );

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(["hello"]);

    expect(result.usage.totalTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Fallback to /api/embeddings (sequential legacy endpoint)
  // -------------------------------------------------------------------------

  it("falls back to /api/embeddings when /api/embed returns a non-ok status", async () => {
    const embedding = makeEmbedding(768, 1);
    const mockFetch = vi.fn()
      // /api/embed fails with 404 (older Ollama without batch support)
      .mockResolvedValueOnce(makeFetchResponse({ error: "not found" }, 404))
      // /api/embeddings sequential call succeeds
      .mockResolvedValueOnce(
        makeFetchResponse(makeEmbeddingsSingleResponse(embedding))
      );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(["hello"]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [fallbackUrl] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(fallbackUrl).toBe("http://localhost:11434/api/embeddings");
    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toEqual(embedding);
  });

  it("falls back to /api/embeddings when /api/embed throws a network error", async () => {
    const embedding = makeEmbedding(768, 1);
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(
        makeFetchResponse(makeEmbeddingsSingleResponse(embedding))
      );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(["hello"]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.embeddings[0]).toEqual(embedding);
  });

  it("embeds multiple texts sequentially via /api/embeddings fallback", async () => {
    const embeddings = [makeEmbedding(768, 1), makeEmbedding(768, 2)];
    const mockFetch = vi.fn()
      // Batch endpoint fails
      .mockResolvedValueOnce(makeFetchResponse({ error: "not found" }, 404))
      // Sequential calls — one per text
      .mockResolvedValueOnce(
        makeFetchResponse(makeEmbeddingsSingleResponse(embeddings[0]!))
      )
      .mockResolvedValueOnce(
        makeFetchResponse(makeEmbeddingsSingleResponse(embeddings[1]!))
      );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(["foo", "bar"]);

    // 1 batch attempt + 2 sequential calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual(embeddings[0]);
    expect(result.embeddings[1]).toEqual(embeddings[1]);
  });

  it("sends model and prompt fields in the /api/embeddings request body", async () => {
    const embedding = makeEmbedding(768, 1);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeFetchResponse({ error: "not found" }, 404))
      .mockResolvedValueOnce(
        makeFetchResponse(makeEmbeddingsSingleResponse(embedding))
      );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider({ model: "nomic-embed-text" });
    await provider.embed(["my text"]);

    const [, fallbackInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(fallbackInit.body as string) as {
      model: string;
      prompt: string;
    };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.prompt).toBe("my text");
  });

  it("returns zero totalTokens for the /api/embeddings sequential path", async () => {
    const embedding = makeEmbedding(768, 1);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeFetchResponse({ error: "not found" }, 404))
      .mockResolvedValueOnce(
        makeFetchResponse(makeEmbeddingsSingleResponse(embedding))
      );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed(["hello"]);

    expect(result.usage.totalTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("throws when both /api/embed and /api/embeddings fail", async () => {
    const mockFetch = vi.fn()
      // Batch endpoint fails
      .mockResolvedValueOnce(makeFetchResponse({ error: "not found" }, 404))
      // Sequential endpoint also fails
      .mockResolvedValueOnce(
        makeFetchResponse({ error: "internal server error" }, 500)
      );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider();
    await expect(provider.embed(["hello"])).rejects.toThrow(/HTTP 500/);
  });

  it("throws on a sequential /api/embeddings failure mid-batch", async () => {
    const embedding = makeEmbedding(768, 1);
    const mockFetch = vi.fn()
      // Batch endpoint fails → triggers fallback
      .mockResolvedValueOnce(makeFetchResponse({ error: "not found" }, 404))
      // First sequential call succeeds
      .mockResolvedValueOnce(
        makeFetchResponse(makeEmbeddingsSingleResponse(embedding))
      )
      // Second sequential call fails
      .mockResolvedValueOnce(
        makeFetchResponse({ error: "model not loaded" }, 500)
      );
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider();
    await expect(provider.embed(["first", "second"])).rejects.toThrow(/HTTP 500/);
  });
});
