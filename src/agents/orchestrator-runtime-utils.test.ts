import { describe, expect, it } from "vitest";
import {
  classifyStepErrorCategory,
  mergeLearnedInsights,
  normalizeFailureFingerprint,
  parseReflectionDecision,
  recordProviderHealthFailure,
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

  it("does not block DONE for unavailable tool or generic execution failures", () => {
    const unavailable = validateReflectionDecision("DONE", createState({
      stepResults: [
        { toolName: "csharp_symbol_search", success: false, summary: "Tool 'csharp_symbol_search' is currently unavailable.", timestamp: 1 },
      ],
    }));
    expect(unavailable.decision).toBe("DONE");

    const execFailed = validateReflectionDecision("DONE", createState({
      stepResults: [
        { toolName: "some_tool", success: false, summary: "Tool execution failed: Invalid argument", timestamp: 2 },
      ],
    }));
    expect(execFailed.decision).toBe("DONE");

    const bridgeDown = validateReflectionDecision("DONE", createState({
      stepResults: [
        { toolName: "unity_build", success: false, summary: "bridge disconnected: ECONNREFUSED 127.0.0.1:7691", timestamp: 3 },
      ],
    }));
    expect(bridgeDown.decision).toBe("DONE");
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

describe("classifyStepErrorCategory", () => {
  it("classifies timeout errors", () => {
    expect(classifyStepErrorCategory("Streaming stalled after 300000ms without progress")).toBe("provider_timeout");
    expect(classifyStepErrorCategory("Request timed out")).toBe("provider_timeout");
    expect(classifyStepErrorCategory("DeadlineExceeded: upstream timeout")).toBe("provider_timeout");
    expect(classifyStepErrorCategory("This operation was aborted")).toBe("provider_timeout");
    expect(classifyStepErrorCategory("Timeout waiting for response")).toBe("provider_timeout");
  });

  it("classifies abort as timeout when it contains timeout signals", () => {
    // "operation was aborted" from stall timeouts should be timeout, not abort
    expect(classifyStepErrorCategory("The operation was aborted due to timeout")).toBe("provider_timeout");
  });

  it("classifies pure task abort (no timeout signal)", () => {
    expect(classifyStepErrorCategory("Task cancelled by user")).toBe("abort");
    expect(classifyStepErrorCategory("Aborted: task interrupted")).toBe("abort");
  });

  it("classifies network errors", () => {
    expect(classifyStepErrorCategory("connect ECONNREFUSED 127.0.0.1:443")).toBe("network");
    expect(classifyStepErrorCategory("getaddrinfo ENOTFOUND api.example.com")).toBe("network");
    expect(classifyStepErrorCategory("fetch failed: socket hang up")).toBe("network");
    expect(classifyStepErrorCategory("ECONNRESET: connection was reset")).toBe("network");
  });

  it("classifies tool unavailability", () => {
    expect(classifyStepErrorCategory("Tool is unavailable")).toBe("tool_unavailable");
    expect(classifyStepErrorCategory("bridge disconnected")).toBe("tool_unavailable");
    expect(classifyStepErrorCategory("Tool execution failed")).toBe("tool_unavailable");
  });

  it("classifies build failures", () => {
    expect(classifyStepErrorCategory("Build failed with 3 errors")).toBe("build_failure");
    expect(classifyStepErrorCategory("error CS1002: ; expected")).toBe("build_failure");
    expect(classifyStepErrorCategory("error MSB4018: The task failed")).toBe("build_failure");
    expect(classifyStepErrorCategory("typecheck failed on 2 files")).toBe("build_failure");
  });

  it("classifies test failures", () => {
    expect(classifyStepErrorCategory("3 tests failed")).toBe("test_failure");
    expect(classifyStepErrorCategory("AssertionError: assert failed")).toBe("test_failure");
    expect(classifyStepErrorCategory("expect(received).toBe(expected)")).toBe("test_failure");
  });

  it("classifies validation errors", () => {
    expect(classifyStepErrorCategory("Schema validation error")).toBe("validation");
    expect(classifyStepErrorCategory("Invalid argument: expected number")).toBe("validation");
  });

  it("classifies auth errors", () => {
    expect(classifyStepErrorCategory("HTTP 401 Unauthorized")).toBe("auth");
    expect(classifyStepErrorCategory("Error 403: Forbidden")).toBe("auth");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyStepErrorCategory("Something went wrong")).toBe("unknown");
    expect(classifyStepErrorCategory("")).toBe("unknown");
  });

  it("handles empty/falsy input", () => {
    expect(classifyStepErrorCategory("")).toBe("unknown");
  });
});

describe("recordProviderHealthFailure", () => {
  function createMockRegistry() {
    return {
      recordFailure: (_name: string, _error: string) => {},
      recordQuotaExhausted: (_name: string, _error: string) => {},
      recordOverloaded: (_name: string, _error: string) => {},
    };
  }

  it("routes 403 quota errors to recordQuotaExhausted", () => {
    const reg = createMockRegistry();
    const spy = { called: "" };
    reg.recordQuotaExhausted = (name: string) => { spy.called = name; };
    recordProviderHealthFailure(reg, "openai", "403 quota exceeded");
    expect(spy.called).toBe("openai");
  });

  it("routes HTTP 529 errors to recordOverloaded", () => {
    const reg = createMockRegistry();
    const spy = { called: "" };
    reg.recordOverloaded = (name: string) => { spy.called = name; };
    recordProviderHealthFailure(reg, "minimax", "Request failed with status 529");
    expect(spy.called).toBe("minimax");
  });

  it("routes HTTP 503 errors to recordOverloaded", () => {
    const reg = createMockRegistry();
    const spy = { called: "" };
    reg.recordOverloaded = (name: string) => { spy.called = name; };
    recordProviderHealthFailure(reg, "anthropic", "Service Unavailable 503");
    expect(spy.called).toBe("anthropic");
  });

  it("routes generic errors to recordFailure", () => {
    const reg = createMockRegistry();
    const spy = { called: "" };
    reg.recordFailure = (name: string) => { spy.called = name; };
    recordProviderHealthFailure(reg, "openai", "Connection timeout");
    expect(spy.called).toBe("openai");
  });

  it("does not treat 403 without quota keywords as quota exhaustion", () => {
    const reg = createMockRegistry();
    const spy = { failure: false, quota: false };
    reg.recordFailure = () => { spy.failure = true; };
    reg.recordQuotaExhausted = () => { spy.quota = true; };
    recordProviderHealthFailure(reg, "openai", "403 Forbidden");
    expect(spy.failure).toBe(true);
    expect(spy.quota).toBe(false);
  });
});
