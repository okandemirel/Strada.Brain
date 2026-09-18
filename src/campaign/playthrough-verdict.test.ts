import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync , symlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { readPlaythroughVerdict, describePlaythrough, playthroughDirective, PLAYTHROUGH_VERDICT_REL, PLAYER_PLAYTHROUGH_VERDICT_REL } from "./playthrough-verdict.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "playthrough-verdict-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const ok = {
  ok: true, reasons: [],
  record: { scene: "Entry", session: 1, autoStarted: false, actions: 12, outcome: "Won" },
  // A LIVE stamp: the reader holds the writer's own measuredAt to the sprint
  // window now, so a fixed date two days old is correctly stale (R#8).
  frames: { count: 5, flat: 0, maxMotionShare: 0.31 }, measuredAt: new Date().toISOString(),
};
function write(content: unknown, ageMs = 0): string {
  const path = join(root, PLAYTHROUGH_VERDICT_REL);
  mkdirSync(join(root, "Recordings", "playthrough"), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  if (ageMs > 0) { const t = new Date(Date.now() - ageMs); utimesSync(path, t, t); }
  return path;
}

/**
 * The captures a real run leaves beside its verdict. Round 13 #32: without
 * them the verdict's frame count is only a claim, so a fixture that omits them
 * is a fixture of a producer that captured nothing.
 */
function writeFrames(count: number): void {
  mkdirSync(join(root, "Recordings", "playthrough"), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, "Recordings", "playthrough", `frame_${String(i).padStart(5, "0")}.png`), "png");
  }
}

/**
 * The save the run wrote and read back, named by the scenario row.
 *
 * Round 14 #11: the row's `savedStateHash` is the sha256 of THESE BYTES, which
 * is what stops a scenario authenticating itself with some other file the run
 * happened to write (the verdict included).
 */
const SAVE_ARTIFACT = join("Recordings", "playthrough", "save-slot-1.json");
const SAVE_BYTES = '{"level":3,"coins":12}';
const SAVE_SHA256 = createHash("sha256").update(SAVE_BYTES).digest("hex");
function writeSaveArtifact(): void {
  mkdirSync(join(root, "Recordings", "playthrough"), { recursive: true });
  writeFileSync(join(root, SAVE_ARTIFACT), SAVE_BYTES);
}

describe("scenario verdict integration", () => {
  it("carries defensively parsed record.scenarios through the verdict reader", () => {
    write({ ...ok, record: { ...ok.record, scenarios: [null, { id: { toString: null } },
      { id: "win", startAccepted: true, reached: true, reachedOutcome: true, outcome: "Won", actions: 2, frames: { before: 0, after: 1 } },
      { id: "save-load", actions: 0.5, frames: { after: "1" }, reason: { toString: null } },
    ] } });
    writeFrames(5);
    const read = readPlaythroughVerdict(root, 0);
    expect(read.scenarios?.find((row) => row.id === "win")).toMatchObject({ status: "reached", evidence: { actions: 2, frames: { before: 0, after: 1 } } });
    const save = read.scenarios?.find((row) => row.id === "save-load");
    expect(save).toMatchObject({ status: "not-reached", evidence: { frames: {} } });
    expect(save?.evidence).not.toHaveProperty("actions");
    expect(save?.evidence).not.toHaveProperty("reason");
    write({ ...ok, runId: "other", record: { ...ok.record, scenarios: [{ id: "win" }] } });
    expect(readPlaythroughVerdict(root, 0, undefined, "this-attempt")).toEqual({ found: false, stale: true });
  });

  it("old files keep their play result while explicitly reporting scenarios not measured", () => {
    write(ok);
    const read = readPlaythroughVerdict(root, 0);
    expect(read).toMatchObject({ found: true, ok: true, actions: 12, outcome: "Won" });
    expect(read.scenarios?.map((row) => row.status)).toEqual(Array(5).fill("not-measured"));
    expect(describePlaythrough(read)).toContain("scenarios not measured");
    expect(playthroughDirective(read)).toContain("scenarios not measured");
    write({ ...ok, ok: false, reasons: ["flat frames"] });
    expect(readPlaythroughVerdict(root, 0)).toMatchObject({ ok: false, reasons: ["flat frames"] });
  });

  it("gate output gives a human-readable line for shown refused and unmeasured scenarios", () => {
    write({ ...ok, record: { ...ok.record, scenarios: [
      { id: "win", startAccepted: true, reached: true, reachedOutcome: true, outcome: "Won", actions: 2, frames: { before: 0, after: 1 } },
      { id: "save-load", startAccepted: false, reason: "no save driver" },
      { id: "lose", startAccepted: true, reached: false },
    ] } });
    writeFrames(5);
    const read = readPlaythroughVerdict(root, 0);
    for (const output of [describePlaythrough(read), playthroughDirective(read)]) {
      expect(output.split("\n").filter((line) => line.startsWith("scenario "))).toHaveLength(5);
      expect(output).toContain("scenario win: REACHED — win shown; frames #0 → #1");
      expect(output).toContain("scenario save-load: REFUSED — save/load; no save driver");
      expect(output).toContain("scenario menu-to-game: not measured — menu → game");
      expect(output).toContain("scenario lose: NOT REACHED — lose");
      expect(output).toContain("scenario scene-transition: not measured — scene transition");
    }
    expect(describePlaythrough({ found: false })).toContain("scenario win: not measured");
  });
});

