import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandHandler } from "./command-handler.js";

describe("CommandHandler /routing", () => {
  const sendMarkdown = vi.fn().mockResolvedValue(undefined);
  const sendText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    sendMarkdown.mockReset();
    sendText.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  it("renders recent routing decisions together with runtime execution traces", async () => {
    const handler = new CommandHandler(
      {} as never,
      {
        sendMarkdown,
        sendText,
      } as never,
      {
        listAvailable: () => [],
      } as never,
      undefined,
      undefined,
      undefined,
      {
        getRecentArtifactsForIdentity: () => [
          {
            id: "artifact-1",
            kind: "workflow",
            state: "active",
            name: "Compile Fix Loop",
            description: "Reusable compile fix loop",
            lastStateReason: "Promoted after clean verifier runs.",
            projectWorldFingerprint: "unity:pooling",
            stats: {
              shadowSampleCount: 5,
              activeUseCount: 4,
              cleanCount: 4,
              retryCount: 1,
              failureCount: 0,
              blockerCount: 0,
              harmfulCount: 0,
              recentEvaluations: [],
              regressionFingerprints: {},
            },
            updatedAt: Date.now(),
          },
        ],
      } as never,
      "unity:pooling",
    );

    handler.setProviderRouter({
      getPreset: () => "balanced",
      setPreset: () => {},
      getRecentDecisions: () => [
        {
          provider: "kimi",
          reason: "best planner",
          task: { type: "planning", complexity: "moderate", criticality: "normal" },
          timestamp: Date.now(),
        },
      ],
      getRecentExecutionTraces: () => [
        {
          provider: "kimi",
          model: "kimi-for-coding",
          role: "executor",
          phase: "executing",
          source: "tool-turn-affinity",
          reason: "kept the active tool-turn provider pinned to preserve provider-specific tool context",
          task: { type: "coding", complexity: "complex", criticality: "normal" },
          timestamp: Date.now(),
        },
        {
          provider: "gemini",
          model: "gemini-2.5-pro",
          role: "reviewer",
          phase: "clarification-review",
          source: "clarification-review",
          reason: "reviewed whether a proposed user question should stay internal",
          task: { type: "bug-analysis", complexity: "complex", criticality: "high" },
          timestamp: Date.now() + 1,
        },
      ],
      getRecentPhaseOutcomes: () => [
        {
          provider: "reviewer",
          model: "review-model",
          role: "reviewer",
          phase: "completion-review",
          source: "completion-review",
          status: "replanned",
          reason: "Verifier review requested a new approach.",
          task: { type: "code-review", complexity: "complex", criticality: "high" },
          timestamp: Date.now() + 2,
        },
      ],
      getPhaseScoreboard: () => [
        {
          provider: "reviewer",
          role: "reviewer",
          phase: "completion-review",
          sampleSize: 3,
          score: 0.82,
          approvedCount: 2,
          continuedCount: 0,
          replannedCount: 1,
        blockedCount: 0,
        failedCount: 0,
        verifierSampleSize: 3,
        verifierCleanRate: 0.72,
        rollbackRate: 0.33,
        avgRetryCount: 1.33,
        avgTokenCost: 420,
        repeatedFailureCount: 1,
        latestTimestamp: Date.now() + 3,
        latestReason: "Verifier review requested a new approach.",
      },
      ],
    });

    await handler.handle("chat-1", "routing", ["info"], "user-1");

    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Recent Routing Decisions*"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Recent Runtime Execution*"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("`executing/executor` -> `kimi`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("model=`kimi-for-coding`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("source=`tool-turn-affinity`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("`clarification-review/reviewer` -> `gemini`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Recent Phase Outcomes*"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("status=`replanned`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Adaptive Phase Scores*"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("score=`0.82`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("verifier=`0.72`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Runtime Self-Improvement*"),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it("reports an empty state when no routing or execution history exists", async () => {
    const handler = new CommandHandler(
      {} as never,
      {
        sendMarkdown,
        sendText,
      } as never,
      {
        listAvailable: () => [],
      } as never,
    );

    handler.setProviderRouter({
      getPreset: () => "balanced",
      setPreset: () => {},
      getRecentDecisions: () => [],
      getRecentExecutionTraces: () => [],
      getRecentPhaseOutcomes: () => [],
      getPhaseScoreboard: () => [],
    });

    await handler.handle("chat-1", "routing", ["info"], "user-1");

    expect(sendText).toHaveBeenCalledWith("chat-1", "No routing decisions recorded yet.");
    expect(sendMarkdown).not.toHaveBeenCalled();
  });
});
