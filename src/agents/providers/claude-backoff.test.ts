/**
 * PRV-12 (Claude): the Anthropic SDK retried 429s and 5xx internally with no hook, so a
 * rate-limit backoff on Claude was silence to the FallbackChain — its first-response timer
 * fired and the model was filed as unresponsive. Message calls now retry through the
 * project's retry policy (SDK retries off), which reports each backoff via `onBackoff`.
 * The fetch here is the real SDK transport with a fake network underneath.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import { ClaudeProvider } from "./claude.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const mockFetch = vi.fn();

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function messageResponse(): Response {
  return new Response(JSON.stringify(MESSAGE), { status: 200, headers: { "content-type": "application/json" } });
}

function streamResponse(): Response {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { ...MESSAGE, content: [], stop_reason: null } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A 429 whose Retry-After is 10 ms, so the test does not sleep. */
function rateLimited(): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" } }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": "0.01" } },
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const messages = [{ role: "user" as const, content: "hi" }];

describe("Claude reports its rate-limit backoffs", () => {
  it("chat(): a 429 with Retry-After fires onBackoff once, then the retry succeeds", async () => {
    mockFetch.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(messageResponse());
    const onBackoff = vi.fn();

    const response = await new ClaudeProvider("sk-ant-test").chat("sys", messages, [], { onBackoff });

    expect(response.text).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(onBackoff).toHaveBeenCalledTimes(1);
    expect(onBackoff).toHaveBeenCalledWith(expect.objectContaining({ status: 429, delayMs: 10 }));
  });

  it("chatStream(): the same, on the streaming path", async () => {
    mockFetch.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(streamResponse());
    const onBackoff = vi.fn();
    const chunks: string[] = [];

    const response = await new ClaudeProvider("sk-ant-test").chatStream(
      "sys", messages, [], (chunk) => chunks.push(chunk), { onBackoff },
    );

    expect(response.text).toBe("ok");
    expect(chunks.join("")).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(onBackoff).toHaveBeenCalledWith(expect.objectContaining({ status: 429, delayMs: 10 }));
  });

  it("no double retry: the SDK's own retries are off, so a persistent 429 makes 1 + 2 attempts", async () => {
    mockFetch.mockImplementation(async () => rateLimited());
    const onBackoff = vi.fn();

    const failure = await new ClaudeProvider("sk-ant-test").chat("sys", messages, [], { onBackoff })
      .then(() => undefined, (err: unknown) => err);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(onBackoff).toHaveBeenCalledTimes(2);
    // The SDK still turns the final response into its own typed error.
    expect(failure).toBeInstanceOf(APIError);
    expect((failure as APIError).status).toBe(429);
  });

  it("keeps the SDK's retry rule: a 529 is retried, a 400 is not", async () => {
    const overloaded = new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
      status: 529, headers: { "content-type": "application/json" },
    });
    mockFetch.mockResolvedValueOnce(overloaded).mockResolvedValueOnce(messageResponse());
    const onBackoff = vi.fn();
    expect((await new ClaudeProvider("sk-ant-test").chat("sys", messages, [], { onBackoff })).text).toBe("ok");
    expect(onBackoff).toHaveBeenCalledWith(expect.objectContaining({ status: 529 }));

    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));
    const failure = await new ClaudeProvider("sk-ant-test").chat("sys", messages, [])
      .then(() => undefined, (err: unknown) => err);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((failure as APIError).status).toBe(400);
  });
});
