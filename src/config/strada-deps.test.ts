import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkStradaDeps, installStradaDep, installStradaMcpSubmodule } from "./strada-deps.js";

const TEST_STRADA_CONFIG = {
  coreRepoUrl: "https://example.com/Strada.Core.git",
  modulesRepoUrl: "https://example.com/Strada.Modules.git",
  mcpRepoUrl: "https://example.com/Strada.MCP.git",
};

describe("checkStradaDeps", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `strada-deps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns coreInstalled: false when Packages/ does not exist", () => {
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(false);
    expect(result.modulesInstalled).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Packages/");
  });

  it("returns coreInstalled: false when Packages/ exists but no strada packages", () => {
    mkdirSync(join(testDir, "Packages"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(false);
    expect(result.corePath).toBeNull();
    expect(result.modulesInstalled).toBe(false);
    expect(result.modulesPath).toBeNull();
  });

  it("detects strada.core directory", () => {
    mkdirSync(join(testDir, "Packages", "strada.core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(true);
    expect(result.corePath).toBe(join(testDir, "Packages", "strada.core"));
  });

  it("detects com.strada.core directory", () => {
    mkdirSync(join(testDir, "Packages", "com.strada.core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(true);
    expect(result.corePath).toBe(join(testDir, "Packages", "com.strada.core"));
  });

  it("detects Strada.Core directory (PascalCase)", () => {
    // On case-insensitive filesystems (macOS), the first matching name
    // in CORE_NAMES search order wins, so we only check coreInstalled
    mkdirSync(join(testDir, "Packages", "Strada.Core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(true);
    expect(result.corePath).not.toBeNull();
  });

  it("detects strada.modules directory", () => {
    mkdirSync(join(testDir, "Packages", "strada.core"), { recursive: true });
    mkdirSync(join(testDir, "Packages", "strada.modules"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.modulesInstalled).toBe(true);
    expect(result.modulesPath).toBe(join(testDir, "Packages", "strada.modules"));
  });

  it("detects core via manifest.json fallback", () => {
    mkdirSync(join(testDir, "Packages"), { recursive: true });
    writeFileSync(
      join(testDir, "Packages", "manifest.json"),
      JSON.stringify({
        dependencies: {
          "com.strada.core": "https://github.com/okandemirel/Strada.Core.git",
        },
      }),
    );
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(true);
    expect(result.corePath).toBeNull(); // manifest-only detection has no path
  });

  it("produces no core warning when core is installed", () => {
    mkdirSync(join(testDir, "Packages", "strada.core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.warnings.some((w) => w.includes("Strada.Core not found"))).toBe(false);
  });

  it("produces modules warning when modules is not installed", () => {
    mkdirSync(join(testDir, "Packages", "strada.core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.warnings.some((w) => w.includes("Strada.Modules"))).toBe(true);
  });

  it("detects Strada.MCP from configured path", () => {
    const mcpDir = join(testDir, "custom-mcp");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(
      join(mcpDir, "package.json"),
      JSON.stringify({ name: "strada-mcp", version: "1.2.3" }),
    );

    const result = checkStradaDeps(testDir, {
      ...TEST_STRADA_CONFIG,
      mcpPath: mcpDir,
    });

    expect(result.mcpInstalled).toBe(true);
    expect(result.mcpPath).toBe(mcpDir);
    expect(result.mcpVersion).toBe("1.2.3");
  });

  it("detects a project-local Strada.MCP install inside Packages/Submodules", () => {
    const localMcpDir = join(testDir, "Packages", "Submodules", "Strada.MCP");
    mkdirSync(localMcpDir, { recursive: true });
    writeFileSync(
      join(localMcpDir, "package.json"),
      JSON.stringify({ name: "strada-mcp", version: "2.0.0" }),
    );

    const result = checkStradaDeps(testDir, TEST_STRADA_CONFIG);

    expect(result.mcpInstalled).toBe(true);
    expect(result.mcpPath).toBe(localMcpDir);
    expect(result.mcpVersion).toBe("2.0.0");
  });

  it("warns when configured STRADA_MCP_PATH is invalid", () => {
    const invalidMcpDir = join(testDir, "invalid-mcp");
    mkdirSync(invalidMcpDir, { recursive: true });
    writeFileSync(
      join(invalidMcpDir, "package.json"),
      JSON.stringify({ name: "not-strada-mcp", version: "1.0.0" }),
    );

    const result = checkStradaDeps(testDir, {
      ...TEST_STRADA_CONFIG,
      mcpPath: invalidMcpDir,
    });

    expect(result.warnings).toContain(
      "Configured STRADA_MCP_PATH is not a valid Strada.MCP package root",
    );
  });
});

describe("installStradaDep", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `strada-deps-install-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns err when project is not a git repo", async () => {
    const result = await installStradaDep(testDir, "core");
    expect(result.kind).toBe("err");
    expect(result.kind === "err" && result.error).toContain("not a git repository");
  });

  it("returns err when installing Strada.MCP into a project that is not a git repo", async () => {
    const result = await installStradaMcpSubmodule(testDir, "packages", TEST_STRADA_CONFIG);
    expect(result.kind).toBe("err");
    expect(result.kind === "err" && result.error).toContain("not a git repository");
  });
});
