/**
 * What the settle path does with a scope verdict (GDD-drift plan W09): the
 * pure half — the next step, the bounce text, the time-box split, the worker's
 * dispute lines, and the final milestone's missing proofs. Invented rows only.
 */

import { describe, expect, it } from "vitest";
import { UNMEASURABLE_PROOF_RE } from "./campaign-manager.js";
import {
  FAILED_NAMES_CAP,
  SCOPE_CHECKS_FAULTED_PROOF,
  SCOPE_GATE_MARKER,
  SCOPE_NOT_ADMITTED_PROOF,
  endedOnOutage,
  failsOnlyOnAcceptance,
  infrastructureOnly,
  nextScopeAction,
  parseWorkerLines,
  publicationLost,
  scopeBounceText,
  scopeDeliveryProofs,
  timeBoxSplit,
  withoutScopeBlock,
  writerFaultClass,
} from "./scope-settle.js";
import { judgeMilestone } from "./scope-verdict.js";
import type { GreenInput, GreenReason, Judgement, RequirementRow } from "./scope-types.js";
import type { RunIntegrity, TerminalKey } from "../agents/autonomy/terminal-key.js";

function row(label: string, start: number, last?: RequirementRow["last"]): RequirementRow {
  return {
    rid: `req-${String(start).padStart(3, "0")}-abcdef${start}`,
    encoded: label,
    label,
    text: `${label}: the lantern must glow when the ferry docks.`,
    section: "Core Rules",
    line: start,
    span: { start, end: start + 10 },
    kind: "rule",
    source: "extracted",
    ownership: [],
    status: "open",
    checks: [],
    ...(last ? { last } : {}),
    gddSha256: "sha",
    gddRevision: 1,
  };
}

const red = (detail: string, extra: Partial<GreenReason> = {}): GreenReason => ({ reasonClass: "red", code: "row-failing", detail, ...extra });
const notGreen = (state: "red" | "unmeasurable" | "check-fault", reasons: GreenReason[]): Judgement => ({ green: false, state, reasons });

describe("failsOnlyOnAcceptance", () => {
  it("is true only for a complete list of acceptance names under the cap", () => {
    const names = ["Strada.Acceptance.M1.Acceptance_M1.R001_aaaaaa", "Strada.Acceptance.M1.Acceptance_M1.R002_bbbbbb"];
    expect(failsOnlyOnAcceptance(names, 0)).toBe(true);
    expect(failsOnlyOnAcceptance(names, undefined)).toBe(true);
    expect(failsOnlyOnAcceptance([...names, "Ferry.Tests.Dock.Opens"], 0)).toBe(false);
    expect(failsOnlyOnAcceptance(names, 1)).toBe(false);
    expect(failsOnlyOnAcceptance([], 0)).toBe(false);
    expect(failsOnlyOnAcceptance(undefined, 0)).toBe(false);
    const capped = Array.from({ length: FAILED_NAMES_CAP }, (_, i) => `Strada.Acceptance.M1.Acceptance_M1.R${i}_x`);
    expect(failsOnlyOnAcceptance(capped, 0)).toBe(false);
  });
});

