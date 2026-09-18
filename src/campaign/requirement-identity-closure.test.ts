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
import { CampaignPlanner, closingFact, quotableFactsOf } from "./campaign-planner.js";
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

// ─── THE FINGERPRINT TABLE — one place for the whole family ─────────────────

/**
 * WHAT THE CONTENT FINGERPRINT MUST SEE, as a table.
 *
 * Three rounds in a row found one member of one family: a character that
 * changes the ASK and that the tokenizer threw away before fingerprinting, so a
 * proven requirement carried its closure onto a different requirement — an
 * operator (round 13 #27), a sign (round 14 #10), an approximation and a digit
 * glued to a word (round 15 #17). The cases are listed here rather than
 * discovered one round at a time: the next member of the family is ONE LINE in
 * MUST_DIFFER, next to the class it belongs to.
 *
 * Each row is [class, one wording, another wording]. MUST_DIFFER rows are two
 * different asks and may never share a content fingerprint; MUST_MATCH rows are
 * one ask written twice and must share one, because a rewording that changed
 * nothing has to keep what was already proven about it (that direction costs a
 * repair round every time it is got wrong).
 */
const MUST_DIFFER: Array<[string, string, string]> = [
  // Comparison and equality — the ask is the threshold.
  ["operator", "Score < 10", "Score > 10"],
  ["operator", "Score >= 10", "Score > 10"],
  // A unary sign. Gravity down is not gravity up.
  ["sign", "Set gravity = -10", "Set gravity = 10"],
  ["sign", "Set gravity = -10", "Set gravity = +10"],
  ["sign", "The score may go to -5", "The score may go to 5"],
  ["sign at the start", "-10 gravity is the floor", "10 gravity is the floor"],
  // An approximation is not a target, in either of its two characters.
  ["approximation ~", "~60 fps in the built player", "60 fps in the built player"],
  ["approximation ≈", "≈60 fps in the built player", "60 fps in the built player"],
  // A DIGIT GLUED TO A WORD is a version, a tier or an index (round 15 #17).
  ["digit after letters", "Support WebGL1", "Support WebGL2"],
  ["digit after letters", "The L3 Bomb must spawn", "The L5 Bomb must spawn"],
  ["digit after letters", "Use HDRP2 for the render pipeline", "Use HDRP for the render pipeline"],
  // Quantity markers: a percentage is not a count, a price is not a quantity.
  ["percentage", "Drop rate: 5%", "Drop rate: 5"],
  ["percentage", "Crit chance 25%", "Crit chance 20%"],
  ["multiplier", "2× damage on a critical hit", "2 damage on a critical hit"],
  ["degree", "Rotate the turret 90° per second", "Rotate the turret 90 per second"],
  ["currency", "The starter pack costs $5", "The starter pack costs 5"],
  ["postfix +", "60+ fps", "60 fps"],
  // Units, which separate themselves now that there is no length floor.
  ["unit", "The boot takes 10s", "The boot takes 10ms"],
  // A range differs by its own numbers.
  ["range", "Spawn 10-20 enemies", "Spawn 10-30 enemies"],
  // The classes that were already right, kept here so the table is the whole rule.
  ["figure", "12 levels", "13 levels"],
  ["short subject", "Enable AI", "Enable UI"],
  ["preposition", "Save progress to disk", "Save progress disk"],
  ["negation", "The boss is defeated", "The boss is not defeated"],
  ["added clause", "Save progress across restarts", "Save progress across restarts and to the cloud"],
  ["fresh diagnosis", "Shop: absent", "Shop: the UI shell exists but nothing sells"],
];

const MUST_MATCH: Array<[string, string, string]> = [
  ["markdown decoration", "Save progress across restarts: absent", "- **Saving progress across restarts.**"],
  ["verdict suffix", "Shop: absent", "shop"],
  ["copula and modal", "The shop must be implemented", "The shop is implemented"],
  ["run tail", "Boss fight: absent, attempt 2", "Boss fight: absent"],
  ["case and spacing", "Score < 10", "score  <  10."],
  ["decoration on a short subject", "- **Enable AI**", "Enable AI: absent"],
  ["run tail on a figure", "The game runs at 60 fps", "the game runs at 60 fps, attempt 3"],
  // A leading plus is not a value: +10 IS ten.
  ["redundant plus", "Set gravity = +10", "Set gravity = 10"],
  // A dash that JOINS is not a sign, or "level 10 boss" would be a new ask.
  ["joining hyphen", "Auto-save every level", "Auto save every level"],
  ["joining hyphen", "The level-10 boss must be defeatable", "The level 10 boss must be defeatable"],
  // A strikethrough is decoration; only a tilde on DIGITS is an approximation.
  ["strikethrough", "~~Shop~~", "Shop"],
  // A list marker is a dash, a SPACE, then the item — including a numbered one.
  ["list marker", "- 10 levels", "10 levels"],
  ["numbered list marker", "1. 10 levels", "10 levels"],
  ["camelCase", "SaveSystem must persist", "Save System must persist"],
  ["thousands separator", "3,000 coins", "3.000 coins"],
  ["inflection", "The game restarts", "The game restart"],
];

