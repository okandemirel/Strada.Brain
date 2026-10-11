/**
 * A FILESYSTEM'S CLOCK TICKS, AND A REWRITE INSIDE ONE TICK MOVES NO STAMP —
 * the lease's half of 980b16d5.
 *
 * Every question a lease commit asks of its seed is a stamp comparison: did
 * the AGENT touch this lease file (leaseSeed), did a PERSON change the
 * project's copy while the agent ran (sourceSeed), may the agent's deletion
 * go through. NTFS stamps a write with the system clock's ~15.6 ms tick, HFS+
 * and ext3 keep whole seconds and FAT two, so a same-length rewrite inside
 * the tick of the write before it keeps size, mtime and ctime and answers
 * "unchanged" for bytes that changed.
 *
 * This machine's filesystem is finer than a test can wait out, so every
 * fs.promises stat the lease manager makes reports mtime and ctime rounded
 * down to a coarse tick, as HFS+ would: the clock still runs, it just ticks
 * every TICK_MS. Each test starts at the beginning of a tick so its writes
 * share one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { runProcess } from "../../utils/process-runner.js";
import { WorkspaceLeaseManager, readLeaseSeed, writeLeaseSeed, type WorkspaceCommandRunner } from "./workspace-lease-manager.js";
import type { SeedStamp } from "./workspace-lease-manager.js";

const TICK_MS = 500;

/** The tick every fs.promises stat rounds its stamps to while set, and what runs just before a chosen stat. */
const fsClock = vi.hoisted(() => {
  const clock = {
    tickMs: undefined as number | undefined,
    /** Runs once, right before the first stat of a path under this prefix. */
    beforeStatUnder: undefined as { prefix: string; run: () => void } | undefined,
    coarse<T>(st: T): T {
      const tick = clock.tickMs;
      if (tick === undefined) return st;
      const s = st as unknown as { mtimeMs: number; ctimeMs: number };
      Object.assign(st as object, {
        mtimeMs: Math.floor(s.mtimeMs / tick) * tick,
        ctimeMs: Math.floor(s.ctimeMs / tick) * tick,
      });
      return st;
    },
  };
  return clock;
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const stat = (async (path: Parameters<typeof actual.promises.stat>[0], opts?: Parameters<typeof actual.promises.stat>[1]) => {
    const hook = fsClock.beforeStatUnder;
    if (hook !== undefined && String(path).startsWith(hook.prefix)) {
      fsClock.beforeStatUnder = undefined;
      hook.run();
    }
    return fsClock.coarse(await actual.promises.stat(path, opts));
  }) as typeof actual.promises.stat;
  return { ...actual, promises: { ...actual.promises, stat } };
});

let source: string;
let leaseRoot: string;

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), "lease-clock-src-"));
  leaseRoot = mkdtempSync(join(tmpdir(), "lease-clock-root-"));
  mkdirSync(join(source, "Assets", "Scripts"), { recursive: true });
  fsClock.tickMs = TICK_MS;
  fsClock.beforeStatUnder = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  fsClock.tickMs = undefined;
  fsClock.beforeStatUnder = undefined;
  rmSync(source, { recursive: true, force: true });
  rmSync(leaseRoot, { recursive: true, force: true });
});

/** Wait for the next tick to begin, so what follows shares one. */
async function startOfTick(): Promise<void> {
  await sleep(TICK_MS - (Date.now() % TICK_MS) + 5);
}

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

/** A runner that does `whenReadingHead` at the moment acquisition reads the project's HEAD: after both seed snapshots. */
function readingHead(whenReadingHead: () => void): WorkspaceCommandRunner {
  let fired = false;
  return async (spec) => {
    if (!fired && spec.args.length === 4 && spec.args[2] === "rev-parse" && spec.args[3] === "HEAD") {
      fired = true;
      whenReadingHead();
    }
    return runProcess(spec);
  };
}

const rel = join("Assets", "Scripts", "Board.cs");

