/**
 * What a person sees of the scope gate, and the decisions only a person may
 * make (GDD-drift plan W14): the delivery report and the status name each
 * milestone's GDD rows, park reasons, basis and writer; `/campaign rows`
 * lists them; `/campaign waive` takes a row or a section out of judgement for
 * the campaign's owner only; `/campaign rejudge` replays the judge without
 * changing anything.
 *
 * In a measured campaign six of six milestones went green on prose, and the report
 * a person read said so in no line at all.
 */

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignManager, type CampaignManagerOptions } from "./campaign-manager.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import { buildCampaignStatus, formatCampaignStatus } from "./campaign-status.js";
import { encodeRequirement } from "./requirement-identity.js";
import { judgeMilestone } from "./scope-verdict.js";
import type { Campaign, CampaignMilestone } from "./types.js";
import type {
  AcceptanceSource,
  GreenInput,
  RequirementLedger,
  RequirementRow,
  ScopeVerdictRecord,
} from "./scope-types.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { localFixturePath, missingLocalFixture } from "../tests/helpers/local-fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** An invented campaign with a measured one's shape (tests/fixtures/campaigns/synthetic-campaign.ts). */
const SYNTHETIC_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "campaigns", "synthetic-campaign.json");
/** A real campaign's export, never committed. */
const LOCAL_EXPORT = localFixturePath("campaign-export.json");
const GDD_SHA = "a".repeat(64);
const REV = "0123456789abcdef0123456789abcdef01234567";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function row(rid: string, fields: Partial<RequirementRow> = {}): RequirementRow {
  const text = fields.text ?? `The rule ${rid} must hold for every booked night.`;
  return {
    rid,
    encoded: encodeRequirement({ id: rid, text, lineage: rid, gddSha256: GDD_SHA, gddRevision: 1 }),
    text,
    section: "4.2 Catalogue rules",
    sectionNumber: "4.2",
    line: 10,
    span: { start: 0, end: text.length },
    kind: "rule",
    source: "extracted",
    ownership: [],
    status: "open",
    checks: [],
    gddSha256: GDD_SHA,
    gddRevision: 1,
    ...fields,
  };
}

function ledger(rows: RequirementRow[], extra: Partial<RequirementLedger> = {}): RequirementLedger {
  return {
    version: 1,
    gddSha256: GDD_SHA,
    gddRevision: 1,
    extractedAtMs: 1,
    rows,
    overflow: { count: 0, sections: [] },
    numberingGaps: [],
    llmAdded: 0,
    ...extra,
  };
}

const passed = { revision: REV, atMs: 5, outcome: "pass" as const, detail: "passed in run r1" };
const testCheck = (rid: string) => ({
  kind: "test" as const,
  testName: `Strada.Acceptance.M1.Acceptance_M1.R1_${rid.slice(-6)}`,
  path: "Assets/StradaAcceptance/M1/Acceptance_M1.cs",
  bodySha: "b".repeat(64),
});

