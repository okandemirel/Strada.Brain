import { MUTATION_TOOLS } from "./constants.js";

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
  private pruneIndex = 0;

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

  markToolExecution(toolName?: string): void {
    // Only reset stale analysis counter on mutation tools, not read-only tools
    // like file_read, grep_search, list_directory. When no toolName is provided
    // (backward compat), assume mutation to preserve existing behavior.
    if (!toolName || MUTATION_TOOLS.has(toolName)) {
      this.consecutiveNoToolGates = 0;
    }
  }

  markVerificationClean(_iteration: number): void {
    this.events.length = 0;
    this.pruneIndex = 0;
    this.consecutiveNoToolGates = 0;
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
  }

  markRecoveryAttempt(fingerprint: string): number {
    const next = (this.recoveryEpisodes.get(fingerprint) ?? 0) + 1;
    this.recoveryEpisodes.set(fingerprint, next);
    this.events.length = 0;
    this.pruneIndex = 0;
    this.consecutiveNoToolGates = 0;
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
