/**
 * The two generators have to produce the same module.
 *
 * Strada.Core's DirectoryStructureConfig is the declaration of what a module
 * looks like: Scripts/ holds the code folders, while Editor/, Tests/ and
 * Resources/ sit at the module root beside it. strada_create_module writes the
 * same tree, so a module made in Unity and one made by the agent are
 * interchangeable.
 *
 * Where they had drifted, measured against the declaration:
 *   - the generator created Scripts/Mediators, which the framework never
 *     declares, so every module carried a folder nothing knows about;
 *   - it created neither Scripts/Interfaces nor Editor/, both of which the
 *     framework does declare — leaving the agent to invent a home for service
 *     interfaces and no home at all for edit-mode code;
 *   - it created a flat Scripts/Data, collapsing ConfigData and ValueObject,
 *     which are two component types with two folders.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createLogger } from "../../../utils/logger.js";
import { ModuleCreateTool } from "./module-create.js";
import { installCoreDeclaration, installCoreLayout } from "./core-declaration-fixture.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const create = async (input: Record<string, unknown> = {}) => {
  const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-structure-"));
  installCoreDeclaration(projectPath);
  const result = await new ModuleCreateTool().execute(
    { name: "Pantry", ...input },
    { projectPath } as never,
  );
  expect(result.isError, `refused: ${result.content}`).toBeFalsy();
  return { base: join(projectPath, "Assets", "Modules", "PantryModule"), result };
};

describe("a generated module's folder layout", () => {
  it("keeps code under Scripts/", async () => {
    // A system is opt-in (an empty one is ticked every frame for nothing).
    const { base } = await create({ include_system: true });
    for (const folder of ["Interfaces", "Services", "Systems", "Components"]) {
      expect(existsSync(join(base, "Scripts", folder)), `Scripts/${folder} missing`).toBe(true);
    }
  });

  it("keeps Tests beside Scripts, not inside it", async () => {
    // Tests/Runtime and Tests/Editor are declared at the module root.
    const { base } = await create();
    expect(existsSync(join(base, "Tests", "Runtime"))).toBe(true);
    expect(existsSync(join(base, "Tests", "Editor"))).toBe(true);
    expect(existsSync(join(base, "Scripts", "Tests"))).toBe(false);
  });

  it("puts the asmdef at the module root", async () => {
    const { base } = await create();
    expect(readdirSync(base)).toContain("Pantry.asmdef");
  });

  it("does not invent a Mediators folder the framework never declared", async () => {
    const { base } = await create();
    expect(existsSync(join(base, "Scripts", "Mediators"))).toBe(false);
  });

  it("splits Data the way the framework declares it", async () => {
    const { base } = await create({ include_data: true });
    expect(existsSync(join(base, "Scripts", "Data", "UnityObjects"))).toBe(true);
    expect(existsSync(join(base, "Scripts", "Data", "ValueObjects"))).toBe(true);
  });

  it("puts Commands and edit-mode code where the framework declares them", async () => {
    // Both are code, so both are under Scripts/ — the declaration decides, and
    // this test reads it rather than restating a guess.
    const { base } = await create({ include_commands: true, include_editor: true });
    expect(existsSync(join(base, "Scripts", "Commands"))).toBe(true);
    expect(existsSync(join(base, "Scripts", "Editor"))).toBe(true);
  });

  it("creates an authored-asset folder at the module root when asked", async () => {
    // Assets are not code: they sit beside Scripts/, and only when requested.
    const { base } = await create({ asset_folders: ["Art", "Prefabs"] });
    expect(existsSync(join(base, "Art", "Models"))).toBe(true);
    expect(existsSync(join(base, "Art", "Textures"))).toBe(true);
    expect(existsSync(join(base, "Prefabs"))).toBe(true);
    expect(existsSync(join(base, "Scripts", "Art"))).toBe(false);
  });

  it("creates the declared asset folders without being asked", async () => {
    // The agent should not have to know these exist. Measured: while they had
    // to be named, no generated module ever got one.
    const { base } = await create();
    for (const folder of ["Prefabs", "Resources", "Settings", "Scriptables"]) {
      expect(existsSync(join(base, folder)), `${folder} missing`).toBe(true);
    }
    expect(existsSync(join(base, "Art", "Textures"))).toBe(true);
  });

  it("creates none of them when explicitly given an empty list", async () => {
    const { base } = await create({ asset_folders: [] });
    expect(existsSync(join(base, "Prefabs"))).toBe(false);
    expect(existsSync(join(base, "Resources"))).toBe(false);
    // The code half of the module is unaffected.
    expect(existsSync(join(base, "Scripts", "Services"))).toBe(true);
  });

  it("creates only what was named when a list is given", async () => {
    const { base } = await create({ asset_folders: ["Prefabs"] });
    expect(existsSync(join(base, "Prefabs"))).toBe(true);
    expect(existsSync(join(base, "Resources"))).toBe(false);
  });

  it("refuses an asset folder the framework never declared", async () => {
    const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-structure-"));
    installCoreDeclaration(projectPath);
    const result = await new ModuleCreateTool().execute(
      { name: "Pantry", asset_folders: ["Sounds"] },
      { projectPath } as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Sounds/);
  });

  it("refuses to guess when the framework is not installed", async () => {
    // A module whose shape the framework never agreed to is the failure this
    // whole path exists to prevent, so there is no fallback structure.
    const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-nocore-"));
    const result = await new ModuleCreateTool().execute(
      { name: "Pantry" },
      { projectPath } as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Strada\.Core is not installed/);
  });

  it("describes the layout it actually created", async () => {
    // The summary is what the agent reads back; a tree that disagrees with the
    // disk teaches it to file the next file in the wrong place.
    const { result } = await create();
    expect(result.content).toMatch(/Scripts\//);
    expect(result.content).not.toMatch(/Mediators/);
  });
});

describe("a framework whose layout lives in ModuleLayout.cs", () => {
  // Strada.Core moved the folder list out of DirectoryStructureConfig.cs into
  // ModuleLayout.DefaultEntries(), dropped Commands, and filed Signals with
  // Events. Read only from the old file, every module was refused as "Strada.Core
  // is not installed" while startup announced the framework as detected.
  const createIn = async (input: Record<string, unknown> = {}, withLayout = true) => {
    const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-layout-"));
    installCoreLayout(projectPath, { withLayout });
    const result = await new ModuleCreateTool().execute(
      { name: "Pantry", ...input },
      { projectPath } as never,
    );
    return { base: join(projectPath, "Assets", "Modules", "PantryModule"), result };
  };

  it("creates the module", async () => {
    const { base, result } = await createIn({ include_system: true });
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    for (const folder of ["Interfaces", "Services", "Systems", "Components"]) {
      expect(existsSync(join(base, "Scripts", folder)), `Scripts/${folder} missing`).toBe(true);
    }
    expect(existsSync(join(base, "Tests", "Runtime"))).toBe(true);
  });

  it("puts signals in the folder the framework files them in", async () => {
    // FolderOwner(Signals) is Events: asking for signals must give that folder,
    // not a Scripts/Signals the framework no longer declares, and not nothing.
    const { base, result } = await createIn({ include_signals: true });
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(existsSync(join(base, "Scripts", "Events"))).toBe(true);
    expect(existsSync(join(base, "Scripts", "Signals"))).toBe(false);
    expect(result.content).toMatch(/Signals.*Scripts\/Events/);
  });

  it("says so when a requested component has no folder in the layout", async () => {
    const { base, result } = await createIn({ include_commands: true });
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(existsSync(join(base, "Scripts", "Commands"))).toBe(false);
    expect(result.content).toMatch(/Commands/);
    expect(result.content).toMatch(/declares no folder/);
  });

  it("tells an unreadable layout apart from a missing framework", async () => {
    // The framework directory is there; only its layout cannot be read. "Not
    // installed" sends the agent to install what is already installed.
    const { result } = await createIn({}, false);
    expect(result.isError).toBe(true);
    expect(result.content).not.toMatch(/not installed/);
    expect(result.content).toMatch(/module layout could not be read/);
    expect(result.content).toMatch(/ModuleLayout\.cs/);
  });

  it("calls an empty framework directory an incomplete checkout", async () => {
    // An uninitialised submodule: the directory is there, nothing in it is.
    const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-empty-core-"));
    mkdirSync(join(projectPath, "Packages", "Submodules", "Strada.Core"), { recursive: true });
    const result = await new ModuleCreateTool().execute({ name: "Pantry" }, { projectPath } as never);
    expect(result.isError).toBe(true);
    expect(result.content).not.toMatch(/is installed/);
    expect(result.content).toMatch(/checkout is incomplete/);
    expect(existsSync(join(projectPath, "Assets"))).toBe(false);
  });

  it("describes both layouts without calling either one current", () => {
    // The schema is static text the model reads whichever Strada.Core a
    // project pins, and the older layout is the one a fresh clone still gets.
    const props = new ModuleCreateTool().inputSchema.properties as Record<string, { description: string }>;
    for (const key of ["include_signals", "include_commands"]) {
      expect(props[key]!.description).not.toMatch(/current Strada\.Core/i);
    }
    expect(props["include_signals"]!.description).toMatch(/Scripts\/Signals/);
    expect(props["include_signals"]!.description).toMatch(/Scripts\/Events/);
    expect(props["include_commands"]!.description).toMatch(/Scripts\/Commands/);
  });
});
