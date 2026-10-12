/**
 * A module strada_create_module makes is the module Strada.Core's own generator
 * would make.
 *
 * Measured: Brain's hand-kept templates gave every module a ModuleConfig whose
 * Initialize was empty — a registered service was never handed to the
 * PatternManager, so it was never initialized or ticked — a service interface
 * that did not extend IService, and, by default, a starter system whose OnUpdate
 * held only a TODO and a commented-out ForEach. A game built that way carried
 * eleven systems with nothing in OnUpdate, each ticked every frame.
 *
 * Core declares what a module's files contain in ModuleSourceTemplates.cs. These
 * tests install the real file (a copy, kept honest by module-templates.test.ts)
 * and hold the tool to it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import os from "node:os";
import { createLogger } from "../../../utils/logger.js";
import { ModuleCreateTool } from "./module-create.js";
import { installCoreLayout, installCoreTemplates } from "./core-declaration-fixture.js";
import { CORE_TEMPLATES_SOURCE } from "./core-templates-fixture.js";
import { parseModuleSourceTemplates } from "./module-templates.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const MODULE = "Assets/Modules/HarborModule";

function project(withTemplates = true): string {
  const root = mkdtempSync(join(os.tmpdir(), "module-core-templates-"));
  installCoreLayout(root, { withTemplates });
  return root;
}

const run = (root: string, input: Record<string, unknown> = {}) =>
  new ModuleCreateTool().execute({ name: "Harbor", ...input }, { projectPath: root } as never);

const read = (root: string, rel: string) => readFileSync(join(root, MODULE, ...rel.split("/")), "utf-8");

const csFiles = (root: string) =>
  readdirSync(join(root, MODULE), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".cs"))
    .map((e) => join(e.parentPath, e.name).slice(join(root, MODULE).length + 1).split(sep).join("/"))
    .sort();

function put(root: string, rel: string, content: string): void {
  const target = join(root, MODULE, ...rel.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** What Core's Files() renders for this selection, by file name. */
function core(selection: Record<string, boolean>): Map<string, string> {
  const templates = parseModuleSourceTemplates(CORE_TEMPLATES_SOURCE, "fixture");
  return new Map(templates.render("Harbor", "Game.Modules.Harbor", selection).map((f) => [f.fileName, f.source]));
}

describe("strada_create_module writes Core's templates", () => {
  it("a default module: config wired to the PatternManager, an IService interface, and no empty system", async () => {
    const root = project();
    const result = await run(root);
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();

    expect(csFiles(root)).toEqual([
      "Scripts/HarborModuleConfig.cs",
      "Scripts/Interfaces/IHarborService.cs",
      "Scripts/Services/HarborService.cs",
    ]);

    const config = read(root, "Scripts/HarborModuleConfig.cs");
    expect(config).toContain("builder.RegisterService<IHarborService, HarborService>();");
    expect(config).toContain("var patterns = services.Get<PatternManager>();");
    expect(config).toContain("patterns.RegisterService(services.Get<IHarborService>());");
    expect(read(root, "Scripts/Interfaces/IHarborService.cs")).toContain("public interface IHarborService : IService");

    // Byte for byte what Core's generator writes for the same selection.
    const expected = core({ ModuleConfig: true, ServiceInterface: true, Service: true });
    for (const file of csFiles(root)) {
      expect(read(root, file), file).toBe(expected.get(file.split("/").pop()!));
    }
    expect(result.content).toContain("ModuleSourceTemplates.cs");
  });

  it("a controller and config data come from Core's templates too", async () => {
    const root = project();
    const result = await run(root, { include_controller: true, include_data: true });
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();

    expect(csFiles(root)).toEqual([
      "Scripts/Controllers/HarborController.cs",
      "Scripts/Data/UnityObjects/CD_Harbor.cs",
      "Scripts/Data/ValueObjects/HarborConfig.cs",
      "Scripts/HarborModuleConfig.cs",
      "Scripts/Interfaces/IHarborService.cs",
      "Scripts/Services/HarborService.cs",
    ]);
    const config = read(root, "Scripts/HarborModuleConfig.cs");
    expect(config).toContain("builder.RegisterController<HarborController>();");
    expect(config).toContain("patterns.RegisterController(services.Get<HarborController>());");
    expect(read(root, "Scripts/Controllers/HarborController.cs")).toContain("public class HarborController : TickableController");
    expect(read(root, "Scripts/Data/UnityObjects/CD_Harbor.cs")).toContain("public class CD_Harbor : ConfigData<HarborConfig>");

    const expected = core({
      ModuleConfig: true, ServiceInterface: true, Service: true, Controller: true, ConfigData: true, ValueObject: true,
    });
    for (const file of csFiles(root)) {
      expect(read(root, file), file).toBe(expected.get(file.split("/").pop()!));
    }
  });

  it("a system only when asked for, and then Core's, with no TODO or commented-out code", async () => {
    const root = project();
    await run(root);
    expect(existsSync(join(root, MODULE, "Scripts", "Systems", "HarborSystem.cs"))).toBe(false);

    const asked = project();
    const result = await run(asked, { include_system: true });
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    const system = read(asked, "Scripts/Systems/HarborSystem.cs");
    expect(system).toBe(core({ EcsSystem: true }).get("HarborSystem.cs"));
    expect(system).not.toMatch(/TODO|\/\/\s*ForEach/);
  });

  it("registers only what this call made: a hand-written service is neither stubbed nor registered", async () => {
    const root = project();
    put(root, "Scripts/Services/HarborService.cs", "namespace Game.Modules.Harbor { public class HarborService { public int Berths; } }");

    const result = await run(root, { include_controller: true });
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(read(root, "Scripts/Services/HarborService.cs")).toContain("Berths");
    expect(existsSync(join(root, MODULE, "Scripts", "Interfaces", "IHarborService.cs"))).toBe(false);

    const config = read(root, "Scripts/HarborModuleConfig.cs");
    expect(config).not.toContain("RegisterService");
    expect(config).toContain("patterns.RegisterController(services.Get<HarborController>());");
    // The controller does not inject a service this call did not make.
    expect(read(root, "Scripts/Controllers/HarborController.cs")).not.toContain("[Inject]");
  });

  it("a kept config is named, with what is left to register and hand to the PatternManager", async () => {
    const root = project();
    put(root, "Scripts/HarborModuleConfig.cs", "// mine");

    const result = await run(root);
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(read(root, "Scripts/HarborModuleConfig.cs")).toBe("// mine");
    expect(result.content).toMatch(/RegisterService<IHarborService, HarborService>/);
    expect(result.content).toMatch(/PatternManager/);
  });
});

