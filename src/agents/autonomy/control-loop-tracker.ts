import { MUTATION_TOOLS, PROGRESS_MUTATION_TOOLS } from "./constants.js";

export type ControlLoopGateKind =
  | "clarification_internal_continue"
  | "visibility_internal_continue"
  | "reflection_continue"
  | "verifier_continue"
  | "verifier_replan";

export interface ControlLoopGateEvent {
  readonly kind: ControlLoopGateKind;
  readonly reason?: string;
  readonly gate?: string;
  readonly iteration: number;
}

export interface ControlLoopTrigger {
  readonly fingerprint: string;
  readonly sameFingerprintCount: number;
  readonly recentGateCount: number;
  readonly recoveryEpisode: number;
  readonly reason: string;
  readonly latestReason?: string;
}

interface StoredGateEvent extends ControlLoopGateEvent {
  readonly fingerprint: string;
}

export interface ControlLoopConfig {
  /** Clock, for the time-based read-only stall (tests). */
  readonly now?: () => number;
  readonly sameFingerprintThreshold?: number;
  readonly sameFingerprintWindow?: number;
  readonly gateDensityThreshold?: number;
  readonly gateDensityWindow?: number;
  readonly maxRecoveryEpisodes?: number;
  readonly staleAnalysisThreshold?: number;
  /** Hard cap: force replan after this many consecutive text-only gates. */
  readonly hardCapReplan?: number;
  /** Hard cap: force block after this many consecutive text-only gates. */
  readonly hardCapBlock?: number;
}

export class ControlLoopTracker {
  private readonly events: StoredGateEvent[] = [];
  private readonly seenEvidence = new Set<string>();
  private readonly recoveryEpisodes = new Map<string, number>();
  private consecutiveNoToolGates = 0;
  private consecutiveReadOnlyToolCalls = 0;
  /** Read-only streaks reported this run (reset by a progress mutation) — the escalation level. */
  private readOnlyStreakReports = 0;
  private lastReadOnlyFingerprint: string | null = null;
  private sameReadOnlyFingerprintCount = 0;
  private mutationsSinceLastReset = false;
  /** When the current read-only streak began (epoch ms); null = no streak. */
  private readOnlySince: number | null = null;
  private readonly now: () => number;
  private pruneIndex = 0;

  static readonly READ_ONLY_STALL_THRESHOLD = 8;
  /** Measured: a legitimate document read ran to 39 calls; a real spin ran to 108. */
  /**
   * Consecutive read-only calls (DISTINCT ones — repeats trip the 8-call rule)
   * before the run is told that reading is not progress. Measured 2026-09-08
   * 17:57-18:44 on a PixelFlow sprint: 14 turns, ~30 vault/file reads, no
   * write, no gate — the old limit of 60 was ~100 minutes of a 6-hour box at
   * the provider's 4.5-minute turn pace, and shell greps reset it besides.
   */
  static readonly READ_ONLY_STREAK_LIMIT = 24;
  /**
   * Time-based stall: this long without a progress tool, after at least
   * READ_ONLY_TIME_MIN_CALLS read-only calls. Measured 2026-09-09 11:37-12:37:
   * a node with a 60-minute budget read the tree for the whole hour at ~2.5
   * min per turn — about 24 calls, so the count-based limit fired at the end
   * of the budget at best. Fifteen minutes of reads is a stall at any pace.
   */
  static readonly READ_ONLY_STALL_MS = 15 * 60_000;
  static readonly READ_ONLY_TIME_MIN_CALLS = 6;

  private readonly fpThreshold: number;
  private readonly hasCustomFpThreshold: boolean;
  private readonly fpWindow: number;
  private readonly densityThreshold: number;
  private readonly densityWindow: number;
  readonly maxRecoveryEpisodes: number;
  private readonly staleAnalysisThreshold: number;
  readonly hardCapReplan: number;
  readonly hardCapBlock: number;

