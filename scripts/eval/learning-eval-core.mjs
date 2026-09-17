/**
 * learning-eval-core.mjs — the ablation harness's LOGIC, with no I/O and no
 * learning imports, so every number it produces can be tested (tests/eval/).
 *
 * Plan item 6.3. Three measures, and one rule that outranks them:
 *
 *   1. REPEAT-ERROR REDUCTION — with learning on, does the system walk into a
 *      failure mode it has already solved once?
 *   2. HARMFUL RECALL — does the guidance it recalls make the outcome WORSE
 *      than not recalling anything?
 *   3. COST PER ACCEPTED RESULT — what does one accepted result cost, with
 *      learning on versus the same store never consulted?
 *
 *   "SKIPPED" IS NOT "MEASURED". An arm that could not run is reported as
 *   unmeasured and is never folded into a pass; the exit code distinguishes
 *   measured-and-good (0) from measured-and-regressed (1) from not-measured (3).
 *
 * HONESTY CONTRACT
 *   - Retrieval, storage, credit settlement and the ledger are REAL: the arms
 *     drive src/learning against throwaway SQLite databases created for the run.
 *   - TOOL EXECUTION IS NOT REAL. Whether a probe ends accepted, and what it
 *     costs, comes from an oracle DECLARED IN THE DATASET — pre-registered, not
 *     inferred from what the system happened to recall. The harness prints this
 *     on every run; a reader must never mistake the cost figures for wall-clock
 *     provider spend.
 *   - Rates whose denominator is zero are reported as unmeasured, never as 0
 *     and never as a pass.
 *   - No comparative ("better than <other assistant>") claim is produced here.
 */

// ─── Exit contract ──────────────────────────────────────────────────────────

export const EXIT = Object.freeze({
  /** every requested measure ran and stayed inside its pre-registered bound */
  MEASURED_GOOD: 0,
  /** something RAN and came out worse than its bound */
  MEASURED_REGRESSED: 1,
  /** bad invocation, unreadable dataset, harness error */
  USAGE: 2,
  /** nothing (or not everything) could be measured — never a pass */
  NOT_MEASURED: 3,
});

export const STATE = Object.freeze({
  GOOD: "measured-good",
  REGRESSED: "measured-regressed",
  UNMEASURED: "not-measured",
});

/** Classification of one probe's decision. */
export const DECISION = Object.freeze({
  NO_RECALL: "no-recall",
  CORRECT: "correct-recall",
  HARMFUL: "harmful-recall",
});

export const RUBRIC_KINDS = ["must_contain", "must_not_contain", "regex", "judge"];

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** learning must remove at least this fraction of the control's repeat errors */
  minRepeatErrorReduction: 0.5,
  /** at most this fraction of what gets recalled may be guidance that does not apply */
  maxHarmfulRecallRate: 0.34,
  /** learning-on cost per accepted result, over the control's */
  maxCostRatio: 1.1,
  /** a generated answer is "accepted" at or above this rubric score */
  minQualityAccept: 0.7,
  /** fraction of prompts where injected guidance may lower the rubric score */
  maxQualityHarmRate: 0.0,
});

// ─── Dataset ────────────────────────────────────────────────────────────────
//
// A dataset is { version: 2, thresholds?, train: TrainFamily[], heldOut: Probe[],
// quality?: QualityCase[] }.
//
//   TrainFamily = {
//     family: string,          // stable id; a probe names the families that resolve it
//     title: string,
//     tool: string,            // the tool whose failure is taught
//     target: object,          // tool input; the repair must act on the SAME target
//     errorMessage: string,    // what the failing call printed
//     repairs: number,         // successful runs credited after the fix (confidence needs them)
//   }
//
//   Probe = {                  // HELD OUT: never shown to the training phase
//     id, title,
//     family: string|null,     // the failure mode this re-presents, null when novel
//     tool, errorMessage, errorCode?, filePath?,
//     resolvedBy: string[],    // families whose guidance actually resolves this probe
//     cost: { withoutGuidance, withGuidance, wrongGuidancePenalty },
//     accepted: { withoutGuidance: bool, whenMisled: bool },
//   }
//
//   QualityCase = { id, prompt, rubric: RubricCriterion[] }
//
// A probe with resolvedBy: [] is a TRAP: guidance recalled for it is, by
// construction, guidance that does not apply. Traps are how measure 2 can fail.

