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
  it("books the reviewer's own spend through onUsage, attributed to the review provider (audit 03.3 / D22)", async () => {
    // The reviewer's calls returned only a verdict; every reviewer turn was
    // model spend nobody accounted for.
    const onUsage = vi.fn();
    const params = baseParams({
      consensusManager: {
        shouldConsult: vi.fn().mockReturnValue(true),
        verify: vi.fn().mockResolvedValue({ agreed: true, strategy: "review", reasoning: "fine", usage: { inputTokens: 120, outputTokens: 30 } }),
      },
      reviewAssignment: { provider: { name: "opencode" }, providerName: "opencode", modelId: "deepseek-flash", reason: "diversity" },
      onUsage,
    });
    await runConsensusVerification(params);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "opencode", model: "deepseek-flash", inputTokens: 120, outputTokens: 30 }));
  });

  it("…and a verdict without usage books nothing (guard)", async () => {
    const onUsage = vi.fn();
    await runConsensusVerification(baseParams({ onUsage }));
    expect(onUsage).not.toHaveBeenCalled();
  });

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
