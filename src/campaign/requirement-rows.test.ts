/**
 * Requirement rows (GDD-drift plan W04, M3): the approved GDD read into rows
 * by code, and each row given to the milestone that owns it.
 *
 * In a measured campaign nothing turned a GDD rule into a row the system owned:
 * R-07 was closed by a worker's prose, and the §3.9 constants were
 * never held against anything. These tests pin the deterministic extraction
 * (no model), the add-only pass (a model may only ADD rows that quote the
 * document), and ownership.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeRequirement } from "./requirement-identity.js";
import {
  assignOwners,
  extractRequirementRows,
  proposeRowsAddOnly,
  requirementLedgerFrom,
  rowsToGaps,
} from "./requirement-rows.js";
import type { RequirementRow } from "./scope-types.js";

const SHA = "a".repeat(64);
const GDD = { gddSha256: SHA, gddRevision: 1 };

/** An invented English design document: labelled rules in a pipe table, a flattened constants table, screens, a claim. */
const ENGLISH = [
  "# Orbit Garden — Game Design Document",
  "",
  "## 1. Introduction",
  "This document describes the game. Every reader must read it whole.",
  "",
  "## 2. Core Rules",
  "| ID | Requirement |",
  "|---|---|",
  "| FR-1 | The player must tap a seed to plant it in the nearest empty plot. |",
  "| FR-2 | A plant must ripen in 30 seconds. |",
  "| FR-4 | Harvested fruit is added to the basket. |",
  "",
  "The basket holds at most 12 fruit.",
  "Each round lasts 60–90 s.",
  "",
  "### 2.1 Timing Constants",
  "Config key",
  "Default",
  "Description",
  "garden.grow_time",
  "30 s",
  "Seconds a plant needs to ripen",
  "garden.spawn_rate",
  "2 /s",
  "Seeds spawned per second",
  "",
  "## 3. Screens",
  "### 3.1 Main Menu",
  "The main menu shows a Play button.",
  "### 3.2 Results Screen",
  "The results screen must show the harvest total.",
  "",
  "## 4. Art Direction",
  "The look must feel calm and warm.",
  "",
  "## 5. KPI Targets",
  "Day-1 retention must be at least 40%.",
  "",
  "## 6. Performance",
  "The game must run at 60 fps on mid-range phones.",
  "",
  "The FR-1 … FR-5 series defines the core rules.",
  "",
].join("\n");

/** The same kind of document in Turkish: inline labels, the -mAlI obligation, "en fazla", screens. */
const TURKISH = [
  "# Yıldız Bahçesi — Oyun Tasarım Belgesi",
  "",
  "## 1. Giriş",
  "Bu belge oyunu ve bir bahçeyi anlatır.",
  "",
  "## 2. Temel Kurallar",
  "K-1: Oyuncu bir tohuma dokunarak onu en yakın boş tarlaya ekler.",
  "K-2: Bir bitki 30 saniyede olgunlaşmalıdır.",
  "K-3: Sepet en fazla 12 meyve alır.",
  "",
  "Oyuncu asla aynı anda iki tohum taşıyamaz ve bu bir kuraldır.",
  "Her tur 60–90 saniye sürmelidir.",
  "",
  "3.2 Çekirdek Sabitler",
  "Bir tohum 2 saniyede filizlenmelidir.",
  "",
  "## 4. Ekranlar",
  "### 4.1 Ana Menü",
  "### 4.2 Sonuç Ekranı",
  "Sonuç ekranı toplam hasadı göstermelidir.",
  "",
  "## 5. KPI Hedefleri",
  "Birinci gün elde tutma en az %40 olmalıdır.",
  "",
].join("\n");

function byLabel(rows: readonly RequirementRow[], label: string): RequirementRow {
  const row = rows.find((r) => r.label === label);
  if (row === undefined) throw new Error(`no row labelled ${label}: ${rows.map((r) => r.label ?? r.text.slice(0, 30)).join(" | ")}`);
  return row;
}

function byText(rows: readonly RequirementRow[], prefix: string): RequirementRow {
  const row = rows.find((r) => r.text.startsWith(prefix));
  if (row === undefined) throw new Error(`no row starting "${prefix}": ${rows.map((r) => r.text.slice(0, 40)).join(" | ")}`);
  return row;
}

