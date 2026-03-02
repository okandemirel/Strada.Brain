import { describe, it, expect } from "vitest";
import { DotnetBuildTool, DotnetTestTool, parseBuildOutput, parseTestOutput } from "./dotnet-tools.js";
import type { ToolContext } from "./tool.interface.js";

const ctx: ToolContext = {
  projectPath: "/tmp/test-project",
  workingDirectory: "/tmp/test-project",
  readOnly: false,
};

describe("parseBuildOutput", () => {
  it("parses MSBuild errors", () => {
    const output = `
Build started...
Assets/Scripts/Player.cs(15,10): error CS0246: The type or namespace name 'Foo' could not be found
Assets/Scripts/Enemy.cs(30,5): error CS1002: ; expected
Build FAILED.
`;
    const { errors, warnings } = parseBuildOutput(output);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.file).toBe("Assets/Scripts/Player.cs");
    expect(errors[0]!.line).toBe(15);
    expect(errors[0]!.column).toBe(10);
    expect(errors[0]!.code).toBe("CS0246");
    expect(errors[0]!.severity).toBe("error");
    expect(errors[1]!.code).toBe("CS1002");
  });

  it("parses MSBuild warnings", () => {
    const output = `
Assets/Scripts/Util.cs(5,1): warning CS0168: The variable 'x' is declared but never used
Build succeeded.
`;
    const { errors, warnings } = parseBuildOutput(output);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("CS0168");
    expect(warnings[0]!.severity).toBe("warning");
  });

  it("handles clean build output", () => {
    const output = `
Build started...
  Restoring packages...
  MyProject -> /output/MyProject.dll

Build succeeded.
    0 Warning(s)
    0 Error(s)
`;
    const { errors, warnings } = parseBuildOutput(output);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("parses mixed errors and warnings", () => {
    const output = `
Foo.cs(1,1): error CS0001: err1
Foo.cs(2,2): warning CS0002: warn1
Bar.cs(3,3): error CS0003: err2
`;
    const { errors, warnings } = parseBuildOutput(output);
    expect(errors).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });
});

describe("parseTestOutput", () => {
  it("parses passed tests", () => {
    const output = `
  Passed MyNamespace.MyTests.TestAdd [5ms]
  Passed MyNamespace.MyTests.TestSub [2ms]

Total:     2
Passed:    2
Failed:    0
Skipped:   0
`;
    const { tests, summary } = parseTestOutput(output);
    expect(tests).toHaveLength(2);
    expect(tests[0]!.outcome).toBe("passed");
    expect(tests[0]!.name).toBe("MyNamespace.MyTests.TestAdd");
    expect(tests[0]!.duration).toBe("5ms");
  });

  it("parses failed tests", () => {
    const output = `
  Passed MyTests.Good [1ms]
  Failed MyTests.Bad [10ms]

Total:     2
Passed:    1
Failed:    1
Skipped:   0
`;
    const { tests, summary } = parseTestOutput(output);
    expect(tests).toHaveLength(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.total).toBe(2);
  });

  it("parses skipped tests", () => {
    const output = `
  Passed A [1ms]
  Skipped B
  Skipped C

Total:     3
Passed:    1
Failed:    0
Skipped:   2
`;
    const { tests, summary } = parseTestOutput(output);
    expect(tests).toHaveLength(3);
    expect(summary.skipped).toBe(2);
  });

  it("handles summary line format", () => {
    const output = `Total:  10, Passed:  8, Failed:  1, Skipped:  1`;
    const { summary } = parseTestOutput(output);
    expect(summary.total).toBe(10);
    expect(summary.passed).toBe(8);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it("handles empty output", () => {
    const { tests, summary } = parseTestOutput("");
    expect(tests).toHaveLength(0);
    expect(summary.total).toBe(0);
  });
});

describe("DotnetBuildTool", () => {
  const tool = new DotnetBuildTool();

  it("has correct metadata", () => {
    expect(tool.name).toBe("dotnet_build");
    expect(tool.inputSchema.properties).toHaveProperty("project");
    expect(tool.inputSchema.properties).toHaveProperty("configuration");
  });

  it("handles dotnet not installed gracefully", async () => {
    // This test verifies the tool doesn't crash when dotnet isn't available
    const result = await tool.execute({}, ctx);
    // Should return an error but not throw
    expect(result.content).toBeDefined();
    expect(typeof result.content).toBe("string");
  });
});

describe("DotnetTestTool", () => {
  const tool = new DotnetTestTool();

  it("has correct metadata", () => {
    expect(tool.name).toBe("dotnet_test");
    expect(tool.inputSchema.properties).toHaveProperty("filter");
    expect(tool.inputSchema.properties).toHaveProperty("no_build");
  });

  it("handles dotnet not installed gracefully", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.content).toBeDefined();
    expect(typeof result.content).toBe("string");
  });
});