/** m1 owns one row of every status; m2 is parked; m3 went green before the gate; the rest are disclosed or queued. */
function ledgerCampaign(root: string, overrides: Partial<Campaign> = {}): Campaign {
  const rows = [
    row("req-1-aaaaaa", { label: "C-1", owner: "m1", status: "passing", last: passed, checks: [testCheck("req-1-aaaaaa")] }),
    row("req-2-bbbbbb", {
      label: "C-2",
      owner: "m1",
      status: "failing",
      checks: [testCheck("req-2-bbbbbb")],
      last: { revision: REV, atMs: 5, outcome: "fail", detail: "Expected 12 but was 9" },
    }),
    row("req-3-cccccc", { label: "C-3", owner: "m1", status: "check-fault" }),
    row("req-4-dddddd", { label: "C-4", owner: "m1", status: "unmeasured" }),
    row("req-5-eeeeee", {
      label: "C-5",
      owner: "m1",
      status: "waived",
      waiver: { userId: "u1", atMs: 7, reason: "deferred to the second season" },
    }),
    row("req-6-ffffff", { label: "C-6", owner: "m2", status: "failing", sectionNumber: "6.2", section: "6.2 Conflicts" }),
    row("req-7-gggggg", { owner: "m3", status: "open", sectionNumber: "5", section: "5 Screens", kind: "screen" }),
    row("req-8-hhhhhh", {
      status: "excluded",
      kind: "aspiration",
      text: "Week-2 return rate must be at least 22%.",
      excludedBecause: "a business KPI",
      sectionNumber: "7.1",
      section: "7.1 Targets",
    }),
    row("req-9-iiiiii", { status: "open", kind: "judgement", text: "The sky must feel still and deep.", sectionNumber: "1", section: "1 Night Sky" }),
    row("req-10-jjjjjj", { status: "open", sectionNumber: "2.1", section: "2.1 Mirrors" }),
  ];
  const shadow: ScopeVerdictRecord = {
    green: false,
    state: "red",
    revision: REV,
    reasons: [
      {
        reasonClass: "red",
        code: "row-failing",
        detail: 'C-2 (§4.2, line 10): "The rule req-2-bbbbbb must hold for every booked night." fails on 01234567: Expected 12 but was 9',
        rid: "req-2-bbbbbb",
      },
    ],
    atMs: 9,
    mode: "shadow",
  };
  const proven: ScopeVerdictRecord = {
    green: true,
    basis: "proven",
    revision: REV,
    reasons: [],
    caveats: [
      'the run ended "task_stuck", but every owned row passed checks written by a model that did not work on the milestone (scope proven)',
    ],
    atMs: 10,
    mode: "on",
  };
  const milestones: CampaignMilestone[] = [
    { id: "m1", title: "Sprint 1", prompt: "p1", status: "green", attempts: 1, scopeVerdict: shadow, judgementBasis: "typed" },
    {
      id: "m2",
      title: "Sprint 2",
      prompt: "p2",
      status: "failed",
      attempts: 2,
      parked: {
        atMs: 11,
        queued: ["req-6-ffffff"],
        reasons: [{ reasonClass: "red", code: "row-failing", detail: "C-6 (§6.2, line 10): the later sighting is not kept as a note", rid: "req-6-ffffff" }],
      },
    },
    { id: "m3", title: "Sprint 3", prompt: "p3", status: "green", attempts: 1, judgementBasis: "legacy" },
    { id: "m4", title: "Sprint 4", prompt: "p4", status: "green", attempts: 1, scopeVerdict: proven, judgementBasis: "typed" },
  ];
  return {
    id: "campaign_scope_1",
    chatId: "chat-1",
    channelType: "cli",
    userId: "u1",
    projectRoot: root,
    state: "done",
    draftAttempts: 0,
    currentMilestone: 3,
    createdAt: 1,
    updatedAt: 2,
    milestones,
    gddPath: "docs/GDD.md",
    gddSha256: GDD_SHA,
    gddRevision: 1,
    requirements: ledger(rows, {
      overflow: { count: 3, sections: ["8 Star tables"] },
      numberingGaps: [{ series: "C", missing: ["C-7", "C-8"], detail: "C-1…C-9 named, C-7 and C-8 not defined" }],
      llmAdded: 2,
    }),
    pendingCoverageGaps: [
      row("req-10-jjjjjj").encoded,
      row("req-6-ffffff", { sectionNumber: "6.2", section: "6.2 Conflicts" }).encoded,
      "a legacy gap with no identity tail",
    ],
    ...overrides,
  };
}

function acceptanceSource(milestoneId: string, independence: "different-model" | "same-model"): AcceptanceSource {
  const source = `// acceptance file for ${milestoneId}\n`;
  return {
    milestoneId,
    path: `Assets/StradaAcceptance/${milestoneId.toUpperCase()}/Acceptance_${milestoneId.toUpperCase()}.cs`,
    sha256: sha256(source),
    source,
    writer: { provider: "deepseek", model: "deepseek-v4", independence },
    revisions: 1,
    tests: [{ rid: "req-1-aaaaaa", testName: testCheck("req-1-aaaaaa").testName, bodySha: "b".repeat(64) }],
  };
}

