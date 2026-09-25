import { describe, expect, it, vi } from "vitest";
import {
  buildSupervisorExecutionStrategy,
  getProviderByNameOrFallback,
  recordProviderUsage,
  resolveConsensusReviewAssignment,
  resolveSupervisorAssignment,
} from "./orchestrator-supervisor-routing.js";
import type { TaskClassification } from "../agent-core/routing/routing-types.js";
import { ProviderRouter, type ProviderManagerRef } from "../agent-core/routing/provider-router.js";
import { RateLimiter } from "../security/rate-limiter.js";

// RateLimiter.recordTokenUsage logs through getLogger(), which throws outside a
// booted process; the routing module itself does not log.
vi.mock("../utils/logger.js", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => noop, getLoggerSafe: () => noop };
});

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

describe("a routed provider that cannot be built (ORC-20)", () => {
  const task: TaskClassification = { type: "code_generation", complexity: "simple", criticality: "medium" };

  it("names the assignment after the fallback that actually runs, with the fallback's model", () => {
    const fallbackProvider = makeProvider("qwen");
    const ctx = {
      providerManager: {
        getActiveInfo: vi.fn().mockReturnValue({ providerName: "qwen", model: "qwen3-coder" }),
        getProviderByName: vi.fn().mockReturnValue(null),
        listExecutionCandidates: vi.fn().mockReturnValue([]),
        listAvailable: vi.fn().mockReturnValue([]),
      },
      providerRouter: {
        resolve: vi.fn().mockReturnValue({ provider: "openai", model: "gpt-x", reason: "best coder" }),
      },
    } as any;

    const assignment = resolveSupervisorAssignment(
      ctx, "executor", task, "executing", "chat:web:1", "qwen", fallbackProvider as any,
    );

    expect(assignment.provider).toBe(fallbackProvider);
    expect(assignment.providerName).toBe("qwen");
    expect(assignment.modelId).toBe("qwen3-coder");
    expect(assignment.reason).toContain("'openai' is unavailable");
  });

  it("the lookup reports the fallback's name when it falls back", () => {
    const fallbackProvider = makeProvider("qwen");
    const resolved = getProviderByNameOrFallback(
      { providerManager: { getProviderByName: vi.fn().mockReturnValue(null) } } as any,
      "openai",
      "qwen",
      fallbackProvider as any,
      "gpt-x",
    );

    expect(resolved).toEqual({ providerName: "qwen", provider: fallbackProvider, usedFallback: true });
  });

  it("consensus does not pass the current provider off as the alternate reviewer", () => {
    const current = makeProvider("qwen");
    const ctx = {
      providerManager: {
        getActiveInfo: vi.fn().mockReturnValue(undefined),
        getProviderByName: vi.fn().mockReturnValue(null),
        listExecutionCandidates: vi.fn().mockReturnValue([]),
        listAvailable: vi.fn().mockReturnValue([{ name: "qwen" }, { name: "openai" }]),
      },
    } as any;
    const currentAssignment = { role: "executor", providerName: "qwen", provider: current } as any;

    expect(resolveConsensusReviewAssignment(ctx, currentAssignment, currentAssignment, "chat:web:1")).toBeNull();
  });
});

