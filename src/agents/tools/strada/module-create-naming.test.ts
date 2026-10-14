/**
 * "OrreryModule" is what the module is called, and the tool has to accept it.
 *
 * The generator composed every name off the raw input: `${name}ModuleConfig`
 * for the config class and its asset menu, `${name}Module` for the default
 * folder. That reads correctly only if the caller strips the word "Module"
 * first, which the schema never said and no caller thought to do.
 *
 * Measured on a from-scratch run: the agent called strada_create_module with
 * names that already ended in "Module" — the names it had just chosen for
 * those modules — and got <Name>ModuleModuleConfig.cs files, classes named
 * twice over, with asset menus to match. Nothing rejected it and nothing
 * corrected it.
 *
 * Both spellings must land in the same place: the suffix is part of what a
 * module is called, not part of what distinguishes one.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createLogger } from "../../../utils/logger.js";
import { ModuleCreateTool } from "./module-create.js";
import { installCoreDeclaration } from "./core-declaration-fixture.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const create = async (input: Record<string, unknown>) => {
  const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-naming-"));
  installCoreDeclaration(projectPath);
  const result = await new ModuleCreateTool().execute(input, { projectPath } as never);
  expect(result.isError, `refused: ${result.content}`).toBeFalsy();
  return projectPath;
};

describe("a module named with the Module suffix", () => {
  it("does not double the suffix in the config class", async () => {
    const projectPath = await create({ name: "OrreryModule" });
    const config = join(projectPath, "Assets/Modules/OrreryModule/Scripts/OrreryModuleConfig.cs");

    expect(existsSync(config), "config file is not where the framework expects it").toBe(true);
    const code = readFileSync(config, "utf-8");
    expect(code).toContain("class OrreryModuleConfig : ModuleConfig");
    expect(code).not.toContain("OrreryModuleModuleConfig");
  });

  it("does not double it in the asset menu either", async () => {
    // The menu path is what a designer reads in Unity.
    const projectPath = await create({ name: "OrreryModule" });
    const code = readFileSync(
      join(projectPath, "Assets/Modules/OrreryModule/Scripts/OrreryModuleConfig.cs"),
      "utf-8",
    );

    expect(code).toContain('menuName = "Strada/Modules/Orrery"');
    expect(code).not.toMatch(/Modules\/OrreryModule"/);
  });

  it("puts the module in one OrreryModule folder, not OrreryModuleModule", async () => {
    const projectPath = await create({ name: "OrreryModule" });

    expect(existsSync(join(projectPath, "Assets/Modules/OrreryModule"))).toBe(true);
    expect(existsSync(join(projectPath, "Assets/Modules/OrreryModuleModule"))).toBe(false);
  });

  it("lands in the same place whether or not the caller wrote the suffix", async () => {
    const withSuffix = await create({ name: "OrreryModule" });
    const without = await create({ name: "Orrery" });

    for (const file of [
      "Assets/Modules/OrreryModule/Orrery.asmdef",
      "Assets/Modules/OrreryModule/Scripts/OrreryModuleConfig.cs",
    ]) {
      expect(existsSync(join(withSuffix, file)), `${file} missing for "OrreryModule"`).toBe(true);
      expect(existsSync(join(without, file)), `${file} missing for "Orrery"`).toBe(true);
    }
  });

  it("leaves a name that merely contains the word alone", async () => {
    // "Modulator" ends in no such suffix; stripping by substring would maul it.
    const projectPath = await create({ name: "Modulator" });
    expect(existsSync(join(projectPath, "Assets/Modules/ModulatorModule"))).toBe(true);
  });
});
