/**
 * Holds the `task:blocked` announcements of a block-plus-notice sequence so the
 * channel hears it once.
 *
 * `block()` announces and `appendTaskNotice()` re-announces the combined text,
 * so a stop that wrote both put the same long message on the channel twice.
 * Inside a {@link BlockAnnouncementHold.once} scope the writes still reach
 * storage in order; only the announcement is held back and sent when the scope
 * ends.
 */
export class BlockAnnouncementHold {
  /** Per task in a scope: the text waiting to be announced (null = nothing yet). */
  private readonly held = new Map<string, string | null>();

  constructor(private readonly emit: (taskId: string, text: string) => void) {}

  /**
   * Announce `text` now, or hold it when the task is inside a scope. A notice
   * REPLACES the held text (it is the held text plus the notice); a second,
   * separate block flushes the held one first so no message is lost.
   */
  announce(taskId: string, text: string, kind: "block" | "notice"): void {
    if (!this.held.has(taskId)) {
      this.emit(taskId, text);
      return;
    }
    const waiting = this.held.get(taskId) ?? null;
    if (kind === "block" && waiting !== null) this.emit(taskId, waiting);
    this.held.set(taskId, text);
  }

  /** Run synchronous `fn`, then announce what it left held, once. Nested scopes defer to the outer one. */
  once<T>(taskId: string, fn: () => T): T {
    if (this.held.has(taskId)) return fn();
    this.held.set(taskId, null);
    try {
      return fn();
    } finally {
      const waiting = this.held.get(taskId) ?? null;
      this.held.delete(taskId);
      if (waiting !== null) this.emit(taskId, waiting);
    }
  }
}

/** Announce a block and the notices written with it once, on a manager that can; one that cannot announces each write. */
export function announceBlockedOnce(
  manager: { announceBlockedOnce?<T>(id: string, fn: () => T): T } | null | undefined,
  taskId: string,
  fn: () => void,
): void {
  if (manager?.announceBlockedOnce) manager.announceBlockedOnce(taskId, fn);
  else fn();
}
