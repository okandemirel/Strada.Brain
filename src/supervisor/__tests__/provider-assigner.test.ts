import { describe, it, expect } from "vitest";
import { ProviderAssigner } from "../provider-assigner.js";
import type { TaggedGoalNode, CapabilityProfile } from "../supervisor-types.js";

function makeTaggedNode(id: string, task: string, profile: CapabilityProfile, deps: string[] = []): TaggedGoalNode {
  return {
    id: id as any, parentId: null, task, dependsOn: deps as any[],
    depth: 0, status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
    capabilityProfile: profile,
  };
}

const PROVIDERS = [
  { name: "claude", model: "claude-sonnet-4-6-20250514",
    scores: { reasoning: 0.85, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.55, cost: 0.4, quality: 0.9, creative: 0.8 } },
  { name: "deepseek", model: "deepseek-chat",
    scores: { reasoning: 0.9, vision: 0, "code-gen": 0.85, "tool-use": 0.75, "long-context": 0.5, speed: 0.5, cost: 0.9, quality: 0.8, creative: 0.6 } },
  { name: "groq", model: "openai/gpt-oss-120b",
    scores: { reasoning: 0.3, vision: 0, "code-gen": 0.6, "tool-use": 0.7, "long-context": 0.5, speed: 0.98, cost: 0.85, quality: 0.55, creative: 0.4 } },
];

describe("ProviderAssigner", () => {
  const assigner = new ProviderAssigner(PROVIDERS);

  it("assigns best provider for reasoning+code-gen task", () => {
    const node = makeTaggedNode("g1", "Analyze auth flow", {
      primary: ["reasoning", "code-gen"], preference: "quality", confidence: 0.9, source: "heuristic" });
    const result = assigner.assignNode(node);
    expect(result.assignedProvider).toBeDefined();
    expect(["claude", "deepseek"]).toContain(result.assignedProvider);
  });

  it("eliminates providers missing vision", () => {
    const node = makeTaggedNode("g2", "Process image", {
      primary: ["vision", "code-gen"], preference: "quality", confidence: 0.9, source: "heuristic" });
    const result = assigner.assignNode(node);
    expect(result.assignedProvider).toBe("claude"); // only one with vision
  });

  it("prefers speed provider for speed preference", () => {
    const node = makeTaggedNode("g3", "Quick lint", {
      primary: ["code-gen"], preference: "speed", confidence: 0.9, source: "heuristic" });
    const result = assigner.assignNode(node);
    expect(result.assignedProvider).toBe("groq"); // highest speed score
  });

  it("applies diversity cap", () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeTaggedNode(`g${i}`, `Task ${i}`, {
        primary: ["code-gen"], preference: "quality", confidence: 0.9, source: "heuristic" }));
    const results = assigner.assignNodes(nodes, 0.6);
    const claudeCount = results.filter(r => r.assignedProvider === "claude").length;
    expect(claudeCount).toBeLessThanOrEqual(3); // 60% of 5
  });

  it("handles single-provider gracefully", () => {
    const singleAssigner = new ProviderAssigner([PROVIDERS[0]]);
    const node = makeTaggedNode("g1", "Anything", {
      primary: ["reasoning"], preference: "cost", confidence: 0.9, source: "heuristic" });
    const result = singleAssigner.assignNode(node);
    expect(result.assignedProvider).toBe("claude");
  });

  it("returns ranked alternatives for escalation", () => {
    const node = makeTaggedNode("g1", "Analyze code", {
      primary: ["reasoning", "code-gen"], preference: "quality", confidence: 0.9, source: "heuristic" });
    const ranked = assigner.getRankedProviders(node);
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0].score).toBeGreaterThan(0);
    // Sorted descending
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it("excludes unhealthy providers", () => {
    const withUnhealthy = [
      { ...PROVIDERS[0], healthy: false },
      PROVIDERS[1],
      PROVIDERS[2],
    ];
    const a = new ProviderAssigner(withUnhealthy);
    const node = makeTaggedNode("g1", "Analyze code", {
      primary: ["reasoning"], preference: "quality", confidence: 0.9, source: "heuristic" });
    const result = a.assignNode(node);
    expect(result.assignedProvider).not.toBe("claude");
  });

  it("deprioritizes rate-limited providers", () => {
    const withRateLimit = [
      { ...PROVIDERS[0], nearRateLimit: true },
      PROVIDERS[1],
    ];
    const a = new ProviderAssigner(withRateLimit);
    const node = makeTaggedNode("g1", "Analyze code", {
      primary: ["reasoning", "code-gen"], preference: "quality", confidence: 0.9, source: "heuristic" });
    const result = a.assignNode(node);
    // deepseek should win because claude is rate-limited (score * 0.5)
    expect(result.assignedProvider).toBe("deepseek");
  });

  it("canonicalizes labeled provider descriptors and outcome history", () => {
    const labeled = new ProviderAssigner([
      {
        name: "Kimi (Moonshot)",
        model: "kimi-for-coding",
        scores: { reasoning: 0.8, vision: 0, "code-gen": 0.85, "tool-use": 0.8, "long-context": 0.9, speed: 0.6, cost: 0.7, quality: 0.8, creative: 0.7 },
      },
      {
        name: "deepseek",
        model: "deepseek-chat",
        scores: { reasoning: 0.8, vision: 0, "code-gen": 0.84, "tool-use": 0.75, "long-context": 0.5, speed: 0.5, cost: 0.9, quality: 0.78, creative: 0.6 },
      },
    ]);
    const node = makeTaggedNode("g-history", "Implement code path", {
      primary: ["code-gen"], preference: "quality", confidence: 0.9, source: "heuristic" });

    labeled.recordOutcome("kimi", ["code-gen"], true);
    labeled.recordOutcome("Kimi (Moonshot)", ["code-gen"], true);

    const ranked = labeled.getRankedProviders(node);
    expect(ranked[0]?.providerName).toBe("kimi");
    expect(ranked.some((entry) => entry.providerName === "Kimi (Moonshot)")).toBe(false);
  });
});
