/**
 * THE AUDITABLE LEARNING LEDGER (plan 6.4).
 *
 * Wave 3 made the learning system's judgements defensible one at a time: an
 * instinct carries its owner, credit settles from a run's terminal verdict, a
 * rival solution is not a duplicate, a superseded rule is soft-retired, and a
 * permanently-wrong one can be quarantined. What no surface could answer was
 * the question a person actually asks about a piece of guidance:
 *
 *   Where did this come from? What evidence is there FOR it and AGAINST it?
 *   Which runs did it influence, and how did those end? When did its status
 *   change, and why? Is it still having an effect — and how do I stop it?
 *
 * The plan's measure for this item is HOW LONG IT TAKES FOR WRONG GUIDANCE TO
 * STOP HAVING AN EFFECT, so the ledger is built for exactly that:
 *
 *   findSuspectGuidance() makes a bad rule FINDABLE without knowing its id —
 *     ranked by the runs it influenced that failed, never by confidence alone;
 *   retireGuidance() makes it RETIRABLE in one action — status, every runtime
 *     artifact generated from it, and a lifecycle row naming actor and reason;
 *   buildInstinctLedger() makes the retirement VISIBLE afterwards — when it
 *     stopped, how long that took from the first negative evidence, and
 *     whether anything is still carrying it.
 *
 * Two honesty rules run through all of it:
 *   1. NO EVIDENCE IS NOT GOOD EVIDENCE. A rule nobody has measured is
 *      reported as unmeasured, never as clean.
 *   2. A RETIREMENT IS NOT AN EFFECT ENDING BY ITSELF. Deprecated status plus
 *      a still-active generated artifact means the guidance is still in
 *      effect, and the ledger says so.
 */

import type { LearningStorage, InstinctCreditRecord } from "./storage/learning-storage.js";
import type { Instinct, InstinctId, InstinctStatus } from "./types.js";

/** The statuses a run can still be shown — see InstinctRetriever.filterDedupAndBoost
 *  (deprecated/quarantined are filtered) and getInstinctsForScope's default. */
const RETRIEVABLE: readonly InstinctStatus[] = ["active", "proposed", "permanent"];

/** Feedback types that count AGAINST a piece of guidance. */
const NEGATIVE_FEEDBACK = new Set(["thumbs_down", "correction"]);

export interface LedgerOrigin {
  createdAt: number;
  /** The session the rule was learned in, when it was recorded. */
  originSessionId?: string;
  /** The trajectories it was generalised from. */
  sourceTrajectoryIds: readonly string[];
  /** Who owns a user-scoped rule (item 3.1) — undefined for project/global. */
  owner?: string;
  scopeType?: string;
  /** True when it was seeded at startup rather than learned. */
  seeded: boolean;
  scopes: ReadonlyArray<{ projectPath: string; scopeType: string | null; userId: string | null; createdAt: number }>;
}

export interface LedgerEvidence {
  /** Runs/outcomes that went its way, and against it. */
  for: number;
  against: number;
  confidence: number;
  bayesianAlpha: number;
  bayesianBeta: number;
  feedback: { thumbsUp: number; thumbsDown: number; teaching: number; correction: number };
  /** Earliest dated evidence against it (a failed run it influenced, or negative feedback). */
  firstNegativeAt?: number;
  lastNegativeAt?: number;
  /**
   * True when negative evidence is counted but NOTHING is dated — counters
   * from before the credit ledger existed. The measure cannot be computed and
   * says so rather than reporting zero.
   */
  negativeEvidenceUndated: boolean;
  /** True when nothing has been measured either way. NOT the same as "clean". */
  unmeasured: boolean;
}

export interface LedgerTransition {
  fromStatus: string;
  toStatus: string;
  reason: string;
  confidenceAtTransition: number;
  at: number;
}

