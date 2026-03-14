import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeProvider } from "./claude.js";
import type { ConversationMessage, MessageContent } from "./provider-core.interface.js";

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "I can see the image." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      },
    })),
  };
});

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("ClaudeProvider vision support", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    provider = new ClaudeProvider("test-key"); // positional arg
  });

  it("declares vision capability", () => {
    expect(provider.capabilities.vision).toBe(true);
  });

  it("converts base64 image blocks in buildMessages", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "dGVzdA==",
            },
          },
        ] as MessageContent[],
      },
    ];

    // Access private method via any
    const built = (provider as any).buildMessages(messages);
    expect(built).toHaveLength(1);
    expect(built[0].role).toBe("user");

    const content = built[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "What is in this image?" });
    expect(content[1].type).toBe("image");
    expect(content[1].source.type).toBe("base64");
    expect(content[1].source.media_type).toBe("image/jpeg");
    expect(content[1].source.data).toBe("dGVzdA==");
  });

  it("converts URL image blocks", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          {
            type: "image",
            source: { type: "url", url: "https://example.com/img.png" },
          },
        ] as MessageContent[],
      },
    ];

    const built = (provider as any).buildMessages(messages);
    const content = built[0].content;
    expect(content[1].type).toBe("image");
    expect(content[1].source.type).toBe("url");
    expect(content[1].source.url).toBe("https://example.com/img.png");
  });

  it("handles mixed text, image, and tool_result blocks", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
          { type: "tool_result", tool_use_id: "tool-1", content: "result data" },
        ] as MessageContent[],
      },
    ];

    const built = (provider as any).buildMessages(messages);
    expect(built).toHaveLength(1);
    const content = built[0].content;
    expect(content.length).toBe(3);
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image");
    expect(content[2].type).toBe("tool_result");
  });
});
