/**
 * The planner returns structure — coveredSections and deliverables per
 * milestone, excluded items with the GDD's reason — and is asked once more
 * when it leaves a section of the document unclaimed.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { CampaignPlanner, plannerSystem } from "./campaign-planner.js";
import { measureGddScope } from "./gdd-scope.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => { createLogger("error", "test.log"); });

const GDD = "# Pigs\n## 1. Core Loop\nMerge pigs.\n## 2. Levels\nThere are 30 levels.\n## 3. Audio\nMusic and SFX for merge.\n";
const sprint = (title: string, sections: string[], prompt = "Build it end to end, compile green, PlayMode green unfiltered, capture a frame, commit per unit.") =>
  ({ title, prompt, coveredSections: sections, deliverables: [`${title} scene`] });

function fakeProvider(replies: string[]): { calls: string[]; provider: unknown } {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      name: "fake",
      capabilities: { streaming: false },
      chat: async (_system: string, messages: Array<{ content: string }>) => {
        calls.push(String(messages[0]?.content ?? ""));
        return { text: replies[Math.min(calls.length - 1, replies.length - 1)]! };
      },
    },
  };
}

describe("plannerSystem", () => {
  it("is sized by the measured scope and names the non-code areas the GDD asks for", () => {
    const text = plannerSystem(measureGddScope(GDD));
    expect(text).toContain("4 to 8 milestones");
    expect(text).toContain("audio (music and SFX bound to AudioSources");
    expect(text).toContain('"coveredSections"');
    expect(text).not.toContain("prerendered-character pipeline");
  });
});

describe("CampaignPlanner.planMilestones", () => {
  it("returns the structure and asks once more for a section nobody claimed", async () => {
    const first = JSON.stringify({ milestones: [sprint("Sprint A — Foundations", ["1. Core Loop"]), sprint("Sprint B — Levels", ["2. Levels"]), sprint("Sprint C — Delivery", ["2. Levels"])], excluded: [] });
    const second = JSON.stringify({ milestones: [sprint("Sprint A — Foundations", ["1. Core Loop"]), sprint("Sprint B — Levels + audio", ["2. Levels", "3. Audio"]), sprint("Sprint C — Delivery", ["Pigs"])], excluded: ["leaderboards: the GDD says none in v1"] });
    const fake = fakeProvider([first, second]);
    const planner = new CampaignPlanner(fake.provider as never);
    const ladder = await planner.planMilestones(GDD, "docs/GDD.md");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toContain('claimed no milestone for these GDD sections: "Pigs", "3. Audio"');
    expect(ladder.milestones[1]!.coveredSections).toEqual(["2. Levels", "3. Audio"]);
    expect(ladder.milestones[1]!.deliverables).toEqual(["Sprint B — Levels + audio scene"]);
    expect(ladder.excluded).toEqual(["leaderboards: the GDD says none in v1"]);
    expect(ladder.uncoveredSections).toEqual([]);
    expect(ladder.totalSections).toBe(4);
    expect([ladder.minMilestones, ladder.maxMilestones]).toEqual([4, 8]);
  });

  it("keeps the first ladder when the second round covers no more, and records what stays unclaimed", async () => {
    const first = JSON.stringify({ milestones: [sprint("A", ["1. Core Loop"]), sprint("B", ["2. Levels"]), sprint("C", ["2. Levels"])] });
    const worse = JSON.stringify({ milestones: [sprint("A", ["1. Core Loop"]), sprint("B", []), sprint("C", [])] });
    const fake = fakeProvider([first, worse]);
    const ladder = await new CampaignPlanner(fake.provider as never).planMilestones(GDD, "docs/GDD.md");
    expect(ladder.milestones.map((m) => m.title)).toEqual(["A", "B", "C"]);
    expect(ladder.uncoveredSections).toEqual(["Pigs", "3. Audio"]);
  });

  it("a ladder without the new fields still validates (defaults), so an older model reply is not a failed campaign", async () => {
    const bare = JSON.stringify({ milestones: [{ title: "A", prompt: "Build the foundations, compile green, PlayMode green unfiltered, capture a frame." }, { title: "B", prompt: "Build the rest, full suite green unfiltered, DELIVERY REPORT with captured frame." }] });
    const fake = fakeProvider([bare, bare]);
    const ladder = await new CampaignPlanner(fake.provider as never).planMilestones(GDD, "docs/GDD.md");
    expect(ladder.milestones[0]!.coveredSections).toEqual([]);
    expect(ladder.excluded).toEqual([]);
    expect(ladder.uncoveredSections).toHaveLength(4);
  });
});
