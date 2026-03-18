import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRouter } from "./provider-router.js";
import type { ProviderManagerRef } from "./provider-router.js";
import type { TaskClassification } from "./routing-types.js";
import type { ProviderCapabilities } from "../../agents/providers/provider.interface.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function createMockManager(
  providers: Array<{ name: string; label: string; defaultModel: string; capabilities?: ProviderCapabilities }>,
  executionPools: Record<string, string[]> = {},
): ProviderManagerRef {
  return {
    listAvailable: () => providers.map(({ capabilities: _capabilities, ...provider }) => provider),
    listExecutionCandidates: (identityKey?: string) => {
      const allowed = identityKey ? executionPools[identityKey] : undefined;
      const scopedProviders = allowed
        ? providers.filter((provider) => allowed.includes(provider.name))
        : providers;
      return scopedProviders.map((provider) => ({
        ...provider,
        capabilities: provider.capabilities ?? null,
      }));
    },
    describeAvailable: () => providers.map((provider) => ({
      ...provider,
      capabilities: provider.capabilities ?? null,
    })),
    isAvailable: (name: string) => providers.some((p) => p.name === name),
  };
}

const SINGLE_PROVIDER = [
  {
    name: "ollama",
    label: "Ollama (Local)",
    defaultModel: "llama3.3",
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      contextWindow: 8_000,
      thinkingSupported: false,
      specialFeatures: ["local_inference"],
    },
  },
];

const MULTI_PROVIDERS = [
  {
    name: "ollama",
    label: "Ollama (Local)",
    defaultModel: "llama3.3",
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      contextWindow: 8_000,
      thinkingSupported: false,
      specialFeatures: ["local_inference"],
    },
  },
  {
    name: "claude",
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-4-6-20250514",
    capabilities: {
      maxTokens: 8192,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: true,
      systemPrompt: true,
      contextWindow: 1_000_000,
      thinkingSupported: true,
      specialFeatures: ["prompt_caching", "adaptive_thinking"],
    },
  },
  {
    name: "groq",
    label: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    capabilities: {
      maxTokens: 8192,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      contextWindow: 128_000,
      thinkingSupported: false,
      specialFeatures: ["fast_inference"],
    },
  },
  {
    name: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    capabilities: {
      maxTokens: 8192,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      contextWindow: 128_000,
      thinkingSupported: true,
      specialFeatures: ["reasoning", "context_caching"],
    },
  },
];

const planningTask: TaskClassification = {
  type: "planning",
  complexity: "complex",
  criticality: "high",
};

const simpleTask: TaskClassification = {
  type: "simple-question",
  complexity: "trivial",
  criticality: "low",
};

const codeGenTask: TaskClassification = {
  type: "code-generation",
  complexity: "moderate",
  criticality: "medium",
};

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("ProviderRouter", () => {
  describe("single provider", () => {
    it("returns the only available provider directly", () => {
      const manager = createMockManager(SINGLE_PROVIDER);
      const router = new ProviderRouter(manager, "balanced");

      const decision = router.resolve(planningTask);

      expect(decision.provider).toBe("ollama");
      expect(decision.reason).toBe("only available provider");
    });
  });

  describe("multi-provider selection", () => {
    it("selects a capable provider for planning tasks", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "performance");

      const decision = router.resolve(planningTask);

      // Claude has best reasoning/nuanced strengths for planning
      expect(decision.provider).toBe("claude");
      expect(decision.reason).toContain("planning");
    });

    it("selects a cheap provider for simple questions in budget mode", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "budget");

      const decision = router.resolve(simpleTask);

      // Budget mode favors cheap providers (ollama or groq)
      expect(["ollama", "groq"]).toContain(decision.provider);
      expect(decision.reason).toContain("cost-effective");
    });
  });

  describe("routing decisions", () => {
    it("records routing decisions", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      router.resolve(planningTask);
      router.resolve(simpleTask);
      router.resolve(codeGenTask);

      const decisions = router.getRecentDecisions(10);
      expect(decisions).toHaveLength(3);
      expect(decisions[0]!.task.type).toBe("planning");
      expect(decisions[1]!.task.type).toBe("simple-question");
      expect(decisions[2]!.task.type).toBe("code-generation");
    });

    it("limits stored decisions to max", () => {
      const manager = createMockManager(SINGLE_PROVIDER);
      const router = new ProviderRouter(manager, "balanced");

      for (let i = 0; i < 110; i++) {
        router.resolve(simpleTask);
      }

      const decisions = router.getRecentDecisions(200);
      expect(decisions.length).toBeLessThanOrEqual(100);
    });
  });

  describe("preset switching", () => {
    it("changes behavior when preset is switched", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "budget");

      const budgetDecision = router.resolve(codeGenTask);

      router.setPreset("performance");
      const perfDecision = router.resolve(codeGenTask);

      // Budget favors cheap providers, performance favors capable ones
      // At minimum the weights must have changed
      const weights = router.getWeights();
      expect(weights.costWeight).toBe(0.0);
      expect(weights.capabilityWeight).toBe(0.6);

      // The selected providers should differ (budget → cheap, performance → capable)
      // ollama or groq for budget, claude for performance
      expect(
        budgetDecision.provider !== perfDecision.provider ||
          budgetDecision.reason !== perfDecision.reason,
      ).toBe(true);
    });
  });

  describe("phase diversity", () => {
    it("boosts diversity for reflecting phase", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      // First resolve sets lastExecutingProvider
      const execDecision = router.resolve(codeGenTask);
      const executingProvider = execDecision.provider;

      // Reflecting phase should prefer a different provider
      const reflectDecision = router.resolve(codeGenTask, "reflecting");

      // With boosted diversity, the reflecting provider should differ
      // from the executing provider (unless scores are overwhelmingly in favor)
      expect(reflectDecision.provider).not.toBe(executingProvider);
    });

    it("does not crash when reflecting with no previous provider", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      const decision = router.resolve(codeGenTask, "reflecting");
      expect(decision.provider).toBeDefined();
    });
  });

  describe("identity-scoped execution pools", () => {
    it("routes within the identity-specific execution pool instead of every configured provider", () => {
      const manager = createMockManager(MULTI_PROVIDERS, {
        "chat-1": ["ollama", "groq"],
      });
      const router = new ProviderRouter(manager, "performance");

      const decision = router.resolve(planningTask, undefined, { identityKey: "chat-1" });

      expect(["ollama", "groq"]).toContain(decision.provider);
      expect(decision.provider).not.toBe("claude");
      expect(decision.provider).not.toBe("deepseek");
    });
  });
});
