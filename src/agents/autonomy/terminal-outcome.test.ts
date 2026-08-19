/**
 * A run that told the user it could not finish must not be recorded as a success.
 *
 * Measured on two from-scratch runs: each surfaced "Unable to complete this task
 * — the AI provider is not responding" twice, and each closed its episode with
 * failed:false. The settlement call passed no outcome at all, so it took the
 * default, and nothing carried the terminal reason out to it.
 */

import { describe, it, expect } from "vitest";
import { isFailedTerminalKey, FAILED_TERMINAL_KEYS } from "./terminal-outcome.js";

describe("which terminals are failures", () => {
  it("counts a provider outage as one", () => {
    expect(isFailedTerminalKey("provider_abort")).toBe(true);
  });

  it("counts a stuck run and an exhausted budget as failures", () => {
    expect(isFailedTerminalKey("task_stuck")).toBe(true);
    expect(isFailedTerminalKey("token_budget_exceeded")).toBe(true);
  });

  it("leaves a clean terminal alone", () => {
    // A clean finish maps to no key at all; that must stay a success.
    expect(isFailedTerminalKey(undefined)).toBe(false);
  });

  it("does not treat a question to the user as a failure", () => {
    // Asking the user something is a legitimate way for a run to end.
    expect(isFailedTerminalKey("provider_ask_user")).toBe(false);
    expect(FAILED_TERMINAL_KEYS.has("provider_ask_user")).toBe(false);
  });
});
