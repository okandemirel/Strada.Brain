/**
 * The independent review as a gate (GDD-drift plan W13).
 *
 * The delivery review was advisory prose: its BLOCKERS never reached the
 * requirement ledger, so a reviewer who read a system check that asserts a
 * literal, or found a GDD rule no row states, changed nothing — the weak check
 * kept closing its row and the missing rule never held delivery. Here, with a
 * ledger that decides, the reviewer is handed the rows and their stored checks
 * and answers with a JSON tail; a weak check on a known row reopens it for one
 * regeneration, a verbatim GDD quote becomes a queued row, and everything else
 * is disclosed. It never closes a row, and a reviewer that cannot run blocks
 * nothing. With the gate off the review stays today's advice.
 *
 * The GDD wording here is invented.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignManager, openLedgerRows } from "./campaign-manager.js";
import { CampaignStorage } from "./campaign-storage.js";
import { encodeRequirement } from "./requirement-identity.js";
import { closesByLedger } from "./scope-verdict.js";
import type { AcceptanceSource, RequirementLedger, RequirementRow, RowResult, ScopeGateMode } from "./scope-types.js";
import type { Campaign, CampaignMilestone } from "./types.js";

const REV_NOW = "c".repeat(40);

const GDD_TEXT = [
  "# Reef Courier",
  "## 2 Rules",
  "RC-01 The courier loses one oxygen bubble every 3 seconds underwater.",
  "RC-02 A parcel counts as delivered only when the courier docks at its matching buoy.",
  "## 4 Harbour",
  "The harbour gate stays shut until every parcel of the shift has been delivered.",
].join("\n");
const GDD_SHA = createHash("sha256").update(GDD_TEXT).digest("hex");

const RID_1 = "req-1-aaaaaaaa";
const RID_2 = "req-2-bbbbbbbb";
const TEST_2 = "Strada.Acceptance.M1.Acceptance_M1.R2_bbbbbb";
const FILE = "Assets/StradaAcceptance/Acceptance_M1.cs";
const WEAK_BODY_MARKER = "global::NUnit.Framework.Assert.That(true, global::NUnit.Framework.Is.True);";
const MISSING_QUOTE = "The harbour gate stays shut until every parcel of the shift has been delivered.";

const pass = (revision: string): RowResult => ({ revision, atMs: 5, outcome: "pass", detail: "passed in run r1" });

function row(rid: string, label: string, text: string, fields: Partial<RequirementRow> = {}): RequirementRow {
  const start = GDD_TEXT.indexOf(text);
  return {
    rid,
    encoded: encodeRequirement({ id: rid, text, lineage: rid, gddSha256: GDD_SHA, gddRevision: 1 }),
    label,
    text,
    section: "2 Rules",
    sectionPath: ["2 Rules"],
    sectionNumber: "2",
    line: GDD_TEXT.slice(0, start).split("\n").length,
    span: { start, end: start + text.length },
    kind: "rule",
    source: "extracted",
    owner: "m1",
    ownership: [{ milestoneId: "m1", reason: "covered-section", atMs: 1 }],
    status: "passing",
    checks: [{ kind: "test", testName: `Strada.Acceptance.M1.Acceptance_M1.R1_${rid.slice(-6)}`, path: FILE, bodySha: "f".repeat(64) }],
    last: pass(REV_NOW),
    gddSha256: GDD_SHA,
    gddRevision: 1,
    ...fields,
  };
}

function ledger(): RequirementLedger {
  return {
    version: 1,
    gddSha256: GDD_SHA,
    gddRevision: 1,
    extractedAtMs: 1,
    rows: [
      row(RID_1, "RC-01", "RC-01 The courier loses one oxygen bubble every 3 seconds underwater."),
      row(RID_2, "RC-02", "RC-02 A parcel counts as delivered only when the courier docks at its matching buoy.", {
        checks: [{ kind: "test", testName: TEST_2, path: FILE, bodySha: "e".repeat(64) }],
      }),
    ],
    overflow: { count: 0, sections: [] },
    numberingGaps: [],
    llmAdded: 0,
  };
}

const SOURCE: AcceptanceSource = {
  milestoneId: "m1",
  path: FILE,
  sha256: "d".repeat(64),
  source: [
    "namespace Strada.Acceptance.M1",
    "{",
    "    // REQ req-2-bbbbbbbb — RC-02 A parcel counts as delivered only when the courier docks at its matching buoy.",
    "    public System.Collections.IEnumerator R2_bbbbbb()",
    "    {",
    "        yield return Boot();",
    `        ${WEAK_BODY_MARKER}`,
    "    }",
    "}",
  ].join("\n"),
  writer: { provider: "fake", model: "writer-model", independence: "different-model" },
  revisions: 1,
  tests: [{ rid: RID_2, testName: TEST_2, bodySha: "e".repeat(64) }],
};

function campaignWith(fields: Partial<Campaign> = {}): Campaign {
  return {
    id: "c-w13",
    chatId: "chat",
    gddText: GDD_TEXT,
    gddSha256: GDD_SHA,
    gddRevision: 1,
    state: "executing",
    milestones: [{ id: "m1", title: "Sprint 1 — Parcels", prompt: "build the parcels", status: "green", attempts: 1 } as CampaignMilestone],
    currentMilestone: 0,
    requirements: ledger(),
    ...fields,
  } as unknown as Campaign;
}

type Reviewer = (p: { projectRoot: string; prompt: string }) => Promise<{ ok: boolean; model: string; text: string; ms: number; error?: string }>;

interface GateOutcome {
  readonly reopened: readonly string[];
  readonly added: readonly string[];
  readonly disclosed: readonly string[];
  readonly changed: number;
}

interface ReviewPaths {
  gatherIndependentReview: (c: Campaign) => Promise<GateOutcome>;
  openRequirements: (c: Campaign) => Promise<{ open: string[]; auditFailed?: string }>;
}

/** The manager's review and closure paths, with the tree, storage and reviewer stubbed as own properties. */
function reviewPaths(mode: ScopeGateMode, reviewer: Reviewer | null, saved: Campaign[] = []): ReviewPaths {
  const manager = Object.create(CampaignManager.prototype) as Record<string, unknown>;
  Object.assign(manager, {
    persist: (c: Campaign) => {
      saved.push(structuredClone(c));
      return true;
    },
    projectRoot: "/nonexistent-project-root",
    projectRevision: () => REV_NOW,
    projectRepoState: () => "revision",
    projectIsDirty: () => false,
    projectFingerprint: () => "",
    scopeGateMode: mode,
    independentReviewer: reviewer,
    storage: { listAcceptance: () => [SOURCE], get: () => undefined },
  });
  return manager as unknown as ReviewPaths;
}

