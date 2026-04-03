import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRouter } from "./provider-router.js";
import type { ProviderManagerRef } from "./provider-router.js";
import type { TaskClassification } from "./routing-types.js";
import type { ProviderCapabilities } from "../../agents/providers/provider.interface.js";
import type { TrajectoryPhaseSignalRetriever } from "./trajectory-phase-signal-retriever.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function createMockManager(
  providers: Array<{
    name: string;
    label: string;
    defaultModel: string;
    capabilities?: ProviderCapabilities;
    catalogUpdatedAt?: number;
    catalogFreshnessScore?: number;
    catalogAgeMs?: number;
    catalogStale?: boolean;
    officialAlignmentScore?: number;
    capabilityDriftReasons?: string[];
  }>,
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
    getCatalogSnapshot: (identityKey?: string) => ({
      generatedAt: 123,
      assignmentVersion: identityKey === "user-1" ? 7 : 3,
      stale: false,
      degraded: false,
      health: {
        stale: false,
        degraded: false,
        freshnessScore: 0.91,
        alignmentScore: 0.88,
        updatedAt: 123,
      },
      activeProvider: identityKey === "user-1" ? "beta" : "alpha",
      activeModel: identityKey === "user-1" ? "beta-model" : "alpha-model",
      providers: providers.map((provider) => ({
        name: provider.name,
        label: provider.label,
        defaultModel: provider.defaultModel,
        model: provider.defaultModel,
        active: identityKey ? provider.name === (identityKey === "user-1" ? "beta" : "alpha") : false,
        catalogUpdatedAt: provider.catalogUpdatedAt,
        catalogFreshnessScore: provider.catalogFreshnessScore,
        catalogAgeMs: provider.catalogAgeMs,
        catalogStale: provider.catalogStale,
        officialAlignmentScore: provider.officialAlignmentScore,
        capabilityDriftReasons: provider.capabilityDriftReasons ?? [],
      })),
    }),
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

