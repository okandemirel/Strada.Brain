/**
 * audited 2026-09-02: the Provider Health Awareness prompt section must describe a signal the
 * model can actually receive. It used to tell the model to watch for "[Provider Health Report]"
 * messages whose only producer had no callers since the v1 engine was deleted.
 */
import { describe, expect, it } from "vitest";
import { buildProviderHealthAwareness } from "./prepare-iteration.js";

describe("buildProviderHealthAwareness", () => {
  it("is absent while no failure has occurred", () => {
    expect(buildProviderHealthAwareness({ getTotalFailures: () => 0, getFailureRate: () => 0 })).toBeUndefined();
  });

  it("states the live count and rate, names the reflection-prompt signal, and never points at a message nothing injects", () => {
    const section = buildProviderHealthAwareness({ getTotalFailures: () => 2, getFailureRate: () => 0.5 });
    expect(section).toBeDefined();
    expect(section).toContain("## Provider Health Awareness");
    expect(section).toContain("2 failure(s)");
    expect(section).toContain("50%");
    expect(section).toContain("**PROVIDER HEALTH**");
    expect(section).not.toContain("[Provider Health Report]");
    // The adaptation directive is unconditional — not gated behind any conditional phrasing.
    expect(section).toContain("Adapt your approach");
  });
});
