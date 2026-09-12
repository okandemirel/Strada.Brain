/**
 * The GDD's numbers, read back and answered — or named as unanswerable.
 * Until 2026-09-10 "60 fps" and "loads in under 3 seconds" in a GDD were
 * repeated to the planner and never measured by any gate.
 */
import { describe, expect, it } from "vitest";
import { gddPlatform } from "./gdd-platform.js";
import { assessNumericClaims, claimsRefusal, describeClaims, extractNumericClaims, finishedSessionIndices } from "./gdd-claims.js";
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
    expect(finishedSessionIndices({
      sessionCount: 4,
      sessions: [
        { index: 1, outcome: "Won", actions: 5 },
        { index: 1, outcome: "Won", actions: 9 },   // the same level again
        { index: 4, outcome: "Lost", actions: 3 },  // the LAST catalog entry counts
        { index: 5, outcome: "Won", actions: 3 },   // outside the catalog
        { index: 2, outcome: "None", actions: 7 },  // never reached an outcome
        { index: 3, outcome: "Won", actions: 0 },   // did nothing
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
