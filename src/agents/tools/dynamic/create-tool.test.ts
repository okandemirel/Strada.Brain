import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreateToolTool, getFactory } from "./create-tool.js";
import { createToolContext, createMockTool } from "../../../test-helpers.js";

describe("CreateToolTool", () => {
  const tool = new CreateToolTool();

  beforeEach(() => {
    // Reset factory state between tests
    const factory = getFactory();
    for (const { name } of factory.listAll()) {
      factory.remove(name);
    }
  });

  it("has correct name and schema", () => {
    expect(tool.name).toBe("create_tool");
    expect(tool.inputSchema.required).toContain("name");
    expect(tool.inputSchema.required).toContain("description");
    expect(tool.inputSchema.required).toContain("strategy");
  });

  it("returns error when registerDynamicTool is not in context", async () => {
    const result = await tool.execute(
      { name: "test", description: "test", strategy: "shell", command: "echo" },
      createToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("creates and registers a shell tool", async () => {
    const registeredTools: Array<{ name: string }> = [];
    const ctx = createToolContext({
      registerDynamicTool: (t) => registeredTools.push(t),
      lookupTool: () => undefined,
    });

    const result = await tool.execute(
      {
        name: "my_echo",
        description: "Echo things",
        strategy: "shell",
        command: "echo {{msg}}",
        parameters: [
          { name: "msg", type: "string", description: "Message", required: true },
        ],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("dynamic_my_echo");
    expect(result.content).toContain("created and registered");
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("dynamic_my_echo");
  });

  it("creates and registers a composite tool", async () => {
    const registeredTools: Array<{ name: string }> = [];
    const mockRead = createMockTool("file_read");
    const ctx = createToolContext({
      registerDynamicTool: (t) => registeredTools.push(t),
      lookupTool: (name) => (name === "file_read" ? mockRead : undefined),
    });

    const result = await tool.execute(
      {
        name: "read_wrapper",
        description: "Wrapper",
        strategy: "composite",
        parameters: [{ name: "path", type: "string", description: "Path" }],
        steps: [
          { tool: "file_read", params: { path: "{{path}}" } },
        ],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("dynamic_read_wrapper");
  });

  it("rejects duplicate tool name", async () => {
    const ctx = createToolContext({
      registerDynamicTool: () => {},
      lookupTool: () => undefined,
    });

    // Create first
    await tool.execute(
      { name: "unique", description: "test", strategy: "shell", command: "echo" },
      ctx,
    );

    // Try duplicate
    const result = await tool.execute(
      { name: "unique", description: "test", strategy: "shell", command: "echo" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
  });

  it("rejects invalid spec", async () => {
    const ctx = createToolContext({
      registerDynamicTool: () => {},
      lookupTool: () => undefined,
    });

    const result = await tool.execute(
      { name: "", description: "test", strategy: "shell", command: "echo" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to create");
  });

  it("rolls back on registration failure", async () => {
    const ctx = createToolContext({
      registerDynamicTool: () => {
        throw new Error("Registration blocked");
      },
      lookupTool: () => undefined,
    });

    const result = await tool.execute(
      { name: "will_fail", description: "test", strategy: "shell", command: "echo" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("registration failed");
    // Factory should have cleaned up
    expect(getFactory().has("dynamic_will_fail")).toBe(false);
  });

  it("shows parameter list in success message", async () => {
    const ctx = createToolContext({
      registerDynamicTool: () => {},
      lookupTool: () => undefined,
    });

    const result = await tool.execute(
      {
        name: "param_tool",
        description: "test",
        strategy: "shell",
        command: "echo {{a}} {{b}}",
        parameters: [
          { name: "a", type: "string", description: "First", required: true },
          { name: "b", type: "number", description: "Second" },
        ],
      },
      ctx,
    );

    expect(result.content).toContain("a (string)");
    expect(result.content).toContain("b (number)");
    expect(result.content).toContain("*required*");
  });

  it("blocks shell strategy in read-only mode", async () => {
    const ctx = createToolContext({
      readOnly: true,
      registerDynamicTool: () => {},
      lookupTool: () => undefined,
    });

    const result = await tool.execute(
      {
        name: "ro_shell",
        description: "test",
        strategy: "shell",
        command: "echo hello",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Shell-strategy dynamic tools are blocked in read-only mode");
  });

  it("allows composite strategy in read-only mode", async () => {
    const registeredTools: Array<{ name: string }> = [];
    const mockRead = createMockTool("file_read");
    const ctx = createToolContext({
      readOnly: true,
      registerDynamicTool: (t) => registeredTools.push(t),
      lookupTool: (name) => (name === "file_read" ? mockRead : undefined),
    });

    const result = await tool.execute(
      {
        name: "ro_composite",
        description: "Read-only composite wrapper",
        strategy: "composite",
        parameters: [{ name: "path", type: "string", description: "Path" }],
        steps: [
          { tool: "file_read", params: { path: "{{path}}" } },
        ],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("dynamic_ro_composite");
    expect(result.content).toContain("created and registered");
    expect(registeredTools).toHaveLength(1);
  });
});
