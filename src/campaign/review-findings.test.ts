/**
 * The independent review's findings tail, read and applied (GDD-drift plan W13).
 * Pure: the ledger, the approved text and the clock come in as arguments.
 *
 * The GDD wording here is invented.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeRequirement } from "./requirement-identity.js";
import {
  REVIEW_MAX_ADDED_ROWS,
  applyReviewFindings,
  parseReviewFindings,
  reviewGateRecord,
  reviewRowsOf,
  type ReviewFindings,
} from "./review-findings.js";
import { closesByLedger } from "./scope-verdict.js";
import type { RequirementLedger, RequirementRow } from "./scope-types.js";

const REV = "9".repeat(40);
const AT = 1_000_000;

const GDD = [
  "# Kite Post",
  "## Glossary",
  "Updraft — a column of rising air that lifts any kite flying through it.",
  "## 3 Flight",
  "KP-01 A kite gains one metre of height for every second spent inside an updraft.",
  "KP-02 A letter is delivered only when the kite lands on the roof that matches its stamp.",
  "The wind indicator must show the current gust direction",
  "at all times during a delivery.",
  "## 7 Business",
  "Day-7 retention rate must reach at least 20 percent within the first month.",
  "## 8 Towns",
  ...Array.from({ length: 12 }, (_, i) => `Town ${i + 1} must have its own post office with a distinct roof colour.`),
].join("\n");
const SHA = createHash("sha256").update(GDD).digest("hex");

function row(rid: string, label: string | undefined, text: string, fields: Partial<RequirementRow> = {}): RequirementRow {
  const start = GDD.indexOf(text);
  return {
    rid,
    encoded: encodeRequirement({ id: rid, text, lineage: rid, gddSha256: SHA, gddRevision: 1 }),
    ...(label === undefined ? {} : { label }),
    text,
    section: "3 Flight",
    sectionPath: ["3 Flight"],
    sectionNumber: "3",
    line: GDD.slice(0, start).split("\n").length,
    span: { start, end: start + text.length },
    kind: "rule",
    source: "extracted",
    owner: "m1",
    ownership: [{ milestoneId: "m1", reason: "covered-section", atMs: 1 }],
    status: "passing",
    checks: [{ kind: "test", testName: `Strada.Acceptance.M1.Acceptance_M1.R_${rid}`, path: "Assets/StradaAcceptance/Acceptance_M1.cs", bodySha: "a".repeat(64) }],
    last: { revision: REV, atMs: 5, outcome: "pass", detail: "passed in run r1" },
    gddSha256: SHA,
    gddRevision: 1,
    ...fields,
  };
}

const KP1 = "KP-01 A kite gains one metre of height for every second spent inside an updraft.";
const KP2 = "KP-02 A letter is delivered only when the kite lands on the roof that matches its stamp.";

function ledger(rows: RequirementRow[] = [row("req-1-k1", "KP-01", KP1), row("req-2-k2", "KP-02", KP2)]): RequirementLedger {
  return { version: 1, gddSha256: SHA, gddRevision: 1, extractedAtMs: 1, rows, overflow: { count: 0, sections: [] }, numberingGaps: [], llmAdded: 0 };
}

const findings = (fields: Partial<ReviewFindings>): ReviewFindings => ({ found: true, weakChecks: [], missing: [], unreadable: [], ...fields });
const apply = (l: RequirementLedger, f: ReviewFindings, gddText: string | undefined = GDD) => applyReviewFindings(l, f, { gddText, atMs: AT });

describe("parseReviewFindings", () => {
  it("reads the JSON tail after the reviewer's prose", () => {
    const parsed = parseReviewFindings(
      [
        "VERDICT: NOT DELIVERABLE",
        'BLOCKERS: 1. the "wind indicator is missing {see HUD.cs}',
        '{"weakChecks":[{"rid":"req-2-k2","why":"asserts true"}],"missing":[{"gddQuote":"The wind indicator must show the current gust direction","why":"no HUD"}]}',
      ].join("\n"),
    );
    expect(parsed).toEqual({
      found: true,
      weakChecks: [{ rid: "req-2-k2", why: "asserts true" }],
      missing: [{ gddQuote: "The wind indicator must show the current gust direction", why: "no HUD" }],
      unreadable: [],
    });
  });

  it("reads a fenced, pretty-printed tail, and the LAST findings object wins over an example in the prose", () => {
    const parsed = parseReviewFindings(
      [
        'For example {"weakChecks":[{"rid":"req-0-example","why":"example"}]} would name a row.',
        "```json",
        JSON.stringify({ weakChecks: [], missing: [{ gddQuote: "x".repeat(30), why: "y" }] }, null, 2),
        "```",
      ].join("\n"),
    );
    expect(parsed.weakChecks).toEqual([]);
    expect(parsed.missing).toEqual([{ gddQuote: "x".repeat(30), why: "y" }]);
  });

  it("an answer with no tail is found: false; entries of neither shape are unreadable, not dropped", () => {
    expect(parseReviewFindings("VERDICT: DELIVERABLE\nBLOCKERS: none")).toEqual({ found: false, weakChecks: [], missing: [], unreadable: [] });
    const parsed = parseReviewFindings('{"weakChecks":[{"why":"no rid"},"req-1-k1"],"missing":[{"quote":"wrong key"}]}');
    expect(parsed.found).toBe(true);
    expect(parsed.weakChecks).toEqual([]);
    expect(parsed.missing).toEqual([]);
    expect(parsed.unreadable).toHaveLength(3);
  });
});

describe("applyReviewFindings", () => {
  it("a weak check retires its test once, reopens the row, and only a new check passing on a measured revision closes it", () => {
    const before = ledger();
    const snapshot = structuredClone(before);
    const applied = apply(before, findings({ weakChecks: [{ rid: "req-2-k2", why: "asserts true" }, { rid: "KP-02", why: "again, by label" }] }));
    expect(before).toEqual(snapshot);
    expect(applied.reopened.map((r) => r.rid)).toEqual(["req-2-k2"]);
    // The same row named twice in one review is regenerated once.
    expect(applied.disclosed.join("\n")).toContain("this review already retired it");
    const open = applied.ledger.rows.find((r) => r.rid === "req-2-k2")!;
    expect(open.status).toBe("open");
    expect(open.last).toBeUndefined();
    expect(open.checks).toEqual([{ ...before.rows[1]!.checks[0], weak: "asserts true", supersededAtMs: AT }]);
    // Even a pass restored on the same revision cannot close a row whose only test the review retired…
    expect(closesByLedger({ ...open, last: before.rows[1]!.last }, REV)).toBe(false);
    // …and the regenerated test closes it once it has passed on a measured revision.
    const regenerated: RequirementRow = {
      ...open,
      checks: [...open.checks, { kind: "test", testName: "Strada.Acceptance.M1.Acceptance_M1.R_req_2_k2_v2", path: "Assets/StradaAcceptance/Acceptance_M1.cs", bodySha: "b".repeat(64) }],
    };
    expect(closesByLedger(regenerated, REV)).toBe(false);
    expect(closesByLedger({ ...regenerated, status: "passing", last: { revision: REV, atMs: 9, outcome: "pass", detail: "passed in run r2" } }, REV)).toBe(true);
    // The row the review did not name is untouched.
    expect(applied.ledger.rows[0]).toEqual(before.rows[0]);
    expect(reviewGateRecord(applied, "on").reopened).toEqual(["KP-02 (§3) — asserts true"]);
  });

  it("a weak call on a row that never blocks, has no current test, or no such id is disclosed and changes nothing", () => {
    const rows = [
      row("req-1-k1", "KP-01", KP1, { status: "waived", waiver: { userId: "owner", atMs: 1, reason: "cut from scope" } }),
      row("req-2-k2", "KP-02", KP2, { checks: [], status: "open", last: undefined }),
    ];
    const applied = apply(ledger(rows), findings({ weakChecks: [{ rid: "req-1-k1", why: "a" }, { rid: "req-2-k2", why: "b" }, { rid: "req-404", why: "c" }] }));
    expect(applied.reopened).toEqual([]);
    expect(applied.ledger.rows).toEqual(rows);
    const said = applied.disclosed.join("\n");
    expect(said).toContain("a person waived it");
    expect(said).toContain("no current system test");
    expect(said).toContain('"req-404": no GDD row has that id');
  });

  it("a label names a row only when exactly one row carries it", () => {
    const rows = [row("req-1-k1", "KP-01", KP1), row("req-2-k2", "KP-01", KP2)];
    const applied = apply(ledger(rows), findings({ weakChecks: [{ rid: "KP-01", why: "ambiguous" }] }));
    expect(applied.reopened).toEqual([]);
    expect(applied.disclosed[0]).toContain("no GDD row has that id");
  });

  it("a verbatim quote, line breaks aside, becomes a queued review-added row", () => {
    const applied = apply(ledger(), findings({ missing: [{ gddQuote: "The wind indicator must show the current gust direction at all times during a delivery.", why: "no HUD" }] }));
    expect(applied.added).toHaveLength(1);
    const added = applied.added[0]!;
    expect(added).toMatchObject({
      source: "review-added",
      status: "open",
      text: "The wind indicator must show the current gust direction at all times during a delivery.",
      section: "Flight",
      sectionNumber: "3",
      checks: [],
      ownership: [],
      gddSha256: SHA,
      gddRevision: 1,
    });
    expect(added.owner).toBeUndefined();
    expect(applied.ledger.rows.map((r) => r.rid)).toEqual(["req-1-k1", "req-2-k2", added.rid]);
    expect(new Set(applied.ledger.rows.map((r) => r.rid)).size).toBe(3);
    expect(reviewGateRecord(applied, "on").added[0]).toContain("The wind indicator must show the current gust direction");
  });

  it("a paraphrase, a short quote, a known row, apparatus and an aspiration are disclosed only", () => {
    const applied = apply(
      ledger(),
      findings({
        missing: [
          { gddQuote: "the wind arrow should always point where the gust blows", why: "paraphrase" },
          { gddQuote: "Updraft", why: "short" },
          { gddQuote: "A kite gains one metre of height for every second spent inside an updraft.", why: "already a row" },
          { gddQuote: "a column of rising air that lifts any kite flying through it", why: "glossary" },
          { gddQuote: "Day-7 retention rate must reach at least 20 percent within the first month.", why: "kpi" },
        ],
      }),
    );
    expect(applied.added).toEqual([]);
    expect(applied.ledger).toEqual(ledger());
    const said = applied.disclosed.join("\n");
    expect(said).toContain("not verbatim in the approved GDD");
    expect(said).toContain("quote too short");
    expect(said).toContain("duplicate of an existing row (req-1-k1)");
    expect(said).toContain("document apparatus");
    expect(said).toContain("never blocks");
  });

  it("one review adds at most REVIEW_MAX_ADDED_ROWS rows; the rest are disclosed", () => {
    const quotes = Array.from({ length: 12 }, (_, i) => ({ gddQuote: `Town ${i + 1} must have its own post office with a distinct roof colour.`, why: "absent" }));
    const applied = apply(ledger(), findings({ missing: quotes }));
    expect(applied.added).toHaveLength(REVIEW_MAX_ADDED_ROWS);
    expect(applied.disclosed.filter((d) => d.includes(`past the ${REVIEW_MAX_ADDED_ROWS} rows`))).toHaveLength(2);
  });

  it("a quote is read only against the text the rows were read from", () => {
    const amended = `${GDD}\nA storm grounds every kite for 30 seconds.`;
    const applied = apply(ledger(), findings({ missing: [{ gddQuote: "A storm grounds every kite for 30 seconds.", why: "x" }] }), amended);
    expect(applied.added).toEqual([]);
    expect(applied.disclosed[0]).toContain("another text than the approved GDD");
  });

  it("never closes: no finding moves a failing row, and no tail is disclosed", () => {
    const failing = ledger([row("req-1-k1", "KP-01", KP1, { status: "failing", last: { revision: REV, atMs: 5, outcome: "fail", detail: "was 0" } })]);
    const none = apply(failing, findings({ found: false }));
    expect(none.ledger).toBe(failing);
    expect(none.disclosed).toEqual(["the review ended with no findings object, so it reopened and added nothing"]);
    const weak = apply(failing, findings({ weakChecks: [{ rid: "req-1-k1", why: "x" }] }));
    expect(weak.ledger.rows[0]!.status).toBe("open");
    expect(closesByLedger(weak.ledger.rows[0]!, REV)).toBe(false);
  });
});

describe("reviewRowsOf", () => {
  it("lists the rows that can block, with their current test only", () => {
    const rows = [
      row("req-1-k1", "KP-01", KP1, {
        checks: [
          { kind: "test", testName: "Old", path: "p", bodySha: "c", supersededAtMs: 3 },
          { kind: "test", testName: "New", path: "p", bodySha: "d" },
        ],
      }),
      row("req-2-k2", undefined, KP2, { checks: [], sectionNumber: undefined }),
      row("req-3-k3", undefined, "Day-7 retention rate must reach at least 20 percent within the first month.", { kind: "aspiration", status: "excluded" }),
    ];
    expect(reviewRowsOf(ledger(rows))).toEqual([
      { rid: "req-1-k1", label: "KP-01", where: "§3", text: KP1, test: "New" },
      { rid: "req-2-k2", where: "3 Flight", text: KP2 },
    ]);
  });
});
