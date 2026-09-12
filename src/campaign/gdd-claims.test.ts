/**
 * The GDD's numbers, read back and answered — or named as unanswerable.
 * Until 2026-09-10 "60 fps" and "loads in under 3 seconds" in a GDD were
 * repeated to the planner and never measured by any gate.
 */
import { describe, expect, it } from "vitest";
import { gddPlatform } from "./gdd-platform.js";
import { assessNumericClaims, claimsRefusal, describeClaims, extractActionBudget, extractNumericClaims, finishedSessionIndices } from "./gdd-claims.js";
import type { PlaythroughEvidence } from "./types.js";

const GDD = `# Sky Pigs
Target 60 fps on mid-range phones. The game must load in under 3 seconds from a cold start.
There are 12 levels in the first world. Each level lasts 30-90 seconds.
Frame rate is 60 FPS (again). The menu appears within 500 ms of launch.`;

function evidence(over: Partial<PlaythroughEvidence> = {}): PlaythroughEvidence {
  return {
    found: true, ok: true, outcome: "Won", session: 1, actions: 20,
    perf: { medium: "editor-playmode-batch", bootSeconds: 2.4, playSeconds: 41.2, playFrames: 1030, avgFps: 25, worstFrameMs: 180 },
    ...over,
    // WHAT A CURRENT PRODUCER EMITS. Every session record carries whether the
    // run could identify the content it played (Codex 2026-09-12 X, Z#5), so
    // the fixtures carry it too; a test that is about identity says otherwise
    // for the session it means.
    ...(over.sessions ? { sessions: over.sessions.map((s) => ({ identityVerified: true, ...s })) } : {}),
  };
}

describe("extractNumericClaims", () => {
  it("reads frame rate, boot budget (both word orders and ms), level count and session length, de-duplicated", () => {
    const { claims, truncated } = extractNumericClaims(GDD);
    expect(truncated).toBe(0);
    expect(claims.map((c) => [c.kind, c.comparator, c.value])).toEqual([
      ["fps", "min", 60],
      ["boot_seconds", "max", 3],
      ["level_count", "eq", 12],
      // A range has a floor as well as a ceiling (Codex 2026-09-11 B#19), and
      // the list is in DOCUMENT order, so the 500 ms boot budget comes last.
      ["session_seconds", "max", 90],
      ["session_seconds", "min", 30],
      ["boot_seconds", "max", 0.5],
    ]);
    expect(claims[1]!.text).toContain("load in under 3 seconds");

    // "2 worlds with 12 levels each" is ONE claim of 24, not 2 and 12.
    const multiplied = extractNumericClaims("The game ships 2 worlds with 12 levels each.").claims;
    expect(multiplied.map((c) => [c.kind, c.value])).toEqual([["level_count", 24]]);
  });

  it("finds nothing in prose without numbers, and ignores years and version numbers", () => {
    expect(extractNumericClaims("A calm puzzle game released in 2026, version 1.4, with 1080p art.").claims).toEqual([]);
  });
});

