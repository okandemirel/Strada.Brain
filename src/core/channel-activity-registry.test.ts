import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelActivityRegistry } from "./channel-activity-registry.js";

describe("ChannelActivityRegistry", () => {
  let registry: ChannelActivityRegistry;

  beforeEach(() => {
    registry = new ChannelActivityRegistry();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ========================================================================
  // recordActivity
  // ========================================================================

  describe("recordActivity", () => {
    it("records activity for a channel and chat", () => {
      registry.recordActivity("web", "chat-1");

      const chats = registry.getActiveChatIds();
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({
        channelName: "web",
        chatId: "chat-1",
      });
    });

    it("updates timestamp when same channel+chat is recorded again", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      registry.recordActivity("web", "chat-1");

      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      registry.recordActivity("web", "chat-1");

      const chats = registry.getActiveChatIds();
      expect(chats).toHaveLength(1);
      expect(chats[0]!.lastActivity).toBe(new Date("2026-01-01T01:00:00Z").getTime());
    });

    it("tracks multiple channels independently", () => {
      registry.recordActivity("web", "chat-1");
      registry.recordActivity("telegram", "chat-2");
      registry.recordActivity("discord", "chat-3");

      const chats = registry.getActiveChatIds();
      expect(chats).toHaveLength(3);
      const channelNames = chats.map((c) => c.channelName);
      expect(channelNames).toContain("web");
      expect(channelNames).toContain("telegram");
      expect(channelNames).toContain("discord");
    });

    it("tracks multiple chats on the same channel", () => {
      registry.recordActivity("web", "chat-1");
      registry.recordActivity("web", "chat-2");

      const chats = registry.getActiveChatIds();
      expect(chats).toHaveLength(2);
      const chatIds = chats.map((c) => c.chatId);
      expect(chatIds).toContain("chat-1");
      expect(chatIds).toContain("chat-2");
    });
  });

  // ========================================================================
  // getLastActivityTime
  // ========================================================================

  describe("getLastActivityTime", () => {
    it("returns 0 when no activity has been recorded", () => {
      expect(registry.getLastActivityTime()).toBe(0);
    });

    it("returns the most recent activity timestamp", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      registry.recordActivity("web", "chat-1");

      vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
      registry.recordActivity("telegram", "chat-2");

      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      registry.recordActivity("discord", "chat-3");

      expect(registry.getLastActivityTime()).toBe(
        new Date("2026-01-01T02:00:00Z").getTime(),
      );
    });

    it("reflects updated timestamps after re-recording", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      registry.recordActivity("web", "chat-1");

      vi.setSystemTime(new Date("2026-01-01T05:00:00Z"));
      registry.recordActivity("web", "chat-1");

      expect(registry.getLastActivityTime()).toBe(
        new Date("2026-01-01T05:00:00Z").getTime(),
      );
    });
  });

  // ========================================================================
  // getActiveChatIds
  // ========================================================================

  describe("getActiveChatIds", () => {
    it("returns an empty array when no activity exists", () => {
      expect(registry.getActiveChatIds()).toEqual([]);
    });

    it("returns all recorded chat activities", () => {
      registry.recordActivity("web", "chat-1");
      registry.recordActivity("telegram", "chat-2");

      const chats = registry.getActiveChatIds();
      expect(chats).toHaveLength(2);
      expect(chats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channelName: "web", chatId: "chat-1" }),
          expect.objectContaining({ channelName: "telegram", chatId: "chat-2" }),
        ]),
      );
    });

    it("returns a new array each time (not the internal reference)", () => {
      registry.recordActivity("web", "chat-1");
      const first = registry.getActiveChatIds();
      const second = registry.getActiveChatIds();
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });
  });

  // ========================================================================
  // isIdle
  // ========================================================================

  describe("isIdle", () => {
    it("returns true when no activity has been recorded", () => {
      expect(registry.isIdle(5)).toBe(true);
    });

    it("returns false when last activity is within timeout", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      registry.recordActivity("web", "chat-1");

      // Advance only 2 minutes, timeout is 5 minutes
      vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
      expect(registry.isIdle(5)).toBe(false);
    });

    it("returns true when last activity exceeds timeout", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      registry.recordActivity("web", "chat-1");

      // Advance 10 minutes, timeout is 5 minutes
      vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
      expect(registry.isIdle(5)).toBe(true);
    });

    it("returns false at exact boundary (elapsed equals timeout)", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      registry.recordActivity("web", "chat-1");

      // Exactly 5 minutes later
      vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
      expect(registry.isIdle(5)).toBe(false);
    });

    it("respects the most recent activity across all channels", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      registry.recordActivity("web", "chat-1");

      vi.setSystemTime(new Date("2026-01-01T00:08:00Z"));
      registry.recordActivity("telegram", "chat-2");

      // 3 minutes after last activity — within 5-minute timeout
      vi.setSystemTime(new Date("2026-01-01T00:11:00Z"));
      expect(registry.isIdle(5)).toBe(false);

      // 6 minutes after last activity — exceeds timeout
      vi.setSystemTime(new Date("2026-01-01T00:14:01Z"));
      expect(registry.isIdle(5)).toBe(true);
    });

    it("handles zero timeout (always idle unless activity is at exact same ms)", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      registry.recordActivity("web", "chat-1");

      // Same millisecond: elapsed = 0, timeout = 0 → 0 > 0 is false
      expect(registry.isIdle(0)).toBe(false);

      // Any time advance makes it idle
      vi.advanceTimersByTime(1);
      expect(registry.isIdle(0)).toBe(true);
    });
  });
});
