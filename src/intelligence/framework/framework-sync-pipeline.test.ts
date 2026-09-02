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
import { initializeFrameworkSchemaProvider, getFrameworkSchemaProvider } from "./framework-schema-provider.js";
import { FrameworkPromptGenerator } from "./framework-prompt-generator.js";
import type { FrameworkSyncConfig } from "./framework-types.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => logSpy,
  getLogger: () => logSpy,
}));

/**
 * A deterministic stand-in for chokidar: records the paths/options the
 * pipeline hands to `watch()` and exposes the registered handlers so a test
 * can deliver an event itself instead of waiting on the real filesystem
 * watcher (the wall-clock version of this test was flaky under the parallel
 * suite). "ready" is emitted on the next microtask.
 */
type Handler = (...args: unknown[]) => void;
interface FakeWatch {
  paths: string[];
  options: Record<string, unknown>;
  handlers: Map<string, Handler[]>;
  emit(event: string, ...args: unknown[]): void;
  closed: boolean;
}
const fakeWatches: FakeWatch[] = [];
vi.mock("chokidar", () => ({
  watch: (paths: string[], options: Record<string, unknown>) => {
    const handlers = new Map<string, Handler[]>();
    const rec: FakeWatch = {
      paths,
      options,
      handlers,
      closed: false,
      emit(event, ...args) {
        for (const fn of [...(handlers.get(event) ?? [])]) fn(...args);
      },
    };
    const watcher = {
      on(event: string, fn: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        return watcher;
      },
      once(event: string, fn: Handler) {
        const wrapped: Handler = (...args) => {
          handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== wrapped));
          fn(...args);
        };
        handlers.set(event, [...(handlers.get(event) ?? []), wrapped]);
        return watcher;
      },
      close: async () => {
        rec.closed = true;
      },
    };
    fakeWatches.push(rec);
    queueMicrotask(() => rec.emit("ready"));
    return watcher;
  },
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

/**
 * Audited 2026-09-02: FrameworkSchemaProvider and FrameworkPromptGenerator
 * memoise the boot snapshot and their invalidateCache() had no production
 * caller, so a snapshot the pipeline stored later was never served — the
 * watcher path did work no reader ever saw.
 */
describe("FrameworkSyncPipeline invalidates snapshot readers after storing (audited 2026-09-02)", () => {
  let tmp: string;
  let corePath: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "fw-pipeline-inval-")));
    corePath = join(tmp, "Strada.Core");
    mkdirSync(join(corePath, "Runtime"), { recursive: true });
    writeFileSync(join(corePath, "package.json"), JSON.stringify({ name: "com.strada.core", version: "1.0.0" }));
    writeFileSync(join(corePath, "Runtime", "SystemBase.cs"), CORE_ONE_BASE);
    store = new FrameworkKnowledgeStore(join(tmp, "fw.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("the schema provider singleton serves the newly synced base classes", async () => {
    const pipeline = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(corePath));
    await pipeline.bootSync();
    initializeFrameworkSchemaProvider(store);
    expect(getFrameworkSchemaProvider()!.getSystemBaseClasses()).toEqual(["SystemBase"]);

    writeFileSync(join(corePath, "Runtime", "SystemBase.cs"), CORE_TWO_BASES);
    const report = await pipeline.syncPackage("core");
    expect(report?.driftScore ?? 0).toBeGreaterThan(0);

    // Same singleton the tools read through — no restart, no manual invalidate.
    expect(getFrameworkSchemaProvider()!.getSystemBaseClasses()).toEqual(["SystemBase", "NetworkSystemBase"]);
  });

  it("notifies registered listeners so the prompt generator can drop its memo", async () => {
    const pipeline = new FrameworkSyncPipeline(store, makeConfig(), makeDeps(corePath));
    await pipeline.bootSync();
    const generator = new FrameworkPromptGenerator(store);
    const seen: string[] = [];
    const unsubscribe = pipeline.onSnapshotStored((pkgId) => {
      seen.push(pkgId);
      generator.invalidateCache();
    });

    const before = generator.buildFrameworkKnowledgeSection();
    expect(before).toContain("`SystemBase`");
    expect(before).not.toContain("NetworkSystemBase");

    writeFileSync(join(corePath, "Runtime", "SystemBase.cs"), CORE_TWO_BASES);
    await pipeline.syncPackage("core");

    expect(seen).toEqual(["core"]);
    expect(generator.buildFrameworkKnowledgeSection()).toContain("`NetworkSystemBase`");

    unsubscribe();
    writeFileSync(join(corePath, "Runtime", "SystemBase.cs"), CORE_ONE_BASE);
    await pipeline.syncPackage("core");
    expect(seen).toEqual(["core"]);
  });
});

/**
 * Audited 2026-09-02: chokidar 5 matches a string `ignored` entry by exact
 * equality (see chokidar's createPattern), so the glob strings
 * "**\/node_modules/**" etc. never matched a real path. Every npm install under
 * Strada.MCP/node_modules and every lock-file churn under Strada.Core/.git
 * reached the handler and triggered a full re-extraction.
 */
describe("FrameworkSyncPipeline watcher ignore matcher (audited 2026-09-02)", () => {
  let tmp: string;
  let corePath: string;
  let store: FrameworkKnowledgeStore;

  beforeEach(() => {
    fakeWatches.length = 0;
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "fw-pipeline-ignore-")));
    corePath = join(tmp, "Strada.Core");
    mkdirSync(join(corePath, "Runtime"), { recursive: true });
    writeFileSync(join(corePath, "package.json"), JSON.stringify({ name: "com.strada.core", version: "1.0.0" }));
    writeFileSync(join(corePath, "Runtime", "SystemBase.cs"), CORE_ONE_BASE);
    store = new FrameworkKnowledgeStore(join(tmp, "fw.db"));
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("hands chokidar a function matcher that ignores node_modules/.git/bin/obj and keeps Runtime .cs", async () => {
    const pipeline = new FrameworkSyncPipeline(store, makeConfig({ watchEnabled: true }), makeDeps(corePath));
    await pipeline.startWatcher();
    try {
      expect(fakeWatches).toHaveLength(1);
      expect(fakeWatches[0]!.paths).toEqual([corePath]);
      const ignored = fakeWatches[0]!.options["ignored"] as unknown;
      // A string entry is compared with `===` by chokidar 5; only a function
      // (or RegExp) can match a real absolute path.
      expect(typeof ignored).toBe("function");
      const isIgnored = ignored as (path: string) => boolean;

      // The directory itself must be ignored so chokidar never descends into it.
      expect(isIgnored(join(corePath, "node_modules"))).toBe(true);
      expect(isIgnored(join(corePath, "node_modules", "chalk", "index.js"))).toBe(true);
      expect(isIgnored(join(corePath, ".git"))).toBe(true);
      expect(isIgnored(join(corePath, ".git", "index.lock"))).toBe(true);
      expect(isIgnored(join(corePath, "bin", "Debug", "Strada.Core.dll"))).toBe(true);
      expect(isIgnored(join(corePath, "obj", "project.assets.json"))).toBe(true);

      // Framework sources keep flowing.
      expect(isIgnored(join(corePath, "Runtime", "SystemBase.cs"))).toBe(false);
      expect(isIgnored(join(corePath, "Runtime"))).toBe(false);
      // "bin"/"obj" are whole path segments, not name prefixes.
      expect(isIgnored(join(corePath, "Runtime", "Binding", "ObjectPool.cs"))).toBe(false);
      expect(isIgnored(join(corePath, "Runtime", "bin.cs"))).toBe(false);
    } finally {
      await pipeline.stop();
    }
  });
});
