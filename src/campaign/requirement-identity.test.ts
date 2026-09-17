/**
 * PLAN 6.2 — the requirement–evidence map's SURFACE.
 *
 * The core of 6.2 (a typed, requirement-specific evidence predicate) is tested
 * in campaign-planner.test.ts. These are the tests for the other half: WHICH
 * requirement a proof belongs to across GDD revisions.
 *
 * The planner-side tests live here rather than in campaign-planner.test.ts
 * because this change's file lane covers this test file; they are named so
 * that is obvious.
 */

import { describe, expect, it, vi } from "vitest";
import {
  contentFingerprint,
  contentTokens,
  decodeIdentities,
  decodeRequirement,
  encodeRequirement,
  identifyRequirements,
  isCosmeticRewording,
  mintRequirementId,
  normalizeWording,
  reconcileRequirements,
  requirementText,
  stemWord,
  subjectFingerprint,
  wordingFingerprint,
  type RequirementIdentity,
} from "./requirement-identity.js";
import { CampaignPlanner, closingFact, quotableFactsOf, saysItIsNotThere } from "./campaign-planner.js";

const SHA1 = "1".repeat(64);
const SHA2 = "2".repeat(64);

describe("normalizeWording", () => {
  it("drops the decoration a document editor adds without changing the ask", () => {
    const plain = normalizeWording("Save progress across restarts");
    expect(normalizeWording("  - **Save  Progress   across restarts.**  ")).toBe(plain);
    expect(normalizeWording("3. Save progress across restarts")).toBe(plain);
    expect(normalizeWording("> `Save progress across restarts`")).toBe(plain);
  });

  it("drops the audit's verdict suffix and a run-specific tail, not the ask", () => {
    expect(normalizeWording("Shop: absent")).toBe("shop");
    expect(normalizeWording("Shop: no milestone implemented it")).toBe("shop");
    expect(normalizeWording("Shop: absent, attempt 3")).toBe("shop");
    // The substance after a colon is NOT a verdict suffix and stays.
    expect(normalizeWording("Level count: 13 levels")).toBe("level count: 13 levels");
  });

  it("splits camelCase before folding case, so SaveSystem and Save System are one wording", () => {
    expect(wordingFingerprint("SaveSystem persists")).toBe(wordingFingerprint("Save System persists"));
  });
});

describe("contentTokens", () => {
  it("keeps numbers and negations verbatim and stems the rest", () => {
    expect(contentTokens("Save progress across restarts: absent")).toEqual(["sav", "progress", "across", "restart"]);
    expect(contentTokens("12 levels")).toEqual(["12", "level"]);
    expect(contentTokens("The boss is not defeated")).toEqual(["boss", "not", "defeat"]);
    // "3,000 coins" and "3.000 coins" are the same figure.
    expect(contentTokens("3,000 coins")).toEqual(contentTokens("3.000 coins"));
    expect(contentTokens("3,000 coins")[0]).toBe("3000");
    // A decimal is a figure, not a separator.
    expect(contentTokens("loads in 2.5 seconds")).toContain("2.5");
  });

  it("uses the same stemmer as the evidence matcher", () => {
    // One stemmer, or a requirement could be "the same" for evidence matching
    // and "different" for identity.
    expect(stemWord("restarts")).toBe("restart");
    expect(contentTokens("Saving progress")).toEqual(contentTokens("Save progress"));
  });
});