export interface LedgerEffect {
  /** Can a run still be shown this guidance right now? */
  inEffect: boolean;
  /** Why it is (or is no longer) in effect, in one sentence. */
  why: string;
  retiredAt?: number;
  retiredReason?: string;
  /** Generated artifacts still carrying the guidance after the rule was retired. */
  liveArtifacts: ReadonlyArray<{ id: string; name: string; state: string }>;
  /**
   * First dated evidence against it → the STATUS change. Only that: while a
   * generated artifact still carries the guidance the effect has not ended, and
   * this number must not be read as "time until it stopped" (round 11 #8).
   * {@link msFromFirstNegativeToNoEffect} is that measure.
   */
  msFromFirstNegativeToRetirement?: number;
  /**
   * THE PLAN'S MEASURE (round 11 #8): first dated evidence against it → the
   * moment EVERY carrier stopped. Absent while any carrier is still live, and
   * {@link noEffectPendingReason} says which one.
   */
  msFromFirstNegativeToNoEffect?: number;
  /** When the last carrier of the guidance stopped. Absent while one is live. */
  noEffectAt?: number;
  /** Why the time-to-no-effect measure could not be completed, when it could not. */
  noEffectPendingReason?: string;
  /** Still in effect with evidence against it: how long it has been wrong so far. */
  msWrongAndStillInEffect?: number;
  /**
   * Runs SHOWN the guidance after the retirement. Anything above 0 is a leak.
   *
   * Round 11 #8: this counted credit rows by SETTLEMENT time, and settlement
   * rides a serial queue behind the run's own events (round 10 #14) — so the
   * ordinary case of retiring a rule while a run that already saw it finishes
   * was reported as "something is still applying it", indistinguishable from the
   * real leak this measure exists to catch.
   */
  runsAfterRetirement: number;
  /** Exposed BEFORE the retirement, credit settled after. Not a leak — a queue hop. */
  runsSettledAfterRetirementExposedBefore: number;
  /** Settled after the retirement with no recorded exposure time: unplaceable, not clean. */
  runsAfterRetirementExposureUnknown: number;
}

export interface InstinctLedgerEntry {
  id: string;
  name: string;
  type: string;
  status: string;
  trigger: string;
  action: string;
  origin: LedgerOrigin;
  evidence: LedgerEvidence;
  /** The runs this guidance influenced, newest first (bounded). */
  runs: readonly InstinctCreditRecord[];
  /** Every status change, oldest first. */
  timeline: readonly LedgerTransition[];
  effect: LedgerEffect;
}

/** Is this status one a run can still be shown? */
export function isRetrievableStatus(status: string): boolean {
  return (RETRIEVABLE as readonly string[]).includes(status);
}

/**
 * The whole record for one piece of guidance.
 *
 * `now` is injectable so the "how long has it been wrong" measure is testable.
 */
