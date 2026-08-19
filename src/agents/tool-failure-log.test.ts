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
