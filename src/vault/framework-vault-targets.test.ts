import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { frameworkVaultTargets } from "./framework-vault-targets.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";

const deps = (over: Partial<StradaDepsStatus> = {}): StradaDepsStatus =>
  ({
    coreInstalled: true,
    corePath: "/repos/Strada.Core",
    modulesInstalled: true,
    modulesPath: "/repos/Strada.Modules",
    mcpInstalled: true,
    mcpPath: "/repos/Strada.MCP",
    mcpVersion: "1.0.0",
    warnings: [],
    ...over,
  }) as StradaDepsStatus;

describe("which codebases get indexed", () => {
  it("covers the frameworks a plan is written against, and this system itself", () => {
    const names = frameworkVaultTargets(deps(), "/repos/Strada.Brain").map((t) => t.name);

    expect(names).toEqual(["Strada.Brain", "Strada.Core", "Strada.Modules", "Strada.MCP"]);
  });

  it("skips a package that is not installed", () => {
    // The path is still recorded — that is the real shape of "not installed",
    // and nulling it too would let the install flag go unchecked.
    const targets = frameworkVaultTargets(
      deps({ modulesInstalled: false, modulesPath: "/repos/Strada.Modules" }),
      "/repos/Strada.Brain",
    );

    expect(targets.map((t) => t.name)).not.toContain("Strada.Modules");
  });

  it("indexes a shared folder once", () => {
    // A submodule copy and its standalone repo can resolve to the same path;
    // indexing it twice doubles the work and splits the results.
    const targets = frameworkVaultTargets(
      deps({ corePath: "/repos/shared", mcpPath: "/repos/shared/" }),
      "/repos/Strada.Brain",
    );

    expect(targets.filter((t) => t.rootPath === "/repos/shared")).toHaveLength(1);
  });

  it("survives a boot with no framework information at all", () => {
    expect(frameworkVaultTargets(undefined, undefined)).toEqual([]);
    expect(frameworkVaultTargets(undefined, "  ")).toEqual([]);
  });

  it("is what bootstrap actually registers", () => {
    // The selection is worth nothing unless boot loops over it. Slice the
    // registration block rather than the file: a mention in a comment would
    // pass while nothing was registered.
    const source = readFileSync("src/core/bootstrap.ts", "utf8");
    const at = source.indexOf("frameworkVaultTargets(");
    const block = source.slice(at, at + 900);

    expect(at, "bootstrap never asks which codebases to index").toBeGreaterThan(-1);
    expect(block).toContain("vaultRegistry.register(vault, target.name)");
    expect(block, "a vault that is never initialised indexes nothing").toContain("vault.init()");
  });

  it("does not register a path that is not on disk", () => {
    const source = readFileSync("src/core/bootstrap.ts", "utf8");
    const at = source.indexOf("frameworkVaultTargets(");
    const block = source.slice(at, at + 900);

    expect(block).toContain("existsSync(target.rootPath)");
  });

  it("does not take this system's root from the working directory", () => {
    // Startup chdirs the process to the Strada home, so cwd is ~/.strada.
    // Measured 2026-08-22: the vault registered as "Strada.Brain" built a 30MB
    // index of the config directory and none of this system's source.
    const source = readFileSync("src/core/bootstrap.ts", "utf8");
    const at = source.indexOf("frameworkVaultTargets(");
    const call = source.slice(source.lastIndexOf("\n", at - 400), at + 120);

    expect(call).not.toContain("frameworkVaultTargets(stradaDeps, process.cwd())");
    expect(call).toContain("installRoot");
  });
});
