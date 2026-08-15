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

beforeAll(() => {
  createLogger("error", "test.log");
});

const create = async (input: Record<string, unknown> = {}) => {
  const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-structure-"));
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

  it("can create Commands under Scripts and Editor at the root", async () => {
    // Editor/ is not code-under-Scripts: it compiles into its own edit-mode
    // assembly, which is why the framework declares it beside Scripts/.
    const { base } = await create({ include_commands: true, include_editor: true });
    expect(existsSync(join(base, "Scripts", "Commands"))).toBe(true);
    expect(existsSync(join(base, "Editor"))).toBe(true);
    expect(existsSync(join(base, "Scripts", "Editor"))).toBe(false);
  });

  it("describes the layout it actually created", async () => {
    // The summary is what the agent reads back; a tree that disagrees with the
    // disk teaches it to file the next file in the wrong place.
    const { result } = await create();
    expect(result.content).toMatch(/Scripts\//);
    expect(result.content).not.toMatch(/Mediators/);
  });
});
