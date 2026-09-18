/**
 * Codex round 13 #27–#31 — plan 6.2's identity, used for the RIGHT JOB.
 *
 * The identity landed in 5e69b10a/51543497 and was then asked to do two jobs
 * it cannot do at once. A `lineage` is HISTORY: it says two wordings are the
 * same requirement over time. What gets SCHEDULED and CLOSED is the
 * requirement as it is worded NOW — and carried evidence is only as good as
 * the tree it was measured on. Five defects, each reproduced here before it
 * was fixed:
 *
 *   #27 `Enable AI` → `Enable UI` and `Score < 10` → `Score > 10` had
 *       identical content fingerprints (short words and operators were
 *       dropped), so one could inherit the other's proof.
 *   #28 a reopened `20 levels` shared a KEY with its closed `13 levels`
 *       predecessor: closure grouped them, asked only about 13, and stamped
 *       both closed.
 *   #29 a legacy (identity-less) running gap was invisible to the audit's
 *       reconciliation, so its re-listing minted a fresh `req:…` key and was
 *       scheduled a second time with a fresh repair budget.
 *   #30 an encoded requirement reached a person verbatim, `⟦rid:…⟧` and all.
 *   #31 a historical `SaveSystem.cs` commit note closed a cosmetically
 *       reworded requirement on a tree from which the save system had been
 *       removed, over the model's own `delivered:false`.
 *
 * The opposite direction is tested too, because a stricter reading of the
 * identity could just as easily lose a proof that still stands: an unchanged
 * requirement keeps its closure, and a cosmetic rewording does not re-prove
 * what is still true on the same tree.
 */
import { describe, expect, it, vi } from "vitest";
import { CampaignManager, requirementKey, restoreLegacyWordings } from "./campaign-manager.js";
import { CampaignPlanner } from "./campaign-planner.js";
import {
  contentFingerprint,
  encodeRequirement,
  identifyRequirements,
  isCosmeticRewording,
  reconcileRequirements,
  requirementText,
} from "./requirement-identity.js";
import type { Campaign, CampaignMilestone } from "./types.js";

const REV_PROVEN = "a".repeat(40);
const REV_NOW = "b".repeat(40);
const GDD_1 = { sha256: "c".repeat(64), revision: 1 };
const GDD_2 = { sha256: "d".repeat(64), revision: 2 };

const SAVE_MILESTONE = {
  title: "Sprint A — Save",
  status: "green",
  commitNote: "2 commit(s): Assets/Scripts/SaveSystem.cs",
  testVerdict: "179/179 tests passed",
  testVerdictUnfiltered: true,
};

function plannerWith(replies: string[]): { planner: CampaignPlanner; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async () => ({ text: replies.shift() ?? "" }));
  const provider = { chat, name: "test", capabilities: { streaming: false } } as never;
  return { planner: new CampaignPlanner(provider), chat };
}

/**
 * The live coverage paths, without a campaign to boot: both are private, and
 * both are what the findings name. Everything they touch outside the campaign
 * record is stubbed as an own property.
 */
interface CoveragePaths {
  openRequirements: (c: Campaign) => Promise<{ open: string[]; auditFailed?: string }>;
  buildCoverageRemediation: (c: Campaign) => Promise<CampaignMilestone[] | undefined>;
}

function coveragePaths(overrides: Record<string, unknown>): CoveragePaths {
  const manager = Object.create(CampaignManager.prototype) as Record<string, unknown>;
  Object.assign(
    manager,
    {
      persist: () => true,
      projectRoot: "/nonexistent-project-root",
      projectRevision: () => REV_NOW,
      projectRepoState: () => "revision",
      projectIsDirty: () => false,
      projectFingerprint: () => "",
    },
    overrides,
  );
  return manager as unknown as CoveragePaths;
}

// ─── #27 — a semantic change is never cosmetic ──────────────────────────────