  constructor(config?: ControlLoopConfig) {
    this.now = config?.now ?? Date.now;
    this.fpThreshold = config?.sameFingerprintThreshold ?? 15;
    this.hasCustomFpThreshold = typeof config?.sameFingerprintThreshold === "number";
    this.fpWindow = config?.sameFingerprintWindow ?? 20;
    this.densityThreshold = config?.gateDensityThreshold ?? 20;
    this.densityWindow = config?.gateDensityWindow ?? 30;
    this.maxRecoveryEpisodes = config?.maxRecoveryEpisodes ?? 5;
    this.staleAnalysisThreshold = config?.staleAnalysisThreshold ?? 3;
    this.hardCapReplan = config?.hardCapReplan ?? 5;
    this.hardCapBlock = config?.hardCapBlock ?? 8;
  }

  recordGate(event: ControlLoopGateEvent): ControlLoopTrigger | null {
    const stored: StoredGateEvent = {
      ...event,
      fingerprint: normalizeFingerprint(event.kind, event.reason, event.gate),
    };
    this.events.push(stored);
    this.consecutiveNoToolGates++;
    this.prune(event.iteration);

    const liveEvents = this.pruneIndex > 0 ? this.events.slice(this.pruneIndex) : this.events;

    // Stale analysis: consecutive gates without any tool execution
    if (this.consecutiveNoToolGates >= this.staleAnalysisThreshold) {
      return {
        fingerprint: stored.fingerprint,
        sameFingerprintCount: this.consecutiveNoToolGates,
        recentGateCount: liveEvents.length,
        recoveryEpisode: this.recoveryEpisodes.get(stored.fingerprint) ?? 0,
        reason: "stale_analysis_loop",
        latestReason: stored.reason,
      };
    }

    // Read-only stall: agent executes many verification/read tools without any mutations
    if (this.consecutiveReadOnlyToolCalls >= ControlLoopTracker.READ_ONLY_STALL_THRESHOLD) {
      return {
        fingerprint: "read_only_stall",
        sameFingerprintCount: this.consecutiveReadOnlyToolCalls,
        recentGateCount: liveEvents.length,
        recoveryEpisode: this.recoveryEpisodes.get("read_only_stall") ?? 0,
        reason: `Agent executed ${this.consecutiveReadOnlyToolCalls} consecutive read-only/verification tool calls without any file mutations. This suggests the agent is stuck analyzing without making progress.`,
      };
    }

    const sameFingerprintEvents = liveEvents.filter((entry) =>
      entry.fingerprint === stored.fingerprint &&
      entry.iteration >= event.iteration - this.fpWindow,
    );
    if (sameFingerprintEvents.length >= this.getSameFingerprintThreshold(event.kind)) {
      return {
        fingerprint: stored.fingerprint,
        sameFingerprintCount: sameFingerprintEvents.length,
        recentGateCount: liveEvents.length,
        recoveryEpisode: this.recoveryEpisodes.get(stored.fingerprint) ?? 0,
        reason: "same_fingerprint_repeated",
        latestReason: stored.reason,
      };
    }

    const recentEvents = liveEvents.filter((entry) => entry.iteration >= event.iteration - this.densityWindow);
    if (recentEvents.length >= this.densityThreshold) {
      return {
        fingerprint: stored.fingerprint,
        sameFingerprintCount: sameFingerprintEvents.length,
        recentGateCount: recentEvents.length,
        recoveryEpisode: this.recoveryEpisodes.get(stored.fingerprint) ?? 0,
        reason: "internal_gate_density",
        latestReason: stored.reason,
      };
    }

    return null;
  }

  incrementTextOnlyGate(): void {
    this.consecutiveNoToolGates++;
  }

  getConsecutiveTextOnlyGates(): number {
    return this.consecutiveNoToolGates;
  }

  getConsecutiveReadOnlyToolCalls(): number {
    return this.consecutiveReadOnlyToolCalls;
  }

