import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

describe("ChannelActivityRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should record activity and return last activity time", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    const now = Date.now();
    vi.setSystemTime(now);
    registry.recordActivity("web", "chat-1");
    expect(registry.getLastActivityTime()).toBe(now);
  });

  it("should return 0 when no activity recorded", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    expect(registry.getLastActivityTime()).toBe(0);
  });

  it("should track multiple channels independently", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    vi.setSystemTime(1000);
    registry.recordActivity("web", "chat-1");
    vi.setSystemTime(2000);
    registry.recordActivity("telegram", "tg-123");
    expect(registry.getLastActivityTime()).toBe(2000);
    expect(registry.getActiveChatIds()).toEqual([
      { channelName: "web", chatId: "chat-1", lastActivity: 1000 },
      { channelName: "telegram", chatId: "tg-123", lastActivity: 2000 },
    ]);
  });

  it("should update existing chat activity time", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    vi.setSystemTime(1000);
    registry.recordActivity("web", "chat-1");
    vi.setSystemTime(5000);
    registry.recordActivity("web", "chat-1");
    const chats = registry.getActiveChatIds();
    expect(chats).toHaveLength(1);
    expect(chats[0].lastActivity).toBe(5000);
  });

  it("should detect idle state based on timeout", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    vi.setSystemTime(1000);
    registry.recordActivity("web", "chat-1");
    vi.setSystemTime(1000 + 4 * 60 * 1000);
    expect(registry.isIdle(5)).toBe(false);
    vi.setSystemTime(1000 + 6 * 60 * 1000);
    expect(registry.isIdle(5)).toBe(true);
  });

  it("should be idle when no activity ever recorded", async () => {
    const { ChannelActivityRegistry } = await import(
      "../../core/channel-activity-registry.js"
    );
    const registry = new ChannelActivityRegistry();
    expect(registry.isIdle(5)).toBe(true);
  });
});
