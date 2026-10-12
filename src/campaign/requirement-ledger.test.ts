/**
 * The pure half of the ledger's life (GDD-drift plan W11): what an amendment
 * keeps, reopens and retires; which queued requirements a row may answer
 * for; a replanned ladder; a model pass that could not run. Invented
 * documents only.
 */

import { describe, expect, it } from "vitest";
import { encodeRequirement, decodeRequirement } from "./requirement-identity.js";
import {
  adoptInFlightIdentities,
  buildLedger,
  completeLedgerByModel,
  modelPassOwed,
  reownLedger,
  rereadLedger,
} from "./requirement-ledger.js";
import type { RequirementLedger, RequirementRow } from "./scope-types.js";

const DOC = [
  "# Tide Keeper — Design",
  "",
  "## 1. World",
  "The lighthouse keeper lives on a rock between two harbours at the edge of the map.",
  "",
  "## 2. Rules",
  "TK-1: The keeper must refill the lamp before the tide turns.",
  "TK-2: A full lamp must burn for 90 seconds.",
  "TK-3: At most 3 ships may wait at the rock.",
  "",
  "## 3. Extras",
  "The fog horn must sound when a ship is within 2 tiles.",
  "",
].join("\n");

const LADDER = [
  { id: "m1", coveredSections: ["Rules"] },
  { id: "m2", coveredSections: ["Extras"] },
];

const options = { atMs: 1_000 };
const gddOf = (text: string, revision: number) => ({ gddText: text, gddSha256: `${revision}`.repeat(64).slice(0, 64), gddRevision: revision });

function ledgerOf(text = DOC): RequirementLedger {
  const built = buildLedger(gddOf(text, 1), LADDER, options);
  if (!built) throw new Error("no ledger");
  return built.ledger;
}

const byLabel = (rows: readonly RequirementRow[], label: string): RequirementRow => {
  const row = rows.find((r) => r.label === label);
  if (!row) throw new Error(`no ${label}`);
  return row;
};

describe("rereadLedger", () => {
  it("drops a waiver whose ask changed, keeps one whose wording only moved, and retires what the document lost", () => {
    const ledger = ledgerOf();
    for (const label of ["TK-1", "TK-2"]) {
      const row = byLabel(ledger.rows, label);
      row.status = "waived";
      row.waiver = { userId: "owner", atMs: 5, reason: "deferred" };
    }
    const amended = DOC.replace("TK-1: The keeper must refill the lamp before the tide turns.", "TK-1: the keeper MUST refill the lamp, before the tide turns")
      .replace("TK-2: A full lamp must burn for 90 seconds.", "TK-2: A full lamp must burn for 120 seconds.")
      .replace("TK-3: At most 3 ships may wait at the rock.\n", "");

    const result = rereadLedger(ledger, amended, { gddSha256: "b".repeat(64), gddRevision: 2 }, LADDER, { atMs: 2_000 });

    expect(byLabel(result.ledger.rows, "TK-1")).toMatchObject({ status: "waived", waiver: { reason: "deferred" }, owner: "m1" });
    const tk2 = byLabel(result.ledger.rows, "TK-2");
    expect(tk2.status).toBe("open");
    expect(tk2.waiver).toBeUndefined();
    expect(result.waiversDropped.map((r) => r.label)).toEqual(["TK-2"]);
    expect(result.retired.map((r) => r.label)).toEqual(["TK-3"]);
    expect(result.ledger.rows.some((r) => r.label === "TK-3")).toBe(false);
    expect(result.cosmetic).toBe(1);
    expect(result.reopened.map((r) => r.label)).toEqual(["TK-2"]);
  });

  it("keeps a model-added row whose quote is still in the document, bound to the new revision, and owes the model pass again", async () => {
    const quote = "The lighthouse keeper lives on a rock between two harbours at the edge of the map.";
    const first = await completeLedgerByModel(
      ledgerOf(),
      DOC,
      async () => JSON.stringify({ rows: [{ requirement: "the keeper lives on a rock between two harbours", quote }] }),
      LADDER,
      options,
    );
    expect(first.ledger.llmAdded).toBe(1);
    expect(modelPassOwed(first.ledger)).toBe(false);
    const amended = DOC.replace("TK-2: A full lamp must burn for 90 seconds.", "TK-2: A full lamp must burn for 75 seconds.");

    const result = rereadLedger(first.ledger, amended, { gddSha256: "c".repeat(64), gddRevision: 2 }, LADDER, { atMs: 2_000 });

    const kept = result.ledger.rows.find((r) => r.source === "llm-added");
    expect(kept?.text).toBe(quote);
    expect(kept?.gddRevision).toBe(2);
    expect(decodeRequirement(kept!.encoded).identity?.gddRevision).toBe(2);
    expect(amended.slice(kept!.span.start, kept!.span.end)).toBe(quote);
    expect(result.ledger.llmAdded).toBe(1);
    expect(modelPassOwed(result.ledger)).toBe(true);
  });
});