describe("extractRequirementRows — an invented English GDD", () => {
  const { rows, numberingGaps, overflow } = extractRequirementRows(ENGLISH, GDD);

  it("reads labelled rules from a pipe table, verbatim, with their section", () => {
    const fr1 = byLabel(rows, "FR-1");
    expect(fr1.text).toBe("FR-1 | The player must tap a seed to plant it in the nearest empty plot.");
    expect(fr1.section).toBe("Core Rules");
    expect(fr1.sectionNumber).toBe("2");
    expect(fr1.kind).toBe("input");
    expect(fr1.source).toBe("extracted");
    expect(fr1.status).toBe("open");
    expect(ENGLISH.slice(fr1.span.start, fr1.span.end)).toContain("FR-1");
    expect(fr1.line).toBe(9);

    // A quantity inside a labelled rule merges into that rule: one row, bounds parsed by code.
    const fr2 = byLabel(rows, "FR-2");
    expect(fr2.kind).toBe("rule");
    expect(fr2.bounds).toEqual({ kind: "exact", value: 30, tolerance: 0.5, unit: "s" });
    expect(rows.filter((r) => r.text.includes("ripen in 30 seconds"))).toHaveLength(1);

    expect(byLabel(rows, "FR-4").kind).toBe("rule");
  });

  it("reads normative sentences, quantities and label/value constants, with bounds parsed by code", () => {
    const basket = byText(rows, "The basket holds at most 12 fruit.");
    expect(basket.kind).toBe("range");
    expect(basket.bounds).toEqual({ kind: "range", hi: 12 });

    const grow = byText(rows, "garden.grow_time");
    expect(grow.kind).toBe("constant");
    expect(grow.section).toBe("Timing Constants");
    expect(grow.sectionNumber).toBe("2.1");
    expect(grow.sectionPath).toEqual(["Core Rules", "Timing Constants"]);
    expect(grow.bounds).toEqual({ kind: "exact", value: 30, tolerance: 0.5, unit: "s" });
    expect(byText(rows, "garden.spawn_rate").bounds).toEqual({ kind: "exact", value: 2, tolerance: 0.5, unit: "/s" });

    // The header cells of a flattened table are not rows.
    expect(rows.some((r) => r.text.startsWith("Config key"))).toBe(false);
  });

  it("turns a session-length range into ONE claim row and a frame-rate figure into a claim", () => {
    const round = rows.filter((r) => r.text.startsWith("Each round lasts"));
    expect(round).toHaveLength(1);
    expect(round[0]!.kind).toBe("claim");
    expect(round[0]!.bounds).toEqual({ kind: "range", lo: 60, hi: 90, unit: "s" });

    const fps = byText(rows, "The game must run at 60 fps");
    expect(fps.kind).toBe("claim");
    expect(fps.bounds).toEqual({ kind: "range", lo: 60, unit: "fps" });
  });

  it("reads screens from their headings, and keeps a rule under a screen heading as its own row", () => {
    expect(byText(rows, "Main Menu").kind).toBe("screen");
    expect(byText(rows, "Results Screen").kind).toBe("screen");
    expect(byText(rows, "The results screen must show the harvest total.").kind).toBe("rule");
    // "Screens" names a group of screens, not a screen.
    expect(rows.some((r) => r.text === "Screens")).toBe(false);
  });

  it("classifies aspiration (excluded and disclosed) and judgement (never blocks)", () => {
    const kpi = byText(rows, "Day-1 retention must be at least 40%.");
    expect(kpi.kind).toBe("aspiration");
    expect(kpi.status).toBe("excluded");
    expect(kpi.excludedBecause).toMatch(/aspiration/);

    const look = byText(rows, "The look must feel calm and warm.");
    expect(look.kind).toBe("judgement");
    expect(look.status).toBe("open");
  });

  it("drops document apparatus: nothing is read from the introduction", () => {
    expect(rows.some((r) => r.text.includes("Every reader must read it whole"))).toBe(false);
  });

  it("reports a numbering gap and never invents the missing rows", () => {
    expect(numberingGaps).toEqual([
      expect.objectContaining({ series: "FR-", missing: ["FR-3", "FR-5"] }),
    ]);
    expect(rows.some((r) => r.label === "FR-3" || r.label === "FR-5")).toBe(false);
    expect(overflow).toEqual({ count: 0, sections: [] });
  });

  it("gives every row an identity that rides in its encoded string, bound to the approved GDD", () => {
    for (const row of rows) {
      expect(row.rid).toMatch(/^req-\d{3}-[0-9a-f]{12}$/);
      const decoded = decodeRequirement(row.encoded);
      expect(decoded.text).toBe(row.text);
      expect(decoded.identity?.id).toBe(row.rid);
      expect(decoded.identity?.gddSha256).toBe(SHA);
      expect(decoded.identity?.gddRevision).toBe(1);
      expect(row.gddSha256).toBe(SHA);
      expect(row.gddRevision).toBe(1);
      expect(row.ownership).toEqual([]);
      expect(row.checks).toEqual([]);
    }
    expect(new Set(rows.map((r) => r.rid)).size).toBe(rows.length);
  });

  it("is deterministic: the same text gives the same rows", () => {
    expect(extractRequirementRows(ENGLISH, GDD).rows).toEqual(rows);
  });

  it("a cosmetic rewording keeps the row's lineage; the new wording gets a new id", () => {
    const reworded = ENGLISH.replace("A plant must ripen in 30 seconds.", "The plant must ripen in 30 seconds.");
    const next = extractRequirementRows(reworded, { gddSha256: "b".repeat(64), gddRevision: 2, previous: rows });
    const before = byLabel(rows, "FR-2");
    const after = byLabel(next.rows, "FR-2");
    expect(after.rid).not.toBe(before.rid);
    const identity = decodeRequirement(after.encoded).identity!;
    expect(identity.lineage).toBe(before.rid);
    expect(identity.supersedes).toEqual([before.rid]);
    // An untouched row keeps its id.
    expect(byLabel(next.rows, "FR-1").rid).toBe(byLabel(rows, "FR-1").rid);
  });
});

