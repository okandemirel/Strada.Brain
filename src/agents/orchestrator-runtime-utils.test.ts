import { describe, expect, it } from "vitest";
import {
  mergeLearnedInsights,
  normalizeFailureFingerprint,
  parseReflectionDecision,
  replaceSection,
  sanitizeEventInput,
  sanitizeToolResult,
  validateReflectionDecision,
} from "./orchestrator-runtime-utils.js";
import { AgentPhase, type AgentState } from "./agent-state.js";

function createState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    phase: AgentPhase.REFLECTING,
    taskDescription: "test task",
    iteration: 1,
    plan: "do the work",
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    ...overrides,
  };
}

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

  it("ignores incidental inspection failures when reflection declares DONE", () => {
    const result = validateReflectionDecision("DONE", createState({
      stepResults: [
        { toolName: "list_directory", success: false, summary: "Temp directory missing", timestamp: 1 },
        { toolName: "file_read", success: true, summary: "Read fallback path", timestamp: 2 },
      ],
    }));

    expect(result.decision).toBe("DONE");
  });

  it("keeps the loop open for blocking mutation or verification failures", () => {
    const mutationFailure = validateReflectionDecision("DONE", createState({
      stepResults: [
        { toolName: "file_write", success: false, summary: "permission denied", timestamp: 1 },
      ],
    }));
    expect(mutationFailure.decision).toBe("CONTINUE");

    const verificationFailure = validateReflectionDecision("DONE", createState({
      stepResults: [
        { toolName: "shell_test", success: false, summary: "build failed", timestamp: 2 },
      ],
    }));
    expect(verificationFailure.decision).toBe("CONTINUE");
  });
});