export function buildInstinctLedger(
  storage: LearningStorage,
  instinctId: string,
  opts?: { runLimit?: number; now?: number },
): InstinctLedgerEntry | undefined {
  const instinct = storage.getInstinct(instinctId as InstinctId);
  if (!instinct) return undefined;
  const now = opts?.now ?? Date.now();
  const runLimit = opts?.runLimit ?? 50;

  const credits = storage.getInstinctCredits({ instinctId, limit: runLimit });
  const allFailures = storage.getInstinctCredits({ instinctId }).filter((c) => !c.success);
  const feedback = storage.getFeedbackByInstinct(instinctId);
  const logs = storage
    .getLifecycleLogs({ instinctId: instinctId as InstinctId })
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  const feedbackCounts = { thumbsUp: 0, thumbsDown: 0, teaching: 0, correction: 0 };
  for (const row of feedback) {
    if (row.type === "thumbs_up") feedbackCounts.thumbsUp++;
    else if (row.type === "thumbs_down") feedbackCounts.thumbsDown++;
    else if (row.type === "teaching") feedbackCounts.teaching++;
    else if (row.type === "correction") feedbackCounts.correction++;
  }

  const negativeDates = [
    ...allFailures.map((c) => c.timestamp),
    ...feedback.filter((f) => NEGATIVE_FEEDBACK.has(f.type)).map((f) => f.createdAt),
  ].sort((a, b) => a - b);

  const against = instinct.stats?.timesFailed ?? 0;
  const forCount = instinct.stats?.timesApplied ?? 0;
  const countedAgainst = Math.max(against, allFailures.length, feedbackCounts.thumbsDown + feedbackCounts.correction);
  const evidence: LedgerEvidence = {
    for: forCount,
    against: countedAgainst,
    confidence: instinct.confidence,
    bayesianAlpha: instinct.bayesianAlpha ?? 1,
    bayesianBeta: instinct.bayesianBeta ?? 1,
    feedback: feedbackCounts,
    ...(negativeDates.length > 0 ? { firstNegativeAt: negativeDates[0]!, lastNegativeAt: negativeDates[negativeDates.length - 1]! } : {}),
    // Counted but not dated: the counters predate the credit ledger.
    negativeEvidenceUndated: countedAgainst > 0 && negativeDates.length === 0,
    // NOT "clean": nothing has been measured either way.
    unmeasured: forCount === 0 && countedAgainst === 0 && credits.length === 0,
  };

  const artifacts = storage
    .getRuntimeArtifactsBySourceInstinct(instinctId)
    .filter((a) => a.state === "active" || a.state === "shadow")
    .map((a) => ({ id: String(a.id), name: a.name, state: a.state }));

  const retirement = [...logs].reverse().find((l) => l.toStatus === "deprecated" || l.toStatus === "quarantined");
  const retiredAt = isRetrievableStatus(instinct.status) ? undefined : retirement?.timestamp ?? instinct.updatedAt;
  // A run SHOWN the guidance after the rule was retired means something is still
  // applying it — the leak this measure exists to catch. A run shown it BEFORE,
  // whose credit merely settled afterwards, is a queue hop and is reported
  // separately (round 11 #8); a row with no recorded exposure time cannot be
  // placed on either side and is reported as unknown.
  const across = retiredAt === undefined
    ? { exposedAfter: 0, settledAfterExposedBefore: 0, exposureUnknown: 0 }
    : storage.countInstinctCreditsAcross(instinctId, retiredAt);

  const statusRetrievable = isRetrievableStatus(instinct.status);
  const inEffect = statusRetrievable || artifacts.length > 0;
  const why = statusRetrievable
    ? `status '${instinct.status}' is still offered to runs`
    : artifacts.length > 0
    ? `the rule is '${instinct.status}', but ${artifacts.length} generated artifact(s) still carry its guidance: ${artifacts
        .map((a) => `${a.name} (${a.state})`)
        .join(", ")}`
    : `status '${instinct.status}' is never offered to a run`;

  // ROUND 11 #8 — WHEN DID EVERY CARRIER STOP?
  //
  // The retirement duration measured the STATUS change alone, which reads as
  // "it stopped" while a generated artifact is still active — the ledger's own
  // second honesty rule. So the measure runs to the LAST carrier: the status
  // change and every artifact derived from the rule. It is reported only when
  // none is live, and says which one is holding it open otherwise.
  const noEffect = measureNoEffect(storage, instinctId, instinct.status, retiredAt, artifacts);

  const effect: LedgerEffect = {
    inEffect,
    why,
    ...(retiredAt === undefined ? {} : { retiredAt }),
    ...(retirement?.reason ? { retiredReason: retirement.reason } : {}),
    liveArtifacts: artifacts,
    ...(retiredAt !== undefined && evidence.firstNegativeAt !== undefined && retiredAt >= evidence.firstNegativeAt
      ? { msFromFirstNegativeToRetirement: retiredAt - evidence.firstNegativeAt }
      : {}),
    ...(noEffect.at === undefined ? {} : { noEffectAt: noEffect.at }),
    ...(noEffect.pendingReason === undefined ? {} : { noEffectPendingReason: noEffect.pendingReason }),
    ...(noEffect.at !== undefined && evidence.firstNegativeAt !== undefined && noEffect.at >= evidence.firstNegativeAt
      ? { msFromFirstNegativeToNoEffect: noEffect.at - evidence.firstNegativeAt }
      : {}),
    ...(inEffect && evidence.firstNegativeAt !== undefined
      ? { msWrongAndStillInEffect: Math.max(0, now - evidence.firstNegativeAt) }
      : {}),
    runsAfterRetirement: across.exposedAfter,
    runsSettledAfterRetirementExposedBefore: across.settledAfterExposedBefore,
    runsAfterRetirementExposureUnknown: across.exposureUnknown,
  };

  return {
    id: String(instinct.id),
    name: instinct.name,
    type: instinct.type,
    status: instinct.status,
    trigger: instinct.triggerPattern,
    action: instinct.action,
    origin: {
      createdAt: instinct.createdAt,
      ...(instinct.originSessionId ? { originSessionId: instinct.originSessionId } : {}),
      sourceTrajectoryIds: instinct.sourceTrajectoryIds ?? [],
      ...(instinct.userId ? { owner: instinct.userId } : {}),
      ...(instinct.scopeType ? { scopeType: instinct.scopeType } : {}),
      seeded: instinct.seed === true,
      scopes: storage.getInstinctScopes(instinctId),
    },
    evidence,
    runs: credits,
    timeline: logs.map((l) => ({
      fromStatus: l.fromStatus,
      toStatus: l.toStatus,
      reason: l.reason,
      confidenceAtTransition: l.confidenceAtTransition,
      at: l.timestamp,
    })),
    effect,
  };
}

