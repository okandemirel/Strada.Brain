/**
 * PRV-3: a ChatGPT/Codex subscription token the server invalidated before its
 * local JWT expired is rejected with a 401. The refresh-and-retry that answers
 * that case sat AFTER fetchWithRetry, which throws on a 401 instead of returning
 * it — so on the chat path the refresh never ran, the 401 reached the chain as a
 * credential rejection, and the whole seat was benched for hours over a token
 * one refresh would have renewed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ token: "old-token", refresh: vi.fn() }));

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

vi.mock("../../common/openai-subscription-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../common/openai-subscription-auth.js")>();
  return {
    ...actual,
    ensureOpenAiSubscriptionAuth: vi.fn(async () => ({
      ok: true, authFile: "auth.json", accessToken: auth.token, accountId: "acct", detail: "",
    })),
    refreshOpenAiSubscriptionToken: auth.refresh,
  };
});

const { OpenAIProvider } = await import("./openai.js");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function sseOk(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        "event: response.output_text.delta",
        'data: {"delta":"pong"}',
        "",
        "event: response.completed",
        'data: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[]}}',
        "",
      ].join("\n")));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream, text: async () => "", headers: new Headers() } as unknown as Response;
}

function unauthorized(): Response {
  return {
    ok: false,
    status: 401,
    text: async () => '{"detail":"token invalidated"}',
    headers: new Headers(),
    body: { cancel: vi.fn(async () => undefined) },
  } as unknown as Response;
}

const ask = (p: InstanceType<typeof OpenAIProvider>) =>
  p.chat("system", [{ role: "user", content: "ping" }], []);

const bearerOf = (call: number): string =>
  (mockFetch.mock.calls[call]![1] as { headers: Record<string, string> }).headers["Authorization"]!;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset, not clear: a once-queued response left by a previous test must not leak.
  mockFetch.mockReset();
  auth.token = "old-token";
  auth.refresh.mockImplementation(async () => {
    auth.token = "new-token";
    return { ok: true };
  });
});

describe("ChatGPT/Codex subscription chat path refreshes a rejected token once", () => {
  it("refreshes after a 401 and answers with the renewed token", async () => {
    mockFetch.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(sseOk());
    const provider = new OpenAIProvider({ mode: "chatgpt-subscription", authFile: "auth.json" });

    await expect(ask(provider)).resolves.toMatchObject({ text: "pong" });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(bearerOf(0)).toBe("Bearer old-token");
    expect(bearerOf(1)).toBe("Bearer new-token");
  });

  it("surfaces the 401 when the refresh fails, without retrying", async () => {
    auth.refresh.mockResolvedValue({ ok: false, error: "refresh_token revoked" });
    mockFetch.mockResolvedValue(unauthorized());
    const provider = new OpenAIProvider({ mode: "chatgpt-subscription", authFile: "auth.json" });

    await expect(ask(provider)).rejects.toThrow(/401/u);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries at most once when the renewed token is rejected too", async () => {
    mockFetch.mockResolvedValue(unauthorized());
    const provider = new OpenAIProvider({ mode: "chatgpt-subscription", authFile: "auth.json" });

    await expect(ask(provider)).rejects.toThrow(/401/u);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
