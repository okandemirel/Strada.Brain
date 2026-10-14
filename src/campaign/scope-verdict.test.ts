/**
 * The scope gate's pure judge (GDD-drift plan W08).
 *
 * In a measured campaign every milestone went green on prose. The judge is
 * the replacement's one decision: green only when the milestone's own GDD
 * rows and every row that passed before pass the system's checks, in one run
 * the system admitted, on the committed revision — and the run ended `done`
 * unless independent checks proved the scope anyway.
 *
 * Every table here runs in both directions: a real red stays red, unmeasured
 * never reads as a pass, an outage is never charged, and an outage always
 * yields to any red reason.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getResilienceMessage } from "../agents/resilience-messages.js";
import {
  OUTAGE_TERMINALS,
  RED_TERMINALS,
  TERMINAL_KEYS,
  type RunIntegrity,
  type TerminalKey,
} from "../agents/autonomy/terminal-key.js";
import type {
  AcceptanceRefusalKind,
  AcceptanceRunResult,
  AcceptanceSource,
  CompletionGate,
  GateOutcome,
  GreenInput,
  Judgement,
  ReasonClass,
  RequirementRow,
  RowOutcome,
  RowResult,
  WriterIndependence,
} from "./scope-types.js";
import {
  attributeRun,
  closesByLedger,
  judgeMilestone,
  legacyRunIntegrity,
  terminalReasonClass,
  type ExpectedAcceptanceTest,
} from "./scope-verdict.js";

// =============================================================================
// FIXTURES
// =============================================================================

const REV = "rev-committed-0001";
const OTHER_REV = "rev-earlier-0000";
const FILE = "Assets/StradaAcceptance/M1/Acceptance_M1.cs";
const OTHER_FILE = "Assets/StradaAcceptance/M2/Acceptance_M2.cs";
const testName = (rid: string): string => `Strada.Acceptance.M1.Acceptance_M1.R_${rid}`;

function row(rid: string, over: Partial<RequirementRow> = {}): RequirementRow {
  return {
    rid,
    encoded: `The rule ${rid} must hold. ⟦${rid}⟧`,
    text: `The rule ${rid} must hold.`,
    section: "Kiln rules",
    sectionNumber: "21.4",
    line: 42,
    span: { start: 0, end: 10 },
    kind: "rule",
    source: "extracted",
    ownership: [],
    status: "open",
    checks: [{ kind: "test", testName: testName(rid), path: FILE, bodySha: `body-${rid}` }],
    gddSha256: "gdd-sha",
    gddRevision: 1,
    ...over,
  };
}

function source(
  rids: readonly string[],
  independence: WriterIndependence = "different-model",
  model = "writer-model",
): AcceptanceSource {
  return {
    milestoneId: "m1",
    path: FILE,
    sha256: "file-sha",
    source: "// system-rendered C#",
    writer: { provider: "writer-provider", model, independence },
    revisions: 1,
    tests: rids.map((rid) => ({ rid, testName: testName(rid), bodySha: `body-${rid}` })),
  };
}

function result(outcome: RowOutcome, over: Partial<RowResult> = {}): RowResult {
  return { revision: REV, runId: "run-1", atMs: 1, outcome, detail: `${outcome} detail`, ...over };
}

function run(over: Partial<AcceptanceRunResult> = {}): AcceptanceRunResult {
  return {
    admitted: true,
    runId: "run-1",
    revision: REV,
    expected: [],
    total: 0,
    failedNames: [],
    unattributed: 0,
    flaky: [],
    acceptanceCompileErrors: [],
    tamper: [],
    failures: [],
    ...over,
  };
}

function integrity(worst: TerminalKey, over: Partial<RunIntegrity> = {}): RunIntegrity {
  return { terminalKeys: [worst], worst, source: "spine", workerModels: ["worker-model"], ...over };
}

const GATES: readonly CompletionGate[] = ["visualEvidence", "noWork", "art", "prosOnly"];
const gates = (outcome: GateOutcome = "pass"): Record<CompletionGate, GateOutcome> =>
  ({ visualEvidence: outcome, noWork: outcome, art: outcome, prosOnly: outcome });

/** Everything passes: two owned rows, both checked by a model that did not work on the milestone. */
function input(over: Partial<GreenInput> = {}): GreenInput {
  const own = over.own ?? [row("r1"), row("r2")];
  const regression = over.regression ?? [];
  return {
    milestoneId: "m1",
    mode: "on",
    revision: REV,
    compile: { ran: true, ok: true },
    tamper: [],
    own,
    regression,
    results: Object.fromEntries([...own, ...regression].map((r) => [r.rid, result("pass")])),
    run: run(),
    sources: [source([...own, ...regression].map((r) => r.rid))],
    integrity: integrity("done"),
    gates: gates(),
    proseFailure: false,
    ...over,
  };
}

/** A milestone that owns no rows, with nothing to regress. */
function vacuous(over: Partial<GreenInput> = {}): GreenInput {
  return input({ own: [], regression: [], results: {}, sources: [], run: undefined, ...over });
}

function notGreen(j: Judgement): Extract<Judgement, { green: false }> {
  if (j.green) throw new Error(`expected not green, got green (${j.basis}; ${j.caveats.join(" | ")})`);
  return j;
}

function greenOf(j: Judgement): Extract<Judgement, { green: true }> {
  if (!j.green) throw new Error(`expected green, got ${j.state}: ${j.reasons.map((r) => `${r.code} ${r.detail}`).join(" | ")}`);
  return j;
}

const REFUSALS: readonly AcceptanceRefusalKind[] = [
  "no-runner",
  "no-assembly",
  "lock",
  "no-record",
  "foreign-record",
  "count-mismatch",
  "skipped",
  "tree-moved",
  "runner-error",
];