/** Small dataset used by the harness's own tests. Deliberately minimal. */
export const FIXTURE_DATASET = Object.freeze({
  version: 2,
  train: [
    {
      family: "fixture-metadata",
      title: "fixture: missing metadata file",
      tool: "dotnet_build",
      target: { file_path: "/fixture/App.csproj" },
      errorMessage: "error CS0006: Metadata file '/fixture/Bin/Fixture.Core.dll' could not be found",
      repairs: 4,
    },
  ],
  heldOut: [
    {
      id: "fixture-p1",
      title: "same failure mode, different assembly",
      family: "fixture-metadata",
      tool: "dotnet_build",
      errorCode: "CS0006",
      errorMessage: "error CS0006: Metadata file '/fixture/Bin/Fixture.Modules.dll' could not be found",
      resolvedBy: ["fixture-metadata"],
      cost: { withoutGuidance: 3, withGuidance: 1, wrongGuidancePenalty: 1 },
      accepted: { withoutGuidance: true, whenMisled: false },
    },
    {
      id: "fixture-p2",
      title: "trap: same code, cause the taught fix cannot touch",
      family: null,
      tool: "dotnet_build",
      errorCode: "CS0006",
      errorMessage: "error CS0006: Metadata file 'Fixture.Deleted.dll' could not be found",
      resolvedBy: [],
      cost: { withoutGuidance: 3, withGuidance: 1, wrongGuidancePenalty: 2 },
      accepted: { withoutGuidance: true, whenMisled: false },
    },
  ],
  quality: [],
});

function fail(message) {
  const err = new Error(message);
  err.datasetError = true;
  return err;
}

/** Validate and normalise a dataset. Throws with a reader-usable message. */
export function validateDataset(raw) {
  if (!raw || typeof raw !== "object") throw fail("dataset must be a JSON object");
  if (raw.version !== 2) {
    throw fail(
      `dataset version ${JSON.stringify(raw.version)} is not supported — this harness reads version 2 ` +
        `({ version: 2, train: [...], heldOut: [...] }). Version 1 described the old scaffold and has no arms.`,
    );
  }
  if (!Array.isArray(raw.train) || raw.train.length === 0) throw fail("dataset.train must be a non-empty array");
  if (!Array.isArray(raw.heldOut) || raw.heldOut.length === 0) throw fail("dataset.heldOut must be a non-empty array");

  const families = new Set();
  for (const t of raw.train) {
    if (!t?.family) throw fail("each train entry needs a family id");
    if (families.has(t.family)) throw fail(`duplicate train family: ${t.family}`);
    families.add(t.family);
    if (!t.tool) throw fail(`train ${t.family}: tool is required`);
    if (!t.errorMessage) throw fail(`train ${t.family}: errorMessage is required`);
    if (!t.target || typeof t.target !== "object") throw fail(`train ${t.family}: target (tool input) is required`);
  }

  const ids = new Set();
  const probes = [];
  for (const p of raw.heldOut) {
    if (!p?.id) throw fail("each heldOut probe needs an id");
    if (ids.has(p.id)) throw fail(`duplicate probe id: ${p.id}`);
    ids.add(p.id);
    if (!p.tool) throw fail(`probe ${p.id}: tool is required`);
    if (!p.errorMessage) throw fail(`probe ${p.id}: errorMessage is required`);
    if (!Array.isArray(p.resolvedBy)) throw fail(`probe ${p.id}: resolvedBy must be an array (use [] for a trap)`);
    for (const f of p.resolvedBy) {
      if (!families.has(f)) throw fail(`probe ${p.id}: resolvedBy names unknown family ${f}`);
    }
    if (p.family != null && !families.has(p.family)) {
      throw fail(`probe ${p.id}: family ${p.family} is not a trained family`);
    }
    // HELD OUT: a probe must not be the training case itself.
    for (const t of raw.train) {
      if (t.errorMessage === p.errorMessage) {
        throw fail(
          `probe ${p.id} re-uses train family ${t.family}'s exact errorMessage — a held-out probe must differ ` +
            `from what the warm arm was taught, or the arm is only asked to remember, not to generalise`,
        );
      }
    }
    probes.push({
      ...p,
      cost: {
        withoutGuidance: p.cost?.withoutGuidance ?? 3,
        withGuidance: p.cost?.withGuidance ?? 1,
        wrongGuidancePenalty: p.cost?.wrongGuidancePenalty ?? 1,
      },
      accepted: {
        withoutGuidance: p.accepted?.withoutGuidance ?? true,
        whenMisled: p.accepted?.whenMisled ?? false,
      },
    });
  }

  for (const q of raw.quality ?? []) {
    if (!q?.id) throw fail("each quality case needs an id");
    if (!q.prompt) throw fail(`quality ${q.id}: prompt is required`);
    for (const c of q.rubric ?? []) {
      if (!RUBRIC_KINDS.includes(c.kind)) throw fail(`quality ${q.id}: unknown rubric kind ${c.kind}`);
    }
  }

  return {
    version: 2,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
    train: raw.train,
    heldOut: probes,
    quality: raw.quality ?? [],
    ...(raw.notes ? { notes: raw.notes } : {}),
  };
}

