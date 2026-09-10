import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPlaythroughVerdict, describePlaythrough, playthroughDirective, PLAYTHROUGH_VERDICT_REL } from "./playthrough-verdict.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "playthrough-verdict-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const ok = {
  ok: true, reasons: [],
  record: { scene: "Entry", session: 1, autoStarted: false, actions: 12, outcome: "Won" },
  frames: { count: 5, flat: 0, maxMotionShare: 0.31 }, measuredAt: "2026-09-10T10:00:00.000Z",
};
function write(content: unknown, ageMs = 0): string {
  const path = join(root, PLAYTHROUGH_VERDICT_REL);
  mkdirSync(join(root, "Recordings", "playthrough"), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  if (ageMs > 0) { const t = new Date(Date.now() - ageMs); utimesSync(path, t, t); }
  return path;
}

describe("the play-through verdict the campaign reads back (measured 2026-09-10: delivered green, never played)", () => {
  it("absent, stale and unreadable are three different facts, none of them evidence", () => {
    expect(readPlaythroughVerdict(root, 0)).toEqual({ found: false });
    write(ok, 60 * 60_000);
    expect(readPlaythroughVerdict(root, Date.now() - 60_000)).toMatchObject({ found: false, stale: true });
    write("{not json");
    expect(readPlaythroughVerdict(root, 0)).toMatchObject({ found: false, unreadable: true });
  });

  it("a fresh ok verdict carries the terminal state, the taps, the frames and the auto-start fact", () => {
    write(ok);
    const e = readPlaythroughVerdict(root, Date.now() - 60_000);
    expect(e).toMatchObject({ found: true, ok: true, scene: "Entry", session: 1, outcome: "Won", actions: 12, autoStarted: false });
    expect(e.frames).toEqual({ count: 5, flat: 0, maxMotionShare: 0.31 });
    expect(describePlaythrough(e)).toBe(
      "play-through OK in Entry: session 1 played to Won in 12 actions; 5 frames, 0 flat, max motion 31.0%; the game does NOT start play by itself after boot (the driver's StartSession was called)",
    );
  });

  it("a failed verdict names its reasons, and the directive repeats them", () => {
    write({ ...ok, ok: false, reasons: ["session 1 never ended after 60 actions (phases seen: Playing)", "every frame is flat (one colour): nothing visible was drawn"] });
    const e = readPlaythroughVerdict(root, 0);
    expect(e.ok).toBe(false);
    expect(describePlaythrough(e)).toMatch(/^play-through FAILED in Entry: session 1 never ended.*; every frame is flat/);
    expect(playthroughDirective(e)).toMatch(/^PLAY-THROUGH REQUIRED: the last play-through FAILED: session 1 never ended/);
    expect(playthroughDirective(e)).toContain("Strada.Core.Play.IPlaythroughDriver");
    expect(playthroughDirective(e)).toContain("Run unity_playthrough");
  });

  it("a game with no registered driver is named as unplayable, without the auto-start remark", () => {
    write({ ...ok, ok: false, reasons: ["the game registers no Strada.Core.Play.IPlaythroughDriver — it cannot be played by the framework"], record: { scene: "Entry", session: 1, autoStarted: false, actions: 0, missing: "the game registers no Strada.Core.Play.IPlaythroughDriver — it cannot be played by the framework" } });
    const e = readPlaythroughVerdict(root, 0);
    expect(e.missing).toMatch(/registers no Strada\.Core\.Play\.IPlaythroughDriver/);
    expect(describePlaythrough(e)).not.toContain("does NOT start play by itself");
  });

  it("missing and stale verdicts get their own directive wording", () => {
    expect(playthroughDirective({ found: false })).toMatch(/no play-through of the game as it now stands was observed/);
    expect(playthroughDirective({ found: false, stale: true })).toMatch(/from BEFORE this sprint began/);
    expect(describePlaythrough(undefined)).toMatch(/NOT observed/);
    expect(describePlaythrough({ found: false, stale: true })).toMatch(/predates this sprint/);
  });
});
