/**
 * Requirement rows (GDD-drift plan W04, M3): the approved GDD read into rows
 * by code, and each row given to the milestone that owns it.
 *
 * In a measured campaign nothing turned a GDD rule into a row the system owned:
 * a labelled rule was closed by a worker's prose, and a section of tuning
 * constants was never held against anything. These tests pin the deterministic extraction
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
  "## 2. Orchard Rules",
  "| ID | Requirement |",
  "|---|---|",
  "| FR-1 | The player must press a branch to mark it for pruning. |",
  "| FR-2 | A graft must take in 38 seconds. |",
  "| FR-4 | Pruned wood is added to the compost heap. |",
  "",
  "A pruning order covers at most 23 branches.",
  "Each round lasts 74–95 s.",
  "",
  "### 2.1 Frost Table",
  "Key",
  "Value",
  "Graft time",
  "38 s",
  "Frost checks",
  "3 /day",
  "",
  "## 3. Performance",
  "The game must hold 53 fps while the trees sway.",
  "",
  "## 4. Studio KPIs",
  "Week-2 returners must be at least 31% of installs.",
  "",
  "## 5. Screens",
  "### 5.1 Main Menu",
  "The main menu shows a Play button.",
  "### 5.2 Results Screen",
  "The results screen must show the harvest weight.",
  "",
  "## 6. Visual Mood",
  "The look must feel calm and warm.",
  "",
  "Rules FR-1 through FR-5 are the orchard rules.",
  "",
].join("\n");

/** The same kind of document in Turkish: inline labels, the -mAlI obligation, "en fazla", screens. */
const TURKISH = [
  "# Yıldız Bahçesi — Oyun Tasarım Belgesi",
  "",
  "## 1. Giriş",
  "Bu belge oyunu ve bir bahçeyi anlatır.",
  "",
  "## 2. Bahçe Kuralları",
  "K-1: Oyuncu bir dala basılı tutarak onu budama için işaretler.",
  "K-2: Bir aşı 38 saniyede tutmalıdır.",
  "K-3: Bir budama emri en fazla 23 dalı kapsar.",
  "",
  "Oyuncu asla aynı anda iki fidan taşıyamaz ve bu bir kuraldır.",
  "Her tur 74–95 saniye sürmelidir.",
  "",
  "3.2 Çiçeklenme Takvimi",
  "Bir tomurcuk 2 saniyede açmalıdır.",
  "",
  "## 5. Stüdyo KPI'ları",
  "İkinci hafta geri dönüş en az %31 olmalıdır.",
  "",
  "## 6. Ekranlar",
  "### 6.1 Ana Menü",
  "### 6.2 Sonuç Ekranı",
  "Sonuç ekranı toplam hasadı göstermelidir.",
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
    expect(fr1.text).toBe("FR-1 | The player must press a branch to mark it for pruning.");
    expect(fr1.section).toBe("Orchard Rules");
    expect(fr1.sectionNumber).toBe("2");
    expect(fr1.kind).toBe("input");
    expect(fr1.source).toBe("extracted");
    expect(fr1.status).toBe("open");
    expect(ENGLISH.slice(fr1.span.start, fr1.span.end)).toContain("FR-1");
    expect(fr1.line).toBe(9);

    // A quantity inside a labelled rule merges into that rule: one row, bounds parsed by code.
    const fr2 = byLabel(rows, "FR-2");
    expect(fr2.kind).toBe("rule");
    expect(fr2.bounds).toEqual({ kind: "exact", value: 38, tolerance: 0.5, unit: "s" });
    expect(rows.filter((r) => r.text.includes("take in 38 seconds"))).toHaveLength(1);

    expect(byLabel(rows, "FR-4").kind).toBe("rule");
  });

  it("reads normative sentences, quantities and label/value constants, with bounds parsed by code", () => {
    const order = byText(rows, "A pruning order covers at most 23 branches.");
    expect(order.kind).toBe("range");
    expect(order.bounds).toEqual({ kind: "range", hi: 23 });

    const graft = byText(rows, "Graft time");
    expect(graft.kind).toBe("constant");
    expect(graft.section).toBe("Frost Table");
    expect(graft.sectionNumber).toBe("2.1");
    expect(graft.sectionPath).toEqual(["Orchard Rules", "Frost Table"]);
    expect(graft.bounds).toEqual({ kind: "exact", value: 38, tolerance: 0.5, unit: "s" });
    expect(byText(rows, "Frost checks").bounds).toEqual({ kind: "exact", value: 3, tolerance: 0.5, unit: "/day" });

    // The header cells of a flattened table are not rows.
    expect(rows.some((r) => r.text.startsWith("Key"))).toBe(false);
  });

  it("turns a session-length range into ONE claim row and a frame-rate figure into a claim", () => {
    const round = rows.filter((r) => r.text.startsWith("Each round lasts"));
    expect(round).toHaveLength(1);
    expect(round[0]!.kind).toBe("claim");
    expect(round[0]!.bounds).toEqual({ kind: "range", lo: 74, hi: 95, unit: "s" });

    const fps = byText(rows, "The game must hold 53 fps");
    expect(fps.kind).toBe("claim");
    expect(fps.bounds).toEqual({ kind: "range", lo: 53, unit: "fps" });
  });

  it("reads screens from their headings, and keeps a rule under a screen heading as its own row", () => {
    expect(byText(rows, "Main Menu").kind).toBe("screen");
    expect(byText(rows, "Results Screen").kind).toBe("screen");
    expect(byText(rows, "The results screen must show the harvest weight.").kind).toBe("rule");
    // "Screens" names a group of screens, not a screen.
    expect(rows.some((r) => r.text === "Screens")).toBe(false);
  });

  it("classifies aspiration (excluded and disclosed) and judgement (never blocks)", () => {
    const kpi = byText(rows, "Week-2 returners must be at least 31% of installs.");
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
    const reworded = ENGLISH.replace("A graft must take in 38 seconds.", "The graft must take in 38 seconds.");
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
    expect(k1.section).toBe("Bahçe Kuralları");

    const k2 = byLabel(rows, "K-2");
    expect(k2.bounds).toEqual({ kind: "exact", value: 38, tolerance: 0.5, unit: "s" });

    const k3 = byLabel(rows, "K-3");
    expect(k3.bounds).toEqual({ kind: "range", hi: 23 });

    expect(byText(rows, "Oyuncu asla aynı anda iki fidan taşıyamaz").kind).toBe("rule");
    const round = byText(rows, "Her tur 74–95 saniye sürmelidir.");
    expect(round.kind).toBe("range");
    expect(round.bounds).toEqual({ kind: "range", lo: 74, hi: 95, unit: "s" });
  });

  it("reads a numbered heading that opens with a non-ASCII capital", () => {
    const sprout = byText(rows, "Bir tomurcuk 2 saniyede açmalıdır.");
    expect(sprout.section).toBe("Çiçeklenme Takvimi");
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
    const kpi = byText(rows, "İkinci hafta geri dönüş en az %31 olmalıdır.");
    expect(kpi.kind).toBe("aspiration");
    expect(kpi.status).toBe("excluded");
    expect(kpi.bounds).toEqual({ kind: "range", lo: 31, unit: "%" });
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
        "## 2. Obstgartenregeln",
        "OR-1: Der Spieler tippt auf einen Ast, um ihn für den Schnitt zu markieren.",
        "OR-2: Eine Veredelung muss in 38 Sekunden anwachsen.",
        "Ein Schnittauftrag umfasst höchstens 23 Äste.",
        "Ein Spieler darf nie zwei Samen gleichzeitig tragen.",
        "## 3. Übersicht der Bildschirme",
        "### 3.1 Hauptmenü",
        "### 3.2 Ergebnisbildschirm",
        "Der Ergebnisbildschirm muss die Ernte anzeigen.",
      ],
      section: "Obstgartenregeln",
      capped: "Ein Schnittauftrag umfasst höchstens 23 Äste.",
      never: "Ein Spieler darf nie zwei Samen",
      screens: ["Hauptmenü", "Ergebnisbildschirm"],
      descriptive: "Dieses Dokument",
    },
    es: {
      text: [
        "# Jardín Estelar — Documento de diseño",
        "## 1. Introducción",
        "Este documento describe el juego y el mundo.",
        "## 2. Reglas del huerto",
        "OR-1: El jugador toca una rama para marcarla para la poda.",
        "OR-2: Un injerto debe prender en 38 segundos.",
        "Una orden de poda cubre como máximo 23 ramas.",
        "El jugador nunca puede llevar dos semillas a la vez.",
        "## 3. Pantallas",
        "### 3.1 Menú principal",
        "### 3.2 Pantalla de resultados",
        "La pantalla de resultados debe mostrar la cosecha.",
      ],
      section: "Reglas del huerto",
      capped: "Una orden de poda cubre como máximo 23 ramas.",
      never: "El jugador nunca puede llevar",
      screens: ["Menú principal", "Pantalla de resultados"],
      descriptive: "Este documento",
    },
    fr: {
      text: [
        "# Jardin Stellaire — Document de conception",
        "## 1. Présentation",
        "Ce document décrit le jeu et le monde.",
        "## 2. Règles du verger",
        "OR-1 : Le joueur touche une branche pour la marquer pour la taille.",
        "OR-2 : Une greffe doit prendre en 38 secondes.",
        "Un ordre de taille couvre au plus 23 branches.",
        "Le joueur ne peut jamais porter deux graines à la fois.",
        "## 3. Écrans",
        "### 3.1 Menu principal",
        "### 3.2 Écran des résultats",
        "L'écran des résultats doit afficher la récolte.",
      ],
      section: "Règles du verger",
      capped: "Un ordre de taille couvre au plus 23 branches.",
      never: "Le joueur ne peut jamais porter",
      screens: ["Menu principal", "Écran des résultats"],
      descriptive: "Ce document",
    },
  };

  for (const [language, doc] of Object.entries(docs)) {
    it(`${language}: labels, obligation words, bounds parsed by code, screens`, () => {
      const { rows } = extractRequirementRows(doc.text.join("\n"), GDD);
      const or1 = byLabel(rows, "OR-1");
      expect(or1.kind).toBe("input");
      expect(or1.section).toBe(doc.section);
      expect(byLabel(rows, "OR-2").bounds).toEqual({ kind: "exact", value: 38, tolerance: 0.5, unit: "s" });
      expect(byText(rows, doc.capped).bounds).toEqual({ kind: "range", hi: 23 });
      expect(byText(rows, doc.never).kind).toBe("rule");
      for (const screen of doc.screens) expect(byText(rows, screen).kind).toBe("screen");
      expect(rows.some((r) => r.text.startsWith(doc.descriptive))).toBe(false);
    });
  }
});