describe("#27 short semantic tokens and operators are part of the content", () => {
  it("does not merge two-letter subjects: Enable AI is not Enable UI", () => {
    expect(contentFingerprint("Enable AI")).not.toBe(contentFingerprint("Enable UI"));
    expect(isCosmeticRewording("Enable AI", "Enable UI")).toBe(false);
  });

  it("keeps comparison operators: Score < 10 is not Score > 10", () => {
    expect(contentFingerprint("Score < 10")).not.toBe(contentFingerprint("Score > 10"));
    expect(isCosmeticRewording("Score < 10", "Score > 10")).toBe(false);
    // …and "at least 60 fps" is not "60 fps".
    expect(isCosmeticRewording("60+ fps", "60 fps")).toBe(false);
  });

  it("keeps a two-letter preposition, which the doctrine already claimed it did", () => {
    // The module's own comment: prepositions stay in, because "save TO disk"
    // is not "save FROM disk". A two-letter one was dropped by the length
    // filter, so "to disk" and bare "disk" were one requirement.
    expect(isCosmeticRewording("Save progress to disk", "Save progress disk")).toBe(false);
  });

  it("a proven requirement's evidence is never inherited by a different short-token ask", () => {
    const before = reconcileRequirements({ texts: ["Enable AI"], gdd: GDD_1 }).identities;
    const after = identifyRequirements({
      previous: before,
      texts: ["Enable UI"],
      gdd: GDD_2,
      proven: new Set([before[0]!.id]),
    });
    expect(after.result.identities[0]!.evidenceCarried).not.toBe(true);
  });

  it("…and an operator flip REOPENS the requirement instead of inheriting its proof", () => {
    const before = reconcileRequirements({ texts: ["Score < 10 ends the session"], gdd: GDD_1 }).identities;
    const after = identifyRequirements({
      previous: before,
      texts: ["Score > 10 ends the session"],
      gdd: GDD_2,
      proven: new Set([before[0]!.id]),
    });
    expect(after.result.identities[0]!.evidenceCarried).not.toBe(true);
    expect(after.result.identities[0]!.reopened).toBe(true);
  });

  // THE OPPOSITE DIRECTION: keeping short tokens must not turn decoration,
  // case or the audit's verdict suffix into a rewording.
  it("a genuinely cosmetic rewording of a short-token ask still carries", () => {
    expect(isCosmeticRewording("- **Enable AI**", "Enable AI: absent")).toBe(true);
    expect(isCosmeticRewording("Score < 10", "score  <  10.")).toBe(true);
    expect(isCosmeticRewording("The game runs at 60 fps", "the game runs at 60 fps, attempt 3")).toBe(true);
  });
});

// ─── #28 — the current wording is what is scheduled and closed ──────────────

/** A proven "13 levels" and the "20 levels" revision reopened it as. */
function levelCountPair(): { closed: string; reopened: string } {
  const before = reconcileRequirements({ texts: ["Level count: 13 levels"], gdd: GDD_1 }).identities;
  const after = identifyRequirements({
    previous: before,
    texts: ["Level count: 20 levels"],
    gdd: GDD_2,
    proven: new Set([before[0]!.id]),
  });
  expect(after.result.identities[0]!.reopened).toBe(true);
  expect(after.result.identities[0]!.lineage).toBe(before[0]!.lineage);
  return { closed: encodeRequirement(before[0]!), reopened: after.encoded[0]! };
}

