/**
 * Learning Pipeline - Core learning engine for pattern detection and instinct creation
 * 
 * Processes observations, creates instincts, and manages evolution of learned patterns.
 */

import { randomUUID } from "node:crypto";
import { sanitizePromptInjection } from "../../agents/orchestrator-text-utils.js";
import { LearningStorage } from "../storage/learning-storage.js";
import { ConfidenceScorer, EVIDENCE_WEIGHTS, getVerdictScore } from "../scoring/confidence-scorer.js";
import { getLoggerSafe } from "../../utils/logger.js";
import { PatternMatcher, embedderFromProvider, combinedSimilarity } from "../matching/pattern-matcher.js";
import { RuntimeArtifactManager } from "../runtime-artifact-manager.js";
import type { ToolResultEvent, FeedbackReactionEvent, IEventBus, LearningEventMap } from "../../core/event-bus.js";
import { FeedbackHandler } from "../feedback/feedback-handler.js";
import { capLearnedText } from "../feedback/learned-text.js";
import { EmbeddingQueue } from "./embedding-queue.js";
import type { IEmbeddingProvider } from "../../rag/rag.interface.js";
import {
  DEFAULT_LEARNING_CONFIG,
  type Instinct,
  type InstinctId,
  type Trajectory,
  type TrajectoryId,
  type TrajectoryStep,
  type TrajectoryOutcome,
  type Observation,
  type ObservationId,
  type ErrorPattern,
  type ErrorPatternId,
  type Verdict,
  type VerdictId,
  type VerdictDimensions,
  type EvolutionProposal,
  type LearningConfig,
  type ErrorDetails,
  type InstinctType,
  type ContextCondition,
  type ContextConditionId,
  type RuntimeArtifact,
  type BayesianConfig,
  type InstinctLifecycleEvent,
  type ScopeType,
  type CorrectionRecord,
  type PatternMatch,
  CONFIDENCE_THRESHOLDS,
  createInstinctId,
} from "../types.js";
import { createBrand, type ToolName, type TimestampMs, type JsonObject } from "../../types/index.js";
import { seedAllFrameworkConventions } from "../seeds/framework-seeds.js";

/**
 * What a tool call acted on. A repair has to act on the same thing as the
 * failure it claims to repair (D39 / audit 04.2a), so the pair is compared on
 * this and not on the tool name alone.
 */
export type RepairTarget = { kind: "path"; value: string } | { kind: "command"; value: string };

/** Input keys that NAME the resource a tool acted on. */
const TARGET_INPUT_KEYS = [
  "path", "file_path", "filePath", "file", "filename", "fileName", "target_file", "notebook_path",
] as const;

/**
 * Read the target out of a tool input: the named resource when there is one,
 * else the command line. Deliberately NOT a guess — a tool input that names
 * neither yields null, and a null target can never be repaired (see
 * {@link isRepairOf}), because "the same tool succeeded later" is not evidence
 * that anything was fixed.
 *
 * Content-bearing keys (content, text, body, …) are never read: a file body is
 * not a target and must never become the action text of an instinct.
 */
export function repairTarget(input: unknown): RepairTarget | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of TARGET_INPUT_KEYS) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) {
      return { kind: "path", value: raw.trim().replace(/\\/g, "/").replace(/^\.\//, "") };
    }
  }
  const command = record["command"];
  if (typeof command === "string" && command.trim()) {
    return { kind: "command", value: command.trim() };
  }
  return null;
}

/**
 * program + sub-command of the LAST segment of a (possibly compound) command
 * line: the repair's recheck is what it ends with, so
 * "dotnet restore && dotnet build" re-runs "dotnet build".
 */
function commandOperation(command: string): string {
  const lastSegment = command.split(/&&|\|\||;|\|/).pop() ?? command;
  return lastSegment
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0 && !/^\w+=/.test(token))
    .slice(0, 2)
    .join(" ")
    .toLowerCase();
}

/**
 * Whether `success` repairs `failure`: the same named resource, or a command
 * that explicitly re-runs the failed operation. Anything else — an unrelated
 * command, a read of another file, a pair naming no target at all — is NOT a
 * repair, however close in time and however identical the tool name.
 */
export function isRepairOf(failure: RepairTarget | null, success: RepairTarget | null): boolean {
  if (!failure || !success || failure.kind !== success.kind) return false;
  if (failure.kind === "path") return failure.value === success.value;
  const failedOperation = commandOperation(failure.value);
  return failedOperation.length > 0 && failedOperation === commandOperation(success.value);
}

const VERDICT_SCORE = {
  HIGH: 0.7,
  PERFECT: 1.0,
};

/** Default confidence system config used when none is provided */
const DEFAULT_BAYESIAN_CONFIG: BayesianConfig = {
  enabled: true,
  deprecatedThreshold: 0.3,
  activeThreshold: 0.7,
  evolutionThreshold: 0.9,
  autoEvolveThreshold: 0.95,
  maxInitial: 0.5,
  coolingPeriodDays: 7,
  coolingMinObservations: 10,
  coolingMaxFailures: 3,
  promotionMinObservations: 25,
  verdictCleanSuccess: 0.9,
  verdictRetrySuccess: 0.6,
  verdictFailure: 0.2,
};

// ─── LearningPipeline Class ──────────────────────────────────────────────────

export class LearningPipeline {
  private storage: LearningStorage;
  private confidenceScorer: ConfidenceScorer;
  private patternMatcher: PatternMatcher;
  private readonly runtimeArtifacts: RuntimeArtifactManager;
  private config: LearningConfig;
  private bayesianConfig: BayesianConfig;
  private eventBus: IEventBus<LearningEventMap> | null = null;
  private readonly feedbackHandler: FeedbackHandler;
  private embeddingQueue: EmbeddingQueue | null = null;
  private evolutionTimer: ReturnType<typeof setInterval> | null = null;
  private feedbackReactionListener: ((event: FeedbackReactionEvent) => void) | null = null;
  /** r13 #22: the synchronous credit note, unsubscribed with the pipeline. */
  private toolResultCreditListener: ((event: ToolResultEvent) => void) | null = null;
  private periodicTimer?: ReturnType<typeof setInterval>;
  private isRunning = false;

  private static readonly RESOLUTION_LINK_WINDOW_MS = 5 * 60 * 1000;
  private static readonly STALE_RESOLUTION_THRESHOLD_MS = 10 * 60 * 1000;

  private recentObservations: Array<{
    toolName: string; errorPattern?: string; timestamp: number;
  }> = [];

  /** Tracks pending error resolutions: `${sessionId}:${toolName}` → error observation data */
  private pendingResolutions = new Map<string, {
    errorObservation: Observation;
    toolName: string;
    errorOutput: string;
    timestamp: number;
    /** What the FAILING call acted on; only a success on the same thing repairs it (D39). */
    target: RepairTarget | null;
  }>();

  /**
   * LIVING VAULT (C) — optional injected note-writer for the learning↔vault
   * bridge. When set (bootstrap wires it after the dev-knowledge vault is
   * registered), high-confidence instinct creations and clean-success verdicts
   * are mirrored as human-readable notes into the dev-knowledge vault. The
   * dependency is INTERFACE-ONLY (defined in src/vault/), so there is no
   * runtime src/learning -> src/vault import — no import cycle. Unset (default,
   * and in all unit tests that don't wire it) ⇒ every bridge call is a
   * null-guarded no-op ⇒ byte-identical to prior behavior.
   */
  private noteWriter?: import("../../vault/dev-knowledge-writer.js").DevKnowledgeNoteWriter;
  /** Per-id dedup set so the same instinct/verdict is not re-noted within a process. */
  private readonly notedIds = new Set<string>();

  /** Project path for scope-aware instinct creation (Phase 13) */
  private projectPath?: string;
  /** Scope promotion threshold (Phase 13): distinct projects needed for universal promotion */
  private promotionThreshold = 3;

  /**
   * audited 2026-09-02: per-run credit ledger, keyed by the run's sessionId (= chatId).
   * The orchestrator tags EVERY tool:result of a run with the whole set retrieved
   * ONCE at run start, so an instinct retrieved once was being credited once per
   * tool call — 60 calls read as "applied 60x", and 13 failing unrelated calls
   * deprecated a healthy teaching. An instinct is now credited at most once per
   * run per tool it governs; the orchestrator clears the run's ledger at teardown
   * ({@link clearRunInstinctCredits}) alongside currentSessionInstinctIds.
   */
  /**
   * D40 (audit 04.2b): the per-run credit used to be APPLIED by the first
   * related tool result, from that one event's verdict, and no terminal outcome
   * was ever consulted — so an instinct was reinforced for a run that later
   * failed (a green first build, then a failed verdict, still read as a
   * success). The ledger now holds credit PENDING until the run ends, and
   * {@link clearRunInstinctCredits} settles it from the run's terminal verdict.
   *
   * Value per instinct: the evidence observed in-run, used only when the caller
   * supplies no terminal verdict (any observed failure wins — never the first
   * event's opinion), plus `exposedAt` — WHEN the run was shown this guidance.
   *
   * Round 11 #8: the exposure time is a different fact from the settlement time,
   * and the ledger needs both. Settlement rides the serial queue behind the run's
   * own events (#14), so a rule retired between the two looked to the ledger like
   * a rule a run had applied AFTER its retirement. The earliest application in
   * the run wins: that is when the guidance first reached it.
   */
  private readonly runPendingCredits = new Map<string, Map<string, { success: boolean; verdictScore: number; exposedAt: number }>>();

  /**
   * ROUND 12 #9 — WHEN THE RUN WAS SHOWN THE GUIDANCE, FROM WHERE IT WAS SHOWN.
   *
   * Round 11 #8 split exposure from settlement and then filled the exposure
   * column with `Date.now()` at the moment the tool event was PROCESSED. Tool
   * events ride the same serial queue as the settlement (#14), so that is the
   * very clock the fix was written to stop trusting: retire a rule between a
   * run's exposure and its queued event, and the ledger reports the retired rule
   * as still being applied — the alarm that is supposed to mean a leak.
   *
   * Keyed exactly like the pending credit, by {@link runCreditKey}, and reported
   * by whoever puts the guidance in front of the model
   * ({@link noteGuidanceShown}). Nothing here guesses: with no recorded exposure
   * the tool event's OWN timestamp is used — later than the true exposure but
   * still a fact from inside the run, never the processing clock.
   */
  private readonly runGuidanceShownAt = new Map<string, Map<string, number>>();
  /** Bound on the exposure map: oldest run's exposures forgotten first. */
  private static readonly MAX_SHOWN_RUNS = 200;

  /**
   * ROUND 13 #25 — RULES THIS RUN WAS SHOWN AND DEMONSTRABLY DID NOT USE.
   *
   * One exposure produced TWO contradictory ledger rows: the error-recovery hook
   * wrote its non-application row straight to storage, while this pipeline's
   * terminal settlement wrote a positive row for the same instinct, the same run
   * and the same `exposedAt` — because the run's tool events name the guidance it
   * was CARRYING, which is not the same fact as the guidance it USED. A reader
   * asking "which runs did this rule influence, and how did they end" got both
   * answers for one moment.
   *
   * So there is one settlement ledger, and this is its dedup key: run → instinct
   * → the EXPOSURES already judged. One exposure reported twice writes one row;
   * two exposures in one run (the rule shown for two different errors) are two
   * facts and two rows. An instinct listed here at all has its pending credit
   * dropped: a rule the run demonstrably did not use is not credited with the
   * run's outcome either.
   */
  private readonly runNonApplied = new Map<string, Map<string, Set<number>>>();

  /**
   * ROUND 10 #14 — A RUN'S TERMINAL VERDICT IS FINAL, INCLUDING FOR LATE EVENTS.
   *
   * Tool results reach this pipeline through an asynchronous serial queue
   * (bootstrap.ts), while the engine's teardown settled directly — so an event
   * queued before teardown could be processed after it. That event recreated
   * PENDING credit under the chat's key, and the next run's teardown on the same
   * chat then settled it as that run's outcome: a rule was reinforced by a run it
   * never took part in. Two things stop it. {@link setSettlementBarrier} puts the
   * settlement on the same queue, behind the events it is meant to judge; and a
   * settled run's verdict is REMEMBERED here, so an event that still arrives late
   * is credited from the verdict of the run it belonged to, exactly once
   * (`credited` is the once-per-run-per-instinct guard the pending map gave).
   *
   * Only runs that HAVE an identity are remembered: without a taskRunId the chat
   * is the whole scope and a late event is indistinguishable from the next run's
   * first event, so that case keeps its previous behaviour rather than guessing.
   */
  private readonly settledRuns = new Map<string, {
    sessionId: string;
    runId: string;
    terminal: { success: boolean; verdictScore: number };
    credited: Set<string>;
  }>();
  /** Bound on the retained-verdict map: oldest run forgotten first. */
  private static readonly MAX_SETTLED_RUNS = 200;