/**
 * Tables that lost their pipes in a PDF conversion: every cell on a line of
 * its own, the label alone on one. A converted GDD's numbered rules and
 * phase tables reach the extractor in this shape and no other, so nothing
 * else in this file reads them.
 */
const FLATTENED = [
  "# Orchard Seasons — Game Design Document",
  "",
  "2. THE ORCHARD",
  "2.1 Season Phases",
  "Each season moves through these phases in order.",
  "Code",
  "Phase",
  "What happens",
  "S1",
  "Dormancy",
  "The player marks branches to prune; no tree grows during this phase.",
  "S2",
  "Grafting",
  "Every graft placed this season must be joined to a pruned branch.",
  "S3",
  "Harvest",
  "Each tree's yield is weighed in kilograms and added to the store.",
  "",
  "4. SEASON PLAY",
  "4.5 Grafting rules",
  "The settled rules are listed here; the full list runs from G-01 to G-07.",
  "Code",
  "Rule",
  "G-01",
  "Pruning. A branch pruned in winter must not fruit that season.",
  "G-02",
  "Growth. Each tree's growth animation must finish within 0.4 s.",
  "G-03",
  "Walls. A tree beside the orchard wall must yield half its usual weight.",
  "G-04",
  "Tokens. Each harvest adds seed tokens to the store by weight.",
  "",
  "6. VARIETIES",
  "6.8 Planting Calendar",
  "Variety",
  "Week",
  "Note",
  "Russet pear",
  "W3",
  "Needs a sheltered plot beside the south wall.",
  "Quince",
  "W11",
  "Fruits only after a hard winter.",
  "",
  "6.9 Season Journal",
  "Entry",
  "See",
  "Frost damage",
  "G-03",
  "",
].join("\n");