/**
 * The same paths over a store, saved by the manager's own persist(): a waiver,
 * an amendment or a revive lands on a copy loaded from the store while the
 * reviewer runs, the way `/campaign waive`, `amendGdd` and a revive do.
 */
function reviewPathsOverStore(reviewer: (store: Map<string, Campaign>) => ReturnType<Reviewer>, store: Map<string, Campaign>): ReviewPaths {
  const manager = reviewPaths("on", async () => reviewer(store)) as unknown as Record<string, unknown>;
  delete manager["persist"];
  manager["storage"] = {
    listAcceptance: () => [SOURCE],
    get: (id: string) => structuredClone(store.get(id)),
    save: (c: Campaign) => {
      store.set(c.id, structuredClone(c));
    },
  };
  return manager as unknown as ReviewPaths;
}

/** Another copy of the stored campaign, changed and saved, as a command handler would. */
function landMeanwhile(store: Map<string, Campaign>, id: string, change: (c: Campaign) => void): void {
  const other = structuredClone(store.get(id)!);
  change(other);
  store.set(id, other);
}

const FINDINGS_TAIL = JSON.stringify({
  weakChecks: [{ rid: RID_2, why: "it asserts a literal, so it passes whether or not a parcel was ever docked" }],
  missing: [{ gddQuote: MISSING_QUOTE, why: "the harbour gate opens at the start of the shift" }],
});

const REVIEW_TEXT = [
  "VERDICT: NOT DELIVERABLE",
  "BLOCKERS: 1. the harbour gate is never closed (Assets/Scripts/Harbour.cs)",
  "DISAGREEMENTS: none",
  "NEXT: close the gate; make RC-02's check dock a parcel; rerun",
  FINDINGS_TAIL,
].join("\n");

