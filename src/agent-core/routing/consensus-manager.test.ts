import { describe, it, expect, vi } from "vitest";
import { ConfidenceEstimator } from "./confidence-estimator.js";
import { ConsensusManager } from "./consensus-manager.js";
import { createLogger } from "../../utils/logger.js";

createLogger("error", "/dev/null");

describe("ConfidenceEstimator", () => {
  const estimator = new ConfidenceEstimator();

  it("returns high confidence for clean session", () => {
    const score = estimator.estimate({
      task: { type: "simple-question", complexity: "trivial", criticality: "low" },
      providerName: "claude",
      agentState: { consecutiveErrors: 0, stepResults: [], iteration: 1 },
      responseLength: 100,
    });
    expect(score).toBeGreaterThan(0.6);
  });

  it("returns low confidence for complex task on cheap model with errors", () => {
    const score = estimator.estimate({
      task: { type: "planning", complexity: "complex", criticality: "high" },
      providerName: "ollama",
      agentState: {
        consecutiveErrors: 3,
        stepResults: [
          { success: false }, { success: false }, { success: false },
        ],
        iteration: 3,
      },
      responseLength: 5,
    });
    expect(score).toBeLessThan(0.3);
  });

  it("reduces confidence for capability mismatch", () => {
    const highCap = estimator.estimate({
      task: { type: "planning", complexity: "complex", criticality: "high" },
      providerName: "claude",
      agentState: { consecutiveErrors: 0, stepResults: [], iteration: 1 },
      responseLength: 500,
    });
    const lowCap = estimator.estimate({
      task: { type: "planning", complexity: "complex", criticality: "high" },
      providerName: "groq",
      agentState: { consecutiveErrors: 0, stepResults: [], iteration: 1 },
      responseLength: 500,
    });
    expect(highCap).toBeGreaterThan(lowCap);
  });

  it("clamps to 0.0-1.0 range", () => {
    const worst = estimator.estimate({
      task: { type: "planning", complexity: "complex", criticality: "critical" },
      providerName: "ollama",
      agentState: { consecutiveErrors: 5, stepResults: Array(10).fill({ success: false }), iteration: 10 },
      responseLength: 0,
    });
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe("ConsensusManager", () => {
  it("skips when disabled", () => {
    const mgr = new ConsensusManager({ mode: "disabled" });
    const strategy = mgr.shouldConsult(0.1, { type: "destructive-operation", complexity: "simple", criticality: "critical" }, 3);
    expect(strategy).toBe("skip");
  });

  it("skips when only 1 provider", () => {
    const mgr = new ConsensusManager({ mode: "auto" });
    const strategy = mgr.shouldConsult(0.1, { type: "planning", complexity: "complex", criticality: "high" }, 1);
    expect(strategy).toBe("skip");
  });

  it("skips when confidence above threshold", () => {
    const mgr = new ConsensusManager({ mode: "auto", threshold: 0.5 });
    const strategy = mgr.shouldConsult(0.8, { type: "code-generation", complexity: "moderate", criticality: "medium" }, 3);
    expect(strategy).toBe("skip");
  });

  it("reviews for destructive operations with low confidence", () => {
    const mgr = new ConsensusManager({ mode: "auto", threshold: 0.5 });
    const strategy = mgr.shouldConsult(0.3, { type: "destructive-operation", complexity: "simple", criticality: "critical" }, 2);
    expect(strategy).toBe("review");
  });

  it("re-executes for very low confidence", () => {
    const mgr = new ConsensusManager({ mode: "auto", threshold: 0.5 });
    const strategy = mgr.shouldConsult(0.2, { type: "code-generation", complexity: "complex", criticality: "medium" }, 3);
    expect(strategy).toBe("re-execute");
  });

  it("critical-only mode skips non-critical tasks", () => {
    const mgr = new ConsensusManager({ mode: "critical-only" });
    const strategy = mgr.shouldConsult(0.1, { type: "code-generation", complexity: "complex", criticality: "high" }, 3);
    expect(strategy).toBe("skip"); // high != critical
  });

  it("critical-only mode reviews critical tasks", () => {
    const mgr = new ConsensusManager({ mode: "critical-only" });
    const strategy = mgr.shouldConsult(0.3, { type: "destructive-operation", complexity: "simple", criticality: "critical" }, 2);
    expect(strategy).toBe("review");
  });

  it("verify returns agreed:true when skipping", async () => {
    const mgr = new ConsensusManager({ mode: "disabled" });
    const result = await mgr.verify({
      originalOutput: { text: "Hello" },
      originalProvider: "claude",
      task: { type: "simple-question", complexity: "trivial", criticality: "low" },
      confidence: 0.9,
      reviewProvider: { chat: vi.fn(), name: "groq" } as any,
      prompt: "Hi",
    });
    expect(result.agreed).toBe(true);
    expect(result.strategy).toBe("skip");
  });

  it("verify performs review with tool call serialization", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: '{"approved": true, "reasoning": "Looks correct"}',
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: {
        text: "Deleting file",
        toolCalls: [{ name: "file_delete", input: { path: "/src/old.cs" } }],
      },
      originalProvider: "claude",
      task: { type: "destructive-operation", complexity: "simple", criticality: "critical" },
      confidence: 0.4,
      reviewProvider: mockReview as any,
      prompt: "Remove the unused file",
    });

    expect(result.strategy).toBe("review");
    expect(mockReview.chat).toHaveBeenCalled();
    // Verify tool call was serialized in the review prompt
    const callArgs = mockReview.chat.mock.calls[0]!;
    const userMsg = callArgs[1][0].content as string;
    expect(userMsg).toContain("file_delete");
    expect(userMsg).toContain("/src/old.cs");
  });

  it("verify returns agreed:true on review failure (fail-open)", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockRejectedValue(new Error("Provider down")),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Some output" },
      originalProvider: "claude",
      task: { type: "code-generation", complexity: "moderate", criticality: "medium" },
      confidence: 0.3,
      reviewProvider: mockReview as any,
      prompt: "Generate code",
    });

    expect(result.agreed).toBe(true); // Fail-open
    expect(result.reasoning).toContain("failed");
  });
});
