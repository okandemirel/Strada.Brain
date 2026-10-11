import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediatorCreateTool } from "./mediator-create.js";
import { createToolContext } from "../../../test-helpers.js";
import type { ToolContext } from "../tool.interface.js";

vi.mock("../../../security/path-guard.js", () => ({
  validatePath: vi.fn(),
  isValidCSharpIdentifier: vi.fn().mockReturnValue(true),
  isValidCSharpType: vi.fn().mockReturnValue(true),
}));

import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";

describe("MediatorCreateTool", () => {
  let tool: MediatorCreateTool;
  let root: string;
  let ctx: ToolContext;
  // The tool writes for real (exclusively, so it can never replace a file), so
  // the project is a temp directory rather than a mocked filesystem.
  const written = (relPath: string) => readFileSync(join(root, relPath), "utf-8");

  beforeEach(() => {
    tool = new MediatorCreateTool();
    root = mkdtempSync(join(tmpdir(), "strada-mediator-test-"));
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

    const code = written("Assets/Med.cs");
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

    expect(result.isError).toBeUndefined();
    const code = written("Assets/Med.cs");
    expect(code).toContain("Add component bindings here");
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
