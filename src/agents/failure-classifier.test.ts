import { describe, it, expect } from "vitest";
import type { StepResult } from "./agent-state.ts";
import {
  FailureType,
  classifyFailure,
  shouldForceReplan,
} from "./failure-classifier.ts";

function makeStep(summary: string, success = false): StepResult {
  return {
    toolName: "test-tool",
    success,
    summary,
    timestamp: Date.now(),
  };
}

describe("classifyFailure", () => {
  it("should classify CS errors as COMPILATION with error code extracted", () => {
    const step = makeStep("error CS1002: ; expected");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.COMPILATION);
    expect(result.errorCode).toBe("CS1002");
  });

  it("should classify MSB errors as COMPILATION", () => {
    const step = makeStep("MSB4018: The build task failed");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.COMPILATION);
  });

  it("should classify test failures as TEST", () => {
    const step = makeStep("FAIL: SomeTest - Expected 5 but Actual was 3");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.TEST);
  });

  it("should classify Assert failures as TEST", () => {
    const step = makeStep("Assert.AreEqual failed");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.TEST);
  });

  it("should classify ENOENT as ENVIRONMENT", () => {
    const step = makeStep("ENOENT: no such file or directory");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.ENVIRONMENT);
  });

  it("should classify EACCES as ENVIRONMENT", () => {
    const step = makeStep("EACCES: permission denied");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.ENVIRONMENT);
  });

  it("should classify NullReferenceException as RUNTIME", () => {
    const step = makeStep("NullReferenceException: Object reference not set");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.RUNTIME);
  });

  it("should classify StackOverflowException as RUNTIME", () => {
    const step = makeStep("StackOverflow detected in method Foo");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.RUNTIME);
  });

  it("should classify unknown errors as UNKNOWN", () => {
    const step = makeStep("something went wrong somehow");
    const result = classifyFailure(step);
    expect(result.type).toBe(FailureType.UNKNOWN);
    expect(result.errorCode).toBeNull();
  });
});

describe("shouldForceReplan", () => {
  it("should return true after 3 consecutive same-type failures", () => {
    const steps: StepResult[] = [
      makeStep("error CS1002: ; expected"),
      makeStep("error CS0246: type not found"),
      makeStep("error CS0103: name does not exist"),
    ];
    expect(shouldForceReplan(steps)).toBe(true);
  });

  it("should return false for mixed failure types", () => {
    const steps: StepResult[] = [
      makeStep("error CS1002: ; expected"),
      makeStep("ENOENT: no such file"),
      makeStep("error CS0246: type not found"),
    ];
    expect(shouldForceReplan(steps)).toBe(false);
  });

  it("should return false for fewer than 3 failures", () => {
    const steps: StepResult[] = [
      makeStep("error CS1002: ; expected"),
      makeStep("error CS0246: type not found"),
    ];
    expect(shouldForceReplan(steps)).toBe(false);
  });

  it("should only consider the last 3 steps", () => {
    const steps: StepResult[] = [
      makeStep("ENOENT: no such file"),
      makeStep("error CS1002: ; expected"),
      makeStep("error CS0246: type not found"),
      makeStep("error CS0103: name does not exist"),
    ];
    expect(shouldForceReplan(steps)).toBe(true);
  });
});
