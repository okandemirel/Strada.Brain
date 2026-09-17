/**
 * THE HARNESS'S OWN TESTS (plan 6.3).
 *
 * A harness that cannot fail is worthless, so these tests do two things:
 *
 *   1. drive the REAL arms against a REAL seeded SQLite database (the fixture
 *      dataset, throwaway temp store, src/learning untouched) and assert each of
 *      the three measures on numbers the learning subsystem actually produced;
 *   2. prove the gate FIRES — a deliberately regressed treatment arm (the same
 *      trained store with learning switched off) is reported as a regression,
 *      and the three exit codes are distinguished end to end through the CLI.
 *
 * The rule under test above all others: "SKIPPED" IS NOT "MEASURED". An arm that
 * could not run must never be folded into a pass.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  DECISION,
  EXIT,
  FIXTURE_DATASET,
  STATE,
  decideVerdict,
  measureCostPerAccepted,
  measureHarmfulRecall,
  measureRepeatErrorReduction,
  renderReport,
  scoreDeterministicRubric,
  scoreProbe,
  summariseArm,
  summariseQuality,
  runQualityArm,
  validateDataset,
  DEFAULT_THRESHOLDS,
} from "../../scripts/eval/learning-eval-core.mjs";
import { ARM_SPECS, makeWorkDir, measureEffectEnds, runArm } from "../../scripts/eval/learning-eval-arms.mjs";
import * as learningModule from "../../src/learning/index.js";
import { InstinctRetriever } from "../../src/agents/instinct-retriever.js";
import * as ledgerModule from "../../src/learning/ledger.js";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const CLI = join(REPO_ROOT, "scripts", "eval", "learning-eval.mjs");

const learning = {
  LearningStorage: learningModule.LearningStorage,
  LearningPipeline: learningModule.LearningPipeline,
  PatternMatcher: learningModule.PatternMatcher,
  ConfidenceScorer: learningModule.ConfidenceScorer,
  ErrorLearningHooks: learningModule.ErrorLearningHooks,
  InstinctRetriever,
  ledger: {
    buildInstinctLedger: ledgerModule.buildInstinctLedger,
    findSuspectGuidance: ledgerModule.findSuspectGuidance,
    retireGuidance: ledgerModule.retireGuidance,
  },
};

// ─── pure logic: the exit contract ──────────────────────────────────────────

describe("learning-eval exit contract", () => {
  const good = { name: "m1", state: STATE.GOOD, reason: "fine" };
  const bad = { name: "m2", state: STATE.REGRESSED, reason: "worse" };
  const missing = { name: "m3", state: STATE.UNMEASURED, reason: "no provider" };

  it("exits 0 only when every measure ran and stayed inside its bound", () => {
    const v = decideVerdict({ measures: [good, { ...good, name: "m1b" }], arms: [], requested: [] });
    expect(v.exitCode).toBe(EXIT.MEASURED_GOOD);
    expect(v.verdict).toBe(STATE.GOOD);
  });

  it("exits 1 when something RAN and came out worse — measured and regressed", () => {
    const v = decideVerdict({ measures: [good, bad], arms: [], requested: [] });
    expect(v.exitCode).toBe(EXIT.MEASURED_REGRESSED);
    expect(v.reasons.join(" ")).toContain("worse");
  });

  it("exits 3 for an unmeasured measure — a skip is never folded into a pass", () => {
    const v = decideVerdict({ measures: [good, missing], arms: [], requested: [] });
    expect(v.exitCode).toBe(EXIT.NOT_MEASURED);
    expect(v.verdict).toBe(STATE.UNMEASURED);
    expect(v.reasons.join(" ")).toContain("NOT MEASURED");
  });

  it("exits 3 when a REQUESTED arm could not run, even with every measure good", () => {
    const v = decideVerdict({
      measures: [good],
      arms: [],
      requested: [{ name: "answer-quality", state: STATE.UNMEASURED, reason: "no provider credential" }],
    });
    expect(v.exitCode).toBe(EXIT.NOT_MEASURED);
    expect(v.reasons.join(" ")).toContain("answer-quality");
  });

  it("a regression outranks an unmeasured measure — something ran and was worse", () => {
    const v = decideVerdict({ measures: [bad, missing], arms: [], requested: [] });
    expect(v.exitCode).toBe(EXIT.MEASURED_REGRESSED);
  });

  it("an arm that threw is unmeasured, not a pass and not a regression", () => {
    const v = decideVerdict({ measures: [good], arms: [{ name: "cold", error: "disk full" }], requested: [] });
    expect(v.exitCode).toBe(EXIT.NOT_MEASURED);
    expect(v.reasons.join(" ")).toContain("disk full");
  });

  it("measures nothing at all → not measured, never 0", () => {
    expect(decideVerdict({ measures: [], arms: [], requested: [] }).exitCode).toBe(EXIT.NOT_MEASURED);
  });
});

// ─── pure logic: rates with no denominator ──────────────────────────────────

describe("learning-eval reports an empty denominator as unmeasured", () => {
  const arm = (name: string, over: Record<string, unknown>) =>
    summariseArm({ name, trained: true, learningEnabled: name.endsWith("on"), probes: [], ...over });

  it("harmful recall with zero recalls is NOT MEASURED, not 0%", () => {
    const arms = [
      arm("warm-learning-off", { probes: [{ id: "a", decision: DECISION.NO_RECALL, repeatable: true, repeatedError: true, accepted: true, cost: 3, recalled: [] }] }),
      arm("warm-learning-on", { probes: [{ id: "a", decision: DECISION.NO_RECALL, repeatable: true, repeatedError: true, accepted: true, cost: 3, recalled: [] }] }),
    ];
    const m = measureHarmfulRecall(arms, DEFAULT_THRESHOLDS, null);
    expect(m.state).toBe(STATE.UNMEASURED);
    expect(m.reason).toContain("NOT evidence that recall is safe");
  });

  it("repeat-error reduction is NOT MEASURED when the control repeated nothing", () => {
    const probe = { id: "a", decision: DECISION.CORRECT, repeatable: true, repeatedError: false, accepted: true, cost: 1, recalled: [] };
    const arms = [arm("warm-learning-off", { probes: [probe] }), arm("warm-learning-on", { probes: [probe] })];
    const m = measureRepeatErrorReduction(arms, DEFAULT_THRESHOLDS);
    expect(m.state).toBe(STATE.UNMEASURED);
    expect(m.reason).toContain("no repeat-error rate to reduce");
  });

  it("cost per accepted result is NOT MEASURED when an arm accepted nothing", () => {
    const none = { id: "a", decision: DECISION.HARMFUL, repeatable: false, repeatedError: false, accepted: false, cost: 4, recalled: [] };
    const some = { id: "a", decision: DECISION.NO_RECALL, repeatable: false, repeatedError: false, accepted: true, cost: 3, recalled: [] };
    const arms = [arm("warm-learning-off", { probes: [some] }), arm("warm-learning-on", { probes: [none] })];
    const m = measureCostPerAccepted(arms, DEFAULT_THRESHOLDS, null);
    expect(m.state).toBe(STATE.UNMEASURED);
    expect(m.reason).toContain("undefined");
  });
});

// ─── pure logic: the oracle and the dataset guard ───────────────────────────

describe("learning-eval dataset and oracle", () => {
  it("refuses a probe that reuses what the warm arm was taught (held-out guard)", () => {
    const bad = {
      ...FIXTURE_DATASET,
      heldOut: [{ ...FIXTURE_DATASET.heldOut[0], errorMessage: FIXTURE_DATASET.train[0].errorMessage }],
    };
    expect(() => validateDataset(bad)).toThrow(/held-out probe must differ/);
  });

  it("refuses a version-1 scaffold dataset instead of pretending to run it", () => {
    expect(() => validateDataset({ version: 1, tasks: [] })).toThrow(/version 2/);
  });

  it("refuses resolvedBy that names a family nothing was taught for", () => {
    const bad = { ...FIXTURE_DATASET, heldOut: [{ ...FIXTURE_DATASET.heldOut[0], resolvedBy: ["nope"] }] };
    expect(() => validateDataset(bad)).toThrow(/unknown family nope/);
  });

  it("classifies recall against the DATASET's oracle, not against what was recalled", () => {
    const probe = validateDataset(FIXTURE_DATASET).heldOut[0];
    const trained = new Set(["fixture-metadata"]);
    const right = scoreProbe(probe, [{ instinctId: "i1", family: "fixture-metadata", confidence: 0.8 }], trained);
    expect(right.decision).toBe(DECISION.CORRECT);
    expect(right.repeatedError).toBe(false);
    expect(right.cost).toBe(probe.cost.withGuidance);

    const wrong = scoreProbe(probe, [{ instinctId: "i2", family: "something-else", confidence: 0.8 }], trained);
    expect(wrong.decision).toBe(DECISION.HARMFUL);
    expect(wrong.accepted).toBe(false);
    expect(wrong.cost).toBe(probe.cost.withoutGuidance + probe.cost.wrongGuidancePenalty);

    const silent = scoreProbe(probe, [], trained);
    expect(silent.decision).toBe(DECISION.NO_RECALL);
    expect(silent.repeatedError, "a solved failure mode came back and was not counted").toBe(true);
  });

  it("a judge rubric criterion is unscored, not silently passed", () => {
    const scored = scoreDeterministicRubric("mentions the reference", [
      { id: "a", weight: 1, kind: "must_contain", any: ["reference"] },
      { id: "b", weight: 9, kind: "judge", question: "is it kind?" },
    ]);
    expect(scored.score).toBe(1);
    expect(scored.unscored.map((u: { id: string }) => u.id)).toEqual(["b"]);
  });

  it("answer-level harm is counted when guidance lowers the rubric score", () => {
    const q = summariseQuality(
      [
        { id: "a", baseScore: 1, guidedScore: 0.5, tokens: 100 },
        { id: "b", baseScore: 0.5, guidedScore: 1, tokens: 100 },
      ],
      DEFAULT_THRESHOLDS,
    );
    expect(q.harm.worse).toBe(1);
    expect(q.harm.rate).toBe(0.5);
    expect(q.cost.tokensPerAccepted).toBe(200);
  });

  it("an answer-quality arm with nothing scorable is unmeasured", () => {
    const q = summariseQuality([{ id: "a", baseScore: null, guidedScore: null, tokens: 0 }], DEFAULT_THRESHOLDS);
    expect(q.state).toBe(STATE.UNMEASURED);
  });
});

// ─── the fixture run: real arms, real SQLite, real ledger ───────────────────

describe("learning-eval fixture run (real src/learning, throwaway SQLite)", () => {
  const dataset = validateDataset(FIXTURE_DATASET);
  let work: { dir: string; cleanup: () => void };
  const stores: Array<{ close: () => void }> = [];
  const runs: Record<string, any> = {};

  beforeAll(async () => {
    work = makeWorkDir("learning-eval-test-");
    for (const spec of ARM_SPECS) {
      const run = await runArm({ spec, dataset, learning, workDir: work.dir });
      runs[spec.name] = run;
      if (run.storage) stores.push(run.storage);
    }
  }, 60_000);

  afterAll(() => {
    for (const s of stores) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    work?.cleanup();
  });

  it("the cold arm is genuinely cold: an empty store and no recall", () => {
    const arm = runs["cold"].arm;
    expect(arm.error).toBeUndefined();
    expect(arm.instinctCount, "the cold arm found instincts it was never taught").toBe(0);
    expect(arm.totals.recalls).toBe(0);
  });

  it("the warm arms are genuinely warm: the same training produced a store to recall from", () => {
    expect(runs["warm-learning-on"].arm.instinctCount).toBeGreaterThan(0);
    expect(runs["warm-learning-off"].arm.instinctCount).toBeGreaterThan(0);
    expect(runs["warm-learning-on"].arm.dbPath).not.toBe(runs["warm-learning-off"].arm.dbPath);
  });

  it("MEASURE 1: learning reduces the repeat-error rate on held-out probes", () => {
    const arms = [runs["cold"].arm, runs["warm-learning-off"].arm, runs["warm-learning-on"].arm];
    const m = measureRepeatErrorReduction(arms, DEFAULT_THRESHOLDS);
    expect(m.state, m.reason).toBe(STATE.GOOD);
    expect(m.controlRate, "the control had the store and still recalled nothing?").toBe(1);
    expect(m.treatmentRate).toBe(0);
    expect(m.reduction).toBe(1);
  });

  it("MEASURE 2: the trap probe's recall is counted as harmful", () => {
    const arms = [runs["cold"].arm, runs["warm-learning-off"].arm, runs["warm-learning-on"].arm];
    const m = measureHarmfulRecall(arms, { ...DEFAULT_THRESHOLDS, maxHarmfulRecallRate: 0.6 }, null);
    expect(m.state).toBe(STATE.GOOD);
    expect(m.harmfulRecalls).toBe(1);
    expect(m.recalls).toBe(2);
    expect(m.outcomeRegressions, "the control accepted the trap and learning-on did not").toEqual(["fixture-p2"]);
  });

  it("MEASURE 2: a stricter budget turns the same numbers into a regression", () => {
    const arms = [runs["cold"].arm, runs["warm-learning-off"].arm, runs["warm-learning-on"].arm];
    const m = measureHarmfulRecall(arms, { ...DEFAULT_THRESHOLDS, maxHarmfulRecallRate: 0 }, null);
    expect(m.state).toBe(STATE.REGRESSED);
  });

  it("MEASURE 3: cost per accepted result is reported in attempts for both arms", () => {
    const arms = [runs["cold"].arm, runs["warm-learning-off"].arm, runs["warm-learning-on"].arm];
    const m = measureCostPerAccepted(arms, { ...DEFAULT_THRESHOLDS, maxCostRatio: 10 }, null);
    expect(m.state).toBe(STATE.GOOD);
    expect(m.unit).toBe("attempts");
    expect(m.controlCostPerAccepted).toBeGreaterThan(0);
    expect(m.treatmentCostPerAccepted).toBeGreaterThan(0);
    expect(m.ratio).toBeCloseTo(m.treatmentCostPerAccepted / m.controlCostPerAccepted, 10);
  });

  it("the ledger finds the wrongly-recalled rule and its effect ends on retirement", () => {
    const effect = measureEffectEnds({
      arm: runs["warm-learning-on"].arm,
      storage: runs["warm-learning-on"].storage,
      ledger: learning.ledger,
    });
    expect(effect.state, effect.reason).toBe(STATE.GOOD);
    expect(effect.rows.length, "no wrongly-recalled rule reached the ledger").toBeGreaterThan(0);
    for (const row of effect.rows) {
      expect(row.unmeasured, "the ledger called a rule with settled runs unmeasured").toBe(false);
      expect(row.inEffectBefore).toBe(true);
      expect(row.inEffectAfter, "retirement left the rule in effect").toBe(false);
      expect(row.runsAfterRetirement, "a run was credited AFTER the retirement").toBe(0);
      expect(row.effectEnded).toBe(true);
    }
    expect(
      effect.rows.some((r: { foundBySuspectSearch: boolean }) => r.foundBySuspectSearch),
      "no wrongly-recalled rule was findable without knowing its id",
    ).toBe(true);
    expect(
      effect.rows.some((r: { evidenceAgainst: number }) => r.evidenceAgainst > 0),
      "the failing run never became evidence against the rule",
    ).toBe(true);
  });

  it("the report names every measure and prints the exit contract", () => {
    const arms = [runs["cold"].arm, runs["warm-learning-off"].arm, runs["warm-learning-on"].arm];
    const measures = [
      measureRepeatErrorReduction(arms, DEFAULT_THRESHOLDS),
      measureHarmfulRecall(arms, DEFAULT_THRESHOLDS, null),
      measureCostPerAccepted(arms, DEFAULT_THRESHOLDS, null),
    ];
    const verdict = decideVerdict({ measures, arms, requested: [] });
    const text = renderReport({ ...verdict, arms, measures, requested: [] });
    expect(text).toContain("repeat-error-reduction");
    expect(text).toContain("harmful-recall");
    expect(text).toContain("cost-per-accepted");
    expect(text).toContain("SIMULATED");
    expect(text).toContain("exit contract");
  });

  it("A DELIBERATELY REGRESSED ARM IS REPORTED AS A REGRESSION (the harness can fail)", async () => {
    // The same trained store, with learning switched off in the treatment arm:
    // the treatment then cannot beat the control, so the gate MUST fire.
    const regressed = await runArm({
      spec: { name: "warm-learning-on", trained: true, learningEnabled: false },
      dataset,
      learning,
      workDir: work.dir,
    });
    stores.push(regressed.storage);
    const arms = [runs["warm-learning-off"].arm, regressed.arm];
    const measures = [
      measureRepeatErrorReduction(arms, DEFAULT_THRESHOLDS),
      measureHarmfulRecall(arms, DEFAULT_THRESHOLDS, null),
      measureCostPerAccepted(arms, DEFAULT_THRESHOLDS, null),
    ];
    const m1 = measures[0] as { state: string; reduction: number };
    expect(m1.state).toBe(STATE.REGRESSED);
    expect(m1.reduction).toBe(0);
    expect(decideVerdict({ measures, arms, requested: [] }).exitCode).toBe(EXIT.MEASURED_REGRESSED);
  }, 60_000);

  it("MUTANT: crediting the treatment arm's recalls to the control erases the finding", () => {
    // If the arms were not independent stores — if the control could see what
    // the treatment recalled — measure 1 would read 0% reduction and nothing
    // would be learnable from this harness. This is the shape of the bug the
    // separate temp databases exist to prevent.
    const mutant = summariseArm({
      name: "warm-learning-off",
      trained: true,
      learningEnabled: false,
      probes: runs["warm-learning-on"].arm.probes,
    });
    const m = measureRepeatErrorReduction([mutant, runs["warm-learning-on"].arm], DEFAULT_THRESHOLDS);
    expect(m.state).not.toBe(STATE.GOOD);
  });
});


// ─── the answer-quality arm, with an injected generator ─────────────────────

describe("learning-eval answer-quality arm", () => {
  const dataset = {
    quality: [
      {
        id: "q1",
        prompt: "the build cannot find Fixture.Modules.dll, what now?",
        rubric: [{ id: "names-the-fix", weight: 1, kind: "must_contain", any: ["build the dependency first"] }],
      },
    ],
  };

  it("injects the guidance production's retrieval actually returns, and scores both answers", async () => {
    const seen: string[] = [];
    const generate = async (system: string) => {
      seen.push(system);
      return { text: "build the dependency first", tokens: 10 };
    };
    const retriever = { getInsightsForTask: async () => ({ insights: ["[learned] build the dependency first"] }) };
    const q = await runQualityArm({ dataset, generate, retriever, thresholds: DEFAULT_THRESHOLDS });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toContain("LEARNED GUIDANCE");
    expect(seen[1], "the recalled guidance never reached the prompt").toContain("build the dependency first");
    expect(q.state).toBe(STATE.GOOD);
    expect(q.harm.worse).toBe(0);
    expect(q.cost.tokens).toBe(20);
  });

  it("counts guidance that makes the answer WORSE as harmful recall, and regresses measure 2", async () => {
    let call = 0;
    const generate = async () => {
      call++;
      return call === 1 ? { text: "build the dependency first", tokens: 5 } : { text: "reinstall unity", tokens: 5 };
    };
    const retriever = { getInsightsForTask: async () => ({ insights: ["[learned] reinstall unity"] }) };
    const q = await runQualityArm({ dataset, generate, retriever, thresholds: DEFAULT_THRESHOLDS });
    expect(q.harm.worse).toBe(1);
    expect(q.harm.rate).toBe(1);

    const probe = { id: "a", decision: DECISION.CORRECT, repeatable: true, repeatedError: false, accepted: true, cost: 1, recalled: [{ instinctId: "i", family: "f" }] };
    const arms = [
      summariseArm({ name: "warm-learning-off", trained: true, learningEnabled: false, probes: [probe] }),
      summariseArm({ name: "warm-learning-on", trained: true, learningEnabled: true, probes: [probe] }),
    ];
    const m = measureHarmfulRecall(arms, DEFAULT_THRESHOLDS, q);
    expect(m.state, "an answer made worse by recalled guidance was not reported").toBe(STATE.REGRESSED);
    expect(m.reason).toContain("scored WORSE with recalled guidance");
  });

  it("a provider that fails is UNMEASURED and names the provider's own error", async () => {
    const generate = async () => {
      throw new Error("API error 401: Insufficient balance");
    };
    const q = await runQualityArm({ dataset, generate, retriever: null, thresholds: DEFAULT_THRESHOLDS });
    expect(q.state).toBe(STATE.UNMEASURED);
    expect(q.reason).toContain("Insufficient balance");
  });

  /**
   * PARTIAL MEASUREMENT IS NOT A PASS (Codex round 12 #25).
   *
   * summariseQuality used to keep only the cases that produced two scorable
   * answers and report measured-good over those: a second case that died at the
   * provider, a retrieval call that threw, or a rubric criterion nothing could
   * score all vanished from the verdict. The harness then said "measured and
   * good" about a measurement it had not finished.
   *
   * The rule, in both directions: incomplete downgrades GOOD to NOT MEASURED,
   * and what WAS measured is still carried, so a regression the partial run did
   * find still outranks the incompleteness.
   */
  it("a quality case that died at the provider makes the arm NOT MEASURED, not measured-good", () => {
    const q = summariseQuality(
      [
        { id: "a", baseScore: 1, guidedScore: 1, tokens: 20 },
        { id: "b", baseScore: null, guidedScore: null, tokens: 0, error: "API error 401: Insufficient balance" },
      ],
      DEFAULT_THRESHOLDS,
    );
    expect(q.state, "one case answered and one dead at the provider reported as a pass").toBe(STATE.UNMEASURED);
    expect(q.reason).toContain("Insufficient balance");
    expect(q.reason).toContain("b");
    // What DID run is still reported — it has to be, or the regression below is lost.
    expect(q.harm.compared).toBe(1);
  });

  it("a retrieval failure is NOT MEASURED even when both answers scored", () => {
    const q = summariseQuality(
      [{ id: "a", baseScore: 1, guidedScore: 1, tokens: 20, retrievalError: "storage is closed" }],
      DEFAULT_THRESHOLDS,
    );
    expect(q.state, "a case whose guidance retrieval threw was folded into a pass").toBe(STATE.UNMEASURED);
    expect(q.reason).toContain("storage is closed");
  });

  it("a rubric criterion nothing scored is NOT MEASURED, not a silent pass", () => {
    const q = summariseQuality(
      [{ id: "a", baseScore: 1, guidedScore: 1, tokens: 20, unscoredCriteria: ["is-it-actionable"] }],
      DEFAULT_THRESHOLDS,
    );
    expect(q.state, "an unscored judge criterion was folded into a pass").toBe(STATE.UNMEASURED);
    expect(q.reason).toContain("is-it-actionable");
  });

  it("PRECEDENCE: an incomplete quality arm still REGRESSES, it does not hide behind NOT MEASURED", () => {
    const q = summariseQuality(
      [
        { id: "a", baseScore: 1, guidedScore: 0.4, tokens: 20 },
        { id: "b", baseScore: null, guidedScore: null, tokens: 0, error: "provider timed out" },
      ],
      DEFAULT_THRESHOLDS,
    );
    expect(q.state).toBe(STATE.UNMEASURED);
    expect(q.harm.worse).toBe(1);

    const probe = {
      id: "p", decision: DECISION.CORRECT, repeatable: true, repeatedError: false,
      accepted: true, cost: 1, recalled: [{ instinctId: "i", family: "f" }],
    };
    const arms = [
      summariseArm({ name: "warm-learning-off", trained: true, learningEnabled: false, probes: [probe] }),
      summariseArm({ name: "warm-learning-on", trained: true, learningEnabled: true, probes: [probe] }),
    ];
    const m = measureHarmfulRecall(arms, DEFAULT_THRESHOLDS, q);
    expect(m.state, "harm found by a partial quality arm was dropped with the arm's state").toBe(STATE.REGRESSED);
    expect(m.reason).toContain("scored WORSE with recalled guidance");

    const v = decideVerdict({
      measures: [m],
      arms: [],
      requested: [{ name: "answer-quality", state: q.state, reason: q.reason }],
    });
    expect(v.exitCode, "NOT MEASURED outranked a regression").toBe(EXIT.MEASURED_REGRESSED);
  });

  it("the whole quality arm is NOT MEASURED when only some of the requested prompts were answered", async () => {
    const twoCases = {
      quality: [
        { id: "q1", prompt: "first", rubric: [{ id: "r", weight: 1, kind: "must_contain", any: ["fix"] }] },
        { id: "q2", prompt: "second", rubric: [{ id: "r", weight: 1, kind: "must_contain", any: ["fix"] }] },
      ],
    };
    let call = 0;
    const generate = async () => {
      call += 1;
      if (call > 2) throw new Error("API error 429: rate limited");
      return { text: "fix it", tokens: 5 };
    };
    const q = await runQualityArm({ dataset: twoCases, generate, retriever: null, thresholds: DEFAULT_THRESHOLDS });
    expect(q.state, "one answered prompt and one rate-limited prompt reported as measured-good").toBe(STATE.UNMEASURED);
    expect(q.reason).toContain("429");
    expect(q.compared).toBe(1);
  });

  it("a dataset with no quality cases is unmeasured, not a pass", async () => {
    const q = await runQualityArm({
      dataset: { quality: [] },
      generate: async () => ({ text: "x", tokens: 1 }),
      retriever: null,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(q.state).toBe(STATE.UNMEASURED);
    expect(q.reason).toContain("no quality cases");
  });
});