/**
 * WHEN DID THE GUIDANCE STOP HAVING AN EFFECT — across every carrier of it
 * (round 11 #8)?
 *
 * A carrier is anything a run can still be shown the guidance through: the rule
 * itself (its status) and every runtime artifact generated from it. The answer
 * is the moment the LAST of them stopped, and it exists only when none is live.
 * While one is, this returns the reason instead of a number: a duration here
 * would be read as "it stopped", which is exactly the false reassurance the
 * ledger exists to refuse.
 */
function measureNoEffect(
  storage: LearningStorage,
  instinctId: string,
  status: string,
  retiredAt: number | undefined,
  liveArtifacts: ReadonlyArray<{ id: string; name: string; state: string }>,
): { at?: number; pendingReason?: string } {
  if (isRetrievableStatus(status)) {
    return { pendingReason: `the rule's status '${status}' is still offered to runs` };
  }
  if (liveArtifacts.length > 0) {
    return {
      pendingReason: `${liveArtifacts.length} generated artifact(s) still carry the guidance: ${liveArtifacts
        .map((a) => `${a.name} (${a.state})`)
        .join(", ")}`,
    };
  }
  if (retiredAt === undefined) {
    return { pendingReason: "the moment the rule stopped being offered is not recorded" };
  }
  // Every artifact is retired/rejected by now; the effect ended with whichever
  // carrier stopped LAST — a skill that outlived the rule's status change is the
  // case that made the status-only duration misleading.
  let last = retiredAt;
  for (const artifact of storage.getRuntimeArtifactsBySourceInstinct(instinctId)) {
    const stopped = artifact.retiredAt ?? artifact.rejectedAt ?? artifact.updatedAt;
    if (typeof stopped === "number" && stopped > last) last = stopped;
  }
  return { at: last };
}

export interface SuspectGuidance {
  id: string;
  name: string;
  status: string;
  confidence: number;
  /** Runs it influenced that failed (from the credit ledger), and how many in all. */
  failedRuns: number;
  totalRuns: number;
  /**
   * Runs that were SHOWN it and did not use it — a cost-only misfire, which
   * costs an attempt and says the TRIGGER is too wide, not that the action is
   * broken. Counted apart from failedRuns for exactly that reason.
   */
  shownNotApplied: number;
  negativeFeedback: number;
  lastFailureAt?: number;
  /** How long it has been carrying dated evidence against it while still in effect. */
  msWrongAndStillInEffect?: number;
  /** Why it is on this list, in one sentence. */
  why: string;
  /** Ranking score — higher is more suspect. Never used as a verdict. */
  score: number;
}

/**
 * The guidance most likely to be wrong AND still in effect.
 *
 * Ranked by the runs it influenced that FAILED, not by confidence: a rule that
 * keeps failing while its confidence stays high is exactly the case a person
 * cannot find today. Guidance with no measurements is not on this list — and
 * is not called clean either; buildInstinctLedger reports it as unmeasured.
 */
