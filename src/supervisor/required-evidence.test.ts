import { describe, expect, it } from "vitest";
import { summarizeToolArgs } from "../agents/orchestrator-tool-execution.js";
import { describeEvidenceShortfall, missingRequiredEvidence, requiredToolsInPrompt, requiredToolArguments } from "./required-evidence.js";

describe("required evidence named by the task", () => {
  it("the trace's argument copy is capped and redacted", () => {
    const summary = summarizeToolArgs({
      sessions: "all",
      apiKey: "sk-should-never-appear",
      prompt: "x".repeat(200),
      nested: { a: 1 },
      nothing: null,
    });
    expect(summary).toContain('"sessions":"all"');
    expect(summary).not.toContain("sk-should-never-appear");
    expect(summary).toContain("<redacted>");
    expect(summary!.length).toBeLessThanOrEqual(400);
    expect(summary).not.toContain("nothing");
    expect(summarizeToolArgs(undefined)).toBeUndefined();
    expect(summarizeToolArgs({})).toBeUndefined();
  });

  it("a tool that ran the WRONG way is not evidence (Codex 2026-09-11, review B #13 residue)", () => {
    const prompt = 'Prove the levels: run unity_playthrough with sessions "all" and report the catalog.';
    expect(requiredToolArguments(prompt)).toEqual([{ tool: "unity_playthrough", key: "sessions", value: "all" }]);
    // Ran, but with one session: the task asked for all of them.
    const narrow = missingRequiredEvidence(prompt, [
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "1" }) },
    ]);
    expect(narrow).toEqual([{ tool: "unity_playthrough", attempts: 1, argument: { key: "sessions", value: "all" } }]);
    expect(describeEvidenceShortfall(narrow)).toContain('with sessions "all"');
    // Ran the way the task named it.
    expect(missingRequiredEvidence(prompt, [
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "all" }) },
    ])).toEqual([]);
    // A trace row that recorded no arguments cannot contradict the task.
    expect(missingRequiredEvidence(prompt, [{ toolName: "unity_playthrough", success: true }])).toEqual([]);
    // An ordinary mention manufactures no requirement.
    expect(requiredToolArguments('unity_playthrough is a tool; the scene is named "Main".')).toEqual([]);
  });

  it("names the tool whatever verb the sentence uses (Codex 2026-09-11 B#13)", () => {
    expect(requiredToolsInPrompt("execute unity_playthrough when the scene loads")).toEqual(["unity_playthrough"]);
    expect(requiredToolsInPrompt("run the full PlayMode suite using unity_test_run")).toEqual(["unity_test_run"]);
    expect(requiredToolsInPrompt("prove it via unity_build_player")).toEqual(["unity_build_player"]);
    expect(requiredToolsInPrompt("call unity_verify_change first")).toEqual(["unity_verify_change"]);
    expect(requiredToolsInPrompt("unity_playthrough is a tool that exists")).toEqual([]);
  });

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