interface FakeTask {
  id: string;
  status: string;
  result?: string;
  verification?: unknown;
  title: string;
  createdAt: number;
  updatedAt: number;
  progress: never[];
}

const managers: CampaignManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(opts: { tasks?: Map<string, FakeTask>; extra?: Partial<CampaignManagerOptions> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "strada-scope-report-"));
  dirs.push(dir);
  const storage = new CampaignStorage(join(dir, "campaigns.db"));
  const tasks = opts.tasks ?? new Map<string, FakeTask>();
  const taskManager = Object.assign(new EventEmitter(), {
    getStatus: (id: string) => tasks.get(id) ?? null,
    findLatestLineageTask: (id: string) => tasks.get(id) ?? null,
    listTasks: () => [],
  });
  const messages: Array<{ chatId: string; text: string }> = [];
  const manager = new CampaignManager({
    storage,
    planner: { planMilestones: vi.fn() } as unknown as CampaignPlanner,
    taskManager: taskManager as unknown as TaskManager,
    messenger: async (chatId, text) => {
      messages.push({ chatId, text });
    },
    projectRoot: dir,
    ...opts.extra,
  });
  managers.push(manager);
  return { manager, storage, messages, root: dir };
}

const report = (manager: CampaignManager, campaign: Campaign): string =>
  (manager as unknown as { buildDeliveryReport(c: Campaign): string }).buildDeliveryReport(campaign);

/** The line the report renders for one milestone. */
const lineOf = (text: string, title: string): string =>
  text.split("\n").find((l) => l.startsWith("• ") && l.includes(` ${title}`)) ?? "";

describe("the delivery report names each milestone's GDD rows and how its verdict was reached (W14)", () => {
  it("counts the rows, marks the park, names the basis, the writer, the shadow verdict and the disclosed rows", () => {
    const { manager, storage, root } = build({ extra: { scopeGateMode: "shadow" } });
    const campaign = ledgerCampaign(root);
    storage.save(campaign);
    storage.putAcceptance(campaign.id, acceptanceSource("m1", "different-model"), 3);
    storage.putAcceptance(campaign.id, acceptanceSource("m4", "same-model"), 3);
    const text = report(manager, campaign);

    const m1 = lineOf(text, "Sprint 1");
    expect(m1).toContain("GDD rows: 1 passing, 1 failing, 1 check-fault, 1 unmeasured, 1 waived");
    expect(m1).toContain("deepseek:deepseek-v4 (different-model)");
    expect(m1).toContain("scope gate (shadow, not acted on): would NOT be green");
    expect(text).toContain("C-2 (§4.2, line 10)");

    // No new status: a parked milestone keeps the failed icon and says PARKED in its line.
    const m2 = lineOf(text, "Sprint 2");
    expect(m2.startsWith("• ❌")).toBe(true);
    expect(m2).toContain("PARKED");
    expect(text).toContain("the later sighting is not kept as a note");

    expect(lineOf(text, "Sprint 3")).toContain("basis: legacy");
    const m4 = lineOf(text, "Sprint 4");
    expect(m4).toContain("basis: proven");
    expect(m4).toContain("(same-model)");
    // The terminal key the scope proof overrode is a caveat, not silence.
    expect(text).toContain('the run ended "task_stuck", but every owned row passed');
    expect(text).toMatch(/Sprint 4: its checks were written by .*same model/);

    expect(text).toContain("1 aspiration row(s)");
    expect(text).toContain("1 look-and-feel row(s)");
    expect(text).toContain("3 row(s) past the extraction cap were NOT checked");
    expect(text).toContain("C-7, C-8");
    expect(text).toContain('waived by a person: C-5 (§4.2) — "deferred to the second season"');
  });

  it("with the gate off and no ledger the report gains no line", () => {
    const { manager, root } = build();
    const plain = ledgerCampaign(root, { requirements: undefined, pendingCoverageGaps: undefined });
    plain.milestones = plain.milestones.map(({ scopeVerdict: _v, parked: _p, judgementBasis: _b, ...m }) => ({ ...m }));
    const text = report(manager, plain);
    for (const added of ["GDD rows", "scope gate", "Scope gate", "PARKED", "basis:", "requirement rows", "waived"]) {
      expect(text, added).not.toContain(added);
    }
  });

  it("an unreadable ledger is said to be unreadable, not reported as empty", () => {
    const { manager, root } = build({ extra: { scopeGateMode: "shadow" } });
    const text = report(manager, ledgerCampaign(root, { requirements: undefined, requirementsUnreadable: true }));
    expect(text).toContain("requirement ledger could not be read");
  });
});

