/**
 * A FILESYSTEM'S CLOCK TICKS, AND A REWRITE INSIDE ONE TICK MOVES NO STAMP —
 * the project fingerprint's half of 980b16d5.
 *
 * A project without git binds its requirement closures to projectFingerprint(),
 * a hash of every file's size, mtime and ctime. NTFS stamps a write with the
 * system clock's ~15.6 ms tick, HFS+ and ext3 keep whole seconds and FAT two:
 * a same-length rewrite inside the tick of the write before it leaves the
 * fingerprint where it was, so the audit's before/after guard accepted a tree
 * that changed under it and the closure stood for bytes nobody judged.
 *
 * This machine's filesystem is finer than a test can wait out, so the bigint
 * stats the walk makes report a clock that has not ticked, and the wall clock
 * the walk measures freshness against is held still.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "./campaign-manager.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { Campaign } from "./types.js";
import type { TaskManager } from "../tasks/task-manager.js";

/** The stamps every bigint stat reports while set, and how many files were opened. */
const fsClock = vi.hoisted(() => {
  const clock = {
    mtimeNs: undefined as bigint | undefined,
    ctimeNs: undefined as bigint | undefined,
    opens: 0,
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
    fsClock.opens++;
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  return { ...actual, statSync, openSync };
});

const SECOND_NS = 1_000_000_000n;
const NOW_MS = Date.now();
const NOW_NS = BigInt(NOW_MS) * 1_000_000n;
const stampAll = (ns: bigint | undefined): void => {
  fsClock.mtimeNs = ns;
  fsClock.ctimeNs = ns;
};

describe("the project fingerprint on a filesystem whose clock ticks coarsely", () => {
  let project: string;
  let state: string;
  const managers: CampaignManager[] = [];

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "fp-clock-project-"));
    state = mkdtempSync(join(tmpdir(), "fp-clock-state-"));
    mkdirSync(join(project, "Assets"), { recursive: true });
    writeFileSync(join(project, "Assets", "Game.cs"), "class Game { int x = 1; }");
    stampAll(undefined);
    fsClock.opens = 0;
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    stampAll(undefined);
    for (const m of managers.splice(0)) m.dispose();
    rmSync(project, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const manager = (resolveCoverageGaps?: (gdd: string, reqs: readonly string[]) => Promise<unknown>): CampaignManager => {
    const m = new CampaignManager({
      storage: new CampaignStorage(join(state, "campaigns.db")),
      planner: { planMilestones: vi.fn(), auditCoverage: vi.fn().mockResolvedValue([]), resolveCoverageGaps } as unknown as CampaignPlanner,
      taskManager: new EventEmitter() as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: project,
    });
    managers.push(m);
    return m;
  };
  const fingerprintOf = (m: CampaignManager): string => (m as unknown as { projectFingerprint(): string }).projectFingerprint();

  it("a same-length rewrite inside one tick moves the fingerprint", () => {
    // Every write until the tick ends carries this stamp.
    stampAll(NOW_NS);
    const m = manager();
    const first = fingerprintOf(m);
    expect(first).toMatch(/^fp:[0-9a-f]{64}$/);
    // The same bytes are the same tree, so a fresh tree still binds a closure.
    expect(fingerprintOf(m)).toBe(first);
    writeFileSync(join(project, "Assets", "Game.cs"), "class Game { int x = 2; }");
    expect(fingerprintOf(m)).not.toBe(first);
  });

  it("an audit across a same-length rewrite inside one tick closes nothing", async () => {
    stampAll(NOW_NS);
    const m = manager(async (_gdd, reqs) => {
      // The implementation changes while the audit is judging the old one.
      writeFileSync(join(project, "Assets", "Game.cs"), "class Game { int x = 2; }");
      return { closed: [...reqs], open: [] };
    });
    const campaign = {
      id: "c_fp_tick", chatId: "chat1", channelType: "cli", userId: "u", projectRoot: project, draftAttempts: 0,
      gddText: "# GDD", gddPath: "docs/Game_GDD.md", state: "executing", currentMilestone: 0,
      createdAt: NOW_MS, updatedAt: NOW_MS,
      milestones: [{ id: "mcov1-0", title: "Req1", prompt: "p", status: "failed", attempts: 1, coverageGap: "Req1: absent" }],
    } as unknown as Campaign;
    const openRequirements = (m as unknown as {
      openRequirements(c: Campaign): Promise<{ open: string[] }>;
    }).openRequirements.bind(m);

    const result = await openRequirements(campaign);

    expect(campaign.milestones[0]!.coverageClosed).not.toBe(true);
    expect(result.open).toEqual(["Req1: absent"]);
  });

  it("a tree that settled before the walk is fingerprinted by its stamps alone", () => {
    stampAll(NOW_NS - 3600n * SECOND_NS);
    const m = manager();
    fsClock.opens = 0;
    const settled = fingerprintOf(m);
    expect(settled).toMatch(/^fp:[0-9a-f]{64}$/);
    expect(fingerprintOf(m)).toBe(settled);
    expect(fsClock.opens).toBe(0);
    // …and a file whose ctime is fresh is read, whatever its mtime says: a
    // copy that preserved an old mtime changed the file just now.
    fsClock.ctimeNs = NOW_NS;
    const copied = fingerprintOf(m);
    expect(fsClock.opens).toBe(1);
    writeFileSync(join(project, "Assets", "Game.cs"), "class Game { int x = 2; }");
    expect(fingerprintOf(m)).not.toBe(copied);
  });
});
