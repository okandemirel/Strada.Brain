/**
 * The requirement ledger's life (GDD-drift plan W11): read at plan time from
 * the APPROVED text, built once for a campaign that was already running when
 * the scope gate arrived, and read again when a person amends the GDD.
 *
 * In campaign 18d4t nothing turned a GDD rule into a row the system owned, so
 * nothing could hold a milestone to one. W04 can read the rows; until a
 * campaign holds them, no gate has anything to judge.
 *
 * Every document here is invented.
 */

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignManager, repairsForRequirement, type CampaignManagerOptions } from "./campaign-manager.js";
import { splitGddSections, type CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import { decodeIdentities, decodeRequirement, encodeRequirement } from "./requirement-identity.js";
import type { RequirementRow, ScopeGateMode } from "./scope-types.js";
import type { Campaign, CampaignMilestone } from "./types.js";
import type { TaskManager } from "../tasks/task-manager.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** An invented design document: labelled rules (LD-4 never defined), a screen, a KPI. */
const APPROVED = [
  "# Lantern Drift — Game Design Document",
  "",
  "## 1. Overview",
  "A raft drifts down a slow river at night, carrying lanterns.",
  "",
  "## 2. Core Rules",
  "LD-1: The player must tap the lantern to light the next buoy.",
  "LD-2: A buoy must stay lit for 8 seconds.",
  "LD-3: The raft holds at most 4 passengers.",
  "LD-5: A capsized raft must respawn at the last lit buoy.",
  "",
  "## 3. Screens",
  "### 3.1 Harbour Menu",
  "The harbour menu must show a Cast Off button.",
  "",
  "## 4. KPI Targets",
  "Day-7 retention must be at least 20%.",
  "",
].join("\n");

/** What a worker left on disk: a rule nobody approved. */
const EDITED_ON_DISK = APPROVED.replace(
  "LD-5: A capsized raft must respawn at the last lit buoy.",
  "LD-5: A capsized raft must respawn at the last lit buoy.\nLD-6: The raft must never leave the river channel.",
);

/** The amendment a person approves: LD-1 reworded cosmetically, LD-2's number changed. */
const AMENDED = APPROVED.replace(
  "LD-1: The player must tap the lantern to light the next buoy.",
  "LD-1: The player must TAP the lantern, to light the next buoy!",
).replace("LD-2: A buoy must stay lit for 8 seconds.", "LD-2: A buoy must stay lit for 11 seconds.");

const LADDER = {
  milestones: [
    { title: "Sprint A — Rules", prompt: "build the core rules, capture a frame", coveredSections: ["Core Rules"] },
    { title: "Sprint B — Screens", prompt: "build the screens, capture a frame", coveredSections: ["Screens"] },
  ],
};

/** The add-only pass's model: quotes the overview verbatim, once per call. */
const MODEL_REPLY = JSON.stringify({
  rows: [{ requirement: "a raft drifts down a slow river at night carrying lanterns", quote: "A raft drifts down a slow river at night, carrying lanterns." }],
});

interface FakeTask {
  id: string;
  status: string;
  createdAt: number;
}

const managers: CampaignManager[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(mode: ScopeGateMode, extra: Partial<CampaignManagerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "strada-ledger-life-"));
  dirs.push(dir);
  const root = join(dir, "project");
  mkdirSync(join(root, "docs"), { recursive: true });
  const storage = new CampaignStorage(join(dir, "campaigns.db"));
  const tasks = new Map<string, FakeTask>();
  const submitted: string[] = [];
  const taskManager = Object.assign(new EventEmitter(), {
    submit: (_chatId: string, _channel: string, prompt: string) => {
      const task = { id: `task_${tasks.size + 1}`, status: "executing", createdAt: Date.now() };
      tasks.set(task.id, task);
      submitted.push(prompt);
      return task;
    },
    getStatus: (id: string) => tasks.get(id) ?? null,
    findLatestLineageTask: (id: string) => tasks.get(id) ?? null,
    findLineageRootId: (id: string) => id,
    isInLineage: (root: string, id: string) => root === id,
    priorProgressSummary: () => "",
    listTasks: () => [],
    listLiveInLineage: () => [],
    lineageHasDeliberateStop: () => false,
    cancel: (id: string) => {
      const task = tasks.get(id);
      if (task) task.status = "cancelled";
    },
  });
  const complete = vi.fn(async () => MODEL_REPLY);
  const planner = {
    planMilestones: vi.fn().mockResolvedValue(LADDER),
    complete,
  } as unknown as CampaignPlanner;
  const messages: string[] = [];
  const manager = new CampaignManager({
    storage,
    planner,
    taskManager: taskManager as unknown as TaskManager,
    messenger: async (_chatId, text) => {
      messages.push(text);
    },
    projectRoot: root,
    scopeGateMode: mode,
    retryAdoptionGraceMs: 10,
    completedSettleDelayMs: 0,
    ...extra,
  });
  managers.push(manager);
  return { manager, storage, root, complete, messages, submitted };
}

