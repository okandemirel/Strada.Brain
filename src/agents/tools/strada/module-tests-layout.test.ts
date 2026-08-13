/**
 * A module's tests belong to the module.
 *
 * The framework declares the shape itself, in
 * Strada.Core/Editor/ModuleGenerator/Config/DirectoryStructureConfig.cs:
 *
 *   Tests/Runtime  → RuntimeTests
 *   Tests/Editor   → EditorTests
 *
 * and Strada.Core follows its own rule — Tests/Runtime/Strada.Core.Tests.asmdef
 * and Tests/Editor/Strada.Core.Editor.Tests.asmdef, one assembly per mode.
 *
 * The generator created a single flat `Tests/` folder with no assembly in it.
 * A test folder with no .asmdef compiles into the default assembly, which
 * cannot see the module's own assembly, so tests written there cannot reference
 * the code they are testing. Measured on a live run: the agent gave up on the
 * module entirely and built a separate Assets/Tests/PixelFlow tree with an
 * invented asmdef — tests that live outside the architecture they belong to.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { ModuleCreateTool } from "./module-create.js";
import type { ToolContext } from "../tool-core.interface.js";

let projectPath: string;

beforeEach(() => {
  projectPath = mkdtempSync(join(os.tmpdir(), "module-tests-"));
  mkdirSync(join(projectPath, "Assets", "Modules"), { recursive: true });
});

function context(): ToolContext {
  return {
    projectPath,
    workingDirectory: projectPath,
    readOnly: false,
  } as ToolContext;
}

async function createModule(includeTests: boolean): Promise<string> {
  const tool = new ModuleCreateTool();
  const result = await (
    tool as unknown as {
      execute(input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError?: boolean }>;
    }
  ).execute({ name: "Game", include_tests: includeTests }, context());
  expect(result.isError, String(result.content)).toBeFalsy();
  return join(projectPath, "Assets", "Modules", "GameModule");
}

describe("generated module test layout", () => {
  it("splits tests by mode, inside the module", async () => {
    const base = await createModule(true);

    expect(existsSync(join(base, "Tests", "Runtime"))).toBe(true);
    expect(existsSync(join(base, "Tests", "Editor"))).toBe(true);
    // The flat folder the framework does not declare.
    expect(existsSync(join(base, "Tests", "Game.Modules.Game.Tests.asmdef"))).toBe(false);
  });

  it("gives each test mode an assembly that can see the module", async () => {
    // Without this the tests compile into the default assembly and cannot
    // reference the code under test — the folder exists and is useless.
    const base = await createModule(true);

    const runtime = JSON.parse(
      readFileSync(join(base, "Tests", "Runtime", "Game.Modules.Game.Tests.asmdef"), "utf8"),
    );
    expect(runtime.references).toContain("Game.Modules.Game");
    expect(runtime.references).toContain("UnityEngine.TestRunner");
    expect(runtime.precompiledReferences).toContain("nunit.framework.dll");
    expect(runtime.defineConstraints).toContain("UNITY_INCLUDE_TESTS");
  });

  it("constrains the editor test assembly to the editor", async () => {
    // An edit-mode assembly that ships in a player build breaks the build.
    const base = await createModule(true);

    const editor = JSON.parse(
      readFileSync(join(base, "Tests", "Editor", "Game.Modules.Game.Editor.Tests.asmdef"), "utf8"),
    );
    expect(editor.includePlatforms).toEqual(["Editor"]);
    expect(editor.references).toContain("Game.Modules.Game");
  });

  it("creates no test folders when tests were not asked for", async () => {
    const base = await createModule(false);
    expect(existsSync(join(base, "Tests"))).toBe(false);
  });
});
