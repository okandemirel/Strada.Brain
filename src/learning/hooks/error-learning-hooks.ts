/**
 * Error Learning Hooks
 * 
 * Integration hooks that connect the error recovery system with the
 * learning pipeline. Provides callbacks for error analysis and resolution.
 */

import type { LearningPipeline } from "../pipeline/learning-pipeline.js";
import type { PatternMatcher } from "../matching/pattern-matcher.js";
import type { ConfidenceScorer } from "../scoring/confidence-scorer.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { 
  PatternMatch,
  PatternMatchInput,
  ErrorDetails,
  ErrorCategory,
  ContextConditionId,
} from "../types.js";
import { createBrand, type JsonObject } from "../../types/index.js";

// ErrorAnalysis interface is defined locally (not in learning/types.ts)
interface ErrorAnalysis {
  hasErrors: boolean;
  errorCount: number;
  summary: string;
  recoveryInjection: string;
  learnedSolutions?: string;
}

// ─── Hook Context ───────────────────────────────────────────────────────────────

export interface ErrorContext {
  /** Tool that generated the error */
  toolName: string;
  /** Raw error output */
  errorOutput: string;
  /** Structured error analysis */
  analysis: ErrorAnalysis;
  /** Session/task identifier */
  sessionId: string;
  /** Timestamp of error */
  timestamp: Date;
  /** File being processed (if known) */
  filePath?: string;
  /** Additional context */
  metadata?: Record<string, unknown>;
}

export interface ResolutionContext {
  /** Original error context */
  errorContext: ErrorContext;
  /** Resolution action taken */
  action: string;
  /** Whether the resolution was successful */
  success: boolean;
  /** Tool used for resolution */
  resolutionTool?: string;
  /** Time taken to resolve (ms) */
  resolutionTimeMs?: number;
  /** Number of attempts before success */
  attempts?: number;
  /**
   * ROUND 13 #24 — WHICH GUIDANCE THE RUN ACTUALLY USED, reported by whoever ran
   * the repair. This is the only thing a misfire penalty may be built from.
   *
   *   - a list of ids: those were applied, and every OTHER rule the run was shown
   *     is a demonstrated trigger misfire;
   *   - `[]`: "none of what I was shown" — also a report, also demonstrated;
   *   - `undefined`: nobody said. NOT evidence. A resolution whose wording differs
   *     from the rule's action is indistinguishable from one that ignored it, so
   *     the exposure is left unjudged and counted
   *     ({@link ErrorLearningHooks.getStats}) rather than guessed at.
   */
  appliedInstinctIds?: readonly string[];
  /** Which run resolved it (#13/#25): the ledger's dedup key is run-scoped. */
  taskRunId?: string;
  /**
   * The id {@link ErrorLearningHooks.onBeforeErrorAnalysis} returned for this
   * error (round 13 #26). Without it the id is recomputed from a reconstructed
   * timestamp, which is a different id, and the resolution correlates with
   * nothing the run was shown.
   */
  correlationId?: string;
  /**
   * `reported` (default) — a caller describing the repair it made.
   * `observed-success` — something merely SAW the failure stop happening. There is
   * no resolution text in that case, so nothing may be minted from it: neither a
   * new instinct nor a correction observation, both of which would take a tool's
   * own output as a learned repair (round 13 #26).
   */
  derivation?: "reported" | "observed-success";
}

/**
 * Negative weight of ONE non-application (guidance shown, not used).
 *
 * A real failed application adds ~0.8 to beta; this is a third of that, so a
 * rule needs several cost-only misfires before its confidence drops under the
 * recovery gate, and a single coincidence never silences a good rule
 * (tightening a gate cuts both ways).
 */
export const NON_APPLICATION_BETA = 0.25;

/** What the run used, and whether "the rest misfired" is a fact (round 13 #24). */
interface ApplicationEvidence {
  /** Ids the run demonstrably applied. */
  readonly applied: readonly string[];
  /**
   * True when something SAID what was used, so a rule shown and absent from
   * `applied` is a demonstrated trigger misfire. False = nobody said, and no
   * penalty may be derived from that.
   */
  readonly demonstrated: boolean;
}