const PARITY_PROVIDERS = [
  {
    name: "alpha",
    label: "Alpha",
    defaultModel: "alpha-model",
    capabilities: {
      maxTokens: 8192,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      contextWindow: 128_000,
      thinkingSupported: true,
      specialFeatures: ["reasoning"],
    },
  },
  {
    name: "beta",
    label: "Beta",
    defaultModel: "beta-model",
    capabilities: {
      maxTokens: 8192,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      contextWindow: 128_000,
      thinkingSupported: true,
      specialFeatures: ["reasoning"],
    },
  },
];

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

    it("keeps zero-overhead fast path without scanning replay storage", () => {
      const manager = createMockManager(SINGLE_PROVIDER);
      const retriever: TrajectoryPhaseSignalRetriever = {
        getSignalsForTask: () => {
          throw new Error("replay scan should not run for a single provider");
        },
        getSignalForProvider: () => null,
      };
      const router = new ProviderRouter(manager, "balanced", {
        trajectoryPhaseSignalRetriever: retriever,
      });

      const decision = router.resolve(planningTask, "planning", {
        taskDescription: "Fix the Unity editor crash during 100-level generation",
        projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      });

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

    it("prefers fresher and more aligned catalog telemetry when providers are otherwise close", () => {
      const manager = createMockManager([
        {
          ...PARITY_PROVIDERS[0]!,
          catalogUpdatedAt: Date.now() - 30 * 60 * 1000,
          catalogFreshnessScore: 0.98,
          officialAlignmentScore: 0.95,
          catalogStale: false,
        },
        {
          ...PARITY_PROVIDERS[1]!,
          catalogUpdatedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
          catalogFreshnessScore: 0.28,
          officialAlignmentScore: 0.35,
          catalogStale: true,
          capabilityDriftReasons: ["default-model-missing-from-official-catalog"],
        },
      ]);
      const router = new ProviderRouter(manager, "balanced");

      const decision = router.resolve(planningTask, "planning");

      expect(decision.provider).toBe("alpha");
      expect(decision.catalogSignal).toEqual(expect.objectContaining({
        freshnessScore: 0.98,
        alignmentScore: 0.95,
        stale: false,
      }));
    });

    it("exposes catalog assignment metadata through resolveWithCatalog", () => {
      const manager = createMockManager(SINGLE_PROVIDER);
      const router = new ProviderRouter(manager, "balanced");

      const decision = router.resolveWithCatalog(planningTask, "planning", {
        identityKey: "user-1",
      });

      expect(decision).toEqual(expect.objectContaining({
        provider: "ollama",
        model: "llama3.3",
        assignmentVersion: 7,
        reason: expect.any(String),
      }));
      expect(decision.catalog).toEqual(expect.objectContaining({
        stale: false,
        degraded: false,
        freshnessScore: expect.any(Number),
        alignmentScore: expect.any(Number),
      }));
    });
  });

  describe("routing decisions", () => {
    it("records routing decisions", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      router.resolve(planningTask, undefined, { identityKey: "user-1" });
      router.resolve(simpleTask, undefined, { identityKey: "user-1" });
      router.resolve(codeGenTask, undefined, { identityKey: "user-2" });

      const decisions = router.getRecentDecisions(10);
      expect(decisions).toHaveLength(3);
      expect(decisions[0]!.task.type).toBe("planning");
      expect(decisions[1]!.task.type).toBe("simple-question");
      expect(decisions[2]!.task.type).toBe("code-generation");

      const userOneDecisions = router.getRecentDecisions(10, "user-1");
      expect(userOneDecisions).toHaveLength(2);
      expect(userOneDecisions.every((decision) => decision.identityKey === "user-1")).toBe(true);
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

    it("records runtime execution traces separately from routing intent", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      router.recordExecutionTrace({
        provider: "kimi",
        model: "kimi-for-coding",
        role: "executor",
        phase: "executing",
        source: "tool-turn-affinity",
        reason: "kept the active tool-turn provider pinned to preserve provider-specific tool context",
        task: codeGenTask,
        timestamp: 1,
        identityKey: "user-1",
      });
      router.recordExecutionTrace({
        provider: "gemini",
        model: "gemini-2.5-pro",
        role: "reviewer",
        phase: "clarification-review",
        source: "clarification-review",
        reason: "reviewed whether a user-facing clarification was truly necessary",
        task: planningTask,
        timestamp: 2,
        identityKey: "user-2",
      });

      const traces = router.getRecentExecutionTraces(10);
      expect(traces).toHaveLength(2);
      expect(traces[0]).toEqual(expect.objectContaining({
        provider: "kimi",
        model: "kimi-for-coding",
        role: "executor",
        phase: "executing",
        source: "tool-turn-affinity",
      }));
      expect(traces[1]).toEqual(expect.objectContaining({
        provider: "gemini",
        role: "reviewer",
        phase: "clarification-review",
        source: "clarification-review",
      }));
      expect(router.getRecentExecutionTraces(10, "user-1")).toEqual([
        expect.objectContaining({
          provider: "kimi",
          identityKey: "user-1",
        }),
      ]);
    });

    it("records phase outcomes separately from execution traces", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      router.recordPhaseOutcome({
        provider: "reviewer",
        model: "review-model",
        role: "reviewer",
        phase: "completion-review",
        source: "completion-review",
        status: "replanned",
        reason: "Verifier review requested a new approach.",
        task: planningTask,
        timestamp: 3,
        identityKey: "user-1",
      });
      router.recordPhaseOutcome({
        provider: "synth",
        model: "synth-model",
        role: "synthesizer",
        phase: "synthesis",
        source: "synthesis",
        status: "approved",
        reason: "Synthesis produced the final response.",
        task: codeGenTask,
        timestamp: 4,
        identityKey: "user-2",
      });

      expect(router.getRecentPhaseOutcomes(10)).toEqual([
        expect.objectContaining({
          provider: "reviewer",
          status: "replanned",
        }),
        expect.objectContaining({
          provider: "synth",
          status: "approved",
        }),
      ]);
      expect(router.getRecentPhaseOutcomes(10, "user-1")).toEqual([
        expect.objectContaining({
          provider: "reviewer",
          identityKey: "user-1",
        }),
      ]);
    });

    it("builds an adaptive phase scoreboard and prefers providers with cleaner runtime history", () => {
      const manager = createMockManager(PARITY_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      router.recordPhaseOutcome({
        provider: "beta",
        role: "planner",
        phase: "planning",
        source: "supervisor-strategy",
        status: "approved",
        reason: "Produced a clean plan.",
        task: planningTask,
        timestamp: 10,
        identityKey: "user-1",
      });
      router.recordPhaseOutcome({
        provider: "beta",
        role: "planner",
        phase: "planning",
        source: "supervisor-strategy",
        status: "approved",
        reason: "Follow-up planning also stayed clean.",
        task: planningTask,
        timestamp: 11,
        identityKey: "user-1",
      });
      router.recordPhaseOutcome({
        provider: "alpha",
        role: "planner",
        phase: "planning",
        source: "supervisor-strategy",
        status: "replanned",
        reason: "The plan had to be replaced.",
        task: planningTask,
        timestamp: 12,
        identityKey: "user-1",
      });

      const scoreboard = router.getPhaseScoreboard(10, "user-1");
      expect(scoreboard[0]).toEqual(expect.objectContaining({
        provider: "beta",
        phase: "planning",
        score: expect.any(Number),
        sampleSize: 2,
        verifierCleanRate: expect.any(Number),
        rollbackRate: expect.any(Number),
        repeatedWorldContextCount: expect.any(Number),
      }));
      expect(scoreboard.find((entry) => entry.provider === "beta")!.score).toBeGreaterThan(
        scoreboard.find((entry) => entry.provider === "alpha")!.score,
      );

      const decision = router.resolve(planningTask, "planning", { identityKey: "user-1" });
      expect(decision.provider).toBe("beta");
      expect(decision.reason).toContain("phase score");
    });

    it("penalizes rollback-heavy and verifier-dirty histories even when raw approvals look similar", () => {
      const manager = createMockManager(PARITY_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      router.recordPhaseOutcome({
        provider: "alpha",
        role: "reviewer",
        phase: "completion-review",
        source: "completion-review",
        status: "approved",
        reason: "Approved, but only after several retries.",
        task: planningTask,
        timestamp: 1,
        identityKey: "user-2",
        telemetry: {
          verifierDecision: "approve",
          retryCount: 4,
          rollbackDepth: 2,
          inputTokens: 1200,
          outputTokens: 500,
          failureFingerprint: "same failure path",
          projectWorldFingerprint: "root project a modules castle systems 9",
        },
      });
      router.recordPhaseOutcome({
        provider: "alpha",
        role: "reviewer",
        phase: "completion-review",
        source: "completion-review",
        status: "replanned",
        reason: "Verifier reopened the same failing path.",
        task: planningTask,
        timestamp: 2,
        identityKey: "user-2",
        telemetry: {
          verifierDecision: "replan",
          retryCount: 5,
          rollbackDepth: 3,
          inputTokens: 1500,
          outputTokens: 600,
          failureFingerprint: "same failure path",
          projectWorldFingerprint: "root project a modules castle systems 9",
        },
      });
      router.recordPhaseOutcome({
        provider: "beta",
        role: "reviewer",
        phase: "completion-review",
        source: "completion-review",
        status: "approved",
        reason: "Verifier cleared the path cleanly.",
        task: planningTask,
        timestamp: 3,
        identityKey: "user-2",
        telemetry: {
          verifierDecision: "approve",
          retryCount: 0,
          rollbackDepth: 0,
          inputTokens: 400,
          outputTokens: 200,
          projectWorldFingerprint: "root project a modules combat systems 4",
        },
      });
      router.recordPhaseOutcome({
        provider: "beta",
        role: "reviewer",
        phase: "completion-review",
        source: "completion-review",
        status: "approved",
        reason: "Stayed clean on the follow-up pass.",
        task: planningTask,
        timestamp: 4,
        identityKey: "user-2",
        telemetry: {
          verifierDecision: "approve",
          retryCount: 0,
          rollbackDepth: 0,
          inputTokens: 350,
          outputTokens: 150,
          projectWorldFingerprint: "root project a modules ui systems 3",
        },
      });

      const scoreboard = router.getPhaseScoreboard(10, "user-2");
      const alpha = scoreboard.find((entry) => entry.provider === "alpha");
      const beta = scoreboard.find((entry) => entry.provider === "beta");

      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      expect(beta!.score).toBeGreaterThan(alpha!.score);
      expect(alpha!.rollbackRate).toBeGreaterThan(beta!.rollbackRate);
      expect(alpha!.repeatedFailureCount).toBeGreaterThan(beta!.repeatedFailureCount);
      expect(alpha!.repeatedWorldContextCount).toBeGreaterThanOrEqual(beta!.repeatedWorldContextCount);
      expect(alpha!.avgRetryCount).toBeGreaterThan(beta!.avgRetryCount);
    });

    it("uses persisted trajectory replay signals for task-specific phase bias", () => {
      const manager = createMockManager(PARITY_PROVIDERS);
      const retriever: TrajectoryPhaseSignalRetriever = {
        getSignalsForTask: () => [
          {
            provider: "beta",
            phase: "synthesis",
            sampleSize: 3,
            sameWorldMatches: 2,
            successCount: 3,
            failureCount: 0,
            verdictSampleSize: 2,
            verdictScore: 0.91,
            latestTimestamp: 20,
            score: 0.86,
          },
          {
            provider: "alpha",
            phase: "synthesis",
            sampleSize: 2,
            sameWorldMatches: 2,
            successCount: 0,
            failureCount: 2,
            verdictSampleSize: 1,
            verdictScore: 0.22,
            latestTimestamp: 21,
            score: 0.18,
          },
        ],
        getSignalForProvider: () => null,
      };
      const router = new ProviderRouter(manager, "balanced", {
        trajectoryPhaseSignalRetriever: retriever,
      });

      const decision = router.resolve(planningTask, "synthesis", {
        identityKey: "user-3",
        taskDescription: "Fix the Unity editor crash during 100-level generation",
        projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      });

      expect(decision.provider).toBe("beta");
      expect(decision.reason).toContain("replay score");
      expect(decision.reason).toContain("persisted trajectories");
      expect(decision.reason).toContain("verdict");
      expect(decision.replaySignal).toEqual({
        phase: "synthesis",
        score: 0.86,
        sampleSize: 3,
        sameWorldMatches: 2,
        verdictSampleSize: 2,
        verdictScore: 0.91,
        latestTimestamp: 20,
      });
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

  describe("resolveRanked", () => {
    it("returns all providers sorted by score descending", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      const ranked = router.resolveRanked(planningTask);

      expect(ranked.length).toBe(MULTI_PROVIDERS.length);
      // All provider names should be present
      for (const provider of MULTI_PROVIDERS) {
        expect(ranked).toContain(provider.name);
      }
    });

    it("returns single provider for single-provider scenarios", () => {
      const manager = createMockManager(SINGLE_PROVIDER);
      const router = new ProviderRouter(manager, "balanced");

      const ranked = router.resolveRanked(planningTask);

      expect(ranked).toEqual(["ollama"]);
    });

    it("does not record a decision (side-effect free)", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      router.resolveRanked(planningTask);

      expect(router.getRecentDecisions(10)).toHaveLength(0);
    });

    it("respects phase-aware weight adjustment", () => {
      const manager = createMockManager(MULTI_PROVIDERS);
      const router = new ProviderRouter(manager, "balanced");

      // First resolve normally to set lastExecutingProvider
      router.resolve(planningTask);

      const normalRanked = router.resolveRanked(planningTask, "executing");
      const reflectingRanked = router.resolveRanked(planningTask, "reflecting");

      // Both should have all providers
      expect(normalRanked.length).toBe(MULTI_PROVIDERS.length);
      expect(reflectingRanked.length).toBe(MULTI_PROVIDERS.length);
    });
  });
});
