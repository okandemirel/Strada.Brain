/**
 * learning-eval-arms.mjs — the A/B arms of the ablation harness (plan 6.3).
 *
 * Every arm gets its OWN throwaway SQLite database, created for this run:
 *
 *   cold              empty store, learning ON  — nothing to recall. It is what
 *                     proves the warm arms' recalls come from this run's
 *                     training and not from a seeded or leftover store.
 *   warm-learning-off trained store, learning OFF (ErrorLearningHooks.disable()
 *                     — production's own switch). THE CONTROL: the knowledge
 *                     exists and is never consulted, so any difference is
 *                     retrieval, not the dataset.
 *   warm-learning-on  trained store, learning ON. The treatment.
 *
 * The probes are HELD OUT: the training phase never sees them (validateDataset
 * refuses a probe that reuses a trained errorMessage), so a warm arm has to
 * generalise, not remember.
 *
 * WHAT IS REAL HERE: LearningStorage, LearningPipeline (error→repair minting,
 * run-scoped credit settled from the run's terminal verdict), PatternMatcher,
 * ErrorLearningHooks.onBeforeErrorAnalysis (the same call and the same
 * minConfidence a real run's error recovery uses), and src/learning/ledger.ts.
 * WHAT IS NOT: the tool execution itself — cost and acceptance come from the
 * dataset's pre-registered oracle (see learning-eval-core.mjs).
 *
 * The learning classes are INJECTED so the harness's own tests can drive these
 * arms against the real src/learning modules without spawning a process.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DECISION, STATE, scoreProbe, summariseArm } from "./learning-eval-core.mjs";

const LEARNING_CONFIG = Object.freeze({
  enabled: true,
  detectionIntervalMs: 60_000,
  evolutionIntervalMs: 60_000,
  minConfidenceForCreation: 0.5,
  batchSize: 10,
});

export const ARM_SPECS = Object.freeze([
  { name: "cold", trained: false, learningEnabled: true },
  { name: "warm-learning-off", trained: true, learningEnabled: false },
  { name: "warm-learning-on", trained: true, learningEnabled: true },
]);

/** A throwaway root for this run's databases. Caller must call cleanup(). */
export function makeWorkDir(prefix = "learning-eval-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function toolEvent({ sessionId, runId, tool, input, success, output, appliedInstinctIds }) {
  return {
    sessionId,
    ...(runId ? { taskRunId: runId } : {}),
    toolName: tool,
    input: input ?? {},
    output,
    success,
    ...(success ? {} : { errorDetails: { category: "build", message: output } }),
    appliedInstinctIds: appliedInstinctIds ?? [],
    timestamp: Date.now(),
  };
}

/**
 * Teach one family the way a real run teaches: a failing call, then a call that
 * repairs the SAME target inside the SAME run (the only pair the pipeline will
 * mint an error_fix from), then the successful runs that give the new rule
 * enough confidence to clear the error-recovery threshold — which a
 * freshly-minted instinct does NOT (0.95 × 0.5 = 0.475 < 0.5).
 */
