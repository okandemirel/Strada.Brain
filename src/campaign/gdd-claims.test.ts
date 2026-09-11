/**
 * The GDD's numbers, read back and answered — or named as unanswerable.
 * Until 2026-09-10 "60 fps" and "loads in under 3 seconds" in a GDD were
 * repeated to the planner and never measured by any gate.
 */
import { describe, expect, it } from "vitest";
import { assessNumericClaims, claimsRefusal, describeClaims, extractNumericClaims } from "./gdd-claims.js";
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
      ["boot_seconds", "max", 0.5],
      ["level_count", "eq", 12],
      ["session_seconds", "max", 90],
    ]);
    expect(claims[1]!.text).toContain("load in under 3 seconds");
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
      ["boot_seconds", 0.5, "not_met", true],
      ["level_count", 12, "unmeasured", false],
      ["session_seconds", 90, "met", true],
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
    expect(lines).toHaveLength(5);
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
    const allPlayed = assessNumericClaims(claims, evidence({ sessionCount: 12, sessions: Array.from({ length: 12 }, (_, i) => ({ index: i + 1, outcome: "Won", actions: 10, seconds: 5 })) }));
    expect(allPlayed.find((x) => x.claim.kind === "level_count")).toMatchObject({ status: "met", measured: 12 });
    expect(allPlayed.find((x) => x.claim.kind === "level_count")!.note).toContain("12 of 12 played session(s) reached an outcome");
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
