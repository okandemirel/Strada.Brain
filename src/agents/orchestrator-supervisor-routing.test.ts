import { describe, expect, it, vi } from "vitest";
import {
  getProviderByNameOrFallback,
  resolveSupervisorAssignment,
} from "./orchestrator-supervisor-routing.js";
import type { TaskClassification } from "../agent-core/routing/routing-types.js";

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

  // FIX #17: the resolved model must be threaded into getProviderByName so the built
  // provider runs THAT model instead of its static default (matching
  // buildTaskAwareProvider which passes getProviderByName(primaryName, modelId)).
  it("threads the resolved modelId through to getProviderByName", () => {
    const kimiProvider = makeProvider("kimi");
    const fallbackProvider = makeProvider("chain(qwen->kimi)");
    const getProviderByName = vi.fn((name: string) => (name === "kimi" ? kimiProvider : null));

    const resolved = getProviderByNameOrFallback(
      { providerManager: { getProviderByName } } as any,
      "Kimi (Moonshot)",
      "qwen",
      fallbackProvider as any,
      "kimi-long-context",
    );

    expect(getProviderByName).toHaveBeenCalledWith("kimi", "kimi-long-context");
    expect(resolved.provider).toBe(kimiProvider);
  });
});

describe("resolveSupervisorAssignment hard-pin fallback", () => {
  const task: TaskClassification = {
    type: "planning",
    complexity: "simple",
    criticality: "medium",
  };

  it("falls back to the current worker when the hard-pinned provider can no longer be built", () => {
    const fallbackProvider = makeProvider("openai");
    const hardPinError = Object.assign(new Error("hard pin unavailable"), {
      code: "HARD_PIN_UNAVAILABLE",
    });

    const ctx = {
      providerManager: {
        getActiveInfo: vi.fn().mockReturnValue({
          selectionMode: "strada-hard-pin",
          providerName: "claude",
          model: "claude-sonnet-4-6",
        }),
        getProvider: vi.fn(() => {
          throw hardPinError;
        }),
        listExecutionCandidates: vi.fn().mockReturnValue([]),
        listAvailable: vi.fn().mockReturnValue([]),
        // getRoutingMetadata is optional; omit so a default catalog version is used.
      },
    } as any;

    const assignment = resolveSupervisorAssignment(
      ctx,
      "planner",
      task,
      "planning",
      "chat:web:1",
      "openai",
      fallbackProvider as any,
    );

    // Must not throw; degrades to the fallback worker.
    expect(assignment.providerName).toBe("openai");
    expect(assignment.provider).toBe(fallbackProvider);
    expect(assignment.reason).toBe("hard-pinned provider unavailable, reusing the current worker");
  });
});
