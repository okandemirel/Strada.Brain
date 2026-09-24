/**
 * AUT-8 (audited 2026-09-24): the unity-console gate ignored the attempt cap
 * SelfVerification applies, and it and the same-error gate both ran before
 * the honest-failure branch — so a run reporting errors it could not fix was
 * sent back until loop recovery blocked it.
 */
import { describe, expect, it } from "vitest";
import { AgentPhase, type AgentState } from "../agent-state.js";
import { planVerifierPipeline } from "./verifier-pipeline.js";
import { SelfVerification } from "./self-verification.js";

const HONEST =
  "I could not fix it: the remaining errors are in the vendor plugin under Assets/Plugins, which I must not edit. Blocked.";

function state(steps: ReadonlyArray<{ toolName: string; success: boolean; summary: string }>): AgentState {
  const now = Date.now();
  return {
    phase: AgentPhase.EXECUTING,
    taskDescription: "Fix the compile errors",
    iteration: 12,
    plan: null,
    stepResults: steps.map((s, i) => ({ ...s, timestamp: now - 1000 + i })),
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
  };
}

const plan = (draft: string, verifier: SelfVerification, steps: Parameters<typeof state>[0]) =>
  planVerifierPipeline({
    prompt: "Fix the compile errors",
    draft,
    state: state(steps),
    task: { type: "debugging", complexity: "moderate", criticality: "medium" },
    verificationState: verifier.getState(),
    buildVerificationGate: verifier.needsVerification() ? verifier.getPrompt() : null,
    conformanceGate: null,
    logEntries: [],
    chatId: "chat-honest",
    taskStartedAtMs: Date.now() - 60_000,
  });

/** A verifier that has seen `rounds` different sets of console errors. */
function consoleRounds(rounds: number): SelfVerification {
  const verifier = new SelfVerification();
  for (let i = 0; i < rounds; i++) {
    verifier.track("unity_console_read", {}, {
      toolCallId: `c${i}`,
      content: `Assets/Plugins/Vendor/Net.cs(${i + 1},5): error CS0246: type not found`,
      isError: false,
    });
  }
  return verifier;
}

const EDITED = [{ toolName: "file_edit", success: true, summary: "Edited Player.cs" }];

describe("the unity-console gate can give up (AUT-8)", () => {
  it("past the attempt cap, an honest failure report ends the run", () => {
    const verifier = consoleRounds(11);
    expect(verifier.hasUnresolvedUnityErrors()).toBe(false);
    const result = plan(HONEST, verifier, EDITED);
    expect(result.initialDecision).toBe("approve");
    expect(result.checks.find((c) => c.name === "unity-console")?.gate).toBeUndefined();
  });

  it("past the attempt cap, a success claim is no longer held by this gate", () => {
    const result = plan("Fixed the errors.\nDONE", consoleRounds(11), EDITED);
    expect(result.checks.find((c) => c.name === "unity-console")?.gate).toBeUndefined();
  });

  it("before the cap, this gate does not hold an honest failure report either", () => {
    // (The build gate still carries the open errors under the cap; this
    // check no longer adds a second, uncapped hold.)
    const result = plan(HONEST, consoleRounds(2), EDITED);
    expect(result.checks.find((c) => c.name === "unity-console")?.gate).toBeUndefined();
  });

  it("guard: under the cap, a success claim over console errors is still sent back", () => {
    const result = plan("Fixed the errors.\nDONE", consoleRounds(2), EDITED);
    expect(result.initialDecision).toBe("continue");
    expect(result.checks.find((c) => c.name === "unity-console")?.gate).toContain("UNITY CONSOLE ERROR LOOP");
  });
});

describe("the same-error gate does not argue with an honest failure report (AUT-8)", () => {
  const sameFailure = { toolName: "unity_verify_change", success: false, summary: "error CS0246: Vendor type not found" };

  it("three identical failures and a failure report: approved", () => {
    const result = plan(HONEST, new SelfVerification(), [sameFailure, sameFailure, sameFailure]);
    expect(result.initialDecision).toBe("approve");
  });

  it("guard: three identical failures and a success claim: replanned", () => {
    const result = plan("Fixed.\nDONE", new SelfVerification(), [sameFailure, sameFailure, sameFailure]);
    expect(result.initialDecision).toBe("replan");
  });
});