// ─── The oracle ─────────────────────────────────────────────────────────────

/**
 * Score ONE probe from the guidance the real system recalled for it.
 *
 * `recalled` is what production retrieval returned, highest-confidence first,
 * each entry carrying the family it was learned from (null when it came from
 * somewhere the harness did not teach). Everything else — cost, acceptance —
 * is the dataset's pre-registered oracle.
 */
export function scoreProbe(probe, recalled, trainedFamilies) {
  const top = recalled[0];
  const repeatable = probe.family != null && trainedFamilies.has(probe.family);
  const resolves = new Set(probe.resolvedBy);
  const misleading = recalled.filter((r) => !resolves.has(r.family)).length;

  let decision;
  if (!top) decision = DECISION.NO_RECALL;
  else if (resolves.has(top.family)) decision = DECISION.CORRECT;
  else decision = DECISION.HARMFUL;

  let cost;
  let accepted;
  if (decision === DECISION.CORRECT) {
    cost = probe.cost.withGuidance;
    accepted = true;
  } else if (decision === DECISION.HARMFUL) {
    cost = probe.cost.withoutGuidance + probe.cost.wrongGuidancePenalty;
    accepted = probe.accepted.whenMisled;
  } else {
    cost = probe.cost.withoutGuidance;
    accepted = probe.accepted.withoutGuidance;
  }

  return {
    id: probe.id,
    title: probe.title ?? probe.id,
    family: probe.family ?? null,
    decision,
    repeatable,
    /** the failure mode it had already solved came back */
    repeatedError: repeatable && decision !== DECISION.CORRECT,
    accepted,
    cost,
    injected: recalled.length,
    misleading,
    recalled: recalled.map((r) => ({
      instinctId: r.instinctId,
      family: r.family ?? null,
      matchType: r.matchType ?? null,
      confidence: r.confidence ?? null,
      ...(r.path ? { path: r.path } : {}),
    })),
  };
}

/** Roll a scored probe list into one arm's totals. */
export function summariseArm(arm) {
  const probes = arm.probes ?? [];
  const totals = {
    probes: probes.length,
    recalls: 0,
    correctRecalls: 0,
    harmfulRecalls: 0,
    repeatable: 0,
    repeated: 0,
    accepted: 0,
    cost: 0,
  };
  for (const p of probes) {
    if (p.decision !== DECISION.NO_RECALL) totals.recalls++;
    if (p.decision === DECISION.CORRECT) totals.correctRecalls++;
    if (p.decision === DECISION.HARMFUL) totals.harmfulRecalls++;
    if (p.repeatable) totals.repeatable++;
    if (p.repeatedError) totals.repeated++;
    if (p.accepted) totals.accepted++;
    totals.cost += p.cost;
  }
  return {
    ...arm,
    totals: {
      ...totals,
      repeatErrorRate: totals.repeatable > 0 ? totals.repeated / totals.repeatable : null,
      harmfulRecallRate: totals.recalls > 0 ? totals.harmfulRecalls / totals.recalls : null,
      costPerAccepted: totals.accepted > 0 ? totals.cost / totals.accepted : null,
    },
  };
}

// ─── The three measures ─────────────────────────────────────────────────────

function unmeasured(name, reason, extra = {}) {
  return { name, state: STATE.UNMEASURED, reason, ...extra };
}

/**
 * Measure 1 — repeat-error reduction.
 *
 * Control is the WARM arm with learning switched off: the same trained store,
 * never consulted. The cold arm cannot answer this (nothing was taught in it,
 * so nothing of its own can repeat) and is reported as such.
 */