describe("extractRequirementRows — a flattened table: each label alone on a line", () => {
  const { rows, numberingGaps } = extractRequirementRows(FLATTENED, GDD);

  it("reads every labelled row of a run with the cells after its label, verbatim, under its own heading", () => {
    expect(rows.filter((r) => r.label !== undefined).map((r) => r.label)).toEqual(["S1", "S2", "S3", "G-01", "G-02", "G-03", "G-04", "W3", "W11"]);

    const g1 = byLabel(rows, "G-01");
    expect(g1.text).toBe("G-01 Pruning. A branch pruned in winter must not fruit that season.");
    expect(FLATTENED.slice(g1.span.start, g1.span.end)).toBe("G-01\nPruning. A branch pruned in winter must not fruit that season.");
    expect(g1.section).toBe("Grafting rules");
    expect(g1.sectionNumber).toBe("4.5");
    expect(g1.status).toBe("open");

    // Three cells to a row: the label, a name, what it means.
    const s1 = byLabel(rows, "S1");
    expect(s1.text).toBe("S1 Dormancy The player marks branches to prune; no tree grows during this phase.");
    expect(s1.section).toBe("Season Phases");
    expect(s1.sectionNumber).toBe("2.1");

    // The one quantity of a labelled rule is its bounds, and the sentence is not read a second time.
    expect(byLabel(rows, "G-02").bounds).toEqual({ kind: "range", hi: 0.4, unit: "s" });
    expect(rows.filter((r) => r.text.includes("must finish within 0.4 s"))).toHaveLength(1);

    // The header row is no row.
    expect(rows.some((r) => /^(?:Code|Phase|What happens|Rule\b|Variety|Week|Note|Entry|See\b)/.test(r.text))).toBe(false);
  });

  it("finds the label's column from a header wider than the row: the cell before the label is the row's", () => {
    expect(byLabel(rows, "W3").text).toBe("Russet pear W3 Needs a sheltered plot beside the south wall.");
    expect(byLabel(rows, "W11").text).toBe("Quince W11 Fruits only after a hard winter.");
  });

  it("a lone label in another table refers to a rule; it defines none", () => {
    expect(rows.filter((r) => r.label === "G-03")).toHaveLength(1);
    expect(rows.some((r) => r.section === "Season Journal")).toBe(false);
  });

  it("reports the span the document states and the table stops short of, and invents none of it", () => {
    expect(numberingGaps).toEqual([
      expect.objectContaining({ series: "G-", missing: ["G-05", "G-06", "G-07"] }),
    ]);
    expect(numberingGaps[0]!.detail).toContain("G-01 to G-07");
    expect(rows.some((r) => r.label === "G-05")).toBe(false);
  });
});