describe("#28 lineage is history; the current version is the identity for closure", () => {
  it("a reopened requirement does not share its closed predecessor's key", () => {
    const { closed, reopened } = levelCountPair();
    expect(requirementKey(reopened)).not.toBe(requirementKey(closed));
  });

  it("a COSMETIC rewording still shares the key, so the repair budget survives it", () => {
    const before = reconcileRequirements({ texts: ["The player can save and load progress"], gdd: GDD_1 }).identities;
    const { encoded } = identifyRequirements({
      previous: before,
      texts: ["the player can save and load progress."],
      gdd: GDD_2,
    });
    expect(requirementKey(encoded[0]!)).toBe(requirementKey(encodeRequirement(before[0]!)));
  });

  it("closure asks about the wording the document asks for NOW, and closes only that one", async () => {
    const { closed, reopened } = levelCountPair();
    const asked: string[] = [];
    // A resolver whose record only ever measured THIRTEEN levels.
    const resolveCoverageGaps = vi.fn(async (_gdd: string, reqs: readonly string[]) => {
      asked.push(...reqs.map((r) => requirementText(r)));
      const closedNow = reqs.filter((r) => requirementText(r).includes("13 levels"));
      return { closed: closedNow, open: reqs.filter((r) => !closedNow.includes(r)), unasked: [] };
    });
    const campaign = {
      id: "c-28",
      gddText: "# GDD",
      milestones: [
        {
          id: "mcov1",
          title: "Coverage completion 1.1 — Level count",
          prompt: "- Level count: 13 levels\n",
          coverageGap: closed,
          status: "green",
          attempts: 2,
          coverageClosed: true,
          coverageClosedRevision: REV_NOW,
        },
        {
          id: "mcov2",
          title: "Coverage completion 2.1 — Level count",
          prompt: "- Level count: 20 levels\n",
          coverageGap: reopened,
          status: "failed",
          attempts: 2,
        },
      ],
    } as unknown as Campaign;

    const result = await coveragePaths({ planner: { resolveCoverageGaps } }).openRequirements(campaign);

    // The question is about the requirement as it stands now…
    expect(asked.join(" | ")).toContain("20 levels");
    // …the evidence for thirteen does not answer it…
    expect(result.open.map(requirementText)).toContain("Level count: 20 levels");
    expect(campaign.milestones[1]!.coverageClosed).not.toBe(true);
    // …and the predecessor's own proven closure is left exactly as it was.
    expect(campaign.milestones[0]!.coverageClosed).toBe(true);
  });

  it("asks with the NEWEST wording when one requirement has several sprints", async () => {
    // Two repairs for one requirement, the document having tidied the wording
    // in between. They are one requirement — one question — and the question is
    // the wording that stands, not the one the first sprint was created with.
    const first = reconcileRequirements({ texts: ["Shop: absent"], gdd: GDD_1 }).identities;
    const tidied = identifyRequirements({
      previous: first,
      texts: ["- **Shop**"],
      gdd: GDD_2,
    });
    const asked: string[] = [];
    const resolveCoverageGaps = vi.fn(async (_gdd: string, reqs: readonly string[]) => {
      asked.push(...reqs.map((r) => requirementText(r)));
      return { closed: [], open: [...reqs], unasked: [] };
    });
    const row = (id: string, gap: string): unknown => ({
      id,
      title: `Coverage completion — ${requirementText(gap)}`,
      prompt: `- ${requirementText(gap)}\n`,
      coverageGap: gap,
      status: "failed",
      attempts: 2,
    });
    const campaign = {
      id: "c-28d",
      gddText: "# GDD",
      milestones: [row("mcov1", encodeRequirement(first[0]!)), row("mcov2", tidied.encoded[0]!)],
    } as unknown as Campaign;

    await coveragePaths({ planner: { resolveCoverageGaps } }).openRequirements(campaign);

    // One question for the one requirement, in its current wording.
    expect(asked).toEqual(["- **Shop**"]);
  });

  it("tells the resolver WHICH tree it is judging, so carried evidence can be held against it", async () => {
    // The closure audit and the carriage rule must mean the same tree: the
    // revision a closure would be stamped with is the revision carried evidence
    // is honoured at (round 13 #31).
    const [encoded] = identifyRequirements({ texts: ["Shop: absent"], gdd: GDD_1 }).encoded;
    const seen: Array<{ revision?: string } | undefined> = [];
    const resolveCoverageGaps = vi.fn(
      async (_gdd: string, reqs: readonly string[], _ms: unknown, options?: { revision?: string }) => {
        seen.push(options);
        return { closed: [], open: [...reqs], unasked: [] };
      },
    );
    const campaign = {
      id: "c-28c",
      gddText: "# GDD",
      milestones: [
        {
          id: "mcov1",
          title: "Coverage completion 1.1 — Shop",
          prompt: "- Shop: absent\n",
          coverageGap: encoded,
          status: "failed",
          attempts: 2,
        },
      ],
    } as unknown as Campaign;

    await coveragePaths({ planner: { resolveCoverageGaps } }).openRequirements(campaign);

    expect(seen).toEqual([{ revision: REV_NOW }]);
  });

  it("an unchanged requirement closed on this tree is never re-asked (the opposite direction)", async () => {
    const [encoded] = identifyRequirements({ texts: ["Save progress across restarts: absent"], gdd: GDD_1 }).encoded;
    const resolveCoverageGaps = vi.fn(async (_gdd: string, reqs: readonly string[]) => ({
      closed: [],
      open: [...reqs],
      unasked: [],
    }));
    const campaign = {
      id: "c-28b",
      gddText: "# GDD",
      milestones: [
        {
          id: "mcov1",
          title: "Coverage completion 1.1 — Save",
          prompt: "- Save progress across restarts\n",
          coverageGap: encoded,
          status: "failed",
          attempts: 2,
          coverageClosed: true,
          coverageClosedRevision: REV_NOW,
        },
      ],
    } as unknown as Campaign;

    const result = await coveragePaths({ planner: { resolveCoverageGaps } }).openRequirements(campaign);

    expect(resolveCoverageGaps).not.toHaveBeenCalled();
    expect(result.open).toEqual([]);
    expect(campaign.milestones[0]!.coverageClosed).toBe(true);
  });
});

