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
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createLogger } from "../../../utils/logger.js";
import { ModuleCreateTool } from "./module-create.js";
import { installCoreDeclaration } from "./core-declaration-fixture.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const create = async (input: Record<string, unknown> = {}) => {
  const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-structure-"));
  installCoreDeclaration(projectPath);
  const result = await new ModuleCreateTool().execute(
    { name: "Board", ...input },
    { projectPath } as never,
  );
  expect(result.isError, `refused: ${result.content}`).toBeFalsy();
  return { base: join(projectPath, "Assets", "Modules", "BoardModule"), result };
};

describe("a generated module's folder layout", () => {
  it("keeps code under Scripts/", async () => {
    const { base } = await create();
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
    expect(readdirSync(base)).toContain("Board.asmdef");
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

  it("creates no asset folders unless they were asked for", async () => {
    const { base } = await create();
    expect(existsSync(join(base, "Prefabs"))).toBe(false);
    expect(existsSync(join(base, "Resources"))).toBe(false);
  });

  it("refuses an asset folder the framework never declared", async () => {
    const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-structure-"));
    installCoreDeclaration(projectPath);
    const result = await new ModuleCreateTool().execute(
      { name: "Board", asset_folders: ["Sounds"] },
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
      { name: "Board" },
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
