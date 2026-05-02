export interface ChatActivity {
  channelName: string;
  chatId: string;
  lastActivity: number;
}

export class ChannelActivityRegistry {
  private readonly activities = new Map<string, ChatActivity>();
  private readonly startupTime: number;
  private readonly startupGracePeriodMs = 5 * 60 * 1000; // 5 minutes

  constructor(startupTime?: number) {
    this.startupTime = startupTime ?? Date.now();
  }

  recordActivity(channelName: string, chatId: string): void {
    const key = `${channelName}:${chatId}`;
    this.activities.set(key, {
      channelName,
      chatId,
      lastActivity: Date.now(),
    });
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

  getActiveChatIds(): ChatActivity[] {
    return Array.from(this.activities.values());
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
