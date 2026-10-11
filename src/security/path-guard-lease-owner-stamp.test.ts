/**
 * THE LEASE OWNER FILE IS REMEMBERED ONLY WHILE ITS STAMP STILL VOUCHES FOR IT.
 *
 * leaseOwnerRootOf kept the parsed owner keyed on the file's mtime alone. A
 * filesystem stamps in ticks — NTFS ~15.6 ms, HFS+ and ext3 a second, FAT
 * two — so a lease path re-used for another checkout inside one tick, a
 * rewrite whose mtime was put back, or a file replaced by another left the
 * key where it was, and redirectRealCheckoutPath kept rewriting the OLD
 * checkout's paths into the lease while refusing the new one's (review
 * evidence-ledger-windows, the sibling of windows-test 2f8041bc).
 *
 * This machine's filesystem is finer than a test can wait out, so the stat
 * calls on the owner file report a clock the test sets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PATH_GUARD_CACHE_MAX_ROOTS, leaseOwnerRootOf, pathGuardCacheSizes, redirectRealCheckoutPath } from "./path-guard.js";

const OWNER = ".strada-lease-owner.json";

/** The stamps the owner file's stat reports while set, and how often it was read. */
const fsClock = vi.hoisted(() => {
  const clock = {
    mtimeNs: undefined as bigint | undefined,
    ctimeNs: undefined as bigint | undefined,
    reads: 0,
    pin<T>(path: unknown, st: T): T {
      const { mtimeNs, ctimeNs } = clock;
      if (mtimeNs === undefined || ctimeNs === undefined || !String(path).endsWith(".strada-lease-owner.json")) return st;
      if (typeof (st as { mtimeNs?: unknown })?.mtimeNs === "bigint") {
        Object.assign(st as object, { mtimeNs, ctimeNs, mtimeMs: mtimeNs / 1_000_000n, ctimeMs: ctimeNs / 1_000_000n });
      } else {
        Object.assign(st as object, { mtimeMs: Number(mtimeNs) / 1e6, ctimeMs: Number(ctimeNs) / 1e6 });
      }
      return st;
    },
  };
  return clock;
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const statSync = ((...args: Parameters<typeof actual.statSync>) => fsClock.pin(args[0], actual.statSync(...args))) as typeof actual.statSync;
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]).endsWith(".strada-lease-owner.json")) fsClock.reads++;
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, statSync, readFileSync };
});

const SECOND_NS = 1_000_000_000n;
const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;
const stamp = (mtimeNs: bigint | undefined, ctimeNs = mtimeNs): void => {
  fsClock.mtimeNs = mtimeNs;
  fsClock.ctimeNs = ctimeNs;
};
// Two checkouts whose owner records are the same size.
const GAME_A = resolve("/Users/x/GameA");
const GAME_B = resolve("/Users/x/GameB");
const ownerRecord = (projectRoot: string): string => JSON.stringify({ pid: 1, startedAt: 0, projectRoot });

describe("leaseOwnerRootOf on a filesystem whose clock ticks coarsely", () => {
  let lease: string;
  beforeEach(() => {
    lease = mkdtempSync(join(tmpdir(), "lease-owner-stamp-"));
    stamp(undefined);
    fsClock.reads = 0;
  });
  afterEach(() => {
    stamp(undefined);
    rmSync(lease, { recursive: true, force: true });
  });

  it("names the new checkout when the owner file is rewritten at the same size inside one tick", () => {
    stamp(nowNs());
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_A));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_A);
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_B));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_B);
    expect(redirectRealCheckoutPath(lease, join(GAME_B, "Assets", "a.cs"))).toBe(join("Assets", "a.cs"));
    expect(redirectRealCheckoutPath(lease, join(GAME_A, "Assets", "a.cs"))).toBeUndefined();
  });

  it("reads a settled owner file again when its ctime moved and its mtime was put back", () => {
    const old = nowNs() - 7200n * SECOND_NS;
    stamp(old);
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_A));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_A);
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_B));
    stamp(old, old + 3600n * SECOND_NS);
    expect(leaseOwnerRootOf(lease)).toBe(GAME_B);
  });

  it("judges a copied owner file by its ctime: an old mtime does not make a fresh file settled", () => {
    // Copied with its mtime preserved, then rewritten inside the same ctime tick.
    stamp(nowNs() - 7200n * SECOND_NS, nowNs());
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_A));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_A);
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_B));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_B);
  });

  it("reads a settled owner file again when its size changed and no stamp moved", () => {
    stamp(nowNs() - 7200n * SECOND_NS);
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_A));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_A);
    const longer = resolve("/Users/x/GameA-next");
    writeFileSync(join(lease, OWNER), ownerRecord(longer));
    expect(leaseOwnerRootOf(lease)).toBe(longer);
  });

  it("reads a settled owner file again when another file replaced it with the same size and stamps", () => {
    stamp(nowNs() - 7200n * SECOND_NS);
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_A));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_A);
    writeFileSync(join(lease, `${OWNER}.tmp`), ownerRecord(GAME_B));
    renameSync(join(lease, `${OWNER}.tmp`), join(lease, OWNER));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_B);
  });

  it("still serves a settled, unchanged owner file from memory", () => {
    stamp(nowNs() - 3600n * SECOND_NS);
    writeFileSync(join(lease, OWNER), ownerRecord(GAME_A));
    expect(leaseOwnerRootOf(lease)).toBe(GAME_A);
    const reads = fsClock.reads;
    expect(leaseOwnerRootOf(lease)).toBe(GAME_A);
    expect(redirectRealCheckoutPath(lease, join(GAME_A, "Assets", "a.cs"))).toBe(join("Assets", "a.cs"));
    expect(fsClock.reads).toBe(reads);
  });

  it("remembers settled owners, and no more of them than the bound (SEC-23)", () => {
    stamp(nowNs() - 3600n * SECOND_NS);
    for (let i = 0; i < PATH_GUARD_CACHE_MAX_ROOTS + 20; i++) {
      const root = join(lease, `task-${i.toString(16)}`);
      mkdirSync(root);
      writeFileSync(join(root, OWNER), ownerRecord(GAME_A));
      expect(leaseOwnerRootOf(root)).toBe(GAME_A);
    }
    expect(pathGuardCacheSizes().leaseOwners).toBe(PATH_GUARD_CACHE_MAX_ROOTS);
  });
});
