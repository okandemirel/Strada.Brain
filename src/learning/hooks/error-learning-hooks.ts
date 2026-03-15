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

// ─── Error Learning Hooks ───────────────────────────────────────────────────────

export class ErrorLearningHooks {
  private pipeline: LearningPipeline;
  private patternMatcher: PatternMatcher;
  private confidenceScorer: ConfidenceScorer;
  private storage: LearningStorage;
  private enabled = false;

  /** Track active errors for resolution correlation */
  private activeErrors = new Map<string, ErrorContext>();

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
    if (resolution.success) {
      await this.handleSuccessfulResolution(resolution);
    } else {
      this.handleFailedResolution(resolution);
    }

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
    this.updateInstinctStatus(instinct);
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
    this.updateInstinctStatus(instinct);

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

  private async handleSuccessfulResolution(resolution: ResolutionContext): Promise<void> {
    // Find if any instinct was applied
    const appliedInstinct = this.findAppliedInstinct(resolution);

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

  private handleFailedResolution(resolution: ResolutionContext): void {
    const appliedInstinct = this.findAppliedInstinct(resolution);
    
    if (appliedInstinct) {
      this.penalizeInstinct(appliedInstinct.id, {
        errorContext: resolution.errorContext,
        reason: resolution.action,
      });
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