describe("isCosmeticRewording — the rule stated in code", () => {
  const cosmetic: Array<[string, string]> = [
    ["Save progress across restarts: absent", "- **Saving progress across restarts.**"],
    ["Shop: absent", "shop"],
    ["The shop must be implemented", "The shop is implemented"],
    ["12 levels: absent", "12 Levels"],
    ["Boss fight: absent, attempt 2", "Boss fight: absent"],
  ];
  it.each(cosmetic)("cosmetic: %s ↔ %s", (a, b) => {
    expect(isCosmeticRewording(a, b)).toBe(true);
  });

  const substantive: Array<[string, string]> = [
    // A changed number.
    ["12 levels", "13 levels"],
    ["Level count: 13 levels", "Level count: 20 levels"],
    // An added clause.
    ["Save progress across restarts", "Save progress across restarts and to the cloud"],
    // A dropped negation — the case a fingerprint that ignored stopwords would
    // have let inherit the opposite requirement's proof.
    ["The boss is defeated", "The boss is not defeated"],
    // A changed verb.
    ["Save progress", "Load progress"],
    // A changed preposition: "to disk" is not "from disk".
    ["Save progress to disk", "Save progress from disk"],
    // A fresh diagnosis of the same ask.
    ["Shop: absent", "Shop: the UI shell exists but nothing sells"],
  ];
  it.each(substantive)("NOT cosmetic: %s ↔ %s", (a, b) => {
    expect(isCosmeticRewording(a, b)).toBe(false);
  });

  it("never judges two contentless requirements the same one", () => {
    expect(contentTokens("???")).toEqual([]);
    expect(isCosmeticRewording("???", "—")).toBe(false);
    expect(contentFingerprint("???").startsWith("exact:")).toBe(true);
  });
});

describe("the id", () => {
  it("is derived from position and the wording fingerprint, deterministically", () => {
    expect(mintRequirementId("Shop: absent", 1)).toBe(mintRequirementId("Shop: absent", 1));
    expect(mintRequirementId("Shop: absent", 1)).toMatch(/^req-001-[0-9a-f]{12}$/);
    expect(mintRequirementId("Shop: absent", 2)).not.toBe(mintRequirementId("Shop: absent", 1));
  });

  it("is never the id of a DIFFERENT requirement, even at the same position", () => {
    expect(mintRequirementId("Boss Alpha: absent", 1)).not.toBe(mintRequirementId("Boss Beta: absent", 1));
    // …and the id fingerprints its own wording, so a text/id mismatch is detectable.
    const id = mintRequirementId("Boss Alpha: absent", 1);
    expect(id.endsWith(wordingFingerprint("Boss Alpha: absent"))).toBe(true);
    expect(id.endsWith(wordingFingerprint("Boss Beta: absent"))).toBe(false);
  });

  it("gives two requirements with identical wording distinct ids in one revision", () => {
    const { result } = identifyRequirements({ texts: ["Shop: absent", "Shop: absent"] });
    expect(result.identities[0]!.id).not.toBe(result.identities[1]!.id);
  });
});

describe("carriage through the persisted string", () => {
  it("round-trips the id, the lineage, the GDD revision, supersedes and the flags", () => {
    const identity: RequirementIdentity = {
      id: "req-003-0123456789ab",
      text: "Save progress across restarts: absent",
      lineage: "req-001-ffffffffffff",
      gddSha256: SHA1,
      gddRevision: 4,
      supersedes: ["req-001-ffffffffffff"],
      evidenceCarried: true,
    };
    const encoded = encodeRequirement(identity);
    expect(decodeRequirement(encoded).identity).toEqual(identity);
    // The FULL sha travels, so no comparison has to be a prefix test.
    expect(encoded).toContain(SHA1);
  });

  it("hands back the text alone for a person, a worker or a model", () => {
    const encoded = encodeRequirement({
      id: "req-001-0123456789ab",
      text: "Shop: absent",
      lineage: "req-001-0123456789ab",
    });
    expect(requirementText(encoded)).toBe("Shop: absent");
    // A legacy requirement never carried a tail and reads unchanged.
    expect(requirementText("Shop: absent")).toBe("Shop: absent");
    expect(decodeRequirement("Shop: absent").identity).toBeUndefined();
    expect(decodeIdentities(["Shop: absent", encoded]).map((i) => i.id)).toEqual(["req-001-0123456789ab"]);
  });

  it("is stable across calls, so a persisted requirement keys the same every round", () => {
    const first = identifyRequirements({ texts: ["Shop: absent", "Boss: absent"], gdd: { sha256: SHA1, revision: 1 } });
    // The next audit reports them in a different order; the identities are
    // reconciled by wording, so the strings are byte-identical.
    const second = identifyRequirements({
      previous: first.result.identities,
      texts: ["Boss: absent", "Shop: absent"],
      gdd: { sha256: SHA2, revision: 2 },
    });
    expect(second.encoded.slice().sort()).toEqual(first.encoded.slice().sort());
  });
});

