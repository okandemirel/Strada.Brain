import { describe, it, expect } from "vitest";
import { MetricsCollector } from "./metrics.js";

describe("MetricsCollector", () => {
  it("starts with zero counters", () => {
    const mc = new MetricsCollector();
    const snap = mc.getSnapshot();
    expect(snap.totalMessages).toBe(0);
    expect(snap.totalTokens.input).toBe(0);
    expect(snap.totalTokens.output).toBe(0);
    expect(snap.activeSessions).toBe(0);
  });

  it("records messages", () => {
    const mc = new MetricsCollector();
    mc.recordMessage();
    mc.recordMessage();
    expect(mc.getSnapshot().totalMessages).toBe(2);
  });

  it("accumulates token usage", () => {
    const mc = new MetricsCollector();
    mc.recordTokenUsage(100, 50, "claude");
    mc.recordTokenUsage(200, 80, "claude");

    const snap = mc.getSnapshot();
    expect(snap.totalTokens.input).toBe(300);
    expect(snap.totalTokens.output).toBe(130);
    expect(snap.providerName).toBe("claude");
  });

  it("keeps recent token usage entries", () => {
    const mc = new MetricsCollector();
    mc.recordTokenUsage(100, 50, "claude");
    mc.recordTokenUsage(200, 80, "openai");

    const snap = mc.getSnapshot();
    expect(snap.recentTokenUsage).toHaveLength(2);
    expect(snap.recentTokenUsage[0]!.provider).toBe("claude");
    expect(snap.recentTokenUsage[1]!.provider).toBe("openai");
  });

  it("records tool calls and errors", () => {
    const mc = new MetricsCollector();
    mc.recordToolCall("file_read", 10, true);
    mc.recordToolCall("file_read", 15, true);
    mc.recordToolCall("file_write", 50, false);

    const snap = mc.getSnapshot();
    expect(snap.toolCallCounts["file_read"]).toBe(2);
    expect(snap.toolCallCounts["file_write"]).toBe(1);
    expect(snap.toolErrorCounts["file_write"]).toBe(1);
    expect(snap.toolErrorCounts["file_read"]).toBeUndefined();
  });

  it("tracks active sessions", () => {
    const mc = new MetricsCollector();
    mc.setActiveSessions(5);
    expect(mc.getSnapshot().activeSessions).toBe(5);
  });

  it("includes memory stats when provided", () => {
    const mc = new MetricsCollector();
    const stats = { totalEntries: 42, hasAnalysisCache: true };
    const snap = mc.getSnapshot(stats);
    expect(snap.memoryStats).toEqual(stats);
  });

  it("tracks uptime", () => {
    const mc = new MetricsCollector();
    const snap = mc.getSnapshot();
    expect(snap.uptime).toBeGreaterThanOrEqual(0);
    expect(snap.uptime).toBeLessThan(1000);
  });

  // --- recentTokenUsage max-size boundary ---

  it("caps recentTokenUsage at 100 entries", () => {
    const mc = new MetricsCollector();
    for (let i = 0; i < 110; i++) {
      mc.recordTokenUsage(10, 5, `provider-${i}`);
    }
    const snap = mc.getSnapshot();
    expect(snap.recentTokenUsage).toHaveLength(100);
    // The oldest 10 entries should have been evicted; first remaining is provider-10
    expect(snap.recentTokenUsage[0]!.provider).toBe("provider-10");
    expect(snap.recentTokenUsage[99]!.provider).toBe("provider-109");
  });

  it("does not exceed 100 entries even after many small bursts", () => {
    const mc = new MetricsCollector();
    // Fill to exactly 100
    for (let i = 0; i < 100; i++) {
      mc.recordTokenUsage(1, 1, "burst");
    }
    expect(mc.getSnapshot().recentTokenUsage).toHaveLength(100);

    // Add one more — should still be capped at 100
    mc.recordTokenUsage(1, 1, "overflow");
    const snap = mc.getSnapshot();
    expect(snap.recentTokenUsage).toHaveLength(100);
    expect(snap.recentTokenUsage[99]!.provider).toBe("overflow");
  });

  it("still accumulates total tokens even when recent entries are evicted", () => {
    const mc = new MetricsCollector();
    for (let i = 0; i < 150; i++) {
      mc.recordTokenUsage(10, 5, "p");
    }
    const snap = mc.getSnapshot();
    expect(snap.recentTokenUsage).toHaveLength(100);
    // Total tokens should reflect all 150 recordings, not just the kept 100
    expect(snap.totalTokens.input).toBe(1500);
    expect(snap.totalTokens.output).toBe(750);
  });

  // --- recordSecretSanitized ---

  it("records secret sanitized events with default count", () => {
    const mc = new MetricsCollector();
    mc.recordSecretSanitized();
    mc.recordSecretSanitized();
    const snap = mc.getSnapshot();
    expect(snap.securityStats!.secretsSanitized).toBe(2);
  });

  it("records secret sanitized events with explicit count", () => {
    const mc = new MetricsCollector();
    mc.recordSecretSanitized(5);
    mc.recordSecretSanitized(3);
    const snap = mc.getSnapshot();
    expect(snap.securityStats!.secretsSanitized).toBe(8);
  });

  it("records secret sanitized with count of zero (no-op addition)", () => {
    const mc = new MetricsCollector();
    mc.recordSecretSanitized(0);
    expect(mc.getSnapshot().securityStats!.secretsSanitized).toBe(0);
  });

  // --- recordToolBlocked ---

  it("records tool blocked events", () => {
    const mc = new MetricsCollector();
    mc.recordToolBlocked();
    mc.recordToolBlocked();
    mc.recordToolBlocked();
    const snap = mc.getSnapshot();
    expect(snap.securityStats!.toolsBlocked).toBe(3);
  });

  it("security stats start at zero", () => {
    const mc = new MetricsCollector();
    const snap = mc.getSnapshot();
    expect(snap.securityStats).toEqual({
      secretsSanitized: 0,
      toolsBlocked: 0,
    });
  });

  // --- getSnapshot with various memoryStats states ---

  it("returns null memoryStats when no argument is passed", () => {
    const mc = new MetricsCollector();
    const snap = mc.getSnapshot();
    expect(snap.memoryStats).toBeNull();
  });

  it("returns null memoryStats when undefined is passed explicitly", () => {
    const mc = new MetricsCollector();
    const snap = mc.getSnapshot(undefined);
    expect(snap.memoryStats).toBeNull();
  });

  it("returns provided memoryStats with zero entries", () => {
    const mc = new MetricsCollector();
    const stats = { totalEntries: 0, hasAnalysisCache: false };
    const snap = mc.getSnapshot(stats);
    expect(snap.memoryStats).toEqual(stats);
  });

  it("returns a defensive copy of recentTokenUsage (not a reference)", () => {
    const mc = new MetricsCollector();
    mc.recordTokenUsage(100, 50, "test");
    const snap1 = mc.getSnapshot();
    const snap2 = mc.getSnapshot();
    // They should be equal but not the same reference
    expect(snap1.recentTokenUsage).toEqual(snap2.recentTokenUsage);
    expect(snap1.recentTokenUsage).not.toBe(snap2.recentTokenUsage);
  });

  // --- readOnlyMode ---

  it("defaults readOnlyMode to false", () => {
    const mc = new MetricsCollector();
    expect(mc.getSnapshot().readOnlyMode).toBe(false);
  });

  it("reflects readOnlyMode changes in snapshot", () => {
    const mc = new MetricsCollector();
    mc.setReadOnlyMode(true);
    expect(mc.getSnapshot().readOnlyMode).toBe(true);
    mc.setReadOnlyMode(false);
    expect(mc.getSnapshot().readOnlyMode).toBe(false);
  });

  // --- providerName ---

  it("defaults providerName to unknown", () => {
    const mc = new MetricsCollector();
    expect(mc.getSnapshot().providerName).toBe("unknown");
  });

  it("updates providerName to last recorded provider", () => {
    const mc = new MetricsCollector();
    mc.recordTokenUsage(10, 5, "openai");
    mc.recordTokenUsage(20, 10, "gemini");
    expect(mc.getSnapshot().providerName).toBe("gemini");
  });

  // --- getStartTime ---

  it("getStartTime returns a reasonable epoch timestamp", () => {
    const before = Date.now();
    const mc = new MetricsCollector();
    const after = Date.now();
    expect(mc.getStartTime()).toBeGreaterThanOrEqual(before);
    expect(mc.getStartTime()).toBeLessThanOrEqual(after);
  });

  // --- Concurrent / interleaved recording operations ---

  it("handles interleaved operations across all recording methods", () => {
    const mc = new MetricsCollector();

    mc.recordMessage();
    mc.recordTokenUsage(100, 50, "claude");
    mc.recordToolCall("exec", 30, true);
    mc.recordSecretSanitized(2);
    mc.recordToolBlocked();
    mc.recordMessage();
    mc.recordTokenUsage(200, 80, "openai");
    mc.recordToolCall("exec", 10, false);
    mc.recordSecretSanitized();
    mc.recordToolBlocked();
    mc.setActiveSessions(3);

    const snap = mc.getSnapshot();
    expect(snap.totalMessages).toBe(2);
    expect(snap.totalTokens.input).toBe(300);
    expect(snap.totalTokens.output).toBe(130);
    expect(snap.recentTokenUsage).toHaveLength(2);
    expect(snap.toolCallCounts["exec"]).toBe(2);
    expect(snap.toolErrorCounts["exec"]).toBe(1);
    expect(snap.securityStats!.secretsSanitized).toBe(3);
    expect(snap.securityStats!.toolsBlocked).toBe(2);
    expect(snap.activeSessions).toBe(3);
    expect(snap.providerName).toBe("openai");
  });

  it("handles concurrent-style Promise.all recording without corruption", async () => {
    const mc = new MetricsCollector();

    // Simulate concurrent recording by running many operations in parallel promises
    const operations = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => {
        mc.recordMessage();
        mc.recordTokenUsage(10, 5, `p-${i}`);
        mc.recordToolCall(`tool-${i % 5}`, 10, i % 3 !== 0);
      }),
    );

    await Promise.all(operations);

    const snap = mc.getSnapshot();
    expect(snap.totalMessages).toBe(50);
    expect(snap.totalTokens.input).toBe(500);
    expect(snap.totalTokens.output).toBe(250);
    expect(snap.recentTokenUsage).toHaveLength(50);
    // 5 distinct tool names (tool-0 through tool-4)
    expect(Object.keys(snap.toolCallCounts)).toHaveLength(5);
  });

  // --- Multiple tool calls with mixed success/failure ---

  it("tracks errors independently per tool name", () => {
    const mc = new MetricsCollector();
    mc.recordToolCall("read", 5, true);
    mc.recordToolCall("read", 5, false);
    mc.recordToolCall("write", 10, false);
    mc.recordToolCall("write", 10, false);
    mc.recordToolCall("delete", 15, true);

    const snap = mc.getSnapshot();
    expect(snap.toolCallCounts["read"]).toBe(2);
    expect(snap.toolCallCounts["write"]).toBe(2);
    expect(snap.toolCallCounts["delete"]).toBe(1);
    expect(snap.toolErrorCounts["read"]).toBe(1);
    expect(snap.toolErrorCounts["write"]).toBe(2);
    expect(snap.toolErrorCounts["delete"]).toBeUndefined();
  });

  // --- Snapshot isolation ---

  it("snapshot is not affected by subsequent mutations", () => {
    const mc = new MetricsCollector();
    mc.recordMessage();
    mc.recordTokenUsage(100, 50, "claude");

    const snap = mc.getSnapshot();

    // Mutate after snapshot
    mc.recordMessage();
    mc.recordMessage();
    mc.recordTokenUsage(200, 100, "openai");

    // Original snapshot should be unchanged
    expect(snap.totalMessages).toBe(1);
    expect(snap.totalTokens.input).toBe(100);
    expect(snap.recentTokenUsage).toHaveLength(1);
    expect(snap.providerName).toBe("claude");
  });
});
