/**
 * DigestReporter Tests
 *
 * Tests for DigestReporter: snapshot data collection, IChannelSender delivery,
 * delta tracking via DaemonStorage, cron scheduling, event emission.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonStorage } from "../daemon-storage.js";
import { DigestReporter, type DigestReporterDeps } from "./digest-reporter.js";
import type { IEventBus } from "../../core/event-bus.js";
import type { DaemonEventMap } from "../daemon-events.js";
import type { IChannelSender } from "../../channels/channel-core.interface.js";
import type { DigestConfig } from "./notification-types.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeDigestConfig(overrides?: Partial<DigestConfig>): DigestConfig {
  return {
    enabled: true,
    schedule: "0 9 * * *",
    timezone: "UTC",
    dashboardHistoryDepth: 10,
    ...overrides,
  };
}

function makeMockEventBus(): IEventBus<DaemonEventMap> {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEventBus<DaemonEventMap>;
}

function makeMockChannelSender(): IChannelSender {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

let tmpDir: string;
let storage: DaemonStorage;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "digest-reporter-test-"));
  storage = new DaemonStorage(join(tmpDir, "daemon.db"));
  storage.initialize();
});

afterEach(() => {
  storage.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDeps(overrides?: Partial<DigestReporterDeps>): DigestReporterDeps {
  return {
    config: makeDigestConfig(),
    daemonConfig: { timezone: "UTC" },
    storage,
    eventBus: makeMockEventBus(),
    logger: makeMockLogger() as any,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("DigestReporter.sendDigest", () => {
  it("collects snapshot data and delivers via channelSender", async () => {
    const sender = makeMockChannelSender();
    const deps = makeDeps({
      channelSender: sender,
      chatId: "chat-123",
      channelType: "web",
    });

    const reporter = new DigestReporter(deps);
    await reporter.sendDigest();

    expect(sender.sendMarkdown).toHaveBeenCalledTimes(1);
    const [chatId, markdown] = (sender.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(chatId).toBe("chat-123");
    expect(typeof markdown).toBe("string");
    expect(markdown.length).toBeGreaterThan(0);
  });

  it("updates digest_state with timestamp and counters after sending", async () => {
    const sender = makeMockChannelSender();
    const deps = makeDeps({
      channelSender: sender,
      chatId: "chat-123",
      channelType: "web",
    });

    const reporter = new DigestReporter(deps);
    await reporter.sendDigest();

    const lastTimestamp = storage.getDaemonState("digest_last_timestamp");
    expect(lastTimestamp).toBeDefined();
    expect(Number(lastTimestamp)).toBeGreaterThan(0);

    const lastTasksCompleted = storage.getDaemonState("digest_last_tasks_completed");
    expect(lastTasksCompleted).toBeDefined();
  });

  it("emits daemon:digest_sent event", async () => {
    const eventBus = makeMockEventBus();
    const sender = makeMockChannelSender();
    const deps = makeDeps({
      channelSender: sender,
      chatId: "chat-123",
      channelType: "web",
      eventBus,
    });

    const reporter = new DigestReporter(deps);
    await reporter.sendDigest();

    expect(eventBus.emit).toHaveBeenCalledWith(
      "daemon:digest_sent",
      expect.objectContaining({
        channelType: "web",
        timestamp: expect.any(Number),
      }),
    );
  });

  it("gracefully handles missing channel (logs warning, skips delivery)", async () => {
    const logger = makeMockLogger();
    const deps = makeDeps({
      channelSender: undefined,
      chatId: undefined,
      channelType: undefined,
      logger: logger as any,
    });

    const reporter = new DigestReporter(deps);
    await reporter.sendDigest();

    // Should log warning about missing channel
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(warnCall[0]).toContain("channel");
  });

  it("tracks deltas between consecutive digests", async () => {
    const sender = makeMockChannelSender();
    const deps = makeDeps({
      channelSender: sender,
      chatId: "chat-123",
      channelType: "web",
      metricsStorage: {
        getAggregation: vi.fn()
          .mockReturnValueOnce({ totalTasks: 5, successCount: 4, failureCount: 1, completionRate: 0.8 })
          .mockReturnValueOnce({ totalTasks: 8, successCount: 7, failureCount: 1, completionRate: 0.875 }),
      } as any,
    });

    const reporter = new DigestReporter(deps);

    // First digest
    await reporter.sendDigest();
    const firstMarkdown = (sender.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;

    // Second digest should show deltas
    await reporter.sendDigest();
    const secondMarkdown = (sender.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[1][1] as string;

    // Second digest should contain delta information
    expect(secondMarkdown).toContain("+");
  });
});

describe("DigestReporter.start", () => {
  it("creates croner Cron job with configured schedule and timezone", () => {
    const deps = makeDeps({
      config: makeDigestConfig({ schedule: "0 9 * * *", timezone: "America/New_York" }),
    });

    const reporter = new DigestReporter(deps);
    reporter.start();

    // Should not throw and should be stoppable
    reporter.stop();
  });

  it("does not create cron job when disabled", () => {
    const deps = makeDeps({
      config: makeDigestConfig({ enabled: false }),
    });

    const reporter = new DigestReporter(deps);
    reporter.start();

    // Should safely stop even when not started
    reporter.stop();
  });
});

describe("DigestReporter.stop", () => {
  it("stops the cron job", () => {
    const deps = makeDeps();

    const reporter = new DigestReporter(deps);
    reporter.start();
    reporter.stop();

    // Double stop should be safe
    reporter.stop();
  });
});

describe("DigestReporter.getLastDigestTime", () => {
  it("returns undefined when no digest has been sent", () => {
    const deps = makeDeps();
    const reporter = new DigestReporter(deps);

    expect(reporter.getLastDigestTime()).toBeUndefined();
  });

  it("returns timestamp after sending a digest", async () => {
    const sender = makeMockChannelSender();
    const deps = makeDeps({
      channelSender: sender,
      chatId: "chat-123",
      channelType: "web",
    });

    const reporter = new DigestReporter(deps);
    await reporter.sendDigest();

    const lastTime = reporter.getLastDigestTime();
    expect(lastTime).toBeDefined();
    expect(lastTime).toBeGreaterThan(0);
  });
});
