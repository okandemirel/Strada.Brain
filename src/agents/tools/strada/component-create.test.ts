import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentCreateTool } from "./component-create.js";
import { createToolContext } from "../../../test-helpers.js";
import type { ToolContext } from "../tool.interface.js";

vi.mock("../../../security/path-guard.js", () => ({
  validatePath: vi.fn(),
  isValidCSharpIdentifier: vi.fn().mockReturnValue(true),
  isValidCSharpType: vi.fn().mockReturnValue(true),
}));

import { validatePath, isValidCSharpIdentifier, isValidCSharpType } from "../../../security/path-guard.js";

describe("ComponentCreateTool", () => {
  let tool: ComponentCreateTool;
  let root: string;
  let ctx: ToolContext;
  // The tool writes for real (exclusively, so it can never replace a file), so
  // the project is a temp directory rather than a mocked filesystem.
  const written = (relPath: string) => readFileSync(join(root, relPath), "utf-8");

  beforeEach(() => {
    tool = new ComponentCreateTool();
    root = mkdtempSync(join(tmpdir(), "strada-component-test-"));
    ctx = createToolContext({ projectPath: root, workingDirectory: root });
    vi.mocked(validatePath).mockImplementation(async (_root: string, relPath: string) => ({
      valid: true,
      fullPath: join(root, relPath),
    }));
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(true);
    vi.mocked(isValidCSharpType).mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a valid component with StructLayout attribute", async () => {
    const result = await tool.execute({
      name: "Health",
      path: "Assets/Components/Health.cs",
      namespace: "Game.Combat",
      fields: [{ name: "Current", type: "float" }, { name: "Max", type: "float" }],
    }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Component 'HealthComponent' created");

    const writtenCode = written("Assets/Components/Health.cs");
    expect(writtenCode).toContain("using System.Runtime.InteropServices;");
    expect(writtenCode).toContain("using Strada.Core.ECS;");
    expect(writtenCode).toContain("[StructLayout(LayoutKind.Sequential)]");
    expect(writtenCode).toContain("public struct HealthComponent : IComponent");
    expect(writtenCode).toContain("public float Current;");
    expect(writtenCode).toContain("public float Max;");
  });

  it("includes Unity.Mathematics for math types", async () => {
    const result = await tool.execute({
      name: "Velocity",
      path: "Assets/Vel.cs",
      namespace: "Game",
      fields: [{ name: "Value", type: "float3" }],
    }, ctx);

    expect(result.isError).toBeUndefined();
    expect(written("Assets/Vel.cs")).toContain("using Unity.Mathematics;");
  });

  it("returns error in read-only mode", async () => {
    const result = await tool.execute(
      { name: "A", path: "x", namespace: "Y", fields: [] },
      createToolContext({ readOnly: true })
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("returns error for invalid name", async () => {
    vi.mocked(isValidCSharpIdentifier).mockReturnValueOnce(false);
    const result = await tool.execute({
      name: "123Bad", path: "x.cs", namespace: "Y", fields: [],
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid component name");
  });

  it("returns error for invalid field type", async () => {
    vi.mocked(isValidCSharpType).mockReturnValueOnce(false);
    const result = await tool.execute({
      name: "Health", path: "x.cs", namespace: "Y",
      fields: [{ name: "Val", type: "bad;inject" }],
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid field type");
  });

  it("returns error for invalid default value", async () => {
    const result = await tool.execute({
      name: "Health", path: "x.cs", namespace: "Y",
      fields: [{ name: "Val", type: "float", default_value: "0; System.Exec()" }],
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid default value");
  });

  it("returns error when required params missing", async () => {
    const result = await tool.execute({ name: "", path: "", namespace: "" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });
});