// =============================================================================
// THE RULE
// =============================================================================

describe("judgeMilestone — section 1's rule", () => {
  it("positive control: every owned row passing in an admitted run on the committed revision, run ended done, is green and proven", () => {
    const j = greenOf(judgeMilestone(input()));
    expect(j.basis).toBe("proven");
    expect(j.caveats).toEqual([]);
  });

  it("one case per reason: each blocks green with its class and code", () => {
    const cases: Array<[string, GreenInput, ReasonClass, string]> = [
      ["the compile was not measured", input({ compile: { ran: false, ok: false, detail: "no verifier" } }), "unmeasurable", "compile-not-run"],
      ["a compile that ran and says ok:true is still not run when ran is false", input({ compile: { ran: false, ok: true } }), "unmeasurable", "compile-not-run"],
      ["the compile failed", input({ compile: { ran: true, ok: false, detail: "3 errors" } }), "red", "compile-failed"],
      ["an acceptance file was tampered with before the commit", input({ tamper: [FILE] }), "red", "tamper"],
      ["an acceptance file was tampered with before the run", input({ run: run({ tamper: [FILE] }) }), "red", "tamper"],
      ["no acceptance run was taken", input({ run: undefined }), "unmeasurable", "run-not-admitted"],
      ["the run measured another revision", input({ run: run({ revision: OTHER_REV }) }), "unmeasurable", "run-not-admitted"],
      ["the run counted failures no name accounts for", input({ run: run({ unattributed: 3 }) }), "unmeasurable", "row-unmeasured"],
      ["an owned row failed", input({ results: { r1: result("fail"), r2: result("pass") } }), "red", "row-failing"],
      ["an owned row's check is flaky", input({ results: { r1: result("flaky"), r2: result("pass") } }), "check-fault", "row-flaky"],
      ["an owned row's check is at fault", input({ results: { r1: result("check-fault"), r2: result("pass") } }), "check-fault", "row-check-fault"],
      ["an owned row did not run", input({ results: { r1: result("not-run"), r2: result("pass") } }), "unmeasurable", "row-not-run"],
      ["an owned row was not measured", input({ results: { r1: result("unmeasured"), r2: result("pass") } }), "unmeasurable", "row-unmeasured"],
      ["an owned row has no result at all", input({ results: { r2: result("pass") } }), "unmeasurable", "row-not-run"],
      ["an owned row passed on another revision only", input({ results: { r1: result("pass", { revision: OTHER_REV }), r2: result("pass") } }), "unmeasurable", "row-not-run"],
      [
        "an owned row has no system check",
        input({ own: [row("r1", { checks: [] }), row("r2")], sources: [source(["r2"])], results: { r2: result("pass") } }),
        "check-fault",
        "row-no-check",
      ],
      ["the run ended stuck and the checks were written by the worker's model", input({ integrity: integrity("task_stuck"), sources: [source(["r1", "r2"], "same-model")] }), "red", "terminal"],
    ];
    for (const [name, given, state, code] of cases) {
      const j = notGreen(judgeMilestone(given));
      expect(j.state, name).toBe(state);
      expect(j.reasons.map((r) => r.code), name).toContain(code);
    }
  });

  it("every refusal of the run is unmeasurable, never charged, and never a pass", () => {
    for (const kind of REFUSALS) {
      const j = notGreen(judgeMilestone(input({ run: run({ admitted: false, refusal: { kind, detail: `${kind} detail` } }) })));
      expect(j.state, kind).toBe("unmeasurable");
      const reason = j.reasons.find((r) => r.code === "run-not-admitted");
      expect(reason?.detail, kind).toContain(kind);
    }
    // A tree that moved during the run measured nothing about the committed revision.
    const moved = notGreen(judgeMilestone(input({ run: run({ admitted: false, refusal: { kind: "tree-moved", detail: "HEAD moved" } }) })));
    expect(moved.state).toBe("unmeasurable");
  });

  it("unmeasured never reads as a pass: every outcome but pass, a missing result and a stale pass all block green", () => {
    const outcomes: RowOutcome[] = ["fail", "flaky", "not-run", "check-fault", "unmeasured"];
    for (const outcome of outcomes) {
      expect(judgeMilestone(input({ results: { r1: result(outcome), r2: result("pass") } })).green, outcome).toBe(false);
      expect(judgeMilestone(input({ regression: [row("g1")], results: { r1: result("pass"), r2: result("pass"), g1: result(outcome) } })).green, `regression ${outcome}`).toBe(false);
    }
    expect(judgeMilestone(input({ results: {} })).green).toBe(false);
    expect(judgeMilestone(input({ results: { r1: result("pass", { revision: OTHER_REV }), r2: result("pass") } })).green).toBe(false);
    // An outcome nobody defined is not a pass either.
    const bogus = { ...result("pass"), outcome: "passed" as unknown as RowOutcome };
    expect(judgeMilestone(input({ results: { r1: bogus, r2: result("pass") } })).green).toBe(false);
    // Passes taken from a run that was not admitted are not passes.
    for (const kind of REFUSALS) {
      expect(judgeMilestone(input({ run: run({ admitted: false, refusal: { kind, detail: "" } }) })).green, kind).toBe(false);
    }
  });

  it("a real red stays red: a failing row is red whatever else is unmeasured, faulted or outaged", () => {
    const failing = { r1: result("fail", { detail: "Expected 57 but was 38" }), r2: result("unmeasured") };
    const variants: Array<[string, Partial<GreenInput>]> = [
      ["alone", {}],
      ["with an unmeasured compile", { compile: { ran: false, ok: false } }],
      ["with a flaky sibling", { results: { ...failing, r2: result("flaky") } }],
      ["with a check-less sibling", { own: [row("r1"), row("r2", { checks: [] })], sources: [source(["r1"])] }],
      ["with a run that counted more failures than it named", { run: run({ unattributed: 2 }) }],
      ...[...OUTAGE_TERMINALS].map((k): [string, Partial<GreenInput>] => [`with the outage key ${k}`, { integrity: integrity(k) }]),
      ["with the run ending interrupted", { integrity: integrity("interrupted") }],
      ["with the run ending error", { integrity: integrity("error") }],
    ];
    for (const [name, over] of variants) {
      const j = notGreen(judgeMilestone(input({ results: failing, ...over })));
      expect(j.state, name).toBe("red");
      const red = j.reasons.find((r) => r.code === "row-failing");
      expect(red?.rid, name).toBe("r1");
      expect(red?.testName, name).toBe(testName("r1"));
      expect(red?.detail, name).toContain("Expected 57 but was 38");
    }
  });

  it("a failure from a run that was not admitted is still a failure (its passes are refused, not its fails)", () => {
    const j = notGreen(judgeMilestone(input({
      run: run({ admitted: false, refusal: { kind: "skipped", detail: "1 skipped" } }),
      results: { r1: result("fail"), r2: result("pass") },
    })));
    expect(j.state).toBe("red");
    expect(j.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["row-failing", "run-not-admitted"]));
  });

  it("a regression row that fails is red and names the row", () => {
    const g1 = row("g1", { label: "Q-28", text: "Kilns must never fire above their rated heat.", sectionNumber: "21.6" });
    const j = notGreen(judgeMilestone(input({
      regression: [g1],
      results: { r1: result("pass"), r2: result("pass"), g1: result("fail", { detail: "kiln B fired 23 degrees over its rating" }) },
    })));
    expect(j.state).toBe("red");
    const reason = j.reasons.find((r) => r.code === "regression");
    expect(reason?.rid).toBe("g1");
    expect(reason?.testName).toBe(testName("g1"));
    expect(reason?.detail).toContain("Q-28");
    expect(reason?.detail).toContain("Kilns must never fire above their rated heat.");
    expect(reason?.detail).toContain("kiln B fired 23 degrees over its rating");
    // An earlier milestone's file need not be among the sources: the row's own current test names it.
    const elsewhere = row("g2", { checks: [
      { kind: "test", testName: "Strada.Acceptance.M0.Acceptance_M0.R_old", path: OTHER_FILE, bodySha: "b0", supersededAtMs: 3 },
      { kind: "test", testName: "Strada.Acceptance.M0.Acceptance_M0.R_g2", path: OTHER_FILE, bodySha: "b1" },
    ] });
    const k = notGreen(judgeMilestone(input({
      regression: [elsewhere],
      sources: [source(["r1", "r2"])],
      results: { r1: result("pass"), r2: result("pass"), g2: result("fail") },
    })));
    expect(k.reasons.find((r) => r.code === "regression")?.testName).toBe("Strada.Acceptance.M0.Acceptance_M0.R_g2");
  });

  it("a row both owned and regressed is judged once, as owned", () => {
    const j = notGreen(judgeMilestone(input({ regression: [row("r1")], results: { r1: result("fail"), r2: result("pass") } })));
    expect(j.reasons.filter((r) => r.rid === "r1").map((r) => r.code)).toEqual(["row-failing"]);
  });

  it("reasons come worst first, and the state is the worst class present", () => {
    const j = notGreen(judgeMilestone(input({
      compile: { ran: false, ok: false },
      results: { r1: result("flaky"), r2: result("fail") },
    })));
    expect(j.state).toBe("red");
    expect(j.reasons.map((r) => r.reasonClass)).toEqual(["red", "check-fault", "unmeasurable"]);
    // check-fault over unmeasurable: a broken check is the system's to repair now.
    const k = notGreen(judgeMilestone(input({ compile: { ran: false, ok: false }, results: { r1: result("flaky"), r2: result("pass") } })));
    expect(k.state).toBe("check-fault");
  });
});

