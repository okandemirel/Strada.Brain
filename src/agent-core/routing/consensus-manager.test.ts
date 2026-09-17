import { describe, it, expect, vi } from "vitest";
import { ConfidenceEstimator } from "./confidence-estimator.js";
import { ConsensusManager } from "./consensus-manager.js";
import type { ProviderCapabilities } from "../../agents/providers/provider.interface.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
  createLogger: vi.fn(),
}));

function makeCapabilities(
  overrides: Partial<ProviderCapabilities> = {},
): ProviderCapabilities {
  return {
    maxTokens: 8_192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: false,
    systemPrompt: true,
    thinkingSupported: false,
    specialFeatures: [],
    ...overrides,
  };
}

describe("ConfidenceEstimator", () => {
  const estimator = new ConfidenceEstimator();

  it("returns high confidence for clean session", () => {
    const score = estimator.estimate({
      task: { type: "simple-question", complexity: "trivial", criticality: "low" },
      providerName: "claude",
      providerCapabilities: makeCapabilities({
        thinkingSupported: true,
        contextWindow: 200_000,
        maxTokens: 32_000,
        specialFeatures: ["reviewer"],
      }),
      agentState: { consecutiveErrors: 0, stepResults: [], iteration: 1 },
      responseLength: 100,
    });
    expect(score).toBeGreaterThan(0.6);
  });

  it("returns low confidence for complex task on cheap model with errors", () => {
    const score = estimator.estimate({
      task: { type: "planning", complexity: "complex", criticality: "high" },
      providerName: "ollama",
      providerCapabilities: makeCapabilities({
        toolCalling: false,
        streaming: false,
        maxTokens: 4_096,
      }),
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
      providerCapabilities: makeCapabilities({
        thinkingSupported: true,
        contextWindow: 200_000,
        maxTokens: 32_000,
        specialFeatures: ["reviewer"],
      }),
      agentState: { consecutiveErrors: 0, stepResults: [], iteration: 1 },
      responseLength: 500,
    });
    const lowCap = estimator.estimate({
      task: { type: "planning", complexity: "complex", criticality: "high" },
      providerName: "groq",
      providerCapabilities: makeCapabilities({
        toolCalling: false,
        streaming: true,
        maxTokens: 4_096,
      }),
      agentState: { consecutiveErrors: 0, stepResults: [], iteration: 1 },
      responseLength: 500,
    });
    expect(highCap).toBeGreaterThan(lowCap);
  });

  it("clamps to 0.0-1.0 range", () => {
    const worst = estimator.estimate({
      task: { type: "planning", complexity: "complex", criticality: "critical" },
      providerName: "ollama",
      providerCapabilities: makeCapabilities({
        toolCalling: false,
        streaming: false,
        maxTokens: 2_048,
      }),
      agentState: { consecutiveErrors: 5, stepResults: Array(10).fill({ success: false }), iteration: 10 },
      responseLength: 0,
    });
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("falls back to a neutral capability tier when runtime capabilities are unavailable", () => {
    const score = estimator.estimate({
      task: { type: "analysis", complexity: "moderate", criticality: "medium" },
      providerName: "unknown-provider",
      agentState: { consecutiveErrors: 0, stepResults: [], iteration: 1 },
      responseLength: 120,
    });
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.9);
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

  it("verify returns agreed:false on review failure (fail-safe)", async () => {
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

    expect(result.agreed).toBe(false);
    expect(result.reasoning).toContain("failed");
  });

  it("treats malformed reviewer output as not approved", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "uncertain - needs manual review",
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Some output" },
      originalProvider: "claude",
      task: { type: "destructive-operation", complexity: "simple", criticality: "critical" },
      confidence: 0.5, // >= 0.4 so "always" mode picks "review" (not "re-execute")
      reviewProvider: mockReview as any,
      prompt: "Delete the file",
    });

    expect(result.agreed).toBe(false);
    expect(result.strategy).toBe("review");
  });

  // --- Re-execute strategy tests ---

  it("re-execute: tool disagreement (original has tools, second has none) -> agreed:false", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "I think we should just explain the concept.",
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: {
        text: "Running tool",
        toolCalls: [{ name: "file_write", input: { path: "/a.ts" } }],
      },
      originalProvider: "claude",
      task: { type: "code-generation", complexity: "complex", criticality: "medium" },
      confidence: 0.1, // very low -> re-execute
      reviewProvider: mockReview as any,
      prompt: "Create a new TypeScript file",
    });

    expect(result.agreed).toBe(false);
    expect(result.strategy).toBe("re-execute");
    expect(result.reasoning).toContain("disagree");
  });

  it("re-execute: same tools used by both providers -> agreed:true", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "Writing file",
        toolCalls: [
          { name: "file_write", input: { path: "/b.ts" } },
          { name: "file_read", input: { path: "/c.ts" } },
        ],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: {
        text: "Writing file",
        toolCalls: [
          { name: "file_write", input: { path: "/a.ts" } },
          { name: "file_read", input: { path: "/d.ts" } },
        ],
      },
      originalProvider: "claude",
      task: { type: "code-generation", complexity: "complex", criticality: "medium" },
      confidence: 0.1,
      reviewProvider: mockReview as any,
      prompt: "Write two files",
    });

    expect(result.agreed).toBe(true);
    expect(result.strategy).toBe("re-execute");
    expect(result.reasoning).toContain("Tool agreement: 100%");
  });

  it("re-execute: completely different tools -> agreed:false (low overlap)", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "Deleting old files",
        toolCalls: [
          { name: "file_delete", input: { path: "/old.ts" } },
          { name: "shell_exec", input: { cmd: "rm -rf" } },
        ],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: {
        text: "Creating new files",
        toolCalls: [
          { name: "file_write", input: { path: "/new.ts" } },
          { name: "file_read", input: { path: "/ref.ts" } },
          { name: "git_commit", input: {} },
        ],
      },
      originalProvider: "claude",
      task: { type: "code-generation", complexity: "complex", criticality: "medium" },
      confidence: 0.1,
      reviewProvider: mockReview as any,
      prompt: "Refactor the module",
    });

    expect(result.agreed).toBe(false);
    expect(result.strategy).toBe("re-execute");
    expect(result.reasoning).toContain("0%");
  });

  it("re-execute: both text responses -> sends comparison prompt", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn()
        // First call: re-execute (same prompt)
        .mockResolvedValueOnce({
          text: "The answer is 42. Here is a detailed explanation...",
          toolCalls: [],
          stopReason: "end_turn",
        })
        // Second call: comparison prompt
        .mockResolvedValueOnce({
          text: '{"agreed": true, "reasoning": "Both responses provide similar answers"}',
          toolCalls: [],
          stopReason: "end_turn",
        }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "The answer is 42 because of the meaning of life." },
      originalProvider: "claude",
      task: { type: "simple-question", complexity: "trivial", criticality: "low" },
      confidence: 0.1,
      reviewProvider: mockReview as any,
      prompt: "What is the meaning of life?",
    });

    expect(result.strategy).toBe("re-execute");
    expect(result.agreed).toBe(true);
    // Verify two calls: one for re-execute, one for comparison
    expect(mockReview.chat).toHaveBeenCalledTimes(2);
    // Second call should contain comparison prompt
    const secondCallArgs = mockReview.chat.mock.calls[1]!;
    const comparisonMsg = secondCallArgs[1][0].content as string;
    expect(comparisonMsg).toContain("Compare these two responses");
    expect(comparisonMsg).toContain("Response A:");
    expect(comparisonMsg).toContain("Response B:");
  });

  it("re-execute: both text, comparison disagrees -> agreed:false", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn()
        .mockResolvedValueOnce({
          text: "Completely different answer",
          toolCalls: [],
          stopReason: "end_turn",
        })
        .mockResolvedValueOnce({
          text: '{"agreed": false, "reasoning": "Responses take completely different approaches"}',
          toolCalls: [],
          stopReason: "end_turn",
        }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Original answer with a specific approach" },
      originalProvider: "claude",
      task: { type: "analysis", complexity: "moderate", criticality: "medium" },
      confidence: 0.1,
      reviewProvider: mockReview as any,
      prompt: "Analyze this code",
    });

    expect(result.strategy).toBe("re-execute");
    expect(result.agreed).toBe(false);
  });

  // --- parseApproval tests ---

  it("parseApproval: JSON with 'agreed' key -> true", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn()
        .mockResolvedValueOnce({ text: "Second text response", toolCalls: [], stopReason: "end_turn" })
        .mockResolvedValueOnce({
          text: '{"agreed": true, "reasoning": "They match"}',
          toolCalls: [],
          stopReason: "end_turn",
        }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "First text response" },
      originalProvider: "claude",
      task: { type: "simple-question", complexity: "trivial", criticality: "low" },
      confidence: 0.1,
      reviewProvider: mockReview as any,
      prompt: "Hi",
    });

    expect(result.agreed).toBe(true);
  });

  it("parseApproval: positive keyword 'approved' -> true", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "The action looks good. Approved.",
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Some action" },
      originalProvider: "claude",
      task: { type: "destructive-operation", complexity: "simple", criticality: "critical" },
      confidence: 0.5, // review strategy
      reviewProvider: mockReview as any,
      prompt: "Delete file",
    });

    expect(result.agreed).toBe(true);
    expect(result.strategy).toBe("review");
  });

  it("parseApproval: positive keyword 'agree' -> true (via review)", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "I agree with this approach. It should work fine.",
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Some action" },
      originalProvider: "claude",
      task: { type: "code-generation", complexity: "moderate", criticality: "medium" },
      confidence: 0.5,
      reviewProvider: mockReview as any,
      prompt: "Generate code",
    });

    expect(result.agreed).toBe(true);
  });

  it("parseApproval: ambiguous text without keywords -> false (fail-closed)", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "Hmm, this is an interesting situation. Let me think about it. It might work.",
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Some action" },
      originalProvider: "claude",
      task: { type: "code-generation", complexity: "moderate", criticality: "medium" },
      confidence: 0.5,
      reviewProvider: mockReview as any,
      prompt: "Generate code",
    });

    expect(result.agreed).toBe(false);
    expect(result.strategy).toBe("review");
  });

  it("parseApproval: 'not approved' overrides 'approved' keyword -> false", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "This is not approved because it could cause data loss.",
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };

    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Drop database" },
      originalProvider: "claude",
      task: { type: "destructive-operation", complexity: "simple", criticality: "critical" },
      confidence: 0.5,
      reviewProvider: mockReview as any,
      prompt: "Drop the database",
    });

    expect(result.agreed).toBe(false);
  });

  it("parseApproval: a nested {approved:true} inside a rejection does NOT flip to approved", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: '{"previousAttempt":{"approved":true},"comment":"this regresses behavior, do not ship it"}',
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };
    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Some action" },
      originalProvider: "claude",
      task: { type: "destructive-operation", complexity: "simple", criticality: "critical" },
      confidence: 0.5,
      reviewProvider: mockReview as any,
      prompt: "Delete file",
    });
    expect(result.agreed).toBe(false);
  });

  it("parseApproval: conflicting top-level verdicts fail closed", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: 'The earlier draft said {"approved": true} but on reflection: {"approved": false}',
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };
    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Some action" },
      originalProvider: "claude",
      task: { type: "destructive-operation", complexity: "simple", criticality: "critical" },
      confidence: 0.5,
      reviewProvider: mockReview as any,
      prompt: "Delete file",
    });
    expect(result.agreed).toBe(false);
  });

  it("parseApproval: prose 'incorrect' is a rejection, not approval via the 'correct' substring", async () => {
    const mockReview = {
      name: "groq",
      chat: vi.fn().mockResolvedValue({
        text: "The proposed change is incorrect and should be reworked.",
        toolCalls: [],
        stopReason: "end_turn",
      }),
    };
    const mgr = new ConsensusManager({ mode: "always", threshold: 1.0 });
    const result = await mgr.verify({
      originalOutput: { text: "Some action" },
      originalProvider: "claude",
      task: { type: "code-generation", complexity: "moderate", criticality: "medium" },
      confidence: 0.5,
      reviewProvider: mockReview as any,
      prompt: "Generate code",
    });
    expect(result.agreed).toBe(false);
  });
});


