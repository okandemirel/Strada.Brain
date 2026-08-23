/**
 * The retry that lets an endpoint correct our reasoning_effort, end to end.
 *
 * The pure parser is tested next door; this is about the part that costs a
 * request: exactly one retry, only for this error, carrying the corrected value
 * rather than the rejected one, and remembered so the whole session does not pay
 * the 400 again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpencodeProvider } from "./opencode.js";

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => mockLogger,
  getLoggerSafe: () => mockLogger,
}));

const OX_ALPHA_400 =
  'OpenCode (Zen/Go) API error 400: {"error":{"message":"Error from provider ' +
  '(Console Go): Upstream request failed: [1210] This model always engages in ' +
  'thinking and cannot be disabled; please use low, high, or max"}}';

const okResponse = () =>
  ({
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
  }) as unknown as Response;

/** Bodies actually sent, in order, so the retry's payload can be inspected. */
/** A real SSE body, so the streaming path runs rather than being stubbed out. */
const streamResponse = (): Response => {
  const events = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  return new Response(new TextEncoder().encode(events)) as Response;
};

function providerRejectingEffort(rejectValue: string, respond: () => Response = okResponse) {
  const sent: Array<Record<string, unknown>> = [];
  const provider = new OpencodeProvider("key", "ox-alpha-free");
  vi.spyOn(
    provider as unknown as { fetchWithRetry: (u: string, i: RequestInit) => Promise<Response> },
    "fetchWithRetry",
  ).mockImplementation((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push(body);
    if (body["reasoning_effort"] === rejectValue) {
      return Promise.reject(new Error(OX_ALPHA_400));
    }
    return Promise.resolve(respond());
  });
  return { provider, sent };
}

describe("an endpoint that refuses the reasoning_effort we asked for", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries once with the value the endpoint named", async () => {
    const { provider, sent } = providerRejectingEffort("low");

    const result = await provider.chat("sys", [{ role: "user", content: "hi" }], []);

    expect(result.text).toBe("ok");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.["reasoning_effort"]).toBe("low");
    expect(sent[1]?.["reasoning_effort"]).toBe("high");
  });

  it("does not pay the rejection again for the rest of the session", async () => {
    const { provider, sent } = providerRejectingEffort("low");

    await provider.chat("sys", [{ role: "user", content: "hi" }], []);
    await provider.chat("sys", [{ role: "user", content: "again" }], []);

    // Two calls, one retry: the second call goes straight out corrected.
    expect(sent).toHaveLength(3);
    expect(sent[2]?.["reasoning_effort"]).toBe("high");
  });

  it("says what happened, naming both values", async () => {
    const { provider } = providerRejectingEffort("low");
    await provider.chat("sys", [{ role: "user", content: "hi" }], []);

    const [, meta] = mockLogger.warn.mock.calls.at(-1) ?? [];
    expect(meta).toMatchObject({ rejected: "low", nowUsing: "high", model: "ox-alpha-free" });
  });

  it("keeps the streaming path corrected too", async () => {
    const { provider, sent } = providerRejectingEffort("low", streamResponse);

    await provider.chatStream("sys", [{ role: "user", content: "hi" }], [], () => {});

    expect(sent).toHaveLength(2);
    expect(sent[0]?.["stream"]).toBe(true);
    expect(sent[1]?.["stream"]).toBe(true);
    expect(sent[1]?.["reasoning_effort"]).toBe("high");
  });
});

describe("errors that are not this one", () => {
  beforeEach(() => vi.clearAllMocks());

  it("are raised without a second request", async () => {
    const provider = new OpencodeProvider("key", "ox-alpha-free");
    let calls = 0;
    vi.spyOn(
      provider as unknown as { fetchWithRetry: () => Promise<Response> },
      "fetchWithRetry",
    ).mockImplementation(() => {
      calls += 1;
      return Promise.reject(new Error("OpenCode API error 400: max_tokens is too large"));
    });

    await expect(
      provider.chat("sys", [{ role: "user", content: "hi" }], []),
    ).rejects.toThrow("max_tokens is too large");
    expect(calls).toBe(1);
  });

  it("do not leave the provider permanently altered", async () => {
    const provider = new OpencodeProvider("key", "ox-alpha-free");
    const sent: Array<Record<string, unknown>> = [];
    let failNext = true;
    vi.spyOn(
      provider as unknown as { fetchWithRetry: (u: string, i: RequestInit) => Promise<Response> },
      "fetchWithRetry",
    ).mockImplementation((_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("OpenCode API error 503: upstream unavailable"));
      }
      return Promise.resolve(okResponse());
    });

    await expect(provider.chat("sys", [{ role: "user", content: "hi" }], [])).rejects.toThrow();
    await provider.chat("sys", [{ role: "user", content: "hi" }], []);

    expect(sent[1]?.["reasoning_effort"]).toBe("low");
  });
});
