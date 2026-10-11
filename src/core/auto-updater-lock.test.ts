/**
 * COR-3: the update lock judged a live holder by the CHECKER's start time, so
 * a `strada update` started more than 5 s apart from a daemon mid-update broke
 * the daemon's lock and ran a second install/build into the same checkout —
 * and whichever finished first deleted the other's lock on release.
 *
 * COR-21: the lock lived in the install root, which may be read-only (a
 * root-owned global npm install, a read_only container); creating it failed
 * and was reported as "another update is already running".
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoUpdater } from "./auto-updater.js";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { installLockPath } from "./runtime-lock.js";
import { readProcessStartTime } from "./process-start-time.js";

// A directory nobody may write to. Root ignores chmod, so the write calls
// under it are failed the way that filesystem fails them; reads still work.
const unwritable = vi.hoisted(() => ({ root: undefined as string | undefined, code: "EROFS" }));

// /proc on a machine that has none: the start counted from boot of the pids
// set here; every other pid reads as the platform answers.
const bootStarts = vi.hoisted(() => new Map<number, string>());
vi.mock("./process-start-time.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./process-start-time.js")>();
  return {
    ...actual,
    readProcessBootStart: (pid: number, procRoot?: string) => bootStarts.get(pid) ?? actual.readProcessBootStart(pid, procRoot),
    getProcessBootStart: () => bootStarts.get(process.pid) ?? actual.getProcessBootStart(),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const refuse = (syscall: string, target: unknown): void => {
    const root = unwritable.root;
    const target_ = String(target);
    if (root && (target_ === root || target_.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) {
      throw Object.assign(new Error(`${unwritable.code}: ${syscall} '${target_}'`), { code: unwritable.code, syscall, path: target_ });
    }
  };
  const overrides = {
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => (refuse("open", args[0]), actual.writeFileSync(...args)),
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => (refuse("mkdir", args[0]), actual.mkdirSync(...args)),
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => (refuse("unlink", args[0]), actual.unlinkSync(...args)),
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const dirs: string[] = [];
afterEach(() => {
  unwritable.root = undefined;
  unwritable.code = "EROFS";
  bootStarts.clear();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeUpdater(roots: { installRoot?: string; stateRoot?: string } = {}): {
  updater: AutoUpdater;
  /** Where updaters before COR-21 look (and where a writable install root gets a mirror). */
  lockPath: string;
  /** The authoritative lock, under the config root. */
  newLockPath: string;
  installRoot: string;
  stateRoot: string;
} {
  const installRoot = roots.installRoot ?? tempDir("strada-upd-lock-");
  const stateRoot = roots.stateRoot ?? tempDir("strada-upd-state-");
  const config = {
    autoUpdate: { enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest" as const, notify: false, autoRestart: false },
  };
  const registry = { isIdle: () => true, getActiveChatIds: () => [] } as unknown as ChannelActivityRegistry;
  const updater = new AutoUpdater(config, registry, { hasRunningTasks: () => false }, { installRoot, stateRoot });
  return {
    updater,
    lockPath: path.join(installRoot, ".strada-update.lock"),
    newLockPath: installLockPath(stateRoot, installRoot, "update"),
    installRoot,
    stateRoot,
  };
}

describe("update lock (COR-3)", () => {
  it("a live holder that started long before the checker keeps its lock", async () => {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      await once(holder, "spawn");
      const { updater, lockPath } = makeUpdater();
      // The holder's lock records the holder's own start time.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, timestamp: Date.now(), startTime: Date.now() }));
      // The checker has been up for an hour: its start time is irrelevant.
      vi.spyOn(process, "uptime").mockReturnValue(3600);

      expect(updater.acquireLock()).toBe(false);
      expect(updater.wasLockedOut()).toBe(true);

      holder.kill();
      await once(holder, "exit");
      // Once the holder is gone, the lock is recovered.
      expect(updater.acquireLock()).toBe(true);
      updater.releaseLock();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      holder.kill();
    }
  });

  // Review of 1dbe763e: a holder whose start time cannot be read keeps its
  // lock for a fixed 30 minutes, but with 15-minute install and build steps
  // a failing update (pull, two installs, build, boot smoke, then the
  // rollback's two installs and rebuild) runs well past that.
  it("a live holder it cannot identify keeps its lock for as long as a failing update can run", async () => {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      await once(holder, "spawn");
      const { updater, lockPath } = makeUpdater();
      // No startTime: written by an updater that could not read its own.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, timestamp: Date.now() - 45 * 60_000 }));

      expect(updater.acquireLock()).toBe(false);
      expect(updater.wasLockedOut()).toBe(true);

      fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, timestamp: Date.now() - 3 * 60 * 60_000 }));
      expect(updater.acquireLock()).toBe(true);
      updater.releaseLock();
    } finally {
      holder.kill();
    }
  });

  // On Linux the epoch start adds btime, which moves with every wall-clock
  // step (Docker Desktop's VM re-syncs after the host sleeps): a live update's
  // start no longer matched what it recorded, and its lock was broken.
  it("a live holder keeps its lock after the wall clock stepped (Linux)", { skip: process.platform === "win32" }, async () => {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      await once(holder, "spawn");
      const startedAt = readProcessStartTime(holder.pid!);
      if (startedAt === null) throw new Error("this machine cannot read a start time");
      bootStarts.set(holder.pid!, "boot-a:4242");
      const { updater, lockPath, newLockPath } = makeUpdater();

      // The writer records it, or a checker has nothing exact to compare.
      bootStarts.set(process.pid, "boot-a:99");
      expect(updater.acquireLock()).toBe(true);
      expect(JSON.parse(fs.readFileSync(newLockPath, "utf-8"))).toMatchObject({ bootStart: "boot-a:99" });
      updater.releaseLock();

      fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, timestamp: Date.now(), startTime: startedAt - 3_600_000, bootStart: "boot-a:4242" }));
      expect(updater.acquireLock()).toBe(false);

      // A later process given the pid: its epoch start happens to match, its start since boot does not.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, timestamp: Date.now(), startTime: startedAt, bootStart: "boot-a:17" }));
      expect(updater.acquireLock()).toBe(true);
      updater.releaseLock();
    } finally {
      holder.kill();
    }
  });

  it("release leaves a lock that is no longer ours alone", () => {
    const { updater, lockPath } = makeUpdater();
    expect(updater.acquireLock()).toBe(true);
    // Another updater broke ours as stale and holds the path now.
    const theirs = JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "theirs" });
    fs.writeFileSync(lockPath, theirs);

    updater.releaseLock();

    expect(fs.readFileSync(lockPath, "utf-8")).toBe(theirs);
  });
});

