import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaProvider } from "./ollama.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OllamaProvider", () => {
  it("sends correct request to Ollama API", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          message: { content: "Hello from Llama", tool_calls: undefined },
          prompt_eval_count: 80,
          eval_count: 40,
        }),
      text: () => Promise.resolve(""),
    });

    const provider = new OllamaProvider("llama3.1", "http://localhost:11434");
    await provider.chat("System", [{ role: "user", content: "Hi" }], []);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/chat",
      expect.objectContaining({ method: "POST" })
    );

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.model).toBe("llama3.1");
    expect(body.stream).toBe(false);
    expect(body.messages[0]).toEqual({ role: "system", content: "System" });
  });

  it("parses text response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          message: { content: "Response text" },
          prompt_eval_count: 50,
          eval_count: 25,
        }),
      text: () => Promise.resolve(""),
    });

    const provider = new OllamaProvider();
    const result = await provider.chat("sys", [{ role: "user", content: "Hi" }], []);

    expect(result.text).toBe("Response text");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(25);
  });

  it("parses tool call response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "file_read",
                  arguments: { path: "/test.cs" },
                },
              },
            ],
          },
          prompt_eval_count: 100,
          eval_count: 20,
        }),
      text: () => Promise.resolve(""),
    });

    const provider = new OllamaProvider();
    const result = await provider.chat("sys", [{ role: "user", content: "read" }], [
      { name: "file_read", description: "Read", input_schema: {} },
    ]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("file_read");
    expect(result.toolCalls[0]!.input).toEqual({ path: "/test.cs" });
    expect(result.stopReason).toBe("tool_use");
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Model not found"),
    });

    const provider = new OllamaProvider();
    await expect(
      provider.chat("sys", [{ role: "user", content: "Hi" }], [])
    ).rejects.toThrow("Ollama API error 500");
  });

  it("handles missing usage counts", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          message: { content: "Ok" },
        }),
      text: () => Promise.resolve(""),
    });

    const provider = new OllamaProvider();
    const result = await provider.chat("sys", [{ role: "user", content: "Hi" }], []);

    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });
});