/**
 * Statuses a rule can be recognized as APPLIED in (#24).
 *
 * `evolved` and `permanent` were excluded, so the rules that had earned their
 * place could never be found as the one a run used — and were penalised for the
 * runs that used them. `quarantined` and `retired` stay out: a rule nobody should
 * be shown cannot be the rule a run applied.
 */
const MATCHABLE_STATUSES = new Set(["active", "proposed", "evolved", "permanent", "cooling"]);

/**
 * Shortest action text an identity match may be built from. A two-word action
 * ("Rebuild") is a substring of half the resolutions ever written, and matching on
 * it would attribute an application to whichever rule happened to be terse.
 */
const MIN_ACTION_MATCH_CHARS = 12;

/** Compare actions as MEANING-BEARING text, not as raw strings. */
function normalizeAction(action: string): string {
  return String(action ?? "")
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!,;:]+$/g, "")
    .trim();
}

// ─── Error Learning Hooks ───────────────────────────────────────────────────────

export class ErrorLearningHooks {
  private pipeline: LearningPipeline;
  private patternMatcher: PatternMatcher;
  private confidenceScorer: ConfidenceScorer;
  private storage: LearningStorage;
  private enabled = false;

  /** Track active errors for resolution correlation */
  private activeErrors = new Map<string, ErrorContext>();

  /**
   * WHAT WAS SHOWN, per active error, and when. A run repaired some other way
   * used to leave the guidance it was shown completely unmeasured: the 6.3
   * ablation measured a recall on a look-alike trigger costing an attempt and
   * leaving no negative evidence at all, so the same misfire repeats for ever
   * and findSuspectGuidance cannot see it. A non-application is weak evidence
   * against the rule's TRIGGER — not a failure of its action.
   */
  private shownGuidance = new Map<string, { instinctIds: string[]; shownAt: number }>();

  /**
   * Exposures nothing could judge (round 13 #24): the run was shown guidance and
   * never said what it used. NOT MEASURED has to be visible — a silent zero here
   * reads as "no misfires", which is the false green this counter exists to stop.
   */
  private unjudgedExposures = 0;

  constructor(
    pipeline: LearningPipeline,
    patternMatcher: PatternMatcher,
    confidenceScorer: ConfidenceScorer,
    storage: LearningStorage
  ) {
    this.pipeline = pipeline;
    this.patternMatcher = patternMatcher;
    this.confidenceScorer = confidenceScorer;
    this.storage = storage;
  }

  /** Enable learning hooks */
  enable(): void {
    this.enabled = true;
  }

  /** Disable learning hooks */
  disable(): void {
    this.enabled = false;
  }

