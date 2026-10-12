/**
 * The framework vaults bootstrap builds (WP-1.2), through the function boot
 * calls: which codebases, under which scope, and where their index lives.
 *
 * A framework vault rooted at an upstream checkout created
 * <checkout>/.strada/vault/index.db (plus its WAL) on every boot, inside a
 * repository the user owns and that does not ignore .strada/; one rooted at
 * the vendored package wrote it into upstream's folder in the game. Neither
 * is Brain's to write into, so the index lives under the app home.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { initFrameworkVaultsFromBootstrap } from "./stage-knowledge.js";
import { frameworkVaultTargets } from "../../vault/framework-vault-targets.js";
import { VaultRegistry } from "../../vault/vault-registry.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from "../../test-helpers.js";

const tmp = createTempDirTracker("strada-fw-vaults-stage-");

function frameworkPackage(root: string): string {
  mkdirSync(join(root, "Runtime"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "Runtime", "Service.cs"), "namespace Fw { public class Service {} }\n");
  writeFileSync(join(root, "docs", "sprint-report.md"), "# a run's notes\n");
  writeFileSync(join(root, "README.md"), "# Framework\n");
  return root;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out;
}

describe("initFrameworkVaultsFromBootstrap", () => {
  let registry: VaultRegistry | undefined;

  afterEach(async () => {
    await registry?.disposeAll();
    registry = undefined;
    tmp.cleanup();
  });

  it("indexes the installed copy and the upstream checkout within their scope, keeping each index under the app home", async () => {
    const project = tmp.makeDir();
    const vendoredCore = frameworkPackage(join(project, "Packages", "Submodules", "Strada.Core"));
    const modulesCheckout = frameworkPackage(join(tmp.makeDir(), "Strada.Modules"));
    const stateRoot = join(tmp.makeDir(), "app-home", "vaults", "framework");
    const deps = {
      coreInstalled: true,
      corePath: vendoredCore,
      modulesInstalled: false,
      modulesPath: null,
      modulesCheckout: { path: modulesCheckout, source: "sibling-checkout", version: "1.0.0", commit: "abc1234" },
      mcpInstalled: false,
      mcpPath: null,
      mcpVersion: null,
      warnings: [],
    } as StradaDepsStatus;
    registry = new VaultRegistry();

    const startups = await initFrameworkVaultsFromBootstrap({
      targets: frameworkVaultTargets(deps, undefined),
      vaultRegistry: registry,
      embedding: createFakeEmbedding(),
      createVectorStore: () => createFakeVectorStore({ semantic: false }),
      debounceMs: 25,
      stateRoot,
    });
    expect(await Promise.all(startups.map((s) => s.ready))).toEqual([true, true]);

    const byName = new Map(registry.list().map((v) => [registry!.getName(v.id), v]));
    expect([...byName.keys()].sort()).toEqual(["Strada.Core", "Strada.Modules"]);
    for (const vault of byName.values()) {
      // The scope reached the vault: the run's notes are not the framework.
      expect(vault.listFiles().map((f) => f.path).sort()).toEqual(["README.md", "Runtime/Service.cs"]);
    }

    // Nothing of the index inside either package folder ...
    expect(filesUnder(vendoredCore).sort()).toEqual(["README.md", "Runtime/Service.cs", "docs/sprint-report.md"]);
    expect(filesUnder(modulesCheckout).sort()).toEqual(["README.md", "Runtime/Service.cs", "docs/sprint-report.md"]);
    // ... and one index per package under the app home.
    const indexes = filesUnder(stateRoot).filter((f) => f.endsWith("/index.db"));
    expect(indexes).toHaveLength(2);
    expect(indexes.some((f) => f.startsWith("Strada.Core-"))).toBe(true);
    expect(indexes.some((f) => f.startsWith("Strada.Modules-"))).toBe(true);
  });

  it("skips a root that is not on disk and a vault that is already registered", async () => {
    const root = frameworkPackage(join(tmp.makeDir(), "Strada.Core"));
    const target = { name: "Strada.Core", rootPath: root, state: "available" as const };
    const input = {
      vaultRegistry: (registry = new VaultRegistry()),
      embedding: createFakeEmbedding(),
      createVectorStore: () => createFakeVectorStore({ semantic: false }),
      debounceMs: 25,
      stateRoot: join(tmp.makeDir(), "vaults"),
    };

    const first = await initFrameworkVaultsFromBootstrap({
      ...input,
      targets: [target, { name: "Strada.Modules", rootPath: join(root, "..", "missing"), state: "available" }],
    });
    const again = await initFrameworkVaultsFromBootstrap({ ...input, targets: [target] });
    await Promise.all(first.map((s) => s.ready));

    expect(first).toHaveLength(1);
    expect(again).toHaveLength(0);
    expect(registry.list()).toHaveLength(1);
    expect(existsSync(join(root, ".strada"))).toBe(false);
  });
});