describe("the independent review as a gate (W13)", () => {
  it("a weak check reopens its row and a verbatim quote adds a queued row, and both hold delivery as open GDD rows", async () => {
    const prompts: string[] = [];
    const saved: Campaign[] = [];
    const paths = reviewPaths("on", async ({ prompt }) => {
      prompts.push(prompt);
      return { ok: true, model: "fake-astra", text: REVIEW_TEXT, ms: 1 };
    }, saved);
    const campaign = campaignWith();
    // Before the review both rows close: their checks passed on this revision.
    expect(openLedgerRows(campaign.requirements!, REV_NOW)).toHaveLength(0);

    const outcome = await paths.gatherIndependentReview(campaign);

    // The reviewer argued against the rows and the checks the system wrote, not against prose.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("RC-02 A parcel counts as delivered only when the courier docks at its matching buoy.");
    expect(prompts[0]).toContain(WEAK_BODY_MARKER);
    expect(prompts[0]).toContain(RID_2);
    expect(prompts[0]).toContain('"weakChecks"');

    expect(outcome.reopened).toEqual([RID_2]);
    expect(outcome.added).toHaveLength(1);
    expect(outcome.changed).toBe(2);

    const rows = campaign.requirements!.rows;
    const reopened = rows.find((r) => r.rid === RID_2)!;
    expect(reopened.status).toBe("open");
    // A re-measure is required: the weak check's pass no longer speaks for the row.
    expect(reopened.last).toBeUndefined();
    const weak = reopened.checks.find((c) => c.kind === "test" && c.testName === TEST_2);
    expect(weak).toMatchObject({ weak: expect.stringContaining("asserts a literal") });
    expect(weak && "supersededAtMs" in weak ? weak.supersededAtMs : undefined).toEqual(expect.any(Number));
    expect(closesByLedger(reopened, REV_NOW)).toBe(false);

    const added = rows.find((r) => r.rid === outcome.added[0])!;
    expect(added).toMatchObject({ source: "review-added", status: "open", text: MISSING_QUOTE, checks: [] });
    expect(added.owner).toBeUndefined();

    // The row the review did not name is untouched.
    expect(rows.find((r) => r.rid === RID_1)).toEqual(ledger().rows[0]);

    // At the delivery gate both are open GDD rows: missing proofs.
    const open = await paths.openRequirements(campaign);
    expect(open.open).toEqual(expect.arrayContaining([reopened.encoded, added.encoded]));
    expect(open.open).not.toContain(rows.find((r) => r.rid === RID_1)!.encoded);

    // Persisted, with what the gate did recorded beside the verbatim opinion.
    expect(saved.at(-1)!.requirements!.rows.map((r) => r.rid)).toContain(outcome.added[0]);
    expect(campaign.independentReview).toMatchObject({
      ok: true,
      text: REVIEW_TEXT,
      gate: {
        mode: "on",
        reopened: [expect.stringMatching(/^RC-02 \(§2\) — it asserts a literal/)],
        added: [expect.stringContaining(MISSING_QUOTE)],
      },
    });
  });

  it("a paraphrase, an unknown row id and a verdict are disclosed only: nothing is reopened, added or closed", async () => {
    const paths = reviewPaths("on", async () => ({
      ok: true,
      model: "fake-astra",
      text: [
        "VERDICT: DELIVERABLE",
        "BLOCKERS: none",
        JSON.stringify({
          weakChecks: [{ rid: "req-9-zzzzzzzz", why: "no such row" }],
          missing: [{ gddQuote: "the gate at the harbour must be locked during a shift", why: "paraphrased" }],
          closed: [RID_1],
        }),
      ].join("\n"),
      ms: 1,
    }));
    const failing = ledger();
    failing.rows[0] = { ...failing.rows[0]!, status: "failing", last: { revision: REV_NOW, atMs: 5, outcome: "fail", detail: "Expected 3 But was 5" } };
    const campaign = campaignWith({ requirements: structuredClone(failing) });

    const outcome = await paths.gatherIndependentReview(campaign);

    expect(outcome.changed).toBe(0);
    expect(outcome.reopened).toEqual([]);
    expect(outcome.added).toEqual([]);
    expect(outcome.disclosed.join("\n")).toContain("req-9-zzzzzzzz");
    expect(outcome.disclosed.join("\n")).toContain("not verbatim in the approved GDD");
    // A DELIVERABLE verdict and a "closed" list close nothing: the failing row stays failing and open.
    expect(campaign.requirements).toEqual(failing);
    expect((await paths.openRequirements(campaign)).open).toEqual([failing.rows[0]!.encoded]);
  });

  it("a reviewer that throws or times out blocks nothing and is disclosed", async () => {
    for (const reviewer of [
      async () => {
        throw new Error("spawn codex ENOENT");
      },
      async () => ({ ok: false, model: "fake-astra", text: "", ms: 900_000, error: "codex timed out after 900s" }),
    ] as Reviewer[]) {
      const paths = reviewPaths("on", reviewer);
      const campaign = campaignWith();
      const outcome = await paths.gatherIndependentReview(campaign);
      expect(outcome.changed).toBe(0);
      expect(outcome.disclosed.join("\n")).toMatch(/did not run/);
      expect(campaign.requirements).toEqual(ledger());
      expect(campaign.independentReview?.ok).toBe(false);
      expect((await paths.openRequirements(campaign)).open).toEqual([]);
    }
  });

  it("with no reviewer configured it blocks nothing", async () => {
    const campaign = campaignWith();
    const outcome = await reviewPaths("on", null).gatherIndependentReview(campaign);
    expect(outcome.changed).toBe(0);
    expect(campaign.independentReview).toMatchObject({ ok: false, error: "disabled by configuration" });
    expect(campaign.requirements).toEqual(ledger());
  });

  it("shadow records what the findings would do in the ledger; the delivery decision stays the resolver's", async () => {
    const paths = reviewPaths("shadow", async () => ({ ok: true, model: "fake-astra", text: REVIEW_TEXT, ms: 1 }));
    const campaign = campaignWith();
    const outcome = await paths.gatherIndependentReview(campaign);
    expect(outcome.reopened).toEqual([RID_2]);
    expect(outcome.added).toHaveLength(1);
    expect(campaign.requirements!.rows.find((r) => r.rid === RID_2)!.status).toBe("open");
    // The report says it decided nothing.
    expect(campaign.independentReview?.gate?.mode).toBe("shadow");
    // The closure the delivery decision reads in shadow is not the ledger's.
    const asked: string[][] = [];
    Object.assign(paths, {
      openRequirementsByResolver: async (_c: Campaign, sprints: CampaignMilestone[]) => {
        asked.push(sprints.map((m) => m.id));
        return { open: [] };
      },
    });
    expect((await paths.openRequirements(campaign)).open).toEqual([]);
    expect(asked).toEqual([[]]);
  });

  it("off mode is today's advice: no rows in the prompt, no findings read, the ledger untouched", async () => {
    const prompts: string[] = [];
    const paths = reviewPaths("off", async ({ prompt }) => {
      prompts.push(prompt);
      return { ok: true, model: "fake-astra", text: REVIEW_TEXT, ms: 1 };
    });
    const campaign = campaignWith();
    const outcome = await paths.gatherIndependentReview(campaign);
    expect(outcome.changed).toBe(0);
    expect(prompts[0]).not.toContain("weakChecks");
    expect(prompts[0]).not.toContain(WEAK_BODY_MARKER);
    expect(campaign.requirements).toEqual(ledger());
    expect(campaign.independentReview).toEqual({ ok: true, model: "fake-astra", text: REVIEW_TEXT, ms: 1 });
  });

  describe("a review that answers after the campaign moved on: the outcome is what the store holds", () => {
    const answer = async (): ReturnType<Reviewer> => ({ ok: true, model: "fake-astra", text: REVIEW_TEXT, ms: 1 });

    /** Every row the outcome names is in the store, in the state the outcome claims. */
    function expectOutcomeStored(outcome: GateOutcome, saved: Campaign): void {
      const rows = new Map(saved.requirements!.rows.map((r) => [r.rid, r]));
      for (const rid of outcome.reopened) {
        expect(rows.get(rid)?.checks.some((c) => c.kind === "test" && c.weak !== undefined)).toBe(true);
        expect(closesByLedger(rows.get(rid)!, REV_NOW)).toBe(false);
      }
      for (const rid of outcome.added) expect(rows.get(rid)).toMatchObject({ source: "review-added", status: "open" });
      expect(saved.independentReview?.gate?.reopened ?? []).toHaveLength(outcome.reopened.length);
      expect(saved.independentReview?.gate?.added ?? []).toHaveLength(outcome.added.length);
    }

    it("a waiver saved while the reviewer ran is honoured: the row stays waived, its test stays, and it is not called reopened", async () => {
      const campaign = campaignWith();
      const store = new Map([[campaign.id, structuredClone(campaign)]]);
      const paths = reviewPathsOverStore(async (s) => {
        landMeanwhile(s, campaign.id, (other) => {
          const waived = other.requirements!.rows.find((r) => r.rid === RID_2)!;
          waived.status = "waived";
          waived.waiver = { userId: "owner", atMs: 7, reason: "cut from this release" };
        });
        return answer();
      }, store);

      const outcome = await paths.gatherIndependentReview(campaign);

      const saved = store.get(campaign.id)!;
      const waived = saved.requirements!.rows.find((r) => r.rid === RID_2)!;
      expect(waived.status).toBe("waived");
      expect(waived.checks).toEqual(ledger().rows[1]!.checks);
      expect(outcome.reopened).toEqual([]);
      expect(outcome.disclosed.join("\n")).toContain("a person waived it");
      expectOutcomeStored(outcome, saved);
    });

    it("an amendment saved while the reviewer ran keeps its re-read rows, and the findings land on them", async () => {
      const amendedText = `${GDD_TEXT}\n## 6 Tides\nThe tide chart appears on the pause screen during every shift.`;
      const amendedSha = createHash("sha256").update(amendedText).digest("hex");
      const campaign = campaignWith();
      const store = new Map([[campaign.id, structuredClone(campaign)]]);
      const paths = reviewPathsOverStore(async (s) => {
        landMeanwhile(s, campaign.id, (other) => {
          other.gddText = amendedText;
          other.gddSha256 = amendedSha;
          other.gddRevision = 2;
          const reread = other.requirements!;
          other.requirements = { ...reread, gddSha256: amendedSha, gddRevision: 2, rows: reread.rows.map((r) => ({ ...r, gddSha256: amendedSha, gddRevision: 2 })) };
        });
        return answer();
      }, store);

      const outcome = await paths.gatherIndependentReview(campaign);

      const saved = store.get(campaign.id)!;
      // The amendment is not undone by the older copy…
      expect(saved).toMatchObject({ gddText: amendedText, gddRevision: 2 });
      expect(saved.requirements!.gddRevision).toBe(2);
      // …and the review's findings are not dropped by it.
      expect(outcome.reopened).toEqual([RID_2]);
      expect(outcome.added).toHaveLength(1);
      expectOutcomeStored(outcome, saved);
    });

    it("a revive saved while the reviewer ran refuses this copy's save: the outcome changes nothing and says so", async () => {
      const campaign = campaignWith();
      const store = new Map([[campaign.id, structuredClone(campaign)]]);
      const paths = reviewPathsOverStore(async (s) => {
        landMeanwhile(s, campaign.id, (other) => {
          other.stopGeneration = 1;
        });
        return answer();
      }, store);

      const outcome = await paths.gatherIndependentReview(campaign);

      expect(outcome.changed).toBe(0);
      expect(outcome.reopened).toEqual([]);
      expect(outcome.added).toEqual([]);
      expect(outcome.disclosed.join("\n")).toMatch(/revived .*not saved/);
      // The store holds the revived campaign, untouched by the review.
      expect(store.get(campaign.id)).toMatchObject({ stopGeneration: 1, requirements: ledger() });
      // Nor does the copy the caller still holds claim what was never saved.
      expect(campaign.independentReview?.gate?.reopened ?? []).toEqual([]);
    });
  });

  describe("storage", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it("the gate's record survives a reload beside the verbatim opinion", () => {
      dir = mkdtempSync(join(tmpdir(), "strada-w13-"));
      const storage = new CampaignStorage(join(dir, "campaigns.db"));
      try {
        const campaign = {
          ...campaignWith(),
          channelType: "cli",
          userId: "u1",
          projectRoot: dir,
          draftAttempts: 0,
          createdAt: 1,
          updatedAt: 1,
          independentReview: {
            ok: true,
            model: "fake-astra",
            text: REVIEW_TEXT,
            ms: 1,
            gate: { reopened: ["RC-02 (§2) — asserts a literal"], added: ["(§4) — \"The harbour gate…\""], disclosed: ["a paraphrase"], mode: "on" },
          },
        } as unknown as Campaign;
        storage.save(campaign);
        expect(storage.get(campaign.id)!.independentReview).toEqual(campaign.independentReview);
        // A damaged record is dropped whole; the verbatim opinion stays.
        storage.save({ ...campaign, independentReview: { ...campaign.independentReview!, gate: { reopened: "x" } } } as unknown as Campaign);
        expect(storage.get(campaign.id)!.independentReview).toEqual({ ok: true, model: "fake-astra", text: REVIEW_TEXT, ms: 1 });
      } finally {
        storage.close();
      }
    });
  });
});