describe("the status a person asks for (W14)", () => {
  it("carries the row counts, the park and the gate's wiring; with nothing to say it adds nothing", () => {
    const opts = { maxMilestoneAttempts: 2, milestoneTimeBoxMs: 1000, getTask: () => null, listTasks: () => [] };
    const campaign = ledgerCampaign("/p");
    const snapshot = buildCampaignStatus(campaign, { ...opts, scopeGate: { mode: "shadow", writer: null, runner: false } });
    const text = formatCampaignStatus(snapshot, 100);
    expect(text).toContain("Scope gate: shadow");
    expect(text).toContain("writer NOT wired");
    expect(text).toMatch(/m1 Sprint 1 — green, attempt 1\/2/);
    expect(text).toContain("GDD rows: 1 passing, 1 failing, 1 check-fault, 1 unmeasured, 1 waived");
    expect(text).toContain("🔴 m2 Sprint 2 — failed (PARKED)");
    expect(text).toContain("would NOT be green");

    const plain = ledgerCampaign("/p", { requirements: undefined });
    plain.milestones = plain.milestones.map(({ scopeVerdict: _v, parked: _p, judgementBasis: _b, ...m }) => ({ ...m }));
    const before = buildCampaignStatus(plain, opts);
    expect(before.milestones[0]).not.toHaveProperty("rows");
    const quiet = formatCampaignStatus(
      buildCampaignStatus(plain, { ...opts, scopeGate: { mode: "off", writer: null, runner: false } }),
      100,
    );
    expect(quiet).toBe(formatCampaignStatus(before, 100));
    expect(quiet).not.toContain("Scope gate");
  });

  it("describeStatus reads the gate's wiring from the manager", () => {
    const { manager, storage, root } = build({ extra: { scopeGateMode: "shadow" } });
    storage.save(ledgerCampaign(root, { state: "executing" }));
    expect(manager.describeStatus("chat-1")?.scopeGate).toEqual({ mode: "shadow", writer: null, runner: false });
    expect(manager.describeStatus("chat-1")?.milestones[0]?.rows).toMatchObject({ passing: 1, failing: 1, waived: 1 });
  });
});

describe("/campaign rows (W14)", () => {
  it("summarises every milestone, and lists one milestone's rows with their tests and last results", () => {
    const { manager, storage, root } = build({ extra: { scopeGateMode: "shadow" } });
    storage.save(ledgerCampaign(root));
    const all = manager.describeRows("chat-1") ?? "";
    expect(all).toContain("m1 Sprint 1");
    expect(all).toContain("1 passing, 1 failing");
    expect(all).toMatch(/queued with no owner: 1/);

    const m1 = manager.describeRows("chat-1", "M1") ?? "";
    expect(m1).toContain("C-2");
    expect(m1).toContain("failing");
    expect(m1).toContain(testCheck("req-2-bbbbbb").testName);
    expect(m1).toContain("Expected 12 but was 9");
    expect(m1).toContain("waived by u1: deferred to the second season");
    expect(m1).not.toContain("C-6");

    expect(manager.describeRows("chat-1", "m9")).toContain("no milestone m9");
  });

  it("says when there is no ledger instead of listing nothing", () => {
    const { manager, storage, root } = build();
    storage.save(ledgerCampaign(root, { requirements: undefined }));
    expect(manager.describeRows("chat-1")).toContain("no requirement ledger");
  });
});