  /**
   * Round 10 #14 — how to order terminal settlement behind this run's own tool
   * events. Bootstrap passes the learning queue's enqueue, the same serial queue
   * `tool:result` is processed on, so the settlement runs after every event
   * already queued for the run. Unset (tests, standalone use) ⇒ settlement is
   * immediate, exactly as before.
   */
  private settlementBarrier?: (
    task: () => Promise<void> | void,
    /**
     * Round 12 #7/#8: what the work IS (for the queue's overflow warning and
     * shutdown report) and what to do if the queue cannot carry it. A barrier
     * that ignores this second argument keeps the previous behaviour exactly.
     */
    options?: { label?: string; onAbandoned?: () => void },
  ) => boolean | void;

  /** See {@link settlementBarrier}. */
  setSettlementBarrier(
    barrier: (
      task: () => Promise<void> | void,
      options?: { label?: string; onAbandoned?: () => void },
    ) => boolean | void,
  ): void {
    this.settlementBarrier = barrier;
  }

  /** Run-scoped key. The chat id alone cannot tell two sibling runs apart (#13). */
  private static runCreditKey(sessionId: string, runId?: string): string {
    const run = runId?.trim();
    return run ? `${sessionId}\u0000${run}` : sessionId;
  }

  /**
   * ROUND 12 #9 — "THIS GUIDANCE IS NOW IN FRONT OF THE MODEL", reported by
   * whoever put it there. That moment is the exposure the credit ledger carries,
   * and the ledger's leak measure ("applied AFTER it was retired") is only
   * meaningful while it stays that moment and not a queue timestamp.
   *
   * Called for the SAME fact the error-recovery hooks already record as
   * `shownGuidance` (97f7d92d), so there is one notion of "when it was shown"
   * rather than two. The EARLIEST report for a run wins: a mid-run re-retrieval
   * showing the same rule again does not move the exposure.
   */
  noteGuidanceShown(params: {
    sessionId: string;
    /** Which run was shown it (#13). Omitted off-run: the chat is the scope. */
    taskRunId?: string;
    instinctIds: readonly string[];
    /** When it entered the prompt. Defaults to now — the caller IS the prompt. */
    shownAt?: number;
    /**
     * ROUND 15 #13 — THE DURABLE EXPOSURE ROW'S OWN KEY, when the producer has no
     * `taskRunId` to give.
     *
     * Error recovery knows nothing about the run it is inside; it knows the
     * EPISODE it is handling (its correlation id). Recording its exposures under a
     * blank run collapsed every later episode onto the first row — which keeps the
     * earliest `shown_at`, so a window covering recent activity found nothing and
     * printed NOT MEASURED while exposures were happening — and put the row under a
     * key no judgement would look for.
     *
     * Defaults to `taskRunId`. A producer that passes it must pass the SAME value
     * to the judgement, which is what makes the row findable.
     */
    exposureRunId?: string;
  }): void {
    if (params.instinctIds.length === 0) return;
    const shownAt = params.shownAt ?? Date.now();
    const key = LearningPipeline.runCreditKey(params.sessionId, params.taskRunId);
    let shown = this.runGuidanceShownAt.get(key);
    if (!shown) {
      shown = new Map<string, number>();
      this.runGuidanceShownAt.set(key, shown);
      while (this.runGuidanceShownAt.size > LearningPipeline.MAX_SHOWN_RUNS) {
        const oldest = this.runGuidanceShownAt.keys().next();
        if (oldest.done || oldest.value === key) break;
        this.runGuidanceShownAt.delete(oldest.value);
      }
    }
    for (const rawId of params.instinctIds) {
      const id = String(rawId).trim();
      if (!id) continue;
      const already = shown.get(id);
      if (already === undefined || shownAt < already) shown.set(id, shownAt);
      // DURABLE, because "how much of the misfire measurement is not being made"
      // is a question about a period and not about this process's lifetime. Since
      // round 13 #24 / round 14 #14 an exposure is only judged when something
      // REPORTS what was applied, so the unjudged ones are the majority — and a
      // credit row's absence cannot tell "shown and never judged" from "never
      // shown". This row can.
      try {
        const exposureRunId = params.exposureRunId?.trim() || params.taskRunId?.trim();
        this.storage.recordInstinctExposure({
          instinctId: id,
          sessionId: params.sessionId,
          ...(exposureRunId ? { taskRunId: exposureRunId } : {}),
          shownAt,
        });
      } catch {
        // The row is the record, not the mechanism: a storage failure must never
        // stop guidance reaching the prompt that is already on its way.
      }
    }
  }

  /**
   * ROUND 13 #25 — NON-APPLICATION EVIDENCE, THROUGH THE ONE SETTLEMENT LEDGER.
   *
   * "This run was shown rule R and demonstrably did not use it" is weak evidence
   * against R's TRIGGER (not against its action — the action was never tried), and
   * it used to be written by {@link ErrorLearningHooks} straight into storage,
   * beside whatever this pipeline's settlement wrote for the same exposure. Both
   * paths now come through here, so:
   *
   *   - the run's PENDING credit for R is dropped. A rule nobody used cannot be
   *     credited with the run's outcome, and that is what stopped one exposure
   *     producing a negative `observed` row and a positive `terminal` row;
   *   - the same non-application reported twice writes one row;
   *   - a run that has already settled keeps its verdict: if R was credited by
   *     that settlement the ledger is not rewritten, because a run's outcome is
   *     decided once.
   *
   * Returns what it did, so a caller can report a gap instead of assuming a write.
   */
  noteGuidanceNotApplied(params: {
    sessionId: string;
    /** Which run was shown it (#13). Omitted off-run: the chat is the scope. */
    taskRunId?: string;
    instinctId: string;
    /** When the run was shown the rule (r12 #9). Defaults to now. */
    exposedAt?: number;
    /** Beta weight of ONE non-application. A fraction of a real failure. */
    betaDelta: number;
    /** r15 #13: the key the exposure row was recorded under, when not the run's. */
    exposureRunId?: string;
  }): "recorded" | "duplicate" | "already-settled" | "unknown-instinct" {
    const instinctId = String(params.instinctId).trim();
    if (!instinctId) return "unknown-instinct";
    const instinct = this.storage.getInstinct(instinctId as InstinctId);
    if (!instinct) return "unknown-instinct";

    const creditKey = LearningPipeline.runCreditKey(params.sessionId, params.taskRunId);
    let nonApplied = this.runNonApplied.get(creditKey);
    if (!nonApplied) {
      nonApplied = new Map<string, Set<number>>();
      this.runNonApplied.set(creditKey, nonApplied);
      while (this.runNonApplied.size > LearningPipeline.MAX_SHOWN_RUNS) {
        const oldest = this.runNonApplied.keys().next();
        if (oldest.done || oldest.value === creditKey) break;
        this.runNonApplied.delete(oldest.value);
      }
    }
    const exposedAt = params.exposedAt ?? Date.now();
    let exposures = nonApplied.get(instinctId);
    if (exposures?.has(exposedAt) === true) return "duplicate";

    const settled = this.settledRuns.get(creditKey);
    if (settled?.credited.has(instinctId) === true) {
      // The run's terminal verdict already spoke for this exposure. Two rows for
      // one moment is the defect; the first writer wins.
      if (!exposures) {
        exposures = new Set<number>();
        nonApplied.set(instinctId, exposures);
      }
      exposures.add(exposedAt);
      return "already-settled";
    }
    if (!exposures) {
      exposures = new Set<number>();
      nonApplied.set(instinctId, exposures);
    }
    exposures.add(exposedAt);
    settled?.credited.add(instinctId);
    // Never credited with this run's outcome: it took no part in it.
    this.runPendingCredits.get(creditKey)?.delete(instinctId);

    const before = instinct.confidence;
    // A non-application is NOT a failure: the action was never tried, so
    // `timesFailed` must not move and one misfire cannot retire a rule. Only the
    // posterior shifts, by a fraction of a real negative.
    const updated = this.confidenceScorer.applyEvidence(instinct, {
      alphaDelta: 0,
      betaDelta: params.betaDelta,
    });
    this.storage.updateInstinct(updated);
    this.updateInstinctStatus(updated);
    this.recordCreditLedgerSafe(
      params.sessionId,
      { ...instinct, confidence: before },
      { success: false, verdictScore: params.betaDelta },
      "observed",
      updated.confidence,
      params.taskRunId?.trim() || undefined,
      exposedAt,
      false,
      params.exposureRunId?.trim() || undefined,
    );
    return "recorded";
  }

  /**
   * ROUND 15 #14 — AN APPLICATION SOMEBODY REPORTED, THROUGH THE SAME WRITER.
   *
   * The explicit-application path went through {@link ErrorLearningHooks}
   * `reinforceInstinct`, which moves the confidence and writes nothing else. So an
   * application the system had DIRECTLY OBSERVED still left its exposure unjudged:
   * coverage read `shown: 1, judged: 0` while the rule's confidence had just
   * changed because of it. A number built to say how much is unmeasured was
   * overstating the gap, which makes progress indistinguishable from noise — the
   * opposite of what the exposure log is for.
   *
   * The caller keeps ownership of the confidence movement and passes what it did,
   * so routing the judgement here adds a row and a judgement but NOT a second
   * update. The exposure is then settled for this run, exactly as a
   * non-application is: the run's terminal credit must not judge it again.
   */
  noteGuidanceApplied(params: {
    sessionId: string;
    taskRunId?: string;
    instinctId: string;
    exposedAt?: number;
    /** The outcome the application was judged by. */
    success: boolean;
    verdictScore: number;
    /** The movement the caller ALREADY made — recorded, never re-applied. */
    confidenceBefore: number;
    confidenceAfter: number;
    /** r15 #13: the key the exposure row was recorded under, when not the run's. */
    exposureRunId?: string;
  }): "recorded" | "duplicate" | "unknown-instinct" {
    const instinctId = String(params.instinctId).trim();
    if (!instinctId) return "unknown-instinct";
    const instinct = this.storage.getInstinct(instinctId as InstinctId);
    if (!instinct) return "unknown-instinct";

    const creditKey = LearningPipeline.runCreditKey(params.sessionId, params.taskRunId);
    let judged = this.runNonApplied.get(creditKey);
    if (!judged) {
      judged = new Map<string, Set<number>>();
      this.runNonApplied.set(creditKey, judged);
      while (this.runNonApplied.size > LearningPipeline.MAX_SHOWN_RUNS) {
        const oldest = this.runNonApplied.keys().next();
        if (oldest.done || oldest.value === creditKey) break;
        this.runNonApplied.delete(oldest.value);
      }
    }
    const exposedAt = params.exposedAt ?? Date.now();
    let exposures = judged.get(instinctId);
    if (exposures?.has(exposedAt) === true) return "duplicate";
    if (!exposures) {
      exposures = new Set<number>();
      judged.set(instinctId, exposures);
    }
    exposures.add(exposedAt);
    this.settledRuns.get(creditKey)?.credited.add(instinctId);
    // Judged once: the run's own settlement must not credit it a second time.
    this.runPendingCredits.get(creditKey)?.delete(instinctId);

    this.recordCreditLedgerSafe(
      params.sessionId,
      { ...instinct, confidence: params.confidenceBefore },
      { success: params.success, verdictScore: params.verdictScore },
      "observed",
      params.confidenceAfter,
      params.taskRunId?.trim() || undefined,
      exposedAt,
      true,
      params.exposureRunId?.trim() || undefined,
    );
    return "recorded";
  }

  /**
   * When this run was shown `instinctId` (round 12 #9).
   *
   * The event's own timestamp is both the fallback and the ceiling: an event that
   * reports applying a rule proves the run had already been shown it, so the
   * earlier of the two is the honest answer — and the processing clock is never
   * consulted. An event with no usable timestamp leaves nothing better than now.
   */
  private exposureFor(
    sessionId: string,
    runId: string | undefined,
    instinctId: string,
    eventTimestamp: unknown,
  ): number {
    const fromEvent =
      typeof eventTimestamp === "number" && Number.isFinite(eventTimestamp) && eventTimestamp > 0
        ? eventTimestamp
        : Date.now();
    const recorded = this.runGuidanceShownAt.get(LearningPipeline.runCreditKey(sessionId, runId))?.get(instinctId);
    return recorded !== undefined && recorded < fromEvent ? recorded : fromEvent;
  }