export function measureRepeatErrorReduction(arms, thresholds) {
  const control = arms.find((a) => a.name === "warm-learning-off");
  const treatment = arms.find((a) => a.name === "warm-learning-on");
  if (!control || !treatment) {
    return unmeasured("repeat-error-reduction", "the warm control and/or treatment arm did not run");
  }
  const c = control.totals.repeatErrorRate;
  const t = treatment.totals.repeatErrorRate;
  if (control.totals.repeatable === 0 || treatment.totals.repeatable === 0) {
    return unmeasured(
      "repeat-error-reduction",
      "no held-out probe re-presents a trained failure mode, so there is nothing that could repeat",
      { controlRepeatable: control.totals.repeatable, treatmentRepeatable: treatment.totals.repeatable },
    );
  }
  if (c === 0) {
    return unmeasured(
      "repeat-error-reduction",
      "the control repeated nothing, so there is no repeat-error rate to reduce (learning cannot be credited)",
      { controlRate: c, treatmentRate: t },
    );
  }
  const reduction = (c - t) / c;
  return {
    name: "repeat-error-reduction",
    state: reduction >= thresholds.minRepeatErrorReduction ? STATE.GOOD : STATE.REGRESSED,
    reason:
      reduction >= thresholds.minRepeatErrorReduction
        ? `learning removed ${(reduction * 100).toFixed(0)}% of the control's repeat errors`
        : `learning removed only ${(reduction * 100).toFixed(0)}% of the control's repeat errors (needs ${(
            thresholds.minRepeatErrorReduction * 100
          ).toFixed(0)}%)`,
    controlRate: c,
    treatmentRate: t,
    reduction,
    threshold: thresholds.minRepeatErrorReduction,
    controlRepeated: control.totals.repeated,
    treatmentRepeated: treatment.totals.repeated,
    repeatable: treatment.totals.repeatable,
  };
}

/**
 * Measure 2 — harmful recall.
 *
 * Two readings, both reported: the RATE at which recalled guidance does not
 * apply, and the OUTCOME regressions — probes the control accepted and the
 * learning-on arm did not. The second is the stronger claim ("recall made it
 * worse"), the first is the one with a bound.
 */
export function measureHarmfulRecall(arms, thresholds, quality) {
  const control = arms.find((a) => a.name === "warm-learning-off");
  const treatment = arms.find((a) => a.name === "warm-learning-on");
  if (!treatment) return unmeasured("harmful-recall", "the learning-on arm did not run");

  const byId = new Map((control?.probes ?? []).map((p) => [p.id, p]));
  const outcomeRegressions = [];
  const costRegressions = [];
  for (const p of treatment.probes) {
    const base = byId.get(p.id);
    if (!base) continue;
    if (base.accepted && !p.accepted) outcomeRegressions.push(p.id);
    else if (p.cost > base.cost) costRegressions.push(p.id);
  }

  const rate = treatment.totals.harmfulRecallRate;
  // The harm a quality arm measured counts even when the arm as a whole is NOT
  // MEASURED (some case died at the provider): a regression that was actually
  // observed must not be dropped along with the incompleteness. `harm` is
  // absent when nothing was compared at all, so nothing is invented here.
  const answerHarm = quality?.harm ?? null;

  if (rate === null) {
    return unmeasured(
      "harmful-recall",
      "the learning-on arm recalled nothing on any held-out probe, so no recall could be harmful " +
        "(this is NOT evidence that recall is safe — measure 1 will show the same emptiness)",
      { recalls: 0, outcomeRegressions, costRegressions, ...(answerHarm ? { answerHarm } : {}) },
    );
  }

  const withinRate = rate <= thresholds.maxHarmfulRecallRate;
  const answerOk = !answerHarm || answerHarm.rate <= thresholds.maxQualityHarmRate;
  const good = withinRate && answerOk;
  return {
    name: "harmful-recall",
    state: good ? STATE.GOOD : STATE.REGRESSED,
    reason: good
      ? `${treatment.totals.harmfulRecalls} of ${treatment.totals.recalls} recall(s) did not apply, within the budget`
      : [
          withinRate ? null : `${treatment.totals.harmfulRecalls} of ${treatment.totals.recalls} recall(s) did not apply ` +
              `(rate ${rate.toFixed(2)} over budget ${thresholds.maxHarmfulRecallRate})`,
          answerOk ? null : `${answerHarm.worse} of ${answerHarm.compared} answer(s) scored WORSE with recalled guidance`,
        ]
          .filter(Boolean)
          .join("; "),
    rate,
    threshold: thresholds.maxHarmfulRecallRate,
    harmfulRecalls: treatment.totals.harmfulRecalls,
    recalls: treatment.totals.recalls,
    outcomeRegressions,
    costRegressions,
    ...(answerHarm ? { answerHarm } : {}),
  };
}