  /** Check if hooks are enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  // ─── Pre-Error Analysis Hook ─────────────────────────────────────────────────

  /**
   * Called before error analysis to suggest learned solutions
   * 
   * @param context - Error context
   * @returns Suggested instincts that might help, or null
   */
  onBeforeErrorAnalysis(context: ErrorContext): {
    suggestions: PatternMatch[];
    recoveryInjection: string;
    /**
     * The id this exposure is tracked under (round 13 #26). Pass it back as
     * {@link ResolutionContext.correlationId}: recomputing it from a fresh
     * `Date` produces a DIFFERENT id, which is why every production resolution
     * took the untracked branch and no exposure was ever judged.
     */
    correlationId: string;
  } {
    if (!this.enabled) {
      return { suggestions: [], recoveryInjection: "", correlationId: "" };
    }

    // Find matching instincts
    const input: PatternMatchInput = {
      errorCode: this.extractErrorCode(context.errorOutput),
      errorMessage: context.errorOutput,
      errorCategory: this.inferErrorCategory(context.analysis) as ErrorCategory | undefined,
      filePath: context.filePath,
      toolName: context.toolName ? createBrand(context.toolName, "ToolName" as const) : undefined,
      context: context.metadata as JsonObject | undefined,
    };

    const matches = this.patternMatcher.findInstinctsForError(input, {
      minConfidence: 0.5,
      maxResults: 3,
      // ROUND 13 #24 — A RULE THAT GRADUATED WAS NEVER OFFERED AGAIN. The default
      // filter is ["active", "proposed"], so `evolved` (a rule that earned its
      // way up) and `permanent` (one the user made permanent) were excluded from
      // error recovery altogether while a merely `proposed` rule was included.
      // The best guidance in the store was the guidance nobody ever saw.
      statusFilter: ["active", "proposed", "evolved", "permanent"],
    });

    // Build recovery injection
    const recoveryInjection = this.buildRecoveryInjection(matches, context);

    // Store error for later correlation with resolution
    const errorId = this.generateErrorId(context);
    this.activeErrors.set(errorId, context);
    // Only guidance that actually reached the prompt counts as shown.
    if (recoveryInjection.length > 0 && matches.length > 0) {
      const shown = {
        instinctIds: matches.map((m) => String(m.instinct?.id ?? "")).filter((id) => id.length > 0),
        shownAt: Date.now(),
      };
      this.shownGuidance.set(errorId, shown);
      // ROUND 12 #9: the SAME moment reaches the credit ledger's exposure column
      // for this run's tool events. Without it that column was filled with the
      // time the serial queue reached the event, and a rule retired in between
      // read as "applied after it was retired". One notion of "when it was
      // shown", not two.
      this.pipeline.noteGuidanceShown({
        sessionId: String(context.sessionId ?? ""),
        instinctIds: shown.instinctIds,
        shownAt: shown.shownAt,
      });
    }

    return { suggestions: matches, recoveryInjection, correlationId: errorId };
  }

  // ─── Post-Resolution Hook ────────────────────────────────────────────────────

  /**
   * Called after an error has been resolved
   * Updates instinct confidence and records the trajectory
   * 
   * @param resolution - Resolution context
   */
  async onAfterErrorResolution(resolution: ResolutionContext): Promise<void> {
    if (!this.enabled) return;

    // ROUND 13 #26: the id the exposure was tracked under, when the caller
    // carries it. Recomputing it from `resolution.errorContext` hashes a
    // timestamp, and a resolution built a millisecond later hashes to a different
    // id — which is why production always took the untracked branch below.
    const errorId = resolution.correlationId?.trim() || this.generateErrorId(resolution.errorContext);

    // Check if we have a matching active error
    if (!this.activeErrors.has(errorId)) {
      // Error wasn't tracked, but we can still learn from it
      await this.learnFromUntrackedResolution(resolution);
      return;
    }

    // Remove from active errors
    this.activeErrors.delete(errorId);

    // Update learning based on resolution success
    const evidence = this.applicationEvidence(resolution);
    const applied = evidence.applied[0] === undefined ? null : { id: evidence.applied[0] };
    if (resolution.success) {
      await this.handleSuccessfulResolution(resolution, applied);
    } else {
      this.handleFailedResolution(resolution, applied);
    }

    // EVERY OTHER RULE THIS RUN WAS SHOWN cost it an attempt and taught
    // nobody anything — but only where that is a FACT and not a wording
    // difference (round 13 #24).
    this.recordNonApplications(errorId, resolution, evidence);

    // Record observation
    await this.recordResolutionObservation(resolution);
  }

  // ─── Instinct Reinforcement ──────────────────────────────────────────────────

  /**
   * Reinforce an instinct after successful application
   * 
   * @param instinctId - ID of the instinct to reinforce
   * @param context - Context of successful application
   */
  reinforceInstinct(instinctId: string, context: {
    errorContext: ErrorContext;
    success: boolean;
    verdictScore?: number;
  }): void {
    if (!this.enabled) return;

    const instinct = this.storage.getInstinct(instinctId);
    if (!instinct) return;

    const updatedInstinct = this.confidenceScorer.updateConfidence(instinct, context.success, context.verdictScore);
    this.storage.updateInstinct(updatedInstinct);

    // Update status if needed
    this.updateInstinctStatus(updatedInstinct);
  }