describe("assessNumericClaims", () => {
  const { claims } = extractNumericClaims(GDD);

  it("answers each claim from the play-through timing; the batch editor's loop rate is disclosed, never a verdict on fps", () => {
    const a = assessNumericClaims(claims, evidence());
    expect(a.map((x) => [x.claim.kind, x.claim.value, x.status, x.blocking])).toEqual([
      ["fps", 60, "unmeasured", false],
      ["boot_seconds", 3, "met", true],
      ["level_count", 12, "unmeasured", false],
      ["session_seconds", 90, "met", true],
      // The floor is disclosed, never blocking: a driven play-through is
      // faster than a person's.
      ["session_seconds", 30, "met", false],
      ["boot_seconds", 0.5, "not_met", true],
    ]);
    expect(a[0]!.note).toContain("no evidence about the player's frame rate");
    expect(a[0]!.measured).toBe(25);
    expect(claimsRefusal(a)).toMatch(/^THE GDD'S OWN NUMBERS ARE NOT MET: boot time ≤ 0\.5 s measured 2\.4 s/);
    expect(claimsRefusal(a)).not.toContain("frame rate");
  });

  it("nothing measured → every claim is listed as NOT MEASURED with the reason, and nothing blocks", () => {
    const a = assessNumericClaims(claims, undefined);
    expect(a.every((x) => x.status === "unmeasured" && !x.blocking)).toBe(true);
    expect(claimsRefusal(a)).toBeUndefined();
    const lines = describeClaims(a);
    expect(lines[0]).toMatch(/^GDD frame rate ≥ 60 fps: NOT MEASURED — no play-through of this build was observed/);
    expect(lines[3]).toContain("no play-through of this build was observed");
    expect(lines).toHaveLength(6); // the range's floor is a claim of its own (B#19)
  });

  it("a player built for the WRONG platform does not answer a handheld frame-rate claim (Codex 2026-09-11 B#11)", () => {
    const { claims: phoneClaims } = extractNumericClaims("Target 60 fps on mid-range phones.");
    const player: PlaythroughEvidence = {
      found: true, ok: true, outcome: "Won", session: 1, actions: 20,
      perf: { medium: "player", bootSeconds: 1, playSeconds: 10, playFrames: 600, avgFps: 60, worstFrameMs: 40 },
    };
    const platform = gddPlatform("Target 60 fps on mid-range phones.");
    const desktop = assessNumericClaims(phoneClaims, evidence(), player, { platform, builtTarget: "StandaloneOSX" });
    expect(desktop[0]).toMatchObject({ status: "unmeasured", blocking: false, measured: 60 });
    expect(desktop[0]!.note).toContain("the GDD asks for a handheld");
    const onDevice = assessNumericClaims(phoneClaims, evidence(), player, { platform, builtTarget: "Android" });
    expect(onDevice[0]).toMatchObject({ status: "met", blocking: true });
  });

  it("the built player answers the frame-rate claim: measured, and blocking (2026-09-10)", () => {
    const player = (avgFps: number): PlaythroughEvidence =>
      evidence({ perf: { medium: "player", bootSeconds: 1.1, playSeconds: 10, playFrames: Math.round(avgFps * 10), avgFps, worstFrameMs: 40 } });
    const slow = assessNumericClaims(claims, evidence(), player(42));
    expect(slow[0]).toMatchObject({ status: "not_met", measured: 42, blocking: true });
    expect(slow[0]!.note).toContain("42.0 fps average over 420 frames in the built player (real rendering), worst frame 40 ms");
    expect(claimsRefusal(slow)).toContain("frame rate ≥ 60 fps measured 42 fps");
    const fast = assessNumericClaims(claims, evidence(), player(61));
    expect(fast[0]).toMatchObject({ status: "met", measured: 61, blocking: true });
    // A player verdict without timing falls back to the editor's disclosure.
    const silent = assessNumericClaims(claims, evidence(), evidence({ perf: undefined }));
    expect(silent[0]).toMatchObject({ status: "unmeasured", blocking: false });
  });

  it("level count: unmeasured without a session catalog, measured against it with one, and the played sessions are named", () => {
    const noCatalog = assessNumericClaims(claims, evidence());
    expect(noCatalog.find((x) => x.claim.kind === "level_count")).toMatchObject({
      status: "unmeasured", blocking: false, note: "the game registers no Strada.Core.Play.ISessionCatalog, so its sessions cannot be counted",
    });
    const three = assessNumericClaims(claims, evidence({ sessionCount: 3, sessions: [{ index: 1, outcome: "Won", actions: 10, seconds: 5 }, { index: 2, outcome: "None", actions: 60, seconds: 45 }] }));
    expect(three.find((x) => x.claim.kind === "level_count")).toMatchObject({
      status: "not_met", blocking: true, measured: 3, note: "the game's session catalog reports 3; 1 of 2 played session(s) reached an outcome",
    });
    expect(claimsRefusal(three)).toContain("level count = 12 measured 3");
    // A catalog of 12 is a claim; 12 sessions played to an outcome is the measurement (Codex 2026-09-11 B#10).
    const catalogOnly = assessNumericClaims(claims, evidence({ sessionCount: 12 }));
    expect(catalogOnly.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met", blocking: true, measured: 12 });
    // Indices are catalog entries and each session did something. ONE-BASED:
    // Strada.Core states "the first session is 1" and the driver generates
    // 1…min(catalog, cap). Counting 0…catalog-1 rejected the last valid
    // session of every game (Codex 2026-09-12 R#3).
    const allPlayed = assessNumericClaims(claims, evidence({ sessionCount: 12, sessions: Array.from({ length: 12 }, (_, i) => ({ index: i + 1, outcome: "Won", actions: 10, seconds: 5 })) }));
    expect(allPlayed.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "met", measured: 12 });
    expect(allPlayed.find((x) => x.claim.kind === "level_count")!.note).toContain("12 of 12 played session(s) reached an outcome");
    // An impossible index, or a session that took no action, is not a level
    // played (Codex 2026-09-11 D#21).
    const bogus = assessNumericClaims(claims, evidence({
      sessionCount: 12,
      // Real actions, impossible indices: only the catalog check rejects these.
      sessions: Array.from({ length: 12 }, (_, i) => ({ index: 100 + i, outcome: "Won", actions: 8, seconds: 3 })),
    }));
    expect(bogus.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met" });
    // …and a session that took no action is not a level played either.
    const idle = assessNumericClaims(claims, evidence({
      sessionCount: 12,
      sessions: Array.from({ length: 12 }, (_, i) => ({ index: i, outcome: "Won", actions: 0, seconds: 1 })),
    }));
    expect(idle.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met" });
    // A record that omits its index is not "level 0", and half an action is
    // not an action (Codex 2026-09-11 E#7).
    const noIndex = assessNumericClaims(claims, evidence({
      sessionCount: 12,
      sessions: Array.from({ length: 12 }, () => ({ outcome: "Won", actions: 8, seconds: 3 })),
    }));
    expect(noIndex.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met" });
    for (const actions of [0.5, 1.5, 7.25]) {
      const fractional = assessNumericClaims(claims, evidence({
        sessionCount: 12,
        sessions: Array.from({ length: 12 }, (_, i) => ({ index: i, outcome: "Won", actions, seconds: 3 })),
      }));
      expect(fractional.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met" });
    }
    // Negative actions are not actions either.
    const negative = assessNumericClaims(claims, evidence({
      sessionCount: 12,
      sessions: Array.from({ length: 12 }, (_, i) => ({ index: i, outcome: "Won", actions: -3, seconds: 3 })),
    }));
    expect(negative.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met" });
  });

  it("the LAST session of a catalog counts, and a one-level game can be proven (Codex 2026-09-12 R#3)", () => {
    // Brain counted 0…catalog-1 while Strada.Core's contract is "the first
    // session is 1" and the driver plays 1…min(catalog, cap). Every correctly
    // played run therefore lost its last session, and a one-level game could
    // never be proven at all.
    // The LAST session is the one the old bound rejected: a two-level game
    // proven by sessions 1 and 2 used to count only session 1.
    const two = extractNumericClaims("The game ships 2 levels.").claims;
    const played = assessNumericClaims(two, evidence({
      sessionCount: 2,
      sessions: [1, 2].map((index) => ({ index, outcome: "Won", actions: 7, seconds: 4 })),
    }));
    expect(played.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "met" });

    const three = extractNumericClaims("The game ships 3 levels.").claims;
    const all = assessNumericClaims(three, evidence({
      sessionCount: 3,
      sessions: [1, 2, 3].map((index) => ({ index, outcome: "Won", actions: 5, seconds: 3 })),
    }));
    expect(all.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "met" });

    // …and an index the catalog does not have is still not a level played.
    const outside = assessNumericClaims(three, evidence({
      sessionCount: 3,
      sessions: [0, 4, 9].map((index) => ({ index, outcome: "Won", actions: 5, seconds: 3 })),
    }));
    expect(outside.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met" });
  });

  it("distinct sessions, distributive wording, and a mandatory floor (Codex 2026-09-11 C#21-24)", () => {
    const three = extractNumericClaims("The game ships 3 levels.").claims;
    // Three records of the SAME level are one level played three times.
    const repeated = assessNumericClaims(three, evidence({
      sessionCount: 3,
      sessions: [1, 1, 1].map((index) => ({ index, outcome: "Won", actions: 5, seconds: 3 })),
    }));
    expect(repeated.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met" });
    const distinct = assessNumericClaims(three, evidence({
      sessionCount: 3,
      sessions: [1, 2, 3].map((index) => ({ index, outcome: "Won", actions: 5, seconds: 3 })),
    }));
    expect(distinct.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "met" });

    // "in total" is not distributive: 12 levels, not 24.
    expect(extractNumericClaims("The game ships 2 worlds with 12 levels in total.").claims.map((c) => c.value)).toEqual([12]);
    expect(extractNumericClaims("The game ships 2 worlds with 12 levels each.").claims.map((c) => c.value)).toEqual([24]);

    // A 13-level game with ONE session played is still blocked: the waiver is
    // for the shortfall one run cannot reach (Codex 2026-09-11 C#21).
    const thirteen = extractNumericClaims("The game ships 13 levels.").claims;
    const onlyOne = assessNumericClaims(thirteen, evidence({
      sessionCount: 13,
      sessions: [{ index: 1, outcome: "Won", actions: 5, seconds: 3 }],
    }));
    expect(onlyOne.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "not_met", blocking: true });
    const twelvePlayed = assessNumericClaims(thirteen, evidence({
      sessionCount: 13,
      sessions: Array.from({ length: 12 }, (_, i) => ({ index: i + 1, outcome: "Won", actions: 5, seconds: 3 })),
    }));
    expect(twelvePlayed.find((x) => x.claim.kind === "level_count")).toMatchObject({ blocking: false });

    // "each with 12 levels" is distributive however it is phrased (D#22).
    expect(extractNumericClaims("The game ships 2 worlds, each with 12 levels.").claims.map((c) => c.value)).toEqual([24]);
    expect(extractNumericClaims("The game ships 2 worlds with 12 levels in total.").claims.map((c) => c.value)).toEqual([12]);

    // A DENIED timer is not a mandatory floor (D#23)…
    const denied = extractNumericClaims("A typical round lasts 30-60 seconds, with no mandatory timer.").claims;
    const deniedFloor = assessNumericClaims(denied, evidence({ perf: { medium: "editor-playmode-batch", bootSeconds: 1, playSeconds: 5, playFrames: 150, avgFps: 30 } }))
      .find((x) => x.claim.comparator === "min");
    expect(deniedFloor).toMatchObject({ blocking: false });

    // …and a later mandatory sentence is not hidden by an earlier soft one (D#24).
    const both = extractNumericClaims("A typical round lasts 30-60 seconds.\nEvery match has an unskippable timer of 30-60 seconds.").claims;
    const bothFloor = assessNumericClaims(both, evidence({ perf: { medium: "editor-playmode-batch", bootSeconds: 1, playSeconds: 5, playFrames: 150, avgFps: 30 } }))
      .find((x) => x.claim.comparator === "min");
    expect(bothFloor).toMatchObject({ status: "not_met", blocking: true });

    // A mandatory minimum is wall-clock, not player skill: it blocks.
    const mandatory = extractNumericClaims("Each round runs an unskippable timer of 30-60 seconds.").claims;
    const floor = assessNumericClaims(mandatory, evidence({ perf: { medium: "editor-playmode-batch", bootSeconds: 1, playSeconds: 1, playFrames: 30, avgFps: 30 } }))
      .find((x) => x.claim.comparator === "min");
    expect(floor).toMatchObject({ status: "not_met", blocking: true });
  });

  it("a session that never ended has no length; a blown session budget blocks", () => {
    const unfinished = assessNumericClaims(claims, evidence({ ok: false, outcome: "None" }));
    expect(unfinished.find((x) => x.claim.kind === "session_seconds")).toMatchObject({ status: "unmeasured", blocking: false });
    const slow = assessNumericClaims(claims, evidence({ perf: { medium: "editor-playmode-batch", bootSeconds: 1, playSeconds: 120, playFrames: 3000, avgFps: 25 } }));
    expect(slow.find((x) => x.claim.kind === "session_seconds")).toMatchObject({ status: "not_met", blocking: true, measured: 120 });
    expect(claimsRefusal(slow)).toContain("session length ≤ 90 s measured 120 s");
  });

  it("describeClaims names MET with the measurement and the medium", () => {
    const lines = describeClaims(assessNumericClaims(claims, evidence()));
    expect(lines[1]).toBe("GDD boot time ≤ 3 s: MET — scene load → services in 2.4 s (editor play mode, batch)");
    expect(describeClaims([])).toEqual(["GDD numbers: none found (no frame-rate, load-time, level-count or session-length figure in the text)"]);
    expect(describeClaims(assessNumericClaims(claims, evidence()), 2).at(-1)).toBe("GDD numbers: 2 further claim(s) not listed");
  });
});

describe("independent level counts cannot contradict each other (Codex 2026-09-11 F#2)", () => {
  it("keeps the largest, because they are all measured against one catalog", () => {
    const { claims } = extractNumericClaims("Campaign contains 12 levels. The optional tutorial contains 3 puzzles.");
    const levels = claims.filter((c) => c.kind === "level_count");
    expect(levels).toHaveLength(1);
    expect(levels[0]!.value).toBe(12);
    // …whichever order the document names them in.
    const reversed = extractNumericClaims("The tutorial contains 3 puzzles. The campaign contains 12 levels.");
    const levelsReversed = reversed.claims.filter((c) => c.kind === "level_count");
    expect(levelsReversed).toHaveLength(1);
    expect(levelsReversed[0]!.value).toBe(12);
    // A single count is untouched.
    const one = extractNumericClaims("The game ships 7 levels.");
    expect(one.claims.filter((c) => c.kind === "level_count").map((c) => c.value)).toEqual([7]);
  });
});

describe("distinct finished sessions (Codex 2026-09-12 R#4)", () => {
  it("counts a session once, only inside the catalog, and only when it did something", () => {
    // Every session carries the identity a current producer records (X, Z#5).
    const played = (over: Record<string, unknown>) => ({ identityVerified: true, ...over });
    expect(finishedSessionIndices({
      sessionCount: 4,
      sessions: [
        played({ index: 1, outcome: "Won", actions: 5 }),
        played({ index: 1, outcome: "Won", actions: 9 }),   // the same level again
        played({ index: 4, outcome: "Lost", actions: 3 }),  // the LAST catalog entry counts
        played({ index: 5, outcome: "Won", actions: 3 }),   // outside the catalog
        played({ index: 2, outcome: "None", actions: 7 }),  // never reached an outcome
        played({ index: 3, outcome: "Won", actions: 0 }),   // did nothing
      ],
    })).toEqual([1, 4]);
    expect(finishedSessionIndices(undefined)).toEqual([]);
  });
});

describe("a shortfall is not a pass, and an outcome must be stated (Codex 2026-09-12 S#11)", () => {
  const twentyFour = extractNumericClaims("The game ships 24 levels.").claims;

  it("twelve of twenty-four levels is NOT met, though one run cannot be blamed for it", () => {
    const half = assessNumericClaims(twentyFour, evidence({
      sessionCount: 24,
      sessions: Array.from({ length: 12 }, (_, i) => ({ index: i + 1, outcome: "Won", actions: 5, seconds: 3 })),
    }));
    const level = half.find((x) => x.claim.kind === "level_count")!;
    // The status used to read "met" with twelve levels never played.
    expect(level.status).toBe("not_met");
    expect(level.note).toContain("12 of 24 levels are NOT yet played");
    // …and it is still not held against the delivery, since no single run can
    // answer it (C#21 stands).
    expect(level.blocking).toBe(false);
  });

  it("every level played to an outcome IS met", () => {
    const all = assessNumericClaims(twentyFour, evidence({
      sessionCount: 24,
      sessions: Array.from({ length: 24 }, (_, i) => ({ index: i + 1, outcome: "Won", actions: 5, seconds: 3 })),
    }));
    expect(all.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "met" });
  });

  it("a record with no outcome at all is not a level played", () => {
    expect(finishedSessionIndices({
      sessionCount: 3,
      sessions: [
        { index: 1, outcome: "", actions: 5 },
        { index: 2, actions: 5 },
        { index: 3, outcome: "Won", actions: 5, reachedOutcome: false },
      ],
    })).toEqual([]);
  });
});

describe("a per-session requirement is measured per session (Codex 2026-09-12 T#7)", () => {
  it("three 40-second levels satisfy \"each level lasts 30-60 seconds\"", () => {
    // perf.playSeconds is the WHOLE RUN's play time, so three 40-second levels
    // measured 120 s against a 60 s ceiling and failed a game that met the
    // requirement exactly.
    const claims = extractNumericClaims("The game ships 3 levels. Each level lasts 30-60 seconds with a mandatory timer.").claims;
    const three = assessNumericClaims(claims, evidence({
      sessionCount: 3,
      sessions: [1, 2, 3].map((index) => ({ index, outcome: "Won", actions: 5, seconds: 40 })),
      perf: { medium: "playmode", bootSeconds: 1, playSeconds: 120, playFrames: 600, avgFps: 60, worstFrameMs: 20 },
    }));
    const length = three.find((x) => x.claim.kind === "session_seconds")!;
    expect(length.status).toBe("met");
    expect(length.note).toContain("3 session(s) reached an outcome");

    // …and a level that really does run long is still not met.
    const long = assessNumericClaims(claims, evidence({
      sessionCount: 3,
      sessions: [
        { index: 1, outcome: "Won", actions: 5, seconds: 40 },
        { index: 2, outcome: "Won", actions: 5, seconds: 95 },
        { index: 3, outcome: "Won", actions: 5, seconds: 40 },
      ],
      perf: { medium: "playmode", bootSeconds: 1, playSeconds: 175, playFrames: 600, avgFps: 60, worstFrameMs: 20 },
    }));
    expect(long.find((x) => x.claim.kind === "session_seconds")!.status).toBe("not_met");
  });
});

/**
 * The document's own numbers, read the way it wrote them. Measured by Codex
 * 2026-09-12 (U#F3) against the real GDD: "Cold boot ≤ 6 s" stated no timing
 * requirement at all, "ship at least 20 levels" meant exactly twenty, "3,000+
 * levels" meant nothing, and the level count the delivery was held to came
 * from a sentence about how far ahead of the player the queue runs.
 */
describe("comparators, separators and subjects (Codex 2026-09-12 U#F3)", () => {
  const kinds = (text: string): Array<[string, string, number]> =>
    extractNumericClaims(text).claims.map((c) => [c.kind, c.comparator, c.value]);

  it("reads a symbol comparator — the word boundary before ≤ could never match", () => {
    expect(kinds("Cold boot ≤ 6 s to Home on a mid device.")).toEqual([["boot_seconds", "max", 6]]);
    expect(kinds("Boot <= 4s.")).toEqual([["boot_seconds", "max", 4]]);
    // …and the worded form still reads as before.
    expect(kinds("The game must load in under 3 seconds.")).toEqual([["boot_seconds", "max", 3]]);
  });

  it("a LEVEL load is not a cold boot: two intervals, not one stricter boot budget", () => {
    expect(kinds("Cold boot ≤ 6 s to Home on mid device; level load ≤ 1.5 s.")).toEqual([
      ["boot_seconds", "max", 6],
      ["level_load_seconds", "max", 1.5],
    ]);
    expect(kinds("Loading a stage takes under 2 seconds.")).toEqual([["level_load_seconds", "max", 2]]);
  });

  it("names the level-load requirement as unmeasured, because no producer records it", () => {
    const claim = extractNumericClaims("Level load ≤ 1.5 s.").claims[0]!;
    const [assessed] = assessNumericClaims([claim], evidence());
    expect(assessed!.status).toBe("unmeasured");
    expect(assessed!.blocking).toBe(false);
    expect(assessed!.note).toContain("level-ready checkpoint");
  });

  it("reads which way a count points, and reads thousands", () => {
    expect(kinds("Ship at least 20 levels.")).toEqual([["level_count", "min", 20]]);
    expect(kinds("Ship 3,000+ levels.")).toEqual([["level_count", "min", 3000]]);
    expect(kinds("3,000 or more levels at launch.")).toEqual([["level_count", "min", 3000]]);
    expect(kinds("Up to 20 levels.")).toEqual([["level_count", "max", 20]]);
    expect(kinds("The game ships 12 levels.")).toEqual([["level_count", "eq", 12]]);
    // The largest count is still the game's own (Codex 2026-09-11 F#2).
    expect(kinds("Launch depth: 2,000 levels. The tutorial has 3 puzzles.")).toEqual([["level_count", "eq", 2000]]);
  });

  it("a game that ships MORE than its floor is delivered, and one that ships fewer is not", () => {
    const atLeast = extractNumericClaims("Ship at least 20 levels.").claims;
    const sessions = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ index: i + 1, outcome: "Won", actions: 5, seconds: 30 }));
    const more = assessNumericClaims(atLeast, evidence({ sessionCount: 24, sessions: sessions(24) }));
    expect(more[0]!.status).toBe("met");
    const fewer = assessNumericClaims(atLeast, evidence({ sessionCount: 19, sessions: sessions(19) }));
    expect(fewer[0]!.status).toBe("not_met");
    expect(fewer[0]!.blocking).toBe(true);
    // A catalogue that holds enough but was not PLAYED is still not met.
    const unplayed = assessNumericClaims(atLeast, evidence({ sessionCount: 24, sessions: sessions(11) }));
    expect(unplayed[0]!.status).toBe("not_met");
  });

  it("reads the action budget a session is allowed, or nothing", () => {
    expect(extractActionBudget("Up to 60 taps per session; 30 moves per level.")).toBe(60);
    expect(extractActionBudget("A round lasts 90 seconds.")).toBeUndefined();
  });
});