  hadMutationsSinceLastReset(): boolean {
    return this.mutationsSinceLastReset;
  }

  markToolExecution(toolName?: string, callFingerprint?: string): void {
    // Only reset stale analysis counter on mutation tools, not read-only tools
    // like file_read, grep_search, list_directory. When no toolName is provided
    // (backward compat), assume mutation to preserve existing behavior.
    const mutates = !toolName || MUTATION_TOOLS.has(toolName);
    // shell_exec may write, so it counts as a mutation for the gate rules —
    // but `grep -r` through it is reading, and it used to end a read-only
    // streak (measured 2026-09-08 16:07: four shell greps, streak reset).
    const progresses = !toolName || PROGRESS_MUTATION_TOOLS.has(toolName);
    if (mutates) {
      this.consecutiveNoToolGates = 0;
      this.mutationsSinceLastReset = true;
    }
    if (progresses) {
      this.consecutiveReadOnlyToolCalls = 0;
      this.readOnlyStreakReports = 0;
      this.lastReadOnlyFingerprint = null;
      this.sameReadOnlyFingerprintCount = 0;
      this.readOnlySince = null;
    } else {
      this.consecutiveReadOnlyToolCalls++;
      if (this.readOnlySince === null) this.readOnlySince = this.now();
      const fingerprint = callFingerprint ?? toolName;
      if (fingerprint === this.lastReadOnlyFingerprint) {
        this.sameReadOnlyFingerprintCount++;
      } else {
        this.lastReadOnlyFingerprint = fingerprint;
        this.sameReadOnlyFingerprintCount = 1;
      }
    }
  }

  /**
   * Is the run reading without getting anywhere?
   *
   * The same condition is checked inside recordGate(), which only runs when
   * something else already raised a gate. Measured on 2026-08-20: a run made
   * 108 consecutive read-only calls — 171 of them to one stats tool — against a
   * threshold of 8, and raised no gate the whole time, so the check that exists
   * for exactly this was never reached. The counter was right; nobody asked it.
   */
  readOnlyStall(): { readonly calls: number; readonly reason: string } | null {
    // Repetition, not reading. Measured 2026-08-20 on two runs: one spent 42
    // minutes making 171 calls to a single stats tool, and the next read a
    // design document in 39 pieces. Counting read-only calls alone called both
    // of them stuck — reading a long document in order is progress.
    if (this.sameReadOnlyFingerprintCount >= ControlLoopTracker.READ_ONLY_STALL_THRESHOLD) {
      return {
        calls: this.sameReadOnlyFingerprintCount,
        reason:
          `Agent repeated the same read-only call ${this.sameReadOnlyFingerprintCount} times ` +
          `without any file mutation.`,
      };
    }
    // A streak this long is not exploration whatever it reads. Kept well above
    // the document-reading case so ordinary research does not trip it.
    if (this.consecutiveReadOnlyToolCalls >= ControlLoopTracker.READ_ONLY_STREAK_LIMIT) {
      return {
        calls: this.consecutiveReadOnlyToolCalls,
        reason:
          `Agent executed ${this.consecutiveReadOnlyToolCalls} consecutive read-only tool calls ` +
          `without any file mutation.`,
      };
    }
    if (
      this.readOnlySince !== null &&
      this.consecutiveReadOnlyToolCalls >= ControlLoopTracker.READ_ONLY_TIME_MIN_CALLS &&
      this.now() - this.readOnlySince >= ControlLoopTracker.READ_ONLY_STALL_MS
    ) {
      const minutes = Math.round((this.now() - this.readOnlySince) / 60_000);
      return {
        calls: this.consecutiveReadOnlyToolCalls,
        reason:
          `Agent spent ${minutes} minutes on ${this.consecutiveReadOnlyToolCalls} consecutive read-only tool calls ` +
          `without any file mutation.`,
      };
    }
    return null;
  }

