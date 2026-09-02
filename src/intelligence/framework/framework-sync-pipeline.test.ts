/**
 * FrameworkSyncPipeline — boot sync and incremental sync against a real
 * FrameworkKnowledgeStore and the real C# extractor over a temp package dir.
 *
 * Audited 2026-09-02: the pipeline's skip decision keyed only on package.json
 * version and `git rev-parse HEAD`, both of which stay put during an in-place
 * edit, so a fresh (already extracted) snapshot was discarded as "unchanged".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import { FrameworkSyncPipeline } from "./framework-sync-pipeline.js";
import type { FrameworkSyncConfig } from "./framework-types.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => logSpy,
  getLogger: () => logSpy,
}));

const CORE_ONE_BASE = `
namespace Strada.Core.ECS
{
    public abstract class SystemBase { public abstract void OnUpdate(); }
}
`;

const CORE_TWO_BASES = `
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

function makeDeps(corePath: string): StradaDepsStatus {
  return {
    coreInstalled: true,
    corePath,
    modulesInstalled: false,
    modulesPath: null,
    mcpInstalled: false,
    mcpPath: null,
    mcpVersion: null,
    warnings: [],
  };
}

describe("FrameworkSyncPipeline.bootSync re-syncs on content change (audited 2026-09-02)", () => {
  let tmp: string;
  let corePath: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    logSpy.info.mockClear();
    logSpy.debug.mockClear();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "fw-pipeline-")));
    corePath = join(tmp, "Strada.Core");
    mkdirSync(join(corePath, "Runtime"), { recursive: true });
    // Version pinned: local development edits Core in place without bumping it.
    writeFileSync(join(corePath, "package.json"), JSON.stringify({ name: "com.strada.core", version: "1.0.0" }));
    writeFileSync(join(corePath, "Runtime", "SystemBase.cs"), CORE_ONE_BASE);
    store = new FrameworkKnowledgeStore(join(tmp, "fw.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stores a new snapshot when the API changed but version and git HEAD did not", async () => {
    const pipeline = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(corePath));

    const first = await pipeline.bootSync();
    expect(first.reports).toHaveLength(1);
    expect(store.getLatestSnapshot("core")!.classes.map((c) => c.name)).toEqual(["SystemBase"]);
    const firstSyncCount = store.getMetadata("core")!.syncCount;

    // In-place edit: same package.json version, no commit.
    writeFileSync(join(corePath, "Runtime", "SystemBase.cs"), CORE_TWO_BASES);

    const second = await pipeline.bootSync();
    expect(second.reports).toHaveLength(1);
    expect(second.reports[0]!.driftScore).toBeGreaterThan(0);
    expect(store.getLatestSnapshot("core")!.classes.map((c) => c.name)).toEqual(["SystemBase", "NetworkSystemBase"]);
    expect(store.getMetadata("core")!.syncCount).toBe(firstSyncCount + 1);
  });

  it("still skips an identical package, and the skip line names what it compared", async () => {
    const pipeline = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(corePath));
    await pipeline.bootSync();
    const syncCount = store.getMetadata("core")!.syncCount;

    const second = await pipeline.bootSync();
    expect(second.reports).toHaveLength(0);
    expect(store.getMetadata("core")!.syncCount).toBe(syncCount);

    const skipLine = logSpy.debug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("Strada.Core") && m.includes("skipp"));
    expect(skipLine).toBeDefined();
    // The line must say what was measured, not just "unchanged".
    expect(skipLine).toMatch(/content/i);
    expect(skipLine).toMatch(/version 1\.0\.0/);
  });
});