/**
 * Codex round V (2026-09-12) ran the reader again after the U#F3 fix and
 * found two regressions in it plus four rules it had not reached.
 */
describe("the release the delivery is measured against (Codex 2026-09-12 V)", () => {
  it("names the other counts the document states instead of dropping them", () => {
    const doc = "MVP: 200 certified levels. Global launch: 800+ levels. Launch depth: 2,000 levels. Live target: 3,000 levels.";
    const read = extractNumericClaims(doc);
    // One count is measured — one catalogue cannot satisfy four at once — and
    // it is the largest, so nothing is quietly shipped short.
    expect(read.claims.filter((c) => c.kind === "level_count").map((c) => c.value)).toEqual([3000]);
    expect(read.otherLevelCounts).toEqual([2000, 800, 200]);

    const lines = describeClaims(assessNumericClaims(read.claims, evidence()), read.truncated, read.otherLevelCounts);
    const said = lines.find((l) => l.startsWith("GDD level count:"))!;
    expect(said).toContain("measured against 3000");
    expect(said).toContain("2000, 800, 200");
    // A document with ONE count says nothing about releases.
    const single = extractNumericClaims("The game ships 12 levels.");
    expect(single.otherLevelCounts).toEqual([]);
    expect(describeClaims(assessNumericClaims(single.claims, evidence()), 0, single.otherLevelCounts).some((l) => l.startsWith("GDD level count:"))).toBe(false);
  });
});

