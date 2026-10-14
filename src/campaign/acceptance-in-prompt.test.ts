/**
 * The prompts the worker sees (GDD-drift plan W10, M3).
 *
 * In the measured campaign no sprint was ever shown the GDD sentences its milestone
 * would be judged on: the planner told it that its "deliverables" were what
 * the sprint "can be measured against" (nothing ever read them), and the
 * final sprint was told not to re-read the GDD at all. A worker cannot build
 * to rows it never sees, so every submit in shadow and on mode carries the
 * rows the milestone owns, verbatim, with their checks and last results.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CampaignManager, type CampaignManagerOptions } from "./campaign-manager.js";
import { CampaignPlanner, plannerSystem } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import { measureGddScope } from "./gdd-scope.js";
import type { Campaign, CampaignMilestone } from "./types.js";
import type { GreenReason, RequirementLedger, RequirementRow, ScopeGateMode } from "./scope-types.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const OPEN = "<<ACCEPTANCE — GDD rules this sprint is judged on>>";
const CLOSE = "<</ACCEPTANCE>>";

class FakeTasks extends EventEmitter {
  submitted: string[] = [];
  private n = 0;
  submit(_chatId: string, _channel: string, prompt: string): { id: string; status: string } {
    this.n += 1;
    this.submitted.push(prompt);
    return { id: `task_${this.n}`, status: "executing" };
  }
  findLatestLineageTask(id: string): { id: string; status: string } {
    return { id, status: "executing" };
  }
  getStatus(id: string): { id: string; status: string } {
    return { id, status: "executing" };
  }
  cancel(): void {}
  findLineageRootId(id: string): string {
    return id;
  }
  priorProgressSummary(): string {
    return "";
  }
  listTasks(): unknown[] {
    return [];
  }
}

const managers: CampaignManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(mode: ScopeGateMode, extra: Partial<CampaignManagerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "strada-acceptance-prompt-"));
  dirs.push(dir);
  const storage = new CampaignStorage(join(dir, "campaigns.db"));
  const tasks = new FakeTasks();
  const manager = new CampaignManager({
    storage,
    planner: { planMilestones: vi.fn(), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
    taskManager: tasks as unknown as TaskManager,
    messenger: async () => {},
    projectRoot: dir,
    scopeGateMode: mode,
    ...extra,
  });
  managers.push(manager);
  const submit = (campaign: Campaign): string => {
    (manager as unknown as { submitCurrentMilestone(c: Campaign, o?: { countAttempt?: boolean }): void }).submitCurrentMilestone(
      campaign,
      { countAttempt: false },
    );
    return tasks.submitted.at(-1) ?? "";
  };
  return { dir, storage, tasks, manager, submit };
}

function row(over: Partial<RequirementRow> & { rid: string; text: string }): RequirementRow {
  return {
    encoded: over.text,
    section: "12.5 Quay rules",
    line: 10,
    span: { start: 0, end: over.text.length },
    kind: "rule",
    source: "extracted",
    ownership: [],
    status: "open",
    checks: [],
    gddSha256: "a".repeat(64),
    gddRevision: 1,
    ...over,
  };
}

function ledgerOf(rows: RequirementRow[]): RequirementLedger {
  return {
    version: 1,
    gddSha256: "a".repeat(64),
    gddRevision: 1,
    extractedAtMs: 1,
    rows,
    overflow: { count: 0, sections: [] },
    numberingGaps: [],
    llmAdded: 0,
  };
}

function milestone(id: string, over: Partial<CampaignMilestone> = {}): CampaignMilestone {
  return { id, title: `Sprint ${id}`, prompt: `Build sprint ${id}. Compile green, PlayMode green.`, status: "pending", attempts: 0, ...over };
}

function campaignWith(storage: CampaignStorage, dir: string, over: Partial<Campaign> = {}): Campaign {
  const now = Date.now();
  const campaign: Campaign = {
    id: `campaign_${now}_w10${Math.random().toString(36).slice(2, 7)}`,
    chatId: "chat-1",
    channelType: "cli",
    userId: "u1",
    projectRoot: dir,
    state: "executing",
    draftAttempts: 0,
    milestones: [milestone("m1"), milestone("m2"), milestone("m3")],
    currentMilestone: 0,
    createdAt: now,
    updatedAt: now,
    gddText: "# Ferry GDD\n## 12.5 Quay rules\nEvery quay moors at most two boats.\n",
    ...over,
  };
  storage.save(campaign);
  return campaign;
}

function blockOf(prompt: string): string {
  const at = prompt.indexOf(OPEN);
  if (at < 0) return "";
  const end = prompt.indexOf(CLOSE, at);
  return prompt.slice(at, end < 0 ? undefined : end + CLOSE.length);
}

const LONG_FAILURE =
  "Expected: less than or equal to 2 But was: 3. " + "The quay moored a third boat after the second had tied up; ".repeat(8) + "TAIL-OF-THE-MESSAGE";

describe("the ACCEPTANCE block in the submitted prompt", () => {
  it("shows each owned row in the GDD's own words, with its test and its last result", () => {
    const h = harness("shadow");
    const owned = row({
      rid: "req-1-aaaaaaaa",
      label: "Q-4",
      text: "Every quay moors at most two boats; a third boat is turned away.",
      section: "12.5 Quay rules",
      line: 214,
      owner: "m1",
      checks: [{ kind: "test", testName: "Strada.Acceptance.M1.Acceptance_M1.R1_aaaaaa", path: "Assets/StradaAcceptance/M1/Acceptance_M1.cs", bodySha: "b" }],
      last: { revision: "1a2b3c4d5e6f", atMs: 1, outcome: "fail", detail: LONG_FAILURE },
    });
    // Listed by the milestone, owner not stamped yet: still this sprint's.
    const listed = row({ rid: "req-2-bbbbbbbb", text: "The crossing ends when the last cargo is landed.", line: 220 });
    const elsewhere = row({ rid: "req-3-cccccccc", text: "OTHER MILESTONE ROW", owner: "m2" });
    const aspiration = row({ rid: "req-4-dddddddd", text: "Captains should call the river calm.", owner: "m1", kind: "aspiration" });
    const excluded = row({ rid: "req-5-eeeeeeee", text: "EXCLUDED BY THE PLAN", owner: "m1", status: "excluded" });
    const campaign = campaignWith(h.storage, h.dir, {
      gddPath: "docs/FerryDesign.md",
      requirements: ledgerOf([owned, listed, elsewhere, aspiration, excluded]),
      milestones: [milestone("m1", { requirementIds: ["req-1-aaaaaaaa", "req-2-bbbbbbbb"] }), milestone("m2"), milestone("m3")],
    });

    const prompt = h.submit(campaign);
    const block = blockOf(prompt);

    expect(prompt.startsWith(campaign.milestones[0]!.prompt)).toBe(true);
    expect(prompt.split(OPEN)).toHaveLength(2);
    expect(block.endsWith(CLOSE)).toBe(true);
    // The row, verbatim, where the GDD has it.
    expect(block).toContain('"Every quay moors at most two boats; a third boat is turned away."');
    expect(block).toContain("Q-4");
    expect(block).toContain("12.5 Quay rules");
    expect(block).toContain("GDD line 214");
    expect(block).toContain("The crossing ends when the last cargo is landed.");
    // Its system check and what that check last said, clipped to 200 characters.
    expect(block).toContain("Strada.Acceptance.M1.Acceptance_M1.R1_aaaaaa");
    expect(block).toContain("fail on 1a2b3c4d");
    expect(block).toContain("Expected: less than or equal to 2 But was: 3.");
    expect(block).not.toContain("TAIL-OF-THE-MESSAGE");
    expect(block).toContain("not measured yet");
    // Rows the sprint is not judged on stay out.
    expect(block).not.toContain("OTHER MILESTONE ROW");
    expect(block).not.toContain("call the river calm");
    expect(block).not.toContain("EXCLUDED BY THE PLAN");
    // The rules of the folder and of the verdict.
    expect(block).toContain("Assets/StradaAcceptance");
    expect(block).toMatch(/read-only/i);
    expect(block).toMatch(/system-owned/i);
    expect(block).toMatch(/your own tests do not close rows/i);
    expect(block).toContain("ACCEPTANCE DISPUTE <test name or row id>: <why>");
    // Nothing in it arms an evidence demand the supervisor reads from the task prompt.
    expect(block).not.toMatch(/unity_|STRADA-REQUIRED-EVIDENCE|captur/i);
  });

  it("a text-only campaign's rows are quoted, never located in a file (review gdd-W10 P3)", () => {
    // No file in the project holds this GDD: "GDD line 214" sent a worker to
    // line 214 of whatever design document the repo happened to hold.
    const h = harness("on");
    const owned = row({ rid: "req-1-aaaaaaaa", label: "Q-4", text: "Every quay moors at most two boats.", line: 214, owner: "m1" });
    const textOnly = campaignWith(h.storage, h.dir, {
      requirements: ledgerOf([owned]),
      milestones: [milestone("m1", { requirementIds: ["req-1-aaaaaaaa"] }), milestone("m2"), milestone("m3")],
    });
    const block = blockOf(h.submit(textOnly));
    expect(block).toContain('"Every quay moors at most two boats."');
    expect(block).toContain("12.5 Quay rules");
    expect(block).not.toMatch(/line 214/);
    expect(block).toContain("campaign's GDD is not saved in the project, so no file holds it");
    expect(block).toContain("do not look for one");

    const saved = campaignWith(h.storage, h.dir, {
      gddPath: "docs/FerryDesign.md",
      requirements: ledgerOf([owned]),
      milestones: [milestone("m1", { requirementIds: ["req-1-aaaaaaaa"] }), milestone("m2"), milestone("m3")],
    });
    const savedBlock = blockOf(h.submit(saved));
    expect(savedBlock).toContain("GDD line 214");
    expect(savedBlock).not.toContain("not saved in the project");
  });

  it("an unbound row names what the sprint has to expose", () => {
    const h = harness("on");
    const unbound: GreenReason = {
      reasonClass: "check-fault",
      code: "row-unbound",
      detail: "the free berths of a quay",
      rid: "req-1-aaaaaaaa",
    };
    const campaign = campaignWith(h.storage, h.dir, {
      requirements: ledgerOf([row({ rid: "req-1-aaaaaaaa", text: "Every quay moors at most two boats.", owner: "m1" })]),
      milestones: [
        milestone("m1", {
          requirementIds: ["req-1-aaaaaaaa"],
          scopeVerdict: { green: false, state: "check-fault", revision: "r1", reasons: [unbound], atMs: 1, mode: "on" },
        }),
        milestone("m2"),
        milestone("m3"),
      ],
    });
    expect(blockOf(h.submit(campaign))).toContain("expose: the free berths of a quay");
  });

  it("two submits leave one block, and the stored milestone prompt carries none", () => {
    const h = harness("shadow");
    const campaign = campaignWith(h.storage, h.dir, {
      requirements: ledgerOf([row({ rid: "req-1-aaaaaaaa", text: "Every quay moors at most two boats.", owner: "m1" })]),
      milestones: [milestone("m1", { requirementIds: ["req-1-aaaaaaaa"] }), milestone("m2"), milestone("m3")],
    });
    h.submit(campaign);
    const second = h.submit(campaign);
    expect(second.split(OPEN)).toHaveLength(2);
    expect(h.storage.get(campaign.id)!.milestones[0]!.prompt).not.toContain(OPEN);
  });

  it("holds its size cap and names the rows past it by id", () => {
    const h = harness("on");
    const rows = Array.from({ length: 120 }, (_, i) =>
      row({
        rid: `req-${i}-${String(i).padStart(8, "0")}`,
        label: `FR-${i}`,
        text: `Row ${i} of the rules: ${"the quay keeps its order while boats drift into their berths, ".repeat(5)}end ${i}.`,
        line: 100 + i,
        owner: "m1",
      }),
    );
    const campaign = campaignWith(h.storage, h.dir, {
      requirements: ledgerOf(rows),
      milestones: [milestone("m1", { requirementIds: rows.map((r) => r.rid) }), milestone("m2"), milestone("m3")],
    });
    const block = blockOf(h.submit(campaign));
    expect(block.length).toBeGreaterThan(0);
    expect(block.length).toBeLessThanOrEqual(6_000);
    expect(block.endsWith(CLOSE)).toBe(true);
    const shown = rows.filter((r) => block.includes(r.text)).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(rows.length);
    // The first row past the cap is named, and the count of the rest is said.
    expect(block).toContain(`FR-${shown},`);
    expect(block).toContain(`${rows.length - shown} more row(s)`);
  });

  it("no ledger, no block", () => {
    const h = harness("on");
    const campaign = campaignWith(h.storage, h.dir);
    const prompt = h.submit(campaign);
    expect(prompt).not.toContain(OPEN);
    expect(prompt).toBe(campaign.milestones[0]!.prompt);
  });

  it("with the gate off, the sprint is submitted with exactly the prompt it had", () => {
    const h = harness("off");
    const campaign = campaignWith(h.storage, h.dir, {
      requirements: ledgerOf([row({ rid: "req-1-aaaaaaaa", text: "Every quay moors at most two boats.", owner: "m1" })]),
      milestones: [milestone("m1", { requirementIds: ["req-1-aaaaaaaa"] }), milestone("m2"), milestone("m3")],
    });
    expect(h.submit(campaign)).toBe(campaign.milestones[0]!.prompt);
  });
});

describe("the planner's instructions", () => {
  const GDD = "# Ferries\n## 1. Crossings\nSail boats across.\n## 2. Quays\nThere are 12 quays.\n";
  const BAR_OFF = "the relevant PlayMode tests green and UNFILTERED, a captured frame";
  const BAR_ON =
    "the relevant PlayMode tests green and UNFILTERED, the campaign's acceptance checks for this milestone's GDD rows pass " +
    "(Assets/StradaAcceptance, system-owned), a captured frame";

  it("no longer claims the sprint is measured against its deliverables", () => {
    for (const mode of ["off", "shadow", "on"] as const) {
      const text = plannerSystem(measureGddScope(GDD), true, mode);
      expect(text).toContain(
        '- Every milestone returns "deliverables": the concrete things it leaves behind (scenes, prefabs, systems, screens, clips, data).\n',
      );
      expect(text).not.toContain("measured against them");
    }
  });

  it("adds the acceptance checks to the verification bar only while the gate runs", () => {
    const scope = measureGddScope(GDD);
    const off = plannerSystem(scope, true, "off");
    expect(off).toContain(BAR_OFF);
    expect(off).not.toContain("StradaAcceptance");
    for (const mode of ["shadow", "on"] as const) {
      // Exactly one phrase apart: nothing else in the planner changes with the mode.
      expect(plannerSystem(scope, true, mode)).toBe(off.replace(BAR_OFF, BAR_ON));
    }
  });

  it("planMilestones plans with the mode it is given", async () => {
    const systems: string[] = [];
    const ladder = JSON.stringify({
      milestones: [
        { title: "Sprint A", prompt: "Build the crossings end to end, compile green, capture a frame.", coveredSections: ["1. Crossings"], deliverables: [] },
        { title: "Sprint B", prompt: "Build the twelve quays end to end, compile green, capture a frame.", coveredSections: ["2. Quays"], deliverables: [] },
      ],
      excluded: [],
    });
    const provider = {
      name: "fake",
      capabilities: { streaming: false },
      chat: async (system: string) => {
        systems.push(system);
        return { text: ladder };
      },
    };
    await new CampaignPlanner(provider as never).planMilestones(GDD, "docs/GDD.md", undefined, { scopeGate: "shadow" });
    expect(systems[0]).toContain(BAR_ON);
  });

  it("the campaign plans with its own gate mode", async () => {
    const planMilestones = vi.fn().mockResolvedValue({
      milestones: [
        { title: "Sprint A", prompt: "Build the crossings, compile green.", coveredSections: [], deliverables: [] },
        { title: "Sprint B", prompt: "Deliver the game, full suite green.", coveredSections: [], deliverables: [] },
      ],
      excluded: [],
    });
    const h = harness("shadow", {
      planner: { planMilestones, auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
    });
    h.manager.startFromGdd({ chatId: "chat-1", channelType: "cli", userId: "u1" }, GDD);
    await vi.waitFor(() => expect(planMilestones).toHaveBeenCalled());
    expect(planMilestones.mock.calls[0]![3]).toEqual({ scopeGate: "shadow" });
  });
});
