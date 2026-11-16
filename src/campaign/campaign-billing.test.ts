/**
 * A campaign-level call is booked to the campaign it was made for (task #73).
 *
 * Measured before the fix: planning, the acceptance writer, visual conformance
 * and style analysis booked "chat" rows with no campaign_id, so the delivery
 * package's sumBudgetForCampaign never counted them. These tests drive the
 * real callers over scripted providers and the REAL process ledger, and read
 * the campaign each booked row names. Every game is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { campaignBilling, forCampaign, PLANNING_BILLING, STYLE_ANALYSIS_BILLING } from "./campaign-billing.js";
import { CampaignPlanner } from "./campaign-planner.js";
import { StyleAnalysis } from "../agents/style/style-analysis.js";
import { billedChat } from "../agents/providers/billed-call.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const OUTSIDE = "Campaign-level call made outside a campaign — its cost is booked to no campaign";
const MSG = [{ role: "user" as const, content: "Name one buoy." }];

let harness: UsageLedgerHarness;
beforeEach(() => {
  logger.warn.mockClear();
  harness = installUsageLedgerHarness();
});
afterEach(() => harness.uninstall());

describe("campaignBilling names the campaign in scope", () => {
  it("inside forCampaign the billing carries the campaign; outside it is the base, and that is logged", () => {
    expect(forCampaign("cmp_tide", () => campaignBilling(PLANNING_BILLING))).toEqual({ ...PLANNING_BILLING, campaignId: "cmp_tide" });
    expect(logger.warn).not.toHaveBeenCalledWith(OUTSIDE, expect.anything());

    expect(campaignBilling(PLANNING_BILLING)).toBe(PLANNING_BILLING);
    expect(logger.warn).toHaveBeenCalledWith(OUTSIDE, { purpose: "campaign-planning" });
  });

  it("two campaigns working at once each keep their own, across awaits", async () => {
    const seen = await Promise.all(
      ["cmp_tide", "cmp_reef"].map((id, i) =>
        forCampaign(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5 * (2 - i)));
          return campaignBilling(STYLE_ANALYSIS_BILLING).campaignId;
        }),
      ),
    );
    expect(seen).toEqual(["cmp_tide", "cmp_reef"]);
  });
});

describe("the process ledger writes the campaign on the row", () => {
  it("an ownerless call naming a campaign books its row with that campaignId; one naming none books none", async () => {
    await billedChat(scriptedProvider("deepseek", [{ text: "ok", usage: usage(800, 90) }]), { purpose: "campaign-planning", ownerless: "chat", campaignId: "cmp_tide" }, "s", MSG, []);
    await billedChat(scriptedProvider("deepseek", [{ text: "ok", usage: usage(800, 90) }]), { purpose: "session-summary", ownerless: "daemon" }, "s", MSG, []);

    expect(harness.booked).toHaveLength(2);
    expect(harness.booked[0]!.metadata).toMatchObject({ triggerName: "campaign-planning", campaignId: "cmp_tide" });
    expect(harness.booked[1]!.metadata.campaignId).toBeUndefined();
  });
});

const BUOY_GDD = [
  "# Tide Courier",
  "## Sailing",
  "The courier boat sails between buoys; its speed stays between 3 and 6 knots.",
  "## Storms",
  "A storm wave knocks one parcel overboard.",
].join("\n");

const LADDER = JSON.stringify({
  milestones: [
    { title: "Sail the buoys", prompt: "Build the courier boat's sailing between buoys with the speed band from the design.", coveredSections: ["Sailing"], deliverables: ["scene"] },
    { title: "Storm waves", prompt: "Add storm waves that knock one parcel overboard, and the parcel counter.", coveredSections: ["Storms"], deliverables: ["wave prefab"] },
  ],
  excluded: [],
});

describe("the real callers bill the campaign in scope", () => {
  it("a planner call inside forCampaign books its row to that campaign", async () => {
    const provider = scriptedProvider("deepseek", [{ text: LADDER, usage: usage(1200, 340) }]);

    await forCampaign("cmp_tide", () => new CampaignPlanner(provider, { streamingEnabled: false }).planMilestones(BUOY_GDD, "docs/gdd.md"));

    expect(harness.booked).toHaveLength(1);
    expect(harness.booked[0]!.metadata).toMatchObject({ triggerName: "campaign-planning", campaignId: "cmp_tide" });
  });

  it("a style analysis inside forCampaign books its row to that campaign", async () => {
    const style = JSON.stringify({ family: "painterly", pipeline: "sprite-native", proportions: { widthScale: 1, headScale: 1 }, palette: ["#204060", "#e0c080", "#f0f0f0"], outline: { width: 0, color: "#000000" }, shading: "flat", references: [], notes: "Watercolour sea." });
    const provider = scriptedProvider("deepseek", [{ text: style, usage: usage(900, 120) }]);

    await forCampaign("cmp_reef", () => new StyleAnalysis(provider, { streamingEnabled: false }).analyze(BUOY_GDD));

    expect(harness.booked).toHaveLength(1);
    expect(harness.booked[0]!.metadata).toMatchObject({ triggerName: "style-analysis", campaignId: "cmp_reef" });
  });
});