  /**
   * Run teardown: settle this run's pending instinct credit from the run's
   * TERMINAL verdict, then forget the run. Called once per run (the engine's
   * persistTerminal, where the terminal status is already known).
   *
   * `terminal` omitted (older callers, tests): settles from the evidence
   * observed during the run instead — a failure seen anywhere in the run is a
   * failure, so the first event can never decide the outcome on its own.
   */
  clearRunInstinctCredits(
    sessionId: string,
    terminal?: { success: boolean; verdictScore?: number },
    /** Which run is ending (#13). Omitted off-run: the chat is then the scope. */
    runId?: string,
  ): void {
    // #14: behind this run's own queued events when a barrier is wired.
    const barrier = this.settlementBarrier;
    if (barrier) {
      // ROUND 12 #7/#8 — A QUEUE THAT CANNOT TAKE THE SETTLEMENT MUST NOT SWALLOW
      // IT. The learning queue's durable backlog is bounded now, and its shutdown
      // drain runs under a deadline, so the barrier can refuse or abandon the
      // work. Either way this run settles: `onAbandoned` does it at the moment of
      // refusal (or when the drain gives up), and an explicit `false` from a
      // barrier that has no fallback wiring settles it here. Out of order and
      // said so — a settlement delayed is not lost, a settlement dropped is.
      let settledHere = false;
      const settleNow = (): void => {
        settledHere = true;
        this.settleAndForgetRun(sessionId, terminal, runId);
      };
      const accepted = barrier(() => this.settleAndForgetRun(sessionId, terminal, runId), {
        label: `terminal settlement for run ${runId?.trim() || sessionId}`,
        onAbandoned: settleNow,
      });
      if (accepted !== false || settledHere) return;
    }
    this.settleAndForgetRun(sessionId, terminal, runId);
  }

  /** Settle, then forget — the body {@link clearRunInstinctCredits} defers. */
  private settleAndForgetRun(
    sessionId: string,
    terminal?: { success: boolean; verdictScore?: number },
    runId?: string,
  ): void {
    this.settleRunInstinctCredits(sessionId, terminal, runId);
    this.runPendingCredits.delete(LearningPipeline.runCreditKey(sessionId, runId));
    // Round 12 #9: the run is over, so what it was shown is no longer an open
    // fact. Keeping it would date the NEXT run's exposure from this one's prompt.
    this.runGuidanceShownAt.delete(LearningPipeline.runCreditKey(sessionId, runId));
    // Round 13 #25: and so is what it was shown and did not use — but only when
    // the key is the CHAT's, because the next run reuses that key and must not
    // inherit this run's judgements. A run-scoped key is never reused, so its
    // record stays as the dedup for a straggler that arrives after teardown
    // (round 14 #13; with a terminal verdict it has also moved into
    // `settledRuns.credited`). Bounded by MAX_SHOWN_RUNS either way.
    if (runId?.trim() === undefined || runId.trim() === "") {
      this.runNonApplied.delete(LearningPipeline.runCreditKey(sessionId, runId));
    }
    this.evictSessionPendingResolutions(sessionId, runId);
  }

