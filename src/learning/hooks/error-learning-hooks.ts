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
  } {
    if (!this.enabled) {
      return { suggestions: [], recoveryInjection: "" };
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

    return { suggestions: matches, recoveryInjection };
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

    const errorId = this.generateErrorId(resolution.errorContext);

    // Check if we have a matching active error
    if (!this.activeErrors.has(errorId)) {
      // Error wasn't tracked, but we can still learn from it
      await this.learnFromUntrackedResolution(resolution);
      return;
    }

    // Remove from active errors
    this.activeErrors.delete(errorId);

    // Update learning based on resolution success
    const applied = this.findAppliedInstinct(resolution);
    if (resolution.success) {
      await this.handleSuccessfulResolution(resolution, applied);
    } else {
      this.handleFailedResolution(resolution, applied);
    }

    // EVERY OTHER RULE THIS RUN WAS SHOWN cost it an attempt and taught
    // nobody anything. Record that, so a misfiring trigger becomes findable.
    this.recordNonApplications(errorId, resolution, applied?.id);

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
    } else {
      // No instinct was applied - consider creating one from this successful resolution
      await this.considerInstinctFromResolution(resolution);
    }
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
    appliedInstinctId: string | undefined,
  ): void {
    const shown = this.shownGuidance.get(errorId);
    this.shownGuidance.delete(errorId);
    if (!shown) return;
    for (const instinctId of shown.instinctIds) {
      if (instinctId === appliedInstinctId) continue;
      const instinct = this.storage.getInstinct(instinctId);
      if (!instinct) continue;
      const before = instinct.confidence;
      const updated = this.confidenceScorer.applyEvidence(instinct, {
        alphaDelta: 0,
        betaDelta: NON_APPLICATION_BETA,
      });
      this.storage.updateInstinct(updated);
      this.updateInstinctStatus(updated);
      try {
        this.storage.recordInstinctCredit({
          instinctId,
          sessionId: String(resolution.errorContext.sessionId ?? ""),
          success: false,
          applied: false,
          verdictScore: NON_APPLICATION_BETA,
          source: "observed",
          confidenceBefore: before,
          confidenceAfter: updated.confidence,
          statusAt: instinct.status,
          timestamp: Date.now(),
          exposedAt: shown.shownAt,
        });
      } catch {
        // The ledger row is the record, not the mechanism: a storage failure
        // must not take the resolution path down with it.
      }
    }
  }

  private findAppliedInstinct(resolution: ResolutionContext): { id: string } | null {
    // Try to match the resolution action against known instinct actions
    const instincts = this.storage.getInstincts({ status: "active" });
    
    for (const instinct of instincts) {
      // Simple matching - could be more sophisticated
      if (resolution.action.includes(instinct.action) || 
          instinct.action.includes(resolution.action)) {
        return { id: instinct.id };
      }
    }

    return null;
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
    if (resolution.success) {
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
  } {
    return {
      activeErrors: this.activeErrors.size,
      totalTracked: this.activeErrors.size, // Could track cumulative
    };
  }

  /**
   * Clear all active error tracking
   */
  clearActiveErrors(): void {
    this.activeErrors.clear();
  }
}