describe("clause boundaries and the comparators the rest of the document uses (Codex 2026-09-12 V)", () => {
  const kinds = (text: string): Array<[string, string, number]> =>
    extractNumericClaims(text).claims.map((c) => [c.kind, c.comparator, c.value]);

  it("a timing subject is read INSIDE its clause", () => {
    // My own regression: the lookbehind reached across the sentence before
    // it, so the only boot budget in the document became a level-load figure
    // — and that kind is unmeasured, so nothing held the game to it.
    expect(kinds("Map loads fast; boot under 6 s.")).toEqual([["boot_seconds", "max", 6]]);
    // …and the two subjects in one sentence still separate.
    expect(kinds("The level loads in under 2 s. Cold boot ≤ 6 s.")).toEqual([
      ["level_load_seconds", "max", 2],
      ["boot_seconds", "max", 6],
    ]);
  });

  it("a frame-rate CAP is a ceiling, not a floor", () => {
    expect(kinds("At most 30 fps.")).toEqual([["fps", "max", 30]]);
    expect(kinds("Target 60 fps on mid devices.")).toEqual([["fps", "min", 60]]);
    const cap = extractNumericClaims("At most 30 fps to save battery.").claims;
    const player: PlaythroughEvidence = {
      found: true, ok: true, outcome: "Won", session: 1, actions: 20,
      perf: { medium: "player", bootSeconds: 1, playSeconds: 40, playFrames: 1200, avgFps: 30, worstFrameMs: 40 },
    };
    expect(assessNumericClaims(cap, evidence(), player)[0]!.status).toBe("met");
  });

  it("a session FLOOR is not a ceiling", () => {
    expect(kinds("Each round lasts at least 90 seconds.")).toEqual([["session_seconds", "min", 90]]);
    // A range still carries both bounds, and a plain figure is still a ceiling.
    expect(kinds("Each round lasts 30-60 seconds.")).toEqual([
      ["session_seconds", "max", 60],
      ["session_seconds", "min", 30],
    ]);
    expect(kinds("Each round lasts 45 seconds.")).toEqual([["session_seconds", "max", 45]]);
  });

  it("reads a count through the words that describe it, and a STRICT bound as the next whole number", () => {
    expect(kinds("Ship 200 certified levels.")).toEqual([["level_count", "eq", 200]]);
    expect(kinds("Ship 3,000+ handcrafted deterministic levels.")).toEqual([["level_count", "min", 3000]]);
    expect(kinds("More than 12 levels.")).toEqual([["level_count", "min", 13]]);
    expect(kinds("Fewer than 12 levels.")).toEqual([["level_count", "max", 11]]);
    expect(kinds("At most 12 levels.")).toEqual([["level_count", "max", 12]]);
    // A preposition is not a descriptor: "12 minutes across 5 levels" is five.
    expect(kinds("12 minutes across 5 levels.")).toEqual([["level_count", "eq", 5]]);
  });

  it("holds the game to the catalogue it ships, not to the count the document permits", () => {
    // "At most 12 levels" with eight shipped and all eight played demanded
    // twelve played levels and refused the delivery.
    const atMost = extractNumericClaims("At most 12 levels.").claims;
    const sessions = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ index: i + 1, outcome: "Won", actions: 5, seconds: 30 }));
    const eight = assessNumericClaims(atMost, evidence({ sessionCount: 8, sessions: sessions(8) }));
    expect(eight[0]!.status).toBe("met");
    // …and a catalogue over the cap is still not met.
    const thirteen = assessNumericClaims(atMost, evidence({ sessionCount: 13, sessions: sessions(13) }));
    expect(thirteen[0]!.status).toBe("not_met");
    // …and eight shipped with only three played is not met either.
    const partly = assessNumericClaims(atMost, evidence({ sessionCount: 8, sessions: sessions(3) }));
    expect(partly[0]!.status).toBe("not_met");
  });
});

