/**
 * A module's folders name its concerns, not "is this code".
 *
 * The generator wrapped every code folder in `Scripts/` — Scripts/Services,
 * Scripts/Systems, Scripts/Components — while Editor/, Tests/ and Resources/
 * already sat at the module root. So the tree was split by whether something was
 * code rather than by what it did, and reading a module meant opening Scripts/
 * before seeing anything about the module.
 *
 * It also generated `Scripts/Mediators`, a folder the framework never declared,
 * and generated neither `Interfaces/` nor `Editor/`, which it did.
 *
 * The declared shape now lives in one place: Strada.Core's
 * DirectoryStructureConfig and this generator agree, so a module made by the
 * Unity generator and one made by the agent are the same module.
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
  const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-flat-"));
  const result = await new ModuleCreateTool().execute(
    { name: "Board", ...input },
    { projectPath } as never,
  );
  expect(result.isError, `refused: ${result.content}`).toBeFalsy();
  return { base: join(projectPath, "Assets", "Modules", "BoardModule"), result };
};

describe("a generated module's folder layout", () => {
  it("has no Scripts folder at all", async () => {
    const { base } = await create();
    expect(existsSync(join(base, "Scripts"))).toBe(false);
  });

  it("puts component folders directly under the module root", async () => {
    const { base } = await create();
    for (const folder of ["Interfaces", "Services", "Systems", "Components"]) {
      expect(existsSync(join(base, folder)), `${folder} not at module root`).toBe(true);
    }
  });

  it("puts the module config and asmdef at the root beside them", async () => {
    const { base } = await create();
    const entries = readdirSync(base);
    expect(entries).toContain("Board.asmdef");
    expect(entries).toContain("BoardModuleConfig.cs");
  });

  it("does not invent a Mediators folder the framework never declared", async () => {
    const { base } = await create();
    expect(existsSync(join(base, "Mediators"))).toBe(false);
  });

  it("splits Data the way the framework declares it", async () => {
    // ConfigData and ValueObject are two component types, so they are two
    // folders — collapsing them loses the distinction the framework makes.
    const { base } = await create({ include_data: true });
    expect(existsSync(join(base, "Data", "UnityObjects"))).toBe(true);
    expect(existsSync(join(base, "Data", "ValueObjects"))).toBe(true);
  });

  it("can create Commands and Editor folders", async () => {
    const { base } = await create({ include_commands: true, include_editor: true });
    expect(existsSync(join(base, "Commands"))).toBe(true);
    expect(existsSync(join(base, "Editor"))).toBe(true);
  });

  it("describes the layout it actually created", async () => {
    // The summary is what the agent reads back; if it still draws Scripts/, the
    // agent will file its next file there by hand.
    const { result } = await create();
    expect(result.content).not.toMatch(/Scripts\//);
  });
});
