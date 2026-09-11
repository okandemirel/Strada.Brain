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

describe("a verdict is evidence, not a claim (Codex 2026-09-11 B#3, B#25)", () => {
  it("ok WITHOUT play behind it is not ok, and says what is missing", () => {
    // No action taken: nothing was played, whatever the file claims.
    write({ ok: true, reasons: [], record: { scene: "Entry", session: 1, actions: 0, outcome: "None" }, frames: { count: 5 } });
    const noPlay = readPlaythroughVerdict(root, 0);
    expect(noPlay).toMatchObject({ found: true, ok: false });
    expect(noPlay.reasons?.join(" ")).toContain("took no action");

    // A session the game REFUSED to start is not play (Codex 2026-09-11 C#11).
    write({ ok: true, reasons: [], record: { scene: "Entry", session: 1, actions: 0, outcome: "Refused", startAccepted: false }, frames: { count: 3 } });
    expect(readPlaythroughVerdict(root, 0)).toMatchObject({ found: true, ok: false });

    // …and an ENDLESS game has no outcome to reach: driven actions and
    // captured frames are the evidence (C#14).
    write({ ok: true, reasons: [], record: { scene: "Endless", session: 1, actions: 240, outcome: "None" }, frames: { count: 30 } });
    expect(readPlaythroughVerdict(root, 0)).toMatchObject({ found: true, ok: true });

    // Fractional counts are impossible records (Codex 2026-09-11 D#30).
    write({ ok: true, reasons: [], record: { scene: "Entry", session: 1, actions: 0.5, outcome: "Won" }, frames: { count: 0.5 } });
    expect(readPlaythroughVerdict(root, 0)).toMatchObject({ found: true, ok: false });

    write({ ok: true, reasons: [], record: { scene: "Entry", session: 1, actions: 12, outcome: "Won" }, frames: { count: 0 } });
    const noFrames = readPlaythroughVerdict(root, 0);
    expect(noFrames).toMatchObject({ found: true, ok: false });
    expect(noFrames.reasons?.join(" ")).toContain("records no captured frame");

    write({ ok: true, reasons: [] }); // the bare claim Codex reproduced
    expect(readPlaythroughVerdict(root, 0)).toMatchObject({ found: true, ok: false });

    write(ok);
    expect(readPlaythroughVerdict(root, 0)).toMatchObject({ found: true, ok: true, outcome: "Won" });
  });

  it("a file whose stored mtime lands a fraction BEFORE the sprint start is fresh; a real earlier verdict is still stale", () => {
    // Node's utimes path truncates the converted timestamp to microseconds, so
    // a file touched in the same millisecond reads a hair older than the clock
    // it is compared against (Codex 2026-09-11 B#25 — CI coverage job).
    const path = write(ok);
    const t = Date.now();
    const justBefore = new Date(t - 1);
    utimesSync(path, justBefore, justBefore);
    expect(readPlaythroughVerdict(root, t)).toMatchObject({ found: true, ok: true });
    // Ten milliseconds is not truncation: that verdict predates the sprint.
    expect(readPlaythroughVerdict(root, t + 10)).toMatchObject({ found: false, stale: true });
  });
});

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

  it("the runtime dump rides along in the evidence (2026-09-10)", () => {
    write({ ...ok, record: { ...ok.record, runtime: { renderers: 3, worldRenderers: 2, spriteRenderers: 2, meshRenderers: 0, canvases: 1, particleSystems: 0, audioSources: 1, audioPlaying: 0, sprites: ["pig"], meshes: [], primitiveMeshes: 0 } } });
    expect(readPlaythroughVerdict(root, 0).runtime).toEqual({ renderers: 3, worldRenderers: 2, spriteRenderers: 2, meshRenderers: 0, canvases: 1, particleSystems: 0, audioSources: 1, audioPlaying: 0, sprites: ["pig"], meshes: [], primitiveMeshes: 0 });
    write(ok);
    expect(readPlaythroughVerdict(root, 0).runtime).toBeUndefined();
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
