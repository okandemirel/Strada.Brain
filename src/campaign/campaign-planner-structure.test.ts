/**
 * The planner returns structure — coveredSections and deliverables per
 * milestone, excluded items with the GDD's reason — and is asked once more
 * when it leaves a section of the document unclaimed.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { CampaignPlanner, plannerSystem, splitGddSections } from "./campaign-planner.js";
import { measureGddScope } from "./gdd-scope.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => { createLogger("error", "test.log"); });

const GDD = "# Kiln Yard\n## 1. Core Loop\nStack the fired bricks.\n## 2. Levels\nThere are 12 wards.\n## 3. Audio\nMusic and SFX for the kiln.\n";
const sprint = (title: string, sections: string[], prompt = "Build it end to end, compile green, PlayMode green unfiltered, capture a frame, commit per unit.") =>
  ({ title, prompt, coveredSections: sections, deliverables: [`${title} scene`] });

function fakeProvider(replies: string[]): { calls: string[]; systems: string[]; provider: unknown } {
  const calls: string[] = [];
  const systems: string[] = [];
  return {
    calls,
    systems,
    provider: {
      name: "fake",
      capabilities: { streaming: false },
      chat: async (system: string, messages: Array<{ content: string }>) => {
        systems.push(system);
        calls.push(String(messages[0]?.content ?? ""));
        return { text: replies[Math.min(calls.length - 1, replies.length - 1)]! };
      },
    },
  };
}

describe("plannerSystem", () => {
  it("is sized by the measured scope and names the non-code areas the GDD asks for", () => {
    const text = plannerSystem(measureGddScope(GDD));
    expect(text).toContain("3 to 7 milestones");
    expect(text).toContain("audio (music and SFX bound to AudioSources");
    expect(text).toContain('"coveredSections"');
    // What it must say, not what it must not: the capability is offered for
    // the case the document names, never as a pipeline of its own.
    expect(text).toContain("when the GDD wants 2D rendered from 3D");
  });
});

describe("CampaignPlanner.planMilestones", () => {
  it("returns the structure and asks once more for a section nobody claimed", async () => {
    const first = JSON.stringify({ milestones: [sprint("Sprint A — Foundations", ["1. Core Loop"]), sprint("Sprint B — Levels", ["2. Levels"]), sprint("Sprint C — Delivery", ["2. Levels"])], excluded: [] });
    const second = JSON.stringify({ milestones: [sprint("Sprint A — Foundations", ["1. Core Loop"]), sprint("Sprint B — Levels + audio", ["2. Levels", "3. Audio"]), sprint("Sprint C — Delivery", ["Kiln Yard"])], excluded: ["leaderboards: the GDD says none in v1"] });
    const fake = fakeProvider([first, second]);
    const planner = new CampaignPlanner(fake.provider as never);
    const ladder = await planner.planMilestones(GDD, "docs/GDD.md");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toContain('claimed no milestone for these GDD sections: "Kiln Yard", "3. Audio"');
    expect(ladder.milestones[1]!.coveredSections).toEqual(["2. Levels", "3. Audio"]);
    expect(ladder.milestones[1]!.deliverables).toEqual(["Sprint B — Levels + audio scene"]);
    expect(ladder.excluded).toEqual(["leaderboards: the GDD says none in v1"]);
    expect(ladder.uncoveredSections).toEqual([]);
    expect(ladder.totalSections).toBe(4);
    expect([ladder.minMilestones, ladder.maxMilestones]).toEqual([3, 7]);
  });

  it("names the GDD's path when it has one, and says there is none rather than inventing one (audit campaign#1)", async () => {
    const ladder = JSON.stringify({ milestones: [sprint("A", ["Kiln Yard", "1. Core Loop"]), sprint("B", ["2. Levels"]), sprint("C", ["3. Audio"])] });
    const onDisk = fakeProvider([ladder]);
    await new CampaignPlanner(onDisk.provider as never).planMilestones(GDD, "docs/KilnYard_GDD.md");
    expect(onDisk.calls[0]).toContain("GDD project-relative path: docs/KilnYard_GDD.md\n");
    const textOnly = fakeProvider([ladder]);
    await new CampaignPlanner(textOnly.provider as never).planMilestones(GDD, undefined);
    expect(textOnly.calls[0]).toContain("GDD project-relative path: none — this design is not saved in the project");
    expect(textOnly.calls[0]).not.toContain("undefined");
  });

  it("does not tell the planner to reference a path a text-only GDD does not have (review campaign-artifacts P3)", async () => {
    const ladder = JSON.stringify({ milestones: [sprint("A", ["Kiln Yard", "1. Core Loop"]), sprint("B", ["2. Levels"]), sprint("C", ["3. Audio"])] });
    const onDisk = fakeProvider([ladder]);
    await new CampaignPlanner(onDisk.provider as never).planMilestones(GDD, "docs/KilnYard_GDD.md");
    expect(onDisk.systems[0]).toContain("Reference the GDD by its project-relative path");
    const textOnly = fakeProvider([ladder]);
    await new CampaignPlanner(textOnly.provider as never).planMilestones(GDD, undefined);
    // The system prompt and the user line said opposite things.
    expect(textOnly.systems[0]).not.toContain("Reference the GDD by its project-relative path");
    expect(textOnly.systems[0]).toContain("NOT saved in the project");
    expect(textOnly.systems[0]).toContain("restate");
  });

  it("keeps the first ladder when the second round covers no more, and records what stays unclaimed", async () => {
    const first = JSON.stringify({ milestones: [sprint("A", ["1. Core Loop"]), sprint("B", ["2. Levels"]), sprint("C", ["2. Levels"])] });
    const worse = JSON.stringify({ milestones: [sprint("A", ["1. Core Loop"]), sprint("B", []), sprint("C", [])] });
    const fake = fakeProvider([first, worse]);
    const ladder = await new CampaignPlanner(fake.provider as never).planMilestones(GDD, "docs/GDD.md");
    expect(ladder.milestones.map((m) => m.title)).toEqual(["A", "B", "C"]);
    expect(ladder.uncoveredSections).toEqual(["Kiln Yard", "3. Audio"]);
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

describe("map-reduce planning of a document beyond the window (2026-09-10)", () => {
  const bigGdd = (): string => {
    const sections = ["1. Overview", "2. Core Loop", "3. Element schedule", "4. Levels", "5. Audio", "6. Art Direction"];
    return "# Epic\n" + sections.map((h, i) => `${h}\n` + `Section ${i} body: MARKER_${i} `.repeat(3_000) + "\n").join("\n");
  };

  it("splits at headings into bounded chunks and keeps every heading", () => {
    const chunks = splitGddSections(bigGdd(), 40_000, 16);
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    expect(chunks.every((c) => c.text.length <= 40_000)).toBe(true);
    expect(chunks.map((c) => c.heading).join(" | ")).toContain("3. Element schedule");
    expect(splitGddSections("# Tiny\nA short game.\n## Rules\nTap.")).toHaveLength(1);
  });

  it("cuts at a numbered heading that opens with a non-ASCII capital", () => {
    // With A-Z only, "23.2 Örtü Seçimi" and "33. Étagères" were body text of
    // the section before, and the add-only pass saw their rows under its heading.
    const gdd = ["23.1 Hazırlık", "Kapı her sabah açılır.", "23.2 Örtü Seçimi", "Bir somun 47 dakikada pişmelidir.", "33. Étagères", "La vitrine montre trois gâteaux."].join("\n");
    expect(splitGddSections(gdd).map((c) => c.heading)).toEqual(["23.1 Hazırlık + 23.2 Örtü Seçimi + 33. Étagères"]);
  });

  it("briefs every section with the model and plans from the briefs, never from a windowed middle", async () => {
    const gdd = bigGdd();
    expect(gdd.length).toBeGreaterThan(150_000);
    const briefCalls: string[] = [];
    let planCall = "";
    const provider = {
      name: "fake",
      capabilities: { streaming: false },
      chat: async (system: string, messages: Array<{ content: string }>) => {
        const content = String(messages[0]?.content ?? "");
        if (system.startsWith("You brief a planner")) {
          briefCalls.push(content);
          const m = /MARKER_(\d)/.exec(content);
          return { text: `BRIEF for section ${m?.[1] ?? "?"}: elements and rules.` };
        }
        planCall = content;
        return { text: JSON.stringify({ milestones: [sprint("A", ["1. Overview", "2. Core Loop", "3. Element schedule", "4. Levels", "5. Audio", "6. Art Direction", "Epic"]), sprint("B", []), sprint("C", [])] }) };
      },
    };
    const ladder = await new CampaignPlanner(provider as never).planMilestones(gdd, "docs/GDD.md");
    expect(briefCalls.length).toBeGreaterThanOrEqual(6);
    expect(planCall).toContain("briefed section by section");
    for (let i = 0; i < 6; i++) expect(planCall).toContain(`BRIEF for section ${i}`);
    // The raw filler never reaches the planner; the briefs do.
    expect(planCall).not.toContain("MARKER_3 MARKER_3");
    expect(planCall.length).toBeLessThan(20_000);
    expect(ladder.uncoveredSections).toEqual([]);
  });

  it("a section whose brief fails is represented by its outline and counted, never dropped", async () => {
    let calls = 0;
    const provider = {
      name: "fake",
      capabilities: { streaming: false },
      chat: async (system: string, messages: Array<{ content: string }>) => {
        if (system.startsWith("You brief a planner")) {
          calls++;
          if (calls === 2) throw new Error("provider blink");
          return { text: "BRIEF." };
        }
        return { text: JSON.stringify({ milestones: [sprint("A", []), sprint("B", []), sprint("C", [])] }) };
      },
    };
    const planner = new CampaignPlanner(provider as never);
    const planning = await planner.gddForPlanning(bigGdd());
    expect(planning.briefed).toBe(true);
    expect(planning.failed).toBe(1);
    expect(planning.text).toContain("1 represented by outline only (brief failed)");
    expect(planning.text).toContain("[brief could not be made — structural outline follows]");
  });
});
