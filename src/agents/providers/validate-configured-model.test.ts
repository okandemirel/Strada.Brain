import { describe, it, expect } from "vitest";
import { validateConfiguredModel } from "./validate-configured-model.js";

describe("validateConfiguredModel", () => {
  it("returns ok:true with no correction when the configured model is in the live list", () => {
    const result = validateConfiguredModel("opencode", "opencode/grok-code", [
      "opencode/grok-code",
      "opencode/glm-5",
    ]);
    expect(result.ok).toBe(true);
    expect(result.corrected).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it("returns ok:false with a live corrected model and a reason naming provider + stale id when stale", () => {
    const live = ["opencode/grok-code", "opencode/glm-5"];
    const result = validateConfiguredModel("opencode", "opencode/stale-model-retired", live);
    expect(result.ok).toBe(false);
    expect(result.corrected).toBeDefined();
    expect(live).toContain(result.corrected!);
    expect(result.reason).toContain("opencode/stale-model-retired");
    expect(result.reason).toContain("opencode");
  });

  it("returns ok:true when the live list is empty (discovery unavailable — cannot validate)", () => {
    const result = validateConfiguredModel("opencode", "opencode/stale-model-retired", []);
    expect(result.ok).toBe(true);
    expect(result.corrected).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it("prefers a same-family live model as the correction over unrelated ids", () => {
    const result = validateConfiguredModel("openai", "gpt-5.4", [
      "gpt-4.1-mini",
      "gpt-5.2",
      "claude-x",
    ]);
    expect(result.ok).toBe(false);
    // gpt-5.4 shares the "gpt-5" family with gpt-5.2; that must win over
    // the unrelated gpt-4.1-mini / claude-x.
    expect(result.corrected).toBe("gpt-5.2");
  });

  it("prefers a same provider/-prefix live model when no closer family match exists", () => {
    const result = validateConfiguredModel("opencode", "opencode/stale-model-retired", [
      "anthropic/claude-x",
      "opencode/glm-5",
      "openai/gpt-5",
    ]);
    expect(result.ok).toBe(false);
    expect(result.corrected).toBe("opencode/glm-5");
  });

  it("falls back to the first live id when nothing shares a prefix/family", () => {
    const result = validateConfiguredModel("acme", "totally-different", [
      "alpha-1",
      "beta-2",
    ]);
    expect(result.ok).toBe(false);
    expect(result.corrected).toBe("alpha-1");
  });
});