describe("extractRequirementRows — a business word a game uses too excludes no rule", () => {
  // An excluded row is never checked, so a heading word decides only when the
  // heading is the business section itself.
  const MIXED = [
    "# Rally Garden — Game Design Document",
    "## 2. Risk Management",
    "The store submission must finish within 6 days.",
    "## 3. Teams",
    "Players must pick a team before the first round.",
    "### 3.1 Team Size",
    "Each team must have exactly 4 players.",
    "## 4. Roadmap",
    "### 4.2 Autumn Milestone",
    "The autumn milestone must ship by week 37.",
    "## 5. Star Rating",
    "A level awards 3 stars when the player finishes with at least 5 moves left.",
    "## 6. Store KPIs",
    "### 6.2 Autumn Quarter",
    "Week-6 returners must be at least 13% of installs.",
    "## 7. Risk Cards",
    "Drawing a risk card must cost 2 coins.",
    "## 8. Studio",
    "### 8.1 Team",
    "The studio must hire 3 more animators by June.",
    "### 8.2 Budget",
    "The budget must stay under 38,000 EUR.",
    "## 9. Currency Conversion",
    "Ten gems must convert to exactly 100 coins.",
    "## 11. Performance Budget",
    "Frame time must stay under 16 ms.",
    "## 12. Weather",
    "### 12.1 Water Budget",
    "Each tree must receive 4–9 litres of water per turn.",
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
      "Each tree must receive 4–9 litres of water per turn.",
    ]) {
      const row = byText(rows, rule);
      expect({ rule, kind: row.kind, status: row.status }).toEqual({ rule, kind: expect.not.stringMatching(/aspiration/), status: "open" });
    }
  });

  it("still excludes the business sections themselves, and a metric or production heading excludes what sits under it", () => {
    for (const goal of [
      "The store submission must finish within 6 days.",
      "The autumn milestone must ship by week 37.",
      "Week-6 returners must be at least 13% of installs.",
      "The studio must hire 3 more animators by June.",
      "The budget must stay under 38,000 EUR.",
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
      "## 2. Store KPIs",
      "Week-2 returners must be at least 31% of installs.",
      "Week-6 returners must be at least 13% of installs.",
      "## 3. Visual Mood",
      "The look must feel calm and warm.",
      "## 4. Rules",
      "The gate must open within 2 s.",
      "The bridge must hold at most 3 carts.",
    ].join("\n");
    const capped = extractRequirementRows(doc, { ...GDD, maxRows: 2 });
    expect(capped.rows.map((r) => r.text)).toEqual(["The gate must open within 2 s.", "The bridge must hold at most 3 carts."]);
    expect(capped.overflow).toEqual({ count: 3, sections: ["Store KPIs", "Visual Mood"] });
  });
});