describe("adoptInFlightIdentities", () => {
  it("adopts only an identity-bearing requirement with the same content, never one that shares a subject or carries no identity", () => {
    const rows = ledgerOf().rows;
    const tk1 = byLabel(rows, "TK-1");
    const tk3 = byLabel(rows, "TK-3");
    const sameContent = encodeRequirement({ id: "req-777-aaaaaaaaaaaa", text: "tk-1: the keeper must refill the lamp before the tide turns", lineage: "req-700-bbbbbbbbbbbb" });
    const sameSubject = encodeRequirement({ id: "req-778-cccccccccccc", text: "TK-3: absent", lineage: "req-778-cccccccccccc" });
    const legacy = "TK-2: A full lamp must burn for 90 seconds.";

    const out = adoptInFlightIdentities(rows, [sameContent, sameSubject, legacy], { gddSha256: "a".repeat(64), gddRevision: 1 });

    expect(out.adopted).toBe(1);
    const adopted = byLabel(out.rows, "TK-1");
    expect(adopted.rid).toBe("req-777-aaaaaaaaaaaa");
    expect(adopted.text).toBe(tk1.text);
    expect(decodeRequirement(adopted.encoded).identity).toMatchObject({ lineage: "req-700-bbbbbbbbbbbb", gddRevision: 1 });
    expect(byLabel(out.rows, "TK-3").rid).toBe(tk3.rid);
    expect(byLabel(out.rows, "TK-2").rid).toBe(byLabel(rows, "TK-2").rid);
  });
});

describe("reownLedger", () => {
  it("a new ladder owns the rows again and lifts the old plan's exclusions, keeping results and waivers", () => {
    const built = buildLedger(gddOf(DOC, 1), LADDER, { ...options, excluded: ["Extras: post-launch"] });
    const ledger = built!.ledger;
    const horn = ledger.rows.find((r) => r.text.startsWith("The fog horn"))!;
    expect(horn.status).toBe("excluded");
    const tk1 = byLabel(ledger.rows, "TK-1");
    tk1.status = "passing";
    tk1.last = { revision: "r", atMs: 3, outcome: "pass", detail: "ok" };

    const replanned = reownLedger(ledger, [{ id: "m1", coveredSections: ["Extras"] }, { id: "m2", coveredSections: ["Rules"] }], { atMs: 4_000 });

    expect(byLabel(replanned.rows, "TK-1")).toMatchObject({ owner: "m2", status: "passing", last: { outcome: "pass" } });
    expect(byLabel(replanned.rows, "TK-1").ownership.map((o) => o.milestoneId)).toEqual(["m1", "m2"]);
    const lifted = replanned.rows.find((r) => r.text.startsWith("The fog horn"))!;
    expect(lifted).toMatchObject({ owner: "m1", status: "open" });
    expect(lifted.excludedBecause).toBeUndefined();
  });
});

describe("completeLedgerByModel", () => {
  it("a pass whose every call failed adds nothing and stays owed", async () => {
    const ledger = ledgerOf();
    const pass = await completeLedgerByModel(ledger, DOC, async () => { throw new Error("provider down"); }, LADDER, options);
    expect(pass.ran).toBe(false);
    expect(pass.ledger).toBe(ledger);
    expect(modelPassOwed(pass.ledger)).toBe(true);
  });
});