/**
 * Measure 3 — cost per accepted result.
 *
 * Ablation cost is in ATTEMPTS (tool invocations the oracle charges), never in
 * currency. The quality arm, when it runs, adds real provider tokens per
 * accepted answer — the only cost figure here that is not simulated.
 */
export function measureCostPerAccepted(arms, thresholds, quality) {
  const control = arms.find((a) => a.name === "warm-learning-off");
  const treatment = arms.find((a) => a.name === "warm-learning-on");
  const cold = arms.find((a) => a.name === "cold");
  if (!control || !treatment) return unmeasured("cost-per-accepted", "the warm control and/or treatment arm did not run");

  const c = control.totals.costPerAccepted;
  const t = treatment.totals.costPerAccepted;
  if (c === null || t === null) {
    return unmeasured("cost-per-accepted", "an arm accepted nothing, so cost per accepted result is undefined", {
      controlAccepted: control.totals.accepted,
      treatmentAccepted: treatment.totals.accepted,
    });
  }
  const ratio = t / c;
  // Same rule as measure 2: tokens the quality arm really spent are reported
  // even when that arm is incomplete. They are a cost reading, not a pass.
  const tokens = quality?.cost ?? null;
  return {
    name: "cost-per-accepted",
    state: ratio <= thresholds.maxCostRatio ? STATE.GOOD : STATE.REGRESSED,
    reason:
      ratio <= thresholds.maxCostRatio
        ? `${t.toFixed(2)} attempts per accepted result with learning on vs ${c.toFixed(2)} without (ratio ${ratio.toFixed(2)})`
        : `learning on costs ${t.toFixed(2)} attempts per accepted result vs ${c.toFixed(2)} without ` +
          `(ratio ${ratio.toFixed(2)} over ${thresholds.maxCostRatio})`,
    unit: "attempts",
    controlCostPerAccepted: c,
    treatmentCostPerAccepted: t,
    ...(cold ? { coldCostPerAccepted: cold.totals.costPerAccepted } : {}),
    ratio,
    threshold: thresholds.maxCostRatio,
    ...(tokens ? { providerTokens: tokens } : {}),
  };
}

// ─── Verdict and exit code ──────────────────────────────────────────────────

/**
 * Fold arms and measures into the run's verdict.
 *
 * A regression outranks an unmeasured measure (something ran and came out
 * worse — say so), and an unmeasured measure outranks every good one: a pass
 * requires that EVERY requested measure actually ran.
 */
export function decideVerdict({ measures, arms = [], requested = [] }) {
  const reasons = [];
  let regressed = false;
  let missing = false;

  for (const arm of arms) {
    // An arm that threw measured NOTHING. It is never a pass, and it is not a
    // regression either — nothing was compared.
    if (arm.error) {
      missing = true;
      reasons.push(`arm ${arm.name} failed to run: ${arm.error}`);
    }
  }
  for (const m of measures) {
    if (m.state === STATE.REGRESSED) {
      regressed = true;
      reasons.push(`${m.name}: ${m.reason}`);
    } else if (m.state === STATE.UNMEASURED) {
      missing = true;
      reasons.push(`${m.name}: NOT MEASURED — ${m.reason}`);
    }
  }
  for (const r of requested) {
    if (r.state === STATE.UNMEASURED) {
      missing = true;
      reasons.push(`arm ${r.name}: NOT MEASURED — ${r.reason}`);
    } else if (r.state === STATE.REGRESSED) {
      regressed = true;
      reasons.push(`arm ${r.name}: ${r.reason}`);
    }
  }

  if (regressed) return { verdict: STATE.REGRESSED, exitCode: EXIT.MEASURED_REGRESSED, reasons };
  if (missing) return { verdict: STATE.UNMEASURED, exitCode: EXIT.NOT_MEASURED, reasons };
  if (measures.length === 0) {
    return { verdict: STATE.UNMEASURED, exitCode: EXIT.NOT_MEASURED, reasons: ["no measure ran"] };
  }
  return { verdict: STATE.GOOD, exitCode: EXIT.MEASURED_GOOD, reasons };
}

