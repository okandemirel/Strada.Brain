/**
 * The requirement ledger's life: read at plan time from the APPROVED text,
 * built once for a campaign that was already running when the scope gate
 * arrived, and read again when a person amends the GDD.
 *
 * Before the ledger, nothing turned a GDD rule into a row the system owned, so
 * nothing could hold a milestone to one. A gate can read the rows; until a
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
import { rowsJudgedFor } from "./acceptance-prompt.js";
import { CampaignManager, repairsForRequirement, type CampaignManagerOptions } from "./campaign-manager.js";
import { splitGddSections, type CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import { decodeIdentities, decodeRequirement, encodeRequirement } from "./requirement-identity.js";
import { buildLedger } from "./requirement-ledger.js";
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
  cancelReason?: string;
}

const managers: CampaignManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(mode: ScopeGateMode, extra: Partial<CampaignManagerOptions> = {}, ask: () => Promise<string> = async () => MODEL_REPLY) {
  const dir = mkdtempSync(join(tmpdir(), "strada-ledger-life-"));
  dirs.push(dir);
  const root = join(dir, "project");
  mkdirSync(join(root, "docs"), { recursive: true });
  const storage = new CampaignStorage(join(dir, "campaigns.db"));
  const tasks = new Map<string, FakeTask>();
  const submitted: string[] = [];
  const taskManager = Object.assign(new EventEmitter(), {
    submit: (_chatId: string, _channel: string, prompt: string) => {
      const task = { id: `task_${submitted.length + 1}`, status: "executing", createdAt: Date.now() };
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
    // A settled task stays as it settled, with the reason it was stopped for.
    cancel: (id: string, opts?: { reason?: string }) => {
      const task = tasks.get(id);
      if (!task || task.status === "cancelled" || task.status === "completed" || task.status === "failed") return;
      task.status = "cancelled";
      task.cancelReason = opts?.reason;
    },
  });
  const complete = vi.fn(ask);
  const planner = {
    planMilestones: vi.fn().mockResolvedValue(LADDER),
    complete,
  } as unknown as CampaignPlanner;
  const messages: string[] = [];
  const options: CampaignManagerOptions = {
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
  };
  const manager = new CampaignManager(options);
  managers.push(manager);
  /** The process starting again over the same store and tasks: the boot resume, nothing else. */
  const restart = async (): Promise<CampaignManager> => {
    const next = new CampaignManager(options);
    managers.push(next);
    await next.resumeActive();
    return next;
  };
  return { manager, storage, root, complete, messages, submitted, tasks, restart };
}

const ctx = { chatId: "chat-1", channelType: "cli", userId: "owner-1" };

/** The ledger's private builder, as a settle will call it. */
const ensureLedger = (manager: CampaignManager, campaign: Campaign): Promise<{ changed: boolean; note?: string }> =>
  (manager as unknown as { ensureLedger(c: Campaign): Promise<{ changed: boolean; note?: string }> }).ensureLedger(campaign);

const persist = (manager: CampaignManager, campaign: Campaign): boolean =>
  (manager as unknown as { persist(c: Campaign): boolean }).persist(campaign);

/** The milestone's next attempt, as a bounce or a resubmit sends it. */
const submitNow = (manager: CampaignManager, campaign: Campaign): void =>
  (manager as unknown as { submitCurrentMilestone(c: Campaign): void }).submitCurrentMilestone(campaign);

const byLabel = (rows: readonly RequirementRow[], label: string): RequirementRow => {
  const row = rows.find((r) => r.label === label);
  if (!row) throw new Error(`no row ${label}: ${rows.map((r) => r.label ?? r.text.slice(0, 24)).join(" | ")}`);
  return row;
};

const chunksOf = (text: string): number => splitGddSections(text).length;

