import { describe, expect, it } from "vitest";

import { completionOmitsNamedDeliverables } from "./completion-review.js";

// The task below has the shape of a continuation prompt measured on a live run,
// with invented content: this is the case the check exists for.
const TASK = [
  "Continue building the greenhouse described in Greenhouse_Brief.docx.",
  "",
  "The brief asks for things the project still does not have:",
  "- Pollen bursts: 0 files. Build them as the brief describes.",
  "- Wilt condition: 0 files. A greenhouse where nothing can wilt is not the one in the brief.",
  "- Graft pairing and a per-bed harvest check: beds have data and no way to grow one through.",
  "- A PlayMode test that grows a seedling to harvest, and one that lets it wilt.",
].join("\n");

describe("completionOmitsNamedDeliverables", () => {
  it("names the deliverables a completion claim walked past", () => {
    const draft = "Done. The wilt condition is implemented and graft pairing works.";

    const missing = completionOmitsNamedDeliverables(TASK, draft);

    expect(missing).toContain("Pollen bursts");
    expect(missing.some((m) => m.includes("PlayMode test"))).toBe(true);
    expect(missing).not.toContain("Wilt condition");
  });

  it("stays silent when every deliverable is accounted for", () => {
    const draft = [
      "Done. Pollen bursts are in, the wilt condition fires when a bed dries out,",
      "graft pairing feeds the harvest check, and the PlayMode tests grow a seedling",
      "to harvest and let one wilt.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("accepts a deliverable that is named and reported blocked", () => {
    const draft = [
      "Done with what I could reach. Pollen bursts, the wilt condition and graft pairing are in.",
      "The PlayMode test could not run: the test assembly does not build on this machine.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not fire on a draft that never claims completion", () => {
    const draft = "Starting on the irrigation module now; nothing is finished yet.";

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not fire on a task that lists nothing", () => {
    const draft = "Done. Fixed the compile error.";

    expect(completionOmitsNamedDeliverables("Fix the compile error in Seedbed.cs.", draft)).toEqual([]);
  });

  it("treats pollen-bursts, pollen bursts and pollenbursts as the same word", () => {
    const spellings = ["pollen-bursts", "pollen bursts", "pollenbursts", "PollenBursts"];

    for (const spelling of spellings) {
      const draft = `Done. ${spelling}, the wilt condition, graft pairing and the PlayMode tests are all in.`;
      expect(completionOmitsNamedDeliverables(TASK, draft), spelling).toEqual([]);
    }
  });

  it("needs two listed deliverables before it objects to anything", () => {
    const oneItem = "Build the greenhouse.\n- Pollen bursts: 0 files. Build them.";

    expect(completionOmitsNamedDeliverables(oneItem, "Done. Fixed the build.")).toEqual([]);
  });

  it("reads \"Play Mode\" as the PlayMode deliverable", () => {
    // Unity spells it both ways; a draft that used the other spelling was not silent.
    const draft = [
      "Done. Pollen bursts, the wilt condition and graft pairing are in,",
      "and the Play Mode tests grow a seedling to harvest and let one wilt.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not quote a sentence fragment back as if it were a name", () => {
    const task = [
      "- Blight has types but is not wired into watering.",
      "- A PlayMode test that grows a seedling to harvest.",
    ].join("\n");

    const missing = completionOmitsNamedDeliverables(task, "Done. Everything builds.");

    expect(missing).toEqual(["Blight has types", "A PlayMode test"]);
  });
});
