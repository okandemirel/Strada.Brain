/**
 * Hands the framework knowledge store to its consumer only once boot sync has
 * SETTLED (succeeded or failed) — never merely once the store object exists.
 *
 * bootstrap's detached sync IIFE assigned `frameworkStore` before its slow
 * `await bootSync()` (git fetch + extraction), and the main path gated the
 * FrameworkPromptGenerator wiring on `if (frameworkStore)`. On the normal boot
 * that branch was taken mid-sync: the generator was built against an unsynced
 * (on first boot: empty) database, `setFrameworkPromptGenerator` rebuilt the
 * system prompt synchronously, the miss was cached as `null` for the process
 * lifetime (`invalidateCache()` has no caller), and the post-sync repair path
 * was dead because its callback lived in the branch that was not taken. A
 * failed sync was a `logger.debug` line nobody saw. Audited 2026-09-02.
 */
export interface FrameworkSyncOutcome<S> {
  /** The store, when it could be opened. Persisted snapshots may still be usable after a failed sync. */
  readonly store: S | null;
  /** Why the sync failed, when it did. */
  readonly failure?: string;
}

export class FrameworkStoreHandoff<S> {
  private outcome: FrameworkSyncOutcome<S> | null = null;
  private consumer: ((outcome: FrameworkSyncOutcome<S>) => void) | null = null;

  /** True once the sync has succeeded or failed — the only state a consumer may act on. */
  get settled(): boolean {
    return this.outcome !== null;
  }

  /** Record the sync's outcome. The first settlement wins; later calls are ignored. */
  settle(outcome: FrameworkSyncOutcome<S>): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.consumer?.(outcome);
  }

  /**
   * Register the consumer. It runs when the sync settles — immediately if it
   * already has — and never on a store that merely exists but has not synced.
   */
  onSettled(consumer: (outcome: FrameworkSyncOutcome<S>) => void): void {
    this.consumer = consumer;
    if (this.outcome) consumer(this.outcome);
  }
}
