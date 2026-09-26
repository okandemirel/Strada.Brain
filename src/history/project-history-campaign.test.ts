/**
 * THE CAMPAIGN PRODUCERS (plan 6.6).
 *
 * Driven through the REAL CampaignManager — the public approval gate, the real
 * `persist()` funnel and the real delivery-package store — because the point of
 * this half of 6.6 is that the history fills up when the system does its work,
 * not when a test calls the writer directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "../campaign/campaign-manager.js";
import { CampaignStorage } from "../campaign/campaign-storage.js";
import type { Campaign, CampaignMilestone } from "../campaign/types.js";
import type { CampaignPlanner } from "../campaign/campaign-planner.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { ProjectHistoryStore, type ProjectHistoryEvent } from "./project-history.js";
import { createProjectHistoryRecorder } from "./project-history-recorder.js";

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

const OWNER = "okan";
const OTHER = "someone-else";

let dir: string;
let projectRoot: string;
let campaigns: CampaignStorage;
let daemon: DaemonStorage;
let history: ProjectHistoryStore;
let manager: CampaignManager;
let messages: string[];

/** A milestone with only the fields these tests care about. */
function milestone(over: Partial<CampaignMilestone> & { id: string; title: string }): CampaignMilestone {
  return { prompt: "do the work", status: "pending", attempts: 0, ...over };
}

function campaign(over: Partial<Campaign> = {}): Campaign {
  const now = Date.now();
  const row: Campaign = {
    id: `campaign_${now}_test${Math.floor(Math.random() * 1e6)}`,
    chatId: "chat-1",
    channelType: "web",
    userId: OWNER,
    projectRoot,
    state: "awaiting-approval",
    gddPath: "docs/Game_GDD.md",
    gddText: "# Test GDD\n\nA game.",
    draftAttempts: 0,
    milestones: [],
    currentMilestone: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  campaigns.save(row);
  return row;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "history-campaign-"));
  projectRoot = join(dir, "project");
  mkdirSync(join(projectRoot, "docs"), { recursive: true });
  writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), "# Test GDD\n\nA game.");
  campaigns = new CampaignStorage(join(dir, "campaigns.db"));
  daemon = new DaemonStorage(join(dir, "daemon.db"));
  daemon.initialize();
  history = new ProjectHistoryStore(daemon);
  messages = [];
  manager = new CampaignManager({
    storage: campaigns,
    planner: {
      planMilestones: vi.fn().mockResolvedValue([]),
      auditCoverage: vi.fn().mockResolvedValue([]),
      resolveCoverageGaps: vi.fn(async () => ({ closed: [], open: [] })),
    } as unknown as CampaignPlanner,
    taskManager: {
      on: () => undefined,
      submitTask: vi.fn(),
      getStatus: () => undefined,
      listTasks: () => [],
      findLatestLineageTask: () => null,
    } as unknown as TaskManager,
    messenger: async (_chatId: string, text: string) => {
      messages.push(text);
    },
    projectRoot,
    maxDraftAttempts: 2,
  });
  manager.setProjectHistoryRecorder(createProjectHistoryRecorder(daemon, { projectId: projectRoot }));
});