  /** True the first time a stall crosses the threshold, so a caller reports it once. */
  /**
   * The stall, once per streak: reporting restarts the count, so a run that
   * keeps reading is told again after the next full streak rather than once
   * per mutation (which, in a read-only run, is never).
   */
  takeUnreportedReadOnlyStall(): { readonly calls: number; readonly reason: string } | null {
    const stall = this.readOnlyStall();
    if (stall === null) return null;
    this.consecutiveReadOnlyToolCalls = 0;
    this.lastReadOnlyFingerprint = null;
    this.sameReadOnlyFingerprintCount = 0;
    this.readOnlySince = null;
    this.readOnlyStreakReports += 1;
    return stall;
  }

  /** How many read-only streaks this run has been told about since its last change. */
  getReadOnlyStreakReports(): number {
    return this.readOnlyStreakReports;
  }

  markVerificationClean(_iteration: number): void {
    this.events.length = 0;
    this.pruneIndex = 0;
    this.consecutiveNoToolGates = 0;
    this.consecutiveReadOnlyToolCalls = 0;
    this.mutationsSinceLastReset = false;
  }

  markMeaningfulFileEvidence(files: readonly string[], _iteration: number): void {
    const newEvidence = files
      .map((file) => file.trim())
      .filter((file) => file.length > 0 && !this.seenEvidence.has(file));
    if (newEvidence.length === 0) {
      return;
    }
    for (const file of newEvidence) {
      this.seenEvidence.add(file);
    }
    this.events.length = 0;
    this.pruneIndex = 0;
    this.consecutiveNoToolGates = 0;
    this.consecutiveReadOnlyToolCalls = 0;
  }

  /**
   * When the pipeline last intervened (replan, delegation, block). The
   * arbiter measures progress from here: an edit the agent made between two
   * interventions is evidence the second must weigh, whatever the assessor
   * says about the last few turns.
   */
  private lastInterventionAtMs = 0;

  noteIntervention(at: number = Date.now()): void {
    this.lastInterventionAtMs = at;
  }

  lastInterventionAt(): number {
    return this.lastInterventionAtMs;
  }

  markRecoveryAttempt(fingerprint: string): number {
    const next = (this.recoveryEpisodes.get(fingerprint) ?? 0) + 1;
    this.recoveryEpisodes.set(fingerprint, next);
    this.events.length = 0;
    this.pruneIndex = 0;
    this.consecutiveNoToolGates = 0;
    this.consecutiveReadOnlyToolCalls = 0;
    return next;
  }

  private prune(currentIteration: number): void {
    const minIteration = currentIteration - this.densityWindow;
    while (
      this.pruneIndex < this.events.length &&
      this.events[this.pruneIndex] &&
      this.events[this.pruneIndex]!.iteration < minIteration
    ) {
      this.pruneIndex++;
    }
    // Only splice when dead prefix exceeds half the array to amortize cost
    if (this.pruneIndex > 0 && this.pruneIndex > this.events.length / 2) {
      this.events.splice(0, this.pruneIndex);
      this.pruneIndex = 0;
    }
  }

  private getSameFingerprintThreshold(kind: ControlLoopGateKind): number {
    if (this.hasCustomFpThreshold) {
      return this.fpThreshold;
    }
    switch (kind) {
      case "clarification_internal_continue":
      case "visibility_internal_continue":
      case "verifier_continue":
        return 3;
      default:
        return this.fpThreshold;
    }
  }
}

// ─── Adaptive Hard Cap ────────────────────────────────────────────────────────

/**
 * Context snapshot passed to computeAdaptiveHardCap.
 * Keeps the function decoupled from AgentState (avoids circular import).
 */
export interface AdaptiveCapContext {
  readonly phase: string;
  readonly totalStepCount: number;
  readonly hasActivePlan: boolean;
  readonly failedApproachCount: number;
  /** Number of times PAOR override forced DONE→CONTINUE/REPLAN. */
  readonly reflectionOverrideCount?: number;
}

