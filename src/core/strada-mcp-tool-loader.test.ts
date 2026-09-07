import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import { pathKey, fileBasedAlternative, loadInstalledStradaMcpTools, projectPathEscape, registerStradaMcpTools } from "./strada-mcp-tool-loader.js";
import { symlinkSync, realpathSync } from "node:fs";
import type { ITool, ToolContext } from "../agents/tools/tool-core.interface.js";

describe("registerStradaMcpTools", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("registers unique Strada.MCP tools into the main toolchain", () => {
    const register = vi.fn();
    const registry = {
      has: vi.fn().mockReturnValue(false),
      register,
    };

    const result = registerStradaMcpTools(registry, [
      {
        name: "unity_scene_info",
        description: "Get scene info",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          category: "unity-scene",
          requiresBridge: false,
          dangerous: false,
          readOnly: true,
        },
        execute: vi.fn(),
      },
    ]);

    expect(result).toEqual({ registered: 1, skipped: 0, shadowed: [] });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[1]).toMatchObject({
      category: "custom",
      dangerous: false,
      readOnly: true,
      dependencies: ["strada-mcp"],
      requiresBridge: false,
    });
  });

  it("propagates bridge requirements into Brain tool metadata", () => {
    const register = vi.fn();
    const registry = {
      has: vi.fn().mockReturnValue(false),
      register,
    };

    registerStradaMcpTools(registry, [
      {
        name: "unity_live_scene",
        description: "Reads live Unity scene data",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          category: "unity-scene",
          requiresBridge: true,
          dangerous: false,
          readOnly: true,
        },
        execute: vi.fn(),
      },
    ]);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[1]).toMatchObject({
      requiresBridge: true,
    });
  });

  it("skips tool names that already exist in the registry", () => {
    const registry = {
      has: vi.fn().mockReturnValue(true),
      register: vi.fn(),
    };

    const result = registerStradaMcpTools(registry, [
      {
        name: "file_read",
        description: "Read file",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          category: "file",
          requiresBridge: false,
          dangerous: false,
          readOnly: true,
        },
        execute: vi.fn(),
      },
    ]);

    expect(result).toEqual({ registered: 0, skipped: 1, shadowed: ["file_read"] });
    expect(registry.register).not.toHaveBeenCalled();
  });

  it("loads source-only Strada.MCP installs through tsx when dist is missing", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "strada-mcp-source-"));
    tempDirs.push(pkgRoot);
    mkdirSync(join(pkgRoot, "src", "tools"), { recursive: true });
    mkdirSync(join(pkgRoot, "src", "security"), { recursive: true });

    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({
      name: "strada-mcp",
      version: "1.0.0",
      type: "module",
    }));
    writeFileSync(
      join(pkgRoot, "src", "tools", "tool-registry.ts"),
      `export class ToolRegistry {
  tools = [];
  register(tool) { this.tools.push(tool); }
}
`,
    );
    writeFileSync(
      join(pkgRoot, "src", "security", "path-guard.ts"),
      `export function parseAllowedPaths(input) {
  return Array.isArray(input) ? input : [String(input)];
}
`,
    );
    writeFileSync(
      join(pkgRoot, "src", "bootstrap.ts"),
      `import { ToolRegistry } from "./tools/tool-registry.js";
import { parseAllowedPaths } from "./security/path-guard.js";

export function bootstrap(options) {
  const localRegistry = new ToolRegistry();
  void localRegistry;
  parseAllowedPaths(options.config.allowedPaths);
  return {
    tools: [{
      name: "mcp_echo",
      description: "Echo from source-only MCP",
      inputSchema: { type: "object", properties: {} },
      metadata: {
        category: "analysis",
        requiresBridge: false,
        dangerous: false,
        readOnly: true,
      },
      async execute() {
        return { content: "ok" };
      },
    }],
  };
}
`,
    );

    const config = {
      unityProjectPath: "/tmp/project",
      security: { readOnlyMode: true },
      strada: { mcpPath: pkgRoot },
    } as Config;

    const result = await loadInstalledStradaMcpTools(config);

    expect(result?.source.path).toBe(pkgRoot);
    expect(result?.tools).toHaveLength(1);
    expect(result?.tools[0]?.name).toBe("mcp_echo");
  });
});

/**
 * A count is not a finding.
 *
 * "skipped: 22" was the only record of which MCP tools never reached the agent.
 * Tracing one of them — unity_my_assets, which a run had never called — meant
 * reading the loader, the registry and the built-in list by hand to establish
 * that it had in fact been available all along. The names distinguish "never
 * offered" from "offered and ignored", and those have opposite fixes.
 */
describe("what the loader reports about tools it dropped", () => {
  const shadowedTool = (name: string) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    metadata: {
      category: "file" as const,
      requiresBridge: false,
      dangerous: false,
      readOnly: true,
    },
    execute: vi.fn(),
  });

  it("names every tool that lost to a built-in, in order", () => {
    const registry = {
      has: vi.fn((name: string) => name !== "unity_my_assets"),
      register: vi.fn(),
    };

    const result = registerStradaMcpTools(registry, [
      shadowedTool("file_read"),
      shadowedTool("unity_my_assets"),
      shadowedTool("file_write"),
    ]);

    expect(result.shadowed).toEqual(["file_read", "file_write"]);
    expect(result.registered).toBe(1);
  });

  it("keeps the count and the names agreeing", () => {
    const registry = {
      has: vi.fn().mockReturnValue(true),
      register: vi.fn(),
    };

    const result = registerStradaMcpTools(registry, [
      shadowedTool("a"),
      shadowedTool("b"),
      shadowedTool("c"),
    ]);

    expect(result.skipped).toBe(result.shadowed.length);
    expect(result.skipped).toBe(3);
  });
});