async function teachFamily({ pipeline, storage, family }) {
  const session = `train:${family.family}`;
  const run = `${family.family}:mint`;
  // Everything the store gains while this family is being taught BELONGS to this
  // family — the error_fix the repair mints, and any workflow pattern the
  // reinforcement runs produce. Attributing only the first one would count a
  // family's own by-product as guidance from nowhere, i.e. as harmful recall.
  const before = new Set(storage.getInstincts({}).map((i) => String(i.id)));

  await pipeline.handleToolResult(
    toolEvent({ sessionId: session, runId: run, tool: family.tool, input: family.target, success: false, output: family.errorMessage }),
  );
  await pipeline.handleToolResult(
    toolEvent({ sessionId: session, runId: run, tool: family.tool, input: family.target, success: true, output: "the repair succeeded" }),
  );
  pipeline.clearRunInstinctCredits(session, { success: true }, run);

  const minted = storage
    .getInstincts({})
    .map((i) => String(i.id))
    .filter((id) => !before.has(id));

  // A freshly minted instinct sits at 0.50, and the error-recovery path asks for
  // 0.5 AFTER weighting (0.95 × 0.50 = 0.475) — so an unreinforced rule is never
  // offered to a run. These are the successful runs that pay for it.
  for (let n = 0; n < (family.repairs ?? 4); n++) {
    const reinforceRun = `${family.family}:reinforce-${n}`;
    await pipeline.handleToolResult(
      toolEvent({
        sessionId: session,
        runId: reinforceRun,
        tool: family.tool,
        input: family.target,
        success: true,
        output: "the repair succeeded",
        appliedInstinctIds: minted,
      }),
    );
    pipeline.clearRunInstinctCredits(session, { success: true, verdictScore: 0.95 }, reinforceRun);
  }

  const allNew = storage
    .getInstincts({})
    .map((i) => String(i.id))
    .filter((id) => !before.has(id));
  return { minted, allNew };
}

/**
 * Ask the real system what guidance a run would be given for this probe, on
 * BOTH paths production uses:
 *
 *   recovery  ErrorLearningHooks.onBeforeErrorAnalysis — the learned-solutions
 *             block injected at the moment of the error (minConfidence 0.5).
 *   proactive InstinctRetriever.getMatchedInstincts — the insight retrieval that
 *             puts learning in front of the model (lexical similarity >= 0.4,
 *             deprecated/quarantined filtered, rival solutions kept apart).
 *
 * The proactive path is queried with the failing output itself, which is the
 * STRONGEST query a run could hand it — deliberately generous to the system, so
 * a "learning did not help" reading cannot be an artefact of a weak query.
 *
 * Read-only on purpose: no scope context is passed, so the matcher's eager merge
 * never runs, nothing here writes, and probe N cannot teach probe N+1. That is
 * what keeps the held-out set held out.
 */
async function recallFor({ hooks, retriever, probe, familyOf }) {
  const { suggestions, recoveryInjection } = hooks.onBeforeErrorAnalysis({
    toolName: probe.tool,
    errorOutput: probe.errorMessage,
    analysis: {
      hasErrors: true,
      errorCount: 1,
      summary: probe.analysisSummary ?? "missing_reference",
      recoveryInjection: "",
    },
    sessionId: `probe:${probe.id}`,
    timestamp: new Date(),
    ...(probe.filePath ? { filePath: probe.filePath } : {}),
  });
  const recalled = suggestions.map((m) => ({
    instinctId: String(m.instinct?.id ?? m.id),
    family: familyOf.get(String(m.instinct?.id ?? m.id)) ?? null,
    matchType: m.type,
    confidence: m.confidence,
    path: "recovery",
  }));

  if (retriever) {
    const seen = new Set(recalled.map((r) => r.instinctId));
    const proactive = await retriever.getMatchedInstincts(probe.taskQuery ?? probe.errorMessage, 3);
    for (const instinct of proactive) {
      const id = String(instinct.id);
      if (seen.has(id)) continue;
      seen.add(id);
      recalled.push({
        instinctId: id,
        family: familyOf.get(id) ?? null,
        matchType: "proactive-insight",
        confidence: instinct.confidence,
        path: "proactive",
      });
    }
  }

  return { injection: recoveryInjection, recalled };
}

/**
 * Run one arm end to end. Returns the arm summary; never throws for a
 * measurement failure — an arm that could not run comes back with `.error` so
 * the verdict reports it as UNMEASURED instead of a pass.
 */