// =============================================================================
// THE TERMINAL KEY AND scopeProven
// =============================================================================

describe("judgeMilestone — the run's terminal key, and scope proven by independent checks", () => {
  it("terminalReasonClass: red keys are red, except `error`; outages, `error` and interruptions are never charged", () => {
    for (const key of TERMINAL_KEYS) {
      if (key === "done") {
        expect(terminalReasonClass(key)).toBeUndefined();
      } else if (RED_TERMINALS.has(key) && key !== "error") {
        expect(terminalReasonClass(key), key).toBe("red");
      } else {
        expect(terminalReasonClass(key), key).toBe("unmeasurable");
      }
    }
  });

  it("table: every key × checks written by the worker's model or another, rows all passing", () => {
    for (const key of TERMINAL_KEYS) {
      // Different model: scope is proven, so the key never blocks.
      const proven = greenOf(judgeMilestone(input({ integrity: integrity(key) })));
      expect(proven.basis, key).toBe("proven");
      if (key === "done") expect(proven.caveats, key).toEqual([]);
      else expect(proven.caveats.join(" "), key).toContain(key);

      // Same model: only `done` is green; otherwise the key's own class.
      const same = judgeMilestone(input({ integrity: integrity(key), sources: [source(["r1", "r2"], "same-model")] }));
      if (key === "done") {
        expect(greenOf(same).caveats.join(" "), key).toMatch(/same model|same-model/);
      } else {
        const j = notGreen(same);
        expect(j.state, key).toBe(terminalReasonClass(key));
        expect(j.reasons.find((r) => r.code === "terminal")?.terminal, key).toBe(key);
      }
    }
  });

  it("an `error` the settle counted as the worker's own is red; one counted as the machinery's, or not counted at all, is not (W01)", () => {
    const sameModel = [source(["r1", "r2"], "same-model")];
    const keys: TerminalKey[] = ["error", "done"];
    const of = (infrastructureErrors?: number) =>
      judgeMilestone(input({ sources: sameModel, integrity: integrity("error", { terminalKeys: keys, ...(infrastructureErrors === undefined ? {} : { infrastructureErrors }) } as Partial<RunIntegrity>) }));
    const worker = notGreen(of(0));
    expect(worker.state).toBe("red");
    expect(worker.reasons.find((r) => r.code === "terminal")?.detail).toMatch(/worker's own run failed/);
    expect(notGreen(of(1)).state).toBe("unmeasurable");
    expect(notGreen(of(undefined)).state).toBe("unmeasurable");
    // Scope proven by independent checks still is not blocked by it.
    expect(greenOf(judgeMilestone(input({ integrity: integrity("error", { terminalKeys: keys, infrastructureErrors: 0 } as Partial<RunIntegrity>) }))).basis).toBe("proven");
  });

  it("a test the row retired (superseded, weak) still in its file is not the row's check: no stand-in, no proof of scope (W13)", () => {
    const weak = row("r1", {
      checks: [{ kind: "test", testName: testName("r1"), path: FILE, bodySha: "body-r1", supersededAtMs: 5, weak: "it asserts a literal" }],
    });
    // The file was not rendered again yet: the retired test is still in it.
    const j = notGreen(judgeMilestone(input({ own: [weak, row("r2")], results: { r2: result("pass") } })));
    const reason = j.reasons.find((r) => r.rid === "r1");
    expect(reason?.code).toBe("row-no-check");
    expect(reason?.reasonClass).toBe("check-fault");
    // A replacement with other bytes under the same name is the row's check again.
    const replaced = row("r1", {
      checks: [
        { kind: "test", testName: testName("r1"), path: FILE, bodySha: "body-old", supersededAtMs: 5, weak: "it asserts a literal" },
        { kind: "test", testName: testName("r1"), path: FILE, bodySha: "body-r1" },
      ],
    });
    expect(greenOf(judgeMilestone(input({ own: [replaced, row("r2")] }))).basis).toBe("proven");
    // Nor is it counted when the writers are weighed: a retired test the worker's model wrote, left in
    // another file, does not take independence from the current check.
    const both = [
      source(["r1", "r2"]),
      { ...source([], "same-model", "worker-model"), path: OTHER_FILE, tests: [{ rid: "r1", testName: testName("r1"), bodySha: "body-old" }] },
    ];
    const judged = greenOf(judgeMilestone(input({ own: [replaced, row("r2")], sources: both })));
    expect(judged.caveats.join(" ")).not.toMatch(/independent/);
  });

  it("table: every key with a failing owned row is red — the key never softens a failing row", () => {
    for (const key of TERMINAL_KEYS) {
      const j = notGreen(judgeMilestone(input({ integrity: integrity(key), results: { r1: result("fail"), r2: result("pass") } })));
      expect(j.state, key).toBe("red");
    }
  });

  it("scopeProven overrides task_stuck; the same model's checks do not", () => {
    const proven = greenOf(judgeMilestone(input({ integrity: integrity("task_stuck") })));
    expect(proven.caveats.join(" ")).toMatch(/task_stuck/);
    expect(proven.caveats.join(" ")).toMatch(/scope proven/);
    const same = notGreen(judgeMilestone(input({ integrity: integrity("task_stuck"), sources: [source(["r1", "r2"], "same-model")] })));
    expect(same.state).toBe("red");
    expect(same.reasons.map((r) => r.code)).toEqual(["terminal"]);
  });

  it("scope is not proven when any one owned test is not independent", () => {
    const stuck = integrity("task_stuck");
    const cases: Array<[string, Partial<GreenInput>]> = [
      ["one test rewritten by the worker's model", {
        sources: [{ ...source(["r1", "r2"]), tests: [
          { rid: "r1", testName: testName("r1"), bodySha: "b" },
          { rid: "r2", testName: testName("r2"), bodySha: "b", writer: { provider: "p", model: "worker-model", independence: "same-model" } },
        ] }],
      }],
      ["the writer was recorded independent but its model worked on this run", { sources: [source(["r1", "r2"], "different-model", "worker-model")] }],
      ["…compared without case or provider prefix", { integrity: integrity("task_stuck", { workerModels: ["opencode/Writer-Model"] }) }],
      ["one owned row has no stored test (decided some other way)", {
        own: [row("r1"), row("r2", { checks: [{ kind: "scenario", requirement: "the level starts" }] })],
        sources: [source(["r1"])],
      }],
      ["the run was not admitted, so no row passed in it", { run: run({ admitted: false, refusal: { kind: "count-mismatch", detail: "1 short" } }) }],
      ["one owned row failed", { results: { r1: result("pass"), r2: result("fail") } }],
    ];
    for (const [name, over] of cases) {
      const j = notGreen(judgeMilestone(input({ integrity: stuck, ...over })));
      expect(j.state, name).toBe("red");
      expect(j.reasons.some((r) => r.code === "terminal" && r.terminal === "task_stuck"), name).toBe(true);
    }
  });

  it("the judge folds every key the run carried: a worst field that disagrees with its keys cannot hide a red key", () => {
    const lying = integrity("done", { terminalKeys: ["done", "task_stuck"] });
    const j = notGreen(judgeMilestone(input({ integrity: lying, sources: [source(["r1", "r2"], "same-model")] })));
    expect(j.state).toBe("red");
    expect(j.reasons.find((r) => r.code === "terminal")?.terminal).toBe("task_stuck");
    // A supervisor run that stuck in one node and lost its provider in another is red.
    const mixed = integrity("provider_quota", { terminalKeys: ["provider_quota", "task_stuck"] });
    expect(notGreen(judgeMilestone(input({ integrity: mixed, sources: [source(["r1", "r2"], "same-model")] }))).state).toBe("red");
  });

  it("a run whose ending was not recorded is not a clean finish", () => {
    const unrecorded = { terminalKeys: [], worst: "finished" as unknown as TerminalKey, source: "spine", workerModels: [] } as RunIntegrity;
    const j = notGreen(judgeMilestone(input({ integrity: unrecorded, sources: [source(["r1", "r2"], "same-model")] })));
    expect(j.state).toBe("unmeasurable");
    expect(j.reasons.map((r) => r.code)).toEqual(["terminal"]);
    // …and it still never blocks a scope independent checks proved.
    expect(judgeMilestone(input({ integrity: unrecorded })).green).toBe(true);
    // A replayed input with no integrity at all reads the same way, instead of throwing.
    const missing = input({ sources: [source(["r1", "r2"], "same-model")] }) as unknown as Record<string, unknown>;
    delete missing["integrity"];
    const m = notGreen(judgeMilestone(missing as unknown as GreenInput));
    expect(m.state).toBe("unmeasurable");
    expect(m.reasons.map((r) => r.code)).toEqual(["terminal"]);
  });
});

describe("judgeMilestone — an outage is never charged, and always yields to any red reason", () => {
  const redReasons: Array<[string, (key: TerminalKey) => GreenInput]> = [
    ["a compile failure", (k) => input({ integrity: integrity(k), compile: { ran: true, ok: false } })],
    ["tamper", (k) => input({ integrity: integrity(k), tamper: [FILE] })],
    ["a failing owned row", (k) => input({ integrity: integrity(k), results: { r1: result("fail"), r2: result("pass") } })],
    ["a failing regression row", (k) => input({ integrity: integrity(k), regression: [row("g1")], results: { r1: result("pass"), r2: result("pass"), g1: result("fail") } })],
    ["a red key in another node", (k) => input({ integrity: integrity(k, { terminalKeys: [k, "cut_short"] }), sources: [source(["r1", "r2"], "same-model")] })],
    ["a vacuous milestone's failed gate", (k) => vacuous({ integrity: integrity(k), gates: { ...gates(), visualEvidence: "fail" } })],
    ["a vacuous milestone's prose failure", (k) => vacuous({ integrity: integrity(k), proseFailure: true })],
  ];

  it("every outage key × every red reason is red", () => {
    for (const key of [...OUTAGE_TERMINALS, "error" as const, "interrupted" as const]) {
      for (const [name, build] of redReasons) {
        expect(notGreen(judgeMilestone(build(key))).state, `${key} + ${name}`).toBe("red");
      }
    }
  });

  it("an outage key with nothing red is unmeasurable, with no red reason to charge", () => {
    for (const key of [...OUTAGE_TERMINALS, "error" as const, "interrupted" as const]) {
      for (const given of [
        input({ integrity: integrity(key), sources: [source(["r1", "r2"], "same-model")] }),
        input({ integrity: integrity(key), run: undefined }),
        vacuous({ integrity: integrity(key) }),
      ]) {
        const j = notGreen(judgeMilestone(given));
        expect(j.state, key).toBe("unmeasurable");
        expect(j.reasons.filter((r) => r.reasonClass === "red"), key).toEqual([]);
      }
    }
  });

  it("`error` (the runtime threw) is judged like missing infrastructure: unmeasurable, never charged, outranked by any red, and no bar to a proven scope", () => {
    const crashed = integrity("error");
    const alone = notGreen(judgeMilestone(input({ integrity: crashed, sources: [source(["r1", "r2"], "same-model")] })));
    expect(alone.state).toBe("unmeasurable");
    expect(alone.reasons).toEqual([expect.objectContaining({ code: "terminal", terminal: "error", reasonClass: "unmeasurable" })]);
    expect(notGreen(judgeMilestone(input({ integrity: crashed, results: { r1: result("fail"), r2: result("pass") } }))).state).toBe("red");
    expect(greenOf(judgeMilestone(input({ integrity: crashed }))).caveats.join(" ")).toContain("error");
    // A worker's own red key beside the crash still charges.
    const both = integrity("error", { terminalKeys: ["error", "max_steps_reached"] });
    const j = notGreen(judgeMilestone(input({ integrity: both, sources: [source(["r1", "r2"], "same-model")] })));
    expect(j.state).toBe("red");
    expect(j.reasons.find((r) => r.code === "terminal")?.terminal).toBe("max_steps_reached");
  });
});

// =============================================================================
// A MILESTONE THAT OWNS NO ROWS
// =============================================================================

describe("judgeMilestone — a milestone that owns no rows (vacuous)", () => {
  it("is green only on done, a clean compile, every gate passed or not armed, and no prose failure — basis vacuous, disclosed", () => {
    const j = greenOf(judgeMilestone(vacuous()));
    expect(j.basis).toBe("vacuous");
    expect(j.caveats.join(" ")).toMatch(/owns no GDD rows/);
    expect(judgeMilestone(vacuous({ gates: gates("not-armed") })).green).toBe(true);
  });

  it("a spent visual bounce is not green; neither is any other failed gate", () => {
    for (const gate of GATES) {
      const j = notGreen(judgeMilestone(vacuous({ gates: { ...gates(), [gate]: "fail" } })));
      expect(j.state, gate).toBe("red");
      expect(j.reasons.map((r) => r.code), gate).toEqual(["gate-failed"]);
      expect(j.reasons[0]!.detail, gate).toContain(gate);
    }
  });

  it("a gate with no recorded outcome did not pass", () => {
    const missing = { visualEvidence: "pass", noWork: "pass", art: "pass" } as unknown as Record<CompletionGate, GateOutcome>;
    const j = notGreen(judgeMilestone(vacuous({ gates: missing })));
    expect(j.state).toBe("unmeasurable");
    expect(j.reasons[0]!.detail).toContain("prosOnly");
    // No gate record at all: none of the four passed.
    const none = notGreen(judgeMilestone(vacuous({ gates: undefined as unknown as Record<CompletionGate, GateOutcome> })));
    expect(none.state).toBe("unmeasurable");
    expect(none.reasons.map((r) => r.code)).toEqual(["gate-failed", "gate-failed", "gate-failed", "gate-failed"]);
  });

  it("the worker's prose reading as a terminal failure is red here, and only here", () => {
    expect(notGreen(judgeMilestone(vacuous({ proseFailure: true }))).reasons.map((r) => r.code)).toEqual(["prose-failure"]);
    // Prose is not an input to green when rows decide.
    expect(judgeMilestone(input({ proseFailure: true })).green).toBe(true);
  });

  it("needs the typed key done: scopeProven never applies to a milestone that proves no scope", () => {
    for (const key of TERMINAL_KEYS.filter((k) => k !== "done")) {
      const j = notGreen(judgeMilestone(vacuous({ integrity: integrity(key) })));
      expect(j.state, key).toBe(terminalReasonClass(key));
    }
  });

  it("needs an admitted run as soon as it has regression rows", () => {
    expect(notGreen(judgeMilestone(vacuous({ regression: [row("g1")], results: { g1: result("pass") }, sources: [source(["g1"])] }))).reasons.map((r) => r.code))
      .toEqual(["run-not-admitted"]);
    expect(judgeMilestone(vacuous({ regression: [row("g1")], results: { g1: result("pass") }, sources: [source(["g1"])], run: run() })).green).toBe(true);
  });

  it("rows that never block (look and feel, aspirations, waived, excluded) leave a milestone vacuous, and are disclosed", () => {
    const disclosed = [
      row("j1", { kind: "judgement" }),
      row("a1", { kind: "aspiration" }),
      row("w1", { status: "waived", waiver: { userId: "u", atMs: 1, reason: "deferred" } }),
      row("x1", { status: "excluded", excludedBecause: "post-MVP" }),
    ];
    const j = greenOf(judgeMilestone(vacuous({ own: disclosed })));
    expect(j.basis).toBe("vacuous");
    expect(j.caveats.join(" ")).toMatch(/4 owned row\(s\)/);
    // Beside a real row they neither block nor count.
    expect(greenOf(judgeMilestone(input({ own: [row("r1"), ...disclosed], results: { r1: result("pass") }, sources: [source(["r1"])] }))).basis).toBe("proven");
  });

  it("gates do not decide a milestone whose rows do; a failed one is disclosed", () => {
    const j = greenOf(judgeMilestone(input({ gates: { ...gates(), visualEvidence: "fail" } })));
    expect(j.basis).toBe("proven");
    expect(j.caveats.join(" ")).toContain("visualEvidence");
  });
});

// =============================================================================
// PURITY
// =============================================================================

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

describe("judgeMilestone is pure", () => {
  it("reads a frozen input without writing to it, and the same input gives the same verdict", () => {
    const given = deepFreeze(input({ integrity: integrity("task_stuck"), results: { r1: result("fail"), r2: result("pass") }, tamper: [FILE] }));
    const first = judgeMilestone(given);
    expect(judgeMilestone(given)).toEqual(first);
    expect(JSON.parse(JSON.stringify(judgeMilestone(JSON.parse(JSON.stringify(given)) as GreenInput)))).toEqual(JSON.parse(JSON.stringify(first)));
  });

  it("imports nothing but the terminal-key and scope-type contracts, and reads no clock, file, process or randomness", () => {
    const text = readFileSync(join(import.meta.dirname, "scope-verdict.ts"), "utf8");
    const imports = [...text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect([...new Set(imports)].sort()).toEqual(["../agents/autonomy/terminal-key.js", "./scope-types.js"]);
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\bDate\.|\bMath\.random|\bprocess\.|\brequire\(|\bawait\b|\bfetch\(/);
  });
});

// =============================================================================
// attributeRun
// =============================================================================

describe("attributeRun — which expected test passed, failed, faulted or was not measured", () => {
  const expected: ExpectedAcceptanceTest[] = [
    { testName: testName("r1"), path: FILE },
    { testName: testName("r2"), path: FILE },
    { testName: testName("r3"), path: OTHER_FILE },
  ];
  const none = new Set<string>();

  it("an admitted run with no failures passes every expected test", () => {
    const a = attributeRun(run({ expected: expected.map((t) => t.testName), total: 3 }), expected, none);
    expect(a.unattributed).toBe(0);
    for (const t of expected) expect(a.tests[t.testName]?.outcome, t.testName).toBe("pass");
  });

  it("a named failure fails with its message; flaky beats fail (it passed on the one re-run)", () => {
    const a = attributeRun(run({
      failedNames: [testName("r1"), testName("r2")],
      flaky: [testName("r2")],
      failures: [{ name: testName("r1"), message: "Expected 57 but was 38" }],
    }), expected, none);
    expect(a.tests[testName("r1")]).toMatchObject({ outcome: "fail" });
    expect(a.tests[testName("r1")]!.detail).toContain("Expected 57 but was 38");
    expect(a.tests[testName("r2")]?.outcome).toBe("flaky");
    expect(a.tests[testName("r3")]?.outcome).toBe("pass");
  });

  it("failures nobody named: no unnamed test is read as a pass, while the named ones still fail", () => {
    const capped = attributeRun(run({ failedNames: [testName("r1")], unattributed: 10 }), expected, none);
    expect(capped.unattributed).toBe(10);
    expect(capped.tests[testName("r1")]?.outcome).toBe("fail");
    expect(capped.tests[testName("r2")]?.outcome).toBe("unmeasured");
    expect(capped.tests[testName("r3")]?.outcome).toBe("unmeasured");
    // A failed name that is not one of the expected tests is a failure no expected name accounts for.
    const foreign = attributeRun(run({ failedNames: ["Some.Other.Test"] }), expected, none);
    expect(foreign.unattributed).toBe(1);
    for (const t of expected) expect(foreign.tests[t.testName]?.outcome).toBe("unmeasured");
    // An unreadable count is not zero.
    for (const bad of [Number.NaN, -1, 1.5, undefined]) {
      const a = attributeRun(run({ unattributed: bad as unknown as number }), expected, none);
      expect(a.unattributed, String(bad)).toBeGreaterThan(0);
      expect(a.tests[testName("r1")]?.outcome, String(bad)).toBe("unmeasured");
    }
  });

  it("a test whose file no longer compiles is a fail when it compiled before, a check fault when it never did", () => {
    const broken = run({
      admitted: false,
      refusal: { kind: "count-mismatch", detail: "0 of 3 ran" },
      acceptanceCompileErrors: [{ path: FILE, line: 12, code: "CS0246", message: "The type 'ScoreService' could not be found" }],
    });
    const a = attributeRun(broken, expected, new Set([testName("r1")]));
    expect(a.tests[testName("r1")]).toMatchObject({ outcome: "fail", compiledBefore: true });
    expect(a.tests[testName("r1")]!.detail).toContain("CS0246");
    expect(a.tests[testName("r2")]).toMatchObject({ outcome: "check-fault", compiledBefore: false });
    // The rest of the assembly did not run because of that file: not measured, not passed.
    expect(a.tests[testName("r3")]?.outcome).toBe("not-run");
    // Path spellings from the compiler: backslashes, absolute.
    const spelled = attributeRun(
      run({ acceptanceCompileErrors: [{ path: `C:\\proj\\${FILE.replace(/\//g, "\\")}`, message: "x" }] }),
      expected,
      none,
    );
    expect(spelled.tests[testName("r1")]?.outcome).toBe("check-fault");
    expect(spelled.tests[testName("r3")]?.outcome).toBe("pass");
  });

  it("table: a refused record never passes anything; only a short or skipped record of this run keeps its failures", () => {
    for (const kind of REFUSALS) {
      const a = attributeRun(run({
        admitted: false,
        refusal: { kind, detail: `${kind} detail` },
        failedNames: [testName("r1")],
      }), expected, new Set(expected.map((t) => t.testName)));
      const outcomes = expected.map((t) => a.tests[t.testName]?.outcome);
      expect(outcomes, kind).not.toContain("pass");
      if (kind === "count-mismatch" || kind === "skipped") {
        expect(outcomes, kind).toEqual(["fail", "unmeasured", "unmeasured"]);
      } else {
        // Another run's record, another tree, or no record: it measured nothing here.
        expect(outcomes, kind).toEqual(["unmeasured", "unmeasured", "unmeasured"]);
        expect(a.tests[testName("r2")]!.detail, kind).toContain(kind);
      }
    }
    // Compile errors from a run on a tree that moved are not charged either.
    const moved = attributeRun(run({
      admitted: false,
      refusal: { kind: "tree-moved", detail: "HEAD moved" },
      acceptanceCompileErrors: [{ path: FILE, message: "x" }],
    }), expected, new Set([testName("r1")]));
    expect(moved.tests[testName("r1")]?.outcome).toBe("unmeasured");
  });

  it("feeds the judge: a check that compiled before and no longer compiles makes the milestone red", () => {
    const a = attributeRun(run({
      admitted: false,
      refusal: { kind: "count-mismatch", detail: "0 of 2 ran" },
      acceptanceCompileErrors: [{ path: FILE, message: "error CS0117: 'Board' does not contain a definition for 'Tiles'" }],
    }), expected.slice(0, 2), new Set([testName("r1")]));
    const results = Object.fromEntries(["r1", "r2"].map((rid) => {
      const t = a.tests[testName(rid)]!;
      return [rid, result(t.outcome, { detail: t.detail, compiledBefore: t.compiledBefore })];
    }));
    const j = notGreen(judgeMilestone(input({ results, run: run({ admitted: false, refusal: { kind: "count-mismatch", detail: "0 of 2 ran" } }) })));
    expect(j.state).toBe("red");
    expect(j.reasons.find((r) => r.code === "row-failing")?.rid).toBe("r1");
    expect(j.reasons.find((r) => r.code === "row-check-fault")?.rid).toBe("r2");
  });
});

// =============================================================================
// closesByLedger
// =============================================================================

describe("closesByLedger — a requirement closes only when its row passed on the current revision", () => {
  it("closes on a pass at this revision", () => {
    expect(closesByLedger(row("r1", { status: "passing", last: result("pass") }), REV)).toBe(true);
  });

  it("does not close on anything else", () => {
    const cases: Array<[string, RequirementRow, string]> = [
      ["a pass on another revision", row("r1", { last: result("pass", { revision: OTHER_REV }) }), REV],
      ["no revision to compare", row("r1", { last: result("pass") }), " "],
      ["no measurement", row("r1"), REV],
      ...(["fail", "flaky", "not-run", "check-fault", "unmeasured"] as RowOutcome[]).map((o): [string, RequirementRow, string] => [o, row("r1", { last: result(o) }), REV]),
      ["no check at all", row("r1", { checks: [], last: result("pass") }), REV],
      ["only a superseded check", row("r1", { checks: [{ kind: "test", testName: "t", path: FILE, bodySha: "b", supersededAtMs: 5 }], last: result("pass") }), REV],
      ["a check the review called weak", row("r1", { checks: [{ kind: "test", testName: "t", path: FILE, bodySha: "b", weak: "asserts a literal" }], last: result("pass") }), REV],
      ["waived (a person closed it, not the ledger)", row("r1", { status: "waived", last: result("pass") }), REV],
      ["excluded", row("r1", { status: "excluded", last: result("pass") }), REV],
    ];
    for (const [name, r, rev] of cases) expect(closesByLedger(r, rev), name).toBe(false);
  });

  it("a weak check that was regenerated closes once the new test passes", () => {
    const regenerated = row("r1", {
      checks: [
        { kind: "test", testName: "old", path: FILE, bodySha: "b0", weak: "asserts a literal", supersededAtMs: 5 },
        { kind: "test", testName: "new", path: FILE, bodySha: "b1" },
      ],
      last: result("pass"),
    });
    expect(closesByLedger(regenerated, REV)).toBe(true);
  });
});

// =============================================================================
// legacyRunIntegrity
// =============================================================================

describe("legacyRunIntegrity — a run settled before the key was carried, decoded from the system's own stamps", () => {
  // A stand-in for W01's systemStampsIn: finds the system's task_stuck and
  // provider_quota renderings in any locale.
  const STUCK = ["en", "tr", "de"].map((l) => getResilienceMessage("task_stuck", l).slice(0, 60));
  const QUOTA = getResilienceMessage("provider_quota", "en").split("{provider}")[0]!;
  const decode = (text: string): TerminalKey[] => {
    const keys: TerminalKey[] = [];
    for (const piece of STUCK) for (let i = text.indexOf(piece); i >= 0; i = text.indexOf(piece, i + 1)) keys.push("task_stuck");
    if (text.includes(QUOTA)) keys.push("provider_quota");
    return keys;
  };

  it("no stamp is done, from a legacy stamp, with no worker models known", () => {
    for (const tip of ["Implemented the double jump; all 42 tests pass.", "", undefined, null]) {
      expect(legacyRunIntegrity(tip, decode), String(tip)).toEqual({
        terminalKeys: ["done"],
        worst: "done",
        source: "legacy-stamp",
        workerModels: [],
      });
    }
  });

  it("reads the whole tip, not an excerpt: a stamp past the first 500 characters is found", () => {
    const tip = `${"Worked on the board. ".repeat(40)}\n${getResilienceMessage("task_stuck", "en")}`;
    expect(tip.indexOf("I got stuck")).toBeGreaterThan(500);
    expect(legacyRunIntegrity(tip, decode).worst).toBe("task_stuck");
  });

  it("red outranks the quota stamp beside it (measured: a tip of repeated stuck stamps ending in a quota stop)", () => {
    const tip = [
      ...Array.from({ length: 23 }, () => getResilienceMessage("task_stuck", "en")),
      getResilienceMessage("provider_quota", "en", { provider: "opencode", detail: "limit reached." }),
    ].join("\n\n");
    const i = legacyRunIntegrity(tip, decode);
    expect(i.worst).toBe("task_stuck");
    expect(i.terminalKeys.filter((k) => k === "task_stuck")).toHaveLength(23);
    expect(i.source).toBe("legacy-stamp");
    // A quota stop alone is an outage, not a red.
    expect(legacyRunIntegrity(getResilienceMessage("provider_quota", "en", { provider: "x", detail: "y" }), decode).worst).toBe("provider_quota");
    // Another locale's stamp is the same stamp.
    expect(legacyRunIntegrity(getResilienceMessage("task_stuck", "tr"), decode).worst).toBe("task_stuck");
  });

  it("drops anything the decoder returns that is not a terminal key", () => {
    const i = legacyRunIntegrity("text", () => ["nonsense" as TerminalKey, "cut_short"]);
    expect(i.terminalKeys).toEqual(["cut_short"]);
    expect(i.worst).toBe("cut_short");
  });

  it("feeds the judge: a legacy stuck run with no acceptance run is red; a legacy clean one is unmeasurable, never green", () => {
    const stuck = legacyRunIntegrity(getResilienceMessage("task_stuck", "en"), decode);
    const m1 = notGreen(judgeMilestone(input({ integrity: stuck, run: undefined, results: {} })));
    expect(m1.state).toBe("red");
    expect(m1.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["terminal", "run-not-admitted"]));
    const clean = legacyRunIntegrity("Done: all rows implemented.", decode);
    const m3 = notGreen(judgeMilestone(input({ integrity: clean, run: undefined, results: {} })));
    expect(m3.state).toBe("unmeasurable");
    // Same-model checks passing in an admitted run: the clean one turns green, the stuck one stays red on its key alone.
    const same = [source(["r1", "r2"], "same-model")];
    expect(judgeMilestone(input({ integrity: clean, sources: same })).green).toBe(true);
    expect(notGreen(judgeMilestone(input({ integrity: stuck, sources: same }))).reasons.map((r) => r.code)).toEqual(["terminal"]);
    // Written by another model, the stuck one is green with the scope-proven caveat.
    expect(greenOf(judgeMilestone(input({ integrity: stuck }))).caveats.join(" ")).toMatch(/scope proven/);
    // A legacy green discloses that its ending was decoded from stamps.
    expect(greenOf(judgeMilestone(input({ integrity: clean }))).caveats.join(" ")).toMatch(/stamps/);
  });
});
