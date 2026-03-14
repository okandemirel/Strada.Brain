import { describe, it, expect, vi } from "vitest";
import { MistralProvider } from "./mistral.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("MistralProvider", () => {
  const provider = new MistralProvider("test-key");
  const buildBody = (messages: unknown[], tools: unknown) =>
    (provider as unknown as { buildRequestBody: (m: unknown[], t: unknown) => Record<string, unknown> })
      .buildRequestBody(messages, tools);

  it("has correct name and capabilities", () => {
    expect(provider.name).toBe("Mistral");
    expect(provider.capabilities.maxTokens).toBe(8192);
    expect(provider.capabilities.vision).toBe(false);
    expect(provider.capabilities.toolCalling).toBe(true);
  });

  it("includes safe_prompt=false in request body", () => {
    const body = buildBody([{ role: "system", content: "test" }], undefined);
    expect(body["safe_prompt"]).toBe(false);
  });

  it("preserves standard fields in request body", () => {
    const messages = [{ role: "system", content: "test" }];
    const body = buildBody(messages, undefined);
    expect(body["model"]).toBeDefined();
    expect(body["messages"]).toBe(messages);
    expect(body["max_tokens"]).toBe(8192);
  });

  it("includes tools when provided", () => {
    const tools = [{ type: "function", function: { name: "test", description: "test", parameters: {} } }];
    const body = buildBody([], tools);
    expect(body["tools"]).toBe(tools);
    expect(body["safe_prompt"]).toBe(false);
  });
});
