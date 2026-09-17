/**
 * Two projects, one knowledge store — and origin reconciliation that does not
 * wait for the API to change (adversarial review round 9, findings 29 and 30).
 *
 * The store learned per-source keying, but the real readers
 * (FrameworkSchemaProvider, FrameworkPromptGenerator) still asked for
 * `getLatestSnapshot("core")` with no source, so the answer was whichever
 * project synced its Core last on this machine. A package-wide "live" pointer
 * cannot represent two projects at once: the readers have to be bound to the
 * source paths THIS project resolved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import { FrameworkSyncPipeline } from "./framework-sync-pipeline.js";
import { FrameworkSchemaProvider } from "./framework-schema-provider.js";
import { FrameworkPromptGenerator } from "./framework-prompt-generator.js";
import type { FrameworkSyncConfig, FrameworkAPISnapshot } from "./framework-types.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => logSpy,
  getLogger: () => logSpy,
}));

const ONE_BASE = `
namespace Strada.Core.ECS
{
    public abstract class SystemBase { public abstract void OnUpdate(); }
}
`;

const TWO_BASES = `
namespace Strada.Core.ECS
{
    public abstract class SystemBase { public abstract void OnUpdate(); }
    public abstract class NetworkSystemBase : SystemBase { public abstract void OnSync(); }
}
`;

function makeConfig(overrides: Partial<FrameworkSyncConfig> = {}): FrameworkSyncConfig {
  return {
    bootSync: true,
    watchEnabled: false,
    watchDebounceMs: 50,
    gitFallbackEnabled: false,
    gitCacheDir: join(tmpdir(), "unused-framework-cache"),
    gitCacheMaxAgeMs: 0,
    maxDriftScore: 30,
    ...overrides,
  };
}

function makeDeps(corePath: string | null): StradaDepsStatus {
  return {
    coreInstalled: corePath !== null,
    corePath,
    modulesInstalled: false,
    modulesPath: null,
    mcpInstalled: false,
    mcpPath: null,
    mcpVersion: null,
    warnings: [],
  };
}

/** A Strada.Core package tree with the given SystemBase source. */
function writeCorePackage(root: string, source: string): string {
  mkdirSync(join(root, "Runtime"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "com.strada.core", version: "1.0.0" }));
  writeFileSync(join(root, "Runtime", "SystemBase.cs"), source);
  return root;
}