export async function runArm({ spec, dataset, learning, workDir }) {
  const { LearningStorage, LearningPipeline, PatternMatcher, ConfidenceScorer, ErrorLearningHooks, InstinctRetriever } =
    learning;
  const dbPath = join(workDir, `${spec.name}.db`);
  let storage;
  try {
    storage = new LearningStorage(dbPath);
    storage.initialize();
    const pipeline = new LearningPipeline(storage, { ...LEARNING_CONFIG });
    const matcher = new PatternMatcher(storage);
    const hooks = new ErrorLearningHooks(pipeline, matcher, new ConfidenceScorer(), storage);
    // The ablation switch is production's own: learning off means neither the
    // error-recovery injection nor the proactive insight retrieval happens.
    if (spec.learningEnabled) hooks.enable();
    const retriever = spec.learningEnabled && InstinctRetriever ? new InstinctRetriever(matcher, { storage }) : null;

    // ── teach (warm arms only) ──
    const familyOf = new Map();
    const trainedFamilies = new Set();
    if (spec.trained) {
      for (const family of dataset.train) {
        const { minted, allNew } = await teachFamily({ pipeline, storage, family });
        for (const id of allNew) familyOf.set(id, family.family);
        if (minted.length > 0) trainedFamilies.add(family.family);
      }
    }
    const instinctCount = storage.getInstincts({}).length;
    const untaught = dataset.train.filter((f) => spec.trained && !trainedFamilies.has(f.family)).map((f) => f.family);

    // ── decide (read-only, so the held-out set stays held out) ──
    const probes = [];
    const injections = [];
    for (const probe of dataset.heldOut) {
      const { recalled, injection } = await recallFor({ hooks, retriever, probe, familyOf });
      probes.push(scoreProbe(probe, recalled, trainedFamilies));
      injections.push({ id: probe.id, injection });
    }

    // ── settle: the run's terminal verdict reaches the store, keyed by run ──
    for (const scored of probes) {
      const probe = dataset.heldOut.find((p) => p.id === scored.id);
      const session = `eval:${spec.name}`;
      const runId = `${spec.name}:${scored.id}`;
      await pipeline.handleToolResult(
        toolEvent({
          sessionId: session,
          runId,
          tool: probe.tool,
          input: probe.target ?? { file_path: probe.filePath ?? `/eval/${scored.id}` },
          success: scored.accepted,
          output: scored.accepted ? "the probe ended accepted" : probe.errorMessage,
          appliedInstinctIds: scored.recalled.map((r) => r.instinctId),
        }),
      );
      pipeline.clearRunInstinctCredits(session, { success: scored.accepted }, runId);
    }
    storage.flush();

    const arm = summariseArm({
      name: spec.name,
      trained: spec.trained,
      learningEnabled: spec.learningEnabled,
      dbPath,
      instinctCount,
      trainedFamilies: [...trainedFamilies],
      ...(untaught.length > 0 ? { untaughtFamilies: untaught } : {}),
      probes,
      injections,
    });
    return { arm, storage, pipeline, matcher, familyOf };
  } catch (err) {
    try {
      storage?.close();
    } catch {
      /* the arm already failed; a close failure must not mask it */
    }
    return {
      arm: {
        name: spec.name,
        trained: spec.trained,
        learningEnabled: spec.learningEnabled,
        error: err instanceof Error ? `${err.message}` : String(err),
        probes: [],
        totals: {
          probes: 0, recalls: 0, correctRecalls: 0, harmfulRecalls: 0, repeatable: 0, repeated: 0,
          accepted: 0, cost: 0, repeatErrorRate: null, harmfulRecallRate: null, costPerAccepted: null,
        },
      },
    };
  }
}

/**
 * The ledger's own answer to "did the harmful guidance stop having an effect?"
 * — plan 6.4's measure, reused here rather than re-implemented.
 *
 * It asks three things of src/learning/ledger.ts, on the learning-on arm's real
 * store, after the failing runs have settled:
 *   1. can the bad rule be FOUND without knowing its id (findSuspectGuidance)?
 *   2. does the ledger date the evidence against it, or admit it cannot?
 *   3. when the harness retires it, does the effect actually END — status out of
 *      reach, no artifact still carrying it, and zero runs credited afterwards?
 */
