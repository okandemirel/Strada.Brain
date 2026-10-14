import { describe, expect, it } from "vitest";

import { completionOmitsNamedDeliverables } from "./completion-review.js";

// A task that lists its open deliverables: the case the check exists for.
// Invented content.
const TASK = [
  "Finish the hilltop weather-station simulator; Station_Spec.md is the reference.",
  "",
  "Open items from the last review:",
  "1. A PlayMode test that runs a storm front past the station and checks the logged gusts.",
  "2. WindVane: 0 files. Wind direction is never sampled.",
  "3. Barometer drift: readings are taken once at start-up and never corrected.",
  "4. Uplink retry with backoff after the modem drops its link.",
  "5. Solar charge model: the battery level is a constant.",
].join("\n");

describe("completionOmitsNamedDeliverables", () => {
  it("names the deliverables a completion claim walked past", () => {
    const draft = "Done. Barometer drift is corrected every ten minutes and the uplink backoff doubles per retry.";

    const missing = completionOmitsNamedDeliverables(TASK, draft);

    expect(missing).toContain("WindVane");
    expect(missing).toContain("Solar charge model");
    expect(missing.some((m) => m.includes("PlayMode test"))).toBe(true);
    expect(missing).not.toContain("Barometer drift");
    expect(missing).not.toContain("Uplink retry with backoff");
  });

  it("stays silent when every deliverable is accounted for", () => {
    const draft = [
      "Done. The WindVane driver samples direction once a second, barometer drift is corrected",
      "against the reference sensor, the uplink retries with backoff, the solar charge model drains",
      "the battery overnight, and a PlayMode test runs a storm front past the station.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("accepts a deliverable that is named and reported blocked", () => {
    const draft = [
      "Done with what I could reach: the WindVane driver, barometer drift, uplink backoff and the solar",
      "charge model are in. The PlayMode test is blocked: the simulator scene will not load in batch mode here.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not fire on a draft that never claims completion", () => {
    const draft = "Wiring the anemometer next; no item on the list is closed yet.";

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not fire on a task that lists nothing", () => {
    const draft = "Done. Fixed the compile error.";

    expect(completionOmitsNamedDeliverables("Fix the compile error in Anemometer.cs.", draft)).toEqual([]);
  });

  it("treats wind-vane, wind vane and WindVane as the same word", () => {
    const spellings = ["wind-vane", "wind vane", "windvane", "WindVane", "Wind Vane"];

    for (const spelling of spellings) {
      const draft = `Done. The ${spelling} driver, barometer drift, uplink backoff, the solar charge model and the PlayMode test are all in.`;
      expect(completionOmitsNamedDeliverables(TASK, draft), spelling).toEqual([]);
    }
  });

  it("needs two listed deliverables before it objects to anything", () => {
    const oneItem = "Finish the station.\n- WindVane: 0 files. Sample the wind direction.";

    expect(completionOmitsNamedDeliverables(oneItem, "Done. Fixed the build.")).toEqual([]);
  });

  it("reads \"Play Mode\" as the PlayMode deliverable", () => {
    // Unity spells it both ways; a draft that used the other spelling was not silent.
    const draft = [
      "Done. The WindVane driver, barometer drift, uplink backoff and the solar charge model are in,",
      "and the Play Mode test runs a storm front past the station.",
    ].join(" ");

    expect(completionOmitsNamedDeliverables(TASK, draft)).toEqual([]);
  });

  it("does not quote a sentence fragment back as if it were a name", () => {
    const task = [
      "- Tide tables load but never reach the chart view.",
      "- A PlayMode test that plots one full tide cycle.",
    ].join("\n");

    const missing = completionOmitsNamedDeliverables(task, "Done. Everything builds.");

    expect(missing).toEqual(["Tide tables load", "A PlayMode test"]);
  });
});