  /**
   * Drop this session's unrepaired failures. audit 04.cap (2026-09-17): the only
   * drain was the 10-minute periodic sweep, so a run's pending failure outlived
   * the run — a later, unrelated run on the same chat could still be booked as
   * its repair — and the map grew for every (session, tool) pair the daemon saw.
   * A failure nobody repaired before the run ended is not repairable any more.
   *
   * Returns how many were evicted, so a caller never mistakes a no-op for a sweep.
   */
  evictSessionPendingResolutions(sessionId: string, runId?: string): number {
    // #13: with a run identity, only THIS run's unrepaired failures go — a
    // sibling run on the same chat is still in flight and still owns its own.
    // Without one, the whole chat's go, run-scoped keys included (a teardown that
    // knows no run must not leave a run's failures behind for the next one).
    const run = runId?.trim();
    const matches = run
      ? (key: string) => key.startsWith(`${LearningPipeline.runCreditKey(sessionId, run)}:`)
      : (key: string) => key.startsWith(`${sessionId}:`) || key.startsWith(`${sessionId}\u0000`);
    let evicted = 0;
    for (const key of this.pendingResolutions.keys()) {
      if (matches(key)) {
        this.pendingResolutions.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Apply the run's pending credit. Terminal verdict when the caller knows it,
   * else the worst evidence observed in-run. One updateConfidence per instinct
   * per run (the dedup the pending map's keys already give).
   */
  private settleRunInstinctCredits(
    sessionId: string,
    terminal?: { success: boolean; verdictScore?: number },
    runId?: string,
  ): void {
    const creditKey = LearningPipeline.runCreditKey(sessionId, runId);
    const pending = this.runPendingCredits.get(creditKey);

    const settled = terminal
      ? {
          success: terminal.success,
          verdictScore:
            terminal.verdictScore ??
            (terminal.success ? this.bayesianConfig.verdictCleanSuccess : this.bayesianConfig.verdictFailure),
        }
      : undefined;

    // #14: remember the verdict BEFORE applying it, and whether or not anything
    // is pending — a run with no pending credit can still receive a late event,
    // and that event must be judged by this run's verdict, not the next one's.
    const run = runId?.trim();
    const credited = run && settled
      ? this.rememberSettledRun(creditKey, sessionId, run, settled)
      : new Set<string>();

    if (!pending || pending.size === 0) return;

    for (const [instinctId, observed] of pending) {
      credited.add(instinctId);
      // WAS THIS THE RUN'S OWN VERDICT, OR A GUESS FROM WHAT THE RUN SHOWED?
      // The ledger has to say which; a reader judging a rule by the runs it
      // influenced must not be shown inferred outcomes as terminal ones.
      this.applyInstinctCredit(
        sessionId,
        run,
        instinctId,
        settled ?? { success: observed.success, verdictScore: observed.verdictScore },
        settled ? "terminal" : "observed",
        // r11 #8: when the run was SHOWN the rule, which is not now.
        observed.exposedAt,
      );
    }
  }

  /**
   * Retain one run's terminal verdict for events that arrive after its teardown
   * (#14), and return the set that records which instincts it has already
   * credited. Bounded: the oldest run is forgotten first.
   */
  private rememberSettledRun(
    creditKey: string,
    sessionId: string,
    runId: string,
    terminal: { success: boolean; verdictScore: number },
  ): Set<string> {
    const existing = this.settledRuns.get(creditKey);
    // A run settles ONCE. A second teardown for the same run must not replace
    // the verdict the first one recorded.
    if (existing) return existing.credited;

    // ROUND 14 #13 — THE DEDUP MUST OUTLIVE THE RUN, because a late event does.
    // `credited` is what stops an event that arrives after teardown being credited
    // twice, and the rules this run was shown and demonstrably did NOT use belong
    // in it: their exposure is already settled, with a negative row. Seeded here
    // because `settleAndForgetRun` deletes `runNonApplied` immediately afterwards —
    // without this the straggler found no record, was judged by the run's
    // (successful) verdict, and wrote a positive `terminal` row beside the negative
    // `observed` one. One exposure, two contradictory rows, one queue delay later.
    const credited = new Set<string>(this.runNonApplied.get(creditKey)?.keys() ?? []);
    this.settledRuns.set(creditKey, { sessionId, runId, terminal, credited });
    while (this.settledRuns.size > LearningPipeline.MAX_SETTLED_RUNS) {
      const oldest = this.settledRuns.keys().next();
      if (oldest.done) break;
      this.settledRuns.delete(oldest.value);
    }
    return credited;
  }

  /**
   * Credit one instinct for one run's outcome (#14): the settled body shared by
   * the run's own teardown and by an event that arrived after it.
   */
  private applyInstinctCredit(
    sessionId: string,
    runId: string | undefined,
    instinctId: string,
    outcome: { success: boolean; verdictScore: number },
    creditSource: "terminal" | "observed",
    /** When the run was SHOWN this guidance (round 11 #8). */
    exposedAt?: number,
  ): void {
    const instinct = this.storage.getInstinct(instinctId as InstinctId);
    if (!instinct) return;
    // Permanent instincts are frozen against confidence updates — but not
    // unaccountable: the run's outcome feeds the quarantine counter.
    if (instinct.status === "permanent") {
      this.recordPermanentEvidence(instinct, outcome.success);
      this.recordCreditLedgerSafe(sessionId, instinct, outcome, creditSource, instinct.confidence, runId, exposedAt);
      return;
    }
    // Increment coolingFailures for failures on cooling instincts
    const instinctForUpdate = !outcome.success && instinct.coolingStartedAt
      ? { ...instinct, coolingFailures: (instinct.coolingFailures ?? 0) + 1 }
      : instinct;
    const updated = this.confidenceScorer.updateConfidence(
      instinctForUpdate,
      outcome.success,
      outcome.verdictScore,
    );
    this.updateInstinctStatus(updated);
    // THE LEDGER ROW (plan 6.4). The settlement moved a rule's confidence
    // and left no trace of the run that moved it: the pending map is memory
    // only, and trajectory_instincts is written empty by every production
    // caller. Without this row "which runs did this guidance influence, and
    // how did they end" is unanswerable, and a wrong rule is found only by
    // somebody noticing it.
    this.recordCreditLedgerSafe(sessionId, instinct, outcome, creditSource, updated.confidence, runId, exposedAt);
  }

  /**
   * An event for a run that has already settled (#14). Judged by that run's own
   * retained verdict, and only if this run has not already credited the instinct
   * — the run's outcome is decided once and cannot be revisited.
   */
  private settleLateCredit(
    settled: { sessionId: string; runId: string; terminal: { success: boolean; verdictScore: number }; credited: Set<string> },
    instinctId: string,
    /**
     * When the run was SHOWN this rule (round 12 #9). The straggler is arriving
     * now, but the run saw the rule while it was still running — stamping now was
     * the same processing-clock mistake, and it made every late event look like a
     * fresh post-retirement application.
     */
    exposedAt: number,
  ): void {
    if (settled.credited.has(instinctId)) return;
    settled.credited.add(instinctId);
    this.applyInstinctCredit(settled.sessionId, settled.runId, instinctId, settled.terminal, "terminal", exposedAt);
  }

  /**
   * Record one settled credit in the audit ledger. Fire-and-forget: a ledger
   * write must never break a run's teardown.
   */
  private recordCreditLedgerSafe(
    sessionId: string,
    instinct: Instinct,
    outcome: { success: boolean; verdictScore: number },
    source: "terminal" | "observed",
    confidenceAfter: number,
    /** #13: which run settled it. The column existed; nothing ever filled it. */
    taskRunId?: string,
    /** r11 #8: when the run was shown the guidance, as opposed to now. */
    exposedAt?: number,
    /** r13 #25: false = shown and demonstrably not used. Omitted ⇒ applied. */
    applied?: boolean,
    /** r15 #13: the key the exposure row is under, when not the run's own. */
    exposureRunId?: string,
  ): void {
    try {
      this.storage.recordInstinctCredit({
        instinctId: String(instinct.id),
        sessionId,
        ...(taskRunId ? { taskRunId } : {}),
        ...(exposedAt === undefined ? {} : { exposedAt }),
        ...(applied === undefined ? {} : { applied }),
        success: outcome.success,
        verdictScore: outcome.verdictScore,
        source,
        confidenceBefore: instinct.confidence,
        confidenceAfter,
        statusAt: instinct.status,
        timestamp: Date.now(),
      });
    } catch {
      // Fire-and-forget: the run's teardown continues either way.
    }
    // This exposure has now been judged, whichever way it went. The exposure log
    // measures how much of the guidance we show is ever decided about; a decision
    // that did not close its exposure would leave the coverage number lying in the
    // pessimistic direction.
    try {
      const exposureKey = exposureRunId ?? taskRunId;
      this.storage.markInstinctExposureJudged({
        instinctId: String(instinct.id),
        sessionId,
        ...(exposureKey ? { taskRunId: exposureKey } : {}),
        judgedAs: applied === false ? "not-applied" : "credited",
      });
    } catch {
      // Same contract as the row above: a bookkeeping failure is not a run failure.
    }
  }

  constructor(
    storage: LearningStorage,
    config: Partial<LearningConfig> = {},
    embeddingProvider?: IEmbeddingProvider,
    bayesianConfig?: BayesianConfig,
    eventBus?: IEventBus<LearningEventMap>,
  ) {
    this.storage = storage;
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
    this.bayesianConfig = bayesianConfig ?? DEFAULT_BAYESIAN_CONFIG;
    this.confidenceScorer = new ConfidenceScorer();
    // The same provider that embeds every created instinct (EmbeddingQueue,
    // below) must also be what reads those vectors back; this matcher was
    // built without it, so the stored embeddings were never consulted
    // (audited 2026-09-02).
    this.patternMatcher = new PatternMatcher(storage, {
      embedder: embeddingProvider ? embedderFromProvider(embeddingProvider) : undefined,
    });
    this.runtimeArtifacts = new RuntimeArtifactManager(storage);
    this.eventBus = eventBus ?? null;
    // audited 2026-09-02: reactions must reach the stored confidence the
    // lifecycle, ranking and intervention tier read — not only factor_* columns.
    this.feedbackHandler = new FeedbackHandler(storage, {
      onReaction: (instinct, positive) => this.applyReactionEvidence(instinct, positive),
    });

    if (embeddingProvider) {
      this.embeddingQueue = new EmbeddingQueue(embeddingProvider, storage);
    }

    // Subscribe to feedback:reaction events from channel adapters
    if (this.eventBus) {
      this.feedbackReactionListener = (event: FeedbackReactionEvent) => {
        if (event.type === "thumbs_up") {
          this.feedbackHandler.handleThumbsUp({
            instinctIds: event.instinctIds,
            userId: event.userId,
            source: event.source,
          });
        } else if (event.type === "thumbs_down") {
          this.feedbackHandler.handleThumbsDown({
            instinctIds: event.instinctIds,
            userId: event.userId,
            source: event.source,
          });
        }
      };
      this.eventBus.on("feedback:reaction", this.feedbackReactionListener);

      // ROUND 13 #22 — registered HERE, in the constructor, so this listener runs
      // before the one that queues the event's processing (listeners fire in
      // subscription order, and the queueing subscriber is wired after the
      // pipeline is built). The queue may evict or discard the event; the fact
      // the run's settlement depends on is already durable by then.
      this.toolResultCreditListener = (event: ToolResultEvent) => {
        try {
          this.noteAppliedInstinctCredit(event);
        } catch {
          // A credit note must never take the emitter's tool call down with it;
          // the queued handleToolResult will try again.
        }
      };
      this.eventBus.on("tool:result", this.toolResultCreditListener);
    }
  }

  /** Set the project path for scope-aware instinct creation (Phase 13) */
  setProjectPath(path: string): void {
    this.projectPath = path;
  }

  /** Set the promotion threshold for scope promotion (Phase 13) */
  setPromotionThreshold(threshold: number): void {
    this.promotionThreshold = threshold;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.isRunning || !this.config.enabled) return;

    this.isRunning = true;

    // Seed Strada.Core conventions on every boot (idempotent — skips existing patterns)
    seedAllFrameworkConventions(this.storage).catch((_err) => {
      // Seed errors are non-fatal — conventions will be seeded on next boot
    });

    // Detection timer removed -- event-driven processing via handleToolResult() replaces it.
    // Drain any leftover unprocessed observations from previous sessions on startup.
    void this.runDetectionBatch().catch(() => { /* non-critical startup drain */ });

    this.evolutionTimer = setInterval(() => this.tickEvolution(), this.config.evolutionIntervalMs);

    // Periodic trajectory extraction — use detection interval from config
    const periodicMs = this.config.detectionIntervalMs;
    this.periodicTimer = setInterval(() => {
      void this.tickPeriodicExtraction();
    }, periodicMs);
  }

  /**
   * Evolution tick with error isolation. An unguarded throw in a setInterval
   * callback escapes to the process and the global uncaughtException handler
   * shuts the whole daemon down, so swallow it (non-fatal; the next tick retries).
   */
  private tickEvolution(): void {
    try {
      this.runEvolution();
    } catch {
      /* evolution tick errors are non-fatal; the next tick retries */
    }
  }

  /**
   * Periodic-extraction tick with error isolation. runPeriodicExtraction is
   * async, so an unguarded rejection from the setInterval callback becomes an
   * unhandledRejection — which the process-level handler escalates to a full
   * daemon shutdown (src/index.ts). Swallow it (non-fatal; the next tick retries).
   */
  private tickPeriodicExtraction(): Promise<void> {
    return this.runPeriodicExtraction().catch(() => {
      /* periodic-extraction tick errors are non-fatal; the next tick retries */
    });
  }

  stop(): void {
    if (this.embeddingQueue) {
      this.embeddingQueue.shutdown();
    }
    this.isRunning = false;
    if (this.evolutionTimer) {
      clearInterval(this.evolutionTimer);
      this.evolutionTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    if (this.eventBus && this.feedbackReactionListener) {
      this.eventBus.off("feedback:reaction", this.feedbackReactionListener);
      this.feedbackReactionListener = null;
    }
    if (this.eventBus && this.toolResultCreditListener) {
      this.eventBus.off("tool:result", this.toolResultCreditListener);
      this.toolResultCreditListener = null;
    }
  }

  // ─── Observation Methods ─────────────────────────────────────────────────────

  observeToolUse(params: {
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
    output: string;
    success: boolean;
    errorDetails?: ErrorDetails;
  }): void {
    // Note: observation recording is handled by handleToolResult() via the event bus.
    // Only record error patterns here to avoid double-writing observations.
    if (!params.success && params.errorDetails) {
      this.recordErrorPattern(params.errorDetails, params.toolName);
    }
  }

  async observeCorrection(params: {
    sessionId: string;
    toolName: string;
    originalInput: Record<string, unknown>;
    originalOutput: string;
    correctedOutput: string;
    correction: string;
  }): Promise<void> {
    const observation: Observation = {
      id: `obs_${randomUUID()}` as ObservationId,
      type: "correction",
      sessionId: createBrand(params.sessionId, "SessionId" as const),
      toolName: createBrand(params.toolName, "ToolName" as const),
      input: params.originalInput as JsonObject,
      output: params.originalOutput,
      correction: params.correction,
      timestamp: Date.now() as TimestampMs,
      // audited 2026-09-02: instinct creation runs inline right below, so the
      // row is processed at write time. Left at false it was never marked, and
      // the startup drain replayed it into a second, different instinct.
      processed: true,
    };

    this.storage.recordObservation(observation);
    this.storage.flush();

    await this.considerInstinctCreation({
      type: "correction",
      triggerPattern: this.extractTriggerPattern(params.originalOutput),
      action: params.correction,
      toolName: params.toolName,
    });
  }

  // ─── Event-Driven Processing ─────────────────────────────────────────────────

  /**
   * ROUND 13 #22 — THE CREDIT-BEARING HALF OF A TOOL EVENT, REGISTERED BEFORE THE
   * EVENT CAN BE DROPPED.
   *
   * `tool:result` rides the learning queue as DROPPABLE work: evicted on
   * overflow, discarded when shutdown's drain runs out of budget. Everything the
   * event carries is recoverable that way except one fact — WHICH GUIDANCE THIS
   * RUN WAS CARRYING — because that is what the run's terminal settlement
   * settles. Drop the event and the settlement (its own durable item, or its
   * synchronous `onAbandoned` fallback) finds nothing pending and writes ZERO
   * credit rows, while the shutdown report says the settlement was handled. A
   * false green about the one measurement that says whether learning works.
   *
   * So the pipeline subscribes to the bus itself (constructor, before whoever
   * queues the processing) and registers this synchronously, at emit time. It is
   * idempotent: {@link handleToolResult} calls it again when the queue reaches the
   * event, and the pending map's per-instinct entry is the dedup.
   */
  noteAppliedInstinctCredit(event: ToolResultEvent): void {
    if (!event.appliedInstinctIds || event.appliedInstinctIds.length === 0) return;
    const runId = event.taskRunId;
    const verdict = getVerdictScore(event);

    for (const instinctId of event.appliedInstinctIds) {
      const instinct = this.storage.getInstinct(instinctId as InstinctId);
      if (!instinct) continue;

      // Only credit an instinct that has a tool_name contextCondition matching event.toolName.
      // Shared with the trajectory-credit disjoint computation (computeTrajectoryCreditIds) so the
      // two stay exact complements by construction (Issue #22 SIBLING A).
      if (!LearningPipeline.isInstinctRelevantToTool(instinct, event.toolName as string)) continue;

      // audited 2026-09-02: once per run, not once per tool call.
      // #13: keyed by the run, so the first sibling to finish cannot settle
      // (and delete) the credit its sibling is still collecting.
      const creditKey = LearningPipeline.runCreditKey(event.sessionId, runId);

      // r13 #25: this run was shown the rule and demonstrably did not use it.
      // Being CARRIED is not being APPLIED, so it is not credited with the run's
      // outcome — that is what stopped one exposure producing two rows.
      if (this.runNonApplied.get(creditKey)?.has(String(instinctId)) === true) continue;

      // #14: this run has already settled. Its verdict is final, so this late
      // event is judged by THAT verdict — never left pending for whichever run
      // tears down next.
      const settledRun = this.settledRuns.get(creditKey);
      if (settledRun) {
        this.settleLateCredit(
          settledRun,
          instinctId,
          // r12 #9: dated by the run's exposure / this event, never by the
          // moment the queue reached the straggler.
          this.exposureFor(event.sessionId, runId, instinctId, event.timestamp),
        );
        continue;
      }

      let pending = this.runPendingCredits.get(creditKey);
      if (!pending) {
        pending = new Map<string, { success: boolean; verdictScore: number; exposedAt: number }>();
        this.runPendingCredits.set(creditKey, pending);
      }
      const already = pending.get(instinctId);
      if (!already) {
        // r11 #8: the exposure is a different fact from the settlement.
        // r12 #9: and it is not NOW. `Date.now()` here was the moment the
        // serial queue reached this event, so a rule retired between the run's
        // prompt and its queued event read as "applied after retirement" — the
        // alarm that is meant to mean a leak. The exposure comes from where the
        // guidance was shown, falling back to the event's own in-run time.
        pending.set(instinctId, {
          success: verdict.success,
          verdictScore: verdict.verdictScore,
          exposedAt: this.exposureFor(event.sessionId, runId, instinctId, event.timestamp),
        });
      } else if (already.success && !verdict.success) {
        // A later failure in the same run downgrades the observed evidence:
        // the FIRST event never decides the run's outcome on its own (D40).
        // The exposure time is the EARLIEST one and does not move with it.
        pending.set(instinctId, { success: false, verdictScore: verdict.verdictScore, exposedAt: already.exposedAt });
      }
    }
  }

  /**
   * Handle a tool result event from the event bus.
   * Runs the full pipeline per event: observe -> process -> confidence update.
   * Replaces the batch detection timer for per-event learning.
   */
  async handleToolResult(event: ToolResultEvent): Promise<void> {
    // 1. Build observation in-memory (avoids write→read DB round-trip)
    const observation: Observation = {
      id: `obs_${randomUUID()}` as ObservationId,
      type: event.success ? "success" : "error",
      sessionId: createBrand(event.sessionId, "SessionId" as const),
      toolName: createBrand(event.toolName, "ToolName" as const),
      input: event.input as JsonObject,
      output: event.output,
      success: event.success,
      errorDetails: event.errorDetails as ErrorDetails | undefined,
      timestamp: Date.now() as TimestampMs,
      processed: false,
    };

    // 2. Persist and process in-memory (skip getUnprocessedObservations read-back)
    this.storage.recordObservation(observation);

    // Track error→resolution chains.
    // audited 2026-09-02: the map was keyed on tool name alone, so with several
    // sessions sharing one pipeline, session A's failure was "resolved" by
    // session B's unrelated success on the same tool — minting an error_fix
    // instinct whose action was never observed to fix that error — and B's own
    // failure evicted A's pending entry. Key on session + tool.
    // #13: the run, not just the chat. Sibling wave nodes share one chatId.
    const runId = event.taskRunId;
    const resolutionKey = LearningPipeline.resolutionKey(event.sessionId, event.toolName, runId);
    if (!event.success) {
      // Record this as a pending error
      this.pendingResolutions.set(resolutionKey, {
        errorObservation: observation,
        toolName: event.toolName,
        errorOutput: event.output,
        timestamp: Date.now(),
        target: repairTarget(event.input),
      });
    } else if (this.pendingResolutions.has(resolutionKey)) {
      // D39 (audit 04.2a): a success on the same tool in the same session was
      // enough to call the pair an error→fix. So an unrelated `git push`, or a
      // read of a different file, was minted as the "resolution" of a build
      // error — a learned solution never observed to fix anything. A repair now
      // has to act on the SAME target (same file) or explicitly re-run the same
      // command operation ({@link isRepairOf}).
      const pending = this.pendingResolutions.get(resolutionKey)!;
      const elapsed = Date.now() - pending.timestamp;
      const target = repairTarget(event.input);
      if (elapsed >= LearningPipeline.RESOLUTION_LINK_WINDOW_MS) {
        // Past the link window: the error is no longer repairable by this run.
        this.pendingResolutions.delete(resolutionKey);
      } else if (isRepairOf(pending.target, target)) {
        this.pendingResolutions.delete(resolutionKey);
        await this.recordAutoResolution(pending.errorObservation, observation, event.toolName, target);
      }
      // Otherwise the pending error STAYS: an unrelated success on the same tool
      // used to consume it, so the call that actually repaired it was never
      // linked. It is evicted by the stale sweep or at session end.
    }

    if (!event.success && event.errorDetails) {
      this.recordErrorPattern(event.errorDetails as ErrorDetails, event.toolName);
    }

    await this.processObservation(observation);
    // Ensure the observation is flushed to DB before marking it processed,
    // since markObservationsProcessed runs a direct SQL UPDATE.
    this.storage.flush();
    this.storage.markObservationsProcessed([observation.id]);

    // 3. Note which instincts this run owes credit to. The credit is APPLIED at
    //    run end, from the run's terminal verdict (D40 — see runPendingCredits).
    //    Idempotent, and already done synchronously at emit time for events that
    //    travel the event bus (round 13 #22 — see noteAppliedInstinctCredit).
    this.noteAppliedInstinctCredit(event);

    // 4. Inline pattern detection
    this.detectPatternInline({
      toolName: event.toolName,
      success: event.success,
      errorDetails: event.errorDetails as ErrorDetails | undefined,
    });
  }

  // ─── Trajectory Methods ──────────────────────────────────────────────────────

  recordTrajectory(params: {
    sessionId: string;
    chatId?: string;
    taskRunId?: string;
    taskDescription: string;
    steps: TrajectoryStep[];
    outcome: TrajectoryOutcome;
    appliedInstinctIds?: string[];
  }): void {
    // Issue #22 (SIBLING A) — trajectory-level instinct credit (DISJOINT-SET, default OFF, dark).
    // GROUNDWORK ONLY: no production caller passes appliedInstinctIds today (the route-level endTask
    // fires before the run and under a different taskRunId, so it was removed; a future in-run trigger
    // with the populated set in scope will supply it). Until then this always yields [] → byte-identical.
    // The caller passes the FULL set of instincts that participated across the run. The per-tool-result
    // path (handleToolResult, this file ~:344-348) ALREADY credits each participating instinct whose
    // tool_name contextCondition matched a used tool (or that has no contextConditions). To avoid any
    // double-count, the trajectory credit is restricted to the DISJOINT remainder — participating
    // instincts the per-turn path STRUCTURALLY SKIPS (those with contextConditions but no tool_name
    // matching any tool used in this trajectory). Stored AS the trajectory's appliedInstinctIds so the
    // existing autoGenerateVerdict → updateInstinctsFromVerdict reinforces exactly that disjoint set
    // (one updateConfidence each). Flag-OFF (or no appliedInstinctIds): yields [] → byte-identical.
    const creditIds =
      this.config.trajectoryLevelCredit && params.appliedInstinctIds && params.appliedInstinctIds.length > 0
        ? this.computeTrajectoryCreditIds(params.appliedInstinctIds, params.steps)
        : [];

    const trajectory: Trajectory = {
      id: `traj_${randomUUID()}` as TrajectoryId,
      sessionId: createBrand(params.sessionId, "SessionId" as const),
      chatId: params.chatId ? createBrand(params.chatId, "ChatId" as const) : undefined,
      taskRunId: params.taskRunId,
      taskDescription: params.taskDescription,
      steps: params.steps,
      outcome: params.outcome,
      appliedInstinctIds: creditIds as InstinctId[],
      createdAt: Date.now() as TimestampMs,
      processed: false,
    };

    this.storage.createTrajectory(trajectory);

    // Flush immediately to ensure trajectory exists in DB for any follow-up operations
    this.storage.flush();

    // A verdict must name what it measured. The route-level caller reports
    // success as "routeMessage didn't throw" and fires BEFORE the background
    // run, with zero steps — which minted 213 byte-identical "Verified Clean
    // Success, Steps: 0, score=0.88" notes on one campaign (PixelFlow,
    // 2026-08-27) and reinforced pure noise. An empty-step trajectory carries
    // no evidence of work; it earns no verdict.
    if (params.outcome.success && !params.outcome.hadErrors && params.steps.length > 0) {
      this.autoGenerateVerdict(trajectory);
    }
  }

  /**
   * Issue #22 (SIBLING A) — compute the DISJOINT trajectory-credit subset.
   *
   * Returns the participating instincts the per-tool-result path NEVER credited, using the SAME
   * predicate that path applies ({@link isInstinctRelevantToTool}, shared with handleToolResult):
   * per-turn credits an instinct on a tool result iff that predicate holds for that tool. Across the
   * whole run the per-turn-credited set is therefore every participating instinct relevant to SOME
   * tool used in the trajectory. The disjoint remainder (returned here) is the rest: instincts WITH
   * contextConditions whose tool_name conditions (if any) never matched a used tool — provably zero
   * overlap, so no double-count. Missing/permanent instincts are harmless downstream (updateConfidence
   * freezes permanent; updateInstinctsFromVerdict skips missing) but are filtered here for clarity.
   */
  private computeTrajectoryCreditIds(
    participatingInstinctIds: readonly string[],
    steps: readonly TrajectoryStep[],
  ): string[] {
    const usedToolNames: string[] = [];
    for (const step of steps) {
      usedToolNames.push(step.toolName as string);
    }

    const disjoint: string[] = [];
    const seen = new Set<string>();
    for (const instinctId of participatingInstinctIds) {
      if (seen.has(instinctId)) continue;
      seen.add(instinctId);

      const instinct = this.storage.getInstinct(instinctId);
      if (!instinct) continue;

      // Per-turn-credited iff the SHARED predicate holds for ANY tool used in the run (no
      // contextConditions ⇒ relevant to every tool ⇒ always per-turn-credited ⇒ NOT disjoint). The
      // disjoint set is the exact complement: relevant to NONE of the used tools.
      const perTurnCredited = usedToolNames.some((toolName) =>
        LearningPipeline.isInstinctRelevantToTool(instinct, toolName),
      );
      if (perTurnCredited) continue;

      // Structurally skipped per-turn (planning/strategy or stale-tool instinct) ⇒ disjoint, credit it.
      disjoint.push(instinctId);
    }
    return disjoint;
  }

  /**
   * Issue #22 (SIBLING A) — the single per-turn relevance predicate, shared by the per-tool-result
   * credit path (handleToolResult) and the trajectory-credit disjoint computation
   * ({@link computeTrajectoryCreditIds}). Per-turn credits an instinct on a given tool result iff it
   * has NO contextConditions (applies to every tool) OR a `tool_name` contextCondition equal to that
   * tool. Keeping ONE definition guarantees the disjoint set stays the exact complement of the
   * per-turn-credited set, so no future edit to one site can silently reintroduce double-count.
   */
  private static isInstinctRelevantToTool(instinct: Instinct, toolName: string): boolean {
    return (
      instinct.contextConditions.length === 0 ||
      instinct.contextConditions.some((cc) => cc.type === "tool_name" && cc.value === toolName)
    );
  }

  submitVerdict(params: {
    trajectoryId: string;
    judgeType: Verdict["judgeType"];
    score: number;
    dimensions: Partial<VerdictDimensions>;
    feedback?: string;
  }): void {
    const verdict: Verdict = {
      id: `verdict_${randomUUID()}` as VerdictId,
      trajectoryId: params.trajectoryId as TrajectoryId,
      judgeType: params.judgeType,
      score: params.score,
      dimensions: {
        efficiency: params.dimensions.efficiency ?? 0.5,
        correctness: params.dimensions.correctness ?? 0.5,
        quality: params.dimensions.quality ?? 0.5,
        bestPractices: params.dimensions.bestPractices ?? 0.5,
      },
      feedback: params.feedback,
      createdAt: Date.now() as TimestampMs,
      judgeId: "system", // Required field
    };

    this.storage.recordVerdict(verdict);
    this.updateInstinctsFromVerdict(params.trajectoryId, params.score);
  }

  // ─── Batch Processing ────────────────────────────────────────────────────────

  async runDetectionBatch(): Promise<{ instinctsCreated: number; patternsDetected: number }> {
    if (!this.config.enabled) return { instinctsCreated: 0, patternsDetected: 0 };

    let instinctsCreated = 0;
    let patternsDetected = 0;

    // Process observations
    const observations = this.storage.getUnprocessedObservations(this.config.batchSize);
    for (const obs of observations) {
      if (await this.processObservation(obs)) patternsDetected++;
    }
    this.storage.markObservationsProcessed(observations.map(o => o.id));

    // Process trajectories
    const trajectories = this.storage.getUnprocessedTrajectories(this.config.batchSize);
    for (const trajectory of trajectories) {
      const instinct = await this.extractInstinctFromTrajectory(trajectory);
      if (instinct) {
        this.checkScopePromotion(instinct);
        if (this.embeddingQueue) {
          this.embeddingQueue.enqueue(instinct.id, `${instinct.triggerPattern} ${instinct.action}`);
        }
        instinctsCreated++;
      }
    }
    this.storage.markTrajectoriesProcessed(trajectories.map(t => t.id));

    return { instinctsCreated, patternsDetected };
  }

  // ─── Instinct Management ─────────────────────────────────────────────────────

  async considerInstinctCreation(params: {
    type: InstinctType;
    triggerPattern: string;
    action: string;
    toolName?: string;
    contextConditions?: ContextCondition[];
    scopeType?: ScopeType;
    /** Owner of a user-scoped instinct (item 3.1) — carried into the scope row. */
    userId?: string;
    confidence?: number;
  }): Promise<Instinct | null> {
    if (!this.isMeaningfulTrigger(params.triggerPattern)) return null;
    // Check for similar existing instincts (use similarity threshold, not confidence)
    const similar = await this.patternMatcher.findSimilarInstincts(params.triggerPattern);
    if (this.isDuplicateOfExisting(similar, params)) return null;

    const initialConfidence = params.confidence ?? this.calculateInitialConfidence(params);
    if (initialConfidence < this.config.minConfidenceForCreation) return null;

    const scopeType: ScopeType = params.scopeType ?? 'project';

    const instinct: Instinct = {
      id: createInstinctId(),
      name: this.generateInstinctName(params),
      type: params.type,
      status: "proposed",
      confidence: initialConfidence,
      triggerPattern: params.triggerPattern,
      action: params.action,
      contextConditions: params.contextConditions ?? this.generateContextConditions(params.toolName as ToolName | undefined),
      stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
      createdAt: Date.now() as TimestampMs,
      updatedAt: Date.now() as TimestampMs,
      sourceTrajectoryIds: [],
      tags: [],
      scopeType,
      ...(params.userId ? { userId: params.userId } : {}),
    };

    // Store instinct row without old-style scope, then add v2 scope entry with
    // scopeType and the owner (item 3.1).
    this.storage.createInstinct(instinct, undefined);
    if (this.projectPath) {
      this.storage.addInstinctScopeV2(instinct.id, this.projectPath, scopeType, params.userId);
    }
    this.checkScopePromotion(instinct);
    if (this.embeddingQueue) {
      this.embeddingQueue.enqueue(instinct.id, `${instinct.triggerPattern} ${instinct.action}`);
    }
    this.enforceMaxInstincts();
    // LIVING VAULT (C): mirror high-confidence instincts as learned-heuristic notes.
    this.noteHighConfidenceInstinct(instinct);
    return instinct;
  }

  /**
   * ROUND 10 #12 — IS THIS A DUPLICATE, OR A RIVAL SOLUTION?
   *
   * The old gate refused creation on TRIGGER similarity alone, so the second way
   * to fix one error was never written down: "NullReferenceException in X" was
   * already known, therefore "construct it eagerly in Awake" was noise. It also
   * counted blockers that are not in use, and blockers that are not the caller's:
   *
   *  - trigger AND action must both match. A different solution to a known
   *    trigger is knowledge; the matcher's eager merge already draws the line
   *    here (D43) and this gate now draws it in the same place.
   *  - the blocker must have the same OWNER. Alice's private rule is not Bob's
   *    duplicate, and vice versa.
   *  - deprecated / evolved / QUARANTINED rules block nothing. A quarantined
   *    instinct is one deliberately held out of use for being wrong — it must
   *    not also prevent the replacement that supersedes it.
   */
  private isDuplicateOfExisting(
    similar: PatternMatch[],
    params: { triggerPattern: string; action: string; userId?: string },
  ): boolean {
    for (const m of similar) {
      if (!m.instinct) continue;
      // Raw similarity (relevance), not the confidence-weighted score.
      if (m.relevance <= CONFIDENCE_THRESHOLDS.SIMILAR) continue;
      if (
        m.instinct.status === "deprecated" ||
        m.instinct.status === "evolved" ||
        m.instinct.status === "quarantined"
      ) continue;
      if ((m.instinct.userId ?? null) !== (params.userId ?? null)) continue;
      if (combinedSimilarity(m.instinct.action, params.action) <= CONFIDENCE_THRESHOLDS.SIMILAR) continue;
      return true;
    }
    return false;
  }

  createInstinct(params: Omit<Instinct, "id" | "stats" | "createdAt" | "updatedAt" | "sourceTrajectoryIds" | "tags"> & { scopeType?: ScopeType; userId?: string }): Instinct {
    const scopeType: ScopeType = params.scopeType ?? 'project';
    const instinct: Instinct = {
      ...params,
      id: createInstinctId(),
      stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
      createdAt: Date.now() as TimestampMs,
      updatedAt: Date.now() as TimestampMs,
      sourceTrajectoryIds: [],
      tags: [],
      scopeType,
      ...(params.userId ? { userId: params.userId } : {}),
    };

    // Store instinct row without old-style scope, then add v2 scope entry with
    // scopeType AND the owner (item 3.1): a 'user' scope row with no user_id is
    // a rule nobody owns, which every user then sees.
    this.storage.createInstinct(instinct, undefined);
    if (this.projectPath) {
      this.storage.addInstinctScopeV2(instinct.id, this.projectPath, scopeType, params.userId);
    }
    this.checkScopePromotion(instinct);
    if (this.embeddingQueue) {
      this.embeddingQueue.enqueue(instinct.id, `${instinct.triggerPattern} ${instinct.action}`);
    }
    this.enforceMaxInstincts();
    // LIVING VAULT (C): mirror high-confidence instincts as learned-heuristic notes.
    this.noteHighConfidenceInstinct(instinct);
    return instinct;
  }

  /**
   * Push a user reaction (thumbs up/down) into the stored posterior and run
   * the lifecycle state machine on the result. Stats are untouched: a
   * reaction is not an application.
   */
  private applyReactionEvidence(instinct: Instinct, positive: boolean): void {
    if (instinct.status === "permanent") {
      this.recordPermanentEvidence(instinct, positive);
      return;
    }
    const updated = this.confidenceScorer.applyEvidence(
      instinct,
      positive ? EVIDENCE_WEIGHTS.reactionUp : EVIDENCE_WEIGHTS.reactionDown,
    );
    this.updateInstinctStatus(updated);
  }

  /**
   * Push the outcome of a task an instinct merely informed (retrieved, not
   * necessarily applied) into the stored posterior. Wired from
   * InstinctRetriever.recordOutcome so the "P2 action→outcome feedback loop"
   * changes the number retrieval ranks on. (audited 2026-09-02)
   */
  recordInstinctOutcomeEvidence(instinctId: string, success: boolean): void {
    const instinct = this.storage.getInstinct(instinctId);
    if (!instinct) return;
    if (instinct.status === "permanent") {
      this.recordPermanentEvidence(instinct, success);
      return;
    }
    const updated = this.confidenceScorer.applyEvidence(
      instinct,
      success ? EVIDENCE_WEIGHTS.outcomeSuccess : EVIDENCE_WEIGHTS.outcomeFailure,
    );
    this.updateInstinctStatus(updated);
  }

  /**
   * The only thing a 'permanent' instinct is accountable for (improvement on
   * audit 04.6). Its confidence is frozen, its stats do not move, every
   * lifecycle transition skips it and its intervention tier is the highest
   * there is — so a teaching that had BECOME wrong went on being applied
   * forever, with nothing anywhere saying so.
   *
   * Consecutive negative evidence (a failed run that applied it, a thumbs-down,
   * a failed task it informed) is counted in coolingFailures — the existing
   * persisted consecutive-failure counter — and any positive evidence resets it.
   * At bayesianConfig.coolingMaxFailures (the same N the cooling path uses) the
   * instinct becomes 'quarantined': out of every retrieval path, out of the
   * intervention tiers (maxTierForLifecycle returns null for it), and REPORTED —
   * a lifecycle event, a lifecycle log row, and a warn log naming it.
   *
   * Quarantine is not deprecation: the row keeps its confidence and its history
   * so a human can see what was trusted, and why it was held.
   */
  private recordPermanentEvidence(instinct: Instinct, positive: boolean): void {
    const consecutive = instinct.coolingFailures ?? 0;

    if (positive) {
      if (consecutive === 0) return;
      this.storage.updateInstinct({
        ...instinct,
        coolingFailures: 0,
        updatedAt: Date.now() as TimestampMs,
      });
      return;
    }

    const failures = consecutive + 1;
    const threshold = Math.max(1, this.bayesianConfig.coolingMaxFailures);
    if (failures < threshold) {
      this.storage.updateInstinct({
        ...instinct,
        coolingFailures: failures,
        updatedAt: Date.now() as TimestampMs,
      });
      return;
    }

    const reason = `Quarantined: ${failures} consecutive negative outcomes on a permanent instinct (>= ${threshold})`;
    const quarantinedInstinct: Instinct = {
      ...instinct,
      status: "quarantined",
      coolingFailures: failures,
      updatedAt: Date.now() as TimestampMs,
    };
    this.storage.updateInstinct(quarantinedInstinct);
    this.emitLifecycleEvent("instinct:quarantined", quarantinedInstinct, "permanent", "quarantined", reason);
    this.writeLifecycleLogSafe(instinct, "quarantined", reason);
    try {
      getLoggerSafe().warn("instinct quarantined: a permanent teaching kept being wrong", {
        instinctId: instinct.id,
        name: instinct.name,
        consecutiveFailures: failures,
        threshold,
        confidence: instinct.confidence,
      });
    } catch {
      // Logger may not be available in test environments
    }
  }

  /** Every instinct currently held in quarantine, so a report can name them. */
  getQuarantinedInstincts(): Instinct[] {
    return this.storage.getInstincts({ status: "quarantined" });
  }

  updateInstinctStatus(instinct: Instinct): void {
    const config = this.bayesianConfig;

    // Skip permanent instincts entirely -- they are frozen
    if (instinct.status === "permanent") {
      const updatedInstinct: Instinct = {
        ...instinct,
        updatedAt: Date.now() as TimestampMs,
      };
      this.storage.updateInstinct(updatedInstinct);
      return;
    }

    const totalObs = instinct.stats.timesApplied + instinct.stats.timesFailed;
    let updatedInstinct: Instinct = { ...instinct };

    // ─── PROMOTION CHECK (before cooling -- high confidence trumps everything) ───
    if (
      instinct.confidence >= config.autoEvolveThreshold &&
      totalObs >= config.promotionMinObservations &&
      instinct.status === "active"
    ) {
      updatedInstinct = {
        ...updatedInstinct,
        status: "permanent",
        updatedAt: Date.now() as TimestampMs,
      };
      this.storage.updateInstinct(updatedInstinct);

      // Emit lifecycle event
      this.emitLifecycleEvent("instinct:promoted", updatedInstinct, instinct.status, "permanent", `Promoted to permanent: confidence=${instinct.confidence.toFixed(3)}, observations=${totalObs}`);

      // Persist lifecycle log
      this.writeLifecycleLogSafe(instinct, "permanent", `Auto-promoted: confidence ${instinct.confidence.toFixed(3)} >= ${config.autoEvolveThreshold} with ${totalObs} observations`);

      // Increment weekly counter
      this.incrementWeeklyCounterSafe("promoted");
      return;
    }

    // ─── COOLING CHECK ──────────────────────────────────────────────────────
    if (instinct.confidence < config.deprecatedThreshold && totalObs >= config.coolingMinObservations) {
      if (!instinct.coolingStartedAt) {
        // START COOLING
        updatedInstinct = {
          ...updatedInstinct,
          coolingStartedAt: Date.now() as TimestampMs,
          coolingFailures: 0,
          updatedAt: Date.now() as TimestampMs,
        };
        this.storage.updateInstinct(updatedInstinct);

        this.emitLifecycleEvent("instinct:cooling-started", updatedInstinct, instinct.status, instinct.status, `Cooling started: confidence=${instinct.confidence.toFixed(3)}, observations=${totalObs}`);
        this.writeLifecycleLogSafe(instinct, "cooling", `Cooling started: confidence ${instinct.confidence.toFixed(3)} < ${config.deprecatedThreshold} with ${totalObs} observations`);
        this.incrementWeeklyCounterSafe("cooling_started");
        return;
      } else {
        // ALREADY COOLING -- check deprecation triggers
        const daysCooling = (Date.now() - instinct.coolingStartedAt) / (1000 * 60 * 60 * 24);
        if (daysCooling >= config.coolingPeriodDays || (instinct.coolingFailures ?? 0) >= config.coolingMaxFailures) {
          const reason = daysCooling >= config.coolingPeriodDays
            ? `Cooling period expired: ${daysCooling.toFixed(1)} days >= ${config.coolingPeriodDays}`
            : `Consecutive failures: ${instinct.coolingFailures} >= ${config.coolingMaxFailures}`;

          updatedInstinct = {
            ...updatedInstinct,
            status: "deprecated",
            coolingStartedAt: undefined,
            coolingFailures: 0,
            updatedAt: Date.now() as TimestampMs,
          };
          this.storage.updateInstinct(updatedInstinct);

          this.emitLifecycleEvent("instinct:deprecated", updatedInstinct, instinct.status, "deprecated", reason);
          this.writeLifecycleLogSafe(instinct, "deprecated", reason);
          this.incrementWeeklyCounterSafe("deprecated");
          return;
        }
      }
    }

    // ─── COOLING RECOVERY CHECK ─────────────────────────────────────────────
    if (instinct.coolingStartedAt && instinct.confidence >= config.deprecatedThreshold) {
      updatedInstinct = {
        ...updatedInstinct,
        coolingStartedAt: undefined,
        coolingFailures: 0,
        updatedAt: Date.now() as TimestampMs,
      };
      this.storage.updateInstinct(updatedInstinct);
      this.incrementWeeklyCounterSafe("cooling_recovered");
      return;
    }

    // ─── EXISTING: proposed -> active promotion ─────────────────────────────
    let newStatus = instinct.status;
    if (instinct.confidence >= config.activeThreshold && instinct.status === "proposed") {
      newStatus = "active";
    }

    updatedInstinct = {
      ...updatedInstinct,
      status: newStatus,
      updatedAt: Date.now() as TimestampMs,
    };
    this.storage.updateInstinct(updatedInstinct);
  }

  // ─── Evolution ───────────────────────────────────────────────────────────────

  runEvolution(): { proposals: number; artifacts: number } {
    if (!this.config.enabled) return { proposals: 0, artifacts: 0 };

    let proposals = 0;
    let artifacts = 0;
    const candidates = this.storage.getInstincts({
      status: "active",
      minConfidence: CONFIDENCE_THRESHOLDS.EVOLUTION,
    });

    for (const instinct of candidates) {
      if (instinct.confidence > CONFIDENCE_THRESHOLDS.AUTO_EVOLVE) {
        const result = this.materializeRuntimeArtifact(instinct);
        if (result.proposalCreated) {
          proposals++;
          artifacts++;
        }
      }
    }

    return { proposals, artifacts };
  }

  materializeRuntimeArtifact(instinct: Instinct): {
    artifact: RuntimeArtifact;
    proposal: EvolutionProposal | null;
    proposalCreated: boolean;
    created: boolean;
  } {
    return this.runtimeArtifacts.materializeShadowArtifact(instinct, this.projectPath);
  }

  getRuntimeArtifactManager(): RuntimeArtifactManager {
    return this.runtimeArtifacts;
  }

  // ─── Lifecycle Helpers ───────────────────────────────────────────────────────

  /** Emit a lifecycle event on the event bus (fire-and-forget) */
  private emitLifecycleEvent(
    eventName: "instinct:cooling-started" | "instinct:deprecated" | "instinct:promoted" | "instinct:quarantined",
    instinct: Instinct,
    fromStatus: string,
    toStatus: string,
    reason: string,
  ): void {
    if (!this.eventBus) return;
    try {
      const event: InstinctLifecycleEvent = {
        instinct,
        fromStatus: fromStatus as Instinct["status"],
        toStatus: toStatus as Instinct["status"],
        reason,
        timestamp: Date.now(),
      };
      this.eventBus.emit(eventName, event);
    } catch {
      // Fire-and-forget: log and continue
    }
  }

  /** Write lifecycle log entry (fire-and-forget) */
  private writeLifecycleLogSafe(instinct: Instinct, toStatus: string, reason: string): void {
    try {
      const totalObs = instinct.stats.timesApplied + instinct.stats.timesFailed;
      this.storage.writeLifecycleLog({
        instinctId: instinct.id,
        fromStatus: instinct.status,
        toStatus: toStatus as Instinct["status"],
        reason,
        confidenceAtTransition: instinct.confidence,
        bayesianAlpha: instinct.bayesianAlpha ?? 1,
        bayesianBeta: instinct.bayesianBeta ?? 1,
        observationCount: totalObs,
        timestamp: Date.now(),
      });
    } catch {
      // Fire-and-forget: log and continue
    }
  }

  /** Increment weekly counter (fire-and-forget) */
  private incrementWeeklyCounterSafe(eventType: "promoted" | "deprecated" | "cooling_started" | "cooling_recovered"): void {
    try {
      this.storage.incrementWeeklyCounter(eventType);
    } catch {
      // Fire-and-forget: log and continue
    }
  }

  // ─── Scope Promotion (Phase 13) ──────────────────────────────────────────────

  /**
   * Check if an instinct qualifies for scope promotion to universal.
   * Fires instinct:scope_promoted event when threshold reached.
   */
  private checkScopePromotion(instinct: Instinct): void {
    if (!this.projectPath) return;

    try {
      const scopeCount = this.storage.getInstinctScopeCount(instinct.id);
      if (scopeCount >= this.promotionThreshold) {
        // Promote to universal scope
        this.storage.addInstinctScope(instinct.id, "*");

        // Emit scope promotion event
        if (this.eventBus) {
          this.eventBus.emit("instinct:scope_promoted", {
            instinct,
            projectPath: this.projectPath,
            promotedToUniversal: true,
            distinctProjectCount: scopeCount,
            timestamp: Date.now(),
          });
        }
      }
    } catch {
      // Non-blocking: promotion failure should not affect instinct creation
    }
  }

  // ─── Inline Detection ────────────────────────────────────────────────────────

  private detectPatternInline(obs: {
    toolName: string; success: boolean;
    errorDetails?: { message?: string };
  }): void {
    const windowSize = this.config?.batchSize ? this.config.batchSize * 2 : 20;

    this.recentObservations.push({
      toolName: obs.toolName,
      errorPattern: obs.errorDetails?.message
        ? this.sanitizePattern(obs.errorDetails.message) : undefined,
      timestamp: Date.now(),
    });

    if (this.recentObservations.length > windowSize) {
      this.recentObservations.splice(0, this.recentObservations.length - windowSize);
    }

    const minObs = this.config?.minObservationsBeforeLearning ?? 5;
    if (this.recentObservations.length < minObs) return;

    // Same error pattern 3+ times
    if (obs.errorDetails?.message) {
      const pattern = this.sanitizePattern(obs.errorDetails.message);
      const count = this.recentObservations.filter(o => o.errorPattern === pattern).length;
      if (count >= 3) {
        this.considerInstinctCreation({
          type: "error_pattern",
          triggerPattern: pattern,
          action: JSON.stringify({ description: 'Recurring error: ' + pattern }),
          toolName: obs.toolName,
        }).catch(() => {});
      }
    }

    // Same tool sequence 3+ times
    if (this.recentObservations.length >= 9) {
      const seqLen = 3;
      const recent = this.recentObservations.slice(-seqLen).map(o => o.toolName).join('->');
      let seqCount = 0;
      for (let i = 0; i <= this.recentObservations.length - seqLen; i++) {
        const seq = this.recentObservations.slice(i, i + seqLen).map(o => o.toolName).join('->');
        if (seq === recent) seqCount++;
      }
      if (seqCount >= 3) {
        this.considerInstinctCreation({
          type: "workflow_pattern",
          triggerPattern: recent,
          action: JSON.stringify({ description: 'Common workflow: ' + recent }),
        }).catch(() => {});
      }
    }
  }

  // ─── Periodic Trajectory Extraction ─────────────────────────────────────────

  private async runPeriodicExtraction(): Promise<void> {
    // Clean stale pending resolutions (older than 10 minutes)
    const staleThreshold = Date.now() - LearningPipeline.STALE_RESOLUTION_THRESHOLD_MS;
    for (const [key, pending] of this.pendingResolutions) {
      if (pending.timestamp < staleThreshold) {
        this.pendingResolutions.delete(key);
      }
    }

    const unprocessed = this.storage.getUnprocessedTrajectories();
    for (const trajectory of unprocessed) {
      // extractInstinctFromTrajectory -> considerInstinctCreation already persists
      await this.extractInstinctFromTrajectory(trajectory);
    }
    this.storage.markTrajectoriesProcessed(unprocessed.map(t => t.id));

    this.pruneObservations();
    this.pruneExposures();
  }

  /**
   * Retention sweep for the guidance exposure log (round 15 #15).
   *
   * `pruneInstinctExposures` existed and NOTHING called it, so the table grew for
   * ever across restarts and maintenance — and an unbounded table whose reporting
   * window is unstated eventually makes "since N days" mean something other than
   * what the reader assumes. Swept on the same periodic pass as the observations,
   * and the retained window is printed by `strada learning coverage`.
   *
   * Returns what it measured, so a caller never mistakes a no-op for a sweep.
   */
  pruneExposures(): { deleted: number; olderThanMs: number; retentionDays: number } {
    const retentionDays = this.config.exposureRetentionDays;
    const olderThanMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    try {
      deleted = this.storage.pruneInstinctExposures(olderThanMs);
    } catch {
      // A sweep that cannot run is not a reason to fail the periodic pass; the
      // next one retries, and the reported window still says what it covers.
    }
    return { deleted, olderThanMs, retentionDays };
  }

  /**
   * Retention sweep: delete processed observations older than
   * config.observationRetentionDays. Unprocessed rows are kept regardless of
   * age. Returns what was measured so callers never mistake a no-op for a
   * sweep. (audited 2026-09-02: the table had no retention path at all.)
   */
  pruneObservations(): { deleted: number; olderThanMs: number; retentionDays: number } {
    const retentionDays = this.config.observationRetentionDays;
    const olderThanMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted = this.storage.pruneProcessedObservations(olderThanMs);
    return { deleted, olderThanMs, retentionDays };
  }

  // ─── Max Instincts Enforcement ──────────────────────────────────────────────

  /**
   * Evict lowest-confidence rows until the store is within maxInstincts.
   * Order: deprecated → proposed → active. Permanent and evolved rows are never
   * evicted, so the cap can be unenforceable; the returned counts and the
   * warning say so instead of returning silently.
   *
   * audited 2026-09-02: there was no 'proposed' pass, yet every pipeline-created
   * instinct is proposed at 0.5 and most never leave that status. In a
   * proposed-dominated store the cap deleted the few reinforced ACTIVE rows
   * first, freed nothing else, and returned without a word.
   */
  async enforceMaxInstincts(): Promise<{ evicted: number; remainingOverCap: number }> {
    const maxInstincts = this.config?.maxInstincts ?? 1000;
    const count = this.storage.countInstincts();
    if (count <= maxInstincts) return { evicted: 0, remainingOverCap: 0 };
    const overflow = count - maxInstincts;

    let remaining = overflow;
    const evictedByStatus: Record<string, number> = {};
    for (const status of ["deprecated", "proposed", "active"] as const) {
      if (remaining <= 0) break;
      const before = this.storage.countInstincts();
      this.storage.deleteLowestConfidenceInstincts(status, remaining);
      const deleted = before - this.storage.countInstincts();
      if (deleted > 0) evictedByStatus[status] = deleted;
      remaining -= deleted;
    }

    const evicted = overflow - remaining;
    if (remaining > 0) {
      try {
        getLoggerSafe().warn("maxInstincts cap could not be enforced: only permanent/evolved rows remain over the cap", {
          maxInstincts,
          countBefore: count,
          evicted,
          evictedByStatus,
          remainingOverCap: remaining,
        });
      } catch {
        // Logger may not be available in test environments
      }
    }
    return { evicted, remainingOverCap: remaining };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private recordErrorPattern(errorDetails: ErrorDetails, _toolName?: string): void {
    const pattern: ErrorPattern = {
      id: `error_${randomUUID()}` as ErrorPatternId,
      name: `${errorDetails.category} pattern`,
      category: errorDetails.category,
      codePattern: errorDetails.code,
      messagePattern: this.sanitizePattern(errorDetails.message),
      filePatterns: errorDetails.file ? [errorDetails.file] : [],
      occurrenceCount: 1,
      firstSeen: Date.now() as TimestampMs,
      lastSeen: Date.now() as TimestampMs,
      isActive: true,
    };

    this.storage.upsertErrorPattern(pattern);
  }

  private async processObservation(obs: Observation): Promise<boolean> {
    switch (obs.type) {
      case "error":
        if (obs.errorDetails) this.recordErrorPattern(obs.errorDetails, obs.toolName);
        return true;
      case "correction":
        if (obs.correction) {
          await this.considerInstinctCreation({
            type: "correction",
            triggerPattern: this.extractTriggerPattern(obs.output ?? ""),
            action: obs.correction,
            toolName: obs.toolName,
          });
        }
        return true;
      default:
        return false;
    }
  }

  private async extractInstinctFromTrajectory(trajectory: Trajectory): Promise<Instinct | null> {
    if (!trajectory.outcome.success) return null;

    // Find error→fix patterns
    for (let i = 0; i < trajectory.steps.length - 1; i++) {
      const step = trajectory.steps[i]!;
      const nextStep = trajectory.steps[i + 1]!;

      // Check if step result is error and next step is success
      const isError = step.result.kind === "error";
      const isNextSuccess = nextStep.result.kind === "success";

      if (isError && isNextSuccess) {
        const errorResult = step.result;
        return await this.considerInstinctCreation({
          type: "error_fix",
          triggerPattern: errorResult.error.message,
          action: this.stepToAction(nextStep),
          toolName: step.toolName,
          contextConditions: [
                { id: `ctx_${randomUUID()}` as ContextConditionId, type: "error_code", value: errorResult.error.code ?? "unknown", match: "include" },
            { id: `ctx_${randomUUID()}` as ContextConditionId, type: "tool_name", value: step.toolName, match: "include" },
          ],
        }) ?? null;
      }
    }

    return null;
  }

  private updateInstinctsFromVerdict(trajectoryId: string, score: number): void {
    const trajectory = this.storage.getTrajectory(trajectoryId);
    if (!trajectory) return;

    for (const instinctId of trajectory.appliedInstinctIds) {
      const instinct = this.storage.getInstinct(instinctId);
      if (!instinct) continue;

      const updatedInstinct = this.confidenceScorer.updateConfidence(instinct, score >= VERDICT_SCORE.HIGH, score);
      this.storage.updateInstinct(updatedInstinct);
    }
  }

  private stepToAction(step: TrajectoryStep): string {
    const result = step.result;
    const output = result.kind === "success" ? result.output : "";
    return JSON.stringify({ tool: step.toolName, input: step.input, output });
  }

  private extractTriggerPattern(output: string): string {
    // Whole-word signals only, with line-number/pipe prefixes stripped: the
    // old substring test passed JSON metrics ('"compileErrors": 0') and code
    // listings ('  41 | ... ArgumentNullException...') as "error lines" —
    // measured 2026-08-30: 75 instincts created, every trigger a raw output
    // fragment no future task could match and no reader could learn from.
    const relevantLines = output
      .split("\n")
      .map((l) => l.replace(/^\s*\d+\s*\|\s?/, "").trim())
      .filter((l) => /\b(error|failed|exception|cannot|missing|invalid)\b/i.test(l))
      .filter((l) => !/^"[\w.]+"\s*:/.test(l) && !/^[\w.]+\s*:\s*\d+\s*,?\s*$/.test(l));
    return [...new Set(relevantLines)].join(" ").slice(0, 500);
  }

  /**
   * A trigger worth remembering names a CONDITION, not a fragment of output.
   * Gate applied at creation so the instinct store holds knowledge, not noise.
   */
  private isMeaningfulTrigger(trigger: string): boolean {
    const s = trigger.trim();
    if (s.length < 12) return false;
    // JSON metric fragment: quoted key, or a bare numeric metric line —
    // narrow on purpose so error codes ("CS1061: 'Board'…") stay eligible.
    if (/^"[\w.]+"\s*:/.test(s)) return false;
    if (/^[\w.]+\s*:\s*\d+\s*,?\s*$/.test(s)) return false;
    if (/^\s*\d+\s*\|/.test(s)) return false; // code-listing line
    const letters = (s.match(/[a-zA-Z]/g) ?? []).length;
    return letters / s.length >= 0.5;
  }

  /**
   * A resolution may only be attributed to the RUN that produced the error (#13).
   * Keyed on the session alone, a sibling run's success on the same file was
   * booked as the repair of this run's failure — an error_fix instinct nothing
   * was ever observed to fix.
   */
  private static resolutionKey(sessionId: string, toolName: string, runId?: string): string {
    return `${LearningPipeline.runCreditKey(sessionId, runId)}:${toolName}`;
  }

  /**
   * Automatically record a resolution when a tool succeeds after a prior failure.
   * Creates a correction observation and considers instinct creation from the pattern.
   */
  private async recordAutoResolution(
    errorObs: Observation,
    successObs: Observation,
    toolName: string,
    target: RepairTarget | null,
  ): Promise<void> {
    const correction = `Auto-resolved: ${toolName} failed with "${(errorObs.output ?? '').slice(0, 100)}" then succeeded with "${(successObs.output ?? '').slice(0, 100)}"`;

    const resolutionObs: Observation = {
      id: `obs_${randomUUID()}` as ObservationId,
      type: "correction",
      sessionId: successObs.sessionId,
      toolName: successObs.toolName,
      input: successObs.input,
      output: successObs.output,
      correction,
      timestamp: Date.now() as TimestampMs,
      // audited 2026-09-02: the error->fix instinct is considered inline below;
      // an unmarked row was replayed by the startup drain into a junk
      // "Auto-resolved: ..." instinct keyed on the SUCCESS output.
      processed: true,
    };

    this.storage.recordObservation(resolutionObs);
    this.storage.flush();

    // Consider creating an instinct from this error→resolution pattern
    const errorPattern = this.extractTriggerPattern(errorObs.output ?? '');
    if (errorPattern) {
      // D39 (audit 04.2a): this read input.content when there was no command —
      // so for file_write the learned "solution" was the ENTIRE FILE BODY, a
      // blob no future task could act on (and a leak of whatever the file held).
      // The action now describes the OPERATION that repaired the failure; a file
      // body is never an instruction.
      const rawAction = target?.kind === "command"
        ? `re-run \`${target.value.slice(0, 200)}\``
        : target?.kind === "path"
          ? `re-run ${toolName} on ${target.value.slice(0, 200)} once the cause is removed`
          : "retry with corrected input";
      await this.considerInstinctCreation({
        type: "error_fix" as InstinctType,
        triggerPattern: errorPattern,
        action: `When ${toolName} fails with this pattern, the resolution was to ${sanitizePromptInjection(rawAction.slice(0, 300))}`,
        toolName,
      });
    }
  }

  private sanitizePattern(message: string): string {
    return message
      .replace(/'[^']+'/g, "'%NAME%'")
      .replace(/"[^"]+"/g, '"%NAME%"')
      .replace(/\d+/g, "%NUM%")
      .slice(0, 500);
  }

  private generateInstinctName(params: { type: InstinctType; toolName?: string }): string {
    const prefix = params.type.replace("_", "-");
    const tool = params.toolName ?? "general";
    return `${prefix}:${tool}:${Date.now()}`;
  }

  private generateContextConditions(toolName?: ToolName): ContextCondition[] {
    return toolName ? [{ id: `ctx_${randomUUID()}` as ContextConditionId, type: "tool_name", value: toolName, match: "include" }] : [];
  }

  private calculateInitialConfidence(params: { type: InstinctType; triggerPattern: string; action: string }): number {
    let confidence = 0.5;

    if (params.type === "error_fix") confidence += 0.1;
    if (params.type === "correction") confidence += 0.15;
    if (params.triggerPattern.length > 50) confidence += 0.1;
    if (params.action.length > 20) confidence += 0.05;

    return Math.min(confidence, CONFIDENCE_THRESHOLDS.MAX_INITIAL);
  }

  private autoGenerateVerdict(trajectory: Trajectory): void {
    const dimensions: VerdictDimensions = {
      efficiency: trajectory.outcome.totalSteps < 5 ? 0.9 : 0.7,
      correctness: VERDICT_SCORE.PERFECT,
      quality: 0.8,
      bestPractices: 0.8,
    };

    const score = Object.values(dimensions).reduce((a, b) => a + b, 0) / 4;

    this.submitVerdict({
      trajectoryId: trajectory.id,
      judgeType: "automated",
      score,
      dimensions,
      feedback: "Auto-generated verdict for clean successful trajectory",
    });

    // LIVING VAULT (C): mirror the clean-success trajectory as a durable note.
    this.noteCleanSuccessVerdict(trajectory, score);
  }

  // ─── Feedback Methods ────────────────────────────────────────────────────────

  /**
   * Store an explicit user teaching as a new instinct.
   */
  async teachExplicit(content: string, scopeType: ScopeType, userId?: string): Promise<string> {
    const instinct = this.createInstinct({
      name: `teaching:explicit:${Date.now()}`,
      type: 'user_teaching',
      status: 'active',
      confidence: 0.7,
      triggerPattern: this.sanitizePattern(content),
      // Rendered into system prompts: keep a bounded summary, not whatever
      // length the message had.
      action: capLearnedText(content),
      contextConditions: [],
      scopeType,
      // item 3.1 (audit 04.4 / D42): the teacher's identity used to stop here
      // (`_userId`), so a rule taught by one person was stored unowned and
      // handed to everybody working on the project.
      userId,
    });
    return instinct.id;
  }

  /**
   * Record a user correction and consider creating an instinct from it.
   */
  async recordCorrection(record: CorrectionRecord): Promise<void> {
    // The correction becomes an instinct action rendered into prompts, so it is
    // stored as a bounded summary; a whole pasted message is not a correction.
    const params: CorrectionRecord = {
      ...record,
      original: capLearnedText(record.original),
      corrected: capLearnedText(record.corrected),
    };
    // Source-specific confidence: direct user feedback scores higher
    const sourceBoost: Record<string, number> = {
      button: 0.15,
      reaction: 0.1,
      natural_language: 0.05,
      file_heuristic: 0.0,
    };
    const confidence = this.calculateInitialConfidence({
      type: 'correction',
      triggerPattern: this.sanitizePattern(params.corrected),
      action: params.corrected,
    }) + (sourceBoost[params.source] ?? 0);

    // audit 04.cap: the correction is RECORDED as feedback as well as learned
    // from — considerInstinctCreation refuses an unmeaningful trigger, and then
    // the feedback row is the only trace of what the user corrected.
    this.feedbackHandler.handleCorrection(params);
    await this.considerInstinctCreation({
      type: 'correction',
      triggerPattern: this.sanitizePattern(params.corrected),
      action: params.corrected,
      scopeType: 'user',
      // item 3.1: a correction is scoped to the person who made it; without the
      // id the 'user' scope row is unowned and reaches every user.
      userId: params.userId,
      confidence: Math.min(confidence, CONFIDENCE_THRESHOLDS.MAX_INITIAL),
    });
  }

  // ─── Public Getters ──────────────────────────────────────────────────────────

  getStats() {
    return this.storage.getStats();
  }

  /**
   * Issue #22 (SIBLING A) — whether trajectory-level instinct credit is enabled (default OFF).
   * Reserved seam for a future in-run trigger to gate its instinct-set capture on, so flag-off
   * does zero extra work and stays byte-identical. No production caller today (the route-level
   * wiring was removed as structurally unable to supply the run's real instinct set).
   */
  isTrajectoryLevelCreditEnabled(): boolean {
    return this.config.trajectoryLevelCredit === true;
  }

  // ─── LIVING VAULT (C): learning↔vault bridge ──────────────────────────────

  /**
   * Inject the dev-knowledge note-writer (bootstrap wires it after the vault is
   * registered). Interface-only dependency — no src/learning -> src/vault
   * runtime import. Idempotent; passing undefined detaches the bridge.
   */
  setNoteWriter(
    writer: import("../../vault/dev-knowledge-writer.js").DevKnowledgeNoteWriter | undefined,
  ): void {
    this.noteWriter = writer;
  }

  /**
   * Fire-and-forget bridge write. Best-effort, per-id deduped, never throws onto
   * the caller's path. No-op when no writer is wired.
   */
  private writeKnowledgeNote(dedupId: string, relPath: string, content: string): void {
    const writer = this.noteWriter;
    if (!writer) return;
    if (this.notedIds.has(dedupId)) return;
    this.notedIds.add(dedupId);
    void writer.writeNote(relPath, content).catch(() => {
      // Best-effort: the writer already swallows+logs; this catch is a final guard.
    });
  }

  /**
   * Mirror a newly created high-confidence instinct as a durable "learned
   * heuristic" note. Low-volume (creation is rare); deduped by instinctId.
   */
  private noteHighConfidenceInstinct(instinct: Instinct): void {
    if (!this.noteWriter) return;
    const ACTIVE_THRESHOLD = this.bayesianConfig.activeThreshold;
    if (instinct.confidence < ACTIVE_THRESHOLD) return;
    const trigger = sanitizePromptInjection(instinct.triggerPattern.slice(0, 500));
    const action = sanitizePromptInjection(instinct.action.slice(0, 500));
    const content = [
      '---',
      `title: "${instinct.name.replace(/["\n]/g, ' ').trim()}"`,
      `date: ${new Date().toISOString()}`,
      `instinctId: ${instinct.id}`,
      `confidence: ${instinct.confidence.toFixed(2)}`,
      `type: ${instinct.type}`,
      '---',
      '',
      '## Learned Heuristic',
      `When: ${trigger}`,
      '',
      `Do: ${action}`,
      '',
      `Confidence: ${instinct.confidence.toFixed(2)} (${instinct.status})`,
      '',
    ].join('\n');
    this.writeKnowledgeNote(
      `instinct:${instinct.id}`,
      `knowledge/instincts/${instinct.id}.md`,
      content,
    );
  }

  /**
   * Mirror a clean-success trajectory verdict as a human-readable note.
   * Gated upstream (only clean, error-free successes reach autoGenerateVerdict);
   * deduped by trajectoryId.
   */
  private noteCleanSuccessVerdict(trajectory: Trajectory, score: number): void {
    if (!this.noteWriter) return;
    const desc = sanitizePromptInjection((trajectory.taskDescription ?? '').slice(0, 500));
    const content = [
      '---',
      `title: "${desc.replace(/["\n]/g, ' ').slice(0, 80).trim() || 'Clean success'}"`,
      `date: ${new Date().toISOString()}`,
      `trajectoryId: ${trajectory.id}`,
      `score: ${score.toFixed(2)}`,
      '---',
      '',
      '## Verified Clean Success',
      desc || '(no description)',
      '',
      `Steps: ${trajectory.outcome.totalSteps}; score=${score.toFixed(2)}`,
      '',
      '## Key Learning',
      'Approach that worked — verified clean success (no errors, no retries).',
      '',
    ].join('\n');
    this.writeKnowledgeNote(
      `verdict:${trajectory.id}`,
      `knowledge/verdicts/${trajectory.id}.md`,
      content,
    );
  }
}
