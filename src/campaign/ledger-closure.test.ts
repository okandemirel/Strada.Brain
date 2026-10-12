/**
 * Closure by the ledger (GDD-drift plan W12, M3).
 *
 * A coverage requirement used to be closed by a model's quote of a measured
 * line plus a word match (`resolveCoverageGaps` → `quoteIsAbout`): a commit
 * that named `LanternSystem.cs` closed "a lantern refills only at a shrine the
 * player has lit" whatever the lantern did. With a readable requirement ledger
 * under the scope gate's `on` mode, a GDD row is closed only by a check of its
 * own that passed on the revision being judged (`closesByLedger`), and the
 * resolver never sees a row. A campaign without a ledger, with an unreadable
 * one, or with the gate off or in shadow keeps today's resolver exactly.
 *
 * The GDD wording here is invented.
 */
import { describe, expect, it, vi } from "vitest";
import { CampaignManager, withRepairBudget } from "./campaign-manager.js";
import { CampaignPlanner, closingFact, quotableFactsOf } from "./campaign-planner.js";
import { encodeRequirement, requirementText } from "./requirement-identity.js";
import type { RequirementLedger, RequirementRow, RowResult, ScopeGateMode } from "./scope-types.js";
import type { Campaign, CampaignMilestone } from "./types.js";

const GDD_SHA = "e".repeat(64);
const REV_NOW = "b".repeat(40);
const REV_OLD = "a".repeat(40);

const GDD_TEXT = [
  "# Lantern Keeper",
  "## 2 Rules",
  "LR-01 The lantern drains one charge every 5 seconds.",
  "LR-02 A lantern refills only at a shrine the player has lit.",
  "LR-03 The player taps a shrine to light it.",
].join("\n");

function row(rid: string, text: string, fields: Partial<RequirementRow> = {}): RequirementRow {
  return {
    rid,
    encoded: encodeRequirement({ id: rid, text, lineage: rid, gddSha256: GDD_SHA, gddRevision: 1 }),
    text,
    section: "2 Rules",
    sectionNumber: "2",
    line: 3,
    span: { start: 0, end: text.length },
    kind: "rule",
    source: "extracted",
    owner: "m1",
    ownership: [],
    status: "open",
    checks: [testCheck(rid)],
    gddSha256: GDD_SHA,
    gddRevision: 1,
    ...fields,
  };
}

function testCheck(rid: string): RequirementRow["checks"][number] {
  return {
    kind: "test",
    testName: `Strada.Acceptance.M1.Acceptance_M1.R1_${rid}`,
    path: "Assets/StradaAcceptance/M1/Acceptance_M1.cs",
    bodySha: "f".repeat(64),
  };
}

const pass = (revision: string): RowResult => ({ revision, atMs: 5, outcome: "pass", detail: "passed in run r1" });
const fail = (revision: string, detail = "Expected: True But was: False"): RowResult => ({ revision, atMs: 5, outcome: "fail", detail });

function ledgerOf(rows: RequirementRow[]): RequirementLedger {
  return {
    version: 1,
    gddSha256: GDD_SHA,
    gddRevision: 1,
    extractedAtMs: 1,
    rows,
    overflow: { count: 0, sections: [] },
    numberingGaps: [],
    llmAdded: 0,
  };
}

function coverageSprint(id: string, gap: string, fields: Partial<CampaignMilestone> = {}): CampaignMilestone {
  return {
    id,
    title: `Coverage completion — ${requirementText(gap).slice(0, 60)}`,
    prompt: `- ${requirementText(gap)}\n`,
    coverageGap: gap,
    status: "failed",
    attempts: 2,
    ...fields,
  } as CampaignMilestone;
}

const BUILT: CampaignMilestone = {
  id: "m1",
  title: "Sprint 1 — Lanterns",
  prompt: "build the lanterns",
  status: "green",
  attempts: 1,
  commitNote: "2 commit(s): Assets/Scripts/Lantern/LanternSystem.cs",
} as CampaignMilestone;

function campaignWith(fields: Partial<Campaign>): Campaign {
  return {
    id: "c-w12",
    chatId: "chat",
    gddText: GDD_TEXT,
    gddPath: "docs/gdd.md",
    gddSha256: GDD_SHA,
    gddRevision: 1,
    milestones: [BUILT],
    ...fields,
  } as unknown as Campaign;
}