describe("ConsensusManager carries the reviewer's usage (audit 03.3 / D22)", () => {
  const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
  const reviewer = (answers: Array<{ text: string; inputTokens: number; outputTokens: number; servedBy?: { provider: string; model?: string }; auxiliary?: number; fail?: boolean }>) => {
    const chat = vi.fn();
    for (const a of answers) {
      if (a.fail) { chat.mockRejectedValueOnce(new Error("reviewer timed out")); continue; }
      chat.mockResolvedValueOnce({
        text: a.text, toolCalls: [], stopReason: "end_turn", usage: usage(a.inputTokens, a.outputTokens),
        ...(a.servedBy ? { servedBy: a.servedBy } : {}),
        ...(a.auxiliary ? { auxiliaryUsage: usage(a.auxiliary, 0) } : {}),
      });
    }
    return { name: "reviewer", chat } as never;
  };
  const task = { type: "code_generation", complexity: "moderate", criticality: "high" } as never;

  it("the review strategy returns the reviewer call's usage", async () => {
    const cm = new ConsensusManager(new ConfidenceEstimator());
    const result = await (cm as unknown as { reviewStrategy(p: unknown): Promise<{ agreed: boolean; usages?: unknown[] }> }).reviewStrategy({
      originalOutput: { text: "done" }, originalProvider: "claude", reviewProvider: reviewer([{ text: '{"approved": true, "reasoning": "ok"}', inputTokens: 120, outputTokens: 30 }]), prompt: "p", task,
    });
    expect(result.agreed).toBe(true);
    expect(result.usages).toEqual([expect.objectContaining({ inputTokens: 120, outputTokens: 30, provider: "reviewer" })]);
  });

  it("each call is attributed to who SERVED it, superseded tokens included (Codex 2026-09-17 #1, #2)", async () => {
    const cm = new ConsensusManager(new ConfidenceEstimator());
    const result = await (cm as unknown as { reExecuteStrategy(p: unknown): Promise<{ usages?: unknown[] }> }).reExecuteStrategy({
      originalOutput: { text: "answer A" }, originalProvider: "claude",
      reviewProvider: reviewer([
        { text: "answer B", inputTokens: 100, outputTokens: 40, servedBy: { provider: "claude", model: "claude-sonnet-5" }, auxiliary: 5000 },
        { text: '{"agreed": true, "reasoning": "same"}', inputTokens: 200, outputTokens: 10, servedBy: { provider: "opencode", model: "deepseek-flash" } },
      ]),
      prompt: "p", task,
    });
    expect(result.usages).toEqual([
      expect.objectContaining({ provider: "claude", model: "claude-sonnet-5", inputTokens: 5100, outputTokens: 40 }),
      expect.objectContaining({ provider: "opencode", model: "deepseek-flash", inputTokens: 200, outputTokens: 10 }),
    ]);
  });

  it("a reviewer error that carries usage is spend too (Codex 2026-09-17 round 3)", async () => {
    const cm = new ConsensusManager({ reviewTimeoutMs: 0 } as never);
    vi.spyOn(cm, "shouldConsult").mockReturnValue("review" as never);
    const chat = vi.fn().mockRejectedValueOnce(Object.assign(new Error("All providers failed"), { usage: { inputTokens: 10_000, outputTokens: 0, totalTokens: 10_000 } }));
    const result = await cm.verify({
      originalOutput: { text: "answer A" }, originalProvider: "claude", confidence: 0.1,
      reviewProvider: { name: "reviewer", chat } as never, prompt: "p", task,
    });
    expect(result.agreed).toBe(false);
    expect(result.usages).toEqual([expect.objectContaining({ provider: "reviewer", inputTokens: 10_000 })]);
  });

  it("a failure after the first call still reports what that call spent (Codex 2026-09-17 #3)", async () => {
    const cm = new ConsensusManager(new ConfidenceEstimator(), { reviewTimeoutMs: 0 } as never);
    vi.spyOn(cm, "shouldConsult").mockReturnValue("re-execute" as never);
    const result = await cm.verify({
      originalOutput: { text: "answer A" }, originalProvider: "claude", confidence: 0.1,
      reviewProvider: reviewer([{ text: "answer B", inputTokens: 100, outputTokens: 40 }, { text: "", inputTokens: 0, outputTokens: 0, fail: true }]),
      prompt: "p", task,
    });
    expect(result.agreed).toBe(false);
    expect(result.usages).toEqual([expect.objectContaining({ inputTokens: 100, outputTokens: 40 })]);
  });

  it("the re-execute strategy sums BOTH reviewer calls", async () => {
    const cm = new ConsensusManager(new ConfidenceEstimator());
    const result = await (cm as unknown as { reExecuteStrategy(p: unknown): Promise<{ usages?: Array<{ inputTokens: number }> }> }).reExecuteStrategy({
      originalOutput: { text: "answer A" }, originalProvider: "claude",
      reviewProvider: reviewer([{ text: "answer B", inputTokens: 100, outputTokens: 40 }, { text: '{"agreed": true, "reasoning": "same"}', inputTokens: 200, outputTokens: 10 }]),
      prompt: "p", task,
    });
    const total = (result.usages ?? []).reduce((a, u) => a + u.inputTokens, 0);
    expect(total).toBe(300);
    expect(result.usages).toHaveLength(2);
  });
});
