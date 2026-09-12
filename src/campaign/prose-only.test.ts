import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attemptRunId, CampaignManager, capabilityGapWork, closureHolds, coverageRequirementOf, MAX_REPAIRS_PER_REQUIREMENT, repairsForRequirement, withRepairBudget, deliveryFailureKinds, proofSignature, reconcileCapabilityGaps, rememberOwnedTask, OWNERSHIP_LEDGER_LIMIT, unscheduledGaps } from "./campaign-manager.js";

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
    // Each WAY of failing keeps its own tag, including the ones no fixture
    // reached before (Codex 2026-09-11 K's table).
    const tags = [
      "play-through: the game refused to start the session",
      "play-through: the driver took no action at all",
      "play-through: no frame was captured",
      "play-through: session 1 never ended",
      "play-through: IPlaythroughDriver is not registered",
      "play-through: the tool left no verdict",
    ].map((r) => proofSignature([r], { structureRefused: false, compileBroken: false }));
    expect(new Set(tags).size).toBe(tags.length);
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

describe("a requirement's identity, and what a title can prove (Codex 2026-09-12 X#2)", () => {
  it("is identified by its own field or its own prompt line, never by a truncated title", () => {
    expect(coverageRequirementOf({ title: "t", coverageGap: "Boss Alpha: absent" })).toEqual({
      text: "Boss Alpha: absent",
      identified: true,
    });
    expect(coverageRequirementOf({ title: "t", prompt: "Work\r\n- Boss Beta: absent" })).toEqual({
      text: "Boss Beta: absent",
      identified: true,
    });
    // All that is left is a 60-character title: two different requirements
    // reduce to the same words, so this one may be scheduled and reported —
    // never closed.
    const guessed = coverageRequirementOf({ title: "Coverage completion 1.1 — Boss", prompt: "no bullet here" });
    expect(guessed).toEqual({ text: "Boss", identified: false });
  });
});

describe("a repair closes what came before it, by the clock (Codex 2026-09-12 X#4)", () => {
  const gap = "unity_generate_audio (the Unity bridge is not connected)";
  it("reads the attempt times when both sides carry them, not the ladder position", () => {
    // Ladder POSITION is mutable: work is inserted before the final sprint
    // and finals are moved, so a restored row reversed the judgement without
    // changing the evidence.
    const reorderedButOlderRepair = [
      { id: "m1", title: "Audio", status: "green", capabilityGap: gap, attemptStartedAtMs: 300 },
      { id: "mcov1", title: "c", status: "green", coverageGap: capabilityGapWork(gap), attemptStartedAtMs: 200 },
    ];
    expect(reconcileCapabilityGaps(reorderedButOlderRepair)).toEqual([]);
    expect(reorderedButOlderRepair[0]!.capabilityGap).toBe(gap);

    // The repair that really did run later closes it, wherever it sits.
    const laterRepairFirst = [
      { id: "mcov1", title: "c", status: "green", coverageGap: capabilityGapWork(gap), attemptStartedAtMs: 400 },
      { id: "m1", title: "Audio", status: "green", capabilityGap: gap, attemptStartedAtMs: 300 },
    ];
    expect(reconcileCapabilityGaps(laterRepairFirst)).toEqual([gap]);
  });
});

describe("the repair budget applies to every scheduling path (Codex 2026-09-12 W#5)", () => {
  const legacy = (id: string, eol: string) => ({
    id,
    title: "Coverage completion 1.1 — Save the whole unlocked-level st",
    prompt: `The ladder finished, but this item is undelivered:${eol}- Save: the whole unlocked-level state must survive a restart${eol}${eol}Implement it.`,
  });

  it("counts a legacy row's requirement whatever its line endings are", () => {
    const requirement = "Save: the whole unlocked-level state must survive a restart";
    for (const eol of ["\n", "\r\n"]) {
      const ladder = [legacy("mcov1", eol), legacy("mcov2", eol)];
      expect(repairsForRequirement(ladder, requirement)).toBe(2);
      expect(withRepairBudget([requirement], ladder)).toEqual({ schedulable: [], spent: [requirement] });
    }
    // …and one that ends right after the requirement line.
    const trailing = [{ id: "mcov1", title: "Coverage completion 1.1 — Save", prompt: "undelivered:\r\n- Save: absent" }];
    expect(repairsForRequirement(trailing, "Save: absent")).toBe(1);
  });

  it("splits candidates into what may still be repaired and what may not", () => {
    const ladder = [
      { id: "mcov1", title: "c", coverageGap: "Boss: absent" },
      { id: "mcov2", title: "c", coverageGap: "Boss: absent" },
      { id: "mcov3", title: "c", coverageGap: "Shop: absent" },
    ];
    expect(withRepairBudget(["Boss: absent", "Shop: absent", "Save: absent"], ladder)).toEqual({
      schedulable: ["Shop: absent", "Save: absent"],
      spent: ["Boss: absent"],
    });
  });
});

