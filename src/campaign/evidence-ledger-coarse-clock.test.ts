/**
 * A FILESYSTEM'S CLOCK TICKS, AND A REWRITE INSIDE ONE TICK MOVES NO STAMP.
 *
 * windows-test at 2f8041bc: an Android expansion file rewritten at the same
 * size right after its .apk was hashed left artifactDigest where it was. NTFS
 * stamps a write with the system clock's ~15.6 ms tick, so the rewrite kept
 * size, mtime, ctime and inode, and the remembered digest (CMP-11) was served
 * for bytes nobody read. HFS+ and ext3 keep whole seconds and FAT two, so any
 * machine whose disk is coarse enough serves the old game's digest the same way.
 *
 * This machine's filesystem is finer than a test can wait out, so the stat
 * calls the digest makes report a clock that has not ticked: every file
 * stamped with one instant, as FAT would stamp writes inside one two-second
 * tick. The wall clock the freshness rule measures against is held still,
 * so how long a test takes never decides whether a stamp has settled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDigest, artifactDigestAsync } from "./evidence-ledger.js";

/** The stamps every bigint stat reports while set, and how many files were opened for reading. */
const fsClock = vi.hoisted(() => {
  const clock = {
    mtimeNs: undefined as bigint | undefined,
    ctimeNs: undefined as bigint | undefined,
    reads: 0,
    pin<T>(st: T): T {
      if (clock.mtimeNs !== undefined && clock.ctimeNs !== undefined && typeof (st as { mtimeNs?: unknown })?.mtimeNs === "bigint") {
        Object.assign(st as object, { mtimeNs: clock.mtimeNs, ctimeNs: clock.ctimeNs });
      }
      return st;
    },
  };
  return clock;
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const statSync = ((...args: Parameters<typeof actual.statSync>) => fsClock.pin(actual.statSync(...args))) as typeof actual.statSync;
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    fsClock.reads++;
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  const createReadStream = ((...args: Parameters<typeof actual.createReadStream>) => {
    fsClock.reads++;
    return actual.createReadStream(...args);
  }) as typeof actual.createReadStream;
  return { ...actual, statSync, openSync, createReadStream };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = (async (...args: Parameters<typeof actual.stat>) => fsClock.pin(await actual.stat(...args))) as typeof actual.stat;
  return { ...actual, stat };
});

const HEX = /^[0-9a-f]{64}$/;
const SECOND_NS = 1_000_000_000n;
const NOW_MS = Date.now();
const nowNs = (): bigint => BigInt(NOW_MS) * 1_000_000n;
const stampAll = (ns: bigint | undefined): void => {
  fsClock.mtimeNs = ns;
  fsClock.ctimeNs = ns;
};

describe("artifactDigest on a filesystem whose clock ticks coarsely", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artifact-digest-clock-"));
    stampAll(undefined);
    fsClock.reads = 0;
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    stampAll(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  const android = (): string => {
    const at = join(dir, "android");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "Game.apk"), "the apk");
    writeFileSync(join(at, "Game.main.obb"), "the data");
    return join(at, "Game.apk");
  };

  it("an expansion file rewritten at the same size inside one tick is read again (windows-test 2f8041bc)", async () => {
    // The oldest stamp a write in a FAT disk's current tick can carry: the
    // tick began two seconds ago, and every write until it ends gets this.
    stampAll(nowNs() - 2n * SECOND_NS);
    const apk = android();
    const walked = artifactDigest(apk);
    expect(walked).toMatch(HEX);
    writeFileSync(join(dir, "android", "Game.main.obb"), "THE DATA");
    const changed = artifactDigest(apk);
    expect(changed).not.toBe(walked);
    // The async walk shares the memory, and must not serve it either.
    expect(await artifactDigestAsync(apk)).toBe(changed);
    writeFileSync(join(dir, "android", "Game.main.obb"), "the data");
    expect(await artifactDigestAsync(apk)).toBe(walked);
    expect(artifactDigest(apk)).toBe(walked);
  });

  it("a player's data file rewritten inside one tick is read again, first through the async walk", async () => {
    stampAll(nowNs());
    const build = join(dir, "linux");
    mkdirSync(join(build, "Game_Data"), { recursive: true });
    writeFileSync(join(build, "Game.x86_64"), "the executable");
    writeFileSync(join(build, "Game_Data", "level0"), "level one");
    const exe = join(build, "Game.x86_64");
    const before = await artifactDigestAsync(exe);
    expect(before).toMatch(HEX);
    writeFileSync(join(build, "Game_Data", "level0"), "level two");
    expect(await artifactDigestAsync(exe)).not.toBe(before);
    expect(artifactDigest(exe)).not.toBe(before);
  });

  it("a file whose copy kept an old mtime is fresh by its ctime, and is read again", () => {
    // A timestamp-preserving copy: the mtime is an hour old, the ctime is the
    // copy's, inside the current tick. Freshness is the later of the two.
    fsClock.mtimeNs = nowNs() - 3600n * SECOND_NS;
    fsClock.ctimeNs = nowNs() - 2n * SECOND_NS;
    const apk = android();
    const walked = artifactDigest(apk);
    expect(walked).toMatch(HEX);
    writeFileSync(join(dir, "android", "Game.main.obb"), "THE DATA");
    expect(artifactDigest(apk)).not.toBe(walked);
  });

  it("an artifact that settled long before it was hashed is still served from memory (CMP-11)", async () => {
    stampAll(nowNs() - 3600n * SECOND_NS);
    const apk = android();
    const first = artifactDigest(apk);
    expect(first).toMatch(HEX);
    expect(fsClock.reads).toBe(2); // the .apk and its .obb, once each
    fsClock.reads = 0;
    expect(artifactDigest(apk)).toBe(first);
    expect(await artifactDigestAsync(apk)).toBe(first);
    expect(fsClock.reads).toBe(0);
    // …and a remembered digest is still not served once a file changed: a
    // same-size rewrite with its mtime put back moves only ctime.
    writeFileSync(join(dir, "android", "Game.main.obb"), "THE DATA");
    fsClock.ctimeNs = nowNs();
    expect(artifactDigest(apk)).not.toBe(first);
    expect(fsClock.reads).toBe(2);
  });
});