afterEach(() => {
  // Closes the campaign store and the project databases the manager opened
  // (Windows cannot remove a directory holding an open SQLite file).
  manager.dispose();
  daemon.close();
  campaigns.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Events of one kind for one viewer. */
function eventsOf(kind: ProjectHistoryEvent["kind"], viewer: string | undefined = OWNER): ProjectHistoryEvent[] {
  return history.list({ ...(viewer ? { viewer } : {}), kinds: [kind], limit: 100 });
}

// =============================================================================
// decision — the one human gate of a whole campaign
// =============================================================================

describe("the GDD approval gate records a decision", () => {
  it("records who approved what, bound to the GDD revision, and shows it to nobody else", async () => {
    const row = campaign();
    expect(await manager.tryHandleApproval(row.chatId, "evet")).toBe(true);

    const decisions = eventsOf("decision");
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision.summary).toBe(`GDD approved for ${row.id}`);
    expect(decision.owner).toEqual({ scope: "user", userId: OWNER });
    expect(decision.projectId).toBe(projectRoot);
    expect(decision.version.campaignRevision).toBe("gdd-r1");
    expect(decision.payload).toMatchObject({
      campaignId: row.id,
      decision: "approved",
      gate: "gdd-approval",
      gddPath: "docs/Game_GDD.md",
      gddRevision: 1,
      channelType: "web",
    });
    expect(typeof decision.payload.gddSha256).toBe("string");

    // A second identity is shown nothing at all — not the decision, not by id.
    expect(history.list({ viewer: OTHER, limit: 100 })).toEqual([]);
    expect(history.get(decision.id, OTHER)).toBeUndefined();
    // And it is still the owner's after a restart of the storage.
    daemon.close();
    const reopened = new DaemonStorage(join(dir, "daemon.db"));
    reopened.initialize();
    const afterRestart = new ProjectHistoryStore(reopened).get(decision.id, OWNER);
    expect(afterRestart!.version.campaignRevision).toBe("gdd-r1");
    reopened.close();
    daemon = new DaemonStorage(join(dir, "daemon.db"));
    daemon.initialize();
  });

  it("records the approval once, however many times the gate is re-entered", async () => {
    const row = campaign();
    await manager.tryHandleApproval(row.chatId, "evet");
    // A redelivered "evet" finds nothing awaiting approval; a direct re-approval
    // of the same revision must not become a second decision either.
    await manager.tryHandleApproval(row.chatId, "evet");
    expect(eventsOf("decision")).toHaveLength(1);
  });
});

// =============================================================================
// milestone — terminal states, through the real persist() funnel
// =============================================================================

describe("terminal milestones reach the durable history", () => {
  it("records a green and a failed milestone with the commit each landed as, and not a pending one", async () => {
    const row = campaign({
      milestones: [
        milestone({ id: "m1", title: "Sprint A", status: "green", attempts: 1, commits: ["aaaaaaaaaaaa1111"], testVerdict: "42/42" }),
        milestone({ id: "m2", title: "Sprint B", status: "failed", attempts: 2 }),
        milestone({ id: "m3", title: "Sprint C", status: "pending" }),
      ],
    });
    // The approval gate persists — which is what records the ladder's outcomes.
    await manager.tryHandleApproval(row.chatId, "evet");

    const milestones = eventsOf("milestone");
    // Sprint C is pending: not a terminal state, not history yet. (The campaign's
    // own terminal state is recorded too — asserted in its own test below.)
    expect(milestones.map((e) => e.summary).filter((s) => s.startsWith("Sprint")).sort())
      .toEqual(["Sprint A — green", "Sprint B — failed"]);
    expect(milestones.some((e) => e.summary.includes("Sprint C"))).toBe(false);
    const green = milestones.find((e) => e.summary.includes("Sprint A"))!;
    expect(green.owner).toEqual({ scope: "user", userId: OWNER });
    expect(green.version.commitSha).toBe("aaaaaaaaaaaa1111");
    expect(green.payload).toMatchObject({ campaignId: row.id, milestoneId: "m1", status: "green", attempts: 1, testVerdict: "42/42" });
    // Nobody else's business.
    expect(eventsOf("milestone", OTHER)).toEqual([]);
  });

  it("records a milestone outcome once, not once per save", async () => {
    const row = campaign({
      milestones: [milestone({ id: "m1", title: "Sprint A", status: "green", attempts: 1 })],
    });
    await manager.tryHandleApproval(row.chatId, "evet");
    // Every later save re-walks the ladder; the derived id makes the repeats
    // no-ops instead of duplicate history.
    await manager.tryHandleApproval(row.chatId, "evet");
    const stored = campaigns.get(row.id)!;
    stored.state = "cancelled";
    expect(eventsOf("milestone").filter((e) => e.summary === "Sprint A — green")).toHaveLength(1);
  });

  it("records the campaign's own terminal state", async () => {
    const row = campaign({ draftAttempts: 2, milestones: [] });
    // Rejecting past the revision budget cancels the campaign — a terminal state.
    expect(await manager.tryHandleApproval(row.chatId, "make the jump feel heavier")).toBe(true);
    expect(campaigns.get(row.id)!.state).toBe("cancelled");
    const terminal = eventsOf("milestone").filter((e) => e.summary.includes("cancelled"));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.owner).toEqual({ scope: "user", userId: OWNER });
    expect(terminal[0]!.payload).toMatchObject({ campaignId: row.id, state: "cancelled" });
  });
});