describe("a dirty tree is an unknown revision (Codex 2026-09-12 W#4)", () => {
  const dirty = (root: string): boolean => {
    const manager = Object.create(CampaignManager.prototype) as CampaignManager;
    (manager as unknown as { projectRoot: string }).projectRoot = root;
    return (manager as unknown as { projectIsDirty(): boolean }).projectIsDirty();
  };

  it("is false on a clean checkout, true with uncommitted work, and true where git cannot answer", () => {
    const root = repo();
    commit(root, "Assets/Boss.cs");
    expect(dirty(root)).toBe(false);
    // THE SYSTEM'S OWN OUTPUT IS NOT DIRT. Recordings/ and .strada/ are what
    // a run writes — frames, verdicts, leases — and the commit path excludes
    // them for that reason. Counting them made every tree dirty DURING a run,
    // so a requirement the audit had just closed could never be recorded as
    // closed (Codex 2026-09-12 Y#J4.1).
    mkdirSync(join(root, "Recordings", "run"), { recursive: true });
    writeFileSync(join(root, "Recordings", "run", "playthrough.json"), "{}");
    mkdirSync(join(root, ".strada"), { recursive: true });
    writeFileSync(join(root, ".strada", "lease.json"), "{}");
    expect(dirty(root)).toBe(false);
    writeFileSync(join(root, "Assets", "Boss.cs"), "edited");
    expect(dirty(root)).toBe(true);
    // An untracked file counts too — a worker's new scene is uncommitted work.
    const clean = repo();
    commit(clean, "Assets/A.cs");
    writeFileSync(join(clean, "Assets", "New.unity"), "x");
    expect(dirty(clean)).toBe(true);
    // Not a git tree at all: unknown, so nothing may be cached against it.
    expect(dirty(mkdtempSync(join(tmpdir(), "not-git-")))).toBe(true);
  });
});

describe("a recorded closure and the revision it was read on (Codex 2026-09-12 V#4)", () => {
  it("holds only for the revision it names", () => {
    const sha = "a".repeat(40);
    expect(closureHolds({ coverageClosed: true, coverageClosedRevision: sha }, sha)).toBe(true);
    expect(closureHolds({ coverageClosed: true, coverageClosedRevision: sha }, "b".repeat(40))).toBe(false);
    // An UNKNOWN revision binds nothing, on either side.
    expect(closureHolds({ coverageClosed: true }, sha)).toBe(false);
    expect(closureHolds({ coverageClosed: true, coverageClosedRevision: "" }, sha)).toBe(false);
    expect(closureHolds({ coverageClosed: true, coverageClosedRevision: sha }, "")).toBe(false);
    // …including when NEITHER side knows the revision: two unknowns are not
    // the same tree.
    expect(closureHolds({ coverageClosed: true, coverageClosedRevision: "" }, "")).toBe(false);
    // …and a sprint with no closure at all is not closed.
    expect(closureHolds({ coverageClosedRevision: sha }, sha)).toBe(false);
  });
});

describe("how many repairs one requirement may have (Codex 2026-09-12 V#1)", () => {
  it("counts the sprints for THAT requirement, whatever they are called", () => {
    const gap = capabilityGapWork("unity_generate_audio");
    const ladder = [
      { id: "m1", title: "Audio" },
      { id: "mcov1", title: "Coverage completion 1.1", coverageGap: gap },
      { id: "mcov2", title: "Coverage completion 2.1", coverageGap: `  ${gap}  ` },
      { id: "mcov3", title: "Coverage completion 3.1", coverageGap: capabilityGapWork("unity_create_scene") },
    ];
    expect(repairsForRequirement(ladder, gap)).toBe(MAX_REPAIRS_PER_REQUIREMENT);
    // …and a requirement that differs in CASE has its own budget (Y#1).
    expect(repairsForRequirement(ladder, gap.toUpperCase())).toBe(0);
    expect(repairsForRequirement(ladder, capabilityGapWork("unity_create_scene"))).toBe(1);
    expect(repairsForRequirement(ladder, capabilityGapWork("unity_build_player"))).toBe(0);
  });
});

