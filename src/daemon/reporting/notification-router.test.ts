import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NotificationRouter } from "./notification-router.js";
import { DaemonStorage } from "../daemon-storage.js";
import { TypedEventBus } from "../../core/event-bus.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonEventMap } from "../daemon-events.js";
import type { NotificationConfig, QuietHoursConfig } from "./notification-types.js";
import type { IChannelSender } from "../../channels/channel-core.interface.js";
import { HubChannel } from "../../channels/hub/hub-channel.js";
import type { IChannelAdapter } from "../../channels/channel.interface.js";
import type { IncomingMessage } from "../../channels/channel-messages.interface.js";

describe("NotificationRouter", () => {
  let storage: DaemonStorage;
  let tmpDir: string;
  let eventBus: TypedEventBus<DaemonEventMap>;
  let mockSender: IChannelSender;

  const defaultNotifConfig: NotificationConfig = {
    minLevel: "low",
    routing: {
      silent: ["dashboard"],
      low: ["dashboard"],
      medium: ["dashboard"],
      high: ["chat", "dashboard"],
      critical: ["chat", "dashboard"],
    },
    groupingWindowMs: 30000,
  };

  const defaultQuietConfig: QuietHoursConfig = {
    enabled: false,
    startHour: 22,
    endHour: 8,
    timezone: "UTC",
    bufferMax: 100,
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "notif-router-test-"));
    storage = new DaemonStorage(join(tmpDir, "daemon.db"));
    storage.initialize();
    eventBus = new TypedEventBus<DaemonEventMap>();
    mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRouter(overrides?: {
    config?: Partial<NotificationConfig>;
    quietConfig?: Partial<QuietHoursConfig>;
  }): NotificationRouter {
    return new NotificationRouter({
      config: { ...defaultNotifConfig, ...overrides?.config },
      quietHoursConfig: { ...defaultQuietConfig, ...overrides?.quietConfig },
      eventBus,
      storage,
      channelSender: mockSender,
      chatId: "test-chat",
    });
  }

  describe("notify()", () => {
    it("with urgency 'low' routes to configured channels", async () => {
      const router = createRouter();
      await router.notify({
        level: "low",
        title: "Task complete",
        message: "Goal finished",
        timestamp: Date.now(),
      });

      // Should log to notification history
      const history = storage.getNotificationHistory(10);
      expect(history).toHaveLength(1);
      expect(history[0].title).toBe("Task complete");
      expect(history[0].deliveredTo).toContain("dashboard");
    });

    it("keeps medium urgency out of chat by default", async () => {
      const router = createRouter();
      await router.notify({
        level: "medium",
        title: "Budget warning",
        message: "80%",
        timestamp: Date.now(),
      });

      expect(mockSender.sendMarkdown).not.toHaveBeenCalled();
      const history = storage.getNotificationHistory(10);
      expect(history[0].deliveredTo).toEqual(["dashboard"]);
    });

    it("with urgency below minLevel is suppressed (not delivered)", async () => {
      const router = createRouter({ config: { minLevel: "medium" } });
      await router.notify({
        level: "low",
        title: "Suppressed",
        message: "Should not appear",
        timestamp: Date.now(),
      });

      const history = storage.getNotificationHistory(10);
      expect(history).toHaveLength(0);
    });

    it("with 'silent' urgency logs to history but never delivers to channels", async () => {
      const router = createRouter({ config: { minLevel: "silent" } });
      await router.notify({
        level: "silent",
        title: "Heartbeat tick",
        message: "Daemon ticked",
        timestamp: Date.now(),
      });

      const history = storage.getNotificationHistory(10);
      expect(history).toHaveLength(1);
      expect(history[0].deliveredTo).toEqual(["dashboard"]);
      // sendMarkdown should NOT be called for silent
      expect(mockSender.sendMarkdown).not.toHaveBeenCalled();
    });
  });

  describe("EventBus auto-routing", () => {
    it("auto-routes daemon:trigger_fired as 'low'", async () => {
      const router = createRouter();
      router.start();

      eventBus.emit("daemon:trigger_fired", {
        triggerName: "daily-check",
        taskId: "task-1",
        timestamp: Date.now(),
      });

      // Give async handlers time to process
      await new Promise((r) => setTimeout(r, 50));

      const history = storage.getNotificationHistory(10);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].urgency).toBe("low");
      expect(history[0].title).toContain("daily-check");

      router.stop();
    });

    it("auto-routes daemon:budget_exceeded as 'high'", async () => {
      const router = createRouter();
      router.start();

      eventBus.emit("daemon:budget_exceeded", {
        usedUsd: 5.5,
        limitUsd: 5.0,
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 50));

      const history = storage.getNotificationHistory(10);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].urgency).toBe("high");

      router.stop();
    });

    it("auto-routes daemon:trigger_failed as 'medium'", async () => {
      const router = createRouter();
      router.start();

      eventBus.emit("daemon:trigger_failed", {
        triggerName: "morning-scan",
        error: "timeout",
        circuitState: "OPEN",
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 50));

      const history = storage.getNotificationHistory(10);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].urgency).toBe("medium");

      router.stop();
    });

    it("stop unsubscribes daemon event listeners", async () => {
      const router = createRouter();
      router.start();
      router.stop();

      eventBus.emit("daemon:trigger_fired", {
        triggerName: "after-stop",
        taskId: "task-2",
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(storage.getNotificationHistory(10)).toHaveLength(0);
    });
  });

  describe("time-window grouping", () => {
    it("collapses 5 same-type events within groupingWindowMs into single notification with count", async () => {
      const router = createRouter({ config: { groupingWindowMs: 30000 } });
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        await router.notify({
          level: "low",
          title: "Trigger fired",
          message: "Daily check",
          sourceEvent: "daemon:trigger_fired",
          timestamp: now + i * 100,
        });
      }

      const history = storage.getNotificationHistory(10);
      // First notification delivered immediately, rest grouped
      // After grouping, should have fewer than 5 in history
      // The first goes through, then the rest are collapsed
      expect(history.length).toBeLessThan(5);
    });
  });

  describe("per-urgency rate limiting", () => {
    it("limits low urgency to 1 per minute", async () => {
      const router = createRouter();
      const now = Date.now();

      // Send 3 rapid low notifications with distinct titles to avoid grouping
      for (let i = 0; i < 3; i++) {
        await router.notify({
          level: "low",
          title: `Task ${i}`,
          message: `Message ${i}`,
          timestamp: now + i,
        });
      }

      const history = storage.getNotificationHistory(10);
      // Only 1 should get through per minute for low
      expect(history.length).toBe(1);
    });

    it("critical urgency is unlimited", async () => {
      const router = createRouter();
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        await router.notify({
          level: "critical",
          title: `Critical ${i}`,
          message: `Emergency ${i}`,
          timestamp: now + i,
        });
      }

      const history = storage.getNotificationHistory(10, "critical");
      expect(history.length).toBe(5);
    });
  });

  describe("quiet hours integration", () => {
    it("during quiet hours, non-critical notifications buffered instead of delivered", async () => {
      // Pin the clock to UTC noon so the [0,23) quiet window is unambiguously active. The router
      // reads the wall clock (isQuietHours() with no arg → new Date()), so without this the test
      // flaked at 23:00–23:59 UTC, where hour 23 ∉ [0,23). timezone is "UTC" (defaultQuietConfig).
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-21T12:00:00Z"));
      const router = createRouter({
        quietConfig: {
          enabled: true,
          startHour: 0,
          endHour: 23,
        },
      });

      await router.notify({
        level: "medium",
        title: "Budget warning",
        message: "80%",
        timestamp: Date.now(),
      });

      // Should be in buffer, not history
      const buffered = storage.getBufferedNotifications();
      expect(buffered.length).toBeGreaterThanOrEqual(1);
    });

    it("critical urgency bypasses quiet hours and delivers immediately", async () => {
      const router = createRouter({
        quietConfig: {
          enabled: true,
          startHour: 0,
          endHour: 23,
        },
      });

      await router.notify({
        level: "critical",
        title: "Security breach",
        message: "Unauthorized access",
        timestamp: Date.now(),
      });

      // Should be in history (delivered), not just buffered
      const history = storage.getNotificationHistory(10, "critical");
      expect(history.length).toBe(1);
    });
  });

  describe("getHistory()", () => {
    it("delegates to storage getNotificationHistory", async () => {
      const router = createRouter();
      await router.notify({
        level: "medium",
        title: "Test",
        message: "msg",
        timestamp: Date.now(),
      });

      const history = router.getHistory(10);
      expect(history).toHaveLength(1);
      expect(history[0].title).toBe("Test");
    });

    it("filters by urgency level when provided", async () => {
      const router = createRouter();
      const now = Date.now();

      // Send different urgency notifications with enough spread to avoid rate limiting
      await router.notify({
        level: "medium",
        title: "Medium 1",
        message: "msg",
        timestamp: now,
      });
      await router.notify({
        level: "high",
        title: "High 1",
        message: "msg",
        timestamp: now + 1,
      });

      const highOnly = router.getHistory(10, "high");
      expect(highOnly.every((h) => h.urgency === "high")).toBe(true);
    });
  });

  describe("high urgency routing to chat", () => {
    it("sends markdown to chat channel for high urgency", async () => {
      const router = createRouter();
      await router.notify({
        level: "high",
        title: "Budget exceeded",
        message: "Budget exhausted: $15.00 / $10.00",
        actionHint: "Run: strada daemon budget reset",
        timestamp: Date.now(),
      });

      expect(mockSender.sendMarkdown).toHaveBeenCalledWith(
        "test-chat",
        expect.stringContaining("Budget exceeded"),
      );
    });

    it("formats notification with action hint", async () => {
      const router = createRouter();
      await router.notify({
        level: "high",
        title: "Alert",
        message: "Something happened",
        actionHint: "Do something",
        timestamp: Date.now(),
      });

      const markdown = (mockSender.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(markdown).toContain("[HIGH]");
      expect(markdown).toContain("Alert");
      expect(markdown).toContain("> Do something");
    });
  });

  describe("notification without channel sender", () => {
    it("works when no channelSender is provided", async () => {
      const router = new NotificationRouter({
        config: defaultNotifConfig,
        quietHoursConfig: defaultQuietConfig,
        eventBus,
        storage,
        // No channelSender
      });

      await router.notify({
        level: "high",
        title: "No sender",
        message: "Should not crash",
        timestamp: Date.now(),
      });

      const history = storage.getNotificationHistory(10);
      expect(history).toHaveLength(1);
    });
  });

  describe("event emission", () => {
    it("emits daemon:notification_routed after delivery", async () => {
      const routedEvents: unknown[] = [];
      eventBus.on("daemon:notification_routed", (e) => routedEvents.push(e));

      const router = createRouter();
      await router.notify({
        level: "medium",
        title: "Test event",
        message: "Check emission",
        timestamp: Date.now(),
      });

      expect(routedEvents).toHaveLength(1);
      expect(routedEvents[0]).toEqual(
        expect.objectContaining({
          urgency: "medium",
          title: "Test event",
          buffered: false,
        }),
      );
    });

    it("emits buffered=true when notification is buffered during quiet hours", async () => {
      // Pin the clock to UTC noon so the [0,23) quiet window is unambiguously active (see the
      // buffering test above) — otherwise this flaked at 23:00–23:59 UTC where hour 23 ∉ [0,23).
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-21T12:00:00Z"));
      const routedEvents: unknown[] = [];
      eventBus.on("daemon:notification_routed", (e) => routedEvents.push(e));

      const router = createRouter({
        quietConfig: {
          enabled: true,
          startHour: 0,
          endHour: 23,
        },
      });

      await router.notify({
        level: "medium",
        title: "Quiet notification",
        message: "buffered",
        timestamp: Date.now(),
      });

      expect(routedEvents).toHaveLength(1);
      expect(routedEvents[0]).toEqual(
        expect.objectContaining({
          buffered: true,
        }),
      );
    });
  });

  describe("grouping window expiry", () => {
    it("groups rapid-fire same-source events within the window", async () => {
      const router = createRouter({ config: { groupingWindowMs: 5000 } });
      const now = Date.now();

      // First notification starts the group window
      await router.notify({
        level: "medium",
        title: "Trigger fired",
        message: "First",
        sourceEvent: "daemon:trigger_fired",
        timestamp: now,
      });

      // Two more within window (grouped -- not delivered)
      await router.notify({
        level: "medium",
        title: "Trigger fired",
        message: "Second",
        sourceEvent: "daemon:trigger_fired",
        timestamp: now + 100,
      });
      await router.notify({
        level: "medium",
        title: "Trigger fired",
        message: "Third",
        sourceEvent: "daemon:trigger_fired",
        timestamp: now + 200,
      });

      const history = storage.getNotificationHistory(10);
      // Only the first notification should be in history (others grouped)
      const triggerEntries = history.filter((h) => h.title.includes("Trigger fired"));
      expect(triggerEntries.length).toBe(1);
    });
  });

  describe("medium urgency rate limit", () => {
    it("allows up to 5 medium notifications per minute", async () => {
      const router = createRouter();
      const now = Date.now();

      for (let i = 0; i < 7; i++) {
        await router.notify({
          level: "medium",
          title: `Medium ${i}`,
          message: `Msg ${i}`,
          timestamp: now + i,
        });
      }

      const history = storage.getNotificationHistory(20, "medium");
      // Should be capped at 5 per minute for medium
      expect(history.length).toBeLessThanOrEqual(5);
    });
  });

  describe("goal events auto-routing", () => {
    it("auto-routes goal:failed as high urgency", async () => {
      const router = createRouter();
      router.start();

      eventBus.emit("goal:failed", {
        rootId: "goal-1",
        error: "timeout",
        failureCount: 3,
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 50));

      const history = storage.getNotificationHistory(10);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].urgency).toBe("high");

      router.stop();
    });

    it("auto-routes goal:complete as low urgency", async () => {
      const router = createRouter();
      router.start();

      eventBus.emit("goal:complete", {
        rootId: "goal-2",
        taskDescription: "Fix bug",
        durationMs: 5000,
        successCount: 1,
        failureCount: 0,
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 50));

      const history = storage.getNotificationHistory(10);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].urgency).toBe("low");

      router.stop();
    });
  });

  // Plan 2.9 (audit 12F1/D58): a notification carries the owner's chatId and
  // channelType from the task/goal row, the hub routes by them, and the
  // fallback is the configured/first-bound chat — never the last chat that spoke.
  describe("owner routing (2.9)", () => {
    type Member = IChannelAdapter & { handler?: (msg: IncomingMessage) => Promise<void>; sent: Array<[string, string]> };
    function member(name: string): Member {
      const m: Member = {
        name,
        sent: [],
        connect: async () => undefined,
        disconnect: async () => undefined,
        isHealthy: () => true,
        onMessage(handler) {
          m.handler = handler;
        },
        sendText: async (chatId, text) => {
          m.sent.push([chatId, text]);
        },
        sendMarkdown: async (chatId, md) => {
          m.sent.push([chatId, md]);
        },
      };
      return m;
    }
    const inbound = (chatId: string, channelType: string): IncomingMessage =>
      ({ chatId, channelType, userId: "u", text: "hi", timestamp: new Date() }) as IncomingMessage;

    it("delivers chat A's goal notification to A's channel after chat B spoke last, and never falls back to the last inbound", async () => {
      const slack = member("slack");
      const tg = member("telegram");
      const hub = new HubChannel([slack, tg], { ownerStore: null });
      const router = new NotificationRouter({
        config: { ...defaultNotifConfig, routing: { ...defaultNotifConfig.routing, low: ["chat", "dashboard"] } },
        quietHoursConfig: defaultQuietConfig,
        eventBus,
        storage,
        channelSender: hub,
        chatId: undefined,
      });
      // Bootstrap wiring: every inbound message offers its chat id.
      hub.onMessage(async (msg) => router.setChatId(msg.chatId));
      await slack.handler!(inbound("C1:1700000000.000001", "slack")); // chat A
      await tg.handler!(inbound("777", "telegram")); // chat B spoke last

      router.start();
      eventBus.emit("goal:complete", {
        rootId: "root-A",
        taskDescription: "ship it",
        durationMs: 1000,
        successCount: 1,
        failureCount: 0,
        timestamp: Date.now(),
        chatId: "C1:1700000000.000001",
        channelType: "slack",
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(slack.sent).toHaveLength(1);
      expect(slack.sent[0]![0]).toBe("C1:1700000000.000001");
      expect(slack.sent[0]![1]).toContain("ship it");
      expect(tg.sent).toEqual([]);

      // A chat the hub never saw since boot: the owner row alone routes it.
      await router.notify({ level: "high", title: "Goal failed: x", message: "m", timestamp: Date.now() + 1, chatId: "C9:1700000000.000009", channelType: "slack" });
      expect(slack.sent).toHaveLength(2);
      expect(slack.sent[1]![0]).toBe("C9:1700000000.000009");
      expect(tg.sent).toEqual([]);

      // Owner-less (daemon-wide) notification: the first-bound chat, not B.
      await router.notify({ level: "critical", title: "Budget exceeded", message: "m", timestamp: Date.now() + 2 });
      expect(router.fallbackChatId()).toBe("C1:1700000000.000001");
      expect(slack.sent).toHaveLength(3);
      expect(tg.sent).toEqual([]);
      router.stop();
    });

    it("keeps a configured admin chat as the fallback over any inbound", async () => {
      const router = createRouter(); // chatId: "test-chat"
      router.setChatId("someone-else");
      await router.notify({ level: "high", title: "t", message: "m", timestamp: Date.now() });
      expect(mockSender.sendMarkdown).toHaveBeenCalledWith("test-chat", expect.any(String));
    });
  });

  /**
   * Codex round 8 #6, #8, #9 on 4a5d19e4: a notification whose owning channel
   * is absent went to another channel; three chats' same-event notifications
   * collapsed into one group so two of them got nothing; and a quiet-hours
   * drain sent every buffered title to the fallback chat.
   */
  describe("a notification belongs to its owner (round 8)", () => {
    it("is not delivered elsewhere when the owning channel is not configured (#6)", async () => {
      mockSender.bindOwner = vi.fn().mockReturnValue(false);
      const router = createRouter();
      await router.notify({
        level: "high",
        title: "Slack-owned goal finished",
        message: "done",
        timestamp: Date.now(),
        chatId: "C123:1700.1",
        channelType: "slack",
      });
      expect(mockSender.bindOwner).toHaveBeenCalledWith("C123:1700.1", "slack");
      expect(mockSender.sendMarkdown).not.toHaveBeenCalled();
    });

    it("groups per owner, so each chat hears about its own work (#8)", async () => {
      mockSender.bindOwner = vi.fn().mockReturnValue(true);
      const router = createRouter({ config: { groupingWindowMs: 60_000 } });
      const at = Date.now();
      for (const chatId of ["chat-a", "chat-b", "chat-c"]) {
        await router.notify({
          level: "high",
          title: `Goal finished in ${chatId}`,
          message: "done",
          timestamp: at,
          sourceEvent: "goal:complete",
          chatId,
          channelType: "web",
        });
      }
      const targets = mockSender.sendMarkdown.mock.calls.map((call) => call[0] as string);
      expect(new Set(targets)).toEqual(new Set(["chat-a", "chat-b", "chat-c"]));
      // …and a REPEAT within one owner's window still groups rather than repeating.
      mockSender.sendMarkdown.mockClear();
      await router.notify({
        level: "high", title: "Goal finished in chat-a", message: "done",
        timestamp: at + 1000, sourceEvent: "goal:complete", chatId: "chat-a", channelType: "web",
      });
      expect(mockSender.sendMarkdown).not.toHaveBeenCalled();
    });

    it("drains quiet-hours buffers to their own chats (#9)", async () => {
      mockSender.bindOwner = vi.fn().mockReturnValue(true);
      // Quiet hours for the whole day: nothing below critical is delivered now.
      const router = createRouter({ quietConfig: { enabled: true, startHour: 0, endHour: 24 } });
      const at = Date.now();
      await router.notify({
        level: "high", title: "A's private goal", message: "a", timestamp: at,
        chatId: "chat-a", channelType: "web",
      });
      await router.notify({
        level: "high", title: "B's private goal", message: "b", timestamp: at + 1,
        chatId: "chat-b", channelType: "web",
      });
      expect(mockSender.sendMarkdown).not.toHaveBeenCalled();

      await router.drainBufferedNotifications(at + 2);
      const byChat = new Map(
        mockSender.sendMarkdown.mock.calls.map((call) => [call[0] as string, call[1] as string]),
      );
      expect([...byChat.keys()].sort()).toEqual(["chat-a", "chat-b"]);
      expect(byChat.get("chat-a")).toContain("A's private goal");
      expect(byChat.get("chat-a")).not.toContain("B's private goal");
      expect(byChat.get("chat-b")).toContain("B's private goal");
      expect(byChat.get("chat-b")).not.toContain("A's private goal");
    });
  });

});