describe("the ledger is read at plan time from the approved text", () => {
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

describe("an in-flight campaign gets its ledger once, at the next revive", () => {
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
    // The add-only pass ran after the submit, and what it added is the stored campaign's.
    expect(ledger.modelPassRevision).toBe(1);
    expect(ledger.llmAdded).toBe(1);
    expect(messages.some((m) => m.includes("add-only pass over the GDD added 1 row(s)"))).toBe(true);

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

  /** A model that has been asked and has not answered: the process can stop while it waits. */
  function unanswered(): () => Promise<string> {
    return () => new Promise<string>(() => {});
  }

  it("the revived sprint is submitted before the model is asked, so a restart during the add-only pass charges no attempt", async () => {
    const { manager, storage, root, complete, messages, submitted, tasks, restart } = build("shadow", {}, unanswered());
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    seed.milestones[1]!.taskId = "task_old";
    tasks.set("task_old", { id: "task_old", status: "failed", createdAt: Date.now() - 60_000 });
    storage.save(seed);

    void manager.reviveByCommand(ctx.chatId);
    await vi.waitFor(() => expect(complete).toHaveBeenCalled(), { timeout: 10_000 });

    // While the model is asked, the store already holds the revived sprint's task, and the chat was told.
    const during = storage.get(seed.id)!;
    expect.soft(during.state).toBe("executing");
    expect.soft(submitted).toHaveLength(1);
    expect.soft(during.milestones[1]!.taskId).toBe("task_1");
    expect.soft(during.milestones[1]!.attempts).toBe(1);
    expect.soft(during.requirements).toBeDefined();
    expect.soft(messages.some((m) => m.startsWith("Reviving the campaign"))).toBe(true);

    // The process stops here and starts again: the live sprint is adopted, nothing is judged or charged.
    await restart();
    const after = storage.get(seed.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[1]!.taskId).toBe("task_1");
    expect(after.milestones[1]!.attempts).toBe(1);
    expect(submitted).toHaveLength(1);
    // The old lineage's failure was the previous budget's: it is not judged as the revived sprint's first attempt.
    expect(after.milestones[1]!.prompt).toBe("build m2, capture a frame");
  });

  it("a restart during the add-only pass does not undo a person's revive of a campaign they had stopped", async () => {
    const { manager, storage, root, complete, messages, tasks, restart } = build("shadow", {}, unanswered());
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    seed.milestones[1]!.taskId = "task_old";
    seed.lastError = "NOT DELIVERED — Sprint m2 was cancelled";
    seed.deliveryReported = true;
    tasks.set("task_old", { id: "task_old", status: "cancelled", createdAt: Date.now() - 60_000, cancelReason: "user" });
    storage.save(seed);

    void manager.tryHandleRevive(ctx.chatId, "kampanya devam", ctx.userId);
    await vi.waitFor(() => expect(complete).toHaveBeenCalled(), { timeout: 10_000 });

    await restart();
    const after = storage.get(seed.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[1]!.status).toBe("running");
    expect(after.milestones[1]!.taskId).toBe("task_1");
    expect(messages.some((m) => m.includes("was cancelled, so the campaign stops here"))).toBe(false);
  });

  it("a result recorded while the add-only pass runs is kept: the pass stays owed instead of saving over it", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { manager, storage, root, complete, messages } = build("shadow", {}, async () => {
      await answered;
      return MODEL_REPLY;
    });
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    storage.save(seed);

    const revived = manager.reviveByCommand(ctx.chatId);
    await vi.waitFor(() => expect(complete).toHaveBeenCalled(), { timeout: 10_000 });
    // A settle records LD-1's result while the model is asked.
    const settled = storage.get(seed.id)!;
    const ld1 = byLabel(settled.requirements!.rows, "LD-1");
    ld1.status = "passing";
    ld1.last = { revision: "rev-b", atMs: 7, outcome: "pass", detail: "passed" };
    expect(persist(manager, settled)).toBe(true);
    answer();
    expect(await revived).toBe(true);

    const after = storage.get(seed.id)!;
    expect(byLabel(after.requirements!.rows, "LD-1")).toMatchObject({ status: "passing", last: { revision: "rev-b" } });
    expect(after.requirements!.modelPassRevision).toBeUndefined();
    expect(after.requirements!.rows.some((r) => r.source === "llm-added")).toBe(false);
    expect(messages.some((m) => m.includes("add-only pass over the GDD added"))).toBe(false);
  });

  it("a row the add-only pass gives the running sprint after its submit is not judged on that attempt; the next submit shows it", async () => {
    const line = "A lighthouse glows on the harbour menu's far shore.";
    const doc = APPROVED.replace("The harbour menu must show a Cast Off button.", `The harbour menu must show a Cast Off button.\n${line}`);
    const reply = JSON.stringify({ rows: [{ requirement: "a lighthouse glows on the harbour menu far shore", quote: line }] });
    const { manager, storage, root, submitted, messages } = build("on", {}, async () => reply);
    writeFileSync(join(root, "docs", "GDD.md"), doc);
    const seed = inFlightCampaign(root, QUEUED);
    seed.gddText = doc;
    storage.save(seed);

    expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);

    const campaign = storage.get(seed.id)!;
    const running = campaign.milestones[1]!;
    const added = campaign.requirements!.rows.find((r) => r.text === line)!;
    expect(added).toMatchObject({ source: "llm-added", owner: "m2" });
    // The prompt the sprint runs on was built before the pass read the row…
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).not.toContain(line);
    // …so this attempt is judged on what that prompt showed, and the chat says why the row waits.
    const judged = rowsJudgedFor(campaign.requirements!, running).map((r) => r.rid);
    expect(judged).not.toContain(added.rid);
    expect(judged.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("not judged on them") && m.includes(running.title))).toBe(true);

    // The next submit shows the row, and from then on the sprint is judged on it.
    submitNow(manager, storage.get(seed.id)!);
    expect(submitted[1]).toContain(line);
    expect(rowsJudgedFor(storage.get(seed.id)!.requirements!, storage.get(seed.id)!.milestones[1]!).map((r) => r.rid)).toContain(added.rid);
  });

  it("an amendment read while the sprint runs: a cosmetic rewording stays judged, a changed ask and a new row wait for the next prompt", async () => {
    const castOff = "The harbour menu must show a Cast Off button.";
    const docks = "The harbour menu must list 3 docks.";
    const doc = APPROVED.replace(castOff, `${castOff}\n${docks}`);
    const amended = doc
      .replace(castOff, "The harbour menu MUST show a Cast Off button!")
      .replace(docks, "The harbour menu must list 5 docks.\nThe harbour menu must ring a bell when a raft docks.");
    const { manager, storage, root, submitted, messages } = build("shadow");
    writeFileSync(join(root, "docs", "GDD.md"), doc);
    const seed = inFlightCampaign(root, QUEUED);
    seed.gddText = doc;
    storage.save(seed);
    expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);
    const before = storage.get(seed.id)!.requirements!.rows;
    const shownCastOff = before.find((r) => r.text === castOff)!;
    expect(shownCastOff.owner).toBe("m2");
    expect(submitted[0]).toContain(castOff);
    expect(submitted[0]).toContain(docks);

    writeFileSync(join(root, "docs", "GDD.md"), amended);
    expect(await manager.tryHandleAmendment(ctx.chatId, "amend gdd", ctx.userId)).toBe(true);

    const campaign = storage.get(seed.id)!;
    const rows = campaign.requirements!.rows;
    const reworded = rows.find((r) => r.text === "The harbour menu MUST show a Cast Off button!")!;
    const fiveDocks = rows.find((r) => r.text === "The harbour menu must list 5 docks.")!;
    const bell = rows.find((r) => r.text === "The harbour menu must ring a bell when a raft docks.")!;
    expect(reworded.rid).not.toBe(shownCastOff.rid);
    for (const row of [reworded, fiveDocks, bell]) expect(row.owner).toBe("m2");
    const judged = rowsJudgedFor(campaign.requirements!, campaign.milestones[1]!).map((r) => r.rid);
    // The same ask the prompt showed, under a new id…
    expect(judged).toContain(reworded.rid);
    // …while a changed ask and a new sentence were never on it.
    expect(judged).not.toContain(fiveDocks.rid);
    expect(judged).not.toContain(bell.rid);
    const told = messages.find((m) => m.startsWith("GDD amendment acknowledged")) ?? "";
    expect(told).toContain("2 row(s) of **Sprint m2** were not in the prompt its running attempt was sent with");
    expect(told).toContain("not judged on them");
  });

  it("the revived sprint is submitted before the chat is told, so a send that never returns leaves no saved revive without its task", async () => {
    const told: string[] = [];
    // The channel takes the revive's message and never answers; everything else is delivered.
    const messenger = async (_chatId: string, text: string): Promise<void> => {
      told.push(text);
      if (text.startsWith("Reviving the campaign")) await new Promise<never>(() => {});
    };
    const { manager, storage, root, submitted } = build("shadow", { messenger });
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    storage.save(seed);

    void manager.reviveByCommand(ctx.chatId);
    await vi.waitFor(() => expect(told.some((m) => m.startsWith("Reviving the campaign"))).toBe(true), { timeout: 5_000 });

    expect(submitted).toHaveLength(1);
    const during = storage.get(seed.id)!;
    expect(during.state).toBe("executing");
    expect(during.milestones[1]).toMatchObject({ status: "running", taskId: "task_1", attempts: 1 });
  });

  it("a revive the submit parks for an outage asks no model and never says the sprint runs after saying it paused", async () => {
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("claude");
    setLiveChainMemberNames(["claude"]);
    try {
      const { manager, storage, root, complete, messages, submitted } = build("on");
      writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
      const seed = inFlightCampaign(root, QUEUED);
      storage.save(seed);
      registry.recordOverloaded("claude", "quota wall");

      expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);

      const parked = storage.get(seed.id)!;
      expect(parked.state).toBe("failed");
      expect(parked.autoReviveAt).toBeGreaterThan(Date.now());
      expect(submitted).toHaveLength(0);
      // The rows are read without a model; the pass is owed to the revive that runs a sprint.
      expect(parked.requirements).toBeDefined();
      expect(parked.requirements!.modelPassRevision).toBeUndefined();
      expect(complete).not.toHaveBeenCalled();
      expect(messages.some((m) => m.includes("add-only pass"))).toBe(false);
      const paused = messages.findIndex((m) => m.includes("Campaign paused before starting"));
      expect(paused).toBeGreaterThanOrEqual(0);
      expect(messages.slice(paused + 1).some((m) => m.includes("fresh attempt budget"))).toBe(false);
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("claude");
    }
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

describe("a GDD amendment reads the ledger again", () => {
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
    // Built the way a settle builds it (the settle calls ensureLedger first).
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

  it("a save from a copy read before the ledger was built does not drop it; only a deliberate clear does", async () => {
    const { manager, storage, root } = build("shadow");
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    seed.state = "executing";
    seed.gddSha256 = sha256(APPROVED);
    seed.gddRevision = 1;
    storage.save(seed);
    // A settle holds this copy across its awaits; the ledger is built and saved meanwhile.
    const stale = storage.get(seed.id)!;
    const held = storage.get(seed.id)!;
    expect((await ensureLedger(manager, held)).changed).toBe(true);
    expect(persist(manager, held)).toBe(true);
    expect(stale.requirements).toBeUndefined();

    expect(persist(manager, stale)).toBe(true);

    const kept = storage.get(seed.id)!;
    expect(kept.requirements).toEqual(held.requirements);
    expect(kept.milestones[0]!.requirementIds).toEqual(held.milestones[0]!.requirementIds);
    expect(kept.milestones[0]!.requirementIds!.length).toBeGreaterThan(0);

    // A copy that drops the rows on purpose says so.
    const clearing = storage.get(seed.id)!;
    clearing.requirements = undefined;
    expect((manager as unknown as { persist(c: Campaign, o: { ledgerCleared: true }): boolean }).persist(clearing, { ledgerCleared: true })).toBe(true);
    expect(storage.get(seed.id)!.requirements).toBeUndefined();
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

describe("what the ledger's life must never do", () => {
  type RawDb = { prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown } };
  const rawDb = (storage: CampaignStorage): RawDb => (storage as unknown as { db: RawDb }).db;

  it("an unreadable stored ledger is not built over at a revive: its bytes stay, and no model is asked", async () => {
    const { manager, storage, root, complete } = build("on");
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    storage.save(seed);
    const damaged = '{"version":1,"rows":[{"rid":';
    rawDb(storage).prepare("UPDATE campaigns SET requirements_json = ? WHERE id = ?").run(damaged, seed.id);
    expect(storage.get(seed.id)!.requirementsUnreadable).toBe(true);

    expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);

    const campaign = storage.get(seed.id)!;
    expect(campaign.state).toBe("executing");
    expect(campaign.requirements).toBeUndefined();
    expect(campaign.requirementsUnreadable).toBe(true);
    const stored = rawDb(storage).prepare("SELECT requirements_json AS r FROM campaigns WHERE id = ?").get(seed.id) as { r: string };
    expect(stored.r).toBe(damaged);
    expect(campaign.milestones.every((m) => m.requirementIds === undefined)).toBe(true);
    // The gate does not start on rows it does not have.
    expect(campaign.scopeGateSince).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it("a replanned ladder owns the stored rows again and lifts the old plan's exclusions", async () => {
    const { manager, storage, root, submitted } = build("shadow");
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const gdd = { gddText: APPROVED, gddSha256: sha256(APPROVED), gddRevision: 1 };
    // The old ladder planned the rules second and left the screens out.
    const old = buildLedger(gdd, [{ id: "m1", coveredSections: ["Overview"] }, { id: "m2", coveredSections: ["Core Rules"] }], {
      atMs: 1_000,
      excluded: ["Screens: after launch"],
    })!.ledger;
    const harbour = (rows: readonly RequirementRow[]): RequirementRow => rows.find((r) => r.text.startsWith("The harbour menu must show"))!;
    expect(byLabel(old.rows, "LD-1").owner).toBe("m2");
    expect(harbour(old.rows).status).toBe("excluded");
    const seed = inFlightCampaign(root, QUEUED);
    storage.save({ ...seed, ...gdd, milestones: [], currentMilestone: 0, requirements: old });

    expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);
    await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 10_000 });

    const campaign = storage.get(seed.id)!;
    const rows = campaign.requirements!.rows;
    expect(byLabel(rows, "LD-1").owner).toBe("m1");
    expect(byLabel(rows, "LD-1").ownership.map((o) => o.milestoneId)).toEqual(["m2", "m1"]);
    expect(harbour(rows)).toMatchObject({ status: "open", owner: "m2" });
    expect(harbour(rows).excludedBecause).toBeUndefined();
    expect(campaign.milestones[0]!.requirementIds).toEqual(rows.filter((r) => r.owner === "m1").map((r) => r.rid));
  });

  it("a ledger that could not be read or built is said in the chat, at the plan and at a revive", async () => {
    const fault = () => {
      throw new Error("invented reader fault");
    };
    const planned = build("shadow");
    vi.spyOn(planned.manager as unknown as { readLedger(c: Campaign): unknown }, "readLedger").mockImplementation(fault);
    planned.manager.startFromGdd(ctx, APPROVED, "docs/GDD.md");
    await vi.waitFor(() => expect(planned.submitted).toHaveLength(1), { timeout: 10_000 });
    const announcement = planned.messages.find((m) => m.includes("Milestone ladder ready")) ?? "";
    expect(announcement).toMatch(/GDD rows could not be read.*invented reader fault/);
    // Only a retry that happens is promised: no settle reads the rows.
    expect(announcement).toContain("the next revive reads them again");
    expect(announcement).not.toContain("settle");

    const revived = build("shadow");
    writeFileSync(join(revived.root, "docs", "GDD.md"), APPROVED);
    revived.storage.save(inFlightCampaign(revived.root, QUEUED));
    vi.spyOn(revived.manager as unknown as { readLedger(c: Campaign): unknown }, "readLedger").mockImplementation(fault);
    expect(await revived.manager.reviveByCommand(ctx.chatId)).toBe(true);
    const revive = revived.messages.find((m) => m.startsWith("Reviving the campaign")) ?? "";
    expect(revive).toMatch(/GDD rows could not be read.*invented reader fault/);
    expect(revive).not.toContain("settle");
  });

  it("an add-only pass that fails after a revive's submit is named as what failed, and the revive it promises does run it", async () => {
    const fault = () => {
      throw new Error("invented pass fault");
    };
    const passed = build("shadow");
    writeFileSync(join(passed.root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(passed.root, QUEUED);
    passed.storage.save(seed);
    const pass = vi
      .spyOn(passed.manager as unknown as { completeLedgerPass(c: Campaign): unknown }, "completeLedgerPass")
      .mockImplementation(async () => fault());
    expect(await passed.manager.reviveByCommand(ctx.chatId)).toBe(true);
    expect(passed.submitted).toHaveLength(1);
    const failed = passed.messages.find((m) => m.includes("invented pass fault")) ?? "";
    // The rows were read; the pass over them is what failed.
    expect(failed).toMatch(/add-only pass over the GDD could not run.*invented pass fault/);
    expect(failed).not.toContain("could not be read");
    expect(failed).toContain("the next revive that starts a sprint asks the model again");
    expect(failed).not.toContain("settle");
    expect(passed.storage.get(seed.id)!.requirements!.rows.length).toBeGreaterThan(0);

    // The promise holds: the next revive runs the pass.
    pass.mockRestore();
    const stopped = passed.storage.get(seed.id)!;
    stopped.state = "failed";
    passed.storage.save(stopped);
    expect(await passed.manager.reviveByCommand(ctx.chatId)).toBe(true);
    expect(passed.complete).toHaveBeenCalled();
    expect(passed.storage.get(seed.id)!.requirements!.modelPassRevision).toBe(1);

    // At plan time too: the rows read are announced, and the pass is named as what failed.
    const planned = build("shadow");
    vi.spyOn(planned.manager as unknown as { completeLedgerPass(c: Campaign): unknown }, "completeLedgerPass").mockImplementation(async () => fault());
    const started = planned.manager.startFromGdd(ctx, APPROVED, "docs/GDD.md");
    await vi.waitFor(() => expect(planned.submitted).toHaveLength(1), { timeout: 10_000 });
    const announcement = planned.messages.find((m) => m.includes("Milestone ladder ready")) ?? "";
    expect(announcement).toMatch(/row\(s\) read from the approved GDD/);
    expect(announcement).toMatch(/add-only pass over the GDD could not run.*invented pass fault/);
    expect(announcement).not.toContain("could not be read");
    expect(planned.storage.get(started.id)!.requirements!.modelPassRevision).toBeUndefined();
  });

  it("a pass whose every call failed, and an amendment, promise the model only at a revive", async () => {
    const { manager, storage, root, messages } = build("shadow", {}, async () => {
      throw new Error("invented model outage");
    });
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    storage.save(seed);
    expect(await manager.reviveByCommand(ctx.chatId)).toBe(true);
    const owed = messages.find((m) => m.includes("could not run")) ?? "";
    expect(owed).toMatch(/add-only pass over the GDD could not run \(\d+ call\(s\) failed\)/);
    expect(owed).toContain("the next revive that starts a sprint asks the model again");
    expect(owed).not.toContain("settle");

    writeFileSync(join(root, "docs", "GDD.md"), AMENDED);
    expect(await manager.tryHandleAmendment(ctx.chatId, "amend gdd", ctx.userId)).toBe(true);
    const amended = messages.find((m) => m.startsWith("GDD amendment acknowledged")) ?? "";
    expect(amended).toContain("The add-only pass is owed for the amended document: the next revive that starts a sprint asks the model again.");
    expect(amended).not.toContain("settle");
  });

  it("the add-only pass asks about no text but the one the ledger was read from", async () => {
    const { manager, storage, root, complete } = build("shadow");
    writeFileSync(join(root, "docs", "GDD.md"), APPROVED);
    const seed = inFlightCampaign(root, QUEUED);
    seed.state = "executing";
    seed.gddSha256 = sha256(APPROVED);
    seed.gddRevision = 1;
    storage.save(seed);
    const held = storage.get(seed.id)!;
    // The rows are read and the model pass is still owed for revision 1…
    held.requirements = buildLedger(held, [{ id: "m1", coveredSections: ["Core Rules"] }, { id: "m2", coveredSections: ["Screens"] }], { atMs: 1_000 })!.ledger;
    // …but the text the campaign now carries is not the one those rows (and the approved hash) came from.
    held.gddText = AMENDED;

    const result = await ensureLedger(manager, held);

    expect(result.changed).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(held.requirements!.modelPassRevision).toBeUndefined();
    expect(held.requirements!.rows.some((r) => r.source === "llm-added")).toBe(false);
  });
});
