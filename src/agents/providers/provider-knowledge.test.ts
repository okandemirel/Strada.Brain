import { describe, it, expect } from "vitest";
import {
  PROVIDER_KNOWLEDGE,
  buildProviderIntelligence,
  getRecommendedMaxMessages,
} from "./provider-knowledge.js";

const ALL_PROVIDERS = [
  "claude",
  "openai",
  "gemini",
  "deepseek",
  "qwen",
  "kimi",
  "minimax",
  "groq",
  "mistral",
  "together",
  "fireworks",
  "ollama",
];

describe("PROVIDER_KNOWLEDGE", () => {
  it("should have knowledge entries for all 12 providers", () => {
    for (const name of ALL_PROVIDERS) {
      expect(PROVIDER_KNOWLEDGE[name]).toBeDefined();
    }
    expect(Object.keys(PROVIDER_KNOWLEDGE)).toHaveLength(12);
  });

  it("should have non-empty strengths array for each provider", () => {
    for (const name of ALL_PROVIDERS) {
      const k = PROVIDER_KNOWLEDGE[name]!;
      expect(k.strengths.length).toBeGreaterThan(0);
    }
  });

  it("should have contextWindow > 0 for each provider", () => {
    for (const name of ALL_PROVIDERS) {
      expect(PROVIDER_KNOWLEDGE[name]!.contextWindow).toBeGreaterThan(0);
    }
  });

  it("should have maxMessages > 0 for each provider", () => {
    for (const name of ALL_PROVIDERS) {
      expect(PROVIDER_KNOWLEDGE[name]!.maxMessages).toBeGreaterThan(0);
    }
  });

  it("should have at least one behavioral hint for each provider", () => {
    for (const name of ALL_PROVIDERS) {
      expect(PROVIDER_KNOWLEDGE[name]!.behavioralHints.length).toBeGreaterThan(0);
    }
  });

  it("should have ollama with the lowest maxMessages (15)", () => {
    const ollama = PROVIDER_KNOWLEDGE["ollama"]!;
    expect(ollama.maxMessages).toBe(15);
    for (const name of ALL_PROVIDERS) {
      if (name === "ollama") continue;
      expect(PROVIDER_KNOWLEDGE[name]!.maxMessages).toBeGreaterThan(ollama.maxMessages);
    }
  });

  it("should have claude and gemini with the highest maxMessages (80)", () => {
    expect(PROVIDER_KNOWLEDGE["claude"]!.maxMessages).toBe(80);
    expect(PROVIDER_KNOWLEDGE["gemini"]!.maxMessages).toBe(80);
    for (const name of ALL_PROVIDERS) {
      expect(PROVIDER_KNOWLEDGE[name]!.maxMessages).toBeLessThanOrEqual(80);
    }
  });

  it("should mention web search in qwen strengths", () => {
    const qwen = PROVIDER_KNOWLEDGE["qwen"]!;
    const hasWebSearch = qwen.strengths.some((s) =>
      s.toLowerCase().includes("web search"),
    );
    expect(hasWebSearch).toBe(true);
  });

  it("should mention fast inference in groq strengths", () => {
    const groq = PROVIDER_KNOWLEDGE["groq"]!;
    const hasFastInference = groq.strengths.some((s) =>
      s.toLowerCase().includes("fast inference"),
    );
    expect(hasFastInference).toBe(true);
  });

  it("should mention privacy in ollama strengths", () => {
    const ollama = PROVIDER_KNOWLEDGE["ollama"]!;
    const hasPrivacy = ollama.strengths.some((s) =>
      s.toLowerCase().includes("privacy"),
    );
    expect(hasPrivacy).toBe(true);
  });
});

describe("buildProviderIntelligence", () => {
  it("should return non-empty string for known providers", () => {
    for (const name of ALL_PROVIDERS) {
      const result = buildProviderIntelligence(name);
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("should return empty string for unknown provider", () => {
    expect(buildProviderIntelligence("nonexistent")).toBe("");
    expect(buildProviderIntelligence("")).toBe("");
    expect(buildProviderIntelligence("foobar_provider")).toBe("");
  });

  it("should include provider display name", () => {
    const result = buildProviderIntelligence("claude");
    expect(result).toContain("Claude (Anthropic)");
  });

  it("should include context window info", () => {
    const result = buildProviderIntelligence("claude");
    expect(result).toContain("1000K tokens");
  });

  it("should include model ID when provided", () => {
    const result = buildProviderIntelligence("openai", "gpt-5.2");
    expect(result).toContain("Model: gpt-5.2");
  });

  it("should show 'default' when model ID is not provided", () => {
    const result = buildProviderIntelligence("openai");
    expect(result).toContain("Model: default");
  });

  it("should include strengths", () => {
    const result = buildProviderIntelligence("groq");
    expect(result).toContain("Extremely fast inference");
  });

  it("should include limitations when present", () => {
    const result = buildProviderIntelligence("deepseek");
    expect(result).toContain("8K max output");
  });

  it("should include behavioral hints", () => {
    const result = buildProviderIntelligence("ollama");
    expect(result).toContain("Keep responses concise");
  });

  it("should contain Current Provider Intelligence header", () => {
    const result = buildProviderIntelligence("claude");
    expect(result).toContain("## Current Provider Intelligence");
  });
});

describe("getRecommendedMaxMessages", () => {
  it("should return correct values for each provider", () => {
    expect(getRecommendedMaxMessages("claude")).toBe(80);
    expect(getRecommendedMaxMessages("openai")).toBe(60);
    expect(getRecommendedMaxMessages("gemini")).toBe(80);
    expect(getRecommendedMaxMessages("deepseek")).toBe(40);
    expect(getRecommendedMaxMessages("qwen")).toBe(60);
    expect(getRecommendedMaxMessages("kimi")).toBe(50);
    expect(getRecommendedMaxMessages("minimax")).toBe(60);
    expect(getRecommendedMaxMessages("groq")).toBe(40);
    expect(getRecommendedMaxMessages("mistral")).toBe(50);
    expect(getRecommendedMaxMessages("together")).toBe(60);
    expect(getRecommendedMaxMessages("fireworks")).toBe(60);
    expect(getRecommendedMaxMessages("ollama")).toBe(15);
  });

  it("should return 40 for unknown provider", () => {
    expect(getRecommendedMaxMessages("nonexistent")).toBe(40);
    expect(getRecommendedMaxMessages("")).toBe(40);
    expect(getRecommendedMaxMessages("unknown_provider")).toBe(40);
  });
});