interface CoveragePaths {
  openRequirements: (c: Campaign) => Promise<{ open: string[]; auditFailed?: string }>;
  gapSprint: (c: Campaign, round: number, index: number, item: string) => CampaignMilestone;
}

/** The private coverage paths, with the tree and the gate stubbed as own properties. */
function coveragePaths(mode: ScopeGateMode | undefined, overrides: Record<string, unknown> = {}): CoveragePaths {
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
      ...(mode === undefined ? {} : { scopeGateMode: mode }),
    },
    overrides,
  );
  return manager as unknown as CoveragePaths;
}

/** A resolver that closes everything it is asked about: any closure it makes shows up in the result. */
function closingResolver() {
  return vi.fn(async (_gdd: string, reqs: readonly string[]) => ({ closed: [...reqs], open: [] as string[], unasked: [] as string[] }));
}

function plannerReplying(reply: string): { planner: CampaignPlanner; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async () => ({ text: reply }));
  const provider = { chat, name: "test", capabilities: { streaming: false } } as never;
  return { planner: new CampaignPlanner(provider), chat };
}

describe("a ledger row is closed only by its own check passing on this revision (W12)", () => {
  it("a row that passed on the current revision closes with no resolver call", async () => {
    const refill = row("req-002-aaaa", "A lantern refills only at a shrine the player has lit.", { status: "passing", last: pass(REV_NOW) });
    const campaign = campaignWith({
      requirements: ledgerOf([refill]),
      milestones: [BUILT, coverageSprint("mcov1", refill.encoded)],
    });
    const resolveCoverageGaps = closingResolver();

    const result = await coveragePaths("on", { planner: { resolveCoverageGaps } }).openRequirements(campaign);

    expect(resolveCoverageGaps).not.toHaveBeenCalled();
    expect(result.open).toEqual([]);
    expect(result.auditFailed).toBeUndefined();
    // The sprint's closure is its row's, bound to the revision it was read on.
    expect(campaign.milestones[1]!.coverageClosed).toBe(true);
    expect(campaign.milestones[1]!.coverageClosedRevision).toBe(REV_NOW);
  });

  it("a failing row stays open although a landed line satisfies the word match", async () => {
    const refill = row("req-002-aaaa", "A lantern refills only at a shrine the player has lit.", {
      status: "failing",
      last: fail(REV_NOW, "R2: lantern charge after visiting an unlit shrine — Expected: 0 But was: 3"),
    });
    // The precondition that made this a false closure: the word matcher finds
    // a measured line ABOUT the row (they share "lantern").
    expect(closingFact(refill.text, quotableFactsOf([BUILT]))).toBeDefined();
    const { planner, chat } = plannerReplying(
      JSON.stringify({ verdicts: [{ id: 1, delivered: true, evidence: "Assets/Scripts/Lantern/LanternSystem.cs" }] }),
    );
    const campaign = campaignWith({
      requirements: ledgerOf([refill]),
      milestones: [BUILT, coverageSprint("mcov1", refill.encoded, { coverageClosed: true, coverageClosedRevision: REV_NOW })],
    });

    const result = await coveragePaths("on", { planner }).openRequirements(campaign);

    expect(chat).not.toHaveBeenCalled();
    expect(result.open).toEqual([refill.encoded]);
    // …and a closure stamped earlier by the word match is withdrawn, so the
    // report cannot call the row delivered beside a NOT DELIVERED headline.
    expect(campaign.milestones[1]!.coverageClosed).not.toBe(true);
    expect(campaign.milestones[1]!.coverageClosedRevision).toBeUndefined();
  });

  it("a pass on another revision, a superseded check or a weak one closes nothing", async () => {
    const old = row("req-001-aaaa", "The lantern drains one charge every 5 seconds.", { status: "passing", last: pass(REV_OLD) });
    const superseded = row("req-002-bbbb", "A lantern refills only at a shrine the player has lit.", {
      status: "passing",
      last: pass(REV_NOW),
      checks: [{ ...testCheck("req-002-bbbb"), kind: "test", supersededAtMs: 9 } as RequirementRow["checks"][number]],
    });
    const weak = row("req-003-cccc", "The player taps a shrine to light it.", {
      status: "passing",
      last: pass(REV_NOW),
      checks: [{ ...testCheck("req-003-cccc"), kind: "test", weak: "asserts a literal" } as RequirementRow["checks"][number]],
    });
    const campaign = campaignWith({ requirements: ledgerOf([old, superseded, weak]) });
    const resolveCoverageGaps = closingResolver();

    const result = await coveragePaths("on", { planner: { resolveCoverageGaps } }).openRequirements(campaign);

    expect(resolveCoverageGaps).not.toHaveBeenCalled();
    expect(result.open).toEqual([old.encoded, superseded.encoded, weak.encoded]);
  });

  it("holds every blocking row, not only those a coverage sprint carries; waived, excluded, aspiration and look-and-feel rows never block", async () => {
    const rows = [
      row("req-001-pass", "The lantern drains one charge every 5 seconds.", { status: "passing", last: pass(REV_NOW) }),
      row("req-002-fail", "A lantern refills only at a shrine the player has lit.", { status: "failing", last: fail(REV_NOW) }),
      row("req-003-none", "The player taps a shrine to light it.", { owner: undefined }),
      row("req-004-fault", "A lit shrine glows until the level ends.", { status: "check-fault", last: pass(REV_NOW) }),
      row("req-005-waived", "Shrines must never be placed on water.", {
        status: "waived",
        waiver: { userId: "owner", atMs: 1, reason: "deferred" },
      }),
      row("req-006-excluded", "Multiplayer shrines are shared.", { status: "excluded", excludedBecause: "excluded by the plan" }),
      row("req-007-kpi", "Day-1 retention must exceed 40%.", { kind: "aspiration" }),
      row("req-008-look", "The lantern glow should feel warm.", { kind: "judgement" }),
    ];
    const campaign = campaignWith({ requirements: ledgerOf(rows) });

    const result = await coveragePaths("on", { planner: { resolveCoverageGaps: closingResolver() } }).openRequirements(campaign);

    expect(result.open.map(requirementText)).toEqual([
      "A lantern refills only at a shrine the player has lit.",
      "The player taps a shrine to light it.",
      "A lit shrine glows until the level ends.",
    ]);
  });

  it("a coverage sprint that carries no row still goes to the resolver, and only that one", async () => {
    const refill = row("req-002-aaaa", "A lantern refills only at a shrine the player has lit.", { status: "failing", last: fail(REV_NOW) });
    const capability = "work no tool was available for: audio generator unavailable";
    const asked: string[] = [];
    const resolveCoverageGaps = vi.fn(async (_gdd: string, reqs: readonly string[]) => {
      asked.push(...reqs);
      return { closed: [...reqs], open: [] as string[], unasked: [] as string[] };
    });
    const campaign = campaignWith({
      requirements: ledgerOf([refill]),
      milestones: [BUILT, coverageSprint("mcov1", refill.encoded), coverageSprint("mcov2", capability)],
    });

    const result = await coveragePaths("on", { planner: { resolveCoverageGaps } }).openRequirements(campaign);

    expect(asked).toEqual([capability]);
    expect(result.open).toEqual([refill.encoded]);
    expect(campaign.milestones[1]!.coverageClosed).not.toBe(true);
  });

  it("binds a sprint to its row by the row's lineage, so an older wording of the row is judged by the ledger too", async () => {
    const current = row("req-002-new", "A lantern refills only at a shrine the player has lit.", { status: "failing", last: fail(REV_NOW) });
    current.encoded = encodeRequirement({ id: "req-002-new", text: current.text, lineage: "req-002-old", gddSha256: GDD_SHA, gddRevision: 2 });
    const olderWording = encodeRequirement({ id: "req-002-old", text: "Lanterns refill at lit shrines only.", lineage: "req-002-old", gddSha256: GDD_SHA, gddRevision: 1 });
    const resolveCoverageGaps = closingResolver();
    const campaign = campaignWith({
      requirements: ledgerOf([current]),
      milestones: [BUILT, coverageSprint("mcov1", olderWording)],
    });

    const result = await coveragePaths("on", { planner: { resolveCoverageGaps } }).openRequirements(campaign);

    expect(resolveCoverageGaps).not.toHaveBeenCalled();
    expect(result.open).toEqual([current.encoded]);
  });

  it("on a tree with uncommitted changes no row closes, and the reason is given", async () => {
    const refill = row("req-002-aaaa", "A lantern refills only at a shrine the player has lit.", { status: "passing", last: pass(REV_NOW) });
    const campaign = campaignWith({ requirements: ledgerOf([refill]), milestones: [BUILT, coverageSprint("mcov1", refill.encoded)] });

    const result = await coveragePaths("on", { planner: { resolveCoverageGaps: closingResolver() }, projectIsDirty: () => true })
      .openRequirements(campaign);

    expect(result.open).toEqual([refill.encoded]);
    expect(result.auditFailed).toContain("uncommitted changes");
    expect(campaign.milestones[1]!.coverageClosed).not.toBe(true);
  });
});

