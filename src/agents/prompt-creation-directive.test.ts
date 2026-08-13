/**
 * The greenfield execution directive.
 *
 * buildExplicitTargetExecutionDirective tells the agent to act on named files
 * "before any broader repository audit or exploratory inspection" — but it only
 * fires when the prompt contains a path. So the request with the most room to
 * wander, "build me a game" with no file named, was the single case that got no
 * instruction to act at all, sitting inside a planning prompt otherwise
 * dominated by verification protocol.
 *
 * Measured on a greenfield task in a correctly configured project: 24
 * file_read, 18 list_directory, 15 glob_search, and 6 strada_validate_architecture
 * calls — architecture validation run six times against a project that had no
 * architecture yet — with zero files written in fourteen minutes.
 */

import { describe, it, expect } from "vitest";
import {
  buildCreationExecutionDirective,
  buildExplicitTargetExecutionDirective,
} from "./prompt-targets.js";
import { buildPlanningPrompt } from "./paor-prompts.js";

const GREENFIELD =
  "Pixel Flow adinda 2D bir Unity oyunu gelistir. Izgara yonetimi, akis mantigi, eslestirme ve puanlama kur.";
const WITH_TARGET =
  "Assets/Scripts altina PixelFlow namespace'inde Board.cs adli tek bir C# dosyasi yaz.";

describe("buildCreationExecutionDirective", () => {
  it("fires for a creation request that names no files", () => {
    const directive = buildCreationExecutionDirective(GREENFIELD);
    expect(directive).toContain("Execution Priority");
    expect(directive).toMatch(/deliverable is new source files/i);
  });

  it("tells the agent not to validate architecture that does not exist yet", () => {
    // The specific observed behaviour: strada_validate_architecture six times
    // on an empty project.
    expect(buildCreationExecutionDirective(GREENFIELD)).toMatch(
      /not.*(analysis|architecture validation).*not written yet|nothing there to validate/i,
    );
  });

  it("defers to the explicit-target directive when the user named a path", () => {
    // Exactly one of the two should ever apply; the named-target instruction is
    // the stronger one.
    expect(buildCreationExecutionDirective(WITH_TARGET)).toBe("");
    expect(buildExplicitTargetExecutionDirective(WITH_TARGET)).not.toBe("");
  });

  it("stays silent when nothing is being created", () => {
    expect(buildCreationExecutionDirective("Bu projede kac tane script var?")).toBe("");
    expect(buildCreationExecutionDirective("Explain how the board scoring works")).toBe("");
  });

  it("recognises creation verbs in both languages the assistant is driven in", () => {
    for (const prompt of [
      "Build a matching system for the grid",
      "Bir eslestirme sistemi olustur",
      "Implement scoring rules",
      "Puanlama kurallarini yaz",
    ]) {
      expect(buildCreationExecutionDirective(prompt), prompt).not.toBe("");
    }
  });
});

describe("planning prompt", () => {
  it("carries the creation directive for a greenfield task", () => {
    const prompt = buildPlanningPrompt(GREENFIELD);
    expect(prompt).toMatch(/deliverable is new source files/i);
  });

  it("carries the target directive, and only that one, when a path is named", () => {
    const prompt = buildPlanningPrompt(WITH_TARGET);
    expect(prompt).toContain("The user named explicit targets");
    expect(prompt).not.toMatch(/deliverable is new source files/i);
  });
});