describe("how the run ended", () => {
  const integrity = (keys: TerminalKey[], infrastructureErrors?: number): RunIntegrity & { infrastructureErrors?: number } => ({
    terminalKeys: keys,
    worst: keys[0]!,
    source: "spine",
    workerModels: [],
    ...(infrastructureErrors === undefined ? {} : { infrastructureErrors }),
  });

  it("an error the node bridge threw is the machinery's; one of the worker's own, or a red key beside it, is not", () => {
    expect(infrastructureOnly(integrity(["error"], 1), "")).toBe(true);
    expect(infrastructureOnly(integrity(["error", "done"], 1), "")).toBe(true);
    expect(infrastructureOnly(integrity(["error"]), "")).toBe(false);
    expect(infrastructureOnly(integrity(["error", "error"], 1), "")).toBe(false);
    expect(infrastructureOnly(integrity(["error", "task_stuck"], 1), "")).toBe(false);
    expect(infrastructureOnly(integrity(["done"]), "")).toBe(false);
  });

  it("a lost publication counts as the machinery's (the executor's own stamp)", () => {
    const stamp = "PUBLICATION FAILED: the workspace commit threw before the work reached the project (EIO). The workspace is kept for salvage.";
    expect(publicationLost(stamp)).toBe(true);
    expect(publicationLost(`Done.\n\n${stamp}`)).toBe(true);
    expect(publicationLost("I wrote a note saying PUBLICATION FAILED: maybe")).toBe(false);
    expect(infrastructureOnly(integrity(["error"]), stamp)).toBe(true);
    expect(infrastructureOnly(undefined, stamp)).toBe(true);
    expect(infrastructureOnly(integrity(["error", "max_steps_reached"]), stamp)).toBe(false);
  });

  it("an outage is the worst key only when no red key is there", () => {
    expect(endedOnOutage(integrity(["provider_quota"]))).toBe(true);
    expect(endedOnOutage(integrity(["provider_abort", "done"]))).toBe(true);
    expect(endedOnOutage(integrity(["provider_quota", "task_stuck"]))).toBe(false);
    expect(endedOnOutage(undefined)).toBe(false);
  });
});

describe("writerFaultClass (W06's causes)", () => {
  it("an outage of the writer is unmeasurable; every other cause is a check fault; neither is red", () => {
    expect(writerFaultClass("call-failed")).toBe("unmeasurable");
    expect(writerFaultClass("no-writer")).toBe("unmeasurable");
    for (const cause of ["lint", "unparseable", "missing", "no-row", "budget"] as const) expect(writerFaultClass(cause)).toBe("check-fault");
  });
});

describe("parseWorkerLines", () => {
  it("reads disputes from the end of the report, one per target", () => {
    const report = [
      "Implemented the dock.",
      "ACCEPTANCE DISPUTE req-002-abcdef: the GDD says only lit piers, the check also requires a lantern",
      "- ACCEPTANCE DISPUTE Strada.Acceptance.M1.Acceptance_M1.R003_ccc: it times out before the ferry arrives",
      "ACCEPTANCE DISPUTE req-002-abcdef: second thoughts — the check boots the wrong scene",
    ].join("\n");
    const { disputes } = parseWorkerLines(report);
    expect(disputes).toEqual([
      { target: "req-002-abcdef", reason: "second thoughts — the check boots the wrong scene" },
      { target: "Strada.Acceptance.M1.Acceptance_M1.R003_ccc", reason: "it times out before the ferry arrives" },
    ]);
  });

  it("ignores a dispute buried before the last fifty lines", () => {
    const report = ["ACCEPTANCE DISPUTE req-001-x: early", ...Array.from({ length: 60 }, (_, i) => `line ${i}`)].join("\n");
    expect(parseWorkerLines(report).disputes).toEqual([]);
  });
});

describe("timeBoxSplit", () => {
  it("keeps ⌈n/2⌉ of the rows that do not pass, in GDD order; passing rows stay out of it", () => {
    const pass = { revision: "r", atMs: 1, outcome: "pass" as const, detail: "" };
    const fail = { revision: "r", atMs: 1, outcome: "fail" as const, detail: "" };
    const rows = [row("EF-6", 60, fail), row("EF-1", 10, pass), row("EF-3", 30, fail), row("EF-2", 20, pass), row("EF-4", 40, fail), row("EF-5", 50)];
    const { kept, moved } = timeBoxSplit(rows);
    expect(kept.map((r) => r.label)).toEqual(["EF-3", "EF-4"]);
    expect(moved.map((r) => r.label)).toEqual(["EF-5", "EF-6"]);
  });
});

