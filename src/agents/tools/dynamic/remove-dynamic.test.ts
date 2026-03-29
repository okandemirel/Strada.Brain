import { describe, it, expect, vi, beforeEach } from "vitest";
import { RemoveDynamicToolTool } from "./remove-dynamic.js";
import { getFactory } from "./create-tool.js";
import { createToolContext } from "../../../test-helpers.js";

describe("RemoveDynamicToolTool", () => {
  const tool = new RemoveDynamicToolTool();

  beforeEach(() => {
    const factory = getFactory();
    for (const { name } of factory.listAll()) {
      factory.remove(name);
    }
  });

  it("has correct name and schema", () => {
    expect(tool.name).toBe("remove_dynamic_tool");
    expect(tool.inputSchema.required).toContain("tool_name");
  });

  it("removes an existing dynamic tool", async () => {
    const factory = getFactory();
    factory.create(
      { name: "to_remove", description: "test", parameters: [], strategy: "shell", command: "echo" },
      new Set(),
    );

    const unregisterFn = vi.fn().mockReturnValue(true);
    const ctx = createToolContext({ unregisterDynamicTool: unregisterFn });

    const result = await tool.execute({ tool_name: "dynamic_to_remove" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("has been removed");
    expect(unregisterFn).toHaveBeenCalledWith("dynamic_to_remove");
    expect(factory.has("dynamic_to_remove")).toBe(false);
  });

  it("rejects empty tool_name", async () => {
    const result = await tool.execute({ tool_name: "" }, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("rejects non-dynamic tool names", async () => {
    const result = await tool.execute({ tool_name: "file_read" }, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("only dynamic tools");
  });

  it("returns error for unknown dynamic tool", async () => {
    const result = await tool.execute(
      { tool_name: "dynamic_nonexistent" },
      createToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("reports call count in removal message", async () => {
    const factory = getFactory();
    const createdTool = factory.create(
      { name: "counted", description: "test", parameters: [], strategy: "shell", command: "echo ok" },
      new Set(),
    );
    // Simulate some calls
    await createdTool.execute({}, createToolContext());
    await createdTool.execute({}, createToolContext());
    await createdTool.execute({}, createToolContext());

    const ctx = createToolContext({ unregisterDynamicTool: () => true });
    const result = await tool.execute({ tool_name: "dynamic_counted" }, ctx);
    expect(result.content).toContain("3 time(s)");
  });

  it("handles missing unregisterDynamicTool gracefully", async () => {
    const factory = getFactory();
    factory.create(
      { name: "no_unreg", description: "test", parameters: [], strategy: "shell", command: "echo" },
      new Set(),
    );

    // No unregisterDynamicTool in context
    const result = await tool.execute(
      { tool_name: "dynamic_no_unreg" },
      createToolContext(),
    );
    // Should still succeed (factory removal works)
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("has been removed");
  });
});