const ctx = { chatId: "chat-1", channelType: "cli", userId: "owner-1" };

/** The ledger's private builder, as a settle (W09) will call it. */
const ensureLedger = (manager: CampaignManager, campaign: Campaign): Promise<{ changed: boolean; note?: string }> =>
  (manager as unknown as { ensureLedger(c: Campaign): Promise<{ changed: boolean; note?: string }> }).ensureLedger(campaign);

const persist = (manager: CampaignManager, campaign: Campaign): boolean =>
  (manager as unknown as { persist(c: Campaign): boolean }).persist(campaign);

const byLabel = (rows: readonly RequirementRow[], label: string): RequirementRow => {
  const row = rows.find((r) => r.label === label);
  if (!row) throw new Error(`no row ${label}: ${rows.map((r) => r.label ?? r.text.slice(0, 24)).join(" | ")}`);
  return row;
};

const chunksOf = (text: string): number => splitGddSections(text).length;

describe("the ledger is read at plan time from the approved text (W11)", () => {
  it("shadow: every planned milestone gets its rows, unowned rows are queued, and the chat is told the counts", async () => {
    const { manager, storage, complete, messages, submitted } = build("shadow");
    const started = manager.startFromGdd(ctx, APPROVED, "docs/GDD.md");
    await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 10_000 });

    const campaign = storage.get(started.id)!;
    const ledger = campaign.requirements;
    expect(ledger).toBeDefined();
    expect(ledger!.gddSha256).toBe(sha256(APPROVED));
    expect(ledger!.gddRevision).toBe(1);
    const rows = ledger!.rows;
    for (const label of ["LD-1", "LD-2", "LD-3", "LD-5"]) expect(byLabel(rows, label).owner).toBe("m1");
    expect(rows.find((r) => r.text.startsWith("The harbour menu must show"))?.owner).toBe("m2");
    // The milestone's list is the ledger's own ownership, in GDD order.
    expect(campaign.milestones[0]!.requirementIds).toEqual(rows.filter((r) => r.owner === "m1").map((r) => r.rid));
    expect(campaign.milestones[1]!.requirementIds).toEqual(rows.filter((r) => r.owner === "m2").map((r) => r.rid));
    // The model may only ADD, quoting the document; its row sits in a section nobody planned, so it is queued.
    const added = rows.filter((r) => r.source === "llm-added");
    expect(added.map((r) => r.text)).toEqual(["A raft drifts down a slow river at night, carrying lanterns."]);
    expect(added[0]!.owner).toBeUndefined();
    expect(ledger!.llmAdded).toBe(1);
    expect(ledger!.modelPassRevision).toBe(1);
    expect(complete.mock.calls.length).toBeGreaterThan(0);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(chunksOf(APPROVED));
    expect(ledger!.numberingGaps.map((g) => g.missing).flat()).toContain("LD-4");

    const announcement = messages.find((m) => m.includes("Milestone ladder ready")) ?? "";
    expect(announcement).toMatch(/row\(s\) read from the approved GDD/);
    expect(announcement).toMatch(/queued with no owner: 1/);
    expect(announcement).toContain("LD-4");
    expect(announcement).toMatch(/aspiration/);
  });

  it("off: nothing is read, no model call is made, and the announcement is today's", async () => {
    const { manager, storage, complete, messages, submitted } = build("off");
    const started = manager.startFromGdd(ctx, APPROVED, "docs/GDD.md");
    await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 10_000 });

    const campaign = storage.get(started.id)!;
    expect(campaign.requirements).toBeUndefined();
    expect(campaign.milestones.every((m) => m.requirementIds === undefined)).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    const announcement = messages.find((m) => m.includes("Milestone ladder ready")) ?? "";
    expect(announcement).not.toMatch(/approved GDD/);
    expect(announcement.endsWith("Sprint 1 starts now.")).toBe(true);
  });
});

