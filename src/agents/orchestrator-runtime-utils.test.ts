import { describe, expect, it } from "vitest";
import {
  mergeLearnedInsights,
  normalizeFailureFingerprint,
  parseReflectionDecision,
  replaceSection,
  sanitizeEventInput,
  sanitizeToolResult,
} from "./orchestrator-runtime-utils.js";

describe("orchestrator-runtime-utils", () => {
  it("replaces prompt sections and strips injected markers", () => {
    const prompt = [
      "before",
      "<!-- re-retrieval:memory:start -->",
      "old",
      "<!-- re-retrieval:memory:end -->",
      "after",
    ].join("\n");

    const updated = replaceSection(
      prompt,
      "re-retrieval:memory",
      "fresh\n<!-- fake:start -->\nsecret\n<!-- fake:end -->",
    );

    expect(updated).toContain("fresh");
    expect(updated).not.toContain("fake:start");
    expect(updated).not.toContain("fake:end");
  });

  it("parses reflection decisions and normalizes failure fingerprints", () => {
    expect(parseReflectionDecision("analysis\nDONE")).toBe("DONE");
    expect(parseReflectionDecision("**REPLAN**\nmore text")).toBe("REPLAN");
    expect(normalizeFailureFingerprint("Build Failed: Missing-Type!")).toBe("build failed missing type");
  });

  it("deduplicates insights and sanitizes tool payloads", () => {
    expect(mergeLearnedInsights(["keep", "repeat"], ["repeat", "new"])).toEqual(["keep", "repeat", "new"]);

    expect(
      sanitizeEventInput({
        apiKey: "sk-secret-secret-secret",
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
    });

    expect(
      sanitizeToolResult("token sk-secret-secret-secret value", 18),
    ).toContain("[REDACTED]");
  });
});
