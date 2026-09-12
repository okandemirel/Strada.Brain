import { describe, it, expect } from "vitest";
import { extractScheduledElements, elementCodeTokens, assessSpecScope, findDesignDoc, stripCsComments } from "./spec-scope.js";

const GDD_SNIPPET = `
## 4. GAME ELEMENTS

### 4.1 Element Introduction Schedule

| Unlock | Element | One-line pitch |
|--------|---------|----------------|
| L21 | Hard Pixel | Armored cube, 2 hits |
| L36 | Ice Block | Encased cube |
| L46 | Wall | Indestructible shaping cell |
| L61 | Lock & Key | Region sealed until key cleared |
`;

describe("spec scope — the design document is the checklist", () => {
  it("word-prefixed unlocks are read, a staffing table is not a schedule, strings survive comment stripping (Codex 2026-09-11 C#29, C#30)", () => {
    const gdd = [
      "| Unlock | Element | Notes |",
      "| --- | --- | --- |",
      "| Level 21 | Ice Block | slides |",
      "| Chapter 1 | Fire Wall | burns |",
    ].join("\n");
    expect(extractScheduledElements(gdd).map((e) => e.name)).toEqual(["Ice Block", "Fire Wall"]);
    // A staffing table is not a game schedule.
    const staffing = ["| # | Who | Role |", "| --- | --- | --- |", "| 1 | Alice (producer) | plans |"].join("\n");
    expect(extractScheduledElements(staffing)).toEqual([]);
    // A string containing "//" does not swallow the rest of the file…
    expect(stripCsComments('class C { string separator="//"; void IceBlock() {} }')).toContain("IceBlock");
    // …and a comment after a label is still a comment.
    expect(stripCsComments("void M() { retry:// TODO IceBlock\n }")).not.toContain("IceBlock");
  });

  it("an unlock id in any shape, and a comment is not an implementation (Codex 2026-09-11 B#18)", () => {
    const gdd = [
      "| Unlock | Element | Notes |",
      "| --- | --- | --- |",
      "| 21 | Teleporter | bends the path |",
      "| E3 | Magnet | pulls items |",
      "| W1-2 | Springboard | launches |",
    ].join("\n");
    expect(extractScheduledElements(gdd).map((e) => e.name)).toEqual(["Teleporter", "Magnet", "Springboard"]);
    expect(stripCsComments("// TODO Teleporter Magnet\nclass A { /* Springboard */ int x; }")).not.toContain("Teleporter");
    expect(stripCsComments("class Teleporter { }")).toContain("Teleporter");
  });

  it("extracts the element schedule from a GDD-style table", () => {
    const els = extractScheduledElements(GDD_SNIPPET);
    expect(els.map((e) => e.name)).toEqual(["Hard Pixel", "Ice Block", "Wall", "Lock & Key"]);
    expect(els[0]?.unlock).toBe("L21");
  });

  it("builds code-token shapes an implementation might use", () => {
    expect(elementCodeTokens("Ice Block")).toContain("IceBlock");
    expect(elementCodeTokens("Lock & Key")).toContain("LockKey");
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
      writeFileSync(join(scripts, "IceBlock.cs"), "public class IceBlock {}");

      const report = assessSpecScope(root);
      expect(report.scheduled).toBe(4);
      expect(report.missing.map((m) => m.name)).toEqual(["Hard Pixel", "Wall", "Lock & Key"]);
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
      writeFileSync(join(root, "docs", "Game_GDD.md"), "# GDD\n\nElement schedule: pig, ball");
      expect(findDesignDoc(root)).toBe(join(root, "docs", "Game_GDD.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("short element names count as whole words (measured 2026-09-10: 'Cube' with `public class Cube` reported missing)", () => {
  it("finds a 4-letter element as an identifier and not inside another word", async () => {
    const { assessSpecScope } = await import("./spec-scope.js");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "spec-scope-short-"));
    try {
      mkdirSync(join(root, "docs"));
      mkdirSync(join(root, "Assets"));
      writeFileSync(join(root, "docs", "GDD.md"), "| L1 | Cube |\n| L2 | Pig |\n| L3 | Tray |\n");
      writeFileSync(join(root, "Assets", "A.cs"), "public class Cube {} // pigment\nclass Tray {}\n");
      const report = assessSpecScope(root, join(root, "docs", "GDD.md"));
      expect(report.scheduled).toBe(3);
      expect(report.missing.map((m) => m.name)).toEqual(["Pig"]); // "pigment" is not Pig
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A schedule table that lost its pipes. Measured by Codex 2026-09-12 (W#12)
 * on the real vehicle document: its whole element schedule — sixteen blockers
 * and special mechanics — read as ZERO scheduled elements, because a document
 * converted out of Google Docs arrives as one cell per LINE. Zero suppresses
 * the coverage check entirely, so none of that content was ever compared to
 * the code.
 */
describe("a flattened schedule table (Codex 2026-09-12 W#12)", () => {
  const flattened = [
    "4.1 Element Introduction Schedule",
    "Unlock",
    "Element",
    "One-line pitch",
    "Side",
    "L6",
    "Dual conveyor",
    "Second belt row; queue reads as a grid",
    "Belt",
    "L21",
    "Hard Pixel",
    "Armored cube, 2 hits",
    "Canvas",
    "L36",
    "Ice Block",
    "Encased cube; break via adjacent clears",
    "Canvas",
    "",
    "4.2 Designer usage",
    "Introduce each element alone, in a friendly level.",
  ].join("\n");

  it("reads the rows a converter flattened, with the right column for each", () => {
    expect(extractScheduledElements(flattened)).toEqual([
      { unlock: "L6", name: "Dual conveyor" },
      { unlock: "L21", name: "Hard Pixel" },
      { unlock: "L36", name: "Ice Block" },
    ]);
  });

  it("stops at the end of the table and does not invent elements from prose", () => {
    const after = `${flattened}\nL99\nnot a table row at all — this is a sentence about L99.`;
    expect(extractScheduledElements(after).map((e) => e.name)).toEqual([
      "Dual conveyor",
      "Hard Pixel",
      "Ice Block",
    ]);
    // A document with no schedule still yields none.
    expect(extractScheduledElements("# GDD\n\nA puzzle game with 12 levels.")).toEqual([]);
    // …and a staffing table is still not a schedule.
    expect(
      extractScheduledElements(["Unlock", "Element", "Owner", "L1", "Ada Lovelace (designer)", "art"].join("\n")),
    ).toEqual([]);
  });

  it("still reads an ordinary pipe table", () => {
    expect(extractScheduledElements(GDD_SNIPPET).map((e) => e.name)).toEqual([
      "Hard Pixel",
      "Ice Block",
      "Wall",
      "Lock & Key",
    ]);
  });
});