describe("without an enforced ledger the resolver decides exactly as before (W12)", () => {
  const refill = row("req-002-aaaa", "A lantern refills only at a shrine the player has lit.", { status: "failing", last: fail(REV_NOW) });
  const cases: Array<[string, ScopeGateMode | undefined, Partial<Campaign>]> = [
    ["no ledger, gate on", "on", {}],
    ["an unreadable ledger, gate on", "on", { requirementsUnreadable: true }],
    ["a ledger, gate off", "off", { requirements: ledgerOf([refill]) }],
    ["a ledger, gate in shadow", "shadow", { requirements: ledgerOf([refill]) }],
    ["a ledger, no gate wired", undefined, { requirements: ledgerOf([refill]) }],
  ];

  it.each(cases)("%s", async (_name, mode, fields) => {
    const resolveCoverageGaps = closingResolver();
    const campaign = campaignWith({ ...fields, milestones: [BUILT, coverageSprint("mcov1", refill.encoded)] });

    const result = await coveragePaths(mode, { planner: { resolveCoverageGaps } }).openRequirements(campaign);

    expect(resolveCoverageGaps).toHaveBeenCalledTimes(1);
    expect(result.open).toEqual([]);
    expect(campaign.milestones[1]!.coverageClosed).toBe(true);
  });
});