// =============================================================================
// delivery — the package store's own revision, plus the commit it was built on
// =============================================================================

describe("a stored delivery package reaches the durable history", () => {
  /** storeDeliveryPackage is the production path the delivery report runs. */
  function storePackage(row: Campaign): string {
    return (manager as unknown as {
      storeDeliveryPackage: (c: Campaign, howToRun: { path?: string; note?: string }) => string;
    }).storeDeliveryPackage(row, {});
  }

  it("records the delivery with its campaign revision and its completeness, owned by the campaign's user", () => {
    const row = campaign({
      state: "done",
      gddRevision: 3,
      milestones: [milestone({ id: "m1", title: "Sprint A", status: "green", attempts: 1, commits: ["bbbbbbbbbbbb2222"] })],
    });
    const line = storePackage(row);
    expect(line).toContain("Delivery package");

    const deliveries = eventsOf("delivery");
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect(delivery.version.campaignRevision).toBe("pkg-r1");
    expect(delivery.owner).toEqual({ scope: "user", userId: OWNER });
    expect(delivery.payload).toMatchObject({ campaignId: row.id, packageRevision: 1, gddRevision: 3 });
    expect(delivery.payload.completeness).toBeDefined();
    expect(typeof delivery.payload.documentSha256).toBe("string");
    expect(eventsOf("delivery", OTHER)).toEqual([]);
  });

  it("gives every stored package revision its own delivery event, each naming its revision", () => {
    // A package that CHANGED is a new revision — and a new revision IS a new
    // delivery to remember. The history follows the store's revisions rather
    // than inventing its own. The same report re-assembled later is not a new
    // revision (CMP-14: only its `assembledAt` differs), so it adds no event.
    const row = campaign({ state: "done", milestones: [milestone({ id: "m1", title: "Sprint A", status: "green" })] });
    storePackage(row);
    storePackage(row);
    expect(eventsOf("delivery").map((e) => e.version.campaignRevision)).toEqual(["pkg-r1"]);
    storePackage({ ...row, state: "failed" });
    const revisions = eventsOf("delivery").map((e) => e.version.campaignRevision).sort();
    expect(revisions).toEqual(["pkg-r1", "pkg-r2"]);
    expect(eventsOf("delivery").every((e) => e.owner.userId === OWNER)).toBe(true);
  });

  it("still delivers when the history recorder throws", () => {
    const row = campaign({ state: "done", milestones: [] });
    manager.setProjectHistoryRecorder(() => {
      throw new Error("history is on fire");
    });
    expect(() => storePackage(row)).not.toThrow();
    expect(storePackage(row)).toContain("Delivery package");
  });

  it("records nothing when no recorder is wired", async () => {
    manager.setProjectHistoryRecorder(undefined);
    const row = campaign({ milestones: [milestone({ id: "m1", title: "Sprint A", status: "green" })] });
    await manager.tryHandleApproval(row.chatId, "evet");
    storePackage(row);
    const count = daemon.getDatabase().prepare("SELECT COUNT(*) AS n FROM project_history").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