// ─── #29 — a requirement in flight keeps the identity it has ────────────────

describe("#29 a mid-flight upgrade does not double-schedule a legacy gap", () => {
  const LEGACY = "Save system: no milestone implemented it";

  function campaignWithLegacyGap(extra: Partial<Campaign> = {}): Campaign {
    return {
      id: "c-29",
      gddText: "# GDD\n\nThe game saves progress.",
      gddSha256: "e".repeat(64),
      gddRevision: 1,
      milestones: [
        { id: "m1", title: "Sprint A", prompt: "build it", status: "green", attempts: 1 },
        {
          id: "mcov1",
          title: `Coverage completion 1.1 — ${LEGACY.slice(0, 60)}`,
          prompt: `- ${LEGACY}\n`,
          coverageGap: LEGACY,
          status: "running",
          attempts: 1,
        },
      ],
      ...extra,
    } as unknown as Campaign;
  }

  it("the audit's re-listing of a running legacy gap is not a second sprint", async () => {
    const { planner } = plannerWith([JSON.stringify({ missing: [LEGACY] })]);
    const campaign = campaignWithLegacyGap();

    const sprints = await coveragePaths({ planner }).buildCoverageRemediation(campaign);

    expect(sprints ?? []).toHaveLength(0);
    expect(campaign.coverageAuditNote ?? "").toContain("already have sprints");
    // The running row is left exactly as it is: rewriting a requirement other
    // code recomputes from text moves its key out from under that code.
    expect(campaign.milestones[1]!.coverageGap).toBe(LEGACY);
  });

  it("the QUEUE is held to the same rule as the milestones, in the same pass", async () => {
    // A requirement waiting in the queue with no identity is the other half of
    // the same defect: an audit's fresh `req:…` for it is a second requirement
    // with a fresh repair budget. The audit's output is held to the campaign's
    // own string wherever the campaign holds it.
    const queued = "Shop: absent";
    const campaign = campaignWithLegacyGap({ pendingCoverageGaps: [queued] });
    const [stamped] = identifyRequirements({ texts: [queued], gdd: GDD_1 }).encoded;
    expect(stamped).toContain("rid:");

    const restored = restoreLegacyWordings(campaign, [stamped!]);

    expect(restored).toEqual([queued]);
    expect(requirementKey(restored[0]!)).toBe(requirementKey(queued));
    // …and a requirement the campaign does NOT already hold keeps its identity.
    expect(restoreLegacyWordings(campaign, identifyRequirements({ texts: ["Boss: absent"], gdd: GDD_1 }).encoded)[0])
      .toContain("rid:");
  });
});

