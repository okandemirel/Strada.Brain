import { describe, it, expect } from "vitest";
import { extractScheduledElements, extractFlattenedSchedule, elementCodeTokens, assessSpecScope, findDesignDoc, scheduleLooksPresent, stripCsComments } from "./spec-scope.js";

const GDD_SNIPPET = `
## Cave features

| Stage | Feature | Effect |
|-------|---------|--------|
| Cave 2 | Gas Vent | Pushes the drone upward |
| Cave 5 | Crystal Seam | Reveals the map nearby |
| Cave 9 | Rockfall | Closes a passage after a delay |
| Cave 12 | Drill & Anchor | Holds the drone against a draught |
`;

describe("spec scope — the design document is the checklist", () => {
  it("word-prefixed unlocks are read, a staffing table is not a schedule, strings survive comment stripping (Codex 2026-09-11 C#29, C#30)", () => {
    const gdd = [
      "| Stage | Feature | Notes |",
      "| --- | --- | --- |",
      "| Cave 7 | Gas Vent | lifts |",
      "| Chapter 1 | Glow Moss | lights |",
    ].join("\n");
    expect(extractScheduledElements(gdd).map((e) => e.name)).toEqual(["Gas Vent", "Glow Moss"]);
    // A staffing table is not a game schedule.
    const staffing = ["| # | Who | Role |", "| --- | --- | --- |", "| 1 | Alice (producer) | plans |"].join("\n");
    expect(extractScheduledElements(staffing)).toEqual([]);
    // A string containing "//" does not swallow the rest of the file…
    expect(stripCsComments('class C { string separator="//"; void GasVent() {} }')).toContain("GasVent");
    // …and a comment after a label is still a comment.
    expect(stripCsComments("void M() { retry:// TODO GasVent\n }")).not.toContain("GasVent");
  });

  it("an unlock id in any shape, and a comment is not an implementation (Codex 2026-09-11 B#18)", () => {
    const gdd = [
      "| Stage | Feature | Notes |",
      "| --- | --- | --- |",
      "| 7 | Teleporter | bends the path |",
      "| E3 | Magnet | pulls items |",
      "| W1-2 | Springboard | launches |",
    ].join("\n");
    expect(extractScheduledElements(gdd).map((e) => e.name)).toEqual(["Teleporter", "Magnet", "Springboard"]);
    expect(stripCsComments("// TODO Teleporter Magnet\nclass A { /* Springboard */ int x; }")).not.toContain("Teleporter");
    expect(stripCsComments("class Teleporter { }")).toContain("Teleporter");
  });

  it("extracts the element schedule from a GDD-style table", () => {
    const els = extractScheduledElements(GDD_SNIPPET);
    expect(els.map((e) => e.name)).toEqual(["Gas Vent", "Crystal Seam", "Rockfall", "Drill & Anchor"]);
    expect(els[0]?.unlock).toBe("Cave 2");
  });

  it("builds code-token shapes an implementation might use", () => {
    expect(elementCodeTokens("Crystal Seam")).toContain("CrystalSeam");
    expect(elementCodeTokens("Drill & Anchor")).toContain("DrillAnchor");
  });

  it("names scheduled elements missing from Assets code", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const root = mkdtempSync(join(tmpdir(), "spec-scope-"));
    try {
      const docs = join(root, "docs");
      mkdirSync(docs, { recursive: true });
      const gdd = join(docs, "GDD.md");
      writeFileSync(gdd, GDD_SNIPPET + "\n# rest of a large document\n" + "x".repeat(500));
      const scripts = join(root, "Assets", "Modules", "M", "Scripts");
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(scripts, "CrystalSeam.cs"), "public class CrystalSeam {}");

      const report = assessSpecScope(root);
      expect(report.scheduled).toBe(4);
      expect(report.missing.map((m) => m.name)).toEqual(["Gas Vent", "Rockfall", "Drill & Anchor"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("findDesignDoc runs in this ESM module", () => {
  // Measured 2026-09-07 14:58: three require("node:fs") calls inside
  // try/catch returned null/[] under ESM, so the scheduled-elements gate
  // never saw the GDD — probe on the real project: null before, the GDD
  // path after.
  it("finds docs/<Name>_GDD.md", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "spec-scope-"));
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "Game_GDD.md"), "# GDD\n\nFeature list: vents, seams");
      expect(findDesignDoc(root)).toBe(join(root, "docs", "Game_GDD.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("short element names count as whole words (measured 2026-09-10: a 4-letter element with its own class reported missing)", () => {
  it("finds a 4-letter element as an identifier and not inside another word", async () => {
    const { assessSpecScope } = await import("./spec-scope.js");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "spec-scope-short-"));
    try {
      mkdirSync(join(root, "docs"));
      mkdirSync(join(root, "Assets"));
      writeFileSync(join(root, "docs", "GDD.md"), "| L1 | Moss |\n| L2 | Vent |\n| L3 | Seam |\n");
      writeFileSync(join(root, "Assets", "A.cs"), "public class Moss {} // eventually\nclass Seam {}\n");
      const report = assessSpecScope(root, join(root, "docs", "GDD.md"));
      expect(report.scheduled).toBe(3);
      expect(report.missing.map((m) => m.name)).toEqual(["Vent"]); // "eventually" is not Vent
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A schedule table that lost its pipes. Measured by Codex 2026-09-12 (W#12)
 * on the real vehicle document: its whole element schedule read as ZERO
 * scheduled elements, because a document converted out of Google Docs
 * arrives as one cell per LINE. Zero suppresses the coverage check entirely,
 * so none of that content was ever compared to the code.
 */
describe("a flattened schedule table (Codex 2026-09-12 W#12)", () => {
  const flattened = [
    "Cave features",
    "Stage",
    "Feature",
    "Effect",
    "Cave 2",
    "Gas Vent",
    "Pushes the drone upward",
    "Cave 5",
    "Crystal Seam",
    "Reveals the map nearby",
    "Cave 9",
    "Rockfall",
    "Closes a passage after a delay",
    "",
    "Drone upgrades",
    "The battery grows after every completed survey.",
  ].join("\n");

  it("reads the rows a converter flattened, with the right column for each", () => {
    expect(extractScheduledElements(flattened)).toEqual([
      { unlock: "Cave 2", name: "Gas Vent" },
      { unlock: "Cave 5", name: "Crystal Seam" },
      { unlock: "Cave 9", name: "Rockfall" },
    ]);
  });

  it("stops at the end of the table and does not invent elements from prose", () => {
    const after = `${flattened}\nCave 99\nnot a table row at all — this is a sentence about Cave 99.`;
    expect(extractScheduledElements(after).map((e) => e.name)).toEqual([
      "Gas Vent",
      "Crystal Seam",
      "Rockfall",
    ]);
    // A document with no schedule still yields none.
    expect(extractScheduledElements("# GDD\n\nA puzzle game with 12 levels.")).toEqual([]);
    // …and a staffing table is still not a schedule.
    expect(
      extractScheduledElements(["Stage", "Feature", "Owner", "Cave 1", "Ada Lovelace (designer)", "art"].join("\n")),
    ).toEqual([]);
  });

  it("still reads an ordinary pipe table", () => {
    expect(extractScheduledElements(GDD_SNIPPET).map((e) => e.name)).toEqual([
      "Gas Vent",
      "Crystal Seam",
      "Rockfall",
      "Drill & Anchor",
    ]);
  });
});

/**
 * A false refusal measured on the test vehicle (Codex 2026-09-12 Y): names
 * carrying a note in parentheses produced only the annotated spellings, so a
 * project whose code used the plain name was reported as missing the
 * elements it had implemented.
 */
describe("a parenthetical is an annotation, not part of the name (Codex 2026-09-12 Y)", () => {
  it("offers the name without its notes as well as with them", () => {
    expect(elementCodeTokens("Survey (v2) Beacon")).toEqual(
      expect.arrayContaining(["SurveyV2Beacon", "SurveyBeacon", "surveybeacon"]),
    );
    expect(elementCodeTokens("Rockfall (timed)")).toEqual(expect.arrayContaining(["Rockfall", "rockfall", "RockfallTimed"]));
    expect(elementCodeTokens("Gas Vent (rare; see notes)")).toEqual(expect.arrayContaining(["GasVent", "gasvent"]));
    // A name with no annotation is unchanged.
    expect(elementCodeTokens("Crystal Seam")).toEqual(["CrystalSeam", "crystalseam"]);
    expect(elementCodeTokens("Drill & Anchor")).toEqual(["DrillAnchor", "drillanchor"]);
  });
});

/**
 * A token two elements SHARE proves neither: "Gate (one-way)" and "Gate
 * (two-way)" both strip to "Gate", so a single `class Gate` covered both
 * scheduled variants (Codex 2026-09-12 Z#8).
 */
describe("a shared stripped name covers no variant (Codex 2026-09-12 Z#8)", () => {
  const project = (gdd: string, code: string): string => {
    const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const root = mkdtempSync(join(tmpdir(), "spec-scope-shared-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "GDD.md"), gdd + "\n# rest of a large document\n" + "x".repeat(500));
    const scripts = join(root, "Assets", "Modules", "M", "Scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "Code.cs"), code);
    return root;
  };
  const twoGates =
    "\n## Cave features\n\n" +
    "| Stage | Feature | Effect |\n|---|---|---|\n| Cave 1 | Gate (one-way) | in only |\n| Cave 2 | Gate (two-way) | both |\n";

  it("reports both variants missing when only the shared name exists", () => {
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    const root = project(twoGates, "public sealed class Gate {}");
    try {
      const report = assessSpecScope(root);
      expect(report.scheduled).toBe(2);
      expect(report.missing.map((m) => m.name)).toEqual(["Gate (one-way)", "Gate (two-way)"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts each variant's own spelling", () => {
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    const root = project(twoGates, "public class GateOneWay {}\npublic class GateTwoWay {}");
    try {
      expect(assessSpecScope(root).missing).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The other shapes a document converter produces. Codex ran each of these
 * against the reader (2026-09-12 Y#4): blank-separated cells, a reversed
 * column order and tab-separated rows all read as NO scheduled elements, and
 * zero suppresses the coverage check entirely.
 */
describe("every flattened shape, and saying when a schedule cannot be read (Codex 2026-09-12 Y#4)", () => {
  const shapes: Array<[string, string]> = [
    ["one cell per line", "Stage\nFeature\nEffect\nCave 1\nVent\nPushes"],
    ["a blank line between cells", "Stage\n\nFeature\n\nEffect\n\nCave 1\n\nVent\n\nPushes"],
    ["the element column first", "Feature\nStage\nEffect\nVent\nCave 1\nPushes"],
    ["tab-separated rows", "Stage\tFeature\tEffect\nCave 1\tVent\tPushes"],
    // Two columns, and five: the width is whatever makes the rows line up,
    // not a number this reader assumes.
    ["two columns", "Stage\nFeature\nCave 1\nVent"],
    ["five columns", "Stage\nFeature\nEffect\nArt\nSound\nCave 1\nVent\nPushes\nvent.png\nhiss.wav"],
    // Two shapes AT ONCE: each worked alone and they failed together, because
    // the header walk stepped straight into a blank (Codex 2026-09-12 AB J2.5).
    ["the element column first AND blank-separated", "Feature\n\nStage\n\nEffect\n\nVent\n\nCave 1\n\nPushes"],
  ];

  it("reads the schedule in each of them", () => {
    for (const [name, doc] of shapes) {
      expect(extractScheduledElements(doc), name).toEqual([{ unlock: "Cave 1", name: "Vent" }]);
      expect(scheduleLooksPresent(doc), name).toBe(true);
    }
  });

  it("a blank line between ROWS is a separator, not the end of the table", () => {
    // It ended the parse, so every later row vanished from coverage — and the
    // rows already read certified the schedule as complete (Codex 2026-09-12
    // AB J2.6).
    const withSeparators = "Stage\nFeature\nEffect\nCave 1\nVent\nPushes\n\nCave 2\nMoss\nGlows";
    expect(extractScheduledElements(withSeparators)).toEqual([
      { unlock: "Cave 1", name: "Vent" },
      { unlock: "Cave 2", name: "Moss" },
    ]);
  });

  it("the coverage report says a schedule was present but unreadable", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const root = mkdtempSync(join(tmpdir(), "spec-scope-unreadable-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(
        join(root, "docs", "GDD.md"),
        "## Cave features\n\nStage\nFeature\nEffect\nthe rows of this table were lost in conversion.\n" + "x".repeat(500),
      );
      const report = assessSpecScope(root);
      expect(report.scheduled).toBe(0);
      expect(report.scheduleUnreadable).toBe(true);
      // …and a document with no schedule at all says nothing of the kind.
      writeFileSync(join(root, "docs", "GDD.md"), "# GDD\n\nA puzzle game with 12 levels.\n" + "x".repeat(500));
      expect(assessSpecScope(root).scheduleUnreadable).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says a schedule is PRESENT even when its rows cannot be read, and absent when there is none", () => {
    // A header this reader recognizes with rows it cannot parse: the caller
    // must not read zero elements as "the document schedules nothing".
    const unreadable = "Stage\nFeature\nEffect\nthe rows of this table were lost in conversion.";
    expect(extractScheduledElements(unreadable)).toEqual([]);
    expect(scheduleLooksPresent(unreadable)).toBe(true);
    expect(scheduleLooksPresent("# GDD\n\nA puzzle game with 12 levels.")).toBe(false);
    expect(scheduleLooksPresent(GDD_SNIPPET)).toBe(true);
  });
});

/**
 * Codex round AC, executed against the flattened reader: one leading blank
 * line in the file dropped every cell, and a table whose rows are separated
 * by TWO blank lines lost everything below the first break while the rows it
 * did read certified the schedule as complete.
 */
describe("a converted table's blank lines (Codex 2026-09-12 AC)", () => {
  it("folds blank-separated cells from the HEADER's parity, not the document's", () => {
    // The same table, shifted by one line — which is what a file with a
    // leading newline or a title line above the table looks like.
    const shifted = "\nStage\n\nFeature\n\nEffect\n\nCave 1\n\nVent\n\nPushes";
    expect(extractScheduledElements(shifted)).toEqual([{ unlock: "Cave 1", name: "Vent" }]);
    // …and preamble of its own, which moves the header off every parity the
    // reader might have assumed.
    expect(extractScheduledElements("# GDD\n\nStage\n\nFeature\n\nEffect\n\nCave 1\n\nVent\n\nPushes"))
      .toEqual([{ unlock: "Cave 1", name: "Vent" }]);
    expect(extractScheduledElements("# GDD\nA game about caves.\n\nStage\n\nFeature\n\nEffect\n\nCave 1\n\nVent\n\nPushes"))
      .toEqual([{ unlock: "Cave 1", name: "Vent" }]);
  });

  it("reads a blank-separated table whose rows are separated too (Codex 2026-09-13 AF#8)", () => {
    // Parity — the document's or the header's — breaks the moment one row
    // carries an extra blank line, and every later cell was discarded.
    expect(extractScheduledElements("Feature\n\nStage\n\nRotor\n\nCave 1\n\n\nMagnet\n\nCave 2")).toEqual([
      { unlock: "Cave 1", name: "Rotor" },
      { unlock: "Cave 2", name: "Magnet" },
    ]);
  });

  it("says so when the LAST row is cut short (Codex 2026-09-13 AF#8)", () => {
    const truncated: { partial?: boolean } = {};
    expect(extractFlattenedSchedule("Stage\nFeature\nCave 1\nRotor\nCave 2", truncated)).toEqual([{ unlock: "Cave 1", name: "Rotor" }]);
    expect(truncated.partial).toBe(true);
  });

  it("steps over TWO blank lines between rows", () => {
    const doubled = "Stage\nFeature\nEffect\nCave 1\nVent\nPushes\n\n\nCave 2\nMoss\nGlows\n\n\nCave 3\nSeam\nShines";
    expect(extractScheduledElements(doubled)).toEqual([
      { unlock: "Cave 1", name: "Vent" },
      { unlock: "Cave 2", name: "Moss" },
      { unlock: "Cave 3", name: "Seam" },
    ]);
  });

  it("says so when it stopped part-way through a table it could read", () => {
    // A row the reader cannot parse in the middle of the table: the elements
    // below it are NOT in the coverage set, and the rows above must not
    // certify the schedule as complete.
    const broken = "Stage\nFeature\nEffect\nCave 1\nVent\nPushes\nthis sentence is not a row of the table at all, it is prose\nCave 9\nSeam\nShines";
    const read: { partial?: boolean } = {};
    expect(extractFlattenedSchedule(broken, read)).toEqual([{ unlock: "Cave 1", name: "Vent" }]);
    expect(read.partial).toBe(true);
    // A table that ends cleanly says nothing of the kind — including one
    // followed by ordinary prose, where the reader stops because the TABLE
    // ended and not because a row was lost.
    const whole: { partial?: boolean } = {};
    extractFlattenedSchedule("Stage\nFeature\nEffect\nCave 1\nVent\nPushes\nCave 2\nMoss\nGlows", whole);
    expect(whole.partial).toBeUndefined();
    const thenProse: { partial?: boolean } = {};
    extractFlattenedSchedule(
      "Stage\nFeature\nEffect\nCave 1\nVent\nPushes\nThe elements above arrive in order.\nNothing below this line is a row.\nThe end.",
      thenProse,
    );
    expect(thenProse.partial).toBeUndefined();
  });
});

describe("the spec-scope code walk is bounded (AUT-15)", () => {
  // It had no budget at all: two links back to Assets/ made one synchronous
  // call walk 2^40 paths. Bounded, it stops — and says its corpus is partial,
  // so nothing it did not read is reported missing by the conformance gate.
  it.skipIf(process.platform === "win32")("stops on a symlink cycle and reports a partial corpus", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "spec-scope-loop-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "GDD.md"), GDD_SNIPPET);
      const assets = join(root, "Assets");
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, "Drone.cs"), "public class Drone {}");
      symlinkSync(assets, join(assets, "a"), "dir");
      symlinkSync(assets, join(assets, "b"), "dir");

      const report = assessSpecScope(root);
      expect(report.scheduled).toBe(4);
      expect(report.corpusPartial).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