  /**
   * Penalize an instinct after failed application
   * 
   * @param instinctId - ID of the instinct to penalize
   * @param context - Context of failed application
   */
  penalizeInstinct(instinctId: string, context: {
    errorContext: ErrorContext;
    reason: string;
  }): void {
    if (!this.enabled) return;

    const instinct = this.storage.getInstinct(instinctId);
    if (!instinct) return;

    const updatedInstinct = this.confidenceScorer.updateConfidence(instinct, false, 0.2);
    this.storage.updateInstinct(updatedInstinct);

    // Update status if needed
    this.updateInstinctStatus(updatedInstinct);

    // Record the failure for pattern analysis
    this.pipeline.observeToolUse({
      sessionId: context.errorContext.sessionId,
      toolName: context.errorContext.toolName,
      input: { instinctId, action: instinct.action },
      output: context.reason,
      success: false,
      errorDetails: {
        category: "unknown" as ErrorCategory,
        message: context.reason,
      },
    });
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  private async handleSuccessfulResolution(
    resolution: ResolutionContext,
    appliedInstinct: { id: string } | null,
  ): Promise<void> {

    if (appliedInstinct) {
      // Reinforce the applied instinct
      this.reinforceInstinct(appliedInstinct.id, {
        errorContext: resolution.errorContext,
        success: true,
        verdictScore: 0.9, // High score for successful resolution
      });
    } else if (this.describesARepair(resolution)) {
      // No instinct was applied - consider creating one from this successful resolution
      await this.considerInstinctFromResolution(resolution);
    }
  }

  /**
   * Is there a described repair here to learn FROM?
   *
   * An `observed-success` report (round 13 #26) says only "the failure stopped
   * happening"; its action text is empty by construction. Minting a rule — or a
   * correction observation — from that would put a tool's own output in the store
   * as a learned repair.
   */
  private describesARepair(resolution: ResolutionContext): boolean {
    return resolution.derivation !== "observed-success" && resolution.action.trim().length > 0;
  }

  private handleFailedResolution(
    resolution: ResolutionContext,
    appliedInstinct: { id: string } | null,
  ): void {
    if (appliedInstinct) {
      this.penalizeInstinct(appliedInstinct.id, {
        errorContext: resolution.errorContext,
        reason: resolution.action,
      });
    }
  }

  /**
   * Weak evidence against every rule this run was SHOWN and did not use.
   *
   * A cost-only misfire — guidance recalled on a look-alike trigger, noticed
   * to be irrelevant and discarded — used to leave nothing behind at all: no
   * credit row, no confidence movement, nothing findSuspectGuidance could
   * rank. So it kept being recalled, at one wasted attempt every time (6.3's
   * measured harmful-recall rate).
   *
   * It is deliberately NOT a failure: the rule's action was never tried, so
   * `timesFailed` does not move and one non-application cannot retire a rule.
   * Only the posterior shifts, by a fraction of a real negative.
   */
  private recordNonApplications(
    errorId: string,
    resolution: ResolutionContext,
    evidence: ApplicationEvidence,
  ): void {
    const shown = this.shownGuidance.get(errorId);
    this.shownGuidance.delete(errorId);
    if (!shown || shown.instinctIds.length === 0) return;

    // ROUND 13 #24 / ROUND 14 #14 — NO EXPLICIT, COMPLETE REPORT, NO PENALTY.
    // Neither the absence of a text match nor the presence of one is evidence:
    // "Compile the referenced dependency before rebuilding" and "Build the
    // dependency project first" are the same remedy in different words, and a
    // resolution that names TWO rules' actions used both. Either way, penalising a
    // rule for the words around it takes a CORRECT rule under the recovery gate
    // and stops it being recalled at all — the gate tightened until learning went
    // dark. Only {@link applicationEvidence}'s report branch sets `demonstrated`;
    // everything else is an unjudged exposure, counted and named, never guessed at.
    if (!evidence.demonstrated) {
      this.unjudgedExposures += 1;
      return;
    }

    const applied = new Set(evidence.applied);
    for (const instinctId of shown.instinctIds) {
      if (applied.has(instinctId)) continue;
      // One ledger (round 13 #25): the pipeline holds the run's credit, so it is
      // the only writer that can tell a non-application from a settlement and
      // keep one exposure to one row.
      this.pipeline.noteGuidanceNotApplied({
        sessionId: String(resolution.errorContext.sessionId ?? ""),
        ...(resolution.taskRunId ? { taskRunId: resolution.taskRunId } : {}),
        instinctId,
        exposedAt: shown.shownAt,
        betaDelta: NON_APPLICATION_BETA,
      });
    }
  }

  /**
   * WHAT THE RUN USED, and whether "everything else misfired" is a fact.
   *
   * Two sources, and only the first can create a penalty:
   *
   *   1. the caller's own report ({@link ResolutionContext.appliedInstinctIds}),
   *      including an empty one ("none of what I was shown"). Demonstrated.
   *   2. a resolution whose text IS a rule's action. That identifies the rule the
   *      run used, which makes the others demonstrated misfires — but the absence
   *      of such a match proves nothing at all, so it never creates a penalty.
   *
   * Candidates are no longer limited to `status: "active"` (#24): an `evolved` or
   * `permanent` rule — a rule that earned its place — could never be found as
   * applied, so it was penalised on every run that applied it.
   */
  private applicationEvidence(resolution: ResolutionContext): ApplicationEvidence {
    if (resolution.appliedInstinctIds !== undefined) {
      const reported = resolution.appliedInstinctIds.map((id) => String(id).trim()).filter((id) => id.length > 0);
      // COMPLETE means every id in it can be checked against what was shown. An
      // id the store does not know breaks that: the rule it names may be one of
      // the shown rules under another identity, so "everything else misfired" is
      // no longer a fact about this report (round 14 #14).
      const unknown = reported.filter((id) => this.storage.getInstinct(id) === null);
      if (unknown.length > 0) {
        return { applied: reported.filter((id) => !unknown.includes(id)), demonstrated: false };
      }
      return { applied: reported, demonstrated: true };
    }
    // ROUND 14 #14 — A TEXT MATCH IDENTIFIES A RULE TO REINFORCE AND NOTHING ELSE.
    // It used to return `demonstrated: true`, which made every OTHER shown rule a
    // misfire on the strength of one substring hit: report a resolution that names
    // TWO rules' actions — both used — and the first match won while the second was
    // penalised for its wording. That is the same defect as #24, one layer down,
    // and the third time it has been caught. Matching is a guess about what was
    // used; only a report is knowledge. So `demonstrated` stays FALSE here,
    // whatever the text says, and the exposure is counted as unjudged.
    const action = normalizeAction(resolution.action);
    if (action.length >= MIN_ACTION_MATCH_CHARS) {
      for (const instinct of this.storage.getInstincts()) {
        if (!MATCHABLE_STATUSES.has(instinct.status)) continue;
        const candidate = normalizeAction(instinct.action);
        if (candidate.length < MIN_ACTION_MATCH_CHARS) continue;
        if (action.includes(candidate) || candidate.includes(action)) {
          return { applied: [instinct.id], demonstrated: false };
        }
      }
    }
    return { applied: [], demonstrated: false };
  }

  private async considerInstinctFromResolution(resolution: ResolutionContext): Promise<void> {
    // Extract error pattern
    const errorDetails: ErrorDetails = {
      category: this.inferErrorCategory(resolution.errorContext.analysis) ?? "unknown",
      message: resolution.errorContext.errorOutput.slice(0, 500),
      code: this.extractErrorCode(resolution.errorContext.errorOutput),
      file: resolution.errorContext.filePath,
    };

    // Create instinct via pipeline
    await this.pipeline.considerInstinctCreation({
      type: "error_fix",
      triggerPattern: errorDetails.message,
      action: resolution.action,
      toolName: resolution.errorContext.toolName,
      contextConditions: [
        { id: `ctx_${crypto.randomUUID()}` as ContextConditionId, type: "error_code", value: errorDetails.code ?? "unknown", match: "include" },
        { id: `ctx_${crypto.randomUUID()}` as ContextConditionId, type: "tool_name", value: resolution.errorContext.toolName, match: "include" },
      ],
    });
  }

  private async learnFromUntrackedResolution(resolution: ResolutionContext): Promise<void> {
    // Still record as observation even if we didn't track the original error
    await this.recordResolutionObservation(resolution);
  }

  private async recordResolutionObservation(resolution: ResolutionContext): Promise<void> {
    if (resolution.success && this.describesARepair(resolution)) {
      await this.pipeline.observeCorrection({
        sessionId: resolution.errorContext.sessionId,
        toolName: resolution.errorContext.toolName,
        originalInput: { error: resolution.errorContext.errorOutput },
        originalOutput: resolution.errorContext.errorOutput,
        correctedOutput: resolution.action,
        correction: resolution.action,
      });
    }
  }

  private updateInstinctStatus(instinct: import("../types.js").Instinct): void {
    // A frozen lifecycle state is not a function of confidence (improvement on
    // audit 04.6): getStatus() would return a quarantined instinct to service
    // and demote a permanent one to 'evolved' — silently, on one reinforcement.
    if (instinct.status === "quarantined" || instinct.status === "permanent") return;
    const newStatus = this.confidenceScorer.getStatus(instinct.confidence);
    
    if (newStatus !== instinct.status) {
      // Create updated instinct with new status (readonly properties require new object)
      const updatedInstinct = { ...instinct, status: newStatus, updatedAt: Date.now() as import("../../types/index.js").TimestampMs };
      this.storage.updateInstinct(updatedInstinct);
    }
  }

  private buildRecoveryInjection(matches: PatternMatch[], _context: ErrorContext): string {
    if (matches.length === 0) return "";

    const lines: string[] = ["\n[LEARNED SOLUTIONS]"];
    
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      if (!match.instinct) continue;

      lines.push(`\n${i + 1}. ${match.instinct.name} (confidence: ${(match.confidence * 100).toFixed(0)}%)`);
      lines.push(`   Match: ${match.matchReason}`);
      lines.push(`   Action: ${match.instinct.action.slice(0, 200)}${match.instinct.action.length > 200 ? "..." : ""}`);
    }

    lines.push("\n[END LEARNED SOLUTIONS]");
    return lines.join("\n");
  }

