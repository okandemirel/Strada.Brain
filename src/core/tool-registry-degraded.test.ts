/**
 * What a session says when it comes up without its Unity tools.
 *
 * Measured 2026-08-23: a Unity project whose vendored Strada.MCP had never had
 * `npm install` run in it threw "Cannot find package 'zod'" during registry
 * initialization. The run continued with none of the 108 Unity tools — no scene
 * build, no play-mode verification, no Asset Store lookup — and the only record
 * was a single logger.warn among 847 info lines. Two runs died that way before
 * anyone read the line.
 *
 * A capability the user is entitled to expect cannot go missing quietly. The
 * notice is the mechanism that already carries "daemon disabled" and "provider
 * failed preflight" to the boot report and the first message; this puts the
 * Unity toolchain on it too.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "./tool-registry.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try {
    createLogger("error", "/tmp/strada-tool-registry-degraded.log");
  } catch {
    // Already initialized by another suite in this worker; that is fine.
  }
});

/**
 * A config that points the MCP loader at a path that cannot load, which is what
 * a vendored submodule with no node_modules amounts to.
 */
const configWithBrokenMcp = () =>
  ({
    unity: { projectPath: "/nonexistent/project/that/cannot/resolve" },
    stradaMcp: { path: "/nonexistent/project/that/cannot/resolve/Packages/Submodules/Strada.MCP" },
  }) as never;

describe("a registry that cannot load the Unity toolchain", () => {
  it("does not throw — a broken submodule must not take the session down", async () => {
    const registry = new ToolRegistry();

    await expect(
      registry.initialize(configWithBrokenMcp(), { onDegraded: vi.fn() }),
    ).resolves.not.toThrow();
  });

  it("still registers the built-in tools it does have", async () => {
    const registry = new ToolRegistry();
    await registry.initialize(configWithBrokenMcp(), { onDegraded: vi.fn() });

    expect(registry.getAllTools().length).toBeGreaterThan(0);
  });

  it("survives a caller that never passed a notice sink", async () => {
    const registry = new ToolRegistry();

    await expect(registry.initialize(configWithBrokenMcp())).resolves.not.toThrow();
  });
});

describe("the notice a broken toolchain produces", () => {
  /** Drives the catch branch directly: the loader is what throws in production. */
  const degradeWith = async (message: string): Promise<string[]> => {
    vi.resetModules();
    vi.doMock("./strada-mcp-tool-loader.js", () => ({
      loadInstalledStradaMcpRuntime: () => Promise.reject(new Error(message)),
      registerStradaMcpTools: () => ({ registered: 0, skipped: 0, shadowed: [] }),
    }));
    // resetModules gives the fresh graph its own logger singleton, which starts
    // out uninitialized.
    const freshLogger = await import("../utils/logger.js");
    try {
      freshLogger.createLogger("error", "/tmp/strada-tool-registry-degraded.log");
    } catch {
      // Already initialized in this graph.
    }
    const { ToolRegistry: Fresh } = await import("./tool-registry.js");
    const notices: string[] = [];
    await new Fresh().initialize(configWithBrokenMcp(), {
      onDegraded: (n: string) => notices.push(n),
    });
    vi.doUnmock("./strada-mcp-tool-loader.js");
    return notices;
  };

  it("names the capabilities that are gone, not just the error", async () => {
    const [notice] = await degradeWith("Cannot find package 'zod'");

    expect(notice).toBeDefined();
    expect(notice).toContain("Unity toolchain unavailable");
    expect(notice).toContain("play-mode verification");
    expect(notice).toContain("Asset Store");
  });

  it("carries the underlying cause through, so it can be acted on", async () => {
    const [notice] = await degradeWith("Cannot find package 'zod'");

    expect(notice).toContain("Cannot find package 'zod'");
  });

  it("says what to actually do about it", async () => {
    const [notice] = await degradeWith("Cannot find package 'zod'");

    expect(notice).toContain("npm install");
    expect(notice).toContain("Packages/Submodules/Strada.MCP");
  });
});
