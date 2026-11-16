/**
 * What a campaign cost includes its own planning (task #73).
 *
 * Measured before the fix: a real campaign's style analysis and ladder call
 * booked "chat" rows with campaign_id NULL, so sumBudgetForCampaign — the
 * delivery package's "what did this campaign cost" — read 0 entries for a
 * campaign that had already spent on planning. Here a REAL CampaignManager
 * starts a campaign with the REAL planner and style analysis over scripted
 * providers, the REAL process ledger and the REAL cost ledger
 * (UnifiedBudgetManager over DaemonStorage), and the campaign's cost is read
 * back the way the delivery package reads it. Every game is invented.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CampaignManager } from "./campaign-manager.js";
import { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import { StyleAnalysis } from "../agents/style/style-analysis.js";
import { installProviderUsageLedger } from "../agents/providers/billed-call.js";
import { createProviderUsageLedger } from "../agent-core/engine/accounting.js";
import { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { RateLimiter } from "../security/rate-limiter.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { scriptedProvider, usage } from "../tests/helpers/usage-ledger-harness.js";
import { createLogger } from "../utils/logger.js";
import { estimateCostWithCache } from "../common/cost-model.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  installProviderUsageLedger(undefined);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const GDD = [
  "# Tide Courier — Game Design Document",
  "",
  "## 1. Sailing",
  "The courier boat sails between buoys; its speed stays between 3 and 6 knots.",
  "",
  "## 2. Storms",
  "A storm wave knocks one parcel overboard.",
  "",
  "## 3. Art Direction",
  "Watercolour sea in deep teal and sand, with soft paper texture and no outlines.",
].join("\n");

const LADDER = JSON.stringify({
  milestones: [
    { title: "Sail the buoys", prompt: "Build the courier boat's sailing between buoys with the speed band from the design.", coveredSections: ["Sailing"], deliverables: ["scene"] },
    { title: "Storm waves", prompt: "Add storm waves that knock one parcel overboard, and the parcel counter.", coveredSections: ["Storms", "Art Direction"], deliverables: ["wave prefab"] },
  ],
  excluded: [],
});

const STYLE = JSON.stringify({
  family: "painterly",
  pipeline: "sprite-native",
  proportions: { widthScale: 1, headScale: 1 },
  palette: ["#1f5f6b", "#e6d3a3", "#f4efe4"],
  outline: { width: 0, color: "#000000" },
  shading: "flat",
  references: [],
  notes: "Watercolour sea with soft paper texture.",
});

function build() {
  const dir = mkdtempSync(join(tmpdir(), "strada-campaign-cost-"));
  const root = join(dir, "project");
  mkdirSync(join(root, "docs"), { recursive: true });

  const daemon = new DaemonStorage(join(dir, "daemon.db"));
  daemon.initialize();
  daemon.migrateBudgetSource();
  installProviderUsageLedger(
    createProviderUsageLedger({
      counters: { metrics: new MetricsCollector(), rateLimiter: new RateLimiter({}) },
      budget: new UnifiedBudgetManager(daemon, { emit: () => {} }, {}),
    }),
  );

  const storage = new CampaignStorage(join(dir, "campaigns.db"));
  const submitted: string[] = [];
  let tasks = 0;
  const taskManager = Object.assign(new EventEmitter(), {
    submit: (_chatId: string, _channel: string, prompt: string) => {
      submitted.push(prompt);
      tasks += 1;
      return { id: `task_${tasks}`, status: "executing", createdAt: Date.now(), updatedAt: Date.now() };
    },
    getStatus: () => null,
    findLatestLineageTask: () => null,
    findLineageRootId: (id: string) => id,
    isInLineage: (rootId: string, id: string) => rootId === id,
    priorProgressSummary: () => "",
    listTasks: () => [],
    listLiveInLineage: () => [],
    lineageHasDeliberateStop: () => false,
    resumeTask: () => null,
    cancel: () => {},
  });
  const plannerProvider = scriptedProvider("deepseek", [{ text: LADDER, usage: usage(1200, 340) }]);
  const styleProvider = scriptedProvider("deepseek", [{ text: STYLE, usage: usage(900, 120) }]);
  const manager = new CampaignManager({
    storage,
    planner: new CampaignPlanner(plannerProvider, { streamingEnabled: false }),
    styleAnalysis: new StyleAnalysis(styleProvider, { streamingEnabled: false }),
    taskManager: taskManager as unknown as TaskManager,
    messenger: async () => {},
    projectRoot: root,
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => daemon.close());
  cleanups.push(() => storage.close());
  cleanups.push(() => manager.dispose());
  return { manager, daemon, submitted, plannerProvider, styleProvider };
}

describe("a campaign's cost includes its campaign-level calls", () => {
  it("the style analysis and planning a real campaign start makes are booked to that campaign and counted by sumBudgetForCampaign", async () => {
    const h = build();

    const campaign = h.manager.startFromGdd({ chatId: "chat-1", channelType: "cli", userId: "owner-1" }, GDD, "docs/GDD.md");
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1), { timeout: 15_000 });

    const calls = h.plannerProvider.calls.length + h.styleProvider.calls.length;
    expect(h.plannerProvider.calls.length).toBeGreaterThan(0);
    expect(h.styleProvider.calls).toHaveLength(1);
    const rows = h.daemon
      .getDatabase()
      .prepare("SELECT trigger_name AS purpose, campaign_id AS campaignId FROM budget_entries ORDER BY id")
      .all() as Array<{ purpose: string; campaignId: string | null }>;
    // One row per provider call, every one of them this campaign's.
    expect(rows).toHaveLength(calls);
    expect(new Set(rows.map((r) => r.purpose))).toEqual(new Set(["style-analysis", "campaign-planning"]));
    expect(rows.every((r) => r.campaignId === campaign.id)).toBe(true);
    // …so the campaign's cost is what the ledger holds, not 0 entries.
    const cost = h.daemon.sumBudgetForCampaign(campaign.id);
    expect(cost.entries).toBe(calls);
    // At the cost model's price for exactly the calls the providers served.
    const priced =
      h.plannerProvider.calls.length * estimateCostWithCache(usage(1200, 340), "deepseek") + estimateCostWithCache(usage(900, 120), "deepseek");
    expect(priced).not.toBe(0);
    expect(cost.totalUsd).toBeCloseTo(priced, 12);
    expect(cost.totalUsd).toBeCloseTo(h.daemon.sumBudgetSince(0), 12);
  }, 30_000);
});
