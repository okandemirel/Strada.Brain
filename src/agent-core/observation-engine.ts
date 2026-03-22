/**
 * Observation Engine
 *
 * Collects observations from registered observers and provides a
 * priority-sorted stream for AgentCore consumption.
 *
 * Features:
 * - Multi-source observation collection
 * - Priority-based sorting
 * - Deduplication (same source + similar summary within window)
 * - Observation history for reasoning context
 */

import type { AgentObservation, Observer } from "./observation-types.js";

/** Dedup window: suppress similar observations within this period */
const DEDUP_WINDOW_MS = 60_000; // 1 minute

/** Max observations to keep in history */
const MAX_HISTORY = 100;

export class ObservationEngine {
  private readonly observers: Observer[] = [];
  private readonly recentHashes = new Map<string, number>(); // hash -> timestamp
  private readonly history: AgentObservation[] = [];
  private readonly pendingInjections: AgentObservation[] = [];

  private static readonly MAX_PENDING_INJECTIONS = 100;

  /** Inject a synthetic observation into the next collect cycle */
  inject(observation: AgentObservation): void {
    if (this.pendingInjections.length >= ObservationEngine.MAX_PENDING_INJECTIONS) {
      this.pendingInjections.shift(); // Drop oldest
    }
    this.pendingInjections.push(observation);
  }

  /** Register an observer */
  register(observer: Observer): void {
    this.observers.push(observer);
  }

  /** Start all observers that support it */
  start(): void {
    for (const obs of this.observers) {
      obs.start?.();
    }
  }

  /** Stop all observers */
  stop(): void {
    for (const obs of this.observers) {
      obs.stop?.();
    }
  }

  /**
   * Collect all pending observations from all registered observers.
   * Returns priority-sorted, deduplicated observations.
   */
  collect(): AgentObservation[] {
    const all: AgentObservation[] = [...this.pendingInjections];
    this.pendingInjections.length = 0;

    for (const observer of this.observers) {
      try {
        const observations = observer.collect();
        all.push(...observations);
      } catch {
        // Observer failure is non-fatal — skip and continue
      }
    }

    // Dedup: suppress observations with same source+summary hash within window
    const now = Date.now();
    this.pruneExpiredHashes(now);

    const deduped = all.filter((obs) => {
      const hash = `${obs.source}:${obs.summary.slice(0, 100)}`;
      const lastSeen = this.recentHashes.get(hash);
      if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
        return false; // Suppress duplicate
      }
      this.recentHashes.set(hash, now);
      return true;
    });

    // Sort by priority descending
    deduped.sort((a, b) => b.priority - a.priority);

    // Add to history and trim excess
    this.history.push(...deduped);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }

    return deduped;
  }

  /** Get recent observation history (for reasoning context) */
  getHistory(limit = 20): readonly AgentObservation[] {
    return this.history.slice(-limit);
  }

  /** Get registered observer count */
  getObserverCount(): number {
    return this.observers.length;
  }

  private pruneExpiredHashes(now: number): void {
    for (const [hash, ts] of this.recentHashes) {
      if (now - ts > DEDUP_WINDOW_MS) {
        this.recentHashes.delete(hash);
      }
    }
  }
}