// #30 is measured where the requirement reaches a person: the delivery
// package's gap rows (delivery-package.test.ts) and the delivery-proof text a
// still-queued requirement produces (campaign-manager.test.ts).

// ─── #31 — carried evidence is bound to the tree it was measured on ─────────

describe("#31 inherited evidence cannot outlive its tree", () => {
  /** Proven at REV_PROVEN, then cosmetically reworded. */
  function carriedSaveRequirement(): string[] {
    const before = reconcileRequirements({ texts: ["Save progress across restarts: absent"], gdd: GDD_1 }).identities;
    const { encoded, result } = identifyRequirements({
      previous: before,
      texts: ["Saving progress across restarts"],
      gdd: GDD_2,
      proven: new Set([before[0]!.id]),
      provenAtRevision: REV_PROVEN,
    });
    expect(result.identities[0]!.evidenceCarried).toBe(true);
    return encoded;
  }

  it("a historical commit note does not close it on a tree it was not measured on", async () => {
    // Saving was proven at REV_PROVEN and then REMOVED; the commit note that
    // proved it is still in the ladder's record for ever, and the model —
    // looking at the tree — says delivered:false.
    const encoded = carriedSaveRequirement();
    const { planner } = plannerWith([JSON.stringify({ verdicts: [{ id: 1, delivered: false }] })]);

    const answer = await planner.resolveCoverageGaps("# GDD", encoded, [SAVE_MILESTONE], { revision: REV_NOW });

    expect(answer.closed).toEqual([]);
    expect(answer.open).toEqual(encoded);
  });

  it("carriage with no tree bound to it closes nothing", async () => {
    // A `carry:1` tail persisted before the carriage was bound to a revision
    // says nothing about any tree, so it cannot renew a closure.
    const legacyCarry = encodeRequirement({
      id: "req-001-0123456789ab",
      lineage: "req-001-0123456789ab",
      text: "Saving progress across restarts",
      evidenceCarried: true,
    });
    const { planner } = plannerWith([JSON.stringify({ verdicts: [{ id: 1, delivered: false }] })]);

    const answer = await planner.resolveCoverageGaps("# GDD", [legacyCarry], [SAVE_MILESTONE], { revision: REV_NOW });

    expect(answer.closed).toEqual([]);
  });

  // THE OPPOSITE DIRECTION: on the tree the proof was read on, a cosmetic
  // rewording must not have to prove again what is still true.
  it("closes on the SAME tree, so a cosmetic rewording never re-proves what stands", async () => {
    const encoded = carriedSaveRequirement();
    const { planner } = plannerWith([JSON.stringify({ verdicts: [{ id: 1, delivered: false }] })]);

    const answer = await planner.resolveCoverageGaps("# GDD", encoded, [SAVE_MILESTONE], { revision: REV_PROVEN });

    expect(answer.closed).toEqual(encoded);
  });

  it("…and never when the measured line that proved it has left the record", async () => {
    const encoded = carriedSaveRequirement();
    const { planner } = plannerWith([JSON.stringify({ verdicts: [{ id: 1, delivered: false }] })]);

    const answer = await planner.resolveCoverageGaps(
      "# GDD",
      encoded,
      [{ title: "Sprint A", status: "green", commitNote: "1 commit(s): Assets/Art/Hero.png" }],
      { revision: REV_PROVEN },
    );

    expect(answer.closed).toEqual([]);
  });

  it("the audit only carries evidence from a closure that holds on the tree it audits", async () => {
    // The `proven` set behind `carry:1` is the campaign's own closures, and a
    // closure recorded at another revision is not one: the implementation
    // could have been removed since (Codex 2026-09-12 V#4).
    const [proven] = identifyRequirements({ texts: ["Save progress across restarts: absent"], gdd: GDD_1 }).encoded;
    const { planner } = plannerWith([JSON.stringify({ missing: ["Saving progress across restarts"] })]);

    const stale = await planner.auditCoverage(
      "# GDD",
      [{ title: "Sprint A", coverageGap: proven, coverageClosed: true, coverageClosedRevision: REV_PROVEN }],
      { identity: true, gddSha256: GDD_2.sha256, gddRevision: GDD_2.revision, treeRevision: REV_NOW },
    );
    expect(stale[0]).not.toContain("carry:1");

    const { planner: planner2 } = plannerWith([JSON.stringify({ missing: ["Saving progress across restarts"] })]);
    const current = await planner2.auditCoverage(
      "# GDD",
      [{ title: "Sprint A", coverageGap: proven, coverageClosed: true, coverageClosedRevision: REV_NOW }],
      { identity: true, gddSha256: GDD_2.sha256, gddRevision: GDD_2.revision, treeRevision: REV_NOW },
    );
    expect(current[0]).toContain("carry:1");
    expect(current[0]).toContain(`tree:${REV_NOW}`);
  });
});