describe("the routing history names the provider each turn runs on (N-2)", () => {
  const task: TaskClassification = { type: "code-generation", complexity: "simple", criticality: "medium" };

  it("a soft preference is routed, and the router records every role's decision for the identity", () => {
    const kimi = makeProvider("kimi");
    const qwen = makeProvider("qwen");
    const providerManager = {
      getActiveInfo: () => ({ providerName: "kimi", model: "kimi-model", selectionMode: "strada-preference-bias" }),
      getProviderByName: (name: string) => (name === "kimi" ? kimi : name === "qwen" ? qwen : null),
      listAvailable: () => [
        { name: "kimi", label: "Kimi", defaultModel: "kimi-model" },
        { name: "qwen", label: "Qwen", defaultModel: "qwen-model" },
      ],
      isAvailable: () => true,
    };
    const router = new ProviderRouter(providerManager as unknown as ProviderManagerRef, "balanced");
    const ctx = { providerManager, providerRouter: router, taskClassifier: { classify: () => task } } as any;

    buildSupervisorExecutionStrategy(ctx, "write the module", "user-1", kimi as any);

    const decisions = router.getRecentDecisions(10, "user-1");
    expect(decisions.map((d) => d.task.type)).toEqual(["planning", "code-generation", "code-review", "simple-question"]);
  });

  it("an explicit hard pin is recorded once per turn, without asking the router", () => {
    const pinned = makeProvider("kimi");
    const recordDecision = vi.fn();
    const resolve = vi.fn();
    const ctx = {
      providerManager: {
        getActiveInfo: () => ({ providerName: "kimi", model: "kimi-max", selectionMode: "strada-hard-pin" }),
      },
      providerRouter: { resolve, recordDecision },
      taskClassifier: { classify: () => task },
    } as any;

    buildSupervisorExecutionStrategy(ctx, "write the module", "user-1", pinned as any);

    expect(resolve).not.toHaveBeenCalled();
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      provider: "kimi",
      identityKey: "user-1",
      reason: "honored the explicit user hard pin",
      task,
    }));
  });

  it("a routed pick that cannot be built records the fallback worker that runs instead", () => {
    const fallbackProvider = makeProvider("qwen");
    const recordDecision = vi.fn();
    const ctx = {
      providerManager: {
        getActiveInfo: vi.fn().mockReturnValue({ providerName: "qwen", model: "qwen3-coder" }),
        getProviderByName: vi.fn().mockReturnValue(null),
        listExecutionCandidates: vi.fn().mockReturnValue([]),
        listAvailable: vi.fn().mockReturnValue([]),
      },
      providerRouter: {
        resolve: vi.fn().mockReturnValue({ provider: "openai", model: "gpt-x", reason: "best coder" }),
        recordDecision,
      },
    } as any;

    resolveSupervisorAssignment(ctx, "executor", task, "executing", "user-1", "qwen", fallbackProvider as any);

    expect(recordDecision).toHaveBeenCalledTimes(1);
    const [decision] = recordDecision.mock.calls[0]!;
    expect(decision).toMatchObject({ provider: "qwen", identityKey: "user-1", task });
    expect(decision.reason).toContain("'openai' is unavailable");
  });

  it("a router failure records the fallback worker", () => {
    const fallbackProvider = makeProvider("qwen");
    const recordDecision = vi.fn();
    const ctx = {
      providerManager: {
        getActiveInfo: vi.fn().mockReturnValue(undefined),
        listExecutionCandidates: vi.fn().mockReturnValue([]),
        listAvailable: vi.fn().mockReturnValue([]),
      },
      providerRouter: {
        resolve: vi.fn(() => {
          throw new Error("catalog unavailable");
        }),
        recordDecision,
      },
    } as any;

    const assignment = resolveSupervisorAssignment(
      ctx, "executor", task, "executing", "user-1", "qwen", fallbackProvider as any,
    );

    expect(assignment.providerName).toBe("qwen");
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      provider: "qwen",
      identityKey: "user-1",
      reason: "routing fallback, reusing the current worker",
    }));
  });
});

describe("recordProviderUsage (audited 2026-09-02)", () => {
  it("hands the cached share of the prompt to the rate limiter, priced like the ledger (audit 03.2 / D21)", () => {
    const plain = new RateLimiter();
    recordProviderUsage({ rateLimiter: plain } as any, "claude", { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }, undefined, "claude-sonnet-5");
    const cached = new RateLimiter();
    recordProviderUsage(
      { rateLimiter: cached } as any,
      "claude",
      { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
      undefined,
      "claude-sonnet-5",
    );
    expect(plain.getSnapshot().costToday).toBeGreaterThan(0);
    expect(cached.getSnapshot().costToday).toBeCloseTo(plain.getSnapshot().costToday * 0.1, 6);
  });

  it("hands the routed model id to the rate limiter, so a free model costs $0", () => {
    // recordProviderUsage already knew modelId (it echoes it on the usage
    // event); the rate limiter's budget wall was the one consumer that never
    // saw it, so a "-free" model was billed at the provider's table rate.
    const rateLimiter = new RateLimiter();
    const ctx = { rateLimiter } as any;

    recordProviderUsage(
      ctx,
      "opencode",
      { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      undefined,
      "grok-code-free",
    );

    const snap = rateLimiter.getSnapshot();
    expect(snap.tokensToday).toBe(2_000_000);
    expect(snap.costToday).toBe(0);
  });

  it("still bills a paid model routed through the same path", () => {
    const rateLimiter = new RateLimiter();
    recordProviderUsage(
      { rateLimiter } as any,
      "opencode",
      { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      undefined,
      "qwen3.6-plus",
    );
    expect(rateLimiter.getSnapshot().costToday).toBeCloseTo(0.6, 5);
  });
});