// ─── Answer-quality rubric (Part B) ─────────────────────────────────────────

/**
 * Score the deterministic rubric criteria for one answer. `judge` criteria need
 * a second real model; without one they are counted as UNMEASURED and excluded
 * from the score's denominator rather than silently passed.
 */
export function scoreDeterministicRubric(answer, rubric) {
  const text = (answer ?? "").toLowerCase();
  let weighted = 0;
  let total = 0;
  const detail = [];
  const unscored = [];
  for (const c of rubric ?? []) {
    const w = c.weight ?? 1;
    if (c.kind === "judge") {
      unscored.push({ id: c.id, kind: c.kind, weight: w, reason: "needs an LLM judge" });
      continue;
    }
    let pass = false;
    if (c.kind === "must_contain") pass = (c.any ?? []).some((s) => text.includes(String(s).toLowerCase()));
    else if (c.kind === "must_not_contain") pass = !(c.all ?? []).some((s) => text.includes(String(s).toLowerCase()));
    else if (c.kind === "regex") pass = new RegExp(c.pattern, "i").test(answer ?? "");
    weighted += pass ? w : 0;
    total += w;
    detail.push({ id: c.id, kind: c.kind, weight: w, pass });
  }
  return { score: total > 0 ? weighted / total : null, detail, unscored };
}

/**
 * Roll per-case answer pairs (no guidance vs recalled guidance) into the
 * quality arm's contribution to measures 2 and 3.
 */
export function summariseQuality(cases, thresholds) {
  const compared = cases.filter((c) => c.baseScore !== null && c.guidedScore !== null);
  if (compared.length === 0) {
    // An unmeasured arm has to say WHY in terms a reader can act on: the
    // provider's own error, not "nothing was scorable".
    const errors = [...new Set(cases.map((c) => c.error).filter(Boolean))];
    if (cases.length === 0) {
      return unmeasured("answer-quality", "the dataset has no quality cases (nothing was asked of a provider)");
    }
    return unmeasured(
      "answer-quality",
      errors.length > 0
        ? `every prompt failed at the provider: ${errors.join("; ")}`
        : "no case produced two scorable answers",
      { cases },
    );
  }
  const worse = compared.filter((c) => c.guidedScore < c.baseScore);
  const accepted = compared.filter((c) => c.guidedScore >= thresholds.minQualityAccept).length;
  const tokens = cases.reduce((sum, c) => sum + (c.tokens ?? 0), 0);
  const measured = {
    name: "answer-quality",
    compared: compared.length,
    harm: {
      compared: compared.length,
      worse: worse.length,
      rate: worse.length / compared.length,
      cases: worse.map((c) => ({ id: c.id, base: c.baseScore, guided: c.guidedScore })),
    },
    cost: {
      unit: "provider tokens",
      tokens,
      accepted,
      tokensPerAccepted: accepted > 0 ? tokens / accepted : null,
    },
    cases,
  };

  // A PARTIAL measurement is not a pass. Every requested case that did not get
  // all the way through — no scorable answer pair, a retrieval call that threw,
  // a rubric criterion nothing could score — downgrades this arm to NOT
  // MEASURED. The numbers that WERE produced stay on the result, so harm the
  // partial run did find still reaches measure 2 and still outranks the
  // incompleteness (REGRESSED beats NOT MEASURED).
  const incomplete = incompleteQualityCases(cases);
  if (incomplete.length > 0) {
    return {
      ...measured,
      state: STATE.UNMEASURED,
      incomplete,
      reason:
        `only ${compared.length} of ${cases.length} requested quality case(s) were measured end to end; `
        + `${incomplete.length} incomplete: ${incomplete.join("; ")} `
        + "(the harm found in the cases that DID run is still reported and still regresses measure 2)",
    };
  }
  return { ...measured, state: STATE.GOOD };
}

/**
 * Why a requested quality case cannot be counted as measured. Each entry names
 * the case and what stopped it, so the verdict's reason is actionable.
 */