describe("/campaign waive is a person's decision, for the campaign's owner only (W14)", () => {
  it("refuses anyone but the campaign's owner and changes nothing", async () => {
    const { manager, storage, root, messages } = build();
    storage.save(ledgerCampaign(root));
    expect(await manager.waiveByCommand("chat-1", "someone-else", "C-2", "not needed")).toBe(false);
    expect(messages.at(-1)!.text).toContain("Only the person who started this campaign can waive");
    const stored = storage.get("campaign_scope_1")!;
    expect(stored.requirements!.rows.find((r) => r.rid === "req-2-bbbbbb")!.status).toBe("failing");
  });

  it("refuses a waiver with no reason", async () => {
    const { manager, storage, root, messages } = build();
    storage.save(ledgerCampaign(root));
    expect(await manager.waiveByCommand("chat-1", "u1", "C-2", "   ")).toBe(false);
    expect(messages.at(-1)!.text).toMatch(/reason/i);
    expect(storage.get("campaign_scope_1")!.requirements!.rows.find((r) => r.rid === "req-2-bbbbbb")!.status).toBe("failing");
  });

  it("the owner's waiver is recorded, disclosed, dequeued, and the row no longer blocks the judge", async () => {
    const { manager, storage, root, messages } = build({ extra: { scopeGateMode: "shadow" } });
    storage.save(ledgerCampaign(root));
    expect(await manager.waiveByCommand("chat-1", "u1", "C-6", "conflict notes are cut from the MVP")).toBe(true);
    expect(messages.at(-1)!.text).toContain("Waived 1 GDD row");
    expect(messages.at(-1)!.text).toContain("C-6");

    const stored = storage.get("campaign_scope_1")!;
    const waived = stored.requirements!.rows.find((r) => r.rid === "req-6-ffffff")!;
    expect(waived.status).toBe("waived");
    expect(waived.waiver).toMatchObject({ userId: "u1", reason: "conflict notes are cut from the MVP" });
    // A queued requirement holds delivery; a waived one must not.
    expect(stored.pendingCoverageGaps).toEqual([row("req-10-jjjjjj").encoded, "a legacy gap with no identity tail"]);

    // The judge: the one failing row is waived, so what remains of m2 passes.
    const input = (rows: RequirementRow[]): GreenInput => ({
      milestoneId: "m2",
      mode: "on",
      revision: REV,
      compile: { ran: true, ok: true },
      tamper: [],
      own: rows,
      regression: [],
      results: { "req-11-kkkkkk": passed },
      run: {
        admitted: true,
        revision: REV,
        expected: ["t"],
        total: 1,
        failedNames: [],
        unattributed: 0,
        flaky: [],
        acceptanceCompileErrors: [],
        tamper: [],
        failures: [],
      },
      sources: [
        {
          ...acceptanceSource("m2", "different-model"),
          tests: [{ rid: "req-11-kkkkkk", testName: "t", bodySha: "c".repeat(64) }],
        },
      ],
      integrity: { terminalKeys: ["done"], worst: "done", source: "spine", workerModels: ["worker-model"] },
      gates: { visualEvidence: "pass", noWork: "pass", art: "not-armed", prosOnly: "not-armed" },
      proseFailure: false,
    });
    const other = row("req-11-kkkkkk", { owner: "m2", status: "passing", last: passed });
    const before = ledgerCampaign(root).requirements!.rows.find((r) => r.rid === "req-6-ffffff")!;
    expect(judgeMilestone(input([before, other])).green).toBe(false);
    expect(judgeMilestone(input([waived, other])).green).toBe(true);

    // Disclosed in the report.
    expect(report(manager, stored)).toContain('waived by a person: C-6 (§6.2) — "conflict notes are cut from the MVP"');
  });

  it("waives a whole GDD section by its number", async () => {
    const { manager, storage, root, messages } = build();
    storage.save(ledgerCampaign(root));
    expect(await manager.waiveByCommand("chat-1", "u1", "§4", "section 4 is the prototype's, not the game's")).toBe(true);
    const rows = storage.get("campaign_scope_1")!.requirements!.rows;
    // Every §4.x row that still decided is waived; the one waived before keeps its own waiver.
    for (const rid of ["req-1-aaaaaa", "req-2-bbbbbb", "req-3-cccccc", "req-4-dddddd"]) {
      expect(rows.find((r) => r.rid === rid)!.status, rid).toBe("waived");
    }
    expect(rows.find((r) => r.rid === "req-5-eeeeee")!.waiver!.reason).toBe("deferred to the second season");
    expect(rows.find((r) => r.rid === "req-6-ffffff")!.status).toBe("failing");
    expect(messages.at(-1)!.text).toContain("Waived 4 GDD row");
  });

  it("names a target that matches nothing instead of waiving at random", async () => {
    const { manager, storage, root, messages } = build();
    storage.save(ledgerCampaign(root));
    expect(await manager.waiveByCommand("chat-1", "u1", "C-99", "no such row")).toBe(false);
    expect(messages.at(-1)!.text).toContain("No GDD row matches C-99");
  });

  it("a stale copy saved after the waiver does not undo it or requeue the row", async () => {
    const { manager, storage, root } = build();
    storage.save(ledgerCampaign(root));
    const stale = storage.get("campaign_scope_1")!;
    expect(await manager.waiveByCommand("chat-1", "u1", "C-6", "cut from the MVP")).toBe(true);
    (manager as unknown as { persist(c: Campaign): boolean }).persist(stale);
    const stored = storage.get("campaign_scope_1")!;
    expect(stored.requirements!.rows.find((r) => r.rid === "req-6-ffffff")!.status).toBe("waived");
    expect(stored.pendingCoverageGaps).not.toContain(row("req-6-ffffff", { sectionNumber: "6.2", section: "6.2 Conflicts" }).encoded);
  });

  it("a waived row is not among the rows the next acceptance file is written for", async () => {
    const { manager, storage, root } = build();
    storage.save(ledgerCampaign(root));
    const { acceptanceTestRows } = await import("./scope-report.js");
    const before = acceptanceTestRows(storage.get("campaign_scope_1")!, "m2").map((r) => r.rid);
    expect(before).toEqual(["req-6-ffffff"]);
    await manager.waiveByCommand("chat-1", "u1", "C-6", "cut from the MVP");
    expect(acceptanceTestRows(storage.get("campaign_scope_1")!, "m2")).toEqual([]);
  });
});