describe("nextScopeAction", () => {
  const budgets = { bounces: 0, maxBounces: 2, resubmits: 0 };

  it("red: a free bounce, a charged one, then park", () => {
    const j = notGreen("red", [red("EF-2 fails")]);
    expect(nextScopeAction(j, budgets)).toEqual({ kind: "bounce", countAttempt: false });
    expect(nextScopeAction(j, { ...budgets, bounces: 1 })).toEqual({ kind: "bounce", countAttempt: true });
    expect(nextScopeAction(j, { ...budgets, bounces: 2 })).toEqual({ kind: "park" });
  });

  it("a check fault that survived its repair parks; an outage takes the outage path", () => {
    expect(nextScopeAction(notGreen("check-fault", [{ reasonClass: "check-fault", code: "row-check-fault", detail: "x" }]), budgets)).toEqual({ kind: "park" });
    const outage: GreenReason = { reasonClass: "unmeasurable", code: "terminal", detail: "quota", terminal: "provider_quota" };
    expect(nextScopeAction(notGreen("unmeasurable", [outage]), { ...budgets, resubmits: 5 })).toEqual({ kind: "outage" });
  });

  it("unmeasurable: an unbound row's round is free and does not spend the resubmit; a machine reason resubmits once, then parks", () => {
    const unbound: GreenReason = { reasonClass: "unmeasurable", code: "row-unbound", detail: "the pier", rid: "r1" };
    expect(nextScopeAction(notGreen("unmeasurable", [unbound]), { ...budgets, resubmits: 1 })).toEqual({ kind: "resubmit-uncharged", why: "unbound" });
    const refused: GreenReason = { reasonClass: "unmeasurable", code: "run-not-admitted", detail: "no runner" };
    expect(nextScopeAction(notGreen("unmeasurable", [refused]), budgets)).toEqual({ kind: "resubmit-uncharged", why: "unmeasurable" });
    expect(nextScopeAction(notGreen("unmeasurable", [refused]), { ...budgets, resubmits: 1 })).toEqual({ kind: "park" });
  });

  it("green advances", () => {
    expect(nextScopeAction({ green: true, basis: "proven", caveats: [] }, budgets)).toEqual({ kind: "advance" });
  });
});

describe("scopeBounceText", () => {
  it("names each failing row, its test and what the check said, and how to dispute; one block per prompt", () => {
    const j = notGreen("red", [
      red('EF-2 (§2, line 8): "EF-2: A rider must board only from a lit pier." fails on abc: expected lit', { rid: "r2", testName: "Strada.Acceptance.M1.Acceptance_M1.R002_x" }),
      { reasonClass: "unmeasurable", code: "row-unbound", detail: "the pier the ferry is docked at", rid: "r1" },
    ]) as Extract<Judgement, { green: false }>;
    const text = scopeBounceText(j, "abcdef1234567890", new Map([["Strada.Acceptance.M1.Acceptance_M1.R002_x", "Expected: lit But was: dark"]]));
    expect(text.startsWith(SCOPE_GATE_MARKER)).toBe(true);
    expect(text).toContain("EF-2: A rider must board only from a lit pier.");
    expect(text).toContain("[test Strada.Acceptance.M1.Acceptance_M1.R002_x]");
    expect(text).toContain("Expected: lit But was: dark");
    expect(text).toContain("Make this observable through a public type or service: the pier the ferry is docked at");
    expect(text).toContain("ACCEPTANCE DISPUTE <test name or row id>: <why>");
    expect(text).toContain("abcdef12");
    const prompt = `do the work${text}`;
    expect(withoutScopeBlock(prompt)).toBe("do the work");
    expect(`${withoutScopeBlock(prompt)}${text}`.split(SCOPE_GATE_MARKER)).toHaveLength(2);
  });
});