/**
 * Computes context-aware hard cap thresholds instead of using static numbers.
 *
 * The configured base values (from env/config) serve as the MINIMUM floor.
 * Adaptive logic adds headroom based on the agent's current state:
 *
 * - PLANNING/REPLANNING phase: text-only analysis is expected → +3 headroom
 * - Agent has already executed tools: reflecting between actions is normal → +2
 * - Agent in EXECUTING with zero tool calls: very suspicious → no headroom (base stays)
 * - Multiple failed approaches: agent is struggling, give a bit more room → +1
 *
 * Block threshold always stays at least replan + 2 to allow the replan
 * to take effect before hard-blocking.
 */
export function computeAdaptiveHardCap(
  baseReplan: number,
  baseBlock: number,
  ctx: AdaptiveCapContext,
): { replan: number; block: number } {
  let replan = baseReplan;
  let block = baseBlock;

  // Planning phases legitimately produce text — plan generation is text-only by design
  if (ctx.phase === "planning" || ctx.phase === "replanning") {
    replan += 3;
    block += 3;
  }

  // Agent has executed tools before: reflecting/re-analyzing between tool batches is normal
  if (ctx.totalStepCount > 0) {
    replan += 2;
    block += 2;
  }

  // Agent in executing phase with zero tools ever: every text-only gate is suspicious
  // No headroom added — base values apply (tightest detection)

  // Multiple failed approaches: agent is iterating on solutions, give slight extra room
  if (ctx.failedApproachCount >= 2) {
    replan += 1;
    block += 1;
  }

  // PAOR override pressure: if the reflection system already forced retries,
  // tighten the caps — the agent is likely stuck on an external failure
  // that retrying cannot fix.
  // Cap override pressure to prevent erasing all context-aware headroom
  const overrides = Math.min(ctx.reflectionOverrideCount ?? 0, 3);
  if (overrides >= 1) {
    replan = Math.max(baseReplan, replan - overrides);
    block = Math.max(replan + 2, block - overrides);
  }

  // Ensure block > replan with enough gap for replan to take effect
  block = Math.max(block, replan + 2);

  return { replan, block };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function normalizeFingerprint(
  kind: ControlLoopGateKind,
  reason?: string,
  gate?: string,
): string {
  const summary = summarizeText(reason || gate || "no-reason");
  return `${kind}:${summary}`;
}

function summarizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 _-]+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * What the model is told when a read-only streak trips: the measurement and
 * the only two acceptable next moves. Pushed into the session as a user turn.
 */
export function readOnlyStreakGate(stall: { readonly calls: number; readonly reason: string }, level = 1): string {
  if (level >= 2) {
    return (
      `[READ-ONLY STREAK ×${level}] ${stall.reason} You were told this before and kept reading. ` +
      "For your next turn the tool list holds ONLY tools that change the project: make one change now " +
      "(write, edit, generate, bind, place), or answer with a final report that names exactly what " +
      "blocks a change. There is nothing left to read."
    );
  }
  return (
    `[READ-ONLY STREAK] ${stall.reason} Reading is not progress. ` +
    "Your next turn must either CHANGE something with a write/generate/bind tool, or state in one " +
    "paragraph exactly what blocks a change and what you will do about it. Do not read more first."
  );
}

/**
 * The tool list for a turn that must change something: the progress-mutation
 * tools only. Measured 2026-09-09 07:24-07:37: the streak gate fired three
 * times in 13 minutes and the model went on reading each time — a nudge the
 * model can ignore is not a gate. With nothing left to read, it cannot.
 * Returns the list unchanged when it holds no such tool (nothing to force).
 */
export function restrictToProgressTools<T extends { readonly name: string }>(tools: readonly T[]): T[] {
  const kept = tools.filter((t) => PROGRESS_MUTATION_TOOLS.has(t.name));
  return kept.length > 0 ? kept : [...tools];
}