/**
 * Measured 2026-09-07 (campaign mcov1, attempt 2): refused six times by the
 * path guard for reading the real checkout, a sub-agent passed that checkout
 * as projectPath to unity_playmode_verify and verified a tree without the
 * run's edits — reported as "the game renders in the real project path".
 */
describe("a projectPath outside the run's project is refused, not noted", () => {
  const lease = "/tmp/strada-workspaces/task-1";
  const real = "/Users/someone/Game";
  const context = (over: Partial<ToolContext> = {}): ToolContext =>
    ({ projectPath: lease, sourceProjectPath: real, workingDirectory: lease, readOnly: false, ...over }) as ToolContext;

  function registeredTool(execute: ReturnType<typeof vi.fn>): ITool {
    let tool: ITool | undefined;
    const registry = {
      has: vi.fn().mockReturnValue(false),
      register: vi.fn((t: ITool) => { tool = t; }),
    };
    registerStradaMcpTools(registry, [
      {
        name: "unity_playmode_verify",
        description: "verify",
        inputSchema: { type: "object", properties: {} },
        metadata: { category: "unity", requiresBridge: false, dangerous: false, readOnly: true },
        execute,
      },
    ]);
    if (!tool) throw new Error("not registered");
    return tool;
  }

  it("redirects the real checkout to the lease, runs there, and says so", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    const result = await registeredTool(execute).execute({ projectPath: real, other: 1 }, context());
    expect(result.isError).toBeFalsy();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ projectPath: lease, other: 1 });
    expect(result.content).toContain("is the real checkout");
    expect(result.content).toContain(`ran against ${lease}`);
    expect(result.content).toContain("WITH this run's edits");
    expect(result.content).toContain("ran");
  });

  it("redirects a subtree of the real checkout to the same subtree of the lease", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    await registeredTool(execute).execute({ projectPath: `${real}/Assets/Scenes` }, context());
    expect(execute.mock.calls[0]?.[0]).toEqual({ projectPath: `${lease}/Assets/Scenes` });
  });

  // Codex review (gpt-6-astra, 2026-09-07): containment was lexical.
  it("a symlink inside the lease that points at the real checkout is refused, not redirected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strada-lease-link-"));
    try {
      const realDir = join(dir, "Game");
      const leaseDir = join(dir, "lease");
      mkdirSync(join(realDir, "Assets"), { recursive: true });
      mkdirSync(leaseDir, { recursive: true });
      symlinkSync(realDir, join(leaseDir, "Linked"));
      const ctx = { projectPath: leaseDir, sourceProjectPath: realDir };
      // The lease's own link, named directly, resolves to the real tree — so
      // it is the real checkout, and runs against the lease root instead.
      const direct = projectPathEscape({ projectPath: join(leaseDir, "Linked") }, ctx);
      expect(direct !== undefined && "redirect" in direct && direct.redirect === leaseDir).toBe(true);
      // The real checkout's twin path in the lease is the link — refused too.
      const twin = projectPathEscape({ projectPath: join(realDir, "Linked") }, ctx);
      expect(twin !== undefined && "refuse" in twin && /through a link/.test(twin.refuse)).toBe(true);
      // A plain subtree of the real checkout still redirects.
      const plain = projectPathEscape({ projectPath: join(realDir, "Assets") }, ctx);
      expect(plain !== undefined && "redirect" in plain && plain.redirect === join(leaseDir, "Assets")).toBe(true);
      // A symlinked LEASE root (macOS /var → /private/var) is still the lease.
      const viaLink = projectPathEscape({ projectPath: join(realpathSync(leaseDir), "Assets") }, ctx);
      expect(viaLink).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canonical paths fold case on case-insensitive platforms and keep it on linux", () => {
    expect(pathKey("/Games/GAME/x", "win32")).toBe(pathKey("/games/game/X", "win32"));
    expect(pathKey("/Games/GAME/x", "linux")).not.toBe(pathKey("/games/game/X", "linux"));
  });

  it("a bridge refusal for a scene-composition tool names the file-based tool", () => {
    expect(fileBasedAlternative("unity_create_gameobject")).toContain("unity_place_prefab");
    expect(fileBasedAlternative("unity_create_gameobject")).toContain("unity_bind_sprite");
    expect(fileBasedAlternative("unity_add_component")).toContain("unity_bind_sprite");
    expect(fileBasedAlternative("unity_build_pipeline")).toBe("");
  });

  it("refuses any other tree too, without the lease wording", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    const result = await registeredTool(execute).execute({ projectPath: "/elsewhere/Other" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("WITHOUT this run's edits");
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets the run's own project and its subtrees through, and an omitted path", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    const tool = registeredTool(execute);
    await tool.execute({ projectPath: lease }, context());
    await tool.execute({ projectPath: `${lease}/Assets` }, context());
    await tool.execute({}, context());
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
