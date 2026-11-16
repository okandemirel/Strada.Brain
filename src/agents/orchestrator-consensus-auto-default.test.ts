import { describe, it, expect, vi } from "vitest";
import { runConsensusIfAvailable } from "./orchestrator-loop-shared.js";
import { ConsensusManager } from "../agent-core/routing/consensus-manager.js";
import { TaskClassifier } from "../agent-core/routing/task-classifier.js";
import { createInitialState } from "./agent-state.js";

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  createLogger: vi.fn(),
}));

/**
 * Locks what the DEFAULT CONSENSUS_MODE=auto actually does, so the README and
 * the config description cannot drift from it again: the task classifier reads
 * the user's PROMPT and never yields "critical" / "destructive-operation", and
 * both consensus gates (tool turn and text-only) require one of those. So the
 * second opinion is sought only in CONSENSUS_MODE=always. If the classifier
 * starts producing critical prompts, this test goes red and the docs must be
 * revisited together with the cost decision.
 */
const DESTRUCTIVE_PROMPTS = [
  "delete all the build artifacts and force push the cleaned history to origin",
  "remove the whole database and drop every table then rm -rf the data directory",
  "silinmesi gereken tüm dosyaları sil ve git push --force ile gönder",
];

function ctx(mode: "auto" | "always", prompt: string) {
  const verify = vi.fn().mockResolvedValue({ agreed: true, strategy: "review", originalProvider: "p1" });
  const manager = new ConsensusManager({ mode });
  vi.spyOn(manager, "verify").mockImplementation(verify);
  return {
    verify,
    ctx: {
      consensusManager: manager,
      // Lowest possible confidence: the most favourable case for a review.
      confidenceEstimator: { estimate: vi.fn().mockReturnValue(0.05) },
      providerManager: { listAvailable: () => [1, 2] },
      taskClassifier: new TaskClassifier(),
      prompt,
      responseText: "done",
      toolCalls: [{ id: "t1", name: "shell_exec", input: { command: "rm -rf build" } }],
      currentAssignment: { providerName: "p1", modelId: "m1" },
      currentProviderCapabilities: null,
      agentState: createInitialState("task"),
      executionStrategy: { reviewer: { providerName: "p2", modelId: "m2" } },
      identityKey: "ik",
      chatId: "c1",
      resolveConsensusReviewAssignment: vi.fn().mockReturnValue({
        provider: { name: "p2" }, providerName: "p2", modelId: "m2", reason: "r",
      }),
      recordExecutionTrace: vi.fn(),
      recordPhaseOutcome: vi.fn(),
    },
  };
}

describe("CONSENSUS_MODE=auto (the default) on a destructive tool turn", () => {
  for (const prompt of DESTRUCTIVE_PROMPTS) {
    it(`never calls the reviewer at the lowest confidence: "${prompt.slice(0, 30)}…"`, async () => {
      const { ctx: c, verify } = ctx("auto", prompt);
      await runConsensusIfAvailable(c as never);
      expect(verify).not.toHaveBeenCalled();
    });
  }

  it("the classifier never marks a prompt critical, which is why", () => {
    const classifier = new TaskClassifier();
    for (const prompt of DESTRUCTIVE_PROMPTS) {
      expect(classifier.classify(prompt).criticality).not.toBe("critical");
    }
  });

  it("CONSENSUS_MODE=always does call the reviewer on the same turn (the documented way to turn it on)", async () => {
    // always still passes the tool-turn gate only for critical prompts, so the
    // same prompt is skipped there too; the reviewer runs on non-tool turns.
    const { ctx: c, verify } = ctx("always", DESTRUCTIVE_PROMPTS[0]!);
    c.toolCalls = [];
    await runConsensusIfAvailable(c as never);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