describe("a verdict is evidence, not a claim (Codex 2026-09-11 B#3, B#25)", () => {
  it("reports the sha256 of the very bytes it parsed, so a receipt is held against one read (plan 1.3)", () => {
    mkdirSync(join(root, "Recordings", "playthrough"), { recursive: true });
    const bytes = JSON.stringify({ ok: true, reasons: [], record: { actions: 3, outcome: "Won" }, frames: { count: 4 }, measuredAt: new Date().toISOString() });
    writeFileSync(join(root, PLAYTHROUGH_VERDICT_REL), bytes);
    const read = readPlaythroughVerdict(root, 0);
    expect(read.found).toBe(true);
    expect(read.bytesSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

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
      "play-through OK in Entry: session 1 played to Won in 12 actions; 5 frames, 0 flat, max motion 31.0%; the game does NOT start play by itself after boot (the driver's StartSession was called); no session catalog (level count not measurable)\n" +
      "scenarios not measured\nscenario menu-to-game: not measured — menu → game\nscenario win: not measured — win\n" +
      "scenario lose: not measured — lose\nscenario save-load: not measured — save/load\nscenario scene-transition: not measured — scene transition",
    );
    write({ ...ok, record: { ...ok.record, sessionCount: 12, sessions: [
      { index: 1, startAccepted: true, actions: 12, outcome: "Won", reachedOutcome: true, seconds: 8.5, identityVerified: true, requestedIndex: 1, observedIndex: 1 },
      { index: 2, startAccepted: true, actions: 60, outcome: "None", reachedOutcome: false, seconds: 45 },
      { index: 3, startAccepted: false, actions: 0, outcome: "None", reachedOutcome: false, seconds: 0 },
    ] } });
    const many = readPlaythroughVerdict(root, 0);
    expect(many.sessionCount).toBe(12);
    // The writer's own reachedOutcome travels with each session now (T#11).
    expect(many.sessions).toEqual([
      // …and WHICH CONTENT it was, when the producer says (Codex 2026-09-12 X).
      { index: 1, outcome: "Won", actions: 12, seconds: 8.5, reachedOutcome: true, identityVerified: true, requestedIndex: 1, observedIndex: 1 },
      { index: 2, outcome: "None", actions: 60, seconds: 45, reachedOutcome: false },
      { index: 3, outcome: "Refused", actions: 0, seconds: 0, reachedOutcome: false },
    ]);
    expect(describePlaythrough(many)).toContain("; played 3: #1 Won in 12, #2 None in 60, #3 Refused in 0;");
    expect(describePlaythrough(many)).toMatch(/; catalog 12 session\(s\)\n/);
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

describe("whose word a session's identity is (Codex 2026-09-12 AC J1)", () => {
  it("names how many sessions the GAME identified and how many rest on the driver's acceptance", () => {
    write({
      ...ok,
      record: {
        ...ok.record, sessionCount: 3,
        sessions: [
          { index: 1, outcome: "Won", actions: 4, seconds: 5, startAccepted: true, reachedOutcome: true, identityVerified: true, identitySource: "active-session" },
          { index: 2, outcome: "Won", actions: 4, seconds: 5, startAccepted: true, reachedOutcome: true, identityVerified: true, identitySource: "start-acceptance" },
        ],
      },
    });
    const e = readPlaythroughVerdict(root, 0);
    expect(e.sessions?.[1]?.identitySource).toBe("start-acceptance");
    const line = describePlaythrough(e);
    expect(line).toContain("identity: 1 session(s) named by the game, 1 on the driver's acceptance alone");
    // A run whose identities ALL come from the game says nothing of the kind.
    write({
      ...ok,
      record: {
        ...ok.record, sessionCount: 3,
        sessions: [
          { index: 1, outcome: "Won", actions: 4, seconds: 5, startAccepted: true, reachedOutcome: true, identityVerified: true, identitySource: "active-session" },
          { index: 2, outcome: "Won", actions: 4, seconds: 5, startAccepted: true, reachedOutcome: true, identityVerified: true, identitySource: "active-session" },
        ],
      },
    });
    expect(describePlaythrough(readPlaythroughVerdict(root, 0))).not.toContain("acceptance alone");
  });
});

describe("a session record that omits its fields keeps them omitted (Codex 2026-09-11 E#7)", () => {
  it("does not invent index 0 or 0 actions", () => {
    write({
      ...ok,
      record: {
        ...ok.record, sessionCount: 2,
        sessions: [{ outcome: "Won", seconds: 1 }, { index: 1, outcome: "Won", actions: 4, seconds: 2 }],
      },
    });
    const parsed = readPlaythroughVerdict(root, 0);
    expect(parsed.sessions?.[0]).toEqual({ outcome: "Won", seconds: 1 });
    expect(parsed.sessions?.[0]?.index).toBeUndefined();
    expect(parsed.sessions?.[0]?.actions).toBeUndefined();
    expect(parsed.sessions?.[1]).toEqual({ index: 1, outcome: "Won", actions: 4, seconds: 2 });

    // …AND CARRIES THE RUNNER'S OWN FINGERPRINT of what loaded, which is how
    // three "verified" sessions of one level are caught (Codex 2026-09-13
    // AG#1).
    write({
      ...ok,
      record: {
        ...ok.record, sessionCount: 2,
        sessions: [
          { index: 1, outcome: "Won", actions: 4, seconds: 5, contentFingerprint: "aaa-3-7" },
          { index: 2, outcome: "Won", actions: 4, seconds: 5 },
        ],
      },
    });
    const prints = readPlaythroughVerdict(root, 0);
    expect(prints.sessions?.[0]?.contentFingerprint).toBe("aaa-3-7");
    expect(prints.sessions?.[1]?.contentFingerprint).toBeUndefined();

    // …AND DOES NOT INVENT A ZERO-SECOND SESSION. A record with no clock and
    // a record of a session that lasted no time both arrived as 0, so a
    // duration floor could neither fail the one nor disclose the other
    // (Codex 2026-09-12 AC J4.3).
    write({
      ...ok,
      record: {
        ...ok.record, sessionCount: 2,
        sessions: [{ index: 1, outcome: "Won", actions: 4 }, { index: 2, outcome: "Won", actions: 4, seconds: 0 }],
      },
    });
    const clocks = readPlaythroughVerdict(root, 0);
    expect(clocks.sessions?.[0]?.seconds).toBeUndefined();
    expect(clocks.sessions?.[1]?.seconds).toBe(0);

    // An IMPOSSIBLE index is passed through as it is, not clamped into a
    // valid one: clamping -1 to 0 makes it level zero, played (Codex G#16).
    write({
      ...ok,
      record: { ...ok.record, sessionCount: 2, sessions: [{ index: -1, outcome: "Won", actions: 3, seconds: 1 }] },
    });
    expect(readPlaythroughVerdict(root, 0).sessions?.[0]?.index).toBe(-1);
  });
});

describe("a verdict file that is not an object wedged the settlement (Codex 2026-09-11 F#4)", () => {
  it("returns unreadable instead of throwing, for every non-object JSON", () => {
    for (const body of ["null", "7", "[]", '"ok"', "{"]) {
      write(body);
      expect(() => readPlaythroughVerdict(root, 0)).not.toThrow();
      expect(readPlaythroughVerdict(root, 0)).toMatchObject({ found: false, unreadable: true });
    }
  });
});

describe("a verdict's nested fields cannot throw (Codex 2026-09-11 H#12)", () => {
  it("keeps only string reasons", () => {
    write({ ok: false, reasons: [{ toString: null }, "compile failed", 7] });
    const parsed = readPlaythroughVerdict(root, 0);
    expect(parsed.found).toBe(true);
    expect(parsed.reasons).toContain("compile failed");
    expect(parsed.reasons?.length).toBe(1);
    // …whatever shape the file's other fields take.
    write({ ok: true, reasons: { nope: true }, record: { actions: [1] }, frames: { count: { n: 1 } } });
    expect(() => readPlaythroughVerdict(root, 0)).not.toThrow();
    expect(readPlaythroughVerdict(root, 0).ok).toBe(false);
  });
});

describe("a play-through verdict names the attempt that asked for it (Codex F#10 / I#11)", () => {
  it("refuses another attempt's verdict and accepts one with no id", () => {
    write({ ...ok, runId: "m3-1-1700000000000" });
    expect(readPlaythroughVerdict(root, 0, undefined, "m3-1-1700000000000")).toMatchObject({ found: true, ok: true });
    expect(readPlaythroughVerdict(root, 0, undefined, "m3-2-1700000000009")).toMatchObject({ found: false, stale: true });
    // A tool that does not echo the id yet behaves exactly as before.
    write(ok);
    expect(readPlaythroughVerdict(root, 0, undefined, "m3-1-1700000000000")).toMatchObject({ found: true, ok: true });
  });
});

describe("the writer's own stamp, not just the file's mtime (Codex 2026-09-12 R#8)", () => {
  it("refuses a touched file whose measuredAt predates the sprint, or comes from the future", () => {
    // Executed by the reviewer: a touched file carrying a year-2000 stamp was
    // accepted as this sprint's play-through.
    write({ ...ok, measuredAt: "2000-01-01T00:00:00.000Z" });
    expect(readPlaythroughVerdict(root, Date.now() - 60_000)).toMatchObject({ found: false, stale: true });

    write({ ...ok, measuredAt: "2099-01-01T00:00:00.000Z" });
    expect(readPlaythroughVerdict(root, Date.now() - 60_000)).toMatchObject({ found: false, stale: true });

    // A stamp inside the window stands, and so does a file that carries none
    // (a tool that does not stamp yet behaves exactly as before).
    write(ok);
    expect(readPlaythroughVerdict(root, Date.now() - 60_000)).toMatchObject({ found: true, ok: true });
    write({ ...ok, measuredAt: undefined });
    expect(readPlaythroughVerdict(root, Date.now() - 60_000)).toMatchObject({ found: true, ok: true });
  });
});

describe("a contradictory session record is rejected the same way everywhere (Codex 2026-09-12 T#11)", () => {
  it("carries reachedOutcome through the reader, so the level count cannot count it", async () => {
    const { finishedSessionIndices } = await import("./gdd-claims.js");
    write({
      ...ok,
      record: {
        ...ok.record,
        sessionCount: 1,
        sessions: [{ index: 1, startAccepted: true, actions: 1, outcome: "Won", reachedOutcome: false, seconds: 2 }],
      },
    });

    const read = readPlaythroughVerdict(root, Date.now() - 60_000);

    expect(read.sessions?.[0]).toMatchObject({ reachedOutcome: false });
    // The helper rejected this record directly; it used to count once the
    // record had passed through the reader, which dropped the field.
    expect(finishedSessionIndices(read)).toEqual([]);
  });
});

/**
 * AN ABSENT OBSERVATION IS NOT A ZERO ONE (Codex 2026-09-13 AI#7).
 *
 * A game that registers no `IActiveSession` has nothing to observe which
 * session is running; the runner says so with a negative index. Read as zero —
 * the contract's "no session is running" — the record claimed an accepted
 * identity and no session at once, and every receiver called that a
 * contradiction.
 */
describe("the reader keeps absence absent", () => {
  it("drops a negative observed index and keeps a reported zero", () => {
    const session = (observedIndex: number) => ({
      index: 1, startAccepted: true, actions: 9, outcome: "Won", reachedOutcome: true, seconds: 4,
      identityVerified: true, identitySource: "start-acceptance", requestedIndex: 1, observedIndex,
    });
    write({ ...ok, record: { ...ok.record, sessionCount: 1, sessions: [session(-1)] } });
    const unobserved = readPlaythroughVerdict(root, 0);
    expect(unobserved.sessions?.[0]).not.toHaveProperty("observedIndex");
    expect(unobserved.sessions?.[0]).toMatchObject({ identityVerified: true, identitySource: "start-acceptance" });

    // A service that DID answer zero is an observation, and it is kept: the
    // game said no session was running (Codex 2026-09-12 AA#3).
    write({ ...ok, record: { ...ok.record, sessionCount: 1, sessions: [session(0)] } });
    expect(readPlaythroughVerdict(root, 0).sessions?.[0]).toMatchObject({ observedIndex: 0 });
  });

  /**
   * Codex round 13 #32. Every scenario field is written by the producer, so a
   * verdict claiming two frames, indices 0 -> 1, and save ids that match could
   * make save/load READ AS REACHED with no captures and no save on disk at all.
   * The numbers are a claim; the files are the evidence, and this reader knows
   * where to look.
   */
  it("refuses a scenario whose captures and save artifact do not exist", () => {
    const selfAsserted = [
      { id: "win", startAccepted: true, reached: true, reachedOutcome: true, outcome: "Won", actions: 2, frames: { before: 0, after: 1 } },
      { id: "save-load", startAccepted: true, reached: true, actions: 2, frames: { before: 0, after: 1 },
        saveCompleted: true, loadCompleted: true, artifact: SAVE_ARTIFACT,
        saveId: "x", loadedSaveId: "x", savedStateHash: SAVE_SHA256, loadedStateHash: SAVE_SHA256 },
    ];
    // Nothing but the verdict file: no frames, no save.
    write({ ...ok, frames: { count: 2, flat: 0, maxMotionShare: 0.3 }, record: { ...ok.record, scenarios: selfAsserted } });
    const claimed = readPlaythroughVerdict(root, 0);
    expect(claimed.scenarios?.find((row) => row.id === "win")).toMatchObject({ status: "not-reached" });
    expect(claimed.scenarios?.find((row) => row.id === "win")?.reason).toContain("none are on disk");
    expect(claimed.scenarios?.find((row) => row.id === "save-load")).toMatchObject({ status: "not-reached" });

    // The frames exist but the save does not: the visual scenario is shown, the
    // one that turns on restored STATE is not.
    writeFrames(2);
    const framesOnly = readPlaythroughVerdict(root, 0);
    expect(framesOnly.scenarios?.find((row) => row.id === "win")).toMatchObject({ status: "reached" });
    expect(framesOnly.scenarios?.find((row) => row.id === "save-load")).toMatchObject({ status: "not-reached" });

    // With the save on disk too, save/load is genuinely shown.
    writeSaveArtifact();
    expect(readPlaythroughVerdict(root, 0).scenarios?.find((row) => row.id === "save-load")).toMatchObject({ status: "reached" });
  });

  it("a save/load that names no artifact is not measured on the producer's word alone", () => {
    write({ ...ok, frames: { count: 2, flat: 0, maxMotionShare: 0.3 }, record: { ...ok.record, scenarios: [
      { id: "save-load", startAccepted: true, reached: true, actions: 2, frames: { before: 0, after: 1 },
        saveCompleted: true, loadCompleted: true, saveId: "x", loadedSaveId: "x", savedStateHash: SAVE_SHA256, loadedStateHash: SAVE_SHA256 },
    ] } });
    writeFrames(2);
    const row = readPlaythroughVerdict(root, 0).scenarios?.find((r) => r.id === "save-load");
    expect(row).toMatchObject({ status: "not-reached" });
    expect(row?.reason).toContain("no save artifact was named");
  });

  it("an artifact path that climbs out of the project is refused, even when that file EXISTS (guard)", () => {
    // The file is real — just not inside the project. A producer naming it is
    // pointing at evidence nobody can attribute to this run.
    const outside = join(root, "..", `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "save.json"), "{}");
    write({ ...ok, frames: { count: 2, flat: 0, maxMotionShare: 0.3 }, record: { ...ok.record, scenarios: [
      { id: "save-load", startAccepted: true, reached: true, actions: 2, frames: { before: 0, after: 1 },
        saveCompleted: true, loadCompleted: true, artifact: `../${outside.split("/").pop()}/save.json`,
        saveId: "x", loadedSaveId: "x", savedStateHash: SAVE_SHA256, loadedStateHash: SAVE_SHA256 },
    ] } });
    writeFrames(2);
    expect(readPlaythroughVerdict(root, 0).scenarios?.find((r) => r.id === "save-load")).toMatchObject({ status: "not-reached" });
  });

  /**
   * Codex round 14 #11 and #12. My round-13 fix asked the right question and
   * accepted the wrong answers: ANY existing path inside the project counted as
   * a save artifact — the verdict file itself, a directory, a symlink out of the
   * tree — and a frame COUNT was treated as proof that the referenced indices
   * existed.
   */
  it("#11 the verdict cannot be its own save artifact, and neither can a directory or a link", () => {
    const row = (artifact: string) => ({
      id: "save-load", startAccepted: true, reached: true, actions: 2, frames: { before: 0, after: 1 },
      saveCompleted: true, loadCompleted: true, artifact,
      saveId: "x", loadedSaveId: "x", savedStateHash: SAVE_SHA256, loadedStateHash: SAVE_SHA256,
    });
    const outside = join(root, "..", `outside-artifact-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "save.json"), SAVE_BYTES);
    mkdirSync(join(root, "Recordings", "playthrough", "a-directory"), { recursive: true });
    symlinkSync(join(outside, "save.json"), join(root, "Recordings", "playthrough", "linked.json"));

    for (const artifact of [
      join("Recordings", "playthrough", "playthrough-verdict.json"), // itself
      join("Recordings", "playthrough", "a-directory"),
      join("Recordings", "playthrough", "linked.json"),
      join("Recordings", "playthrough", "frame_00000.png"), // a capture, not a save
    ]) {
      write({ ...ok, frames: { count: 2, flat: 0, maxMotionShare: 0.3 }, record: { ...ok.record, scenarios: [row(artifact)] } });
      writeFrames(2);
      const result = readPlaythroughVerdict(root, 0).scenarios?.find((r) => r.id === "save-load");
      expect(result, artifact).toMatchObject({ status: "not-reached" });
    }

    // A real save file whose bytes hash to the state the row claims IS accepted.
    write({ ...ok, frames: { count: 2, flat: 0, maxMotionShare: 0.3 }, record: { ...ok.record, scenarios: [row(SAVE_ARTIFACT)] } });
    writeFrames(2);
    writeSaveArtifact();
    expect(readPlaythroughVerdict(root, 0).scenarios?.find((r) => r.id === "save-load")).toMatchObject({ status: "reached" });

    // …and the same file with the WRONG hash is not: the artifact is bound to
    // the state that came back, not merely present.
    writeFileSync(join(root, SAVE_ARTIFACT), "{}");
    expect(readPlaythroughVerdict(root, 0).scenarios?.find((r) => r.id === "save-load")).toMatchObject({ status: "not-reached" });
    rmSync(outside, { recursive: true, force: true });
  });

  it("#12 a DIRECTORY named like a capture is not a capture (and an index is a position)", () => {
    // An index is a POSITION in this verdict's capture order, not a file number,
    // so two captures numbered 98 and 99 are positions 0 and 1 — that reading is
    // the documented contract and stays.
    write({ ...ok, frames: { count: 2, flat: 0, maxMotionShare: 0.3 }, record: { ...ok.record, scenarios: [
      { id: "win", startAccepted: true, reached: true, reachedOutcome: true, outcome: "Won", actions: 2, frames: { before: 0, after: 1 } },
    ] } });
    mkdirSync(join(root, "Recordings", "playthrough"), { recursive: true });
    writeFileSync(join(root, "Recordings", "playthrough", "frame_00098.png"), "png");
    writeFileSync(join(root, "Recordings", "playthrough", "frame_00099.png"), "png");
    const sparse = readPlaythroughVerdict(root, 0).scenarios?.find((r) => r.id === "win");
    expect(sparse).toMatchObject({ status: "reached" });

    // A DIRECTORY named like a capture is not a capture.
    rmSync(join(root, "Recordings", "playthrough", "frame_00098.png"));
    rmSync(join(root, "Recordings", "playthrough", "frame_00099.png"));
    mkdirSync(join(root, "Recordings", "playthrough", "frame_00000.png"), { recursive: true });
    mkdirSync(join(root, "Recordings", "playthrough", "frame_00001.png"), { recursive: true });
    expect(readPlaythroughVerdict(root, 0).scenarios?.find((r) => r.id === "win")).toMatchObject({ status: "not-reached" });
  });
});