describe("a capability gap whose repair proved closure (Codex 2026-09-12 U#F1)", () => {
  const gap = "unity_generate_audio (the Unity bridge is not connected)";
  const reporter = (): { id: string; title: string; status: string; capabilityGap: string } => ({
    id: "m4",
    title: "Audio",
    status: "green",
    capabilityGap: gap,
  });
  const repair = (status: string): { id: string; title: string; status: string; coverageGap: string } => ({
    id: "mcov1",
    title: "Coverage completion 1.1 — work no tool was available",
    status,
    coverageGap: capabilityGapWork(gap),
  });

  it("clears the mark the reporting sprint left, so the work is not scheduled again", () => {
    const milestones = [reporter(), repair("green")];
    expect(reconcileCapabilityGaps(milestones)).toEqual([gap]);
    expect(milestones[0]!.capabilityGap).toBeUndefined();
    // And with the mark gone the gap is no longer work to schedule.
    expect(unscheduledGaps([], milestones, { reopenCompleted: true })).toEqual([]);
  });

  it("only a repair that came AFTER the report can close it (Codex 2026-09-12 W#6)", () => {
    // An OLD green repair was clearing a LATER report of the same missing
    // tool: the ladder had said the tool went away again, and the mark for it
    // vanished on the strength of work done before that happened.
    const before = [repair("green"), reporter()];
    expect(reconcileCapabilityGaps(before)).toEqual([]);
    expect(before[1]!.capabilityGap).toBe(gap);
    // The ordinary order still reconciles.
    const after = [reporter(), repair("green")];
    expect(reconcileCapabilityGaps(after)).toEqual([gap]);
  });

  it("keeps the mark when the repair FAILED, or when another gap is what closed", () => {
    const failed = [reporter(), repair("failed")];
    expect(reconcileCapabilityGaps(failed)).toEqual([]);
    expect(failed[0]!.capabilityGap).toBe(gap);
    // A green sprint for a DIFFERENT requirement proves nothing about this one.
    const other = [reporter(), { ...repair("green"), coverageGap: capabilityGapWork("unity_create_scene") }];
    expect(reconcileCapabilityGaps(other)).toEqual([]);
    expect(other[0]!.capabilityGap).toBe(gap);
    // Neither does a green sprint that is not a coverage sprint at all.
    const notCoverage = [reporter(), { ...repair("green"), id: "m5" }];
    expect(reconcileCapabilityGaps(notCoverage)).toEqual([]);
    expect(notCoverage[0]!.capabilityGap).toBe(gap);
  });
});

