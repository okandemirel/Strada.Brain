import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry, ToolCategories, type ToolCategory, type ToolMetadata } from "./tool-registry.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";
import { ValidationError } from "../common/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTool(name: string, description = `Mock ${name}`): ITool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn<[Record<string, unknown>, ToolContext], Promise<ToolExecutionResult>>().mockResolvedValue({
      content: `executed ${name}`,
    }),
  };
}

function createMetadata(overrides: Partial<ToolMetadata> = {}): Partial<ToolMetadata> {
  return {
    category: "code" as ToolCategory,
    dangerous: false,
    readOnly: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ========================================================================
  // Registration & Lookup
  // ========================================================================

  describe("register / get / has", () => {
    it("registers a tool and retrieves it by name", () => {
      const tool = createMockTool("my_tool");
      registry.register(tool, createMetadata());

      expect(registry.has("my_tool")).toBe(true);
      expect(registry.get("my_tool")).toBe(tool);
    });

    it("returns undefined for an unregistered tool", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
      expect(registry.has("nonexistent")).toBe(false);
    });

    it("throws ValidationError on duplicate registration", () => {
      const tool = createMockTool("dup_tool");
      registry.register(tool, createMetadata());

      expect(() => registry.register(tool, createMetadata())).toThrow(ValidationError);
      expect(() => registry.register(tool, createMetadata())).toThrow("already registered");
    });

    it("registers a tool without metadata", () => {
      const tool = createMockTool("bare_tool");
      registry.register(tool);

      expect(registry.has("bare_tool")).toBe(true);
      expect(registry.getMetadata("bare_tool")).toBeUndefined();
    });
  });

  // ========================================================================
  // Metadata
  // ========================================================================

  describe("metadata", () => {
    it("stores and retrieves full metadata", () => {
      const tool = createMockTool("meta_tool");
      registry.register(tool, {
        category: ToolCategories.GIT,
        dangerous: true,
        requiresConfirmation: true,
        readOnly: false,
        controlPlaneOnly: true,
      });

      const meta = registry.getMetadata("meta_tool");
      expect(meta).toBeDefined();
      expect(meta!.category).toBe("git");
      expect(meta!.dangerous).toBe(true);
      expect(meta!.requiresConfirmation).toBe(true);
      expect(meta!.readOnly).toBe(false);
      expect(meta!.controlPlaneOnly).toBe(true);
      expect(meta!.name).toBe("meta_tool");
    });

    it("applies defaults for omitted metadata fields", () => {
      const tool = createMockTool("defaults_tool");
      registry.register(tool, { category: ToolCategories.FILE });

      const meta = registry.getMetadata("defaults_tool")!;
      expect(meta.dangerous).toBe(false);
      expect(meta.requiresConfirmation).toBe(false);
      expect(meta.readOnly).toBe(true);
      expect(meta.controlPlaneOnly).toBe(false);
      expect(meta.requiresBridge).toBe(false);
      expect(meta.installed).toBe(true);
      expect(meta.available).toBe(true);
    });

    it("returns undefined metadata for unregistered tool", () => {
      expect(registry.getMetadata("ghost")).toBeUndefined();
    });

    it("exposes a read-only metadata map", () => {
      const tool = createMockTool("map_tool");
      registry.register(tool, createMetadata());

      const map = registry.getMetadataMap();
      expect(map.get("map_tool")).toBeDefined();
      expect(map.size).toBe(1);
    });
  });

  // ========================================================================
  // Category Filtering
  // ========================================================================

  describe("getToolsByCategory", () => {
    it("returns tools belonging to a specific category", () => {
      registry.register(createMockTool("git1"), { category: ToolCategories.GIT });
      registry.register(createMockTool("git2"), { category: ToolCategories.GIT });
      registry.register(createMockTool("file1"), { category: ToolCategories.FILE });

      const gitTools = registry.getToolsByCategory(ToolCategories.GIT);
      expect(gitTools).toHaveLength(2);
      expect(gitTools.map((t) => t.name).sort()).toEqual(["git1", "git2"]);
    });

    it("returns empty array for category with no tools", () => {
      expect(registry.getToolsByCategory(ToolCategories.BROWSER)).toEqual([]);
    });
  });

  // ========================================================================
  // Dangerous / Read-Only Filtering
  // ========================================================================

  describe("getDangerousTools", () => {
    it("returns only tools marked as dangerous", () => {
      registry.register(createMockTool("safe"), { category: "code", dangerous: false });
      registry.register(createMockTool("risky"), { category: "code", dangerous: true });

      const dangerous = registry.getDangerousTools();
      expect(dangerous).toHaveLength(1);
      expect(dangerous[0]!.name).toBe("risky");
    });
  });

  describe("getReadOnlyTools", () => {
    it("returns tools that are read-only", () => {
      registry.register(createMockTool("reader"), { category: "code", readOnly: true });
      registry.register(createMockTool("writer"), { category: "code", readOnly: false });

      const readOnly = registry.getReadOnlyTools();
      expect(readOnly).toHaveLength(1);
      expect(readOnly[0]!.name).toBe("reader");
    });

    it("treats tools without metadata as read-only by default", () => {
      registry.register(createMockTool("bare"));

      const readOnly = registry.getReadOnlyTools();
      expect(readOnly).toHaveLength(1);
    });
  });

  // ========================================================================
  // getAllTools / getToolNames / count
  // ========================================================================

  describe("collection accessors", () => {
    it("getAllTools returns all registered tools", () => {
      registry.register(createMockTool("a"), createMetadata());
      registry.register(createMockTool("b"), createMetadata());

      expect(registry.getAllTools()).toHaveLength(2);
    });

    it("getToolNames returns names in insertion order", () => {
      registry.register(createMockTool("alpha"), createMetadata());
      registry.register(createMockTool("beta"), createMetadata());

      expect(registry.getToolNames()).toEqual(["alpha", "beta"]);
    });

    it("count returns the number of tools", () => {
      expect(registry.count).toBe(0);
      registry.register(createMockTool("one"), createMetadata());
      expect(registry.count).toBe(1);
    });
  });

  // ========================================================================
  // getAvailableToolNames
  // ========================================================================

  describe("getAvailableToolNames", () => {
    it("excludes tools where available is false", () => {
      registry.register(createMockTool("vis"), { category: "code", available: true });
      registry.register(createMockTool("hid"), { category: "code", available: false });

      expect(registry.getAvailableToolNames()).toEqual(["vis"]);
    });
  });

  // ========================================================================
  // getToolInventory
  // ========================================================================

  describe("getToolInventory", () => {
    it("returns inventory entries for every tool", () => {
      registry.register(createMockTool("inv_tool"), {
        category: ToolCategories.SHELL,
        dangerous: true,
        readOnly: false,
      });

      const inventory = registry.getToolInventory();
      expect(inventory).toHaveLength(1);
      expect(inventory[0]!.name).toBe("inv_tool");
      expect(inventory[0]!.type).toBe("shell");
      expect(inventory[0]!.dangerous).toBe(true);
    });

    it("defaults category/type to 'custom'/'builtin' when metadata is absent", () => {
      registry.register(createMockTool("no_meta"));

      const entry = registry.getToolInventory()[0]!;
      expect(entry.category).toBe("custom");
      expect(entry.type).toBe("builtin");
    });
  });

  // ========================================================================
  // Dynamic Registration / Unregistration
  // ========================================================================

  describe("unregister", () => {
    it("removes a registered tool and returns true", () => {
      registry.register(createMockTool("rm_me"), { category: ToolCategories.CODE });

      expect(registry.unregister("rm_me")).toBe(true);
      expect(registry.has("rm_me")).toBe(false);
      expect(registry.getMetadata("rm_me")).toBeUndefined();
      expect(registry.getToolsByCategory(ToolCategories.CODE)).toHaveLength(0);
    });

    it("returns false when tool does not exist", () => {
      expect(registry.unregister("ghost")).toBe(false);
    });

    it("removes tool without metadata gracefully", () => {
      registry.register(createMockTool("bare_rm"));
      expect(registry.unregister("bare_rm")).toBe(true);
    });
  });

  describe("registerOrUpdate", () => {
    it("registers a new tool when none exists", () => {
      const tool = createMockTool("fresh");
      registry.registerOrUpdate(tool, createMetadata());

      expect(registry.has("fresh")).toBe(true);
    });

    it("replaces an existing tool without throwing", () => {
      const v1 = createMockTool("evolve");
      const v2 = createMockTool("evolve");
      (v2 as { description: string }).description = "version 2";

      registry.registerOrUpdate(v1, createMetadata());
      registry.registerOrUpdate(v2, { category: ToolCategories.SHELL });

      expect(registry.get("evolve")!.description).toBe("version 2");
      expect(registry.getMetadata("evolve")!.category).toBe("shell");
    });
  });

  // ========================================================================
  // createFiltered
  // ========================================================================

  describe("createFiltered", () => {
    it("returns a new registry with only the allowed tools", () => {
      registry.register(createMockTool("keep"), { category: ToolCategories.FILE });
      registry.register(createMockTool("drop"), { category: ToolCategories.GIT });

      const filtered = registry.createFiltered(["keep"]);

      expect(filtered.count).toBe(1);
      expect(filtered.has("keep")).toBe(true);
      expect(filtered.has("drop")).toBe(false);
    });

    it("silently ignores names that do not exist", () => {
      registry.register(createMockTool("real"), createMetadata());

      const filtered = registry.createFiltered(["real", "imaginary"]);
      expect(filtered.count).toBe(1);
    });
  });

  // ========================================================================
  // execute
  // ========================================================================

  describe("execute", () => {
    it("delegates to the tool's execute method", async () => {
      const tool = createMockTool("exec_tool");
      registry.register(tool, createMetadata());

      const ctx = { workingDirectory: "/tmp" } as unknown as ToolContext;
      const result = await registry.execute("exec_tool", { arg: 1 }, ctx);

      expect(result.content).toBe("executed exec_tool");
      expect(tool.execute).toHaveBeenCalledWith({ arg: 1 }, ctx);
    });

    it("returns an error result when the tool is not found", async () => {
      const ctx = { workingDirectory: "/tmp" } as unknown as ToolContext;
      const result = await registry.execute("missing", {}, ctx);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  // ========================================================================
  // clear
  // ========================================================================

  describe("clear", () => {
    it("removes all tools, metadata, and categories", () => {
      registry.register(createMockTool("a"), { category: ToolCategories.FILE });
      registry.register(createMockTool("b"), { category: ToolCategories.GIT });
      registry.clear();

      expect(registry.count).toBe(0);
      expect(registry.getAllTools()).toEqual([]);
      expect(registry.getToolsByCategory(ToolCategories.FILE)).toEqual([]);
    });
  });

  // ========================================================================
  // Strada.MCP runtime status (null when not loaded)
  // ========================================================================

  describe("getStradaMcpRuntimeStatus", () => {
    it("returns null when no MCP runtime is loaded", () => {
      expect(registry.getStradaMcpRuntimeStatus()).toBeNull();
    });
  });
});
