import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodeQualityTool } from "./code-quality.js";
import type { ToolContext } from "./tool.interface.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("CodeQualityTool", () => {
  let tool: CodeQualityTool;
  let testDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    tool = new CodeQualityTool();
    testDir = join(tmpdir(), `cq-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    ctx = {
      projectPath: testDir,
      workingDirectory: testDir,
      readOnly: false,
    };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("has correct tool metadata", () => {
    expect(tool.name).toBe("code_quality");
    expect(tool.description).toContain("anti-pattern");
    expect(tool.inputSchema.required).toContain("mode");
  });

  it("analyzes a single clean file", async () => {
    const code = `
namespace Game.Core
{
    public class CleanService : ICleanService
    {
        private readonly ILogger _logger;
        public CleanService(ILogger logger) { _logger = logger; }
        public void Run() { }
    }
}`;
    await writeFile(join(testDir, "CleanService.cs"), code);

    const result = await tool.execute(
      { mode: "file", path: "CleanService.cs" },
      ctx
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Score:");
    expect(result.content).toContain("CleanService.cs");
  });

  it("detects issues in a problematic file", async () => {
    const code = `
public struct BadComp : IComponent {
    public string Name;
}`;
    await writeFile(join(testDir, "BadComp.cs"), code);

    const result = await tool.execute(
      { mode: "file", path: "BadComp.cs" },
      ctx
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("[ERROR]");
    expect(result.content).toContain("reference type");
  });

  it("analyzes entire project", async () => {
    await writeFile(
      join(testDir, "A.cs"),
      "public class A { public void Do() { } }"
    );
    await writeFile(
      join(testDir, "B.cs"),
      "public class B { public void Run() { } }"
    );

    const result = await tool.execute({ mode: "project" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Overall Score:");
    expect(result.content).toContain("Files Analyzed:");
  });

  it("reports an oversized file as not analyzed instead of a perfect score (audited 2026-09-02)", async () => {
    // Over the 1MB parser limit; no numeric literals so the raw-text rules stay
    // quiet. This used to print "Score: 100/100 / No issues found — code looks clean!".
    let code = "public class Big\n{\n";
    for (let i = 0; i < 40; i++) {
      code += `    public void M${i}(string a, string b, string c, string d, string e, string f, string g) { Log(a); }\n`;
    }
    code += "}\n";
    while (code.length <= 1024 * 1024) code += "// generated filler with no numeric literal\n";
    await writeFile(join(testDir, "Big.cs"), code);

    const result = await tool.execute({ mode: "file", path: "Big.cs" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Not analyzed");
    expect(result.content).toContain("Big.cs");
    expect(result.content).toMatch(/1MB|1048576/);
    expect(result.content).not.toContain("Score:");
    expect(result.content).not.toContain("looks clean");

    const project = await tool.execute({ mode: "project" }, ctx);
    expect(project.content).toContain("Files Skipped (not analyzed): 1");
    expect(project.content).not.toContain("100/100");
  });

  it("returns error for missing file", async () => {
    const result = await tool.execute(
      { mode: "file", path: "nonexistent.cs" },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed");
  });

  it("returns error for invalid mode", async () => {
    const result = await tool.execute({ mode: "invalid" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown mode");
  });

  it("requires path for file mode", async () => {
    const result = await tool.execute({ mode: "file" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires a 'path'");
  });
});
