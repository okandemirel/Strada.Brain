/**
 * A failing tool has to leave a trace.
 *
 * Measured: a run called unity_scene_build twice and produced no scene, and
 * there was no way to learn why — tool results go into the model's context and
 * nowhere else, not the log and not the task store. The same blindness had
 * already cost a full investigation into whether conformance gates were firing.
 */

import { describe, it, expect } from "vitest";
import { firstMeaningfulLine } from "./orchestrator-tool-execution.js";

describe("what gets kept from a failure", () => {
  it("keeps the cause, not just the generic headline", () => {
    // Measured: this exact failure logged as "Scene NOT assembled." and nothing
    // else, which records that something broke and not what — the whole reason
    // for logging it.
    const content =
      "Scene NOT assembled.\n" +
      "Created 3 artifact(s), assigned 0 field(s).\n" +
      "Problems:\n  boot.GameBootstrapper._gameConfig: unresolved reference 'cfg'";

    expect(firstMeaningfulLine(content)).toBe(
      "Scene NOT assembled. boot.GameBootstrapper._gameConfig: unresolved reference 'cfg'",
    );
  });

  it("keeps just the headline when there is no detail section", () => {
    expect(firstMeaningfulLine("Error: no Unity editor found for this project.")).toBe(
      "Error: no Unity editor found for this project.",
    );
  });

  it("skips leading blank lines rather than reporting nothing", () => {
    expect(firstMeaningfulLine("\n\n   \nError: no Unity editor found")).toBe(
      "Error: no Unity editor found",
    );
  });

  it("truncates a wall of compiler output", () => {
    const long = "error CS0103: " + "x".repeat(2000);

    expect(firstMeaningfulLine(long).length).toBe(300);
  });

  it("is empty for an empty result rather than throwing", () => {
    expect(firstMeaningfulLine("")).toBe("");
    expect(firstMeaningfulLine("\n \n")).toBe("");
  });
});

describe("a result that is a document, not a sentence", () => {
  it("reads the reason out of JSON instead of logging a brace", () => {
    // Measured on batch_execute: the log said detail:"{" — the first line of a
    // JSON document is a brace, and a log of that answers nothing.
    const content = JSON.stringify({
      ok: false,
      results: [{ tool: "shell_exec", error: "shell command looks destructive" }],
    });

    expect(firstMeaningfulLine(content)).toBe("error: shell command looks destructive");
  });

  it("prefers the most direct field when several could serve", () => {
    const content = JSON.stringify({ summary: "batch finished", error: "write refused" });

    expect(firstMeaningfulLine(content)).toBe("error: write refused");
  });

  it("falls back to the text reading when the JSON says nothing useful", () => {
    expect(firstMeaningfulLine('{"count": 3}')).toBe('{"count": 3}');
  });

  it("is not confused by text that merely starts with a brace", () => {
    expect(firstMeaningfulLine("{not json at all\nsecond line")).toBe("{not json at all");
  });
});

describe("a verdict buried under its own evidence", () => {
  // Measured on unity_verify_change at 23:52: the run's compile check failed and
  // the log said detail:"message: Mono: successfully reloaded assembly". The
  // verdict sits at the root; the console entries it attaches as evidence each
  // carry a message, and a depth-first reader reaches those first.
  const verifyResult = JSON.stringify({
    status: "failed",
    summary: { compileIssues: 27, testFailures: 0, buildSuccess: null },
    evidence: {
      console: {
        entries: [
          { message: "Mono: successfully reloaded assembly", type: "Log" },
          { message: "Assets/Modules/Conveyor.cs(14,9): error CS0246", type: "Error" },
        ],
      },
    },
  });

  it("reports the verdict, not the first line of the log it attached", () => {
    expect(firstMeaningfulLine(verifyResult)).toBe("status: failed (compileIssues=27)");
  });

  it("keeps a stated reason ahead of the verdict when the tool gives one", () => {
    const content = JSON.stringify({
      status: "failed",
      error: "no Unity editor found for this project",
      summary: { compileIssues: 3 },
    });

    expect(firstMeaningfulLine(content)).toBe("error: no Unity editor found for this project");
  });

  it("names the status alone when nothing was counted", () => {
    expect(firstMeaningfulLine(JSON.stringify({ status: "timeout", summary: {} }))).toBe(
      "status: timeout",
    );
  });

  it("prefers a shallow reason over one nested in attached evidence", () => {
    const content = JSON.stringify({
      evidence: { console: { entries: [{ message: "reloaded assembly" }] } },
      failure: { reason: "compile never finished" },
    });

    expect(firstMeaningfulLine(content)).toBe("reason: compile never finished");
  });
});
