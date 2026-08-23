import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import { loadInstalledStradaMcpTools, registerStradaMcpTools } from "./strada-mcp-tool-loader.js";

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
