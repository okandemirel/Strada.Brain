import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ModuleCreateTool } from "./module-create.js";
import { createToolContext } from "../../../test-helpers.js";
import { installCoreDeclaration } from "./core-declaration-fixture.js";
import type { ToolContext } from "../tool.interface.js";

vi.mock("../../../security/path-guard.js", () => ({
  validatePath: vi.fn(),
  isValidCSharpIdentifier: vi.fn().mockReturnValue(true),
}));

import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";

describe("ModuleCreateTool", () => {
  let tool: ModuleCreateTool;
  let root: string;
  let ctx: ToolContext;
  const moduleRoot = () => join(root, "Assets", "Modules", "CombatModule");
  // The tool writes for real (exclusively, so it never replaces a file), so
  // the project is a temp directory with the framework's declaration installed,
  // the same text a real Strada.Core checkout carries.
  const written = (rel: string) => readFileSync(join(moduleRoot(), ...rel.split("/")), "utf-8");
  const entries = (kind: "dirs" | "files") =>
    readdirSync(moduleRoot(), { recursive: true, withFileTypes: true })
      .filter((e) => (kind === "dirs" ? e.isDirectory() : e.isFile()))
      .map((e) => join(e.parentPath, e.name).slice(moduleRoot().length + 1).split(sep).join("/"))
      .sort();

  beforeEach(() => {
    tool = new ModuleCreateTool();
    root = mkdtempSync(join(tmpdir(), "strada-module-test-"));
    installCoreDeclaration(root);
    ctx = createToolContext({ projectPath: root, workingDirectory: root });
    vi.mocked(validatePath).mockImplementation(async (_root: string, relPath: string) => ({
      valid: true,
      fullPath: join(root, relPath),
    }));
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates full module with system and service", async () => {
    const result = await tool.execute({
      name: "Combat",
      include_system: true,
      include_service: true,
    }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Module 'Combat' created");

    // Every folder Strada.Core's declaration gives this component selection:
    // Scripts and its four code folders, Tests/Runtime and Tests/Editor, and
    // the eleven authored-asset folders a module gets by default (Tests and Art
    // are their parents). Listing them here is what catches the list silently
    // changing.
    expect(entries("dirs")).toEqual([
      "Art", "Art/Materials", "Art/Models", "Art/Prefabs", "Art/Textures",
      "Audio", "Prefabs", "Resources", "Scenes", "Scriptables",
      "Scripts", "Scripts/Components", "Scripts/Interfaces", "Scripts/Services", "Scripts/Systems",
      "Settings", "Sprites",
      "Tests", "Tests/Editor", "Tests/Runtime",
    ]);

    // asmdef + ModuleConfig + System + Interface + Impl, plus the two default
    // test assemblies = 7 files
    expect(entries("files")).toHaveLength(7);
    expect((result.metadata as { createdFiles: string[] }).createdFiles).toHaveLength(7);

    // Verify asmdef content
    const asmdefContent = JSON.parse(written("Combat.asmdef"));
    expect(asmdefContent.references).toEqual([
      "Strada.Core",
      "Unity.Burst",
      "Unity.Collections",
      "Unity.Mathematics",
      "Unity.Entities",
    ]);

    // Verify ModuleConfig uses RegisterService pattern
    const configCode = written("Scripts/CombatModuleConfig.cs");
    expect(configCode).toContain("class CombatModuleConfig : ModuleConfig");
    expect(configCode).toContain("RegisterService<ICombatService, CombatService>");
    expect(configCode).toContain("using Strada.Core.Modules;");
    expect(configCode).toContain("using Strada.Core.DI;");

    // Verify system uses correct API
    const systemCode = written("Scripts/Systems/CombatSystem.cs");
    expect(systemCode).toContain("using Strada.Core.ECS.Systems;");
    expect(systemCode).toContain("using Strada.Core.Modules;");
    expect(systemCode).toContain("[StradaSystem]");
    expect(systemCode).toContain("[ExecutionOrder(0)]");
    expect(systemCode).toContain("protected override void OnInitialize()");
    expect(systemCode).toContain("protected override void OnDispose()");
    expect(systemCode).not.toContain("World.Query");

    const serviceCode = written("Scripts/Services/CombatService.cs");
    expect(serviceCode).toContain("using Strada.Core.Patterns;");
    expect(serviceCode).toContain("class CombatService : Service, ICombatService");
  });

  it("creates module without system and service", async () => {
    const result = await tool.execute({
      name: "Combat",
      include_system: false,
      include_service: false,
    }, ctx);

    expect(result.isError).toBeUndefined();
    // asmdef + ModuleConfig + the two default test assemblies = 4 files
    expect(entries("files")).toHaveLength(4);
  });

  it("returns error for lowercase module name", async () => {
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(true);
    const result = await tool.execute({ name: "combat" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("uppercase");
  });

  it("returns error for invalid module name", async () => {
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(false);
    const result = await tool.execute({ name: "123Bad" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("returns error for invalid namespace", async () => {
    vi.mocked(isValidCSharpIdentifier)
      .mockReturnValueOnce(true)  // name
      .mockReturnValueOnce(false); // namespace
    const result = await tool.execute({ name: "Combat", namespace: "bad;ns" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid namespace");
  });

  it("returns error in read-only mode", async () => {
    const result = await tool.execute(
      { name: "Combat" },
      createToolContext({ projectPath: root, workingDirectory: root, readOnly: true })
    );
    expect(result.isError).toBe(true);
  });

  it("uses default path and namespace", async () => {
    await tool.execute({ name: "Combat" }, ctx);
    // Default path: Assets/Modules/CombatModule, namespace: Game.Modules.Combat
    expect(written("Scripts/CombatModuleConfig.cs")).toContain("namespace Game.Modules.Combat");
  });

  it("creates correct directory structure", async () => {
    await tool.execute({ name: "Combat" }, ctx);
    const dirs = entries("dirs");
    expect(dirs).toContain("Scripts/Systems");
    expect(dirs).toContain("Scripts/Services");
    expect(dirs).toContain("Scripts/Components");
    // Mediators was never a folder the framework declared.
    expect(dirs.some((d) => d.endsWith("Mediators"))).toBe(false);
    expect(dirs).toContain("Scripts/Interfaces");
  });
});
