/**
 * The NUnit-derived run record the campaign reads ahead of the tool's prose.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLOCK_SKEW_TOLERANCE_MS, PLAYMODE_RUN_RECORD_REL, readPlaymodeRun } from "./playmode-run.js";

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

describe("a record that is not a run record, and a run that is not this attempt's (Codex 2026-09-11 E#1, E#8)", () => {
  it("never throws on a malformed record, and says malformed rather than silent", () => {
    mkdirSync(join(root, "Recordings", "tests"), { recursive: true });
    const p = join(root, PLAYMODE_RUN_RECORD_REL);
    for (const body of ["null", "42", "[]", "{", '"green"']) {
      writeFileSync(p, body);
      const run = readPlaymodeRun(root, 0);
      expect(run).toMatchObject({ found: false, malformed: true });
      expect(run.green).toBeUndefined();
    }
    // A record missing EITHER count is malformed, not absent (G#16: the
    // fixtures all lacked `total`, so the `failed` half of the guard was
    // never exercised).
    writeFileSync(p, JSON.stringify({ passed: 42, unfiltered: true }));
    expect(readPlaymodeRun(root, 0)).toMatchObject({ found: false, malformed: true });
    writeFileSync(p, JSON.stringify({ total: 42, passed: 42, unfiltered: true }));
    expect(readPlaymodeRun(root, 0)).toMatchObject({ found: false, malformed: true });
    writeFileSync(p, JSON.stringify({ failed: 0, passed: 42, unfiltered: true }));
    expect(readPlaymodeRun(root, 0)).toMatchObject({ found: false, malformed: true });
  });

  it("a touched file does not refresh yesterday's run: the record's own stamp decides", () => {
    const attemptStart = Date.now() - 60_000;
    // Written NOW (fresh mtime), measured yesterday.
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: new Date(attemptStart - 24 * 3_600_000).toISOString(),
    });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: false, stale: true });

    // The same record measured during the attempt is the proof it claims to be.
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: new Date(attemptStart + 1_000).toISOString(),
    });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: true, green: true });

    // An unparseable or absent stamp is REPORTED as missing: the mtime alone
    // is refreshed by a copy, so the final sprint refuses such a record
    // (Codex 2026-09-11 G#4 — this test used to assert the bypass).
    write({ total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true, measuredAt: "not a date" });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: true, green: true, stampMissing: true });
    write({ total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: true, stampMissing: true });
    // A stamped record carries no such flag.
    write({ total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true, measuredAt: new Date(attemptStart + 1_000).toISOString() });
    expect(readPlaymodeRun(root, attemptStart).stampMissing).toBeUndefined();

    // A runner whose clock is MINUTES behind the coordinator still belongs to
    // this attempt; only a record from another day is stale (G#8).
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: new Date(attemptStart - 2 * 60_000).toISOString(),
    });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: true, green: true });
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: new Date(attemptStart - 30 * 60_000).toISOString(),
    });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: false, stale: true });
    // The window is exactly the declared skew tolerance, neither a
    // millisecond nor an hour (G#16 pinned the old 2 ms as changeable).
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: new Date(attemptStart - (CLOCK_SKEW_TOLERANCE_MS - 1_000)).toISOString(),
    });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: true, green: true });
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: new Date(attemptStart - (CLOCK_SKEW_TOLERANCE_MS + 1_000)).toISOString(),
    });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: false, stale: true });
  });
});

describe("a stamp is not a free pass (Codex 2026-09-11 H#9, H#10, H#11)", () => {
  it("rejects a stamp from the future and reads counts and stamp from ONE read", () => {
    const attemptStart = Date.now() - 60_000;
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: "2099-01-01T00:00:00.000Z",
    });
    // A fabricated future stamp carries no freshness: the final sprint refuses it.
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: true, stampMissing: true });
  });

  it("the file clock is exact and the record's own stamp carries the skew allowance", () => {
    const attemptStart = Date.now();
    // Written BEFORE the attempt began: a previous attempt's result, whatever
    // the record says about itself. This is the cached-result laundering the
    // gate exists for, so the file's own clock gets no allowance.
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: new Date(attemptStart + 1_000).toISOString(),
    }, 60_000);
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: false, stale: true });

    // Written DURING the attempt by a runner whose clock is two minutes
    // behind: the stamp's allowance covers that.
    write({
      total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true,
      measuredAt: new Date(attemptStart - 2 * 60_000).toISOString(),
    });
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: true, green: true });
  });
});

describe("a record names the attempt that asked for it (the open half of Codex F#10 / I#11)", () => {
  it("refuses a record stamped with ANOTHER attempt's run id, and accepts one with none", () => {
    const attemptStart = Date.now() - 60_000;
    const green = { total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true, measuredAt: new Date(attemptStart + 1_000).toISOString() };

    // A tool that does not echo the id yet behaves exactly as before.
    write(green);
    expect(readPlaymodeRun(root, attemptStart, "m3-1-1700000000000")).toMatchObject({ found: true, green: true });

    // The attempt's own id is accepted and carried.
    write({ ...green, runId: "m3-1-1700000000000" });
    expect(readPlaymodeRun(root, attemptStart, "m3-1-1700000000000")).toMatchObject({ found: true, green: true, runId: "m3-1-1700000000000" });

    // Another attempt's record is not this attempt's proof, however fresh.
    write({ ...green, runId: "m3-0-1600000000000" });
    expect(readPlaymodeRun(root, attemptStart, "m3-1-1700000000000")).toMatchObject({ found: false, stale: true });

    // With no expectation, an id changes nothing.
    expect(readPlaymodeRun(root, attemptStart)).toMatchObject({ found: true, green: true });
  });
});