/**
 * Codex round W (2026-09-12) ran the reader again after round V's fixes.
 * Each line below is an input it executed.
 */
describe("the comparators and boundaries round W found (Codex 2026-09-12 W#7)", () => {
  const kinds = (text: string): Array<[string, string, number]> =>
    extractNumericClaims(text).claims.map((c) => [c.kind, c.comparator, c.value]);

  it("a decimal point is not the end of a sentence", () => {
    // The dot in "1.5" cut away the "at least" before it, so the floor was
    // read as a ceiling and a half-second round passed.
    expect(kinds("Each round lasts at least 1.5 seconds.")).toEqual([["session_seconds", "min", 1.5]]);
    // …and a real sentence end still separates two clauses.
    expect(kinds("Levels are short. Each round lasts 45 seconds.")).toEqual([["session_seconds", "max", 45]]);
  });

  it("reads the strict and inclusive symbols, and a qualifier after the noun", () => {
    expect(kinds("Ship > 12 levels.")).toEqual([["level_count", "min", 13]]);
    expect(kinds("Ship < 12 levels.")).toEqual([["level_count", "max", 11]]);
    expect(kinds("Ship >= 12 levels.")).toEqual([["level_count", "min", 12]]);
    expect(kinds("Ship <= 12 levels.")).toEqual([["level_count", "max", 12]]);
    expect(kinds("12 levels or fewer.")).toEqual([["level_count", "max", 12]]);
  });

  it("a verb is not a descriptor: a sentence about people is not a catalogue", () => {
    expect(kinds("Players aged 18 complete levels.")).toEqual([]);
    expect(kinds("Most players finish 30 levels.")).toEqual([]);
    // …and a real descriptor still reads.
    expect(kinds("Ship 200 certified levels.")).toEqual([["level_count", "eq", 200]]);
  });
});