  private extractErrorCode(errorOutput: string): string | undefined {
    // Try to extract C# error codes
    const match = errorOutput.match(/(CS\d{4})/);
    return match?.[1];
  }

  private inferErrorCategory(analysis: ErrorAnalysis): ErrorCategory | undefined {
    // Extract category from analysis summary
    if (analysis.summary.includes("missing_type")) return "syntax";
    if (analysis.summary.includes("undefined_symbol")) return "logic";
    if (analysis.summary.includes("missing_member")) return "logic";
    if (analysis.summary.includes("type_mismatch")) return "validation";
    if (analysis.summary.includes("syntax")) return "syntax";
    if (analysis.summary.includes("missing_reference")) return "resource";
    if (analysis.summary.includes("access")) return "permission";
    return undefined;
  }

  private generateErrorId(context: ErrorContext): string {
    // Generate a deterministic ID based on error characteristics
    const hash = `${context.toolName}:${context.errorOutput.slice(0, 100)}:${context.timestamp.getTime()}`;
    return hash;
  }

  // ─── Utility Methods ─────────────────────────────────────────────────────────

  /**
   * Get statistics about active errors and learning
   */
  getStats(): {
    activeErrors: number;
    totalTracked: number;
    /**
     * r13 #24: exposures left unjudged because no application was reported —
     * SINCE THIS PROCESS STARTED, and only those this hook saw. It is a live
     * counter, not the measurement: a restart forgets it and a second producer of
     * exposures is not in it. The durable answer is `strada learning coverage`
     * (`exposureCoverage` over `instinct_exposure_log`), which counts recorded
     * exposures per period and reports NOT MEASURED when none were recorded.
     */
    unjudgedExposures: number;
  } {
    return {
      activeErrors: this.activeErrors.size,
      totalTracked: this.activeErrors.size, // Could track cumulative
      unjudgedExposures: this.unjudgedExposures,
    };
  }

  /**
   * Clear all active error tracking
   */
  clearActiveErrors(): void {
    this.activeErrors.clear();
  }
}
