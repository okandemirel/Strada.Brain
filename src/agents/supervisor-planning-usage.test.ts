/**
 * The supervisor's planning call bills the run that asked for the plan (task #67).
 *
 * A supervisor run decomposes the whole task before any node run is open, so
 * no node's model-turn hook sees that call. Measured before the fix: the REAL
 * GoalDecomposer billed 1,800 in / 600 out for the plan and the task's usage
 * record, the rate limiter and the metrics took 0 of it. Drives the REAL
 * Orchestrator admission → REAL SupervisorBrain → REAL GoalDecomposer; only
 * the provider and the node executor are seams.
 */
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { SupervisorBrain } from "../supervisor/supervisor-brain.js";
import { CapabilityMatcher } from "../supervisor/capability-matcher.js";
import { ProviderAssigner } from "../supervisor/provider-assigner.js";
import { GoalDecomposer } from "../goals/goal-decomposer.js";
import type { SupervisorConfig } from "../supervisor/supervisor-types.js";

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

const CONFIG: SupervisorConfig = {
  enabled: true, complexityThreshold: "complex", maxParallelNodes: 2,
  nodeTimeoutMs: 5000, verificationMode: "disabled", verificationBudgetPct: 15,
  triageProvider: "groq", maxFailureBudget: 3, diversityCap: 0.6,
};

const PLAN = JSON.stringify({
  nodes: [
    { id: "a", task: "Write the parser for the recipe file format", dependsOn: [] },
    { id: "b", task: "Add a test that loads three sample recipe files", dependsOn: ["a"] },
  ],
});

describe("supervisor planning usage", () => {
  it("bills the plan call's tokens once to the task's usage record, the rate limiter and the metrics", async () => {
    const planner = {
      name: "planner",
      capabilities: { maxTokens: 8192, streaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async () => ({
        text: PLAN,
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1800, outputTokens: 600, totalTokens: 2400 },
      })),
    };
    const decomposer = new GoalDecomposer(planner as never, 1, [0]);
    const brain = new SupervisorBrain({
      config: CONFIG,
      decomposer,
      capabilityMatcher: new CapabilityMatcher(),
      providerAssigner: new ProviderAssigner([
        { name: "worker", model: "w", scores: { reasoning: 0.9, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.5, cost: 0.4, quality: 0.9, creative: 0.8 } },
      ]),
    });
    brain.setExecuteNode(vi.fn(async (node: { id: string }) => ({
      nodeId: node.id, status: "ok", output: "done", artifacts: [], toolResults: [],
      provider: "worker", model: "w", cost: 0, duration: 1,
    })) as never);
    const rateLimiter = { recordTokenUsage: vi.fn() };
    const metrics = { recordTokenUsage: vi.fn() };
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
      supervisorBrain: brain,
      goalDecomposer: decomposer,
      supervisorComplexityThreshold: "complex",
      rateLimiter: rateLimiter as never,
      metrics: metrics as never,
    });
    (orchestrator as unknown as { taskClassifier: unknown }).taskClassifier = {
      classify: () => ({ type: "analysis", complexity: "complex", criticality: "high" }),
    };
    const onUsage = vi.fn();

    const decision = await orchestrator.evaluateSupervisorAdmission({
      prompt: "Import recipes from three file formats, validate them, and show the import report",
      chatId: "chat-1",
      channelType: "cli",
      onUsage,
    } as never);

    expect(decision.path).toBe("supervisor");
    expect(planner.chat).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls).toEqual([
      [expect.objectContaining({ provider: "planner", inputTokens: 1800, outputTokens: 600 })],
    ]);
    expect(rateLimiter.recordTokenUsage.mock.calls).toEqual([[1800, 600, "planner", undefined, {}]]);
    expect(metrics.recordTokenUsage.mock.calls).toEqual([[1800, 600, "planner"]]);
  });
});
