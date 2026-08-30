import { describe, expect, it, vi } from "vitest";
import { runConsensusVerification } from "./orchestrator-consensus.js";

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    consensusManager: {
      shouldConsult: vi.fn().mockReturnValue(true),
      verify: vi.fn().mockResolvedValue({
        agreed: false,
        strategy: "second-opinion",
        reasoning: "The delete targets the wrong directory",
      }),
    },
    availableProviderCount: 2,
    taskClass: { type: "destructive-operation", criticality: "critical" },
    confidence: 0.3,
    originalOutput: { text: "rm -rf build/" },
    originalProviderName: "openai",
    prompt: "clean the build outputs",
    reviewAssignment: { provider: { name: "opencode" }, providerName: "opencode", reason: "diversity" },
    chatId: "chat-1",
    identityKey: "id-1",
    recordExecutionTrace: vi.fn(),
    recordPhaseOutcome: vi.fn(),
    ...overrides,
  } as never;
}

describe("runConsensusVerification", () => {
  it("returns the disagreement so the caller can act on it (not advisory-only)", async () => {
    // Audited 2026-08-30: the second opinion was recorded and then changed
    // nothing. The verdict must reach the caller, which injects the objection
    // into the next iteration.
    const verdict = await runConsensusVerification(baseParams());
    expect(verdict).toEqual({
      agreed: false,
      reasoning: "The delete targets the wrong directory",
    });
  });

  it("returns agreement verdicts too", async () => {
    const params = baseParams();
    (params as { consensusManager: { verify: ReturnType<typeof vi.fn> } }).consensusManager.verify =
      vi.fn().mockResolvedValue({ agreed: true, strategy: "second-opinion" });
    const verdict = await runConsensusVerification(params);
    expect(verdict?.agreed).toBe(true);
  });
});