describe("extractRequirementRows — an invented Turkish GDD", () => {
  const { rows } = extractRequirementRows(TURKISH, GDD);

  it("reads inline labels, the -mAlI obligation, asla and en fazla, with bounds parsed by code", () => {
    const k1 = byLabel(rows, "K-1");
    expect(k1.kind).toBe("input");
    expect(k1.section).toBe("Temel Kurallar");

    const k2 = byLabel(rows, "K-2");
    expect(k2.bounds).toEqual({ kind: "exact", value: 30, tolerance: 0.5, unit: "s" });

    const k3 = byLabel(rows, "K-3");
    expect(k3.bounds).toEqual({ kind: "range", hi: 12 });

    expect(byText(rows, "Oyuncu asla aynı anda iki tohum taşıyamaz").kind).toBe("rule");
    const round = byText(rows, "Her tur 60–90 saniye sürmelidir.");
    expect(round.kind).toBe("range");
    expect(round.bounds).toEqual({ kind: "range", lo: 60, hi: 90, unit: "s" });
  });

  it("reads a numbered heading that opens with a non-ASCII capital", () => {
    const sprout = byText(rows, "Bir tohum 2 saniyede filizlenmelidir.");
    expect(sprout.section).toBe("Çekirdek Sabitler");
    expect(sprout.sectionNumber).toBe("3.2");
    expect(sprout.bounds).toEqual({ kind: "exact", value: 2, tolerance: 0.5, unit: "s" });
  });

  it("reads Turkish screens and keeps the plural group heading out", () => {
    expect(byText(rows, "Ana Menü").kind).toBe("screen");
    expect(byText(rows, "Sonuç Ekranı").kind).toBe("screen");
    expect(rows.some((r) => r.text === "Ekranlar")).toBe(false);
    expect(byText(rows, "Sonuç ekranı toplam hasadı göstermelidir.").kind).toBe("rule");
  });

  it("classifies a KPI row as aspiration", () => {
    const kpi = byText(rows, "Birinci gün elde tutma en az %40 olmalıdır.");
    expect(kpi.kind).toBe("aspiration");
    expect(kpi.status).toBe("excluded");
    expect(kpi.bounds).toEqual({ kind: "range", lo: 40, unit: "%" });
  });

  it("does not read a descriptive sentence as a rule", () => {
    expect(rows.some((r) => r.text.startsWith("Bu belge"))).toBe(false);
  });
});

