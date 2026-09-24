/**
 * LRN-12: the git fallback must not block the daemon's event loop, and a failed
 * re-clone must not destroy the cache it was meant to refresh.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = vi.hoisted(() => ({
  outcome: "fail" as "fail" | "succeed",
  cloneFinishedAt: [] as number[],
}));

/** Stand-in for a clone: a Strada.Core-shaped tree at `target`. */
function writePackage(target: string, marker: string): void {
  mkdirSync(join(target, "Runtime"), { recursive: true });
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "com.strada.core", version: "1.0.0" }));
  writeFileSync(
    join(target, "Runtime", "SystemBase.cs"),
    "namespace Strada.Core.ECS { public abstract class SystemBase { public abstract void OnUpdate(); } }",
  );
  writeFileSync(join(target, "MARKER"), marker);
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const isClone = (args: unknown): args is string[] => Array.isArray(args) && args[0] === "clone";
  return {
    ...actual,
    // The network, simulated: a clone takes a while and then fails or succeeds.
    execFile: vi.fn((file: string, args: string[], options: unknown, callback: (error: Error | null) => void) => {
      if (!isClone(args)) return actual.execFile(file, args, options as never, callback as never);
      setTimeout(() => {
        git.cloneFinishedAt.push(performance.now());
        if (git.outcome === "succeed") {
          writePackage(args[args.length - 1]!, "fresh");
          callback(null);
        } else {
          callback(new Error("fatal: unable to access the repository (simulated)"));
        }
      }, 50);
      return undefined as never;
    }),
    // The same network behind a synchronous call: the whole process waits for it.
    execFileSync: vi.fn((file: string, args: string[], options: unknown) => {
      if (!isClone(args)) return actual.execFileSync(file, args, options as never);
      const until = performance.now() + 50;
      while (performance.now() < until) { /* blocked on the network */ }
      git.cloneFinishedAt.push(performance.now());
      if (git.outcome === "succeed") {
        writePackage(args[args.length - 1]!, "fresh");
        return Buffer.from("");
      }
      throw new Error("fatal: unable to access the repository (simulated)");
    }),
  };
});

vi.mock("../../utils/logger.js", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLoggerSafe: () => log, getLogger: () => log };
});

import { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import { FrameworkSyncPipeline } from "./framework-sync-pipeline.js";
import type { FrameworkSyncConfig } from "./framework-types.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";

const NO_LOCAL_PACKAGES: StradaDepsStatus = {
  coreInstalled: false,
  corePath: null,
  modulesInstalled: false,
  modulesPath: null,
  mcpInstalled: false,
  mcpPath: null,
  mcpVersion: null,
  warnings: [],
};

let tmp: string;
let cacheRoot: string;
let store: FrameworkKnowledgeStore;

function staleCacheConfig(): FrameworkSyncConfig {
  return {
    bootSync: true,
    watchEnabled: false,
    watchDebounceMs: 50,
    gitFallbackEnabled: true,
    gitCacheDir: cacheRoot,
    // Every cache is stale: a re-clone is attempted.
    gitCacheMaxAgeMs: 0,
    maxDriftScore: 30,
  };
}

beforeEach(() => {
  git.outcome = "fail";
  git.cloneFinishedAt = [];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "fw-git-fallback-")));
  cacheRoot = join(tmp, "cache");
  writePackage(join(cacheRoot, "core"), "stale");
  store = new FrameworkKnowledgeStore(join(tmp, "framework-knowledge.db"));
  store.initialize();
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("framework git fallback (LRN-12)", () => {
  it("a failed re-clone keeps the stale cache and serves it", async () => {
    const pipeline = new FrameworkSyncPipeline(store, staleCacheConfig(), NO_LOCAL_PACKAGES);

    await pipeline.bootSync();

    expect(readFileSync(join(cacheRoot, "core", "MARKER"), "utf8")).toBe("stale");
    expect(store.getLatestSnapshot("core", join(cacheRoot, "core"))?.sourceOrigin).toBe("cached");
    expect(readdirSync(cacheRoot).filter((name) => name.includes(".clone-"))).toEqual([]);
  });

  it("the clone does not block the event loop", async () => {
    const pipeline = new FrameworkSyncPipeline(store, staleCacheConfig(), NO_LOCAL_PACKAGES);
    let timerFiredAt = Number.POSITIVE_INFINITY;
    setTimeout(() => { timerFiredAt = performance.now(); }, 1);

    await pipeline.bootSync();

    expect(git.cloneFinishedAt.length).toBeGreaterThan(0);
    expect(timerFiredAt).toBeLessThan(git.cloneFinishedAt[0]!);
  });

  it("a successful re-clone replaces the cache", async () => {
    git.outcome = "succeed";
    const pipeline = new FrameworkSyncPipeline(store, staleCacheConfig(), NO_LOCAL_PACKAGES);

    await pipeline.bootSync();

    expect(readFileSync(join(cacheRoot, "core", "MARKER"), "utf8")).toBe("fresh");
    expect(existsSync(join(cacheRoot, "modules"))).toBe(true);
    expect(readdirSync(cacheRoot).filter((name) => name.includes(".clone-"))).toEqual([]);
  });
});
