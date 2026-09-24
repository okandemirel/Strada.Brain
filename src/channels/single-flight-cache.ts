/**
 * Run an expensive producer at most once at a time, and reuse its last result
 * for a short while (CHN-8).
 *
 * `GET /api/campaign?measure=1` walked the project tree on every request, so a
 * burst of requests (or a page firing them in a loop) ran one full measurement
 * per request, each blocking the daemon's event loop. Concurrent callers now
 * share the in-flight run, and a result younger than `ttlMs` is reused.
 * A failed run is not cached: the next caller tries again.
 */
export class SingleFlightCache<T> {
  private inflight: Promise<T> | null = null;
  private last: { readonly value: T; readonly at: number } | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  run(produce: () => Promise<T>): Promise<T> {
    if (this.last && this.now() - this.last.at < this.ttlMs) return Promise.resolve(this.last.value);
    if (this.inflight) return this.inflight;
    const run = produce()
      .then((value) => {
        this.last = { value, at: this.now() };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = run;
    return run;
  }

  /** Forget the cached result (e.g. the producer itself was replaced). */
  clear(): void {
    this.last = null;
  }
}