describe("which GDD requirements still need a sprint (Codex 2026-09-11 J#12, J#13)", () => {
  const long = "The save system must preserve all unlocked levels and scores across sessions";
  const sharesPrefix = "The save system must preserve all unlocked levels and scores in the cloud too";

  it("names each requirement once, by its whole text", () => {
    expect(unscheduledGaps([long, long, "Boss fight: absent"], [])).toEqual([long, "Boss fight: absent"]);
    // Two requirements sharing sixty characters are two requirements.
    expect(unscheduledGaps([long, sharesPrefix], [])).toEqual([long, sharesPrefix]);
    // Whitespace is not identity; CASE IS — "Assets/Art/Hero.png" and
    // ".../hero.png" are two files, and lowercasing them into one dropped the
    // second before any sprint ran for it (Codex 2026-09-12 X#2, Y#1).
    expect(unscheduledGaps(["Save: absent", "  Save:   absent "], [])).toEqual(["Save: absent"]);
    expect(unscheduledGaps(["Ship Assets/Art/Hero.png", "Ship Assets/Art/hero.png"], [])).toEqual([
      "Ship Assets/Art/Hero.png",
      "Ship Assets/Art/hero.png",
    ]);
    expect(unscheduledGaps(["", "   "], [])).toEqual([]);
  });

  it("a FRESH AUDIT reopens a requirement a finished sprint claimed, and a legacy row is still recognised (Codex 2026-09-11 K#1, K#2)", () => {
    const green = [{ id: "mcov1", title: "Coverage completion 1.1 — Save", status: "green", coverageGap: "Save: absent" }];
    // The audit has just looked at the tree and says it is still missing.
    expect(unscheduledGaps(["Save: absent"], green, { reopenCompleted: true })).toEqual(["Save: absent"]);
    // A queue drain does not reopen it: its entries were named by an audit
    // that has already been reconciled.
    expect(unscheduledGaps(["Save: absent"], green)).toEqual([]);
    // Work still outstanding suppresses a duplicate either way.
    const running = [{ id: "mcov1", title: "Coverage completion 1.1 — Save", status: "running", coverageGap: "Save: absent" }];
    expect(unscheduledGaps(["Save: absent"], running, { reopenCompleted: true })).toEqual([]);

    // A milestone persisted before coverageGap existed keeps its requirement
    // in its own prompt, and the truncated title is the last resort.
    const legacy = [{
      id: "mcov1",
      title: `Coverage completion 1.1 — ${long.slice(0, 60)}`,
      status: "running",
      prompt: `The build's milestone ladder finished, but auditing it found this scheduled item undelivered:\n- ${long}\n\nImplement it.`,
    }];
    expect(unscheduledGaps([long], legacy)).toEqual([]);
    expect(unscheduledGaps([sharesPrefix], legacy)).toEqual([sharesPrefix]);
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

describe("deliveryFailureKinds — identity from the gates, not their prose (Codex 2026-09-11 K#3, K#4, K#5)", () => {
  const none = {
    testsNotRun: false, testsFiltered: false, compileBroken: false, compileNotRun: false,
    playthroughMissing: false, playthroughStale: false, playthroughRefused: false,
    buildBroken: false, buildNotRun: false, playerMissing: false, playerBroken: false,
    claimsBroken: false, structureRefused: false, queuedGaps: false, targetUnbuilt: false,
    playthroughUndriveable: false, playthroughNoActions: false, playthroughNoFrames: false,
  };

  it("names the gates that failed, and nothing a sentence can change", () => {
    expect(deliveryFailureKinds(none)).toEqual([]);
    expect(deliveryFailureKinds({ ...none, testsNotRun: true })).toEqual(["testsNotRun"]);
    // The set is the identity: order of the flags cannot change it.
    expect(deliveryFailureKinds({ ...none, compileBroken: true, playerMissing: true }))
      .toEqual(deliveryFailureKinds({ ...none, playerMissing: true, compileBroken: true }));
    // Two different gates are two different identities.
    expect(deliveryFailureKinds({ ...none, playthroughRefused: true }))
      .not.toEqual(deliveryFailureKinds({ ...none, playthroughMissing: true }));
    // A refusal that carries no proof sentence at all still has an identity.
    expect(deliveryFailureKinds({ ...none, structureRefused: true })).toEqual(["structureRefused"]);
    expect(deliveryFailureKinds({ ...none, queuedGaps: true })).toEqual(["queuedGaps"]);
    // A platform the document asked for and nobody built has its own identity
    // instead of falling back to prose (Codex 2026-09-11 L#10).
    expect(deliveryFailureKinds({ ...none, targetUnbuilt: true })).toEqual(["targetUnbuilt"]);
  });

  it("different play-through defects are DIFFERENT work (Codex 2026-09-11 L#7)", () => {
    // A session that refuses to start and a session that captures no frames
    // both read as "playthroughMissing | playthroughRefused", so three rounds
    // fixing the first and one hitting the second exhausted one budget and
    // reported "exactly the same proofs missing".
    const refusedToStart = deliveryFailureKinds({ ...none, playthroughMissing: true, playthroughUndriveable: true });
    const noFrames = deliveryFailureKinds({ ...none, playthroughMissing: true, playthroughRefused: true, playthroughNoFrames: true });
    const noActions = deliveryFailureKinds({ ...none, playthroughMissing: true, playthroughRefused: true, playthroughNoActions: true });
    expect(refusedToStart).not.toEqual(noFrames);
    expect(noFrames).not.toEqual(noActions);
    expect(refusedToStart).toContain("playthroughUndriveable");
  });
});

describe("a milestone's ownership ledger (Codex 2026-09-11 L#4, O#11)", () => {
  it("keeps the earliest roots as well as the newest tasks", () => {
    const milestone = { id: "m1", title: "t", prompt: "p", status: "pending", attempts: 0 } as never as import("./types.js").CampaignMilestone;
    // A milestone resubmitted eighty times keeps EVERY root: each entry the
    // ledger drops is a live lineage nobody can retire afterwards (Codex
    // 2026-09-12 Q#4).
    for (let i = 0; i < 80; i++) rememberOwnedTask(milestone, `task_${i}`);
    expect(milestone.taskIds!.length).toBe(80);

    // Past the bound the oldest entries still survive: they are the abandoned
    // ROOTS retirement has to reach, and trimming from the front alone lost
    // exactly those.
    for (let i = 80; i < OWNERSHIP_LEDGER_LIMIT + 40; i++) rememberOwnedTask(milestone, `task_${i}`);
    expect(milestone.taskIds).toContain("task_0");
    expect(milestone.taskIds).toContain(`task_${OWNERSHIP_LEDGER_LIMIT + 39}`);
    expect(milestone.taskIds!.length).toBeLessThanOrEqual(OWNERSHIP_LEDGER_LIMIT);
    // …and it never records the same task twice.
    rememberOwnedTask(milestone, "task_0");
    expect(milestone.taskIds!.filter((t) => t === "task_0")).toHaveLength(1);
  });
});
