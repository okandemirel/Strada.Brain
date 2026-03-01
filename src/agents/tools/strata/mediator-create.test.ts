import { describe, it, expect, vi, beforeEach } from "vitest";
import { MediatorCreateTool } from "./mediator-create.js";
import { createToolContext } from "../../../test-helpers.js";

vi.mock("../../../security/path-guard.js", () => ({
  validatePath: vi.fn().mockResolvedValue({ valid: true, fullPath: "/test/project/Med.cs" }),
  isValidCSharpIdentifier: vi.fn().mockReturnValue(true),
  isValidCSharpType: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { isValidCSharpIdentifier } from "../../../security/path-guard.js";
import { writeFile } from "node:fs/promises";

describe("MediatorCreateTool", () => {
  let tool: MediatorCreateTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new MediatorCreateTool();
    vi.clearAllMocks();
    vi.mocked(isValidCSharpIdentifier).mockReturnValue(true);
  });

  it("creates mediator with bindings", async () => {
    const result = await tool.execute({
      name: "EnemyMediator",
      view_type: "EnemyView",
      path: "Assets/Med.cs",
      namespace: "Game.Combat",
      bindings: [{
        component: "Health",
        property: "Current",
        property_type: "float",
        view_method: "UpdateHealth",
      }],
    }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Mediator 'EnemyMediator' created");
    expect(result.content).toContain("Bindings: 1");

    const code = vi.mocked(writeFile).mock.calls[0]![1] as string;
    expect(code).toContain("class EnemyMediator : EntityMediator<EnemyView>");
    expect(code).toContain("Bind<Health, float>");
  });

  it("creates mediator without bindings (TODO comment)", async () => {
    const result = await tool.execute({
      name: "PlayerMediator",
      view_type: "PlayerView",
      path: "Assets/Med.cs",
      namespace: "Game",
    }, ctx);

    const code = vi.mocked(writeFile).mock.calls[0]![1] as string;
    expect(code).toContain("TODO: Add component bindings");
    expect(result.content).toContain("No bindings configured");
  });

  it("returns error for invalid binding identifier", async () => {
    vi.mocked(isValidCSharpIdentifier)
      .mockReturnValueOnce(true)  // name
      .mockReturnValueOnce(true)  // viewType
      .mockReturnValueOnce(true)  // namespace
      .mockReturnValueOnce(false); // binding.component

    const result = await tool.execute({
      name: "M", view_type: "V", path: "x.cs", namespace: "N",
      bindings: [{ component: "bad;", property: "x", property_type: "int", view_method: "Do" }],
    }, ctx);
    expect(result.isError).toBe(true);
  });

  it("returns error in read-only mode", async () => {
    const result = await tool.execute(
      { name: "M", view_type: "V", path: "x", namespace: "N" },
      createToolContext({ readOnly: true })
    );
    expect(result.isError).toBe(true);
  });

  it("returns error when required params missing", async () => {
    const result = await tool.execute({ name: "", view_type: "", path: "", namespace: "" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });
});