export function incompleteQualityCases(cases) {
  const incomplete = [];
  for (const c of cases ?? []) {
    if (c.baseScore === null || c.baseScore === undefined || c.guidedScore === null || c.guidedScore === undefined) {
      incomplete.push(`${c.id}: no scorable answer pair${c.error ? ` (${c.error})` : ""}`);
      continue;
    }
    if (c.error) incomplete.push(`${c.id}: ${c.error}`);
    if (c.retrievalError) incomplete.push(`${c.id}: guidance retrieval failed (${c.retrievalError})`);
    const unscored = c.unscoredCriteria ?? [];
    if (unscored.length > 0) {
      incomplete.push(`${c.id}: rubric criteria nothing scored (${unscored.join(", ")})`);
    }
  }
  return incomplete;
}

// ─── The answer-quality arm (Part B) ────────────────────────────────────────

const QUALITY_SYSTEM =
  "You are a Unity/C# build assistant. Answer the user's question directly and concretely in at most 120 words.";

/**
 * For each quality case: one answer with no learned guidance, one with the
 * guidance production's proactive retrieval would actually inject, both scored
 * against the same ABSOLUTE rubric. Guidance that lowers the score is harmful
 * recall at the answer level (measure 2).
 */
export async function runQualityArm({ dataset, generate, retriever, thresholds }) {
  const cases = [];
  for (const q of dataset.quality) {
    let insights = [];
    let retrievalError = null;
    if (retriever) {
      try {
        const result = await retriever.getInsightsForTask(q.prompt, 3);
        insights = result.insights ?? [];
      } catch (err) {
        insights = [];
        retrievalError = err instanceof Error ? err.message : String(err);
      }
    }
    const guidedSystem =
      insights.length > 0
        ? `${QUALITY_SYSTEM}\n\n[LEARNED GUIDANCE]\n${insights.join("\n")}\n[END LEARNED GUIDANCE]`
        : QUALITY_SYSTEM;

    let base;
    let guided;
    let error = null;
    try {
      base = await generate(QUALITY_SYSTEM, q.prompt);
      guided = await generate(guidedSystem, q.prompt);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (error) {
      cases.push({
        id: q.id, baseScore: null, guidedScore: null, tokens: 0, error,
        injectedGuidance: insights.length,
        ...(retrievalError ? { retrievalError } : {}),
      });
      continue;
    }
    const baseScored = scoreDeterministicRubric(base.text, q.rubric);
    const guidedScored = scoreDeterministicRubric(guided.text, q.rubric);
    cases.push({
      id: q.id,
      injectedGuidance: insights.length,
      baseScore: baseScored.score,
      guidedScore: guidedScored.score,
      unscoredCriteria: baseScored.unscored.map((u) => u.id),
      tokens: (base.tokens ?? 0) + (guided.tokens ?? 0),
      ...(retrievalError ? { retrievalError } : {}),
    });
  }
  return summariseQuality(cases, thresholds);
}

// ─── Report ─────────────────────────────────────────────────────────────────

function pct(v) {
  return v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(0)}%`;
}
function num(v, digits = 2) {
  return v === null || v === undefined ? "n/a" : v.toFixed(digits);
}

export function renderReport(result) {
  const L = [];
  const bar = "=".repeat(74);
  L.push(bar);
  L.push("Strada.Brain learning ablation harness (plan 6.3)");
  L.push("Retrieval, storage, credit settlement and the ledger are REAL, against");
  L.push("throwaway SQLite databases. TOOL EXECUTION IS SIMULATED by the dataset's");
  L.push("pre-registered oracle — cost is in attempts, not currency. No comparative");
  L.push("claim about any other assistant is made or implied.");
  L.push(bar);

  L.push("");
  L.push("ARMS");
  L.push(
    `  ${"arm".padEnd(20)}${"trained".padEnd(9)}${"learning".padEnd(10)}${"recalls".padEnd(9)}${"repeat".padEnd(10)}${"accepted".padEnd(10)}cost/accepted`,
  );
  for (const a of result.arms) {
    if (a.error) {
      L.push(`  ${a.name.padEnd(20)}ERROR: ${a.error}`);
      continue;
    }
    const t = a.totals;
    L.push(
      `  ${a.name.padEnd(20)}${String(a.trained).padEnd(9)}${(a.learningEnabled ? "on" : "off").padEnd(10)}` +
        `${`${t.recalls}/${t.probes}`.padEnd(9)}${`${t.repeated}/${t.repeatable}`.padEnd(10)}` +
        `${`${t.accepted}/${t.probes}`.padEnd(10)}${num(t.costPerAccepted)}`,
    );
  }
  L.push(`  store at probe time: ${result.arms.map((a) => `${a.name}=${a.instinctCount ?? "?"} instinct(s)`).join(", ")}`);
  if (result.embedding) L.push(`  retrieval backend: ${result.embedding}`);

  L.push("");
  L.push("MEASURES");
  for (const m of result.measures) {
    const tag = m.state === STATE.GOOD ? "OK        " : m.state === STATE.REGRESSED ? "REGRESSED " : "NOT MEASURED ";
    L.push(`  [${tag}] ${m.name}`);
    if (m.name === "repeat-error-reduction" && m.state !== STATE.UNMEASURED) {
      L.push(`      control (warm, learning off): ${pct(m.controlRate)} of ${m.repeatable} re-presented failure mode(s) repeated`);
      L.push(`      treatment (warm, learning on): ${pct(m.treatmentRate)}`);
      L.push(`      reduction: ${pct(m.reduction)} (needs >= ${pct(m.threshold)})`);
    }
    if (m.name === "harmful-recall" && m.state !== STATE.UNMEASURED) {
      L.push(`      recalled guidance that did not apply: ${m.harmfulRecalls}/${m.recalls} = ${num(m.rate)} (budget ${m.threshold})`);
      L.push(`      probes the control accepted and learning-on did not: ${m.outcomeRegressions.length ? m.outcomeRegressions.join(", ") : "none"}`);
      L.push(`      probes that only cost more: ${m.costRegressions.length ? m.costRegressions.join(", ") : "none"}`);
      if (m.answerHarm) L.push(`      answers scored worse WITH guidance: ${m.answerHarm.worse}/${m.answerHarm.compared}`);
    }
    if (m.name === "cost-per-accepted" && m.state !== STATE.UNMEASURED) {
      L.push(`      learning on: ${num(m.treatmentCostPerAccepted)} ${m.unit} per accepted result`);
      L.push(`      control:     ${num(m.controlCostPerAccepted)} ${m.unit} per accepted result`);
      if (m.coldCostPerAccepted !== undefined) L.push(`      cold store:  ${num(m.coldCostPerAccepted)} ${m.unit} per accepted result`);
      L.push(`      ratio: ${num(m.ratio)} (budget ${m.threshold})`);
      if (m.providerTokens) {
        L.push(
          `      provider: ${m.providerTokens.tokens} token(s), ${m.providerTokens.accepted} accepted answer(s), ` +
            `${num(m.providerTokens.tokensPerAccepted, 1)} token(s) per accepted answer`,
        );
      }
    }
    L.push(`      ${m.reason}`);
  }

  if (result.ledger) {
    L.push("");
    L.push("LEDGER (src/learning/ledger.ts — reused, not re-implemented)");
    if (result.ledger.state === STATE.UNMEASURED) {
      L.push(`  [NOT MEASURED ] ${result.ledger.reason}`);
    } else {
      // Name what was measured: the retirement runs on a copy of the arm's
      // store, so nothing here says anything about that store's contents now.
      if (result.ledger.measuredOn) L.push(`  measured on ${result.ledger.measuredOn} — the arms' own stores are left untouched`);
      for (const line of result.ledger.lines) L.push(`  ${line}`);
    }
  }

  if (result.requested?.length) {
    L.push("");
    L.push("ARM STATUS (a skipped arm is UNMEASURED, never a pass)");
    for (const r of result.requested) {
      const tag = r.state === STATE.GOOD ? "measured" : r.state === STATE.REGRESSED ? "REGRESSED" : "NOT MEASURED";
      L.push(`  ${r.name.padEnd(18)} ${tag}${r.reason ? ` — ${r.reason}` : ""}`);
    }
  }

  L.push("");
  L.push("-".repeat(74));
  L.push(`VERDICT: ${result.verdict.toUpperCase()}   exit ${result.exitCode}`);
  for (const r of result.reasons) L.push(`  - ${r}`);
  L.push(
    `exit contract: ${EXIT.MEASURED_GOOD}=measured and good  ${EXIT.MEASURED_REGRESSED}=measured and regressed  ` +
      `${EXIT.NOT_MEASURED}=not measured  ${EXIT.USAGE}=bad invocation`,
  );
  return L.join("\n");
}