/**
 * A game may start playing BY ITSELF after boot. The run then adopts that
 * session instead of starting one, and the record carried the index the run
 * had ASKED for — so a game that auto-starts level 1, asked for session 7,
 * certified level 7 (Codex 2026-09-12 X). The producer now says whether it
 * could identify what it adopted.
 */
describe("a session whose content nobody could identify (Codex 2026-09-12 X)", () => {
  const played = (over: Record<string, unknown>) => ({
    index: 7, outcome: "Won", actions: 5, seconds: 30, reachedOutcome: true, ...over,
  });

  it("is not a level played, and neither is an unidentified or self-contradictory one", () => {
    expect(finishedSessionIndices({ sessionCount: 12, sessions: [played({ identityVerified: false })] })).toEqual([]);
    expect(finishedSessionIndices({ sessionCount: 12, sessions: [played({ identityVerified: true })] })).toEqual([7]);
    // A producer that says NOTHING about identity certifies no content
    // either: absence was read as permission, and a malformed flag became
    // absence (Codex 2026-09-12 Z#5).
    expect(finishedSessionIndices({ sessionCount: 12, sessions: [played({})] })).toEqual([]);
    expect(finishedSessionIndices({ sessionCount: 12, sessions: [played({ identityVerified: "false" as never })] })).toEqual([]);
    expect(finishedSessionIndices({ sessionCount: 12, sessions: [played({ identityVerified: null as never })] })).toEqual([]);
    // …and a record that claims verification while naming a DIFFERENT session
    // as the one that ran is a contradiction, not a level played.
    expect(
      finishedSessionIndices({ sessionCount: 12, sessions: [played({ identityVerified: true, observedIndex: 1 })] }),
    ).toEqual([]);
    // The game reporting the session it was asked for is consistent.
    expect(
      finishedSessionIndices({ sessionCount: 12, sessions: [played({ identityVerified: true, observedIndex: 7 })] }),
    ).toEqual([7]);
  });

  it("keeps the level count honest: an unidentified session does not close it", () => {
    const claim = extractNumericClaims("The game ships 3 levels.").claims;
    const three = [1, 2, 3].map((index) => ({ index, outcome: "Won", actions: 5, seconds: 30, reachedOutcome: true }));
    const identified = assessNumericClaims(claim, evidence({ sessionCount: 3, sessions: three }));
    expect(identified[0]!.status).toBe("met");
    const adopted = assessNumericClaims(
      claim,
      evidence({ sessionCount: 3, sessions: [{ ...three[0]!, identityVerified: false }, three[1]!, three[2]!] }),
    );
    expect(adopted[0]!.status).toBe("not_met");
  });
});

