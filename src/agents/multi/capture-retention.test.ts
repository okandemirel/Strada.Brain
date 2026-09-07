import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_MARKER_FILE, markCaptureEntry, pruneCaptureEntries } from "./capture-retention.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "capture-retention-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function capture(name: string, ageMinutes: number, frames = 3, marked = true): void {
  const dir = join(root, "Recordings", name);
  mkdirSync(dir, { recursive: true });
  if (marked) writeFileSync(join(dir, CAPTURE_MARKER_FILE), "lease");
  const t = new Date(Date.now() - ageMinutes * 60_000);
  for (let i = 0; i < frames; i++) {
    const f = join(dir, `frame_${i}.png`);
    writeFileSync(f, "x".repeat(100));
    utimesSync(f, t, t);
  }
  utimesSync(dir, t, t);
}

describe("pruneCaptureEntries", () => {
  it("keeps the newest entries and reports what it removed", () => {
    // Measured 2026-09-07: 441 entries, 32,760 frames, 1.2 GB, nothing ever removed.
    for (let i = 0; i < 30; i++) capture(`old_${String(i).padStart(2, "0")}`, 60 * 24 + i);
    capture("this_run", 1);
    capture("last_run", 30);

    const result = pruneCaptureEntries(root, 25);

    expect(result).toEqual({ removed: 7, bytes: 7 * (3 * 100 + "lease".length), kept: 25, unmarked: 0 });
    expect(existsSync(join(root, "Recordings", "this_run"))).toBe(true);
    expect(existsSync(join(root, "Recordings", "last_run"))).toBe(true);
    // The oldest went, the newest of the old ones stayed.
    expect(existsSync(join(root, "Recordings", "old_29"))).toBe(false);
    expect(existsSync(join(root, "Recordings", "old_00"))).toBe(true);
  });

  it("does nothing below the limit and without a Recordings/ directory", () => {
    expect(pruneCaptureEntries(root)).toEqual({ removed: 0, bytes: 0, kept: 0, unmarked: 0 });
    capture("a", 5);
    capture("b", 4);
    expect(pruneCaptureEntries(root, 25)).toEqual({ removed: 0, bytes: 0, kept: 2, unmarked: 0 });
  });

  it("never prunes an entry without the lease marker — Recordings/ is also the user's Recorder folder", () => {
    // Review 2026-09-07: a no-op commit deleted the five oldest of a user's
    // thirty Recorder takes.
    for (let i = 0; i < 30; i++) capture(`take_${String(i).padStart(2, "0")}`, 60 * 24 + i, 1, false);
    for (let i = 0; i < 27; i++) capture(`lease_${String(i).padStart(2, "0")}`, 60 + i);
    const result = pruneCaptureEntries(root, 25);
    expect(result.removed).toBe(2);
    expect(result.unmarked).toBe(30);
    for (let i = 0; i < 30; i++) expect(existsSync(join(root, "Recordings", `take_${String(i).padStart(2, "0")}`))).toBe(true);
    // markCaptureEntry turns a plain directory into a prunable one.
    markCaptureEntry(root, "take_29");
    expect(existsSync(join(root, "Recordings", "take_29", CAPTURE_MARKER_FILE))).toBe(true);
  });
});