/** A campaign that was running before the gate: m1 green, m2 failed at the current rung, a repair sprint, a queue. */
function inFlightCampaign(root: string, queued: string): Campaign {
  const now = Date.now();
  const milestone = (id: string, fields: Partial<CampaignMilestone>): CampaignMilestone => ({
    id,
    title: `Sprint ${id}`,
    prompt: `build ${id}, capture a frame`,
    status: "pending",
    attempts: 0,
    ...fields,
  });
  return {
    id: "campaign_ledger_upgrade",
    chatId: ctx.chatId,
    channelType: ctx.channelType,
    userId: ctx.userId,
    projectRoot: root,
    state: "failed",
    gddPath: "docs/GDD.md",
    gddText: APPROVED,
    draftAttempts: 0,
    milestones: [
      milestone("m1", { status: "green", attempts: 1, coveredSections: ["Core Rules"] }),
      milestone("m2", { status: "failed", attempts: 2, coveredSections: ["Screens"] }),
      milestone("mcov1", { title: "Coverage completion 1.1 — raft capacity", status: "failed", attempts: 2, coverageGap: queued }),
    ],
    currentMilestone: 1,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    lastError: "Sprint m2 failed",
    pendingCoverageGaps: [queued, "Shop: absent"],
    deliveryRevives: 2,
    deliveryProofsSignature: "old-proofs",
  };
}

/** A queued requirement from before the ledger, worded as the GDD words LD-3, with an identity of its own. */
const QUEUED = encodeRequirement({
  id: "req-900-0123456789ab",
  text: "LD-3: The raft holds at most 4 passengers.",
  lineage: "req-900-0123456789ab",
});