describe("the final milestone's missing proofs", () => {
  it("names the failing rows, the check faults and a refused run, in words the delivery budget can classify", () => {
    const r1 = row("EF-1", 10);
    const r2 = row("EF-2", 20);
    const verdict = notGreen("red", [
      red("EF-1 fails", { rid: r1.rid }),
      { reasonClass: "unmeasurable", code: "run-not-admitted", detail: "the acceptance run was not admitted (no-runner)" },
    ]);
    const proofs = scopeDeliveryProofs({ verdict, revision: "0123456789abcdef", rows: [r1, r2], checkFaultRows: [r2] });
    expect(proofs.rowsFailing).toBe(true);
    expect(proofs.checksFaulted).toBe(true);
    expect(proofs.unmeasured).toBe(true);
    expect(proofs.proofs[0]).toMatch(/^1 GDD row\(s\) not passing on 01234567: EF-1/);
    expect(proofs.proofs.some((p) => p.startsWith(SCOPE_NOT_ADMITTED_PROOF))).toBe(true);
    expect(proofs.proofs.some((p) => p.startsWith(SCOPE_CHECKS_FAULTED_PROOF) && p.includes("EF-2"))).toBe(true);
    // A check nobody could make work, and a run the system could not admit, revive twice and then ask a person;
    // a failing row is the game's and does not.
    expect(UNMEASURABLE_PROOF_RE.test(proofs.proofs.find((p) => p.startsWith(SCOPE_CHECKS_FAULTED_PROOF))!)).toBe(true);
    expect(UNMEASURABLE_PROOF_RE.test(proofs.proofs.find((p) => p.startsWith(SCOPE_NOT_ADMITTED_PROOF))!)).toBe(true);
    expect(UNMEASURABLE_PROOF_RE.test(proofs.proofs[0]!)).toBe(false);
  });

  it("a green final milestone holds nothing back but the check faults left elsewhere", () => {
    expect(scopeDeliveryProofs({ verdict: { green: true, basis: "proven", caveats: [] }, revision: "r", rows: [], checkFaultRows: [] }).proofs).toEqual([]);
  });
});

describe("tamper is worded for who has to act (W05-3 / W09)", () => {
  const base = (tamper: string[]): GreenInput => ({
    milestoneId: "m1",
    mode: "on",
    revision: "rev1",
    compile: { ran: true, ok: true },
    tamper,
    own: [],
    regression: [],
    results: {},
    sources: [],
    integrity: { terminalKeys: ["done"], worst: "done", source: "spine", workerModels: [] },
    gates: { visualEvidence: "pass", noWork: "pass", art: "pass", prosOnly: "pass" },
    proseFailure: false,
  });

  it("a restored system file and a worker's file outside the folder are two findings with two instructions", () => {
    const j = judgeMilestone(base(["Assets/StradaAcceptance/Acceptance_M1.cs", "Assets/Game/Spoof.cs", "Packages/x/Spoof.asmref"]));
    expect(j.green).toBe(false);
    const tamper = (j as Extract<Judgement, { green: false }>).reasons.filter((r) => r.code === "tamper");
    expect(tamper).toHaveLength(2);
    expect(tamper[0]!.detail).toMatch(/restored to the system's bytes: Assets\/StradaAcceptance\/Acceptance_M1\.cs$/);
    expect(tamper[1]!.detail).toMatch(/outside Assets\/StradaAcceptance could answer for a system check/);
    expect(tamper[1]!.detail).toMatch(/until they are removed: Assets\/Game\/Spoof\.cs, Packages\/x\/Spoof\.asmref$/);
    expect(tamper[1]!.detail).not.toContain("Acceptance_M1.cs");
    expect(tamper.every((r) => r.reasonClass === "red")).toBe(true);
  });

  it("only a worker's file: no sentence claims anything was restored", () => {
    const j = judgeMilestone(base(["Assets/Game/Spoof.cs"])) as Extract<Judgement, { green: false }>;
    expect(j.reasons.filter((r) => r.code === "tamper")).toHaveLength(1);
    expect(j.reasons[0]!.detail).not.toMatch(/restored/);
  });
});