export function measureEffectEnds({ arm, storage, ledger, now }) {
  if (!storage || arm?.error) {
    return { name: "harmful-guidance-effect-ends", state: STATE.UNMEASURED, reason: "the learning-on arm did not run" };
  }
  const harmful = new Map();
  for (const p of arm.probes) {
    if (p.decision !== DECISION.HARMFUL) continue;
    for (const r of p.recalled) harmful.set(r.instinctId, p.id);
  }
  if (harmful.size === 0) {
    return {
      name: "harmful-guidance-effect-ends",
      state: STATE.UNMEASURED,
      reason:
        "no held-out probe recalled guidance that did not apply, so there was no wrong rule to retire " +
        "(NOT evidence that retirement works — this run did not test it)",
    };
  }

  const suspects = ledger.findSuspectGuidance(storage, { limit: 20, now });
  const lines = [];
  const rows = [];
  let regressed = false;

  for (const [instinctId, probeId] of harmful) {
    const before = ledger.buildInstinctLedger(storage, instinctId, { now });
    if (!before) {
      lines.push(`${instinctId}: NOT MEASURED — the ledger has no entry for it`);
      regressed = true;
      continue;
    }
    const rank = suspects.findIndex((s) => s.id === instinctId);
    const retired = ledger.retireGuidance(storage, instinctId, {
      reason: `harmful recall on held-out probe ${probeId} (learning-eval 6.3)`,
      actor: "learning-eval",
      now,
    });
    const after = retired.entry;
    const effectEnded = after ? after.effect.inEffect === false && after.effect.runsAfterRetirement === 0 : false;
    if (!effectEnded) regressed = true;

    rows.push({
      instinctId,
      probeId,
      foundBySuspectSearch: rank >= 0,
      suspectRank: rank >= 0 ? rank + 1 : null,
      evidenceFor: before.evidence.for,
      evidenceAgainst: before.evidence.against,
      negativeEvidenceUndated: before.evidence.negativeEvidenceUndated,
      unmeasured: before.evidence.unmeasured,
      inEffectBefore: before.effect.inEffect,
      msWrongAndStillInEffect: before.effect.msWrongAndStillInEffect ?? null,
      retired: retired.ok,
      inEffectAfter: after ? after.effect.inEffect : null,
      runsAfterRetirement: after ? after.effect.runsAfterRetirement : null,
      msFromFirstNegativeToRetirement: after?.effect.msFromFirstNegativeToRetirement ?? null,
      effectEnded,
    });

    lines.push(
      `${before.name} [${instinctId.slice(0, 22)}] applied wrongly on ${probeId}: ` +
        `evidence ${before.evidence.for} for / ${before.evidence.against} against` +
        (before.evidence.negativeEvidenceUndated ? " (against is UNDATED — the measure cannot be computed)" : "") +
        `; found by suspect search: ${rank >= 0 ? `yes, rank ${rank + 1}` : "NO"}`,
    );
    lines.push(
      `  retire → ${retired.detail}; in effect afterwards: ${after ? after.effect.inEffect : "unknown"}` +
        `; runs credited after retirement: ${after ? after.effect.runsAfterRetirement : "unknown"}` +
        `; first-negative→retirement: ${after?.effect.msFromFirstNegativeToRetirement ?? "not datable"} ms` +
        ` — ${effectEnded ? "the effect ENDED" : "the effect DID NOT end"}`,
    );
    if (after && after.effect.inEffect) lines.push(`  why it is STILL in effect: ${after.effect.why}`);
  }

  return {
    name: "harmful-guidance-effect-ends",
    state: regressed ? STATE.REGRESSED : STATE.GOOD,
    reason: regressed
      ? "retiring guidance that recalled wrongly did not take it out of effect"
      : `every wrongly-recalled rule was findable and went out of effect on retirement (${rows.length} rule(s))`,
    rows,
    lines,
  };
}
