/**
 * Prompt cache breakpoint tests.
 *
 * `prompt_caching` was listed in ClaudeProvider.capabilities.specialFeatures
 * from the start, but `cache_control` appeared nowhere in the source — the
 * feature was advertised and never implemented, so every request re-paid full
 * input price for a prefix that barely changes between turns.
 *
 * Anthropic renders the cacheable prefix in a fixed order — tools, then system,
 * then messages — so these tests pin where the breakpoints land, not merely
 * that some cache_control exists somewhere.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeProvider } from "./claude.js";
import type { ToolDefinition } from "./provider.interface.js";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  const mockStream = vi.fn();
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate, stream: mockStream };
    },
    __mockCreate: mockCreate,
    __mockStream: mockStream,
  };
});

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const sdk = (await import("@anthropic-ai/sdk")) as unknown as {
  __mockCreate: ReturnType<typeof vi.fn>;
  __mockStream: ReturnType<typeof vi.fn>;
};

const EPHEMERAL = { type: "ephemeral" };

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `does ${name}`,
    input_schema: { type: "object", properties: {}, required: [] },
  } as ToolDefinition;
}

function textResponse() {
  return {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe("ClaudeProvider prompt caching", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider("test-api-key");
  });

  async function requestFor(systemPrompt: string, tools: ToolDefinition[]) {
    sdk.__mockCreate.mockResolvedValue(textResponse());
    await provider.chat(systemPrompt, [{ role: "user", content: "hi" }], tools);
    return sdk.__mockCreate.mock.calls[0]![0];
  }

  it("marks the system prompt as cacheable", async () => {
    const request = await requestFor("you are a helpful assistant", []);
    expect(request.system).toEqual([
      { type: "text", text: "you are a helpful assistant", cache_control: EPHEMERAL },
    ]);
  });

  it("puts exactly one breakpoint on the last tool, covering the whole block", async () => {
    const request = await requestFor("sys", [tool("read"), tool("write"), tool("bash")]);

    // Only the final tool carries it: it marks the end of the tool block, and
    // one per tool would exhaust the budget of four breakpoints.
    expect(request.tools.map((t: { cache_control?: unknown }) => t.cache_control)).toEqual([
      undefined,
      undefined,
      EPHEMERAL,
    ]);
  });

  it("stays within Anthropic's four-breakpoint budget", async () => {
    const request = await requestFor("sys", Array.from({ length: 25 }, (_, i) => tool(`t${i}`)));
    const count =
      request.tools.filter((t: { cache_control?: unknown }) => t.cache_control).length +
      request.system.filter((b: { cache_control?: unknown }) => b.cache_control).length;
    expect(count).toBeLessThanOrEqual(4);
  });

  it("omits the system field entirely when there is no system prompt", async () => {
    // An empty text block is rejected by the API, so a blank prompt must not
    // become a cached empty block.
    const request = await requestFor("", [tool("read")]);
    expect(request.system).toBeUndefined();
    expect(request.tools[0].cache_control).toEqual(EPHEMERAL);
  });

  it("omits tools entirely when none are supplied", async () => {
    const request = await requestFor("sys", []);
    expect(request.tools).toBeUndefined();
  });

  it("applies the same breakpoints on the streaming path", async () => {
    sdk.__mockStream.mockReturnValue({
      on: vi.fn(),
      finalMessage: async () => textResponse(),
    });

    await provider.chatStream("sys", [{ role: "user", content: "hi" }], [tool("read")], () => {});

    const request = sdk.__mockStream.mock.calls[0]![0];
    expect(request.system[0].cache_control).toEqual(EPHEMERAL);
    expect(request.tools[0].cache_control).toEqual(EPHEMERAL);
  });
});
