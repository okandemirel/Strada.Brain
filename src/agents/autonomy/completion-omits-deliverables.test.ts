import { describe, expect, it } from "vitest";

import { completionOmitsNamedDeliverables } from "./completion-review.js";

// The task text below is run 20's actual prompt: this is the case the check exists for.
const TASK = [
  "Continue building the game described in PixelFlow_GDD.docx.",
  "",
  "The document asks for things the project still does not have:",
  "- Power-ups: 0 files. Implement them as the GDD specifies.",
  "- Lose condition: 0 files. A game you cannot lose is not the game in the document.",
  "- Level progression and a per-level win check: levels have data and no way to play one through.",
  "- A PlayMode test that plays a level to a win, and one that plays it to a loss.",
].join("\n");

describe("completionOmitsNamedDeliverables", () => {
  it("names the deliverables a completion claim walked past", () => {
    const draft = "Done. The lose condition is implemented and level progression works.";

    const missing = completionOmitsNamedDeliverables(TASK, draft);

    expect(missing).toContain("Power-ups");
    expect(missing.some((m) => m.includes("PlayMode test"))).toBe(true);
    expect(missing).not.toContain("Lose condition");
  });

  it("stays silent when every deliverable is accounted for", () => {
    const draft = [
      "Done. Power-ups are in, the lose condition fires on the last move,",
      "level progression advances on a win check, and the PlayMode tests play a level",
      "to a win and to a loss.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("accepts a deliverable that is named and reported blocked", () => {
    const draft = [
      "Done with what I could reach. Power-ups, the lose condition and level progression are in.",
      "The PlayMode test could not run: the test assembly does not build on this machine.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not fire on a draft that never claims completion", () => {
    const draft = "Starting on the board module now; nothing is finished yet.";

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not fire on a task that lists nothing", () => {
    const draft = "Done. Fixed the compile error.";

    expect(completionOmitsNamedDeliverables("Fix the compile error in Board.cs.", draft)).toEqual([]);
  });

  it("treats power-ups, power ups and powerups as the same word", () => {
    const spellings = ["power-ups", "power ups", "powerups", "PowerUps"];

    for (const spelling of spellings) {
      const draft = `Done. ${spelling}, the lose condition, level progression and the PlayMode tests are all in.`;
      expect(completionOmitsNamedDeliverables(TASK, draft), spelling).toEqual([]);
    }
  });

  it("needs two listed deliverables before it objects to anything", () => {
    const oneItem = "Build the game.\n- Power-ups: 0 files. Implement them.";

    expect(completionOmitsNamedDeliverables(oneItem, "Done. Fixed the build.")).toEqual([]);
  });

  it("reads \"Play Mode\" as the PlayMode deliverable", () => {
    // Unity spells it both ways; a draft that used the other spelling was not silent.
    const draft = [
      "Done. Power-ups, the lose condition and level progression are in,",
      "and the Play Mode tests play a level to a win and to a loss.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not quote a sentence fragment back as if it were a name", () => {
    const task = [
      "- Combo has types but is not wired into scoring.",
      "- A PlayMode test that plays a level to a win.",
    ].join("\n");

    const missing = completionOmitsNamedDeliverables(task, "Done. Everything builds.");

    expect(missing).toEqual(["Combo has types", "A PlayMode test"]);
  });
});
