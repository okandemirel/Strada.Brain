/**
 * One rule for which GDD rows can hold a milestone back (review gdd-W10 P3).
 *
 * The ACCEPTANCE block says it shows "the rows the judge lets decide", and
 * the scope report counts blocking rows by the same rule, but each carried
 * its own copy of the judge's predicate. A status the judge starts treating
 * differently would then show the worker one set of rows and judge it on
 * another. The block and the report read the judge's own predicate, so a
 * change to it moves all three together.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { rowsJudgedFor } from "./acceptance-prompt.js";
import { rowBlocks } from "./scope-report.js";
import type { RequirementLedger, RequirementRow } from "./scope-types.js";
import * as verdict from "./scope-verdict.js";

const judgeRule = vi.hoisted(() => ({ override: undefined as undefined | ((row: { rid: string }) => boolean) }));

vi.mock("./scope-verdict.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.rowDecides as ((row: unknown) => boolean) | undefined;
  return {
    ...actual,
    rowDecides: (row: { rid: string }) => (judgeRule.override ? judgeRule.override(row) : real?.(row) ?? false),
  };
});

afterEach(() => {
  judgeRule.override = undefined;
});

function row(rid: string, over: Partial<RequirementRow> = {}): RequirementRow {
  return {
    rid,
    encoded: rid,
    text: `Row ${rid} of the quay rules.`,
    section: "12.5 Quay rules",
    line: 1,
    span: { start: 0, end: 1 },
    kind: "rule",
    source: "extracted",
    ownership: [],
    status: "open",
    checks: [],
    gddSha256: "a".repeat(64),
    gddRevision: 1,
    owner: "m1",
    ...over,
  };
}

function ledgerOf(rows: RequirementRow[]): RequirementLedger {
  return { version: 1, gddSha256: "a".repeat(64), gddRevision: 1, extractedAtMs: 1, rows, overflow: { count: 0, sections: [] }, numberingGaps: [], llmAdded: 0 };
}

describe("the rows a worker is shown are the rows the judge lets decide", () => {
  it("the judge exports its rule, and it keeps look and feel, aspirations, waived and excluded rows out", () => {
    // Called through the mock with no override, so this is the judge's own rule.
    expect(verdict.rowDecides(row("open"))).toBe(true);
    expect(verdict.rowDecides(row("aspiration", { kind: "aspiration" }))).toBe(false);
    expect(verdict.rowDecides(row("judgement", { kind: "judgement" }))).toBe(false);
    expect(verdict.rowDecides(row("waived", { status: "waived" }))).toBe(false);
    expect(verdict.rowDecides(row("excluded", { status: "excluded" }))).toBe(false);
  });

  it("the ACCEPTANCE block and the scope report follow the judge's rule when it changes", () => {
    // Every row here is an open rule the current rule lets decide; a judge
    // that changes its mind about one of them must change the block and the
    // report with it.
    const keep = row("req-keep");
    const drop = row("req-drop");
    judgeRule.override = (r) => r.rid !== "req-drop";
    expect(rowsJudgedFor(ledgerOf([keep, drop]), { id: "m1" }).map((r) => r.rid)).toEqual(["req-keep"]);
    expect(rowBlocks(keep)).toBe(true);
    expect(rowBlocks(drop)).toBe(false);
  });
});