// ─── /campaign rejudge on an exported campaign ──────────────────────────────

interface FixtureMilestone extends Record<string, unknown> {
  id: string;
  title: string;
  status: CampaignMilestone["status"];
  attempts: number;
  taskId: string;
  tip: {
    id: string;
    status: string;
    createdAt: number;
    completedAt: number;
    verification: unknown;
    stamps: Record<string, number>;
    evidenceLines: Array<{ line: number; text: string }>;
  } | null;
}

/** An exported campaign record as a stored campaign, and its lineage tips as the task manager holds them. */
function loadExport(path: string, root: string): { campaign: Campaign; tasks: Map<string, FakeTask>; milestones: FixtureMilestone[] } {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as {
    campaign: Record<string, unknown> & { id: string; state: Campaign["state"]; currentMilestone: number; createdAt: number; updatedAt: number };
    milestones: FixtureMilestone[];
  };
  const tasks = new Map<string, FakeTask>();
  const milestones = fixture.milestones.map((m) => {
    const { tip, sectionRefs: _refs, promptChars: _chars, promptSha256: _sha, ...fields } = m;
    if (tip && !("missing" in tip)) {
      tasks.set(m.taskId, {
        id: tip.id,
        status: tip.status,
        result: tip.evidenceLines.map((l) => l.text).join("\n"),
        ...(tip.verification ? { verification: tip.verification } : {}),
        title: m.title,
        createdAt: tip.createdAt,
        updatedAt: tip.completedAt,
        progress: [],
      });
    }
    return { ...fields, prompt: "(omitted from the fixture)" } as unknown as CampaignMilestone;
  });
  const { projectName: _name, ...campaignFields } = fixture.campaign;
  return {
    campaign: {
      ...(campaignFields as unknown as Campaign),
      chatId: "chat-export",
      channelType: "cli",
      userId: "u1",
      projectRoot: root,
      milestones,
    },
    tasks,
    milestones: fixture.milestones,
  };
}

