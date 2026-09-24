/**
 * COR-3: the update lock judged a live holder by the CHECKER's start time, so
 * a `strada update` started more than 5 s apart from a daemon mid-update broke
 * the daemon's lock and ran a second install/build into the same checkout —
 * and whichever finished first deleted the other's lock on release.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoUpdater } from "./auto-updater.js";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeUpdater(): { updater: AutoUpdater; lockPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-upd-lock-"));
  dirs.push(dir);
  const config = {
    autoUpdate: { enabled: true, intervalHours: 6, idleTimeoutMin: 5, channel: "latest" as const, notify: false, autoRestart: false },
  };
  const registry = { isIdle: () => true, getActiveChatIds: () => [] } as unknown as ChannelActivityRegistry;
  const updater = new AutoUpdater(config, registry, { hasRunningTasks: () => false }, { installRoot: dir });
  return { updater, lockPath: path.join(dir, ".strada-update.lock") };
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