export function findSuspectGuidance(
  storage: LearningStorage,
  opts?: { limit?: number; now?: number; includeRetired?: boolean },
): SuspectGuidance[] {
  const now = opts?.now ?? Date.now();
  const limit = opts?.limit ?? 10;
  const instincts: Instinct[] = storage.getInstincts({});
  const rows: SuspectGuidance[] = [];

  for (const instinct of instincts) {
    const id = String(instinct.id);
    const retrievable = isRetrievableStatus(instinct.status);
    const artifacts = storage
      .getRuntimeArtifactsBySourceInstinct(id)
      .filter((a) => a.state === "active" || a.state === "shadow");
    const inEffect = retrievable || artifacts.length > 0;
    if (!inEffect && opts?.includeRetired !== true) continue;

    const credits = storage.getInstinctCredits({ instinctId: id });
    // A FAILED APPLICATION AND A MISFIRE ARE DIFFERENT FACTS. Both are stored
    // with success=0: the first tried the rule's action and it did not work,
    // the second only showed the rule to a run that repaired itself some other
    // way. Counting them together would report a cost-only misfire as a broken
    // action; ignoring the misfires is what made them invisible here at all.
    const failed = credits.filter((c) => !c.success && c.applied);
    const misfired = credits.filter((c) => !c.applied);
    const feedback = storage.getFeedbackByInstinct(id);
    const negativeFeedback = feedback.filter((f) => NEGATIVE_FEEDBACK.has(f.type)).length;
    const countedFailures = instinct.stats?.timesFailed ?? 0;
    if (failed.length === 0 && misfired.length === 0 && negativeFeedback === 0 && countedFailures === 0) continue;

    const lastFailureAt = failed[0]?.timestamp ?? undefined;
    const firstNegative = [
      ...failed.map((c) => c.timestamp),
      // A misfire IS dated evidence against the rule. Without it the clock on
      // 'wrong and still in effect' never started for guidance whose only harm
      // was wasted attempts.
      ...misfired.map((c) => c.exposedAt ?? c.timestamp),
      ...feedback.filter((f) => NEGATIVE_FEEDBACK.has(f.type)).map((f) => f.createdAt),
    ].sort((a, b) => a - b)[0];
    // The ledger row, not a verdict: failed runs weigh most, then negative
    // feedback, then undated counters — and a high confidence with failures
    // behind it is MORE suspect, not less, so confidence adds rather than
    // subtracts here.
    const score = failed.length * 10 + negativeFeedback * 5 + misfired.length * 3 + countedFailures + instinct.confidence;
    const parts: string[] = [];
    if (failed.length > 0) parts.push(`${failed.length} of the ${credits.length} run(s) it influenced failed`);
    if (negativeFeedback > 0) parts.push(`${negativeFeedback} negative correction(s)/thumbs-down`);
    if (misfired.length > 0) {
      parts.push(`shown to ${misfired.length} run(s) that did not use it (wasted attempts, action never tried)`);
    }
    if (failed.length === 0 && countedFailures > 0) {
      parts.push(`${countedFailures} failure(s) counted before the credit ledger existed (undated)`);
    }
    if (!retrievable && artifacts.length > 0) {
      parts.push(`retired, but ${artifacts.length} generated artifact(s) still carry it`);
    }
    rows.push({
      id,
      name: instinct.name,
      status: instinct.status,
      confidence: instinct.confidence,
      failedRuns: failed.length,
      totalRuns: credits.length,
      shownNotApplied: misfired.length,
      negativeFeedback,
      ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
      ...(firstNegative === undefined ? {} : { msWrongAndStillInEffect: Math.max(0, now - firstNegative) }),
      why: parts.join("; "),
      score,
    });
  }

  return rows.sort((a, b) => b.score - a.score || b.failedRuns - a.failedRuns).slice(0, limit);
}

/** Find guidance by a substring of its name, trigger or action. */
export function searchGuidance(
  storage: LearningStorage,
  query: string,
  opts?: { limit?: number },
): Array<{ id: string; name: string; status: string; confidence: number; trigger: string; action: string }> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return storage
    .getInstincts({})
    .filter(
      (i) =>
        i.name.toLowerCase().includes(needle) ||
        i.triggerPattern.toLowerCase().includes(needle) ||
        i.action.toLowerCase().includes(needle),
    )
    .slice(0, opts?.limit ?? 20)
    .map((i) => ({
      id: String(i.id),
      name: i.name,
      status: i.status,
      confidence: i.confidence,
      trigger: i.triggerPattern,
      action: i.action,
    }));
}