/**
 * Only the frame rate consumed the built player's evidence, so a player whose
 * boot took 12 s and whose only level ran 120 s was judged MET against a 6 s
 * boot and a 60 s round — measured in the editor, where neither number is the
 * product's (Codex 2026-09-12 Z).
 */
describe("the shipped artifact answers the document's numbers (Codex 2026-09-12 Z)", () => {
  const gdd = "# GDD\n\nThe game ships 3 levels. Cold boot under 6 seconds. Each round lasts under 60 seconds.";
  const editorRun = evidence({
    sessionCount: 3,
    sessions: [1, 2, 3].map((index) => ({ index, outcome: "Won", actions: 5, seconds: 10 })),
    perf: { medium: "editor-playmode-batch", bootSeconds: 0.2, playSeconds: 30, playFrames: 900, avgFps: 40, worstFrameMs: 60 },
  });
  const playerRun = (over: Partial<PlaythroughEvidence> = {}): PlaythroughEvidence => ({
    found: true, ok: true, outcome: "Won", session: 1, actions: 20,
    perf: { medium: "player", bootSeconds: 12, playSeconds: 120, playFrames: 3600, avgFps: 30, worstFrameMs: 90 },
    ...over,
  });

  it("takes the player's boot time and session length over the editor's", () => {
    const claims = extractNumericClaims(gdd).claims;
    const judged = assessNumericClaims(claims, editorRun, playerRun());
    const boot = judged.find((a) => a.claim.kind === "boot_seconds")!;
    expect(boot.status).toBe("not_met");
    expect(boot.measured).toBe(12);
    expect(boot.note).toContain("(player)");
    const session = judged.find((a) => a.claim.kind === "session_seconds")!;
    expect(session.status).toBe("not_met");
    expect(session.measured).toBe(120);
  });

  it("takes the player's session catalogue when it reported one", () => {
    const claims = extractNumericClaims(gdd).claims;
    // The shipped artifact registers ONE level; the editor project had three.
    const judged = assessNumericClaims(claims, editorRun, playerRun({
      sessionCount: 1,
      sessions: [{ index: 1, outcome: "Won", actions: 5, seconds: 30, identityVerified: true }],
    }));
    const count = judged.find((a) => a.claim.kind === "level_count")!;
    expect(count.status).toBe("not_met");
    expect(count.measured).toBe(1);
  });

  it("falls back to the editor's numbers when no player ran, exactly as before", () => {
    const claims = extractNumericClaims(gdd).claims;
    const judged = assessNumericClaims(claims, editorRun, undefined);
    expect(judged.find((a) => a.claim.kind === "boot_seconds")!.measured).toBe(0.2);
    expect(judged.find((a) => a.claim.kind === "boot_seconds")!.note).toContain("editor play mode, batch");
    expect(judged.find((a) => a.claim.kind === "level_count")!.status).toBe("met");
  });
});
