import { describe, expect, it, vi } from "vitest";
import { getProviderByNameOrFallback } from "./orchestrator-supervisor-routing.js";

function makeProvider(name: string) {
  return {
    name,
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn(),
  };
}

describe("getProviderByNameOrFallback", () => {
  it("canonicalizes provider display labels before assignment metadata is built", () => {
    const kimiProvider = makeProvider("kimi");
    const fallbackProvider = makeProvider("chain(qwen->kimi)");

    const resolved = getProviderByNameOrFallback(
      {
        providerManager: {
          getProviderByName: vi.fn((name: string) => (name === "kimi" ? kimiProvider : null)),
        },
      } as any,
      "Kimi (Moonshot)",
      "qwen",
      fallbackProvider as any,
    );

    expect(resolved.providerName).toBe("kimi");
    expect(resolved.provider).toBe(kimiProvider);
  });

  it("uses the canonical fallback provider name instead of the raw provider instance label", () => {
    const fallbackProvider = makeProvider("chain(qwen->kimi)");

    const resolved = getProviderByNameOrFallback(
      {
        providerManager: {
          getProviderByName: vi.fn().mockReturnValue(null),
        },
      } as any,
      undefined,
      "qwen",
      fallbackProvider as any,
    );

    expect(resolved.providerName).toBe("qwen");
    expect(resolved.provider).toBe(fallbackProvider);
  });
});
