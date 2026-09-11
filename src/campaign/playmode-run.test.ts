/**
 * The NUnit-derived run record the campaign reads ahead of the tool's prose.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PLAYMODE_RUN_RECORD_REL, readPlaymodeRun } from "./playmode-run.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "playmode-run-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function write(record: Record<string, unknown>, ageMs = 0): void {
  mkdirSync(join(root, "Recordings", "tests"), { recursive: true });
  const p = join(root, PLAYMODE_RUN_RECORD_REL);
  writeFileSync(p, JSON.stringify(record));
  if (ageMs > 0) { const t = new Date(Date.now() - ageMs); utimesSync(p, t, t); }
}

describe("readPlaymodeRun — a record is counts that add up (Codex 2026-09-11 B#7)", () => {
  it("all-skipped is not green, a filter beside `unfiltered` wins, and counts that do not add up are not a run", () => {
    write({ total: 10, passed: 0, failed: 0, skipped: 10, unfiltered: true, filter: "OnlyOne" });
    const skipped = readPlaymodeRun(root, 0);
    expect(skipped).toMatchObject({ found: true, green: false, unfiltered: false });
    expect(skipped.detail).toContain("NONE ran to a pass");

    write({ total: 100, passed: 3, failed: 0, skipped: 0, unfiltered: true });
    expect(readPlaymodeRun(root, 0)).toMatchObject({ found: true, green: false });

    write({ total: 215, passed: 215, failed: 0, skipped: 0, unfiltered: true });
    expect(readPlaymodeRun(root, 0)).toMatchObject({ found: true, green: true, unfiltered: true });

    // Counts that are not whole non-negative numbers are not a run record
    // (Codex 2026-09-11 C#13): "2 of 1 tests passed" was green.
    write({ total: 1, passed: 2, failed: 0, skipped: -1, unfiltered: true });
    expect(readPlaymodeRun(root, 0)).toMatchObject({ found: true, green: false });
    // `categories` narrows a run exactly as `filter` does.
    // An invalid explicit field is not an absent one (Codex 2026-09-11 D#31).
    write({ total: 10, failed: 0, passed: "0", skipped: "10", unfiltered: true });
    expect(readPlaymodeRun(root, 0)).toMatchObject({ found: true, green: false });

    write({ total: 2, passed: 2, failed: 0, skipped: 0, unfiltered: true, categories: "Smoke" });
    expect(readPlaymodeRun(root, 0)).toMatchObject({ found: true, green: true, unfiltered: false });
  });
});

describe("readPlaymodeRun", () => {
  it("absent and stale are not evidence", () => {
    expect(readPlaymodeRun(root, 0)).toEqual({ found: false });
    write({ total: 10, passed: 10, failed: 0, unfiltered: true }, 3_600_000);
    expect(readPlaymodeRun(root, Date.now() - 60_000)).toMatchObject({ found: false, stale: true });
  });

  it("green, unfiltered — the sentence the gate prints comes from the counts and the arguments", () => {
    write({ total: 179, passed: 179, failed: 0, skipped: 0, failedNames: [], filter: null, categories: null, unfiltered: true, measuredAt: "2026-09-10T15:00:00.000Z" });
    const r = readPlaymodeRun(root, 0);
    expect(r).toMatchObject({ found: true, total: 179, failed: 0, unfiltered: true });
    expect(r.detail).toBe("PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)");
  });

  it("red with names, and a filtered run says which filter", () => {
    write({ total: 215, passed: 205, failed: 10, failedNames: ["A.B.WinLevel_ReachesWonState", "A.B.Other"], filter: "PixelFlow.*", unfiltered: false });
    const r = readPlaymodeRun(root, 0);
    expect(r.detail).toBe("PlayMode verification FAILED: 10 of 215 tests failed (filter: PixelFlow.*)");
    expect(r.failedNames).toEqual(["A.B.WinLevel_ReachesWonState", "A.B.Other"]);
    expect(r.unfiltered).toBe(false);
    write({ total: 0, passed: 0, failed: 0, unfiltered: true });
    expect(readPlaymodeRun(root, 0).detail).toBe("PlayMode run (NUnit): 0 tests executed (unfiltered — the whole PlayMode suite)");
  });
});
