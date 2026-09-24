/**
 * COR-15: an update runs only after every chat has been idle for the idle
 * window, so notices sent only to chats active WITHIN that window reached
 * nobody.
 */
import { describe, expect, it, vi } from "vitest";
import { ChannelActivityRegistry } from "../channel-activity-registry.js";
import { selectUpdateNoticeChats } from "./stage-runtime.js";

describe("selectUpdateNoticeChats (COR-15)", () => {
  const idleWindowMs = 5 * 60_000;

  it("falls back to the most recent chat when nobody spoke within the idle window", () => {
    const start = Date.now();
    vi.useFakeTimers({ now: start });
    try {
      const registry = new ChannelActivityRegistry();
      registry.recordActivity("web", "older");
      vi.setSystemTime(start + 60_000);
      registry.recordActivity("web", "latest");
      // Both went quiet before the idle-gated update ran.
      vi.setSystemTime(start + 60_000 + 2 * idleWindowMs);

      expect(selectUpdateNoticeChats(registry, idleWindowMs).map((chat) => chat.chatId)).toEqual(["latest"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps notifying only the recently active chats when there are some (guard)", () => {
    const registry = new ChannelActivityRegistry();
    registry.recordActivity("web", "active");
    expect(selectUpdateNoticeChats(registry, idleWindowMs).map((chat) => chat.chatId)).toEqual(["active"]);
  });

  it("notifies nobody when no chat ever spoke", () => {
    expect(selectUpdateNoticeChats(new ChannelActivityRegistry(), idleWindowMs)).toEqual([]);
  });
});
