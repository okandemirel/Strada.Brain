import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { DynamicToolFactory, validateSpec } from "./dynamic-tool-factory.js";
import { createToolContext, createMockTool } from "../../../test-helpers.js";
import type { DynamicToolSpec } from "./types.js";

/** ToolContext with a real directory so shell commands can execute. */
const shellCtx = () =>
  createToolContext({ projectPath: tmpdir(), workingDirectory: tmpdir() });

describe("validateSpec", () => {
  it("passes for a valid shell spec", () => {
    const spec: DynamicToolSpec = {
      name: "list_files",
      description: "List files in a directory",
      parameters: [{ name: "dir", type: "string", description: "Directory path", required: true }],
      strategy: "shell",
      command: "ls {{dir}}",
    };
    expect(validateSpec(spec)).toEqual([]);
  });

  it("passes for a valid composite spec", () => {
    const spec: DynamicToolSpec = {
      name: "read_and_count",
      description: "Read a file and count its contents",
      parameters: [{ name: "path", type: "string", description: "File path", required: true }],
      strategy: "composite",
      steps: [
        { tool: "file_read", params: { path: "{{path}}" }, outputAs: "content" },
      ],
    };
    expect(validateSpec(spec)).toEqual([]);
  });

  it("rejects missing name", () => {
    const spec = { name: "", description: "test", strategy: "shell", command: "echo", parameters: [] } as DynamicToolSpec;
    const issues = validateSpec(spec);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("name");
  });

  it("rejects invalid name format", () => {
    const spec = { name: "My-Tool", description: "test", strategy: "shell", command: "echo", parameters: [] } as DynamicToolSpec;
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.field === "name")).toBe(true);
  });

  it("rejects missing command for shell strategy", () => {
    const spec: DynamicToolSpec = {
      name: "test_tool",
      description: "test",
      parameters: [],
      strategy: "shell",
    };
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.field === "command")).toBe(true);
  });

  it("rejects empty steps for composite strategy", () => {
    const spec: DynamicToolSpec = {
      name: "test_tool",
      description: "test",
      parameters: [],
      strategy: "composite",
      steps: [],
    };
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.field === "steps")).toBe(true);
  });

  it("rejects timeout exceeding maximum", () => {
    const spec: DynamicToolSpec = {
      name: "test_tool",
      description: "test",
      parameters: [],
      strategy: "shell",
      command: "echo test",
      timeout: 999_999,
    };
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.field === "timeout")).toBe(true);
  });

  it("rejects invalid strategy", () => {
    const spec = {
      name: "test_tool",
      description: "test",
      parameters: [],
      strategy: "unknown",
    } as unknown as DynamicToolSpec;
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.field === "strategy")).toBe(true);
  });
});