describe("requirementLedgerFrom — the APPROVED text, never the copy on disk", () => {
  it("reads campaign.gddText even when the document on disk says something else", () => {
    const root = mkdtempSync(join(tmpdir(), "rows-approved-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "gdd.md"), "## 2. Orchard Rules\n| FR-9 | The player must never see this disk-only rule. |\n");
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
          { requirement: "Branches are always pruned in pairs", quote: "Branches are always pruned in pairs along the orchard wall." },
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
          { requirement: "A pruning order covers at most 23 branches", quote: "A pruning order covers at most 23 branches." },
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
    const lines = Array.from({ length: 14 }, (_, i) => `Orchard row number ${i + 1} grows a different apple.`);
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
        { id: "m1", coveredSections: ["Orchard Rules"], prompt: "" },
        { id: "m2", coveredSections: ["Screens"], prompt: "" },
        { id: "m3", coveredSections: ["Performance"], prompt: "" },
      ],
      { atMs: 5 },
    );
    const owned = (prefix: string) => result.rows.find((r) => r.text.startsWith(prefix))!;
    expect(owned("FR-1").owner).toBe("m1");
    expect(owned("FR-1").ownership).toEqual([{ milestoneId: "m1", reason: "covered-section", detail: "Orchard Rules", atMs: 5 }]);
    // An ancestor heading claims a row under a sub-heading.
    expect(owned("Graft time").owner).toBe("m1");
    expect(owned("Results Screen").owner).toBe("m2");
    // Claims are measured at delivery: the final milestone owns them.
    expect(owned("Each round lasts").owner).toBe("m3");
    expect(owned("Each round lasts").ownership[0]!.reason).toBe("final-milestone");
    // Nobody claims Visual Mood: the row is queued, failing closed.
    const look = owned("The look must feel");
    expect(look.owner).toBeUndefined();
    expect(result.queued).toContain(look.rid);
    // An aspiration is excluded, not queued.
    expect(result.queued).not.toContain(owned("Week-2 returners").rid);
    expect(result.byMilestone.m1).toContain(owned("FR-1").rid);
    // The input is not mutated.
    expect(rows.every((r) => r.owner === undefined)).toBe(true);
  });

  it("falls back to the § references of a milestone planned without coveredSections, most specific first", () => {
    const result = assignOwners(
      rows,
      [
        { id: "m1", prompt: "Build the orchard rules of §2 and nothing else." },
        { id: "m2", prompt: "Tune the frost table in §2.1." },
        { id: "m3", prompt: "Ship it (§3)." },
      ],
      { atMs: 5 },
    );
    const owned = (prefix: string) => result.rows.find((r) => r.text.startsWith(prefix))!;
    expect(owned("FR-2").owner).toBe("m1");
    expect(owned("FR-2").ownership[0]).toMatchObject({ reason: "section-reference", detail: "§2" });
    expect(owned("Graft time").owner).toBe("m2");
    expect(owned("Graft time").ownership[0]).toMatchObject({ reason: "section-reference", detail: "§2.1" });
    // §2 does not reach §20-something, and nothing references §5.
    expect(owned("Main Menu").owner).toBeUndefined();
  });

  it("reads a § RANGE as every section between its ends; a single reference is more specific than a range", () => {
    const result = assignOwners(
      rows,
      [
        { id: "m1", prompt: "Orchard rules: §1–§2." },
        { id: "m2", prompt: "Screens and mood (§5.1–§5.2, §6 – 2 passes)." },
        { id: "m3", prompt: "Polish the results screen (§5.2)." },
      ],
      { atMs: 5 },
    );
    const owned = (prefix: string) => result.rows.find((r) => r.text.startsWith(prefix))!;
    expect(owned("Graft time").owner).toBe("m1");
    // §2.1 lies inside §1–§2: a range reaches the subsections of its last chapter.
    expect(owned("Graft time").ownership[0]).toMatchObject({ reason: "section-reference", detail: "§1–§2" });
    // §5.1 lies inside §5.1–§5.2; nothing else names it.
    expect(owned("Main Menu").owner).toBe("m2");
    // §5.2 is inside m2's range, but m3 names it alone.
    expect(owned("Results Screen").owner).toBe("m3");
    expect(owned("Results Screen").ownership[0]).toMatchObject({ detail: "§5.2" });
    // "§6 – 2 passes" is §6, not a range from §6 back to §2.
    expect(owned("The look must feel").owner).toBe("m2");
  });

  it("gives claims to the last PLANNED milestone: a stored ladder ends with coverage sprints and a final proof, which own nothing by plan", () => {
    const ladder = [
      { id: "m1", prompt: "Orchard rules: §1–§2." },
      { id: "m2", prompt: "Performance (§3) and the rest (§4–§6)." },
      { id: "mcov1", prompt: "Close the gaps: the frost table of §2.1 and the mood of §6." },
      { id: "mfinal-4", prompt: "Prove §3 at delivery." },
    ];
    const result = assignOwners(rows, ladder, { atMs: 5 });
    const owned = (prefix: string) => result.rows.find((r) => r.text.startsWith(prefix))!;
    expect(owned("Each round lasts").owner).toBe("m2");
    expect(owned("Each round lasts").ownership[0]!.reason).toBe("final-milestone");
    expect(owned("The game must hold 53 fps").owner).toBe("m2");
    // mcov1 names §2.1 and §6 alone, which would outrank the planned ranges.
    expect(owned("Graft time").owner).toBe("m1");
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
      [{ id: "m1", coveredSections: ["Orchard Rules"], prompt: "" }],
      { excluded: ["Performance: tuned after launch"], atMs: 5 },
    );
    const fps = result.rows.find((r) => r.text.startsWith("The game must hold 53 fps"))!;
    expect(fps.status).toBe("open");
    expect(fps.owner).toBe("m1");
    expect(fps.ownership[0]!.reason).toBe("final-milestone");
    expect(result.excluded).not.toContain(fps.rid);
  });

  it("marks rows under a heading the planner excluded as excluded, with the planner's reason", () => {
    const result = assignOwners(
      rows,
      [{ id: "m1", coveredSections: ["Orchard Rules"], prompt: "" }],
      { excluded: ["Visual Mood: the GDD defers the look to phase two"], atMs: 5 },
    );
    const look = result.rows.find((r) => r.text.startsWith("The look must feel"))!;
    expect(look.status).toBe("excluded");
    expect(look.excludedBecause).toContain("Visual Mood: the GDD defers the look to phase two");
    expect(result.queued).not.toContain(look.rid);
    expect(result.excluded).toContain(look.rid);
  });

  it("an exclusion that only MENTIONS a heading excludes nothing under it: the rows stay owned (fail closed)", () => {
    const result = assignOwners(
      rows,
      [{ id: "m1", coveredSections: ["Orchard Rules"], prompt: "" }],
      { excluded: ["Seasonal events beyond the orchard rules: the GDD defers them past launch"], atMs: 5 },
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