describe("reconcileRequirements across GDD revisions", () => {
  const revisionOne = (): RequirementIdentity[] =>
    reconcileRequirements({
      texts: ["Shop: absent", "Save progress across restarts: absent", "Level count: 13 levels"],
      gdd: { sha256: SHA1, revision: 1 },
    }).identities;

  it("keeps the id and the originating GDD revision when the wording did not change", () => {
    const before = revisionOne();
    const after = reconcileRequirements({
      previous: before,
      texts: ["Shop: absent", "Save progress across restarts: absent", "Level count: 13 levels"],
      gdd: { sha256: SHA2, revision: 2 },
      proven: new Set([before[0]!.id]),
    });
    expect(after.identities.map((i) => i.id)).toEqual(before.map((i) => i.id));
    // The GDD version that the WORDING came from travels with the id — it did
    // not come from revision 2 just because revision 2 also asks for it.
    expect(after.identities[0]!.gddSha256).toBe(SHA1);
    expect(after.identities[0]!.gddRevision).toBe(1);
    expect(after.reopened).toEqual([]);
  });

  it("carries a proven requirement's evidence across a COSMETIC rewording, with a supersedes link", () => {
    const before = revisionOne();
    const after = reconcileRequirements({
      previous: before,
      texts: ["Shop: absent", "- **Saving progress across restarts.**", "Level count: 13 levels"],
      gdd: { sha256: SHA2, revision: 2 },
      proven: new Set([before[1]!.id]),
    });
    const reworded = after.identities[1]!;
    expect(reworded.id).not.toBe(before[1]!.id);
    expect(reworded.supersedes).toEqual([before[1]!.id]);
    // The LINEAGE is the requirement's identity across rewordings.
    expect(reworded.lineage).toBe(before[1]!.lineage);
    expect(reworded.evidenceCarried).toBe(true);
    expect(reworded.reopened).toBeUndefined();
    // …and the new wording is stamped with the revision it came from.
    expect(reworded.gddSha256).toBe(SHA2);
    expect(reworded.gddRevision).toBe(2);
  });

  it("carries nothing when the cosmetically reworded requirement was never proven", () => {
    const before = revisionOne();
    const after = reconcileRequirements({
      previous: before,
      texts: ["Shop: absent", "Saving progress across restarts", "Level count: 13 levels"],
      gdd: { sha256: SHA2, revision: 2 },
      proven: new Set(),
    });
    expect(after.identities[1]!.supersedes).toEqual([before[1]!.id]);
    expect(after.identities[1]!.evidenceCarried).toBeUndefined();
  });

  it("REOPENS a proven requirement whose figure changed — the non-cosmetic case", () => {
    const before = revisionOne();
    const after = reconcileRequirements({
      previous: before,
      texts: ["Shop: absent", "Save progress across restarts: absent", "Level count: 20 levels"],
      gdd: { sha256: SHA2, revision: 2 },
      proven: new Set([before[2]!.id]),
    });
    const changed = after.identities[2]!;
    expect(changed.id).not.toBe(before[2]!.id);
    expect(changed.lineage).toBe(before[2]!.lineage); // the history is kept
    expect(changed.evidenceCarried).toBeUndefined(); // the proof is NOT kept
    expect(changed.reopened).toBe(true);
    expect(after.reopened.map((i) => i.id)).toEqual([changed.id]);
  });

  it("REOPENS a proven requirement the revision rediagnosed rather than reworded", () => {
    const before = revisionOne();
    const after = reconcileRequirements({
      previous: before,
      texts: ["Shop: the UI shell exists but nothing sells", "Save progress across restarts: absent", "Level count: 13 levels"],
      gdd: { sha256: SHA2, revision: 2 },
      proven: new Set([before[0]!.id]),
    });
    expect(after.identities[0]!.lineage).toBe(before[0]!.lineage);
    expect(after.identities[0]!.evidenceCarried).toBeUndefined();
    expect(after.identities[0]!.reopened).toBe(true);
  });

  it("links a positional rewording that still shares the ask, and never carries its evidence", () => {
    const before = reconcileRequirements({ texts: ["Dragon boss spawns in the final wave: absent"] }).identities;
    const after = reconcileRequirements({
      previous: before,
      texts: ["The dragon boss must spawn during the final wave of the last level"],
      proven: new Set([before[0]!.id]),
    });
    expect(after.identities[0]!.lineage).toBe(before[0]!.lineage);
    expect(after.identities[0]!.supersedes).toEqual([before[0]!.id]);
    expect(after.identities[0]!.evidenceCarried).toBeUndefined();
    expect(after.identities[0]!.reopened).toBe(true);
  });

  it("mints a fresh lineage for a genuinely new requirement and retires a dropped one", () => {
    const before = revisionOne();
    const after = reconcileRequirements({
      previous: before,
      texts: ["Shop: absent", "Save progress across restarts: absent", "Boss fight: absent"],
      gdd: { sha256: SHA2, revision: 2 },
    });
    const fresh = after.identities[2]!;
    expect(fresh.supersedes).toBeUndefined();
    expect(fresh.lineage).toBe(fresh.id);
    expect(after.retired.map((i) => i.id)).toEqual([before[2]!.id]);
  });

  it("lets only ONE new wording inherit a predecessor", () => {
    // Two new wordings, both cosmetically equal to the one proven requirement:
    // the predecessor is claimed once, so the second is a requirement of its
    // own rather than a second inheritor of the same proof.
    const before = reconcileRequirements({ texts: ["Shop: absent"] }).identities;
    const after = reconcileRequirements({
      previous: before,
      texts: ["A shop", "The shop"],
      proven: new Set([before[0]!.id]),
    });
    expect(after.identities.filter((i) => i.evidenceCarried === true)).toHaveLength(1);
    expect(after.identities[0]!.evidenceCarried).toBe(true);
    expect(after.identities[1]!.lineage).toBe(after.identities[1]!.id);
    expect(after.identities[0]!.id).not.toBe(after.identities[1]!.id);
  });
});