describe("a coverage sprint for a ledger row carries the row (W12)", () => {
  it("records the row id and shows the row's words, its check and its last result", () => {
    const refill = row("req-002-aaaa", "A lantern refills only at a shrine the player has lit.", {
      label: "LR-02",
      status: "failing",
      last: fail(REV_NOW, "R2: lantern charge after visiting an unlit shrine — Expected: 0 But was: 3"),
    });
    const campaign = campaignWith({ requirements: ledgerOf([refill]) });

    const sprint = coveragePaths("on").gapSprint(campaign, 1, 0, refill.encoded);

    expect(sprint.requirementIds).toEqual([refill.rid]);
    expect(sprint.coverageGap).toBe(refill.encoded);
    expect(sprint.prompt).toContain("LR-02");
    expect(sprint.prompt).toContain(refill.text);
    expect(sprint.prompt).toContain("Strada.Acceptance.M1.Acceptance_M1.R1_req-002-aaaa");
    expect(sprint.prompt).toContain("Expected: 0 But was: 3");
    expect(sprint.prompt).not.toContain("⟦");
  });

  it("a requirement that is not a ledger row gets the same sprint as before", () => {
    const campaign = campaignWith({ requirements: ledgerOf([]) });
    const withLedger = coveragePaths("on").gapSprint(campaign, 1, 0, "Shop: absent");
    const without = coveragePaths("on").gapSprint(campaignWith({}), 1, 0, "Shop: absent");

    expect(withLedger.requirementIds).toBeUndefined();
    expect(withLedger).toEqual(without);
  });
});

describe("the repair budget is counted per row (W12)", () => {
  it("a row two sprints carried has spent its budget, whatever requirement each sprint was named after", () => {
    const shared = row("req-003-cccc", "The player taps a shrine to light it.");
    const milestones = [
      coverageSprint("mcov1", row("req-001-aaaa", "The lantern drains one charge every 5 seconds.").encoded, {
        requirementIds: ["req-001-aaaa", shared.rid],
      }),
      coverageSprint("mcov2", row("req-002-bbbb", "A lantern refills only at a shrine the player has lit.").encoded, {
        requirementIds: ["req-002-bbbb", shared.rid],
      }),
    ];

    const { schedulable, spent } = withRepairBudget([shared.encoded], milestones);

    expect(spent).toEqual([shared.encoded]);
    expect(schedulable).toEqual([]);
  });
});
