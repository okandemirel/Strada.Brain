import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { anthropicModelsListMock, mockFetch, safeLogger } = vi.hoisted(() => ({
  anthropicModelsListMock: vi.fn(),
  mockFetch: vi.fn(),
  safeLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: vi.fn(),
  getLogRingBuffer: vi.fn(() => []),
  getLogger: () => {
    throw new Error("Logger not initialized. Call createLogger() first.");
  },
  getLoggerSafe: () => safeLogger,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    models = {
      list: anthropicModelsListMock,
    };

    messages = {
      create: vi.fn(),
      stream: vi.fn(),
    };
  },
}));

import { preflightResponseProviders } from "./response-provider-preflight.js";

describe("response-provider-preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes OpenAI-compatible provider preflight without an initialized logger", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
    });

    await expect(preflightResponseProviders(
      ["openai"],
      {
        openai: { apiKey: "sk-test" },
      },
    )).resolves.toEqual({
      passedProviderIds: ["openai"],
      failures: [],
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("passes Claude preflight without an initialized logger", async () => {
    anthropicModelsListMock.mockResolvedValue({
      data: [{ id: "claude-sonnet-4-6-20250514" }],
    });

    await expect(preflightResponseProviders(
      ["claude"],
      {
        claude: { apiKey: "claude-key" },
      },
    )).resolves.toEqual({
      passedProviderIds: ["claude"],
      failures: [],
    });

    expect(anthropicModelsListMock).toHaveBeenCalledWith({ limit: 1 });
  });

  it("passes Claude subscription-token preflight without an initialized logger", async () => {
    anthropicModelsListMock.mockResolvedValue({
      data: [{ id: "claude-sonnet-4-6-20250514" }],
    });

    await expect(preflightResponseProviders(
      ["claude"],
      {
        claude: {
          anthropicAuthMode: "claude-subscription",
          anthropicAuthToken: "claude-subscription-token-123456",
        },
      },
    )).resolves.toEqual({
      passedProviderIds: ["claude"],
      failures: [],
    });

    expect(anthropicModelsListMock).toHaveBeenCalledWith({ limit: 1 });
  });

  it("passes Ollama preflight without an initialized logger", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
    });

    await expect(preflightResponseProviders(
      ["ollama"],
      {},
    )).resolves.toEqual({
      passedProviderIds: ["ollama"],
      failures: [],
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });
});