describe("extractRequirementRows — German, Spanish and French documents", () => {
  const docs = {
    de: {
      text: [
        "# Sternengarten — Spieldesign",
        "## 1. Einleitung",
        "Dieses Dokument beschreibt das Spiel und die Welt.",
        "## 2. Kernregeln",
        "R-1: Der Spieler tippt auf einen Samen, um ihn zu pflanzen.",
        "R-2: Eine Pflanze muss in 30 Sekunden reifen.",
        "Der Korb fasst höchstens 12 Früchte.",
        "Ein Spieler darf nie zwei Samen gleichzeitig tragen.",
        "## 3. Übersicht der Bildschirme",
        "### 3.1 Hauptmenü",
        "### 3.2 Ergebnisbildschirm",
        "Der Ergebnisbildschirm muss die Ernte anzeigen.",
      ],
      section: "Kernregeln",
      basket: "Der Korb fasst höchstens 12 Früchte.",
      never: "Ein Spieler darf nie zwei Samen",
      screens: ["Hauptmenü", "Ergebnisbildschirm"],
      descriptive: "Dieses Dokument",
    },
    es: {
      text: [
        "# Jardín Estelar — Documento de diseño",
        "## 1. Introducción",
        "Este documento describe el juego y el mundo.",
        "## 2. Reglas básicas",
        "R-1: El jugador toca una semilla para plantarla.",
        "R-2: Una planta debe madurar en 30 segundos.",
        "La cesta admite como máximo 12 frutas.",
        "El jugador nunca puede llevar dos semillas a la vez.",
        "## 3. Pantallas",
        "### 3.1 Menú principal",
        "### 3.2 Pantalla de resultados",
        "La pantalla de resultados debe mostrar la cosecha.",
      ],
      section: "Reglas básicas",
      basket: "La cesta admite como máximo 12 frutas.",
      never: "El jugador nunca puede llevar",
      screens: ["Menú principal", "Pantalla de resultados"],
      descriptive: "Este documento",
    },
    fr: {
      text: [
        "# Jardin Stellaire — Document de conception",
        "## 1. Présentation",
        "Ce document décrit le jeu et le monde.",
        "## 2. Règles de base",
        "R-1 : Le joueur touche une graine pour la planter.",
        "R-2 : Une plante doit mûrir en 30 secondes.",
        "Le panier contient au plus 12 fruits.",
        "Le joueur ne peut jamais porter deux graines à la fois.",
        "## 3. Écrans",
        "### 3.1 Menu principal",
        "### 3.2 Écran des résultats",
        "L'écran des résultats doit afficher la récolte.",
      ],
      section: "Règles de base",
      basket: "Le panier contient au plus 12 fruits.",
      never: "Le joueur ne peut jamais porter",
      screens: ["Menu principal", "Écran des résultats"],
      descriptive: "Ce document",
    },
  };

  for (const [language, doc] of Object.entries(docs)) {
    it(`${language}: labels, obligation words, bounds parsed by code, screens`, () => {
      const { rows } = extractRequirementRows(doc.text.join("\n"), GDD);
      const r1 = byLabel(rows, "R-1");
      expect(r1.kind).toBe("input");
      expect(r1.section).toBe(doc.section);
      expect(byLabel(rows, "R-2").bounds).toEqual({ kind: "exact", value: 30, tolerance: 0.5, unit: "s" });
      expect(byText(rows, doc.basket).bounds).toEqual({ kind: "range", hi: 12 });
      expect(byText(rows, doc.never).kind).toBe("rule");
      for (const screen of doc.screens) expect(byText(rows, screen).kind).toBe("screen");
      expect(rows.some((r) => r.text.startsWith(doc.descriptive))).toBe(false);
    });
  }
});

/**
 * Tables that lost their pipes in a PDF conversion: every cell on a line of
 * its own, the label alone on one. A converted GDD's numbered rules and
 * design pillars reach the extractor in this shape and no other, so nothing
 * else in this file reads them.
 */
const FLATTENED = [
  "# Tide Pool — Game Design Document",
  "",
  "1. OVERVIEW",
  "1.4 Design Pillars",
  "Every feature decision is checked against these pillars.",
  "#",
  "Pillar",
  "What it means in practice",
  "P1",
  "One gesture",
  "The only input is a swipe; no button ever blocks the board.",
  "P2",
  "No luck",
  "Every level must play out the same way from the same moves.",
  "P3",
  "Short rounds",
  "A round never asks for more than two minutes of attention.",
  "",
  "3. CORE GAMEPLAY",
  "3.3 Core Rules (Q-01 … Q-10)",
  "Each numbered rule below is binding for implementation.",
  "#",
  "Rule",
  "Q-01",
  "Matching. Three shells of one colour in a row must clear at once.",
  "Q-02",
  "Gravity. Shells above a cleared gap must fall within 0.3 s.",
  "Q-03",
  "Refill. Empty cells at the top must refill from the tide.",
  "Q-04",
  "Combo. Each further clear in one chain adds 1 to the multiplier.",
  "",
  "3.4 Boosters",
  "Booster",
  "Unlock",
  "Effect",
  "Crab",
  "L12",
  "Clears one shell of the player's choice.",
  "Wave",
  "L20",
  "Reorders every shell on the board.",
  "",
  "3.5 Triggers",
  "Event",
  "Rule",
  "Board settles",
  "Q-02",
  "",
].join("\n");

