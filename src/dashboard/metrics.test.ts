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
});
