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

/**
 * OUTPUT A COMPILER REGENERATES IS NOT WORK THAT WAS LOST.
 *
 * Measured in a live campaign: goals that had done real work were failed
 * because a NuGet restore graph under a build project's obj/ folder, which the
 * project regenerates on its own, conflicted with the lease's copy.
 */
describe("a conflict on generated output", () => {
  it("is disclosed, and the publication stands", () => {
    const verdict = judgePublication({
      written: Array.from({ length: 12 }, (_unused, i) => `Assets/Scripts/File${i}.cs`),
      conflicts: ["Build/LedgerHost/obj/Ledger.Host.csproj.nuget.dgspec.json"],
      quarantined: 1,
    });
    expect(verdict.loss).toBeUndefined();
    expect(verdict.note).toContain("the project writes these for itself");
    expect(verdict.note).toContain("Ledger.Host.csproj.nuget.dgspec.json");
  });

  it("…while a conflict on anything the run AUTHORED is still a loss", () => {
    const mixed = judgePublication({
      written: ["Assets/Scripts/Other.cs"],
      conflicts: ["Build/X/obj/Host.csproj.nuget.dgspec.json", "Assets/Scripts/Rules.cs"],
      quarantined: 2,
    });
    expect(mixed.loss).toContain("1 file(s) the run changed did not reach the project");
    expect(mixed.loss).toContain("Assets/Scripts/Rules.cs");
    // The generated file is not counted among the losses.
    expect(mixed.loss).not.toContain("dgspec");
  });

  // A-missed#4 (2026-09-17): the severity of a conflict is decided by
  // isDerivedBuildOutput, so an authored file the rule misreads as generated is
  // reported as "nothing the run authored was lost" — and stays in quarantine.
  // MSBuild writes <Assembly>.AssemblyInfo.cs under obj/<Config>/<Tfm>/, so the
  // name in a game's OWN obj/ folder does not make the file generated.
  it("an authored AssemblyInfo.cs in the game's own obj/ folder is a LOSS, not a note", () => {
    const verdict = judgePublication({
      written: ["Assets/Scripts/Other.cs"],
      conflicts: ["Assets/obj/Ledger.Runtime.AssemblyInfo.cs"],
      quarantined: 1,
    });
    expect(verdict.note).toBeUndefined();
    expect(verdict.loss).toContain("Assets/obj/Ledger.Runtime.AssemblyInfo.cs");
    expect(verdict.loss).toContain("did not reach the project");
  });

  it("…and the same file where the compiler really writes it is disclosed, not lost", () => {
    const verdict = judgePublication({
      conflicts: ["Build/X/obj/Debug/net8.0/Ledger.Runtime.AssemblyInfo.cs"],
      quarantined: 1,
    });
    expect(verdict.loss).toBeUndefined();
    expect(verdict.note).toContain("the project writes these for itself");
  });

  it("and a generated file that could not even be preserved is still a loss", () => {
    const gone = judgePublication({
      conflicts: ["Build/X/obj/Host.csproj.nuget.dgspec.json"],
      quarantined: 0,
    });
    expect(gone.loss).toContain("exist ONLY in the workspace");
  });
});

/**
 * Measured live 2026-10-14 23:17 on the proof run: the play-mode result the
 * run itself writes conflicted with the project's own copy, the publication
 * called it work that did not reach the project, and the goal that had
 * written 22 other files FAILED — taking three dependent goals with it. The
 * same thing happened twice on the same file.
 */
describe("a conflict on the run's own recording", () => {
  it("is disclosed, not counted as work that was lost", () => {
    const verdict = judgePublication({
      written: Array.from({ length: 22 }, (_, i) => `Assets/Scripts/File${i}.cs`),
      conflicts: ["Recordings/tests/playmode-last.json"],
      quarantined: 1,
    });

    expect(verdict.loss).toBeUndefined();
    expect(verdict.note).toContain("this run's own recordings");
    expect(verdict.note).toContain("Recordings/tests/playmode-last.json");
  });

  it("still fails on authored work that conflicted beside it", () => {
    const verdict = judgePublication({
      written: ["Assets/Scripts/Other.cs"],
      conflicts: ["Recordings/tests/playmode-last.json", "Assets/Scripts/Rules.cs"],
      quarantined: 2,
    });

    expect(verdict.loss).toContain("Assets/Scripts/Rules.cs");
    expect(verdict.loss).toContain("1 file(s)");
  });

  it("keeps a hand-written file under Recordings as authored work", () => {
    const verdict = judgePublication({
      conflicts: ["Recordings/reference/art-direction.png"],
      quarantined: 1,
    });

    expect(verdict.loss).toContain("art-direction.png");
  });
});
