import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModuleCreateTool } from "./module-create.js";
import { createToolContext } from "../../../test-helpers.js";

vi.mock("../../../security/path-guard.js", () => ({
  validatePath: vi.fn().mockResolvedValue({ valid: true, fullPath: "/test/project/Assets/Modules/Combat" }),
  isValidCSharpIdentifier: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { isValidCSharpIdentifier } from "../../../security/path-guard.js";
import { writeFile, mkdir } from "node:fs/promises";

describe("ModuleCreateTool", () => {
  let tool: ModuleCreateTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new ModuleCreateTool();
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(true);
  });

  it("creates full module with system and service", async () => {
    const result = await tool.execute({
      name: "Combat",
      include_system: true,
      include_service: true,
    }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Module 'Combat' created");

    // Should create 6 directories (root + Scripts + 4 subdirs under Scripts)
    expect(mkdir).toHaveBeenCalledTimes(6);

    // Should write asmdef + ModuleConfig + System + Interface + Impl = 5 files
    expect(writeFile).toHaveBeenCalledTimes(5);

    // Verify asmdef content
    const asmdefCall = vi.mocked(writeFile).mock.calls.find(
      (c) => String(c[0]).endsWith(".asmdef")
    );
    expect(asmdefCall).toBeTruthy();
    const asmdefContent = JSON.parse(asmdefCall![1] as string);
    expect(asmdefContent.references).toContain("Strada.Core");

    // Verify ModuleConfig uses RegisterService pattern
    const configCall = vi.mocked(writeFile).mock.calls.find(
      (c) => String(c[0]).endsWith("CombatModuleConfig.cs")
    );
    expect(configCall).toBeTruthy();
    const configCode = configCall![1] as string;
    expect(configCode).toContain("class CombatModuleConfig : ModuleConfig");
    expect(configCode).toContain("RegisterService<ICombatService, CombatService>");
    expect(configCode).toContain("using Strada.Core.Modules;");
    expect(configCode).toContain("using Strada.Core.DI;");

    // Verify system uses correct API
    const systemCall = vi.mocked(writeFile).mock.calls.find(
      (c) => String(c[0]).endsWith("CombatSystem.cs")
    );
    expect(systemCall).toBeTruthy();
    const systemCode = systemCall![1] as string;
    expect(systemCode).toContain("using Strada.Core.ECS.Systems;");
    expect(systemCode).toContain("[StradaSystem]");
    expect(systemCode).toContain("[ExecutionOrder(0)]");
    expect(systemCode).toContain("protected override void OnInitialize()");
    expect(systemCode).toContain("protected override void OnDispose()");
    expect(systemCode).not.toContain("World.Query");
  });

  it("creates module without system and service", async () => {
    const result = await tool.execute({
      name: "Combat",
      include_system: false,
      include_service: false,
    }, ctx);

    expect(result.isError).toBeUndefined();
    // Only asmdef + ModuleConfig = 2 files
    expect(writeFile).toHaveBeenCalledTimes(2);
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
      createToolContext({ readOnly: true })
    );
    expect(result.isError).toBe(true);
  });

  it("uses default path and namespace", async () => {
    await tool.execute({ name: "Combat" }, ctx);
    // Default path: Assets/Modules/Combat, namespace: Game.Modules.Combat
    const configCode = vi.mocked(writeFile).mock.calls.find(
      (c) => String(c[0]).endsWith("CombatModuleConfig.cs")
    )![1] as string;
    expect(configCode).toContain("namespace Game.Modules.Combat");
  });

  it("creates correct directory structure", async () => {
    await tool.execute({ name: "Combat" }, ctx);
    const mkdirCalls = vi.mocked(mkdir).mock.calls.map((c) => String(c[0]));
    expect(mkdirCalls.some((d) => d.endsWith("Systems"))).toBe(true);
    expect(mkdirCalls.some((d) => d.endsWith("Services"))).toBe(true);
    expect(mkdirCalls.some((d) => d.endsWith("Components"))).toBe(true);
    expect(mkdirCalls.some((d) => d.endsWith("Mediators"))).toBe(true);
  });
});
