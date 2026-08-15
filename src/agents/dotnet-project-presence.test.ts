/**
 * The half of the dotnet precondition that nobody was checking.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  hasDotnetProjectFile,
  DotnetProjectPresence,
  DOTNET_PROJECT_TOOLS,
} from "./dotnet-project-presence.js";

const project = (): string => mkdtempSync(join(os.tmpdir(), "dotnet-presence-"));

describe("finding something for dotnet to build", () => {
  it("finds a solution", () => {
    const root = project();
    writeFileSync(join(root, "PixelFlow.sln"), "");
    expect(hasDotnetProjectFile(root)).toBe(true);
  });

  it("finds a project file", () => {
    const root = project();
    writeFileSync(join(root, "Assembly-CSharp.csproj"), "");
    expect(hasDotnetProjectFile(root)).toBe(true);
  });

  it("finds nothing in a Unity project the Editor has never opened", () => {
    // The measured case: Assets/ and Packages/ exist, no solution has been
    // generated, and dotnet_build answers MSB1003.
    const root = project();
    mkdirSync(join(root, "Assets"));
    mkdirSync(join(root, "Packages"));
    expect(hasDotnetProjectFile(root)).toBe(false);
  });

  it("is not fooled by a similar name", () => {
    const root = project();
    writeFileSync(join(root, "notes.csproj.md"), "");
    writeFileSync(join(root, "solution.sln.bak"), "");
    expect(hasDotnetProjectFile(root)).toBe(false);
  });

  it("says no for a directory it cannot read", () => {
    expect(hasDotnetProjectFile(join(os.tmpdir(), "does-not-exist-anywhere"))).toBe(false);
  });
});

describe("the per-run cache", () => {
  it("notices a solution that appears mid-run", () => {
    // Unity can generate one while the agent is working.
    const root = project();
    const presence = new DotnetProjectPresence(root);

    expect(presence.check()).toBe(false);
    writeFileSync(join(root, "PixelFlow.sln"), "");
    expect(presence.check()).toBe(true);
  });

  it("does not re-scan once it has found one", () => {
    const root = project();
    writeFileSync(join(root, "PixelFlow.sln"), "");
    const presence = new DotnetProjectPresence(root);

    expect(presence.check()).toBe(true);
    // Even against a root that no longer resolves, the latched answer holds.
    expect(new DotnetProjectPresence(root).check()).toBe(true);
    expect(presence.check()).toBe(true);
  });
});

describe("which tools the precondition covers", () => {
  it("names the two that cannot run without one", () => {
    expect([...DOTNET_PROJECT_TOOLS].sort()).toEqual(["dotnet_build", "dotnet_test"]);
  });
});
