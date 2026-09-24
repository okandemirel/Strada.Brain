/**
 * PRV-14: a Claude subscription authenticates with an OAuth bearer token, and
 * the Anthropic SDK itself documents `anthropic-beta: oauth-2025-04-20` as
 * required on such requests (lib/credentials/types OAUTH_API_BETA_HEADER). The
 * SDK only adds it on its token-cache path, not for a plain `authToken`, so
 * subscription requests went out without it. And with `apiKey` left undefined
 * the SDK falls back to an ambient ANTHROPIC_API_KEY, sending a second
 * credential beside the bearer token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "./claude.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const mockFetch = vi.fn();

function messageResponse(): Response {
  return new Response(JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function sentHeaders(): Headers {
  const init = mockFetch.mock.calls[0]![1] as RequestInit;
  return new Headers(init.headers);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => messageResponse());
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-ambient-env-key");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-env-bearer");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ask = (p: ClaudeProvider) => p.chat("sys", [{ role: "user", content: "hi" }], []);

describe("Claude subscription requests", () => {
  it("carry the OAuth beta header and only the bearer credential", async () => {
    await ask(new ClaudeProvider({ mode: "claude-subscription", authToken: "sk-ant-oat01-subscription" }));

    const headers = sentHeaders();
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-subscription");
    expect(headers.get("anthropic-beta") ?? "").toContain("oauth-2025-04-20");
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("api-key requests send only the key, without the OAuth beta", async () => {
    await ask(new ClaudeProvider("sk-ant-api-key"));

    const headers = sentHeaders();
    expect(headers.get("x-api-key")).toBe("sk-ant-api-key");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-beta") ?? "").not.toContain("oauth-2025-04-20");
  });
});
