import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attemptRunId, CampaignManager, proofSignature, unscheduledGaps } from "./campaign-manager.js";

/**
 * Measured live 2026-09-04: told not to audit, the final sprint answered
 * three times with DOCUMENTS — a gap analysis, an entry-scene audit, a
 * "vertical slice" write-up — and its commit touched 0 code, scene, prefab or
 * asset files. The no-work gate sees a dirty tree and passes it.
 */
const dirs: string[] = [];
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "prose-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
  execFileSync("git", ["config", "user.name", "t"], { cwd: d });
  return d;
}
function commit(root: string, rel: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", `add ${rel}`], { cwd: root });
}
function judge(root: string): boolean {
  const manager = Object.create(CampaignManager.prototype) as CampaignManager;
  (manager as unknown as { projectRoot: string }).projectRoot = root;
  return (manager as unknown as { changedOnlyProse(m: unknown): boolean })
    .changedOnlyProse({ startedAtMs: Date.now() - 3_600_000 });
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("documents are not delivery", () => {
  it("flags a sprint whose only commits are docs", () => {
    const root = repo();
    commit(root, "docs/GapAnalysis.md");
    commit(root, "docs/DELIVERY_REPORT.md");
    expect(judge(root)).toBe(true);
  });

  it("passes a sprint that touched code or a scene", () => {
    const root = repo();
    commit(root, "docs/Notes.md");
    commit(root, "Assets/Modules/Board/Board.cs");
    expect(judge(root)).toBe(false);
  });

  it("leaves an empty sprint to the no-work gate", () => {
    expect(judge(repo())).toBe(false);
  });
});

describe("the delivery budget's signature is a set of KINDS (Codex 2026-09-11 I#1, I#2)", () => {
  it("ignores the numbers inside a proof and names the refusals that carry none", () => {
    const a = proofSignature(
      ["the built player was never played to a verdict (unity_run_player left no verdict)", "play-through: 100 frames captured, level never ends"],
      { structureRefused: false, compileBroken: false },
    );
    const b = proofSignature(
      ["the built player was never played to a verdict (unity_run_player left no verdict)", "play-through: 101 frames captured, level never ends"],
      { structureRefused: false, compileBroken: false },
    );
    // One more captured frame is not progress.
    expect(a).toBe(b);
    // A DIFFERENT missing proof is.
    expect(proofSignature(["no test run was observed"], { structureRefused: false, compileBroken: false })).not.toBe(a);
    // The structural refusal travels in the signature even though it never
    // travelled in missingProofs, and an empty list is never an empty key.
    expect(proofSignature([], { structureRefused: true, compileBroken: false })).toContain("structure-refused");
    expect(proofSignature([], { structureRefused: false, compileBroken: false })).toBe("none-named");
    expect(proofSignature([], { structureRefused: true, compileBroken: false }))
      .not.toBe(proofSignature([], { structureRefused: false, compileBroken: true }));
    // …and the FALLBACK branch, for wording this list does not know, is
    // number-insensitive too (Codex 2026-09-11 I#1).
    expect(proofSignature(["some new gate: 42 widgets short"], { structureRefused: false, compileBroken: false }))
      .toBe(proofSignature(["some new gate: 43 widgets short"], { structureRefused: false, compileBroken: false }));
    expect(proofSignature(["some new gate: 42 widgets short"], { structureRefused: false, compileBroken: false }))
      .not.toBe(proofSignature(["a different gate: 42 widgets short"], { structureRefused: false, compileBroken: false }));
    // WHICH WAY a play-through failed is part of its identity: a game that
    // cannot start a session and one that cannot reach an ending are
    // different problems (Codex 2026-09-11 J#9).
    const notStarted = proofSignature(["play-through: the game refused to start the session"], { structureRefused: false, compileBroken: false });
    const noEnding = proofSignature(["play-through: session 1 never ended after 60 actions"], { structureRefused: false, compileBroken: false });
    expect(notStarted).not.toBe(noEnding);
    // …and the same failure keeps one identity across its measurements.
    expect(noEnding).toBe(proofSignature(["play-through: session 1 never ended after 240 actions"], { structureRefused: false, compileBroken: false }));
    // The EDITOR's missing play-through is not the PLAYER's, whichever words
    // the description happens to use (J#10).
    // This is the EDITOR's own wording for a stale verdict, and it contains
    // "never played" — which is why order matters here.
    const editorMissing = proofSignature(
      ["play-through: the only verdict on disk predates this sprint — the game as delivered was never played"],
      { structureRefused: false, compileBroken: false },
    );
    const editorAbsent = proofSignature(
      ["play-through: NOT observed — nobody played the game as delivered (unity_playthrough never ran)"],
      { structureRefused: false, compileBroken: false },
    );
    // Both are the editor play-through failing to run for this attempt.
    expect(editorMissing).toBe(editorAbsent);
    const playerMissing = proofSignature(["the built player was never played to a verdict (unity_run_player left no verdict)"], { structureRefused: false, compileBroken: false });
    expect(editorMissing).not.toBe(playerMissing);
    expect(playerMissing).toContain("player-not-played");
    // Order does not matter; the set does.
    expect(proofSignature(["no test run was observed", "the project does not compile (3 error(s))"], { structureRefused: false, compileBroken: true }))
      .toBe(proofSignature(["the project does not compile (12 error(s))", "no test run was observed"], { structureRefused: false, compileBroken: true }));
  });
});

describe("which GDD requirements still need a sprint (Codex 2026-09-11 J#12, J#13)", () => {
  const long = "The save system must preserve all unlocked levels and scores across sessions";
  const sharesPrefix = "The save system must preserve all unlocked levels and scores in the cloud too";

  it("names each requirement once, by its whole text", () => {
    expect(unscheduledGaps([long, long, "Boss fight: absent"], [])).toEqual([long, "Boss fight: absent"]);
    // Two requirements sharing sixty characters are two requirements.
    expect(unscheduledGaps([long, sharesPrefix], [])).toEqual([long, sharesPrefix]);
    // Whitespace and case are not identity.
    expect(unscheduledGaps(["Save: absent", "  save:   ABSENT "], [])).toEqual(["Save: absent"]);
    expect(unscheduledGaps(["", "   "], [])).toEqual([]);
  });

  it("a sprint that FAILED covers nothing, and a green or open one covers its own requirement", () => {
    const green = [{ id: "mcov1", title: `Coverage completion 1.1 — ${long.slice(0, 60)}`, status: "green", coverageGap: long }];
    expect(unscheduledGaps([long], green)).toEqual([]);
    const open = [{ id: "mcov1", title: "Coverage completion 1.1 — x", status: "pending", coverageGap: long }];
    expect(unscheduledGaps([long], open)).toEqual([]);
    // …but an attempt that failed is not a requirement delivered.
    const failed = [{ id: "mcov1", title: "Coverage completion 1.1 — x", status: "failed", coverageGap: long }];
    expect(unscheduledGaps([long], failed)).toEqual([long]);
    // A sprint covering a requirement that merely SHARES a prefix covers nothing.
    expect(unscheduledGaps([sharesPrefix], green)).toEqual([sharesPrefix]);
    // A milestone that is not a coverage sprint never covers anything.
    expect(unscheduledGaps([long], [{ id: "m1", title: long, status: "green" }])).toEqual([long]);
  });
});

describe("attemptRunId (the open half of Codex F#10 / I#11)", () => {
  it("is stable within an attempt and different across attempts", () => {
    const m = { id: "m3", attempts: 1, attemptStartedAtMs: 1_700_000_000_000 };
    expect(attemptRunId(m)).toBe(attemptRunId({ ...m }));
    expect(attemptRunId({ ...m, attempts: 2 })).not.toBe(attemptRunId(m));
    expect(attemptRunId({ ...m, attemptStartedAtMs: 1_700_000_000_001 })).not.toBe(attemptRunId(m));
    expect(attemptRunId({ id: "m4", attempts: 1, attemptStartedAtMs: 1_700_000_000_000 })).not.toBe(attemptRunId(m));
    // A milestone that never recorded an attempt clock still has an id.
    expect(attemptRunId({ id: "m1" })).toBe("m1-0-0");
  });
});