describe("two projects share one knowledge store (r9 finding 29)", () => {
  let tmp: string;
  let projectA: string;
  let projectB: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    logSpy.info.mockClear();
    logSpy.debug.mockClear();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "fw-two-projects-")));
    projectA = writeCorePackage(join(tmp, "project-a", "Packages", "Strada.Core"), ONE_BASE);
    projectB = writeCorePackage(join(tmp, "project-b", "Packages", "Strada.Core"), TWO_BASES);
    // ONE store: ~/.strada-memory/framework-knowledge.db is per machine, not
    // per project.
    store = new FrameworkKnowledgeStore(join(tmp, "framework-knowledge.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("each project's readers keep its own API across alternating syncs and an unchanged restart", async () => {
    const pipeA = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectA));
    const pipeB = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectB));

    await pipeA.bootSync();
    await pipeB.bootSync();

    // Project A restarts. Its source is unchanged, so its per-source sync is
    // skipped — the moment the old readers served B's API.
    const restartA = await pipeA.bootSync();
    expect(restartA.reports).toHaveLength(0);

    const providerA = new FrameworkSchemaProvider(store, pipeA.getSourceBinding());
    const providerB = new FrameworkSchemaProvider(store, pipeB.getSourceBinding());
    expect(providerA.getSystemBaseClasses()).toEqual(["SystemBase"]);
    expect(providerB.getSystemBaseClasses()).toEqual(["SystemBase", "NetworkSystemBase"]);

    const promptA = new FrameworkPromptGenerator(store, { sourceBinding: pipeA.getSourceBinding() });
    const sectionA = promptA.buildFrameworkKnowledgeSection()!;
    expect(sectionA).toContain("`SystemBase`");
    expect(sectionA).not.toContain("NetworkSystemBase");
    // A's own tree is installed here, so its section is still "live".
    expect(sectionA).toContain("(live —");

    const promptB = new FrameworkPromptGenerator(store, { sourceBinding: pipeB.getSourceBinding() });
    expect(promptB.buildFrameworkKnowledgeSection()!).toContain("`NetworkSystemBase`");
  });

  it("a reader bound to this project ignores the other project's newer sync", async () => {
    const pipeA = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectA));
    await pipeA.bootSync();
    const providerA = new FrameworkSchemaProvider(store, pipeA.getSourceBinding());
    expect(providerA.getSystemBaseClasses()).toEqual(["SystemBase"]);

    // B syncs later and its snapshot is the newest in the store, and the live
    // pointer now names B's tree.
    await new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectB)).bootSync();
    expect(store.getLiveSourcePath("core")).toBe(projectB);

    providerA.invalidateCache();
    expect(providerA.getSystemBaseClasses()).toEqual(["SystemBase"]);
  });

  it("guard: a reader with no binding still serves the live snapshot as before", async () => {
    await new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectA)).bootSync();
    const unbound = new FrameworkSchemaProvider(store);
    expect(unbound.getSystemBaseClasses()).toEqual(["SystemBase"]);
    expect(new FrameworkPromptGenerator(store).buildFrameworkKnowledgeSection()).toContain("`SystemBase`");
  });

  it("guard: a package this project has no source for is still served from a clone, labelled as one", async () => {
    const pipeA = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectA));
    await pipeA.bootSync();
    // Knowledge about Strada.Modules exists only as a cached clone, which no
    // project resolves as its own source.
    store.storeSnapshot({
      packageId: "modules",
      packageName: "Strada.Modules",
      version: "2.0.0",
      gitHash: null,
      namespaces: ["Strada.Modules.Inventory"],
      baseClasses: new Map(),
      attributes: new Map(),
      interfaces: [],
      enums: [],
      classes: [{ name: "InventoryModule", namespace: "Strada.Modules.Inventory", baseTypes: [], isAbstract: false }],
      structs: [],
      exportedFunctions: [],
      tools: [],
      resources: [],
      prompts: [],
      extractedAt: new Date(),
      sourcePath: join(tmp, "cache", "modules"),
      sourceOrigin: "cached",
      sourceLanguage: "csharp",
      fileCount: 3,
    } satisfies FrameworkAPISnapshot);

    const section = new FrameworkPromptGenerator(store, { sourceBinding: pipeA.getSourceBinding() })
      .buildFrameworkKnowledgeSection()!;
    expect(section).toContain("`InventoryModule`");
    expect(section).toContain("from a cached clone, not installed here");
  });

  /**
   * r9 finding 28: a vanished tree was dropped with deletePackage, which
   * removed EVERY source's snapshots and left the live pointer and per-source
   * bookkeeping naming the tree that is gone.
   */
  it("one project's source vanishing takes only its own knowledge, and hands the live pointer over", async () => {
    const pipeA = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectA));
    const pipeB = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectB));
    await pipeB.bootSync();
    await pipeA.bootSync();
    // A synced last, so the package-wide live pointer names A's tree.
    expect(store.getLiveSourcePath("core")).toBe(projectA);

    rmSync(projectA, { recursive: true, force: true });
    expect(await pipeA.syncPackage("core")).toBeNull();

    // A's knowledge and bookkeeping are gone…
    expect(store.getLatestSnapshot("core", projectA)).toBeNull();
    expect(store.getSourceMetadata("core", projectA)).toBeNull();
    // …B keeps its own, and the installation pointer is handed to it rather
    // than left dangling on a path with no rows.
    expect(store.getLatestSnapshot("core", projectB)!.classes.map((c) => c.name))
      .toEqual(["SystemBase", "NetworkSystemBase"]);
    expect(store.getLiveSourcePath("core")).toBe(projectB);
    expect(new FrameworkSchemaProvider(store, pipeB.getSourceBinding()).getSystemBaseClasses())
      .toEqual(["SystemBase", "NetworkSystemBase"]);
  });

  it("guard: a project whose Core is NOT installed gets no other project's installation", async () => {
    await new FrameworkSyncPipeline(store, makeConfig(), makeDeps(projectB)).bootSync();
    // This project resolved no Core path at all.
    const orphan = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(null));
    const provider = new FrameworkSchemaProvider(store, orphan.getSourceBinding());
    // Falls back to the static contracts rather than B's tree.
    expect(provider.getSystemBaseClasses()).not.toContain("NetworkSystemBase");
  });
});

