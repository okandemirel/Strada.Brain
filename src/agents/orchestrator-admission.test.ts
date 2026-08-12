/**
 * Supervisor admission: which requests get multi-agent treatment.
 *
 * The gate used to read
 *
 *   if (!force && !isDecomposable && (!classification || !meetsThreshold)) -> direct
 *
 * which made `isDecomposable` sufficient on its own. That value is
 * GoalDecomposer.shouldDecompose, whose entire body is `prompt.length >= 60`
 * and whose own docstring calls it "a MINIMAL pre-filter: it only blocks
 * obviously trivial messages". Used as an activator, it meant any request
 * longer than a tweet took the supervisor path and the classifier's verdict was
 * discarded.
 *
 * Measured cost of that: "write one C# file under Assets/Scripts in the
 * PixelFlow namespace" is 113 characters and classifies as
 * code-generation/moderate — below the configured "complex" threshold. The
 * classifier said no; the length check overruled it; a single-file edit was
 * routed through goal decomposition, a wave planner and multi-agent dispatch,
 * and produced no file at all.
 */

import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { TaskClassification } from "../agent-core/routing/routing-types.js";

function makeOrchestrator(options: {
  classification?: TaskClassification;
  threshold?: "moderate" | "complex";
  withClassifier?: boolean;
}) {
  const mockProvider = {
    name: "mock",
    capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: true, vision: false, systemPrompt: true },
    chat: vi.fn(),
    healthCheck: vi.fn(),
  };

  const orchestrator = new Orchestrator({
    providerManager: {
      getProvider: () => mockProvider,
      getProviderByName: () => mockProvider,
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      listAvailable: () => [{ name: "mock", label: "mock", defaultModel: "default" }],
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: { sendMessage: vi.fn(), type: "cli" } as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    // Present but never reached in these cases; admission returns before it.
    supervisorBrain: { execute: vi.fn(), shouldExecute: () => true } as never,
    supervisorComplexityThreshold: options.threshold ?? "complex",
  });

  // The real orchestrator always has one; the length heuristic reads through it.
  (orchestrator as unknown as { goalDecomposer: unknown }).goalDecomposer = {
    shouldDecompose: (prompt: string) => prompt.trim().length >= 60,
  };

  if (options.withClassifier !== false) {
    (orchestrator as unknown as { taskClassifier: unknown }).taskClassifier = {
      classify: vi.fn().mockReturnValue(
        options.classification ?? { type: "code-generation", complexity: "moderate", criticality: "low" },
      ),
    };
  } else {
    (orchestrator as unknown as { taskClassifier: unknown }).taskClassifier = undefined;
  }

  return orchestrator;
}

/** Longer than the 60-character pre-filter, so length alone would admit it. */
const LONG_MODERATE_PROMPT =
  "Assets/Scripts altina PixelFlow namespace'inde Board.cs adli tek bir C# dosyasi yaz: basit bir grid sinifi olsun.";

describe("supervisor admission", () => {
  it("sends a long but only-moderate request to the direct worker", async () => {
    expect(LONG_MODERATE_PROMPT.length).toBeGreaterThanOrEqual(60);

    const orchestrator = makeOrchestrator({
      classification: { type: "code-generation", complexity: "moderate", criticality: "low" } as TaskClassification,
      threshold: "complex",
    });

    const decision = await orchestrator.evaluateSupervisorAdmission({
      prompt: LONG_MODERATE_PROMPT,
      chatId: "admission-moderate",
      channelType: "cli",
    });

    expect(decision.path).not.toBe("supervisor");
    expect(decision.reason).toBe("low_complexity");
  });

  it("still admits a genuinely complex request", async () => {
    const orchestrator = makeOrchestrator({
      classification: { type: "code-generation", complexity: "complex", criticality: "high" } as TaskClassification,
      threshold: "complex",
    });

    const decision = await orchestrator.evaluateSupervisorAdmission({
      prompt: LONG_MODERATE_PROMPT,
      chatId: "admission-complex",
      channelType: "cli",
    });

    expect(decision.reason).not.toBe("low_complexity");
  });

  it("admits a complex request that happens to be short", async () => {
    // The opposite error would be making length a hard veto: a genuinely
    // complex short request must not be permanently denied the supervisor.
    const orchestrator = makeOrchestrator({
      classification: { type: "analysis", complexity: "complex", criticality: "high" } as TaskClassification,
      threshold: "complex",
    });

    const decision = await orchestrator.evaluateSupervisorAdmission({
      prompt: "Complex task A",
      chatId: "admission-short-complex",
      channelType: "cli",
    });

    expect(decision.reason).not.toBe("low_complexity");
  });

  it("honours a lowered threshold", async () => {
    const orchestrator = makeOrchestrator({
      classification: { type: "code-generation", complexity: "moderate", criticality: "low" } as TaskClassification,
      threshold: "moderate",
    });

    const decision = await orchestrator.evaluateSupervisorAdmission({
      prompt: LONG_MODERATE_PROMPT,
      chatId: "admission-moderate-threshold",
      channelType: "cli",
    });

    expect(decision.reason).not.toBe("low_complexity");
  });

  it("falls back to the length heuristic when there is no classifier", async () => {
    // Length is the stand-in, not the authority — it applies only here.
    const orchestrator = makeOrchestrator({ withClassifier: false });

    const long = await orchestrator.evaluateSupervisorAdmission({
      prompt: LONG_MODERATE_PROMPT,
      chatId: "admission-noclassifier-long",
      channelType: "cli",
    });
    expect(long.reason).not.toBe("low_complexity");

    const short = await orchestrator.evaluateSupervisorAdmission({
      prompt: "hi",
      chatId: "admission-noclassifier-short",
      channelType: "cli",
    });
    expect(short.reason).toBe("low_complexity");
  });
});
