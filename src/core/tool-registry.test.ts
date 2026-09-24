import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { createLogger } from "../utils/logger.js";
import {
  ToolRegistry,
  ToolCategories,
  classifyRuntimeToolMetadata,
  type ToolCategory,
  type ToolMetadata,
} from "./tool-registry.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";
import { ValidationError } from "../common/errors.js";
import { WRITE_OPERATIONS } from "../common/constants.js";
import { WRITE_TOOLS } from "../security/read-only-guard.js";
import type { VaultRegistry } from "../vault/vault-registry.js";

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

  // initialize() logs; the logger is a process-wide singleton that tests must
  // set up explicitly.
  beforeAll(() => {
    createLogger("error", "test.log");
  });

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ========================================================================
  // SHELL_ENABLED gating
  // ========================================================================

  describe("shell_exec gating on SHELL_ENABLED", () => {
    /** Minimal config stand-in — initialize() only reads `shellEnabled` here,
     *  and its MCP/plugin steps degrade to no-ops without further fields. */
    function configWith(shellEnabled: boolean) {
      return { shellEnabled } as unknown as Parameters<ToolRegistry["initialize"]>[0];
    }

    it("registers shell_exec when SHELL_ENABLED is true", async () => {
      const r = new ToolRegistry();
      await r.initialize(configWith(true));
      expect(r.has("shell_exec")).toBe(true);
    });

    it("does NOT register shell_exec when SHELL_ENABLED is false", async () => {
      // Regression guard: the flag was parsed into config and then read by
      // nobody, so an operator who disabled shell execution still got a
      // fully-registered arbitrary-command tool.
      const r = new ToolRegistry();
      await r.initialize(configWith(false));
      expect(r.has("shell_exec")).toBe(false);
    });

    it("still registers other tools when shell is disabled", async () => {
      const r = new ToolRegistry();
      await r.initialize(configWith(false));
      // Disabling shell must not disable the rest of the toolset.
      expect(r.getAvailableToolNames().length).toBeGreaterThan(5);
    });
  });

  // ========================================================================
  // git_branch mutates the working tree — it must classify as a write
  // ========================================================================

  describe("git_branch write classification (audited 2026-09-02)", () => {
    it("registers git_branch as a non-read-only, dangerous tool like git_commit", async () => {
      // git_branch runs `git checkout [-b] <name>`, which rewrites every
      // tracked file on disk. It was registered readOnly:true, so it stayed
      // offered in write-disabled phases, skipped the write-confirmation and
      // plan-review gates, and was dispatched in the PARALLEL group beside
      // file_read/grep — a checkout mid-read returns a mix of two branches.
      const r = new ToolRegistry();
      await r.initialize({ shellEnabled: false } as unknown as Parameters<ToolRegistry["initialize"]>[0]);
      const meta = r.getMetadata("git_branch");
      expect(meta).toBeDefined();
      expect(meta!.readOnly).toBe(false);
      expect(meta!.dangerous).toBe(true);
      expect(meta!.requiresConfirmation).toBe(true);
      expect(r.getReadOnlyTools().some((t) => t.name === "git_branch")).toBe(false);
    });

    it("is in the name-based WRITE_OPERATIONS allowlist so every policy layer agrees", () => {
      // The interaction policy's plan-review write block keys on this set by
      // NAME, independent of registry metadata; both sources must agree. It is
      // also the first test in isParallelSafeToolCall, so membership here is
      // what keeps a checkout out of the leading parallel group.
      expect(WRITE_OPERATIONS.has("git_branch")).toBe(true);
    });

    it("offers branch LISTING as its own read-only tool (audited 2026-09-02)", async () => {
      // Classifying the whole tool as a write was right for create/checkout and
      // wrong for list: `git branch -a --format=…` touches nothing, yet listing
      // vanished from write-disabled phases and every list went to the approval
      // queue. The read half is registered separately instead.
      const r = new ToolRegistry();
      await r.initialize({ shellEnabled: false } as unknown as Parameters<ToolRegistry["initialize"]>[0]);
      const meta = r.getMetadata("git_branch_list");
      expect(meta, "git_branch_list is registered").toBeDefined();
      expect(meta!.readOnly).toBe(true);
      expect(meta!.dangerous).toBe(false);
      expect(meta!.requiresConfirmation).toBeFalsy();
      expect(r.getReadOnlyTools().some((t) => t.name === "git_branch_list")).toBe(true);
      // …and it must not be dragged into the write allowlist with its sibling,
      // which would put it right back in the approval queue.
      expect(WRITE_OPERATIONS.has("git_branch_list")).toBe(false);
    });
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

  // ========================================================================
  // READ_ONLY_MODE is enforced by metadata, not only by a name list
  // ========================================================================

  describe("READ_ONLY_MODE enforced by tool metadata", () => {
    const vaultRegistry = {
      get: vi.fn(),
      list: vi.fn(() => []),
      resolveVaultForPath: vi.fn(),
    } as unknown as VaultRegistry;
    const readOnlyContext = {
      projectPath: "/test/project",
      workingDirectory: "/test/project",
      readOnly: true,
    } as ToolContext;

    function configWith(readOnlyMode: boolean) {
      return { shellEnabled: true, security: { readOnlyMode } } as unknown as Parameters<
        ToolRegistry["initialize"]
      >[0];
    }

    async function initialized(readOnlyMode: boolean): Promise<ToolRegistry> {
      const r = new ToolRegistry();
      await r.initialize(configWith(readOnlyMode), { vaultRegistry });
      await r.waitForRegistrations();
      return r;
    }

    it("withholds every tool whose metadata is not read-only and refuses it at dispatch", async () => {
      const full = await initialized(false);
      const readOnly = await initialized(true);

      const writers = full.getToolNames().filter((name) => full.getMetadata(name)?.readOnly !== true);
      // The writers the old name list missed are among them.
      expect(writers).toContain("vault_write_note");
      expect(writers).toContain("obsidian_append");

      const offered = readOnly.getAllTools().map((t) => t.name);
      for (const name of writers) {
        expect(offered, `${name} is offered in read-only mode`).not.toContain(name);
        const result = await readOnly.execute(name, { path: "notes/x.md", content: "x" }, readOnlyContext);
        expect(result.isError, `${name} ran in read-only mode`).toBe(true);
        expect(result.content).toContain("read-only mode");
      }
    });

    it("keeps the genuinely read-only tools, and the name list still blocks what it names", async () => {
      const full = await initialized(false);
      const readOnly = await initialized(true);

      const expected = full
        .getToolNames()
        .filter((name) => full.getMetadata(name)?.readOnly === true && !WRITE_TOOLS.has(name));
      expect(readOnly.getToolNames().sort()).toEqual(expected.sort());
      for (const name of [
        "file_read", "glob_search", "grep_search", "list_directory",
        "vault_search", "vault_status", "vault_graph_explore", "obsidian_search",
        "git_status", "git_log", "git_diff", "git_branch_list",
      ]) {
        expect(readOnly.has(name), `${name} was withheld`).toBe(true);
      }
      // dotnet_build is registered read-only but writes bin/ and obj/.
      expect(readOnly.has("dotnet_build")).toBe(false);
    });

    it("does not trust omitted or guessed read-only metadata", async () => {
      const r = new ToolRegistry();
      await r.initialize(configWith(true));

      const guessed = createMockTool("plugin_guessed_reader");
      const declared: ITool = {
        ...createMockTool("plugin_declared_reader"),
        metadata: { isReadOnly: true } as unknown as ITool["metadata"],
      };
      r.register(guessed, classifyRuntimeToolMetadata(guessed, "custom"));
      r.register(declared, classifyRuntimeToolMetadata(declared, "custom"));
      r.register(createMockTool("bare_tool"));
      r.register(createMockTool("partial_tool"), { category: ToolCategories.CODE });

      expect(r.has("plugin_guessed_reader")).toBe(false);
      expect(r.has("plugin_declared_reader")).toBe(true);
      expect(r.has("bare_tool")).toBe(false);
      expect(r.has("partial_tool")).toBe(false);
    });

    it("changes nothing when read-only mode is off", async () => {
      const r = new ToolRegistry();
      await r.initialize(configWith(false));
      r.register(createMockTool("bare_tool"));
      expect(r.has("bare_tool")).toBe(true);
      expect(r.has("file_write")).toBe(true);
    });
  });
});
