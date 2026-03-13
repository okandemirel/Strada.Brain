import { describe, it, expect, vi, beforeEach } from "vitest";
import { ComponentCreateTool } from "./component-create.js";
import { createToolContext } from "../../../test-helpers.js";

vi.mock("../../../security/path-guard.js", () => ({
  validatePath: vi.fn().mockResolvedValue({ valid: true, fullPath: "/test/project/Assets/Test.cs" }),
  isValidCSharpIdentifier: vi.fn().mockReturnValue(true),
  isValidCSharpType: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { validatePath, isValidCSharpIdentifier, isValidCSharpType } from "../../../security/path-guard.js";
import { writeFile } from "node:fs/promises";

describe("ComponentCreateTool", () => {
  let tool: ComponentCreateTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new ComponentCreateTool();
    vi.mocked(validatePath).mockResolvedValue({ valid: true, fullPath: "/test/project/Assets/Test.cs" });
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(true);
    vi.mocked(isValidCSharpType).mockReturnValue(true);
  });

  it("creates a valid component with StructLayout attribute", async () => {
    const result = await tool.execute({
      name: "Health",
      path: "Assets/Components/Health.cs",
      namespace: "Game.Combat",
      fields: [{ name: "Current", type: "float" }, { name: "Max", type: "float" }],
    }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Component 'Health' created");
    expect(writeFile).toHaveBeenCalled();

    const writtenCode = vi.mocked(writeFile).mock.calls[0]![1] as string;
    expect(writtenCode).toContain("using System.Runtime.InteropServices;");
    expect(writtenCode).toContain("using Strada.Core.ECS;");
    expect(writtenCode).toContain("[StructLayout(LayoutKind.Sequential)]");
    expect(writtenCode).toContain("public struct Health : IComponent");
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

    const writtenCode = vi.mocked(writeFile).mock.calls[0]![1] as string;
    expect(writtenCode).toContain("using Unity.Mathematics;");
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
