/**
 * The derived-output contract, tested in one place.
 *
 * This predicate decides two different things, which is why it lives on its own
 * now: whether a file travels back from a lease at all (`shouldCommitEntry`),
 * and HOW SERIOUS a publication conflict is (`judgePublication` — a conflict on
 * derived output is disclosed as a note, a conflict on authored work is a loss
 * that fails the task). A wrong answer is therefore either a lost file or a
 * failed goal, and until 2026-09-17 the rule was a regex buried in a
 * 2,700-line lease manager with its cases spread across an fs-heavy suite.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { isDerivedBuildOutput } from "./derived-build-output.js";

describe("isDerivedBuildOutput: what a build directory looks like, and what merely shares its name", () => {
  it("counts what a compiler puts in bin/ and obj/", () => {
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Debug", "a.dll"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "net8.0", "a.dll"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "netstandard2.1", "Core.AssemblyInfo.cs"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "project.assets.json"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Core.csproj.nuget.g.props"))).toBe(true);
    // NuGet's restore graph: it was NOT in this list, so it travelled with
    // every lease, the project restored its own copy, and the conflict failed
    // the goal that had done the work (measured live 2026-09-16 19:03).
    expect(isDerivedBuildOutput(join("Tools", "PixelFlowCoreBuild", "obj", "PixelFlow.Core.csproj.nuget.dgspec.json"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "bin", "Release", "a.dll"))).toBe(true);
    // …while the names .NET actually writes there still count, whatever the extension.
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Core.assets.cache"))).toBe(true);
    expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Core.csproj.FileListAbsolute.txt"))).toBe(true);
  });

  it("does not count a directory that merely shares the name", () => {
    expect(isDerivedBuildOutput(join("bin", "tools.sh"))).toBe(false);
    expect(isDerivedBuildOutput(join("Assets", "Scripts", "Object.cs"))).toBe(false);
    // A GAME'S OWN ASSETS in a folder called obj: a Wavefront model under
    // Assets/Models/obj was classified derived and dropped from publication,
    // which loses authored work (Codex 2026-09-12 S#8).
    expect(isDerivedBuildOutput(join("Assets", "Models", "obj", "Hero.obj"))).toBe(false);
    // A GAME'S OWN baked data in a folder called obj is not compiler output
    // either, whatever its extension (Codex 2026-09-12 T#10).
    expect(isDerivedBuildOutput(join("Assets", "obj", "terrain.cache"))).toBe(false);
    expect(isDerivedBuildOutput(join("Assets", "Models", "obj", "Hero.cache"))).toBe(false);
    expect(isDerivedBuildOutput(join("Assets", "obj", "Pig", "body.fbx"))).toBe(false);
    // …and a game's own file that merely ends in dgspec.json is not NuGet's.
    expect(isDerivedBuildOutput(join("Assets", "Data", "obj", "levels.dgspec.json"))).toBe(false);
    // `bin/` is derived only when it holds a build configuration.
    expect(isDerivedBuildOutput(join("Tools", "X", "bin", "Custom", "a.dll"))).toBe(false);
  });

  describe("an AUTHORED source file is never derived on the strength of a folder name", () => {
    // The worst direction of this predicate to get wrong. A false "derived"
    // makes judgePublication call a conflict on the file "nothing the run
    // authored was lost", so the change stays in .strada/lease-conflicts and
    // the task settles green — hand-written code, silently dropped.
    //
    // MSBuild writes `<Assembly>.AssemblyInfo.cs` into obj/<Config>/<Tfm>/, so
    // the name alone (directly under an obj/ the game owns) proves nothing.
    it("a deliberately authored AssemblyInfo.cs in the game's own obj/ folder is authored", () => {
      expect(isDerivedBuildOutput(join("Assets", "obj", "PixelFlow.Runtime.AssemblyInfo.cs"))).toBe(false);
      expect(isDerivedBuildOutput(join("Assets", "Modules", "CoreModule", "obj", "Core.AssemblyInfo.cs"))).toBe(false);
      // The same file where the compiler really writes it: still derived.
      expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Debug", "net8.0", "Core.AssemblyInfo.cs"))).toBe(true);
      expect(isDerivedBuildOutput(join("Tools", "X", "obj", "Debug", "Core.AssemblyInfo.cs"))).toBe(true);
    });

    it("and no C#/VB/F# source directly under obj/ is claimed by the intermediate-name list", () => {
      expect(isDerivedBuildOutput(join("Assets", "obj", "Level.cs"))).toBe(false);
      expect(isDerivedBuildOutput(join("Assets", "obj", "Level.vb"))).toBe(false);
      expect(isDerivedBuildOutput(join("Assets", "obj", "Level.fs"))).toBe(false);
      expect(isDerivedBuildOutput(join("Assets", "obj", "project.assets.cs"))).toBe(false);
    });

    it("an AssemblyInfo.cs outside any obj/ is authored wherever it lives", () => {
      expect(isDerivedBuildOutput(join("Properties", "AssemblyInfo.cs"))).toBe(false);
      expect(isDerivedBuildOutput(join("Assets", "Scripts", "PixelFlow.Runtime.AssemblyInfo.cs"))).toBe(false);
    });
  });

  it("reads both path separators, so a Windows lease is judged the same way", () => {
    expect(isDerivedBuildOutput("Tools\\X\\obj\\Debug\\a.dll")).toBe(true);
    expect(isDerivedBuildOutput("Tools/X/obj/Debug/a.dll")).toBe(true);
    expect(isDerivedBuildOutput("Assets\\obj\\Core.AssemblyInfo.cs")).toBe(false);
  });
});
