/**
 * ACR-9 — a supervisor's nodes share one budget.
 *
 * The supervisor runs before any run is open (the background executor's top-level
 * admission), so there is no run budget to carve its nodes from. The orchestrator hands the
 * brain one seeded from the global headroom minus what in-flight work has reserved; the
 * brain carves each node's slice from it.
 */
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

describe("Orchestrator.evaluateSupervisorAdmission — the supervisor's budget", () => {
  it("seeds the supervisor run's budget from the headroom other in-flight work has not reserved", async () => {
    const supervisorBrain = {
      shouldExecute: vi.fn().mockReturnValue(true),
      execute: vi.fn().mockResolvedValue({
        success: true, partial: false, output: "done", totalNodes: 2, succeeded: 2,
        failed: 0, blocked: 0, skipped: 0, totalCost: 0, totalDuration: 0, nodeResults: [],
      }),
    };
    const orchestrator = new Orchestrator({
      providerManager: {
        getProvider: () => ({ name: "mock", capabilities: {}, chat: vi.fn() }),
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as never,
      tools: [],
      channel: { name: "mock", onMessage: vi.fn(), sendText: vi.fn(), sendMarkdown: vi.fn() } as never,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      supervisorBrain: supervisorBrain as never,
      supervisorComplexityThreshold: "complex",
    });
    (orchestrator as unknown as { taskClassifier: unknown }).taskClassifier = {
      classify: () => ({ type: "analysis", complexity: "complex", criticality: "high" }),
    };
    // $10 a day, $3 spent, $2 held by live reservations, $1.5 of it left by a dead owner.
    orchestrator.setUnifiedBudgetManager({
      getSnapshot: () => ({
        global: { daily: { usedUsd: 3, limitUsd: 10 }, monthly: { usedUsd: 0, limitUsd: 0 } },
        estimates: { outstandingUsd: 3.5, reconciledUsd: 1.5 },
      }),
    } as never);

    const decision = await orchestrator.evaluateSupervisorAdmission({
      prompt: "Build the whole game from the design document, module by module",
      chatId: "chat-1",
      channelType: "cli",
    } as never);

    expect(decision.path).toBe("supervisor");
    const context = supervisorBrain.execute.mock.calls[0]![1] as {
      runBudget?: { remainingCostUsd(): number; remainingOutputTokens(): number };
    };
    expect(context.runBudget?.remainingCostUsd()).toBeCloseTo(5);
    // Only cost is shared: each node keeps its own run's output-token policy.
    expect(context.runBudget?.remainingOutputTokens()).toBe(Number.POSITIVE_INFINITY);
  });
});