describe("a Strada.Core without module templates", () => {
  it("keeps Brain's own templates, says so, and still makes no system by default", async () => {
    const root = project(false);
    const result = await run(root);
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(read(root, "Scripts/HarborModuleConfig.cs")).toContain("class HarborModuleConfig : ModuleConfig");
    expect(existsSync(join(root, MODULE, "Scripts", "Systems", "HarborSystem.cs"))).toBe(false);
    expect(result.content).toMatch(/declares no module templates/);
  });

  it("a system asked for is Core's shape, with no TODO or commented-out ForEach", async () => {
    const root = project(false);
    const result = await run(root, { include_system: true });
    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    const system = read(root, "Scripts/Systems/HarborSystem.cs");
    expect(system).toContain("public class HarborSystem : SystemBase");
    expect(system).toContain("protected override void OnUpdate(float deltaTime)");
    expect(system).not.toMatch(/TODO|\/\/\s*ForEach/);
  });
});

describe("module templates this reader cannot follow", () => {
  it("refuses, names the file and the construct, and writes nothing", async () => {
    const root = project(false);
    installCoreTemplates(
      root,
      CORE_TEMPLATES_SOURCE.replace(
        "var files = new List<GeneratedFile>(16);",
        "var files = new List<GeneratedFile>(16);\n            switch (name) { default: break; }",
      ),
    );

    const result = await run(root);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ModuleSourceTemplates.cs");
    expect(result.content).toMatch(/switch/);
    expect(existsSync(join(root, "Assets"))).toBe(false);
  });

  it("refuses a framework member it would otherwise print as its last word", async () => {
    // Read as declared, this wrote a line holding only `Empty` into every
    // service interface.
    const root = project(false);
    installCoreTemplates(
      root,
      CORE_TEMPLATES_SOURCE.replace(
        'sb.AppendLine($"    public interface I{name}Service : IService");',
        'sb.AppendLine(string.Empty); sb.AppendLine($"    public interface I{name}Service : IService");',
      ),
    );

    const result = await run(root);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ModuleSourceTemplates.cs");
    expect(result.content).toMatch(/string\.Empty/);
    // The refusal says what to do instead.
    expect(result.content).toMatch(/by hand from Packages\/Submodules\/Strada\.Core\/.*ModuleSourceTemplates\.cs/);
    expect(existsSync(join(root, "Assets"))).toBe(false);
  });

  it("refuses a requested component whose option the installed Core does not declare, before writing anything", async () => {
    // A Core that renamed EcsSystem: rendering without the option made
    // include_system produce no system, and the result did not say so.
    const root = project(false);
    installCoreTemplates(root, CORE_TEMPLATES_SOURCE.replaceAll("EcsSystem", "EntitySystem"));

    const asked = await run(root, { include_system: true });
    expect(asked.isError).toBe(true);
    expect(asked.content).toMatch(/EcsSystem/);
    expect(asked.content).toContain("ModuleSourceTemplates.cs");
    expect(existsSync(join(root, "Assets"))).toBe(false);

    // Not asking for it asks nothing of the missing option.
    const plain = await run(root);
    expect(plain.isError, `refused: ${plain.content}`).toBeFalsy();
  });
});