// ─── round 14 #10 — every character that changes the ASK ────────────────────

/**
 * The same class as `Score < 10` / `Score > 10` (round 13 #27), swept in one
 * pass: a character the tokenizer discards before the fingerprint, where the
 * two readings are different asks. A sign is the one the finding names; the
 * rest of the family is here so a third patch is not needed later.
 */
describe("#10 signs, quantities and units are part of the content", () => {
  const notCosmetic: Array<[string, string]> = [
    // THE FINDING: a unary sign. Gravity down is not gravity up.
    ["Set gravity = -10", "Set gravity = 10"],
    ["Set gravity = -10", "Set gravity = +10"],
    ["The score may go to -5", "The score may go to 5"],
    // A percentage is not a count.
    ["Drop rate: 5%", "Drop rate: 5"],
    ["Crit chance 25%", "Crit chance 20%"],
    // A multiplier is not a count.
    ["2× damage on a critical hit", "2 damage on a critical hit"],
    // An approximation is not a target.
    ["~60 fps in the built player", "60 fps in the built player"],
    // A unit symbol, and a price that is not a quantity.
    ["Rotate the turret 90° per second", "Rotate the turret 90 per second"],
    ["The starter pack costs $5", "The starter pack costs 5"],
    // …and a sign the requirement OPENS with, which the list-decoration
    // stripper used to eat before the tokenizer ever saw it.
    ["-10 gravity is the floor", "10 gravity is the floor"],
  ];
  it.each(notCosmetic)("NOT cosmetic: %s ↔ %s", (a, b) => {
    expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
    expect(isCosmeticRewording(a, b)).toBe(false);
  });

  // THE OPPOSITE DIRECTION: none of this may turn ordinary decoration, a
  // hyphen or a redundant plus into a rewording.
  const stillCosmetic: Array<[string, string]> = [
    ["Set gravity = -10", "- **set gravity = -10.**"],
    // A hyphen JOINING words or a word to a number is not a sign.
    ["Auto-save every level", "Auto save every level"],
    ["The level-10 boss must be defeatable", "The level 10 boss must be defeatable"],
    // A leading plus on a number is not a value: +10 is ten.
    ["Set gravity = +10", "Set gravity = 10"],
    // …and a struck-through heading is decoration, not an approximation.
    ["~~Shop~~", "Shop"],
    // A list marker is still a list marker: dash, SPACE, then the number.
    ["- 10 levels", "10 levels"],
    ["1. 10 levels", "10 levels"],
  ];
  it.each(stillCosmetic)("still cosmetic: %s ↔ %s", (a, b) => {
    expect(isCosmeticRewording(a, b)).toBe(true);
  });

  it("a proven requirement whose sign flipped is REOPENED, never carried", () => {
    const before = reconcileRequirements({ texts: ["Set gravity = -10"], gdd: GDD_1 }).identities;
    const after = identifyRequirements({
      previous: before,
      texts: ["Set gravity = 10"],
      gdd: GDD_2,
      proven: new Set([before[0]!.id]),
      provenAtRevision: REV_PROVEN,
    });
    expect(after.result.identities[0]!.evidenceCarried).not.toBe(true);
    expect(after.result.identities[0]!.reopened).toBe(true);
    // …and the two wordings are not one requirement for scheduling either.
    expect(requirementKey(after.encoded[0]!)).not.toBe(requirementKey(encodeRequirement(before[0]!)));
  });

  it("…while a cosmetic rewording of the SAME signed ask still inherits its closure", async () => {
    // A wording that normalizes to the same string keeps its id outright (the
    // revision did not reword it at all); this one is a real rewording whose
    // CONTENT is unchanged — the copula and a modal — so the proof carries.
    const before = reconcileRequirements({ texts: ["Gravity is set to -10"], gdd: GDD_1 }).identities;
    const { encoded, result } = identifyRequirements({
      previous: before,
      texts: ["Gravity must be set to -10"],
      gdd: GDD_2,
      proven: new Set([before[0]!.id]),
      provenAtRevision: REV_PROVEN,
    });
    expect(result.identities[0]!.evidenceCarried).toBe(true);
    const { planner } = plannerWith([JSON.stringify({ verdicts: [{ id: 1, delivered: false }] })]);
    const answer = await planner.resolveCoverageGaps(
      "# GDD",
      encoded,
      [{ title: "Sprint A", status: "green", commitNote: "1 commit(s): Assets/Scripts/GravitySetter.cs" }],
      { revision: REV_PROVEN },
    );
    expect(answer.closed).toEqual(encoded);
  });
});