/** Replay an export with /campaign rejudge; the stored record before and after, and the report. */
function rejudgeExport(path: string) {
  const tasks = new Map<string, FakeTask>();
  const { manager, storage, root } = build({ tasks });
  const loaded = loadExport(path, root);
  for (const [id, task] of loaded.tasks) tasks.set(id, task);
  storage.save(loaded.campaign);
  const before = JSON.stringify(storage.get(loaded.campaign.id));
  const text = manager.rejudgeByCommand("another-chat", loaded.campaign.id) ?? "";
  return {
    text,
    lineOf: (id: string) => text.split("\n").find((l) => l.startsWith(`• ${id} `)) ?? "",
    before,
    after: JSON.stringify(storage.get(loaded.campaign.id)),
    judgements: storage.listJudgements(loaded.campaign.id),
    milestones: loaded.milestones,
  };
}

describe("/campaign rejudge replays the judge and changes nothing (W14)", () => {
  it("on a campaign that went green on prose, none of the stored greens stands, and the record is untouched", () => {
    const replay = rejudgeExport(SYNTHETIC_FIXTURE);
    expect(replay.text).toContain("0 of 7 stored greens would be green");
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) {
      expect(replay.lineOf(id), id).toContain("stored green → NOT green");
    }
    const m1 = replay.lineOf("m1");
    expect(m1).toContain('"task_stuck"');
    expect(m1).toContain("rebuilt from the record");

    expect(replay.after).toBe(replay.before);
    expect(replay.judgements).toEqual([]);
  });

  it.skipIf(!LOCAL_EXPORT)(
    `on a real export kept locally, a green whose tip carries a stuck stamp does not stand, and nothing changes${LOCAL_EXPORT ? "" : ` (${missingLocalFixture("campaign-export.json", "an export-campaign-fixture.mjs export of a real campaign")})`}`,
    () => {
      const replay = rejudgeExport(LOCAL_EXPORT!);
      const stuckGreens = replay.milestones.filter((m) => m.status === "green" && (m.tip?.stamps?.["task_stuck"] ?? 0) > 0);
      for (const m of stuckGreens) expect(replay.lineOf(m.id), m.id).toContain("stored green → NOT green");
      expect(replay.after).toBe(replay.before);
      expect(replay.judgements).toEqual([]);
    },
  );

  it("replays a stored verdict from its stored input and says whether the replay agrees", () => {
    const { manager, storage, root } = build();
    const campaign = ledgerCampaign(root);
    storage.save(campaign);
    const input: GreenInput = {
      milestoneId: "m4",
      mode: "on",
      revision: REV,
      compile: { ran: true, ok: true },
      tamper: [],
      own: [],
      regression: [],
      results: {},
      sources: [],
      integrity: { terminalKeys: ["done"], worst: "done", source: "spine", workerModels: [] },
      gates: { visualEvidence: "pass", noWork: "pass", art: "pass", prosOnly: "pass" },
      proseFailure: false,
    };
    storage.appendJudgement({ campaignId: campaign.id, attemptKey: "m4#1", atMs: 20, input, judgement: judgeMilestone(input) });
    const text = manager.rejudgeByCommand("chat-1") ?? "";
    const m4 = text.split("\n").find((l) => l.startsWith("• m4 ")) ?? "";
    expect(m4).toContain("stored green → green");
    expect(m4).toContain("replayed from the verdict stored");
    expect(m4).toContain("the replay agrees");
  });

  it("a campaign id from another project is not judged", () => {
    const { manager, storage } = build();
    storage.save(ledgerCampaign("/somewhere/else"));
    expect(manager.rejudgeByCommand("chat-1", "campaign_scope_1")).toContain("No campaign campaign_scope_1 on this project");
  });
});