describe("an in-flight campaign gets its ledger once, at the next revive (W11)", () => {
  it("on: built from gddText (never the edited disk copy), legacy greens kept, the queue's identities and repair budgets carried, counters reset once", async () => {
    const { manager, storage, root, complete, messages } = build("on");
    writeFileSync(join(root, "docs", "GDD.md"), EDITED_ON_DISK);
    const before = inFlightCampaign(root, QUEUED);
    storage.save(before);
    const repairsBefore = repairsForRequirement(before.milestones, QUEUED);
    expect(repairsBefore).toBe(1);

    expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);

    const campaign = storage.get(before.id)!;
    const ledger = campaign.requirements!;
    expect(ledger).toBeDefined();
    // THE APPROVED TEXT, not the disk copy a worker edited.
    expect(ledger.gddSha256).toBe(sha256(APPROVED));
    expect(ledger.rows.some((r) => r.text.includes("never leave the river"))).toBe(false);
    expect(campaign.gddSha256).toBe(sha256(APPROVED));
    expect(campaign.gddRevision).toBe(1);
    // A green from before the gate keeps its status and says how it was judged.
    expect(campaign.milestones[0]!.status).toBe("green");
    expect(campaign.milestones[0]!.judgementBasis).toBe("legacy");
    expect(campaign.milestones[1]!.judgementBasis).toBeUndefined();
    // Owners from coveredSections; the repair sprint owns nothing it was not planned to.
    expect(campaign.milestones[0]!.requirementIds).toEqual(ledger.rows.filter((r) => r.owner === "m1").map((r) => r.rid));
    expect(campaign.milestones[2]!.requirementIds).toBeUndefined();
    // THE QUEUE: no new identities, and the row is the queued requirement, so its repair budget carries.
    expect(campaign.pendingCoverageGaps).toEqual(before.pendingCoverageGaps);
    expect(decodeIdentities(campaign.pendingCoverageGaps!)).toEqual(decodeIdentities(before.pendingCoverageGaps!));
    const ld3 = byLabel(ledger.rows, "LD-3");
    expect(ld3.rid).toBe("req-900-0123456789ab");
    expect(decodeRequirement(ld3.encoded).identity?.lineage).toBe("req-900-0123456789ab");
    expect(repairsForRequirement(campaign.milestones, ld3.encoded)).toBe(repairsBefore);
    // The failure kinds change under the gate: the delivery counters start again, once.
    expect(campaign.deliveryRevives).toBeUndefined();
    expect(campaign.deliveryProofsSignature).toBeUndefined();
    expect(campaign.scopeGateSince).toBeGreaterThan(0);
    expect(complete.mock.calls.length).toBeGreaterThan(0);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(chunksOf(APPROVED));
    expect(messages.some((m) => /row\(s\) read from the approved GDD/.test(m))).toBe(true);

    // ONCE: a later settle neither rebuilds, nor asks the model again, nor resets the counters.
    const calls = complete.mock.calls.length;
    const later = storage.get(before.id)!;
    later.deliveryRevives = 3;
    later.deliveryProofsSignature = "new-proofs";
    storage.save(later);
    const again = await ensureLedger(manager, storage.get(before.id)!);
    expect(again.changed).toBe(false);
    expect(complete.mock.calls.length).toBe(calls);
    const after = storage.get(before.id)!;
    expect(after.deliveryRevives).toBe(3);
    expect(after.deliveryProofsSignature).toBe("new-proofs");
    expect(after.requirements!.extractedAtMs).toBe(ledger.extractedAtMs);
  });

  it("shadow: the ledger is built, and nothing a decision reads changes", async () => {
    const { manager, storage, root } = build("shadow");
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const before = inFlightCampaign(root, QUEUED);
    storage.save(before);

    expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);

    const campaign = storage.get(before.id)!;
    expect(campaign.requirements).toBeDefined();
    expect(campaign.deliveryRevives).toBe(2);
    expect(campaign.deliveryProofsSignature).toBe("old-proofs");
    expect(campaign.scopeGateSince).toBeUndefined();
    expect(campaign.pendingCoverageGaps).toEqual(before.pendingCoverageGaps);
  });

  it("off: the revive is today's — no ledger, no model call, no counter touched", async () => {
    const { manager, storage, root, complete } = build("off");
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const before = inFlightCampaign(root, QUEUED);
    storage.save(before);

    expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);

    const campaign = storage.get(before.id)!;
    expect(campaign.requirements).toBeUndefined();
    expect(campaign.milestones[0]!.judgementBasis).toBeUndefined();
    expect(campaign.deliveryRevives).toBe(2);
    expect(campaign.gddRevision).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("a GDD amendment reads the ledger again (W11)", () => {
  /** A running campaign whose ledger is built, with LD-1 and LD-2 passing their system-written tests. */
  async function amendable(mode: ScopeGateMode = "shadow") {
    const fixture = build(mode);
    const { manager, storage, root } = fixture;
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    seed.state = "executing";
    seed.gddSha256 = sha256(APPROVED);
    seed.gddRevision = 1;
    storage.save(seed);
    // Built the way a settle builds it (W09 calls ensureLedger first).
    const held = storage.get(seed.id)!;
    expect((await ensureLedger(manager, held)).changed).toBe(true);
    for (const label of ["LD-1", "LD-2"]) {
      const row = byLabel(held.requirements!.rows, label);
      row.status = "passing";
      row.last = { revision: "rev-a", atMs: 5, outcome: "pass", detail: "passed" };
      row.checks = [{ kind: "test", testName: `Strada.Acceptance.M1.Acceptance_M1.${label.replace("-", "")}`, path: "Assets/StradaAcceptance/M1/Acceptance_M1.cs", bodySha: "b".repeat(64) }];
    }
    persist(manager, held);
    return { ...fixture, id: seed.id, rows: storage.get(seed.id)!.requirements!.rows };
  }

  it("a cosmetic rewording keeps its row's lineage, result and test; a changed number reopens the row and supersedes its test", async () => {
    const { manager, storage, root, id, rows, complete } = await amendable();
    const ld1 = byLabel(rows, "LD-1");
    const ld2 = byLabel(rows, "LD-2");
    const ld3 = byLabel(rows, "LD-3");
    writeFileSync(join(root, "docs", "GDD.md"), AMENDED);

    expect(manager.amendGdd(id)).toBe(sha256(AMENDED));

    const campaign = storage.get(id)!;
    const ledger = campaign.requirements!;
    expect(ledger.gddSha256).toBe(sha256(AMENDED));
    expect(ledger.gddRevision).toBe(2);
    const cosmetic = byLabel(ledger.rows, "LD-1");
    expect(cosmetic.text).toBe("LD-1: The player must TAP the lantern, to light the next buoy!");
    expect(decodeRequirement(cosmetic.encoded).identity?.lineage).toBe(decodeRequirement(ld1.encoded).identity?.lineage);
    expect(cosmetic.status).toBe("passing");
    expect(cosmetic.last).toEqual(ld1.last);
    expect(cosmetic.checks).toEqual(ld1.checks);
    expect(cosmetic.owner).toBe("m1");
    expect(cosmetic.gddRevision).toBe(2);

    const changed = byLabel(ledger.rows, "LD-2");
    expect(changed.text).toBe("LD-2: A buoy must stay lit for 11 seconds.");
    expect(decodeRequirement(changed.encoded).identity?.lineage).toBe(decodeRequirement(ld2.encoded).identity?.lineage);
    expect(changed.rid).not.toBe(ld2.rid);
    expect(changed.status).toBe("open");
    expect(changed.last).toBeUndefined();
    expect(changed.bounds).toMatchObject({ kind: "exact", value: 11 });
    expect(changed.checks).toHaveLength(1);
    expect(changed.checks[0]).toMatchObject({ kind: "test", testName: ld2.checks[0]!.kind === "test" ? ld2.checks[0]!.testName : "" });
    expect((changed.checks[0] as { supersededAtMs?: number }).supersededAtMs).toBeGreaterThan(0);
    expect(changed.owner).toBe("m1");

    // Untouched wording: the same row.
    expect(byLabel(ledger.rows, "LD-3")).toMatchObject({ rid: ld3.rid, owner: "m1", gddRevision: 2 });
    expect(campaign.milestones[0]!.requirementIds).toEqual(ledger.rows.filter((r) => r.owner === "m1").map((r) => r.rid));

    // The add-only pass is owed for the new revision, and the next settle runs it once.
    expect(ledger.modelPassRevision).toBe(1);
    const calls = complete.mock.calls.length;
    const held = storage.get(id)!;
    expect((await ensureLedger(manager, held)).changed).toBe(true);
    expect(complete.mock.calls.length).toBeGreaterThan(calls);
    expect(held.requirements!.modelPassRevision).toBe(2);
  });

  it("a save from a copy read before the amendment does not put the old rows back", async () => {
    const { manager, storage, root, id } = await amendable();
    const stale = storage.get(id)!;
    writeFileSync(join(root, "docs", "GDD.md"), AMENDED);
    expect(manager.amendGdd(id)).toBe(sha256(AMENDED));

    expect(persist(manager, stale)).toBe(true);

    const campaign = storage.get(id)!;
    expect(campaign.gddRevision).toBe(2);
    expect(campaign.requirements!.gddRevision).toBe(2);
    expect(byLabel(campaign.requirements!.rows, "LD-2").text).toBe("LD-2: A buoy must stay lit for 11 seconds.");
    expect(campaign.milestones[0]!.requirementIds).toEqual(
      campaign.requirements!.rows.filter((r) => r.owner === "m1").map((r) => r.rid),
    );
  });

  it("off: an amendment changes the approved document and nothing else", async () => {
    const { manager, storage, root, id } = await amendable("shadow");
    const rowsBefore = storage.get(id)!.requirements!;
    // The same store under a manager running with the gate off.
    const off = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn() } as unknown as CampaignPlanner,
      taskManager: new EventEmitter() as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: root,
      scopeGateMode: "off",
    });
    managers.push(off);
    writeFileSync(join(root, "docs", "GDD.md"), AMENDED);
    expect(off.amendGdd(id)).toBe(sha256(AMENDED));
    expect(storage.get(id)!.requirements).toEqual(rowsBefore);
  });
});
