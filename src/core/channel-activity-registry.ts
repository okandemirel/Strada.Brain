export interface ChatActivity {
  channelName: string;
  chatId: string;
  lastActivity: number;
}

/** Default recency window for "active" chats — entries older than this are treated as dead. */
const DEFAULT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
/** Hard cap on tracked chats — oldest entries are evicted once exceeded. */
const DEFAULT_MAX_ENTRIES = 1000;

export class ChannelActivityRegistry {
  private readonly activities = new Map<string, ChatActivity>();
  private readonly startupTime: number;
  private readonly startupGracePeriodMs = 5 * 60 * 1000; // 5 minutes
  private readonly activityWindowMs: number;
  private readonly maxEntries: number;

  constructor(startupTime?: number, activityWindowMs?: number, maxEntries?: number) {
    this.startupTime = startupTime ?? Date.now();
    this.activityWindowMs = activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;
    this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  recordActivity(channelName: string, chatId: string): void {
    const key = `${channelName}:${chatId}`;
    this.activities.set(key, {
      channelName,
      chatId,
      lastActivity: Date.now(),
    });
    this.prune();
  }

  /**
   * Drop stale entries (older than the recency window) and enforce the size cap
   * by evicting the least-recently-active entries. Keeps the Map bounded for the
   * process lifetime so it cannot grow without limit on long-running daemons.
   */
  private prune(): void {
    const cutoff = Date.now() - this.activityWindowMs;
    for (const [key, activity] of this.activities) {
      if (activity.lastActivity < cutoff) {
        this.activities.delete(key);
      }
    }
    if (this.activities.size <= this.maxEntries) {
      return;
    }
    // Evict oldest-first until back under the cap.
    const sorted = Array.from(this.activities.entries()).sort(
      (a, b) => a[1].lastActivity - b[1].lastActivity,
    );
    const excess = this.activities.size - this.maxEntries;
    for (let i = 0; i < excess; i++) {
      this.activities.delete(sorted[i]![0]);
    }
  }

  getLastActivityTime(): number {
    let latest = 0;
    for (const activity of this.activities.values()) {
      if (activity.lastActivity > latest) {
        latest = activity.lastActivity;
      }
    }
    return latest;
  }

  /**
   * Return chats active within the recency window. Defaults to the configured
   * activity window so callers (e.g. the auto-updater's update-notice fan-out)
   * only message currently-active conversations, not every chat that ever
   * messaged. Pass an explicit window (e.g. the idle timeout) to narrow further.
   */
  getActiveChatIds(withinMs?: number): ChatActivity[] {
    const window = withinMs ?? this.activityWindowMs;
    const cutoff = Date.now() - window;
    return Array.from(this.activities.values()).filter(
      (activity) => activity.lastActivity >= cutoff,
    );
  }

  isIdle(timeoutMinutes: number): boolean {
    // Block updates during startup grace period to prevent immediate restart loops
    const timeSinceStartup = Date.now() - this.startupTime;
    if (timeSinceStartup < this.startupGracePeriodMs) {
      return false;
    }

    const lastActivity = this.getLastActivityTime();
    if (lastActivity === 0) return true;
    const elapsed = Date.now() - lastActivity;
    return elapsed > timeoutMinutes * 60 * 1000;
  }
}