describe("a lease commit on a filesystem whose clock ticks coarsely", () => {
  it("an agent's same-length rewrite inside the seed's tick is the agent's work, and is published", async () => {
    await startOfTick();
    writeFileSync(join(source, rel), "class Board {}", "utf8");
    const lease = await new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false }).acquireLease({
      label: "t",
      forceTempCopy: true,
    });
    writeFileSync(join(lease.path, rel), "class BOARD {}", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.written).toEqual([rel]);
    expect(readFileSync(join(source, rel), "utf8")).toBe("class BOARD {}");
  });

  it("a person's same-length save inside the tick, after the seed was read, is not overwritten", async () => {
    await startOfTick();
    writeFileSync(join(source, rel), "class Board {}", "utf8");
    gitAt(source, "init", "-q");
    gitAt(source, "add", "-A");
    gitAt(source, "commit", "-qm", "init");
    const lease = await new WorkspaceLeaseManager({
      projectRoot: source,
      leaseRoot,
      preferGitWorktree: false,
      commandRunner: readingHead(() => writeFileSync(join(source, rel), "class Mine  {}", "utf8")),
    }).acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, rel), "class Board { int agent; }", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toEqual([rel]);
    expect(result.written).toEqual([]);
    expect(readFileSync(join(source, rel), "utf8")).toBe("class Mine  {}");
  });

  it("a file whose copy kept an old mtime is fresh by its ctime, and a save that puts the mtime back is still seen", async () => {
    await startOfTick();
    const hourAgo = new Date(Date.now() - 3_600_000);
    writeFileSync(join(source, rel), "class Board {}", "utf8");
    utimesSync(join(source, rel), hourAgo, hourAgo);
    gitAt(source, "init", "-q");
    gitAt(source, "add", "-A");
    gitAt(source, "commit", "-qm", "init");
    const lease = await new WorkspaceLeaseManager({
      projectRoot: source,
      leaseRoot,
      preferGitWorktree: false,
      commandRunner: readingHead(() => {
        writeFileSync(join(source, rel), "class Mine  {}", "utf8");
        utimesSync(join(source, rel), hourAgo, hourAgo);
      }),
    }).acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, rel), "class Board { int agent; }", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toEqual([rel]);
    expect(readFileSync(join(source, rel), "utf8")).toBe("class Mine  {}");
  });

  it("a person's same-length save inside the tick, while the lease was being seeded, is not overwritten", async () => {
    await startOfTick();
    writeFileSync(join(source, rel), "class Board {}", "utf8");
    const manager = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false });
    // After the copy, before the post-seed snapshot of the project: the
    // lease's own snapshot is the first stat under the lease root.
    fsClock.beforeStatUnder = { prefix: leaseRoot, run: () => writeFileSync(join(source, rel), "class Mine  {}", "utf8") };
    const lease = await manager.acquireLease({ label: "t", forceTempCopy: true });
    expect(readFileSync(join(lease.path, rel), "utf8")).toBe("class Board {}");
    writeFileSync(join(lease.path, rel), "class Board { int agent; }", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toEqual([rel]);
    expect(readFileSync(join(source, rel), "utf8")).toBe("class Mine  {}");
  });

  /** Let the seed outlast the settle window, after saving `bytes` over the project's copy once the lease was copied. */
  const slowSeed = (bytes?: string): void => {
    const realNow = Date.now.bind(Date);
    fsClock.beforeStatUnder = {
      prefix: leaseRoot,
      run: () => {
        if (bytes !== undefined) writeFileSync(join(source, rel), bytes, "utf8");
        // A Unity tree's copy takes longer than the window: the post-seed
        // walk finds a stamp that the pre-seed walk found fresh settled.
        vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6_000);
      },
    };
  };

  it("a person's same-length save inside the tick while seeding is not overwritten when the seed outlasts the settle window", async () => {
    await startOfTick();
    writeFileSync(join(source, rel), "class Board {}", "utf8");
    const manager = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false });
    slowSeed("class Mine  {}");
    const lease = await manager.acquireLease({ label: "t", forceTempCopy: true });
    expect(readFileSync(join(lease.path, rel), "utf8")).toBe("class Board {}");
    writeFileSync(join(lease.path, rel), "class Board { int agent; }", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toEqual([rel]);
    expect(readFileSync(join(source, rel), "utf8")).toBe("class Mine  {}");
  });

  it("a file nobody saved while a slow seed ran is still the agent's to publish", async () => {
    await startOfTick();
    writeFileSync(join(source, rel), "class Board {}", "utf8");
    const manager = new WorkspaceLeaseManager({ projectRoot: source, leaseRoot, preferGitWorktree: false });
    slowSeed();
    const lease = await manager.acquireLease({ label: "t", forceTempCopy: true });
    writeFileSync(join(lease.path, rel), "class Board { int agent; }", "utf8");

    const result = await lease.commit();
    await lease.release();

    expect(result.conflicts).toEqual([]);
    expect(result.written).toEqual([rel]);
    expect(readFileSync(join(source, rel), "utf8")).toBe("class Board { int agent; }");
  });

  it("a deletion does not take a file a person saved inside the tick after the seed was read", async () => {
    await startOfTick();
    const scene = join("Assets", "InitTestScene4abd18f9.unity");
    writeFileSync(join(source, scene), "scene", "utf8");
    writeFileSync(join(source, `${scene}.meta`), "meta", "utf8");
    gitAt(source, "init", "-q");
    gitAt(source, "add", "-A");
    gitAt(source, "commit", "-qm", "campaign: Sprint 1 — foundations");
    const lease = await new WorkspaceLeaseManager({
      projectRoot: source,
      leaseRoot,
      preferGitWorktree: false,
      commandRunner: readingHead(() => writeFileSync(join(source, scene), "SCENE", "utf8")),
    }).acquireLease({ label: "t", forceTempCopy: true });
    rmSync(join(lease.path, scene));
    rmSync(join(lease.path, `${scene}.meta`));

    const result = await lease.commit();
    await lease.release();

    expect(result.deleted).toEqual([]);
    expect(readFileSync(join(source, scene), "utf8")).toBe("SCENE");
    expect(existsSync(join(source, `${scene}.meta`))).toBe(true);
  });
});

describe("the seed a crashed owner's salvage commits from", () => {
  it("keeps the bytes' hash of a stamp too fresh to vouch for them", () => {
    const lease = join(leaseRoot, "t-00000000-0000-0000-0000-000000000000");
    mkdirSync(lease, { recursive: true });
    const fresh: SeedStamp = { m: 1, s: 5, c: 2, h: "a".repeat(64) };
    const settled: SeedStamp = { m: 1, s: 5, c: 2 };
    writeLeaseSeed(lease, {
      seedHead: undefined,
      leaseSeed: new Map(),
      sourceSeed: new Map([["fresh.cs", fresh], ["settled.cs", settled]]),
    });

    const seed = readLeaseSeed(lease)!;

    expect(seed.sourceSeed.get("fresh.cs")).toEqual(fresh);
    expect(seed.sourceSeed.get("settled.cs")).toEqual(settled);
  });
});