describe("the content fingerprint — one table for the whole family", () => {
  it.each(MUST_DIFFER)("%s: DIFFERENT asks — %s ↔ %s", (_class, a, b) => {
    expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
    expect(isCosmeticRewording(a, b)).toBe(false);
  });

  it.each(MUST_MATCH)("%s: ONE ask — %s ↔ %s", (_class, a, b) => {
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
    expect(isCosmeticRewording(a, b)).toBe(true);
  });

  it("every row is a pair of distinct wordings (the table cannot pass by accident)", () => {
    for (const [, a, b] of [...MUST_DIFFER, ...MUST_MATCH]) expect(a).not.toBe(b);
    expect(MUST_DIFFER.length).toBeGreaterThan(20);
    expect(MUST_MATCH.length).toBeGreaterThan(12);
  });
});

// ─── what the fingerprint decides about a CLOSURE ───────────────────────────

describe("#27/#10/#17 a changed ask never inherits the proof of another", () => {
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

  it("…and a version digit does the same: WebGL1's proof is not WebGL2's", () => {
    const before = reconcileRequirements({ texts: ["Support WebGL1"], gdd: GDD_1 }).identities;
    const after = identifyRequirements({
      previous: before,
      texts: ["Support WebGL2"],
      gdd: GDD_2,
      proven: new Set([before[0]!.id]),
      provenAtRevision: REV_PROVEN,
    });
    expect(after.result.identities[0]!.evidenceCarried).not.toBe(true);
    expect(after.result.identities[0]!.reopened).toBe(true);
    expect(requirementKey(after.encoded[0]!)).not.toBe(requirementKey(encodeRequirement(before[0]!)));
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

// ─── round 14 #10 — a sign decides a closure ────────────────────────────────

describe("#10 signs and quantities decide what carries", () => {
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

// ─── round 15 #17, the other door ───────────────────────────────────────────

/**
 * The FINGERPRINT half of #17 stops `WebGL1`'s identity from becoming
 * `WebGL2`'s. The evidence matcher is a second door to the same outcome: it
 * splits camelCase (so `SaveSystem` meets `Save System`), which hands it the
 * bare fragment `web` out of `WebGL2` — and a commit naming WebGL1 then shares
 * a stem with a requirement about WebGL2 and closes it. Same consequence, same
 * family: a proven ask closing a different ask.
 */
describe("#17 a versioned name is not its fragment (the evidence half)", () => {
  const facts = (commitNote: string): string[] => quotableFactsOf([{ status: "green", commitNote }]);

  it("a WebGL1 commit does not close a WebGL2 requirement", () => {
    expect(closingFact("Support WebGL2", facts("2 commit(s): Assets/Scripts/WebGL1Bootstrap.cs"))).toBeUndefined();
  });

  it("…and the WebGL2 commit still does (the opposite direction)", () => {
    expect(closingFact("Support WebGL2", facts("2 commit(s): Assets/Scripts/WebGL2Bootstrap.cs"))).toBe(
      "landed: 2 commit(s): Assets/Scripts/WebGL2Bootstrap.cs",
    );
  });

  it("a requirement that names no version is judged exactly as before", () => {
    // The rule may only bite where the requirement itself carries the version:
    // an unversioned ask keeps every stem it had.
    expect(closingFact("Save progress across restarts", facts("2 commit(s): Assets/Scripts/SaveSystem.cs"))).toBe(
      "landed: 2 commit(s): Assets/Scripts/SaveSystem.cs",
    );
    expect(closingFact("Shop: absent", facts("1 commit(s): Assets/Art/Hero.png"))).toBeUndefined();
  });
});
