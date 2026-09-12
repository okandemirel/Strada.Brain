/**
 * Codex round AE#4, reproduced: a completed worker's commit returned
 * `written: ["Assets/Other.cs"], conflicts: ["Assets/Rules.cs"], failed: []`
 * and both publication paths kept the task completed — the change the task
 * was about never reached the project.
 */
import { describe, expect, it } from "vitest";
import { judgePublication } from "./publication.js";

describe("what a lease commit delivered (Codex 2026-09-12 AE#4)", () => {
  it("calls a PARTIAL publication a loss, and names what did not land", () => {
    const verdict = judgePublication({ written: ["Assets/Other.cs"], conflicts: ["Assets/Rules.cs"], quarantined: 1 });
    expect(verdict.loss).toContain("Assets/Rules.cs");
    expect(verdict.loss).toContain("did not reach the project");
    expect(verdict.loss).toContain("1 other file(s) did publish");
    expect(verdict.note).toBeUndefined();
  });

  it("still calls a total conflict, an unpreserved one and a failed write losses", () => {
    expect(judgePublication({ written: [], conflicts: ["A.cs"], quarantined: 1 }).loss).toContain("A.cs");
    expect(judgePublication({ written: ["B.cs"], conflicts: ["A.cs"], quarantined: 0 }).loss).toContain("ONLY in the workspace");
    expect(judgePublication({ written: ["B.cs"], failed: ["A.cs"] }).loss).toContain("could not be written");
    // The strongest cause is the one reported.
    expect(judgePublication({ conflicts: ["A.cs"], quarantined: 0, failed: ["C.cs"] }).loss).toContain("could not be written");
  });

  it("is silent about a clean publication and only NOTES a declined deletion", () => {
    expect(judgePublication({ written: ["A.cs"], conflicts: [], removed: [], failed: [] })).toEqual({});
    const declined = judgePublication({ written: ["A.cs"], removed: ["Old.cs"] });
    expect(declined.loss).toBeUndefined();
    expect(declined.note).toContain("Old.cs");
    // A commit shape missing every array is not a failure either.
    expect(judgePublication({})).toEqual({});
  });
});
