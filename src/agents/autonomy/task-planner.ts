/**
 * Task Planner
 *
 * Injects autonomous planning behavior into the LLM via system prompt
 * and tracks execution state to detect stalls and enforce verification gates.
 *
 * Performance:
 *   - Tool tracking: O(1) per call via Set.has()
 *   - State injection: O(1) — checks counters, not lists
 *   - Error history: bounded array (max 10)
 */

import { MUTATION_TOOLS, VERIFY_TOOLS } from "./constants.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

const MAX_ERROR_HISTORY = 10;
const VERIFY_THRESHOLD = 2;   // mutations before nagging about verification
const STALL_THRESHOLD = 3;    // consecutive errors before suggesting new approach
const BUDGET_WARNING = 40;    // iteration count to warn about budget

/** Injected into system prompt once per task. */
const PLANNING_PROMPT = `

## Autonomous Execution Protocol

Follow this protocol for EVERY task:

### PLAN → ACT → VERIFY → RESPOND

1. **PLAN**: Break complex requests into ordered sub-tasks. State your plan briefly.
2. **ACT**: Execute one sub-task at a time. Read files before editing.
3. **VERIFY**: After editing files, run dotnet_build. After bug fixes, run dotnet_test.
   NEVER declare done without verifying compilation.
4. **RESPOND**: Only after verification passes, give your final response.

### Error Recovery
- When build/test fails, analyze errors systematically.
- Fix in dependency order: missing types → undefined symbols → type mismatches → logic.
- After fixing, rebuild to verify. If stuck after 3 attempts, try a different approach.
`;

// ─── State ──────────────────────────────────────────────────────────────────────

export interface TaskState {
  readonly mutationsSinceVerify: number;
  readonly consecutiveErrors: number;
  readonly buildVerified: boolean;
  readonly iterationsUsed: number;
  readonly errorHistory: readonly string[];
}

// ─── Planner ────────────────────────────────────────────────────────────────────

export class TaskPlanner {
  private mutationsSinceVerify = 0;
  private consecutiveErrors = 0;
  private buildVerified = false;
  private iterationsUsed = 0;
  private errorHistory: string[] = [];

  /** Reset for a new task. */
  reset(): void {
    this.mutationsSinceVerify = 0;
    this.consecutiveErrors = 0;
    this.buildVerified = false;
    this.iterationsUsed = 0;
    this.errorHistory = [];
  }

  /** One-time system prompt append. */
  getPlanningPrompt(): string {
    return PLANNING_PROMPT;
  }

  /**
   * Track a completed tool call. O(1).
   */
  trackToolCall(
    toolName: string,
    isError: boolean,
  ): void {
    this.iterationsUsed++;

    // Mutation tracking — O(1)
    if (MUTATION_TOOLS.has(toolName)) {
      this.mutationsSinceVerify++;
      this.buildVerified = false;
    }

    // Verification tracking — O(1)
    if (VERIFY_TOOLS.has(toolName) && !isError) {
      this.mutationsSinceVerify = 0;
      if (toolName === "dotnet_build") this.buildVerified = true;
      this.consecutiveErrors = 0;
    }

    // Error tracking — O(1)
    if (isError) {
      this.consecutiveErrors++;
    } else if (!VERIFY_TOOLS.has(toolName)) {
      this.consecutiveErrors = 0;
    }
  }

  /**
   * Record an error summary for stall detection.
   * Bounded array (max 10 entries).
   */
  recordError(summary: string): void {
    if (this.errorHistory.length >= MAX_ERROR_HISTORY) {
      this.errorHistory.shift();
    }
    this.errorHistory.push(summary);
  }

  /**
   * Get iteration-aware state injection.
   * Returns empty string when no intervention needed (fast path).
   */
  getStateInjection(): string {
    // Fast path: nothing to say
    if (this.mutationsSinceVerify < VERIFY_THRESHOLD
        && this.consecutiveErrors < STALL_THRESHOLD
        && this.iterationsUsed < BUDGET_WARNING) {
      return "";
    }

    const parts: string[] = [];

    if (this.mutationsSinceVerify >= VERIFY_THRESHOLD && !this.buildVerified) {
      parts.push(
        `[VERIFY] ${this.mutationsSinceVerify} files modified without build check. ` +
        `Run dotnet_build before continuing.`
      );
    }

    if (this.consecutiveErrors >= STALL_THRESHOLD) {
      const recent = this.errorHistory.slice(-3).join(" | ");
      parts.push(
        `[STALL] ${this.consecutiveErrors} consecutive errors. ` +
        `Consider a different approach. Recent: ${recent}`
      );
    }

    if (this.iterationsUsed >= BUDGET_WARNING) {
      parts.push(
        `[BUDGET] ${this.iterationsUsed}/50 iterations used. Wrap up and verify.`
      );
    }

    return parts.length > 0 ? "\n" + parts.join("\n") : "";
  }

  /** Read-only state snapshot for testing/debugging. */
  getState(): TaskState {
    return {
      mutationsSinceVerify: this.mutationsSinceVerify,
      consecutiveErrors: this.consecutiveErrors,
      buildVerified: this.buildVerified,
      iterationsUsed: this.iterationsUsed,
      errorHistory: [...this.errorHistory],
    };
  }
}
