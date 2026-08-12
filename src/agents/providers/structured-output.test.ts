/**
 * Structured output (constrained decoding) across providers.
 *
 * Without it, anything that wants JSON back from a model has to dig it out of
 * prose — consensus-manager carries a hand-rolled brace-balancing scanner plus
 * a keyword fallback for exactly that reason. A schema constrains the reply at
 * decode time, so the response is guaranteed-parseable.
 *
 * The envelope differs by API and sending the wrong one is silently ignored
 * rather than rejected, which is the failure these tests exist to catch:
 *
 *   Anthropic Messages      output_config.format   (top-level output_format is deprecated)
 *   OpenAI chat completions response_format.json_schema
 *   OpenAI Responses        text.format
 *
 * They also pin that `capabilities.structuredOutput` is only true where the
 * schema actually reaches the wire. A capability flag that overstates what the
 * code does is worse than no flag: callers drop their fallback on the strength
 * of it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResponseSchema } from "./provider.interface.js";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate, stream: vi.fn() };
    },
    __mockCreate: mockCreate,
  };
});

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const sdk = (await import("@anthropic-ai/sdk")) as unknown as {
  __mockCreate: ReturnType<typeof vi.fn>;
};

const SCHEMA: ResponseSchema = {
  name: "verdict",
  schema: {
    type: "object",
    properties: { approved: { type: "boolean" } },
    required: ["approved"],
    additionalProperties: false,
  },
};

describe("Anthropic structured output", () => {
  beforeEach(() => vi.clearAllMocks());

  async function requestWith(options?: { responseSchema?: ResponseSchema }) {
    const { ClaudeProvider } = await import("./claude.js");
    sdk.__mockCreate.mockResolvedValue({
      content: [{ type: "text", text: '{"approved":true}' }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new ClaudeProvider("test-api-key");
    await provider.chat("sys", [{ role: "user", content: "hi" }], [], options);
    return sdk.__mockCreate.mock.calls[0]![0];
  }

  it("sends the schema as output_config.format", async () => {
    const request = await requestWith({ responseSchema: SCHEMA });
    expect(request.output_config).toEqual({
      format: { type: "json_schema", schema: SCHEMA.schema },
    });
    // The deprecated top-level spelling must not be used — the API ignores it,
    // so a request carrying only that would silently return unconstrained prose.
    expect(request.output_format).toBeUndefined();
  });

  it("omits the field entirely when no schema is requested", async () => {
    const request = await requestWith();
    expect(request.output_config).toBeUndefined();
  });

  it("declares the capability", async () => {
    const { ClaudeProvider } = await import("./claude.js");
    expect(new ClaudeProvider("k").capabilities.structuredOutput).toBe(true);
  });
});

describe("OpenAI structured output", () => {
  it("sends response_format.json_schema with strict decoding on chat completions", async () => {
    const { OpenAIProvider } = await import("./openai.js");
    const provider = new OpenAIProvider({ mode: "api-key", apiKey: "sk-test" }, "gpt-5.4");

    // buildRequestBody is the seam both the blocking and streaming paths share.
    const body = (
      provider as unknown as {
        buildRequestBody(m: unknown[], t: unknown, s?: ResponseSchema): Record<string, unknown>;
      }
    ).buildRequestBody([], undefined, SCHEMA);

    expect(body["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "verdict", schema: SCHEMA.schema, strict: true },
    });
  });

  it("omits response_format when no schema is requested", async () => {
    const { OpenAIProvider } = await import("./openai.js");
    const provider = new OpenAIProvider({ mode: "api-key", apiKey: "sk-test" }, "gpt-5.4");
    const body = (
      provider as unknown as {
        buildRequestBody(m: unknown[], t: unknown, s?: ResponseSchema): Record<string, unknown>;
      }
    ).buildRequestBody([], undefined);
    expect(body["response_format"]).toBeUndefined();
  });

  it("uses the Responses API's text.format on the subscription path", async () => {
    // The subscription path builds a different request entirely. It returns
    // early from chat() before buildRequestBody is ever reached, so a schema
    // wired only into the chat-completions body would leave this path
    // unconstrained while the capability still advertised support.
    const { OpenAIProvider } = await import("./openai.js");
    const provider = new OpenAIProvider(
      { mode: "chatgpt-subscription", authToken: "token" },
      "gpt-5.4",
    );
    const body = (
      provider as unknown as {
        buildChatGptResponsesRequest(
          s: string, m: unknown[], t: unknown[], r?: ResponseSchema,
        ): Record<string, unknown>;
      }
    ).buildChatGptResponsesRequest("sys", [], [], SCHEMA);

    expect(body["text"]).toEqual({
      format: { type: "json_schema", name: "verdict", schema: SCHEMA.schema, strict: true },
    });
    // The chat-completions spelling is ignored by this endpoint.
    expect(body["response_format"]).toBeUndefined();
  });
});