// ─── round 14 #9 — the requirement that lives only in a prompt ──────────────

describe("#9 a prompt-only legacy requirement is not re-minted", () => {
  const PROMPT_ONLY = "Audio: no milestone implemented it";

  it("the audit's re-listing of it is not a second sprint", async () => {
    // A row persisted before `coverageGap` existed keeps its requirement in its
    // PROMPT. restoreLegacyWordings read the field and not the prompt, so the
    // audit minted a fresh `req:…` whose key is not this row's text key — a
    // second sprint for work already running, with a fresh repair budget.
    const { planner } = plannerWith([JSON.stringify({ missing: [PROMPT_ONLY] })]);
    const campaign = {
      id: "c-r14-9",
      gddText: "# GDD\n\nThe game has music.",
      gddSha256: "f".repeat(64),
      gddRevision: 1,
      milestones: [
        { id: "m1", title: "Sprint A", prompt: "build it", status: "green", attempts: 1 },
        {
          id: "mcov1",
          title: "Coverage completion 1.1 — Audio",
          prompt: `The build's milestone ladder finished, but auditing it found this undelivered:\n- ${PROMPT_ONLY}\n\nImplement it.`,
          status: "running",
          attempts: 1,
        },
      ],
    } as unknown as Campaign;

    const sprints = await coveragePaths({ planner }).buildCoverageRemediation(campaign);

    expect(sprints ?? []).toHaveLength(0);
    expect(campaign.coverageAuditNote ?? "").toContain("already have sprints");
  });

  it("a row whose requirement is only its TRUNCATED TITLE is never spoken for", () => {
    // `coverageRequirementOf` marks that case unidentified, and it must stay
    // that way here: "Boss Alpha" and "Boss Beta" both truncate to the same
    // title, so letting a title answer for a requirement merges two of them
    // (Codex 2026-09-12 X#2).
    const campaign = {
      milestones: [
        { id: "mcov1", title: "Coverage completion 1.1 — Boss Alpha: absent", prompt: "no item line here", status: "running", attempts: 1 },
      ],
    } as unknown as Campaign;
    const [stamped] = identifyRequirements({ texts: ["Boss Alpha: absent"], gdd: GDD_1 }).encoded;

    expect(restoreLegacyWordings(campaign, [stamped!])).toEqual([stamped]);
  });
});