export interface RetireGuidanceResult {
  ok: boolean;
  detail: string;
  /** The ledger AFTER the action — the retirement, visible. */
  entry?: InstinctLedgerEntry;
}

/**
 * Retire a piece of guidance and show what that did.
 *
 * The retirement is only believable if the ledger afterwards says the rule is
 * out of effect, so the entry is rebuilt and returned. If anything still
 * carries the guidance, `entry.effect.inEffect` stays true and says what.
 */
export function retireGuidance(
  storage: LearningStorage,
  instinctId: string,
  opts: { reason: string; actor: string; quarantine?: boolean; now?: number },
): RetireGuidanceResult {
  const result = storage.retireInstinct(instinctId, opts);
  const entry = buildInstinctLedger(storage, instinctId, { now: opts.now });
  return { ok: result.ok, detail: result.detail, ...(entry ? { entry } : {}) };
}

// ─── Rendering (CLI / report) ────────────────────────────────────────────────

function when(ms: number | undefined): string {
  return ms === undefined ? "unknown" : new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const minutes = ms / 60_000;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/** The whole ledger for one rule, as text. Every section is present or says why not. */
export function renderLedgerEntry(entry: InstinctLedgerEntry): string {
  const lines: string[] = [];
  lines.push(`${entry.name}  [${entry.id}]`);
  lines.push(`  type: ${entry.type}   status: ${entry.status}   confidence: ${entry.evidence.confidence.toFixed(3)}`);
  lines.push(`  when: ${entry.trigger}`);
  lines.push(`  then: ${entry.action}`);

  lines.push("", "WHERE IT CAME FROM");
  lines.push(`  created ${when(entry.origin.createdAt)}${entry.origin.seeded ? " (seeded at startup, not learned)" : ""}`);
  lines.push(`  learned in session: ${entry.origin.originSessionId ?? "not recorded"}`);
  lines.push(
    `  from trajectories: ${entry.origin.sourceTrajectoryIds.length > 0 ? entry.origin.sourceTrajectoryIds.join(", ") : "none recorded"}`,
  );
  lines.push(`  owner: ${entry.origin.owner ?? "nobody (not user-scoped)"}   scope: ${entry.origin.scopeType ?? "unrecorded"}`);
  lines.push(
    `  scopes: ${
      entry.origin.scopes.length === 0
        ? "none"
        : entry.origin.scopes.map((s) => `${s.projectPath}${s.scopeType ? ` (${s.scopeType})` : ""}`).join(", ")
    }`,
  );

  lines.push("", "EVIDENCE");
  if (entry.evidence.unmeasured) {
    lines.push("  NOT MEASURED — no run outcome and no feedback has ever been recorded for this rule.");
    lines.push("  (That is not the same as clean: nothing has tested it.)");
  } else {
    lines.push(
      `  for: ${entry.evidence.for}   against: ${entry.evidence.against}   ` +
        `alpha/beta: ${entry.evidence.bayesianAlpha.toFixed(1)}/${entry.evidence.bayesianBeta.toFixed(1)}`,
    );
    lines.push(
      `  feedback: ${entry.evidence.feedback.thumbsUp}👍 ${entry.evidence.feedback.thumbsDown}👎 ` +
        `${entry.evidence.feedback.teaching} teaching, ${entry.evidence.feedback.correction} correction(s)`,
    );
    if (entry.evidence.firstNegativeAt !== undefined) {
      lines.push(`  first evidence against it: ${when(entry.evidence.firstNegativeAt)}; latest: ${when(entry.evidence.lastNegativeAt)}`);
    } else if (entry.evidence.negativeEvidenceUndated) {
      lines.push("  evidence against it is COUNTED BUT UNDATED (it predates the credit ledger) — the time-to-stop measure cannot be computed.");
    }
  }

  lines.push("", `RUNS IT INFLUENCED (${entry.runs.length} recorded)`);
  if (entry.runs.length === 0) {
    lines.push("  none recorded — no run has settled credit for this rule since the ledger existed.");
  } else {
    for (const run of entry.runs.slice(0, 10)) {
      lines.push(
        `  ${when(run.timestamp)}  ${run.success ? "ok    " : "FAILED"}  session ${run.sessionId}  ` +
          `verdict ${run.verdictScore.toFixed(2)} (${run.source})  confidence ${run.confidenceBefore.toFixed(3)} → ${run.confidenceAfter.toFixed(3)}`,
      );
    }
    if (entry.runs.length > 10) lines.push(`  … ${entry.runs.length - 10} more`);
  }

  lines.push("", "STATUS CHANGES");
  if (entry.timeline.length === 0) {
    lines.push("  none recorded — it has held the same status since it was created.");
  } else {
    for (const t of entry.timeline) {
      lines.push(`  ${when(t.at)}  ${t.fromStatus} → ${t.toStatus}  (confidence ${t.confidenceAtTransition.toFixed(3)})`);
      lines.push(`      ${t.reason}`);
    }
  }

  lines.push("", "IS IT STILL HAVING AN EFFECT?");
  lines.push(`  ${entry.effect.inEffect ? "YES" : "NO"} — ${entry.effect.why}`);
  if (entry.effect.retiredAt !== undefined) {
    lines.push(`  retired ${when(entry.effect.retiredAt)}${entry.effect.retiredReason ? `: ${entry.effect.retiredReason}` : ""}`);
  }
  if (entry.effect.msFromFirstNegativeToRetirement !== undefined) {
    lines.push(
      `  time from the first evidence against it to the retirement: ${formatDurationMs(entry.effect.msFromFirstNegativeToRetirement)}`,
    );
  }
  if (entry.effect.msFromFirstNegativeToNoEffect !== undefined) {
    lines.push(
      `  time from the first evidence against it to no effect (every carrier stopped): ` +
        `${formatDurationMs(entry.effect.msFromFirstNegativeToNoEffect)}`,
    );
  } else if (entry.effect.noEffectPendingReason !== undefined) {
    lines.push(`  it has NOT stopped having an effect: ${entry.effect.noEffectPendingReason}`);
  }
  if (entry.effect.msWrongAndStillInEffect !== undefined) {
    lines.push(
      `  ⚠️ it has carried evidence against it for ${formatDurationMs(entry.effect.msWrongAndStillInEffect)} and is STILL in effect`,
    );
  }
  if (entry.effect.runsAfterRetirement > 0) {
    lines.push(
      `  ⚠️ ${entry.effect.runsAfterRetirement} run(s) were SHOWN it after it was retired — something is still applying it.`,
    );
  }
  if (entry.effect.runsSettledAfterRetirementExposedBefore > 0) {
    lines.push(
      `  ${entry.effect.runsSettledAfterRetirementExposedBefore} run(s) settled after the retirement but were shown it before ` +
        `— that is the settlement queue, not continued use.`,
    );
  }
  if (entry.effect.runsAfterRetirementExposureUnknown > 0) {
    lines.push(
      `  ${entry.effect.runsAfterRetirementExposureUnknown} run(s) settled after the retirement whose exposure time was never ` +
        `recorded — they cannot be placed on either side.`,
    );
  }
  return lines.join("\n");
}

/** The suspect list, as text. */
export function renderSuspects(rows: readonly SuspectGuidance[]): string {
  if (rows.length === 0) {
    return "No guidance currently in effect carries evidence against it.\n(Guidance nobody has measured is not listed — that is unmeasured, not clean.)";
  }
  const lines = [`${rows.length} piece(s) of guidance in effect with evidence against them, most suspect first:`, ""];
  for (const row of rows) {
    lines.push(`${row.id}  ${row.name}  [${row.status}, confidence ${row.confidence.toFixed(3)}]`);
    lines.push(`  ${row.why}`);
    if (row.msWrongAndStillInEffect !== undefined) {
      lines.push(`  in effect with evidence against it for ${formatDurationMs(row.msWrongAndStillInEffect)}`);
    }
    lines.push(`  retire it with:  strada learning retire ${row.id} --reason "<why>"`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
