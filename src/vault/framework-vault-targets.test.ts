import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { frameworkVaultTargets } from "./framework-vault-targets.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import { UnityProjectVault } from "./unity-project-vault.js";
import { createFakeEmbedding, createFakeVectorStore } from "../test-helpers.js";

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
    // The selection is worth nothing unless boot hands it on. What the stage
    // does with it (register, scope, skip a missing root, index under the app
    // home) is exercised in stage-knowledge-framework-vaults.test.ts; bootstrap
    // itself cannot run in a unit test, so this checks only the hand-over.
    // Sliced from the call rather than the file: a mention in a comment would
    // pass while nothing was registered.
    const source = readFileSync("src/core/bootstrap.ts", "utf8");
    const at = source.indexOf("frameworkVaultTargets(");
    const block = source.slice(at, at + 1200);

    expect(at, "bootstrap never asks which codebases to index").toBeGreaterThan(-1);
    expect(block, "the targets never reach the stage that registers them").toMatch(
      /initFrameworkVaultsFromBootstrap\(\{\s*targets,/,
    );
    expect(block, "framework indexes must live under the app home").toMatch(
      /stateRoot: resolveStradaHomeEntry\(/,
    );
    expect(block, "the whole-repo Strada.Brain vault must stay skippable").toContain(
      't.name !== "Strada.Brain"',
    );
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

/**
 * WP-1.2: Strada.Modules got no vault unless the project had it installed, so
 * `vault_search "IScreenService ScreenBody"` found nothing while a checkout sat
 * beside the install. And a framework vault indexed its whole package folder:
 * in a measured replay 49% of the injected vault blocks were notes runs had
 * written into the vendored framework folders, not the framework.
 */
describe("framework vaults index the framework, available or installed (WP-1.2)", () => {
  const checkout = (path: string) => ({ path, source: "sibling-checkout" as const, version: "1.0.0", commit: "abc1234" });

  it("registers Strada.Modules from its checkout when the project does not have it", () => {
    const targets = frameworkVaultTargets(
      deps({ modulesInstalled: false, modulesPath: null, modulesCheckout: checkout("/work/Strada.Modules") }),
      "/repos/Strada.Brain",
    );

    expect(targets.find((t) => t.name === "Strada.Modules")).toMatchObject({
      rootPath: "/work/Strada.Modules",
      state: "available",
    });
  });

  it("prefers the copy the project compiles against over the checkout", () => {
    const targets = frameworkVaultTargets(
      deps({ coreCheckout: checkout("/work/Strada.Core"), modulesCheckout: checkout("/work/Strada.Modules") }),
      "/repos/Strada.Brain",
    );

    expect(targets.find((t) => t.name === "Strada.Core")).toMatchObject({ rootPath: "/repos/Strada.Core", state: "installed" });
    expect(targets.find((t) => t.name === "Strada.Modules")).toMatchObject({ rootPath: "/repos/Strada.Modules", state: "installed" });
  });

  it("scopes a framework vault to Runtime/, Editor/, Documentation~/ and READMEs", () => {
    const targets = frameworkVaultTargets(deps(), "/repos/Strada.Brain");
    const core = targets.find((t) => t.name === "Strada.Core")!;
    const modules = targets.find((t) => t.name === "Strada.Modules")!;
    const mcp = targets.find((t) => t.name === "Strada.MCP")!;

    for (const kept of ["Runtime/ECS/Query/QueryBuilder.cs", "Editor/Headless/SceneSpec.cs", "Documentation~/DI.md", "README.md"]) {
      expect(core.includePath?.(kept), kept).toBe(true);
    }
    for (const dropped of [
      "docs/sprint-report.md",
      "analysis/frame-budget.md",
      "notes/run-42.md",
      "plans/m3.md",
      "reports/delivery.md",
      "SecurityReports/scan.md",
      "dist/index.js",
      "Tests/Runtime/QueryTests.cs",
      "CHANGELOG.md",
    ]) {
      expect(core.includePath?.(dropped), dropped).toBe(false);
    }
    // A module package keeps its modules one level down.
    expect(modules.includePath?.("ScreenModule/Runtime/Services/IScreenService.cs")).toBe(true);
    expect(modules.includePath?.("ScreenModule/README.md")).toBe(true);
    // Strada.MCP's framework is its TypeScript source as much as its Unity package.
    expect(mcp.includePath?.("src/tools/scene/scene-build.ts")).toBe(true);
    expect(mcp.includePath?.("unity-package/com.strada.mcp/Editor/Bridge.cs")).toBe(true);
    expect(mcp.includePath?.("notes/campaign.md")).toBe(false);
    expect(mcp.includePath?.("dist/index.js")).toBe(false);
    // This system's own vault is not a framework package: no scope.
    expect(targets.find((t) => t.name === "Strada.Brain")?.includePath).toBeUndefined();
  });

  it("leaves out the run-note folders at the package root only, not a source folder of the same name", () => {
    // Measured on a real Strada.MCP checkout: the any-depth rule dropped all ten
    // sources under src/tools/analysis/ (code-quality.ts, rag-index.ts, ...).
    // Runs left their notes at the package root; a framework folder deeper down
    // that shares one of those names is the framework.
    const targets = frameworkVaultTargets(deps(), "/repos/Strada.Brain");
    const core = targets.find((t) => t.name === "Strada.Core")!;
    const modules = targets.find((t) => t.name === "Strada.Modules")!;
    const mcp = targets.find((t) => t.name === "Strada.MCP")!;

    for (const kept of ["src/tools/analysis/code-quality.ts", "src/tools/analysis/rag-index.ts", "src/reports/summary.ts", "src/docs/index.ts"]) {
      expect(mcp.includePath?.(kept), kept).toBe(true);
    }
    for (const kept of ["Runtime/Reports/ReportService.cs", "Runtime/Analysis/FrameStats.cs", "Editor/Plans/PlanWindow.cs", "Documentation~/notes/DI.md"]) {
      expect(core.includePath?.(kept), kept).toBe(true);
    }
    expect(modules.includePath?.("ScreenModule/Runtime/Docs/ScreenDocs.cs")).toBe(true);
    // At the root they are still the notes runs left behind.
    for (const dropped of ["analysis/frame-budget.md", "docs/plans/m3.md", "notes/Runtime/x.cs", "reports/Editor/y.md", "plans/README.md"]) {
      expect(core.includePath?.(dropped), dropped).toBe(false);
      expect(mcp.includePath?.(dropped), dropped).toBe(false);
    }
    // Test assemblies are not the framework at any depth: a module keeps its
    // tests beside its Runtime/ (ScreenModule/Tests), as the Unity package
    // inside Strada.MCP does, and a test double ranks beside the real API.
    expect(modules.includePath?.("ScreenModule/Tests/Runtime/FakeScreenService.cs")).toBe(false);
    expect(mcp.includePath?.("unity-package/com.strada.mcp/Tests/Editor/BridgeTests.cs")).toBe(false);
    expect(mcp.includePath?.("src/tests/helpers.ts")).toBe(false);
  });

  it("a scoped vault indexes only what its scope keeps, at init and on a later write", async () => {
    const root = mkdtempSync(join(tmpdir(), "strada-framework-vault-"));
    try {
      mkdirSync(join(root, "Runtime"), { recursive: true });
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "Runtime", "Service.cs"), "namespace Fw { public class Service {} }\n");
      writeFileSync(join(root, "docs", "leak.md"), "# a run's sprint notes\n");
      writeFileSync(join(root, "README.md"), "# Framework\n");
      const target = frameworkVaultTargets(deps({ corePath: root }), undefined).find((t) => t.name === "Strada.Core")!;
      const vault = new UnityProjectVault({
        id: "generic:fwtest",
        rootPath: root,
        embedding: createFakeEmbedding(),
        vectorStore: createFakeVectorStore({ semantic: false }),
        includePath: target.includePath,
      });
      try {
        await vault.init();
        expect(vault.listFiles().map((f) => f.path).sort()).toEqual(["README.md", "Runtime/Service.cs"]);

        writeFileSync(join(root, "docs", "later.md"), "# another note\n");
        expect(await vault.reindexFile("docs/later.md")).toBe(false);
        expect(vault.listFiles().map((f) => f.path)).not.toContain("docs/later.md");
      } finally {
        await vault.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