describe("extractRequirementRows — a flattened table: each label alone on a line", () => {
  const { rows, numberingGaps } = extractRequirementRows(FLATTENED, GDD);

  it("reads every labelled row of a run with the cells after its label, verbatim, under its own heading", () => {
    expect(rows.filter((r) => r.label !== undefined).map((r) => r.label)).toEqual(["P1", "P2", "P3", "Q-01", "Q-02", "Q-03", "Q-04", "L12", "L20"]);

    const q1 = byLabel(rows, "Q-01");
    expect(q1.text).toBe("Q-01 Matching. Three shells of one colour in a row must clear at once.");
    expect(FLATTENED.slice(q1.span.start, q1.span.end)).toBe("Q-01\nMatching. Three shells of one colour in a row must clear at once.");
    expect(q1.section).toBe("Core Rules (Q-01 … Q-10)");
    expect(q1.sectionNumber).toBe("3.3");
    expect(q1.status).toBe("open");

    // Three cells to a row: the label, a name, what it means.
    const p1 = byLabel(rows, "P1");
    expect(p1.text).toBe("P1 One gesture The only input is a swipe; no button ever blocks the board.");
    expect(p1.section).toBe("Design Pillars");
    expect(p1.sectionNumber).toBe("1.4");

    // The one quantity of a labelled rule is its bounds, and the sentence is not read a second time.
    expect(byLabel(rows, "Q-02").bounds).toEqual({ kind: "range", hi: 0.3, unit: "s" });
    expect(rows.filter((r) => r.text.includes("must fall within 0.3 s"))).toHaveLength(1);

    // The header row is no row.
    expect(rows.some((r) => /^(?:#|Pillar|What it means|Rule\b|Booster|Event)/.test(r.text))).toBe(false);
  });

  it("finds the label's column from a header wider than the row: the cell before the label is the row's", () => {
    expect(byLabel(rows, "L12").text).toBe("Crab L12 Clears one shell of the player's choice.");
    expect(byLabel(rows, "L20").text).toBe("Wave L20 Reorders every shell on the board.");
  });

  it("a lone label in another table refers to a rule; it defines none", () => {
    expect(rows.filter((r) => r.label === "Q-02")).toHaveLength(1);
    expect(rows.some((r) => r.section === "Triggers")).toBe(false);
  });

  it("reports the span the document states and the table stops short of, and invents none of it", () => {
    expect(numberingGaps).toEqual([
      expect.objectContaining({ series: "Q-", missing: ["Q-05", "Q-06", "Q-07", "Q-08", "Q-09", "Q-10"] }),
    ]);
    expect(numberingGaps[0]!.detail).toContain("Q-01 … Q-10");
    expect(rows.some((r) => r.label === "Q-05")).toBe(false);
  });
});

describe("extractRequirementRows — a business word a game uses too excludes no rule", () => {
  // An excluded row is never checked, so a heading word decides only when the
  // heading is the business section itself.
  const MIXED = [
    "# Rally Garden — Game Design Document",
    "## 3. Teams",
    "Players must pick a team before the first round.",
    "### 3.1 Team Size",
    "Each team must have exactly 4 players.",
    "## 4. Star Rating",
    "A level awards 3 stars when the player finishes with at least 5 moves left.",
    "## 5. Risk Cards",
    "Drawing a risk card must cost 2 coins.",
    "## 6. Currency Conversion",
    "Ten gems must convert to exactly 100 coins.",
    "## 7. Performance Budget",
    "Frame time must stay under 16 ms.",
    "## 8. Economy",
    "### 8.1 Coin Budget (daily model)",
    "Level clears must pay 25–50 coins each.",
    "## 9. Production",
    "### 9.1 Team",
    "The studio must hire 2 more artists by March.",
    "### 9.2 Budget",
    "The budget must stay under 50,000 USD.",
    "## 10. Risks & Mitigations",
    "Store review must finish within 7 days.",
    "## 11. KPI Targets",
    "### 11.1 Week One",
    "Day-7 retention must be at least 18%.",
    "## 12. Production Scope & Roadmap",
    "### 12.1 Team Shape",
    "The core pod must stay at 12 people.",
  ].join("\n");
  const { rows } = extractRequirementRows(MIXED, GDD);

  it("keeps a game rule a row under a heading that shares a word with a business section", () => {
    for (const rule of [
      "Players must pick a team before the first round.",
      "Each team must have exactly 4 players.",
      "A level awards 3 stars when the player finishes with at least 5 moves left.",
      "Drawing a risk card must cost 2 coins.",
      "Ten gems must convert to exactly 100 coins.",
      "Frame time must stay under 16 ms.",
      "Level clears must pay 25–50 coins each.",
    ]) {
      const row = byText(rows, rule);
      expect({ rule, kind: row.kind, status: row.status }).toEqual({ rule, kind: expect.not.stringMatching(/aspiration/), status: "open" });
    }
  });

  it("still excludes the business sections themselves, and a metric or production heading excludes what sits under it", () => {
    for (const goal of [
      "The studio must hire 2 more artists by March.",
      "The budget must stay under 50,000 USD.",
      "Store review must finish within 7 days.",
      "Day-7 retention must be at least 18%.",
      "The core pod must stay at 12 people.",
    ]) {
      const row = byText(rows, goal);
      expect({ goal, kind: row.kind, status: row.status }).toEqual({ goal, kind: "aspiration", status: "excluded" });
    }
  });
});

describe("extractRequirementRows — caps are disclosed, never silent", () => {
  it("counts the rows past the per-section cap and names their section", () => {
    const many = ["## 2. Rules", ...Array.from({ length: 12 }, (_, i) => `Rule ${i + 1}: the gate must open within ${i + 2} s.`)].join("\n");
    const result = extractRequirementRows(many, { ...GDD, perSection: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.overflow).toEqual({ count: 7, sections: ["Rules"] });

    const capped = extractRequirementRows(many, { ...GDD, maxRows: 3 });
    expect(capped.rows).toHaveLength(3);
    expect(capped.overflow.count).toBe(9);
  });

  it("gives the cap's last places to aspiration and judgement rows, wherever the document puts them", () => {
    const doc = [
      "## 2. KPI Targets",
      "Day-1 retention must be at least 40%.",
      "Day-7 retention must be at least 18%.",
      "## 3. Art Direction",
      "The look must feel calm and warm.",
      "## 4. Rules",
      "The gate must open within 2 s.",
      "The bridge must hold at most 3 carts.",
    ].join("\n");
    const capped = extractRequirementRows(doc, { ...GDD, maxRows: 2 });
    expect(capped.rows.map((r) => r.text)).toEqual(["The gate must open within 2 s.", "The bridge must hold at most 3 carts."]);
    expect(capped.overflow).toEqual({ count: 3, sections: ["KPI Targets", "Art Direction"] });
  });
});

describe("requirementLedgerFrom — the APPROVED text, never the copy on disk", () => {
  it("reads campaign.gddText even when the document on disk says something else", () => {
    const root = mkdtempSync(join(tmpdir(), "rows-approved-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "gdd.md"), "## 2. Core Rules\n| FR-9 | The player must never see this disk-only rule. |\n");
      const campaign = { gddText: ENGLISH, gddPath: "docs/gdd.md", projectRoot: root };
      const ledger = requirementLedgerFrom(campaign, { atMs: 1000 })!;
      expect(ledger.rows.some((r) => r.text.includes("disk-only"))).toBe(false);
      expect(ledger.rows.some((r) => r.label === "FR-1")).toBe(true);
      // A campaign from before the hash existed is bound to the text it holds, at revision 1.
      expect(ledger.gddSha256).toBe(createHash("sha256").update(ENGLISH).digest("hex"));
      expect(ledger.gddRevision).toBe(1);
      expect(ledger).toMatchObject({ version: 1, extractedAtMs: 1000, llmAdded: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the stored hash and revision when the campaign has them, and has no ledger without text", () => {
    const ledger = requirementLedgerFrom({ gddText: ENGLISH, gddSha256: SHA, gddRevision: 3 }, { atMs: 1 })!;
    expect(ledger.gddSha256).toBe(SHA);
    expect(ledger.gddRevision).toBe(3);
    expect(ledger.rows.every((r) => r.gddRevision === 3)).toBe(true);
    expect(requirementLedgerFrom({}, { atMs: 1 })).toBeUndefined();
  });
});

describe("proposeRowsAddOnly — a model may only ADD rows, and only with a verbatim quote", () => {
  const base = extractRequirementRows(ENGLISH, GDD).rows;

  it("accepts a verbatim quote (whitespace aside) and rejects a paraphrase", async () => {
    const asks: Array<{ system: string; user: string }> = [];
    const ask = async (system: string, user: string): Promise<string> => {
      asks.push({ system, user });
      return JSON.stringify({
        rows: [
          // A paraphrase: no such sentence in the document.
          { requirement: "Seeds are always planted in the closest plot", quote: "Seeds are always planted in the closest free plot of the garden." },
          // Verbatim, with the document's line break folded into a space.
          { requirement: "The main menu shows a Play button", quote: "The   main menu shows a Play button." },
        ],
      });
    };
    const result = await proposeRowsAddOnly(ENGLISH, ask, base, GDD);

    expect(asks.length).toBeGreaterThan(0);
    expect(result.added).toHaveLength(1);
    const added = result.added[0]!;
    expect(added.text).toBe("The main menu shows a Play button.");
    expect(added.source).toBe("llm-added");
    expect(added.section).toBe("Main Menu");
    expect(ENGLISH.slice(added.span.start, added.span.end)).toBe("The main menu shows a Play button.");
    expect(result.rejected).toEqual([expect.objectContaining({ reason: expect.stringMatching(/verbatim/) })]);
    // Add-only: every deterministic row is still there, untouched.
    expect(result.rows.slice(0, base.length)).toEqual(base);
    expect(result.rows).toHaveLength(base.length + 1);
    expect(new Set(result.rows.map((r) => r.rid)).size).toBe(result.rows.length);
  });

  it("rejects a quote that is too short, a duplicate of a row, and a requirement that is not about its quote", async () => {
    const ask = async (): Promise<string> =>
      JSON.stringify({
        rows: [
          { requirement: "Main menu", quote: "Main Menu" },
          { requirement: "The basket holds at most 12 fruit", quote: "The basket holds at most 12 fruit." },
          { requirement: "The boss has three phases and a rage timer", quote: "The main menu shows a Play button." },
        ],
      });
    const result = await proposeRowsAddOnly(ENGLISH, ask, base, GDD);
    expect(result.added).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      expect.stringMatching(/short/),
      expect.stringMatching(/duplicate/),
      expect.stringMatching(/about/),
    ]);
  });

  it("takes at most ten rows from one chunk, and a failed call removes nothing", async () => {
    const lines = Array.from({ length: 14 }, (_, i) => `Garden bed number ${i + 1} grows a different flower.`);
    const doc = `## 2. Beds\n${lines.join("\n")}\n`;
    const many = async (): Promise<string> => JSON.stringify({ rows: lines.map((quote) => ({ quote })) });
    const result = await proposeRowsAddOnly(doc, many, [], GDD);
    expect(result.added).toHaveLength(10);

    const failing = async (): Promise<string> => {
      throw new Error("provider down");
    };
    const failed = await proposeRowsAddOnly(ENGLISH, failing, base, GDD);
    expect(failed.rows).toEqual(base);
    expect(failed.failedCalls).toBeGreaterThan(0);
  });
});

describe("assignOwners", () => {
  const { rows } = extractRequirementRows(ENGLISH, GDD);

  it("gives a row to the milestone that claims its heading or an ancestor; claims go to the final milestone", () => {
    const result = assignOwners(
      rows,
      [
        { id: "m1", coveredSections: ["Core Rules"], prompt: "" },
        { id: "m2", coveredSections: ["Screens"], prompt: "" },
        { id: "m3", coveredSections: ["Performance"], prompt: "" },
      ],
      { atMs: 5 },
    );
    const owned = (prefix: string) => result.rows.find((r) => r.text.startsWith(prefix))!;
    expect(owned("FR-1").owner).toBe("m1");
    expect(owned("FR-1").ownership).toEqual([{ milestoneId: "m1", reason: "covered-section", detail: "Core Rules", atMs: 5 }]);
    // An ancestor heading claims a row under a sub-heading.
    expect(owned("garden.grow_time").owner).toBe("m1");
    expect(owned("Results Screen").owner).toBe("m2");
    // Claims are measured at delivery: the final milestone owns them.
    expect(owned("Each round lasts").owner).toBe("m3");
    expect(owned("Each round lasts").ownership[0]!.reason).toBe("final-milestone");
    // Nobody claims Art Direction: the row is queued, failing closed.
    const look = owned("The look must feel");
    expect(look.owner).toBeUndefined();
    expect(result.queued).toContain(look.rid);
    // An aspiration is excluded, not queued.
    expect(result.queued).not.toContain(owned("Day-1 retention").rid);
    expect(result.byMilestone.m1).toContain(owned("FR-1").rid);
    // The input is not mutated.
    expect(rows.every((r) => r.owner === undefined)).toBe(true);
  });

  it("falls back to the § references of a milestone planned without coveredSections, most specific first", () => {
    const result = assignOwners(
      rows,
      [
        { id: "m1", prompt: "Build the core rules of §2 and nothing else." },
        { id: "m2", prompt: "Tune the timing constants in §2.1." },
        { id: "m3", prompt: "Ship it (§6)." },
      ],
      { atMs: 5 },
    );
    const owned = (prefix: string) => result.rows.find((r) => r.text.startsWith(prefix))!;
    expect(owned("FR-2").owner).toBe("m1");
    expect(owned("FR-2").ownership[0]).toMatchObject({ reason: "section-reference", detail: "§2" });
    expect(owned("garden.grow_time").owner).toBe("m2");
    expect(owned("garden.grow_time").ownership[0]).toMatchObject({ reason: "section-reference", detail: "§2.1" });
    // §2 does not reach §20-something, and nothing references §3.
    expect(owned("Main Menu").owner).toBeUndefined();
  });

  it("reads a § RANGE as every section between its ends; a single reference is more specific than a range", () => {
    const result = assignOwners(
      rows,
      [
        { id: "m1", prompt: "Core rules: §1–§2." },
        { id: "m2", prompt: "Screens and art (§3.1–§3.2, §4 – 3 passes)." },
        { id: "m3", prompt: "Polish the results screen (§3.2)." },
      ],
      { atMs: 5 },
    );
    const owned = (prefix: string) => result.rows.find((r) => r.text.startsWith(prefix))!;
    expect(owned("garden.grow_time").owner).toBe("m1");
    // §2.1 lies inside §1–§2: a range reaches the subsections of its last chapter.
    expect(owned("garden.grow_time").ownership[0]).toMatchObject({ reason: "section-reference", detail: "§1–§2" });
    // §3.1 lies inside §3.1–§3.2; nothing else names it.
    expect(owned("Main Menu").owner).toBe("m2");
    // §3.2 is inside m2's range, but m3 names it alone.
    expect(owned("Results Screen").owner).toBe("m3");
    expect(owned("Results Screen").ownership[0]).toMatchObject({ detail: "§3.2" });
    // "§4 – 3 passes" is §4, not a range from §4 back to §3.
    expect(owned("The look must feel").owner).toBe("m2");
  });

  it("gives claims to the last PLANNED milestone: a stored ladder ends with coverage sprints and a final proof, which own nothing by plan", () => {
    const ladder = [
      { id: "m1", prompt: "Core rules: §1–§2." },
      { id: "m2", prompt: "Screens (§3) and the rest (§4–§6)." },
      { id: "mcov1", prompt: "Close the gaps: the timing constants of §2.1 and the art of §4." },
      { id: "mfinal-4", prompt: "Prove §6 at delivery." },
    ];
    const result = assignOwners(rows, ladder, { atMs: 5 });
    const owned = (prefix: string) => result.rows.find((r) => r.text.startsWith(prefix))!;
    expect(owned("Each round lasts").owner).toBe("m2");
    expect(owned("Each round lasts").ownership[0]!.reason).toBe("final-milestone");
    expect(owned("The game must run at 60 fps").owner).toBe("m2");
    // mcov1 names §2.1 and §4 alone, which would outrank the planned ranges.
    expect(owned("garden.grow_time").owner).toBe("m1");
    expect(owned("The look must feel").owner).toBe("m2");
    expect(result.byMilestone.mcov1).toBeUndefined();
    expect(result.byMilestone["mfinal-4"]).toBeUndefined();

    // A caller that names the final milestone still decides.
    const named = assignOwners(rows, ladder, { atMs: 5, finalId: "mfinal-4" });
    expect(named.rows.find((r) => r.text.startsWith("Each round lasts"))!.owner).toBe("mfinal-4");
  });

  it("keeps a claim under an excluded heading owned: delivery measures it whatever the plan excluded", () => {
    const result = assignOwners(
      rows,
      [{ id: "m1", coveredSections: ["Core Rules"], prompt: "" }],
      { excluded: ["Performance: tuned after launch"], atMs: 5 },
    );
    const fps = result.rows.find((r) => r.text.startsWith("The game must run at 60 fps"))!;
    expect(fps.status).toBe("open");
    expect(fps.owner).toBe("m1");
    expect(fps.ownership[0]!.reason).toBe("final-milestone");
    expect(result.excluded).not.toContain(fps.rid);
  });

  it("marks rows under a heading the planner excluded as excluded, with the planner's reason", () => {
    const result = assignOwners(
      rows,
      [{ id: "m1", coveredSections: ["Core Rules"], prompt: "" }],
      { excluded: ["Art Direction: the GDD defers art to phase two"], atMs: 5 },
    );
    const look = result.rows.find((r) => r.text.startsWith("The look must feel"))!;
    expect(look.status).toBe("excluded");
    expect(look.excludedBecause).toContain("Art Direction: the GDD defers art to phase two");
    expect(result.queued).not.toContain(look.rid);
    expect(result.excluded).toContain(look.rid);
  });

  it("an exclusion that only MENTIONS a heading excludes nothing under it: the rows stay owned (fail closed)", () => {
    const result = assignOwners(
      rows,
      [{ id: "m1", coveredSections: ["Core Rules"], prompt: "" }],
      { excluded: ["Seasonal events beyond the core rules: the GDD defers them past launch"], atMs: 5 },
    );
    const fr1 = result.rows.find((r) => r.label === "FR-1")!;
    expect(fr1.status).toBe("open");
    expect(fr1.owner).toBe("m1");
    expect(result.excluded).not.toContain(fr1.rid);
  });

  it("rowsToGaps hands back the encoded strings of rows still to do", () => {
    const result = assignOwners(rows, [], { atMs: 5 });
    const queued = result.rows.filter((r) => result.queued.includes(r.rid));
    const gaps = rowsToGaps(result.rows);
    expect(gaps).toEqual(result.rows.filter((r) => r.status !== "excluded" && r.status !== "waived").map((r) => r.encoded));
    expect(queued.length).toBeGreaterThan(0);
    for (const gap of gaps) expect(decodeRequirement(gap).identity?.id).toMatch(/^req-/);
  });

  it("rowsToGaps leaves out a row that already passes", () => {
    const fr1 = rows.find((r) => r.label === "FR-1")!;
    const passing: RequirementRow = { ...fr1, status: "passing" };
    const gaps = rowsToGaps(rows.map((r) => (r === fr1 ? passing : r)));
    expect(gaps).not.toContain(fr1.encoded);
    expect(gaps).toContain(rows.find((r) => r.label === "FR-2")!.encoded);
  });
});
