import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPlaythroughVerdict, describePlaythrough, playthroughDirective, PLAYTHROUGH_VERDICT_REL, PLAYER_PLAYTHROUGH_VERDICT_REL } from "./playthrough-verdict.js";

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
      "play-through OK in Entry: session 1 played to Won in 12 actions; 5 frames, 0 flat, max motion 31.0%; the game does NOT start play by itself after boot (the driver's StartSession was called); no session catalog (level count not measurable)",
    );
    write({ ...ok, record: { ...ok.record, sessionCount: 12, sessions: [
      { index: 1, startAccepted: true, actions: 12, outcome: "Won", reachedOutcome: true, seconds: 8.5 },
      { index: 2, startAccepted: true, actions: 60, outcome: "None", reachedOutcome: false, seconds: 45 },
      { index: 3, startAccepted: false, actions: 0, outcome: "None", reachedOutcome: false, seconds: 0 },
    ] } });
    const many = readPlaythroughVerdict(root, 0);
    expect(many.sessionCount).toBe(12);
    expect(many.sessions).toEqual([
      { index: 1, outcome: "Won", actions: 12, seconds: 8.5 },
      { index: 2, outcome: "None", actions: 60, seconds: 45 },
      { index: 3, outcome: "Refused", actions: 0, seconds: 0 },
    ]);
    expect(describePlaythrough(many)).toContain("; played 3: #1 Won in 12, #2 None in 60, #3 Refused in 0;");
    expect(describePlaythrough(many)).toMatch(/; catalog 12 session\(s\)$/);
  });

  it("the built player's verdict is read from its own path and names its medium (2026-09-10)", () => {
    mkdirSync(join(root, "Recordings", "player-playthrough"), { recursive: true });
    writeFileSync(join(root, PLAYER_PLAYTHROUGH_VERDICT_REL), JSON.stringify({ ...ok, perf: { medium: "player", bootSeconds: 1.1, playSeconds: 10, playFrames: 600, avgFps: 60, worstFrameMs: 40 } }));
    expect(readPlaythroughVerdict(root, 0)).toEqual({ found: false });
    const e = readPlaythroughVerdict(root, 0, PLAYER_PLAYTHROUGH_VERDICT_REL);
    expect(e.found).toBe(true);
    expect(describePlaythrough(e)).toContain("timing (built player, real rendering): boot 1.1 s, 60.0 fps average over 600 frames, worst frame 40 ms");
  });

  it("timing rides along, named by its medium, and is absent when the verdict has none", () => {
    write({ ...ok, perf: { medium: "editor-playmode-batch", bootSeconds: 2.4, playSeconds: 41.2, playFrames: 1030, avgFps: 25.0, worstFrameMs: 180.2 } });
    const e = readPlaythroughVerdict(root, 0);
    expect(e.perf).toEqual({ medium: "editor-playmode-batch", bootSeconds: 2.4, playSeconds: 41.2, playFrames: 1030, avgFps: 25, worstFrameMs: 180.2 });
    expect(describePlaythrough(e)).toContain("; timing (editor play mode, batch — not the shipped player): boot 2.4 s, 25.0 fps average over 1030 frames, worst frame 180 ms");
    write(ok);
    expect(readPlaythroughVerdict(root, 0).perf).toBeUndefined();
    expect(describePlaythrough(readPlaythroughVerdict(root, 0))).not.toContain("timing");
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
