/**
 * How fast one remote address may be issued NEW web identities (CHN-19).
 *
 * Every `session_init` without a valid identity pair mints and persists an
 * identity, and a socket with no Origin is allowed, so a local script looping
 * WebSocket connections could grow the identity table without limit. A browser
 * that already holds an identity verifies it and is never counted here; only
 * fresh browsers (a private window, cleared storage) are.
 *
 * A fixed window per address, with the address map itself bounded.
 */
export const IDENTITY_ISSUE_LIMIT = 20;
export const IDENTITY_ISSUE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_ADDRESSES = 10_000;

export class IdentityIssueLimiter {
  /** address → its current window. Map order is recency. */
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number = IDENTITY_ISSUE_LIMIT,
    private readonly windowMs: number = IDENTITY_ISSUE_WINDOW_MS,
  ) {}

  /** Take one issuance for `address`; false when its window is spent. */
  tryTake(address: string, now: number = Date.now()): boolean {
    const current = this.windows.get(address);
    const window = current && now - current.start < this.windowMs ? current : { start: now, count: 0 };
    this.windows.delete(address);
    this.windows.set(address, window);
    while (this.windows.size > MAX_TRACKED_ADDRESSES) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
    if (window.count >= this.limit) return false;
    window.count++;
    return true;
  }
}
