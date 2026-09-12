import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lets one test fire a third writer INTO the window a reclaimer opens when it
 * renames the canonical path away. Unset for every other test.
 */
const afterNextRename: { run?: () => void } = {};
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    renameSync: (from: string, to: string) => {
      const hook = afterNextRename.run;
      afterNextRename.run = undefined;
      const out = real.renameSync(from, to);
      hook?.();
      return out;
    },
  };
});

import { acquireProjectWriteLock, holderIsAlive } from "./project-write-lock.js";

/**
 * Measured live 2026-09-11 21:16:24: the daemon had restarted five minutes
 * earlier, the lock its dead predecessor left was not yet "stale" by age, and
 * the salvage commit wrote into the real project UNLOCKED — beside whatever
 * else was writing (Codex 2026-09-11 N#2).
 */
describe("the project write lock", () => {
  let root: string;
  const lockDir = (): string => join(root, ".strada", "locks", "project-write.lock");
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "strada-lock-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("takes and releases the lock", async () => {
    const held = await acquireProjectWriteLock(root, { timeoutMs: 100 });
    expect(held.acquired).toBe(true);
    expect(existsSync(lockDir())).toBe(true);
    held.release();
    expect(existsSync(lockDir())).toBe(false);
  });

  it("breaks a lock whose holder is GONE at once, without waiting out the stale window", async () => {
    mkdirSync(lockDir(), { recursive: true });
    // A process id that cannot be running: pid 0 is not a real process here.
    writeFileSync(join(lockDir(), "owner"), JSON.stringify({ pid: 2 ** 30, host: hostname(), token: "dead", at: new Date().toISOString() }));

    const taken = await acquireProjectWriteLock(root, { timeoutMs: 2_000, staleMs: 10 * 60_000 });

    expect(taken.acquired).toBe(true);
    expect(JSON.parse(readFileSync(join(lockDir(), "owner"), "utf8")).pid).toBe(process.pid);
    taken.release();
  });

  it("leaves a LIVE holder's lock alone however long it has been held", async () => {
    mkdirSync(lockDir(), { recursive: true });
    // This very process is the holder, and the lock is an hour old.
    writeFileSync(join(lockDir(), "owner"), JSON.stringify({ pid: process.pid, host: hostname(), token: "live", at: new Date(Date.now() - 3600_000).toISOString() }));

    const denied = await acquireProjectWriteLock(root, { timeoutMs: 300, staleMs: 1 });

    expect(denied.acquired).toBe(false);
    expect(JSON.parse(readFileSync(join(lockDir(), "owner"), "utf8")).token).toBe("live");
  });

  it("a holder that was taken over does not delete the new holder's lock", async () => {
    const first = await acquireProjectWriteLock(root, { timeoutMs: 100 });
    expect(first.acquired).toBe(true);
    // Someone broke it and took it: a different token now owns the directory.
    writeFileSync(join(lockDir(), "owner"), JSON.stringify({ pid: process.pid, host: hostname(), token: "somebody-else", at: new Date().toISOString() }));

    first.release();

    expect(existsSync(lockDir())).toBe(true);
    expect(JSON.parse(readFileSync(join(lockDir(), "owner"), "utf8")).token).toBe("somebody-else");
  });

  it("a lock with no owner file falls back to age", async () => {
    mkdirSync(lockDir(), { recursive: true });
    expect((await acquireProjectWriteLock(root, { timeoutMs: 200, staleMs: 10 * 60_000 })).acquired).toBe(false);
    expect((await acquireProjectWriteLock(root, { timeoutMs: 200, staleMs: 0 })).acquired).toBe(true);
  });

  it("holderIsAlive says 'unknown' for another machine", () => {
    expect(holderIsAlive({ pid: process.pid, host: "some-other-host", token: "t", at: "" })).toBeUndefined();
    expect(holderIsAlive(null)).toBeUndefined();
    expect(holderIsAlive({ pid: process.pid, host: hostname(), token: "t", at: "" })).toBe(true);
  });

  it("reclaiming is one step, so a lock that changed hands is left alone (Codex 2026-09-11 O#16)", async () => {
    // A reclaimer reads a dead owner, another reclaimer breaks it and a new
    // writer takes it — and the first reclaimer's delete then removed the NEW
    // holder's lock, letting a third writer in beside it.
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(join(lockDir(), "owner"), JSON.stringify({ pid: 2 ** 30, host: hostname(), token: "dead", at: new Date().toISOString() }));

    // The lock changes hands while a reclaimer is mid-flight: this is what its
    // stale observation would delete.
    const live = await acquireProjectWriteLock(root, { timeoutMs: 2_000 });
    expect(live.acquired).toBe(true);
    const liveToken = JSON.parse(readFileSync(join(lockDir(), "owner"), "utf8")).token;

    // A second reclaimer, still holding the DEAD owner's observation.
    const second = await acquireProjectWriteLock(root, { timeoutMs: 200, staleMs: 10 * 60_000 });

    expect(second.acquired).toBe(false);
    expect(existsSync(lockDir())).toBe(true);
    expect(JSON.parse(readFileSync(join(lockDir(), "owner"), "utf8")).token).toBe(liveToken);
    live.release();
  });

  it("a stale observation never vacates the path, so a live holder's lock cannot be deleted (Codex 2026-09-12 P#20)", async () => {
    const mine = await acquireProjectWriteLock(root, { timeoutMs: 100 });
    expect(mine.acquired).toBe(true);
    // The lock changed hands while we worked: a different writer owns it now.
    writeFileSync(
      join(lockDir(), "owner"),
      JSON.stringify({ pid: process.pid, host: hostname(), token: "b-is-writing", at: new Date().toISOString() }),
    );
    // …and the moment the canonical path is vacated, a third writer takes it —
    // which is exactly what made the rename-back fail and the live holder's
    // lock get deleted anyway.
    afterNextRename.run = () => {
      mkdirSync(lockDir(), { recursive: true });
      writeFileSync(
        join(lockDir(), "owner"),
        JSON.stringify({ pid: process.pid, host: hostname(), token: "c-came-later", at: new Date().toISOString() }),
      );
    };

    mine.release();

    // The path was never vacated on our stale observation, so the third writer
    // never got in and B still holds its lock.
    expect(afterNextRename.run).toBeDefined();
    expect(existsSync(lockDir())).toBe(true);
    expect(JSON.parse(readFileSync(join(lockDir(), "owner"), "utf8")).token).toBe("b-is-writing");
    afterNextRename.run = undefined;
  });

  it("one reclaim decision at a time: a lock is not broken under a reclaimer that is mid-flight (Codex 2026-09-12 P#20)", async () => {
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(
      join(lockDir(), "owner"),
      JSON.stringify({ pid: 2 ** 30, host: hostname(), token: "dead", at: new Date().toISOString() }),
    );
    mkdirSync(`${lockDir()}.reclaiming`, { recursive: true }); // another reclaimer is deciding

    const denied = await acquireProjectWriteLock(root, { timeoutMs: 300, staleMs: 10 * 60_000 });

    expect(denied.acquired).toBe(false);
    expect(JSON.parse(readFileSync(join(lockDir(), "owner"), "utf8")).token).toBe("dead");

    // A reclaimer that died holding the decision does not block forever.
    rmSync(`${lockDir()}.reclaiming`, { recursive: true, force: true });
    const taken = await acquireProjectWriteLock(root, { timeoutMs: 2_000, staleMs: 10 * 60_000 });
    expect(taken.acquired).toBe(true);
    taken.release();
  });
});