describe("DynamicToolFactory", () => {
  it("creates a shell tool with correct name prefix", () => {
    const factory = new DynamicToolFactory();
    const spec: DynamicToolSpec = {
      name: "echo_test",
      description: "Echo a message",
      parameters: [{ name: "msg", type: "string", description: "Message", required: true }],
      strategy: "shell",
      command: "echo {{msg}}",
    };

    const tool = factory.create(spec, new Set());
    expect(tool.name).toBe("dynamic_echo_test");
    expect(tool.description).toContain("[Dynamic]");
    expect(tool.isPlugin).toBe(true);
  });

  it("shell tool executes command with parameter interpolation", async () => {
    const factory = new DynamicToolFactory();
    const spec: DynamicToolSpec = {
      name: "echo_hello",
      description: "Echo hello",
      parameters: [{ name: "name", type: "string", description: "Name" }],
      strategy: "shell",
      command: "echo Hello {{name}}",
    };

    const tool = factory.create(spec, new Set());
    const result = await tool.execute({ name: "World" }, shellCtx());
    expect(result.content).toContain("Hello");
    expect(result.isError).toBeUndefined();
  });

  it("shell tool escapes parameters to prevent injection", async () => {
    const factory = new DynamicToolFactory();
    const spec: DynamicToolSpec = {
      name: "safe_echo",
      description: "Safely echo",
      parameters: [{ name: "input", type: "string", description: "Input" }],
      strategy: "shell",
      command: "echo {{input}}",
    };

    const tool = factory.create(spec, new Set());
    // Attempt shell injection — should be escaped
    const result = await tool.execute(
      { input: "hello; rm -rf /" },
      shellCtx(),
    );
    // The output should contain the literal string, not execute rm
    expect(result.content).toContain("hello; rm -rf /");
    expect(result.isError).toBeUndefined();
  });

  it("composite tool chains existing tools", async () => {
    const factory = new DynamicToolFactory();
    const mockTool = createMockTool("mock_read");

    const spec: DynamicToolSpec = {
      name: "read_wrapper",
      description: "Wrapper around read",
      parameters: [{ name: "path", type: "string", description: "Path", required: true }],
      strategy: "composite",
      steps: [
        { tool: "mock_read", params: { path: "{{path}}" } },
      ],
    };

    const tool = factory.create(spec, new Set(), (name) =>
      name === "mock_read" ? mockTool : undefined,
    );

    const result = await tool.execute({ path: "/test" }, createToolContext());
    expect(result.content).toBe("mock_read result");
    expect(mockTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/test" }),
      expect.anything(),
    );
  });

  it("composite tool fails if referenced tool not found", async () => {
    const factory = new DynamicToolFactory();
    const spec: DynamicToolSpec = {
      name: "broken_chain",
      description: "Chain with missing tool",
      parameters: [],
      strategy: "composite",
      steps: [{ tool: "nonexistent", params: {} }],
    };

    const tool = factory.create(spec, new Set(), () => undefined);
    const result = await tool.execute({}, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("enforces maximum dynamic tool limit", () => {
    const factory = new DynamicToolFactory();
    // Create 50 tools (the limit)
    for (let i = 0; i < 50; i++) {
      factory.create(
        {
          name: `tool_${i}`,
          description: "test",
          parameters: [],
          strategy: "shell",
          command: "echo",
        },
        new Set(),
      );
    }

    expect(() =>
      factory.create(
        {
          name: "tool_overflow",
          description: "test",
          parameters: [],
          strategy: "shell",
          command: "echo",
        },
        new Set(),
      ),
    ).toThrow(/limit reached/);
  });

  it("rejects duplicate prefixed name in factory registry", () => {
    const factory = new DynamicToolFactory();
    const spec: DynamicToolSpec = {
      name: "dupe",
      description: "test",
      parameters: [],
      strategy: "shell",
      command: "echo",
    };

    factory.create(spec, new Set());
    expect(factory.has("dynamic_dupe")).toBe(true);

    // Second create with same name should fail
    expect(() => factory.create(spec, new Set())).toThrow(/already exists/);
  });

  it("tracks call count", async () => {
    const factory = new DynamicToolFactory();
    const tool = factory.create(
      {
        name: "counter",
        description: "test",
        parameters: [],
        strategy: "shell",
        command: "echo ok",
      },
      new Set(),
    );

    await tool.execute({}, createToolContext());
    await tool.execute({}, createToolContext());

    const record = factory.getRecord("dynamic_counter");
    expect(record?.callCount).toBe(2);
  });

  it("removes a dynamic tool", () => {
    const factory = new DynamicToolFactory();
    factory.create(
      {
        name: "removable",
        description: "test",
        parameters: [],
        strategy: "shell",
        command: "echo",
      },
      new Set(),
    );

    expect(factory.has("dynamic_removable")).toBe(true);
    expect(factory.remove("dynamic_removable")).toBe(true);
    expect(factory.has("dynamic_removable")).toBe(false);
  });

  it("listAll returns all registered tools", () => {
    const factory = new DynamicToolFactory();
    factory.create({ name: "a", description: "a", parameters: [], strategy: "shell", command: "echo" }, new Set());
    factory.create({ name: "b", description: "b", parameters: [], strategy: "shell", command: "echo" }, new Set());

    const all = factory.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.name)).toContain("dynamic_a");
    expect(all.map((e) => e.name)).toContain("dynamic_b");
  });

  it("builds correct inputSchema from parameters", () => {
    const factory = new DynamicToolFactory();
    const tool = factory.create(
      {
        name: "schema_test",
        description: "test",
        parameters: [
          { name: "path", type: "string", description: "File path", required: true },
          { name: "count", type: "number", description: "Count" },
        ],
        strategy: "shell",
        command: "echo {{path}} {{count}}",
      },
      new Set(),
    );

    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema).toHaveProperty("type", "object");
    const props = schema["properties"] as Record<string, unknown>;
    expect(props).toHaveProperty("path");
    expect(props).toHaveProperty("count");
    expect(schema["required"]).toEqual(["path"]);
  });

  it("sets metadata with correct risk level for shell tools", () => {
    const factory = new DynamicToolFactory();
    const tool = factory.create(
      { name: "risky", description: "test", parameters: [], strategy: "shell", command: "echo" },
      new Set(),
    );

    expect(tool.metadata).toBeDefined();
    expect(tool.metadata!.riskLevel).toBe("caution");
    expect(tool.metadata!.requiresConfirmation).toBe(true);
  });

  it("sets metadata with safe risk level for composite tools", () => {
    const factory = new DynamicToolFactory();
    const tool = factory.create(
      {
        name: "safe_composite",
        description: "test",
        parameters: [],
        strategy: "composite",
        steps: [{ tool: "x", params: {} }],
      },
      new Set(),
    );

    expect(tool.metadata!.riskLevel).toBe("safe");
    expect(tool.metadata!.requiresConfirmation).toBe(false);
  });

  it("shell executor blocks execution in read-only mode", async () => {
    const factory = new DynamicToolFactory();
    const tool = factory.create(
      {
        name: "ro_shell_block",
        description: "Should be blocked in read-only",
        parameters: [],
        strategy: "shell",
        command: "echo should-not-run",
      },
      new Set(),
    );

    const ctx = createToolContext({
      readOnly: true,
      projectPath: tmpdir(),
      workingDirectory: tmpdir(),
    });

    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Shell-strategy dynamic tools are blocked in read-only mode");
  });
});
