/**
 * Every planning call bills the campaign's spend (task #71).
 *
 * Measured before the fix: CampaignPlanner.ask() read only the reply's text,
 * so a ladder, a section brief or a coverage resolution consumed tokens that
 * reached no cost ledger, no daily wall and no /api/metrics counter. These
 * tests drive the REAL planner over a scripted provider and the REAL process
 * ledger, and compare what the provider billed with what the counters and the
 * cost ledger hold. Every game is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignPlanner, splitGddSections } from "./campaign-planner.js";
import { installUsageLedgerHarness, scriptedProvider, usage, type UsageLedgerHarness } from "../tests/helpers/usage-ledger-harness.js";
import { expectBilledAsCampaignWork, UNMEASURED_WARNING } from "../tests/helpers/campaign-billing-assertions.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const PURPOSE = "campaign-planning";
const PROVIDER = "deepseek";

let harness: UsageLedgerHarness;
beforeEach(() => {
  logger.warn.mockClear();
  harness = installUsageLedgerHarness();
});
afterEach(() => harness.uninstall());

/** A GDD about a moth gliding between lanterns, small enough to be planned whole. */
const SMALL_GDD = [
  "# Lantern Moth",
  "## Gliding",
  "The moth glides between lanterns; glide speed stays between 2 and 4 m/s.",
  "## Hazards",
  "The moth loses one life when it touches a thorn.",
].join("\n");

/** The same invented game, long enough (past the whole-document window) to be briefed section by section. */
function longGdd(sections: number): string {
  return Array.from({ length: sections }, (_, i) =>
    [`## Lantern Garden ${i + 1}`, `Garden ${i + 1} holds ${i + 3} lanterns. ${"The moth rests on a lit lantern to refill its wings. ".repeat(900)}`].join("\n"),
  ).join("\n\n");
}

const LADDER = JSON.stringify({
  milestones: [
    {
      title: "Glide and land",
      prompt: "Build the moth's glide between lanterns, with landing on a lantern and the speed band from the design.",
      coveredSections: ["Gliding"],
      deliverables: ["scene", "moth prefab"],
    },
    {
      title: "Thorns and lives",
      prompt: "Add thorn hazards that take one life on touch, the life counter and the game-over screen.",
      coveredSections: ["Hazards"],
      deliverables: ["thorn prefab"],
    },
  ],
  excluded: [],
});

describe("campaign planning bills the campaign's spend", () => {
  it("a ladder call books its tokens once: counters and one cost row, source chat, trigger campaign-planning", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: LADDER, usage: usage(1200, 340) }], { streaming: true });

    const ladder = await new CampaignPlanner(provider).planMilestones(SMALL_GDD, "docs/gdd.md");

    expect(ladder.milestones).toHaveLength(2);
    expect(provider.calls).toHaveLength(1);
    expectBilledAsCampaignWork(harness, { purpose: PURPOSE, provider: PROVIDER, calls: [{ inputTokens: 1200, outputTokens: 340 }] });
  });

  it("with STREAMING_ENABLED=false the chat() path bills the same way", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: LADDER, usage: usage(1500, 410) }]);

    await new CampaignPlanner(provider, { streamingEnabled: false }).planMilestones(SMALL_GDD, "docs/gdd.md");

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(provider.calls).toHaveLength(1);
    expectBilledAsCampaignWork(harness, { purpose: PURPOSE, provider: PROVIDER, calls: [{ inputTokens: 1500, outputTokens: 410 }] });
  });

  it("briefing a long document bills one row per section call, whatever each reply cost", async () => {
    const gdd = longGdd(4);
    expect(gdd.length).toBeGreaterThan(150_000);
    const expectedCalls = splitGddSections(gdd).length;
    expect(expectedCalls).toBeGreaterThan(1);
    // Each brief reports a different cost, so a row booked from the wrong reply shows.
    const replies = Array.from({ length: expectedCalls }, (_, i) => ({ text: `Brief ${i}: lanterns and wings.`, usage: usage(900 + i * 10, 80 + i) }));
    const provider = scriptedProvider(PROVIDER, replies);

    const planned = await new CampaignPlanner(provider, { streamingEnabled: false }).gddForPlanning(gdd);

    expect(planned.briefed).toBe(true);
    expect(provider.calls).toHaveLength(expectedCalls);
    expectBilledAsCampaignWork(harness, {
      purpose: PURPOSE,
      provider: PROVIDER,
      calls: replies.map((r) => ({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens })),
    });
  });

  it("two planner methods on one planner bill every call between them (complete, then the briefs)", async () => {
    const gdd = longGdd(4);
    const sections = splitGddSections(gdd).length;
    const replies = [
      { text: "A plain answer.", usage: usage(100, 20) },
      ...Array.from({ length: sections }, () => ({ text: "A brief.", usage: usage(700, 60) })),
    ];
    const provider = scriptedProvider(PROVIDER, replies);
    const planner = new CampaignPlanner(provider, { streamingEnabled: false });

    await planner.complete("You answer plainly.", "Name one lantern.");
    await planner.gddForPlanning(gdd);

    expect(provider.calls).toHaveLength(1 + sections);
    expectBilledAsCampaignWork(harness, {
      purpose: PURPOSE,
      provider: PROVIDER,
      calls: replies.map((r) => ({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens })),
    });
  });

  it("a reply with no usage books nothing, counts nothing, and says it was not measured", async () => {
    const provider = scriptedProvider(PROVIDER, [{ text: "A plain answer." }], { streaming: true });

    const text = await new CampaignPlanner(provider).complete("You answer plainly.", "Name one lantern.");

    expect(text).toBe("A plain answer.");
    expect(provider.calls).toHaveLength(1);
    expect(harness.booked).toEqual([]);
    expect(harness.counted()).toEqual({ input: 0, output: 0, dailyTokens: 0 });
    expect(logger.warn).toHaveBeenCalledWith(UNMEASURED_WARNING, expect.objectContaining({ purpose: PURPOSE }));
  });
});