describe("origin reconciliation is independent of the API fingerprint (r9 finding 30)", () => {
  let tmp: string;
  let dbPath: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    logSpy.info.mockClear();
    logSpy.debug.mockClear();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "fw-origin-")));
    dbPath = join(tmp, "framework-knowledge.db");
    store = new FrameworkKnowledgeStore(dbPath);
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function rawExec(sql: string): void {
    const raw = new Database(dbPath);
    try {
      raw.exec(sql);
    } finally {
      raw.close();
    }
  }

  it("promotes a cached source to the installation when the project now resolves it, with no content change", async () => {
    const corePath = writeCorePackage(join(tmp, "Strada.Core"), ONE_BASE);
    const pipeline = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(corePath));
    await pipeline.bootSync();

    // Rewrite history: this tree was only ever a cached clone. Nothing about
    // the extracted API changes — version, git HEAD and fingerprint all stay.
    // The claim now lives on the PROJECT's binding (r10 finding 11), so that
    // is the row this scenario has to be wrong about; the shared rows are
    // rewritten too, as a pre-upgrade database has them.
    rawExec(`
      UPDATE framework_snapshots SET source_origin = 'cached' WHERE package_id = 'core';
      UPDATE framework_source_metadata SET source_origin = 'cached' WHERE package_id = 'core';
      UPDATE framework_project_source SET source_origin = 'cached' WHERE package_id = 'core';
      DELETE FROM framework_live_source WHERE package_id = 'core';
    `);
    expect(store.getLiveSnapshot("core")).toBeNull();
    const syncCount = store.getMetadata("core")!.syncCount;

    const second = await pipeline.bootSync();

    // Still skipped — the API really is unchanged, and nothing was re-stored…
    expect(second.reports).toHaveLength(0);
    expect(store.getMetadata("core")!.syncCount).toBe(syncCount);
    // …but the origin/installation binding is corrected anyway. Measured on
    // what THIS project's reader sees, which is where installation status
    // lives — not on the snapshot row, which every project at this path shares.
    const binding = pipeline.getSourceBinding();
    expect(store.getProjectSnapshot("core", binding)!.sourceOrigin).toBe("local");
    expect(store.getProjectLiveSourcePath(binding.projectId, "core")).toBe(corePath);
    expect(store.getLiveSourcePath("core")).toBe(corePath);
    const line = [...logSpy.info.mock.calls, ...logSpy.debug.mock.calls]
      .map((c) => String(c[0]))
      .find((m) => m.includes("origin") && m.includes(corePath));
    expect(line).toBeDefined();
    expect(line).toContain("local");
  });

  it("corrects a legacy row wrongly stamped local back to the cache it really is", async () => {
    const cacheRoot = join(tmp, "cache");
    const cachedCore = writeCorePackage(join(cacheRoot, "core"), ONE_BASE);
    // Fresh cache dirs for the other packages too: the fallback reuses an
    // existing cache instead of reaching for the network.
    writeCorePackage(join(cacheRoot, "modules"), ONE_BASE);
    writeCorePackage(join(cacheRoot, "mcp"), ONE_BASE);
    const pipeline = new FrameworkSyncPipeline(
      store,
      makeConfig({ gitFallbackEnabled: true, gitCacheDir: cacheRoot, gitCacheMaxAgeMs: 10 * 60_000 }),
      makeDeps(null),
    );
    await pipeline.bootSync();
    expect(store.getLatestSnapshot("core", cachedCore)!.sourceOrigin).toBe("cached");
    expect(store.getLiveSourcePath("core")).toBeUndefined();

    // What the per-source upgrade backfill does with a legacy database: trust
    // the stamp, and make the "local" row the live installation — including the
    // project binding the project-origin backfill derives from it.
    rawExec(`
      UPDATE framework_snapshots SET source_origin = 'local' WHERE package_id = 'core';
      UPDATE framework_source_metadata SET source_origin = 'local' WHERE package_id = 'core';
      UPDATE framework_project_source SET source_origin = 'local' WHERE package_id = 'core';
      INSERT OR REPLACE INTO framework_live_source (package_id, source_path, updated_at)
        VALUES ('core', '${cachedCore}', 1);
    `);
    expect(store.getLiveSnapshot("core")).not.toBeNull();

    const second = await pipeline.bootSync();

    // Core's content is unchanged, so nothing is re-extracted for it…
    expect(second.reports.map((r) => r.packageId)).not.toContain("core");
    // …yet the origin claim is corrected, for this project and for the
    // package-wide pointer no other project has claimed.
    const binding = pipeline.getSourceBinding();
    expect(store.getProjectSnapshot("core", binding)!.sourceOrigin).toBe("cached");
    expect(store.getProjectLiveSourcePath(binding.projectId, "core")).toBeUndefined();
    expect(store.getLiveSourcePath("core")).toBeUndefined();
    expect(store.getLiveSnapshot("core")).toBeNull();
    // …and no prompt claims the framework is installed here.
    const section = new FrameworkPromptGenerator(store, { sourceBinding: pipeline.getSourceBinding() })
      .buildFrameworkKnowledgeSection()!;
    expect(section).toContain("from a cached clone, not installed here");
    expect(section).not.toContain("This project has Strada installed");
  });

  it("guard: an unchanged source whose origin is already right is left alone and still skipped", async () => {
    const corePath = writeCorePackage(join(tmp, "Strada.Core"), ONE_BASE);
    const pipeline = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(corePath));
    await pipeline.bootSync();
    const before = store.getSourceMetadata("core", corePath)!;

    const second = await pipeline.bootSync();

    expect(second.reports).toHaveLength(0);
    expect(store.getSourceMetadata("core", corePath)).toEqual(before);
    expect(store.getLiveSourcePath("core")).toBe(corePath);
    expect(
      [...logSpy.info.mock.calls].map((c) => String(c[0])).filter((m) => m.includes("origin")),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One physical source, two projects, opposite installation status
// (adversarial review round 10, finding 11)
// ---------------------------------------------------------------------------

/**
 * Whether a directory is the INSTALLATION is a fact about a PROJECT, not about
 * the directory. Until now origin lived on the shared rows: every snapshot at a
 * source path was re-stamped by whichever project synced last, and the readers
 * bound only the path — so project A, which explicitly installs the shared
 * framework-cache directory, was told its framework is "not installed here" the
 * moment project B synced that same directory as fallback knowledge, and in the
 * reverse order B inherited A's "live".
 *
 * The content is byte-identical (it is literally one directory), so no
 * fingerprint, version or git HEAD can carry the difference.
 */
describe("one physical source, two projects with opposite installation status (r10 finding 11)", () => {
  let tmp: string;
  let sharedCacheDir: string;
  let sharedCore: string;
  let projectARoot: string;
  let projectBRoot: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    logSpy.info.mockClear();
    logSpy.debug.mockClear();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "fw-shared-source-")));
    // The shared framework cache: one physical directory.
    sharedCacheDir = join(tmp, "framework-cache");
    sharedCore = writeCorePackage(join(sharedCacheDir, "core"), ONE_BASE);
    // The other packages exist in the cache too, so the git fallback never
    // reaches for the network.
    writeCorePackage(join(sharedCacheDir, "modules"), ONE_BASE);
    writeCorePackage(join(sharedCacheDir, "mcp"), ONE_BASE);
    projectARoot = join(tmp, "project-a");
    projectBRoot = join(tmp, "project-b");
    mkdirSync(projectARoot, { recursive: true });
    mkdirSync(projectBRoot, { recursive: true });
    store = new FrameworkKnowledgeStore(join(tmp, "framework-knowledge.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A installs the shared directory as its own Strada.Core. */
  function installingProject(): FrameworkSyncPipeline {
    return new FrameworkSyncPipeline(store, makeConfig(), makeDeps(sharedCore), projectARoot);
  }

  /** B has no Core of its own and falls back to the same shared directory. */
  function fallbackProject(): FrameworkSyncPipeline {
    return new FrameworkSyncPipeline(
      store,
      makeConfig({ gitFallbackEnabled: true, gitCacheDir: sharedCacheDir, gitCacheMaxAgeMs: 10 * 60_000 }),
      makeDeps(null),
      projectBRoot,
    );
  }

  function coreHeader(pipeline: FrameworkSyncPipeline): string {
    const section = new FrameworkPromptGenerator(store, { sourceBinding: pipeline.getSourceBinding() })
      .buildFrameworkKnowledgeSection();
    const header = (section ?? "").split("\n").find((l) => l.startsWith("## Strada.Core"));
    return header ?? "(no Strada.Core section)";
  }

  it("the installing project still reads its framework as installed after the fallback project syncs the same directory", async () => {
    const installing = installingProject();
    const fallback = fallbackProject();

    await installing.bootSync();
    expect(coreHeader(installing)).toContain("(live —");

    // B uses the very same directory as fallback knowledge. Its content is
    // unchanged, so nothing is re-extracted…
    const bSync = await fallback.bootSync();
    expect(bSync.reports.map((r) => r.packageId)).not.toContain("core");

    // …and A's installation is still A's installation.
    expect(coreHeader(installing)).toContain("(live —");
    expect(coreHeader(fallback)).toContain("not installed here");
  });

  it("guard: one project alone, installing that directory, reads it as its installation", async () => {
    const installing = installingProject();
    await installing.bootSync();

    expect(coreHeader(installing)).toContain("(live —");
    expect(store.getProjectLiveSourcePath(installing.getProjectId(), "core")).toBe(sharedCore);
    // Restarting with nothing changed must not lose the installation.
    await installing.bootSync();
    expect(coreHeader(installing)).toContain("(live —");
  });

  it("guard: one project alone, only falling back to that directory, never reads it as installed", async () => {
    const fallback = fallbackProject();
    await fallback.bootSync();

    const header = coreHeader(fallback);
    expect(header).toContain("not installed here");
    expect(header).not.toContain("(live —");
    expect(store.getProjectLiveSourcePath(fallback.getProjectId(), "core")).toBeUndefined();
    const section = new FrameworkPromptGenerator(store, { sourceBinding: fallback.getSourceBinding() })
      .buildFrameworkKnowledgeSection()!;
    expect(section).not.toContain("This project has Strada installed");
  });

  it("each project's own binding is recorded, and neither reads the other's", async () => {
    const installing = installingProject();
    const fallback = fallbackProject();
    await installing.bootSync();
    await fallback.bootSync();

    expect(store.getProjectSourceOrigin(installing.getProjectId(), "core", sharedCore)).toBe("local");
    expect(store.getProjectSourceOrigin(fallback.getProjectId(), "core", sharedCore)).toBe("cached");
    expect(store.getProjectLiveSourcePath(installing.getProjectId(), "core")).toBe(sharedCore);
    expect(store.getProjectLiveSourcePath(fallback.getProjectId(), "core")).toBeUndefined();
    // The shared knowledge itself is still shared — one directory, one API.
    expect(store.getLatestSnapshot("core", sharedCore)!.classes.map((c) => c.name)).toEqual(["SystemBase"]);
  });

  it("the fallback project does not inherit the installing project's 'installed here' in the reverse order", async () => {
    const fallback = fallbackProject();
    const installing = installingProject();

    await fallback.bootSync();
    expect(coreHeader(fallback)).toContain("not installed here");

    const aSync = await installing.bootSync();
    expect(aSync.reports.map((r) => r.packageId)).not.toContain("core");

    expect(coreHeader(fallback)).toContain("not installed here");
    expect(coreHeader(installing)).toContain("(live —");
  });
});
