import { describe, expect, it } from "vitest";
import { describeEvidenceShortfall, missingRequiredEvidence, requiredToolsInPrompt } from "./required-evidence.js";

describe("required evidence named by the task", () => {
  const prompt = "Register the driver. Then run unity_verify_change, then run unity_playthrough (no arguments) and report its verdict VERBATIM. Run the unity_build_player afterwards.";

  it("reads the tools the prompt tells the worker to run", () => {
    expect(requiredToolsInPrompt(prompt)).toEqual(["unity_verify_change", "unity_playthrough", "unity_build_player"]);
    expect(requiredToolsInPrompt("Bind sprites with unity_bind_sprite and commit.")).toEqual([]);
  });

  it("a required tool with no successful call is a shortfall — never ran, or ran and failed", () => {
    const trace = [
      { toolName: "file_edit", success: true },
      { toolName: "unity_verify_change", success: true },
      { toolName: "unity_playthrough", success: false },
      { toolName: "unity_playthrough", success: false },
    ];
    expect(missingRequiredEvidence(prompt, trace)).toEqual([
      { tool: "unity_playthrough", attempts: 2 },
      { tool: "unity_build_player", attempts: 0 },
    ]);
    expect(describeEvidenceShortfall(missingRequiredEvidence(prompt, trace))).toBe(
      "REQUIRED EVIDENCE MISSING: the task says run unity_playthrough; 2 run(s), none ok; the task says run unity_build_player; it never ran in this node — the result is not done whatever the report says.",
    );
    expect(missingRequiredEvidence(prompt, [...trace, { toolName: "unity_playthrough", success: true }, { toolName: "unity_build_player", success: true }])).toEqual([]);
  });
});