describe("update lock location (COR-21)", () => {
  it("an update runs from a read-only install root: the lock lives under the config root", () => {
    const { updater, lockPath, newLockPath, installRoot } = makeUpdater();
    unwritable.root = installRoot;

    expect(updater.acquireLock()).toBe(true);
    expect(fs.existsSync(newLockPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);

    updater.releaseLock();
    expect(fs.existsSync(newLockPath)).toBe(false);
  });

  it("a lock that cannot be created is an error naming it, not 'another update is running'", async () => {
    const { updater, stateRoot } = makeUpdater();
    unwritable.root = stateRoot;
    unwritable.code = "EACCES";

    expect(() => updater.acquireLock()).toThrow(/Cannot take the update lock at .*EACCES/);
    expect(updater.wasLockedOut()).toBe(false);
    await expect(updater.performUpdate()).rejects.toThrow(/EACCES/);
    expect(updater.wasLockedOut()).toBe(false);
  });

  it("mirrors the claim where older updaters look when the install root is writable", () => {
    const { updater, lockPath, newLockPath } = makeUpdater();
    expect(updater.acquireLock()).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(fs.readFileSync(newLockPath, "utf-8"));
    updater.releaseLock();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(newLockPath)).toBe(false);
  });

  it("two new-style updaters exclude each other through the config-root lock", () => {
    const first = makeUpdater();
    const second = makeUpdater({ installRoot: first.installRoot, stateRoot: first.stateRoot });
    expect(first.updater.acquireLock()).toBe(true);
    // Only the config-root lock is left, as on a read-only install root.
    fs.unlinkSync(first.lockPath);

    expect(second.updater.acquireLock()).toBe(false);
    expect(second.updater.wasLockedOut()).toBe(true);

    first.updater.releaseLock();
    expect(second.updater.acquireLock()).toBe(true);
    second.updater.releaseLock();
  });
});