// ─── the planner's side ─────────────────────────────────────────────────────

function plannerWith(replies: string[]): { planner: CampaignPlanner; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async () => ({ text: replies.shift() ?? "" }));
  const provider = { chat, name: "test", capabilities: { streaming: false } } as never;
  return { planner: new CampaignPlanner(provider), chat };
}

const SAVE_MILESTONE = {
  title: "Sprint A — Save",
  status: "green",
  commitNote: "2 commit(s): Assets/Scripts/SaveSystem.cs",
  testVerdict: "179/179 tests passed",
  testVerdictUnfiltered: true,
};

describe("campaign-planner: the requirement–evidence predicate, exported for the eval", () => {
  it("quotableFactsOf is the record a verdict may quote — status out, filtered suite out", () => {
    const facts = quotableFactsOf([
      { status: "failed", testVerdict: "42/42 tests passed", testVerdictUnfiltered: false, commitNote: "Committed 1 file(s) as abcdef1" },
      SAVE_MILESTONE,
    ]);
    expect(facts.some((f) => f.startsWith("status:"))).toBe(false);
    expect(facts.some((f) => f.includes("(FILTERED"))).toBe(false);
    // A commit note that names no content closes nothing (Codex 2026-09-13 AJ).
    expect(facts.some((f) => f.includes("Committed 1 file(s)"))).toBe(false);
    expect(facts).toContain("landed: 2 commit(s): Assets/Scripts/SaveSystem.cs");
  });

  /**
   * The defect the requirement–evidence eval measured: the predicate asked
   * whether a measured line is ABOUT the requirement and never whether it says
   * the thing is there, so the system's own finding of absence closed the
   * requirement it was about.
   */
  it("a measurement of ABSENCE is not evidence of presence", () => {
    const absent: Array<[string, string, Record<string, unknown>]> = [
      ["Bomb element: absent", "GDD element schedule: 2 of 14 scheduled element(s) have NO trace in code: L3 Bomb, L5 Rocket", { structureFindings: ["GDD element schedule: 2 of 14 scheduled element(s) have NO trace in code: L3 Bomb, L5 Rocket"] }],
      ["World renderers in the shipped scenes: absent", "0 world renderers", { structureFindings: ["0 world renderers in the shipped scenes"] }],
      ["Frame rate at least 60 fps: absent", "NOT MET", { gddClaims: ["GDD frame rate ≥ 60 fps: NOT MET — 41 fps average in the editor under -batchmode"] }],
      ["Boot time under 3 seconds: absent", "NOT MEASURED", { gddClaims: ["GDD boot time ≤ 3 s: NOT MEASURED — the play-through recorded no frame timing"] }],
      ["Entry scene: absent", "REFUSAL STANDS", { structureFindings: ["REFUSAL STANDS at delivery: no enabled scene holds the game"] }],
      ["Element schedule: absent", "unreadable table", { structureFindings: ["GDD element schedule: the document HOLDS a schedule table and none of its rows could be read — nothing was compared against the code"] }],
    ];
    for (const [requirement, , milestone] of absent) {
      const facts = quotableFactsOf([milestone as never]);
      expect(closingFact(requirement, facts), requirement).toBeUndefined();
    }
  });

  it("…and the POSITIVE form of the same measurement still closes it", () => {
    // Tightening a gate cuts both ways: a stricter read that hid a real pass
    // would turn a measured closure into "not measured".
    expect(
      closingFact(
        "Element schedule: absent",
        quotableFactsOf([{ structureFindings: ["GDD element schedule: all 14 scheduled element(s) have a trace in code"] }]),
      ),
    ).toBe("shipped tree: GDD element schedule: all 14 scheduled element(s) have a trace in code");
    expect(
      closingFact(
        "Frame rate at least 60 fps: absent",
        quotableFactsOf([{ gddClaims: ["GDD frame rate ≥ 60 fps: MET — 62 fps average in the editor under -batchmode"] }]),
      ),
    ).toContain("MET");
    // A worker's own prose is not one of the system's negative templates.
    expect(
      closingFact(
        "Tile spawner: absent",
        quotableFactsOf([{ commitNote: "2 commit(s): do not spawn twice — Assets/Scripts/TileSpawner.cs" }]),
      ),
    ).toContain("TileSpawner.cs");
    expect(saysItIsNotThere("landed: Added Assets/Scripts/NotMetGate.cs")).toBe(false);
  });

  it("closingFact names the measured line that closes a requirement, and nothing else", () => {
    const facts = quotableFactsOf([SAVE_MILESTONE]);
    expect(closingFact("Save progress across restarts: absent", facts)).toBe(
      "landed: 2 commit(s): Assets/Scripts/SaveSystem.cs",
    );
    expect(closingFact("Dragon boss: absent", facts)).toBeUndefined();
  });

  it("reads a requirement through its identity tail — the id is not part of the ask", () => {
    const facts = quotableFactsOf([SAVE_MILESTONE]);
    const encoded = encodeRequirement({
      id: "req-002-0123456789ab",
      text: "Save progress across restarts: absent",
      lineage: "req-002-0123456789ab",
      gddSha256: SHA1,
      gddRevision: 1,
    });
    expect(closingFact(encoded, facts)).toBe("landed: 2 commit(s): Assets/Scripts/SaveSystem.cs");
    // The tail's hex must not become one of the requirement's words either.
    expect(closingFact(encoded, ["landed: Assets/Scripts/Req0020123456789ab.cs"])).toBeUndefined();
  });
});

