export type ControlLoopGateKind =
  | "clarification_internal_continue"
  | "visibility_internal_continue"
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
}

export class ControlLoopTracker {
  private readonly events: StoredGateEvent[] = [];
  private readonly seenEvidence = new Set<string>();
  private readonly recoveryEpisodes = new Map<string, number>();

  private readonly fpThreshold: number;
  private readonly fpWindow: number;
  private readonly densityThreshold: number;
  private readonly densityWindow: number;
  readonly maxRecoveryEpisodes: number;

  constructor(config?: ControlLoopConfig) {
    this.fpThreshold = config?.sameFingerprintThreshold ?? 5;
    this.fpWindow = config?.sameFingerprintWindow ?? 20;
    this.densityThreshold = config?.gateDensityThreshold ?? 8;
    this.densityWindow = config?.gateDensityWindow ?? 30;
    this.maxRecoveryEpisodes = config?.maxRecoveryEpisodes ?? 5;
  }

  recordGate(event: ControlLoopGateEvent): ControlLoopTrigger | null {
    const stored: StoredGateEvent = {
      ...event,
      fingerprint: normalizeFingerprint(event.kind, event.reason, event.gate),
    };
    this.events.push(stored);
    this.prune(event.iteration);

    const sameFingerprintEvents = this.events.filter((entry) =>
      entry.fingerprint === stored.fingerprint &&
      entry.iteration >= event.iteration - this.fpWindow,
    );
    if (sameFingerprintEvents.length >= this.fpThreshold) {
      return {
        fingerprint: stored.fingerprint,
        sameFingerprintCount: sameFingerprintEvents.length,
        recentGateCount: this.events.length,
        recoveryEpisode: this.recoveryEpisodes.get(stored.fingerprint) ?? 0,
        reason: "same_fingerprint_repeated",
        latestReason: stored.reason,
      };
    }

    const recentEvents = this.events.filter((entry) => entry.iteration >= event.iteration - this.densityWindow);
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

  markVerificationClean(_iteration: number): void {
    this.events.length = 0;
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
  }

  markRecoveryAttempt(fingerprint: string): number {
    const next = (this.recoveryEpisodes.get(fingerprint) ?? 0) + 1;
    this.recoveryEpisodes.set(fingerprint, next);
    this.events.length = 0;
    return next;
  }

  private prune(currentIteration: number): void {
    const minIteration = currentIteration - this.densityWindow;
    while (this.events.length > 0 && this.events[0] && this.events[0].iteration < minIteration) {
      this.events.shift();
    }
  }
}

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