// ─── end to end: the CLI's exit codes ──────────────────────────────────────

describe("learning-eval CLI exit codes", () => {
  let dir: string;
  let datasetPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "learning-eval-cli-"));
    datasetPath = join(dir, "fixture.json");
    writeFileSync(datasetPath, JSON.stringify(FIXTURE_DATASET), "utf8");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });

  it("exit 2 on a bad invocation", () => {
    const r = run(["--nope"]);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("unknown argument");
  });

  it("exit 2 on an unreadable dataset", () => {
    const r = run(["--ablation-only", "--dataset", join(dir, "missing.json")]);
    expect(r.status).toBe(EXIT.USAGE);
  });

  it("exit 0 when every requested measure ran inside its bound", () => {
    const r = run([
      "--ablation-only",
      "--dataset",
      datasetPath,
      "--max-harmful-recall",
      "0.6",
      "--max-cost-ratio",
      "10",
    ]);
    expect(r.stdout + r.stderr).toContain("VERDICT: MEASURED-GOOD");
    expect(r.status).toBe(EXIT.MEASURED_GOOD);
  }, 120_000);

  it("exit 1 when a measure ran and breached its bound", () => {
    const r = run(["--ablation-only", "--dataset", datasetPath, "--max-harmful-recall", "0", "--max-cost-ratio", "10"]);
    expect(r.stdout).toContain("VERDICT: MEASURED-REGRESSED");
    expect(r.status).toBe(EXIT.MEASURED_REGRESSED);
  }, 120_000);

  it("exit 3 when a requested arm could not be measured — the skip is not a pass", () => {
    // The answer-quality arm is requested by default; with no provider
    // credential in the child's environment it cannot run, and the run must NOT
    // come back 0 on the strength of the ablation arms alone.
    const r = spawnSync(process.execPath, [CLI, "--dataset", datasetPath, "--max-harmful-recall", "0.6", "--max-cost-ratio", "10"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PROVIDER_CHAIN: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        KIMI_API_KEY: "",
        DEEPSEEK_API_KEY: "",
        OPENCODE_API_KEY: "",
        OPENAI_AUTH_MODE: "",
      },
    });
    expect(r.stdout).toContain("NOT MEASURED");
    expect(r.status).toBe(EXIT.NOT_MEASURED);
  }, 120_000);

  it("--verify-can-fail proves the gate fires on the real arms", () => {
    const r = run(["--verify-can-fail", "--dataset", datasetPath]);
    expect(r.stdout).toContain("the gate fires");
    expect(r.status).toBe(EXIT.MEASURED_REGRESSED);
  }, 120_000);
});
