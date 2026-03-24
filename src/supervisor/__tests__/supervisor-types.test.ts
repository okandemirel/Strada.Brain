import { describe, it, expect } from "vitest";
import type {
  CapabilityTag,
  CapabilityProfile,
  TaggedGoalNode,
  NodeResult,
  SupervisorResult,
  VerificationConfig,
  SupervisorConfig,
} from "../supervisor-types.js";

describe("supervisor-types", () => {
  it("CapabilityProfile has required fields", () => {
    const profile: CapabilityProfile = {
      primary: ["reasoning", "code-gen"],
      preference: "quality",
      confidence: 0.9,
      source: "heuristic",
    };
    expect(profile.primary).toContain("reasoning");
    expect(profile.confidence).toBeGreaterThanOrEqual(0);
    expect(profile.confidence).toBeLessThanOrEqual(1);
  });

  it("NodeResult captures execution outcome", () => {
    const result: NodeResult = {
      nodeId: "goal_1" as any,
      status: "ok",
      output: "DB schema created",
      artifacts: [],
      toolResults: [],
      provider: "claude",
      model: "claude-sonnet-4-6-20250514",
      cost: 0.003,
      duration: 12000,
    };
    expect(result.status).toBe("ok");
  });

  it("SupervisorConfig has defaults", () => {
    const config: SupervisorConfig = {
      enabled: true,
      complexityThreshold: "complex",
      maxParallelNodes: 4,
      nodeTimeoutMs: 120000,
      verificationMode: "critical-only",
      verificationBudgetPct: 15,
      triageProvider: "groq",
      maxFailureBudget: 3,
      diversityCap: 0.6,
    };
    expect(config.maxParallelNodes).toBe(4);
  });

  it("CapabilityTag union covers all values", () => {
    const tags: CapabilityTag[] = [
      "reasoning", "vision", "code-gen", "tool-use", "long-context",
      "speed", "cost", "quality", "creative",
    ];
    expect(tags).toHaveLength(9);
  });
});