describe("campaign-planner.auditCoverage: stamping identities", () => {
  it("leaves the requirement text alone unless the caller asks for identities", async () => {
    const { planner } = plannerWith(['{"missing": ["Shop: absent"]}']);
    expect(await planner.auditCoverage("# GDD", [{ title: "Sprint A" }])).toEqual(["Shop: absent"]);
  });

  it("stamps a stable id and the audited document's sha when asked", async () => {
    const { planner } = plannerWith(['{"missing": ["Shop: absent", "Boss: absent"]}']);
    const missing = await planner.auditCoverage("# GDD", [{ title: "Sprint A" }], { identity: true, gddRevision: 3 });
    const identities = decodeIdentities(missing);
    expect(identities).toHaveLength(2);
    expect(identities[0]!.id).toBe(mintRequirementId("Shop: absent", 1));
    expect(identities[0]!.gddRevision).toBe(3);
    // No sha supplied → the sha of the document actually audited.
    expect(identities[0]!.gddSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(missing.map(requirementText)).toEqual(["Shop: absent", "Boss: absent"]);
  });

  it("reconciles against the identities the campaign already persisted", async () => {
    const first = identifyRequirements({ texts: ["Shop: absent"], gdd: { sha256: SHA1, revision: 1 } });
    const { planner } = plannerWith(['{"missing": ["Shop: the UI shell exists but nothing sells"]}']);
    const missing = await planner.auditCoverage(
      "# GDD",
      [{ title: "Coverage completion 1.1 — Shop", coverageGap: first.encoded[0]!, coverageClosed: true }],
      { identity: true, gddSha256: SHA2, gddRevision: 2 },
    );
    const identity = decodeRequirement(missing[0]!).identity!;
    expect(identity.lineage).toBe(first.result.identities[0]!.lineage);
    // Rediagnosed, not reworded cosmetically: the proof does NOT travel.
    expect(identity.evidenceCarried).toBeUndefined();
    expect(identity.reopened).toBe(true);
  });
});

describe("campaign-planner.resolveCoverageGaps: identity-aware", () => {
  const verdict = (id: number, evidence: string): string =>
    JSON.stringify({ verdicts: [{ id, delivered: true, evidence }] });

  it("shows the model the requirement, not its id tail, and returns the encoded string", async () => {
    const encoded = encodeRequirement({
      id: "req-001-0123456789ab",
      text: "Save progress across restarts: absent",
      lineage: "req-001-0123456789ab",
      gddSha256: SHA1,
      gddRevision: 1,
    });
    const { planner, chat } = plannerWith([verdict(1, "2 commit(s): Assets/Scripts/SaveSystem.cs")]);
    const answer = await planner.resolveCoverageGaps("# GDD", [encoded], [SAVE_MILESTONE]);
    const sent = JSON.stringify(chat.mock.calls[0]);
    expect(sent).toContain("1. Save progress across restarts: absent");
    expect(sent).not.toContain("req-001-0123456789ab");
    // The identity survives the round trip, so the campaign keeps it.
    expect(answer.closed).toEqual([encoded]);
  });

  it("closes a cosmetically reworded requirement on the evidence that is still in the record", async () => {
    const before = reconcileRequirements({ texts: ["Save progress across restarts: absent"], gdd: { sha256: SHA1, revision: 1 } }).identities;
    const { encoded } = identifyRequirements({
      previous: before,
      texts: ["Saving progress across restarts"],
      gdd: { sha256: SHA2, revision: 2 },
      proven: new Set([before[0]!.id]),
    });
    // The model answers "not delivered" — it has no memory of the closure.
    const { planner } = plannerWith([JSON.stringify({ verdicts: [{ id: 1, delivered: false }] })]);
    const answer = await planner.resolveCoverageGaps("# GDD", encoded, [SAVE_MILESTONE]);
    expect(answer.closed).toEqual(encoded);
  });

  it("does NOT close it when the measured line that proved it is gone from the record", async () => {
    // The inherited quote is a quote, not a closure: the evidence must still be
    // there on this tree (Codex 2026-09-12 V#4).
    const before = reconcileRequirements({ texts: ["Save progress across restarts: absent"] }).identities;
    const { encoded } = identifyRequirements({
      previous: before,
      texts: ["Saving progress across restarts"],
      proven: new Set([before[0]!.id]),
    });
    const { planner } = plannerWith([JSON.stringify({ verdicts: [{ id: 1, delivered: false }] })]);
    const answer = await planner.resolveCoverageGaps("# GDD", encoded, [
      { title: "Sprint A", status: "green", commitNote: "1 commit(s): Assets/Art/Hero.png" },
    ]);
    expect(answer.closed).toEqual([]);
    expect(answer.open).toEqual(encoded);
  });

  it("leaves a NON-cosmetically reworded requirement open, evidence or not", async () => {
    const before = reconcileRequirements({ texts: ["Level count: 13 levels"] }).identities;
    const { encoded } = identifyRequirements({
      previous: before,
      texts: ["Level count: 20 levels"],
      proven: new Set([before[0]!.id]),
    });
    const { planner } = plannerWith([JSON.stringify({ verdicts: [{ id: 1, delivered: false }] })]);
    const answer = await planner.resolveCoverageGaps("# GDD", encoded, [
      { title: "Sprint A", status: "green", gddClaims: ["document numbers: 13 levels claimed; 13 played to an outcome"], testVerdict: "1/1", testVerdictUnfiltered: true },
    ]);
    expect(answer.closed).toEqual([]);
  });
});
