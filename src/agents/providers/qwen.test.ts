import { describe, it, expect, vi } from "vitest";
import { QwenProvider } from "./qwen.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("QwenProvider", () => {
  const provider = new QwenProvider("test-key");
  const buildBody = (messages: unknown[], tools: unknown) =>
    (provider as unknown as { buildRequestBody: (m: unknown[], t: unknown) => Record<string, unknown> })
      .buildRequestBody(messages, tools);

  it("has correct name and capabilities", () => {
    expect(provider.name).toBe("Qwen (Alibaba)");
    expect(provider.capabilities.maxTokens).toBe(8192);
    expect(provider.capabilities.vision).toBe(false);
  });

  it("includes result_format=message in request body", () => {
    const body = buildBody([], undefined);
    expect(body["result_format"]).toBe("message");
  });

  it("includes enable_search=false in request body", () => {
    const body = buildBody([], undefined);
    expect(body["enable_search"]).toBe(false);
  });

  it("preserves standard fields", () => {
    const messages = [{ role: "system", content: "test" }];
    const body = buildBody(messages, undefined);
    expect(body["model"]).toBeDefined();
    expect(body["messages"]).toBe(messages);
  });

  it("includes tools when provided", () => {
    const tools = [{ type: "function", function: { name: "search", description: "Search", parameters: {} } }];
    const body = buildBody([], tools);
    expect(body["tools"]).toBe(tools);
    expect(body["result_format"]).toBe("message");
  });
});
