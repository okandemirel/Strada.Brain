import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Measured live 2026-09-03 23:30: told to "report the suite's actual pass/fail
 * counts", the sprint answered with a JSON inventory — module counts, prefab
 * counts, a scene list — and changed nothing. Both delivery directives must
 * name the verb and forbid the audit escape.
 */
describe("delivery directives", () => {
  const source = readFileSync(new URL("./campaign-manager.ts", import.meta.url), "utf8");

  it("forbid an inventory in the test-verdict directive", () => {
    const start = source.indexOf("DELIVERY VERIFICATION REQUIRED");
    expect(start).toBeGreaterThan(0);
    expect(source.slice(start, start + 1200)).toContain("DO NOT AUDIT");
  });

  it("forbid an inventory in the structural directive", () => {
    const start = source.indexOf("Fix the game, not the report");
    expect(start).toBeGreaterThan(0);
    expect(source.slice(start, start + 600)).toContain("DO NOT AUDIT");
  });
});

/**
 * Codex 2026-09-11 E#1: readPlaymodeRun threw on a record that parsed to
 * `null`, the enclosing best-effort catch swallowed it, and the PREVIOUS
 * attempt's green verdict stayed on the milestone — so an unreadable record
 * delivered the game. Unreadable evidence must clear the verdict.
 */
describe("evidence that cannot be read is not evidence", () => {
  const source = readFileSync(new URL("./campaign-manager.ts", import.meta.url), "utf8");

  it("clears the milestone's test verdict when the evidence read throws", () => {
    const start = source.indexOf("NOT best-effort: leaving the PREVIOUS attempt's verdict");
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 700);
    expect(block).toContain("milestone.testVerdict = undefined;");
    expect(block).toContain("milestone.testVerdictUnfiltered = undefined;");
    expect(block).toContain("milestone.testRunSource = undefined;");
  });
});

/**
 * Codex 2026-09-11 I#3: the queue shrank in one write and the sprints it
 * produced were appended in another. A crash in that window left the gaps in
 * neither the queue nor the ladder — and the round budget could stop the next
 * audit from rediscovering them.
 */
describe("a gap leaves the queue in the same write that schedules it", () => {
  const source = readFileSync(new URL("./campaign-manager.ts", import.meta.url), "utf8");

  it("does not persist the shortened queue before the milestones exist", () => {
    const at = source.indexOf("const queued = campaign.pendingCoverageGaps ?? [];");
    expect(at).toBeGreaterThan(0);
    const drain = source.slice(at, source.indexOf("return take.map(", at));
    expect(drain).toContain("campaign.pendingCoverageGaps = rest.length > 0 ? rest : undefined;");
    expect(drain).not.toContain("this.persist(campaign);");

    // …and the audit's overflow is queued the same way.
    const overflowAt = source.indexOf("campaign.pendingCoverageGaps = overflow;");
    expect(overflowAt).toBeGreaterThan(0);
    expect(source.slice(overflowAt, overflowAt + 500)).not.toContain("this.persist(campaign);");

    // The CALLER commits both together.
    const callerAt = source.indexOf("campaign.milestones.push(...remediation);");
    expect(callerAt).toBeGreaterThan(0);
    expect(source.slice(callerAt, callerAt + 200)).toContain("this.persist(campaign);");
  });
});
