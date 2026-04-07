import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentStatusTool } from "./agent-status.js";
import type { ToolContext } from "./tool-core.interface.js";
import type { DashboardSnapshot } from "../../dashboard/metrics.js";
import { makeIdentityState } from "../../test-helpers.js";
import { resetToolRateLimit } from "./introspection-helpers.js";

function createMockMetrics(overrides?: Partial<DashboardSnapshot>) {
  const snapshot: DashboardSnapshot = {
    uptime: 120000,
    totalMessages: 42,
    activeSessions: 2,
    totalTokens: { input: 1000, output: 500 },
    providerName: "anthropic",
    readOnlyMode: false,
    memoryStats: null,
    recentTokenUsage: [],
    toolCallCounts: { file_read: 10, grep_search: 5 },
    toolErrorCounts: {},
    recentToolErrors: {},
    securityStats: { secretsSanitized: 0, toolsBlocked: 0 },
    ...overrides,
  };

  return {
    getSnapshot: vi.fn(() => snapshot),
    getStartTime: vi.fn(() => Date.now() - 120000),
  };
}

const dummyContext: ToolContext = {
  projectPath: "/tmp/test",
  workingDirectory: "/tmp/test",
  readOnly: false,
};

describe("AgentStatusTool", () => {
  beforeEach(() => {
    resetToolRateLimit("agent_status");
  });

  it("execute({}) returns overview with uptime, messages, sessions (no provider/tokens)", async () => {
    const metrics = createMockMetrics();
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => ["file_read", "grep_search"],
    );

    const result = await tool.execute({}, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("2"); // uptime minutes (120000ms = 2 min)
    expect(result.content).toContain("42"); // totalMessages
    // Provider name and token details should be redacted
    expect(result.content).not.toContain("anthropic");
    expect(result.content).not.toContain("1000 input");
  });

  it('execute({section: "tools"}) returns tool count and tool names', async () => {
    const metrics = createMockMetrics();
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => ["file_read", "grep_search", "shell_exec"],
    );

    const result = await tool.execute({ section: "tools" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("25"); // tool count
    expect(result.content).toContain("file_read");
    expect(result.content).toContain("grep_search");
    expect(result.content).toContain("shell_exec");
  });

  it('execute({section: "memory"}) returns memory stats when available', async () => {
    const metrics = createMockMetrics();
    const getMemoryStats = () => ({ totalEntries: 150, hasAnalysisCache: true });
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => [],
      getMemoryStats,
    );

    const result = await tool.execute({ section: "memory" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("150"); // totalEntries
  });

  it('execute({section: "memory"}) returns "not available" when getMemoryStats is undefined', async () => {
    const metrics = createMockMetrics();
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => [],
      undefined,
    );

    const result = await tool.execute({ section: "memory" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content.toLowerCase()).toContain("not available");
  });

  it('execute({section: "all"}) returns all sections combined', async () => {
    const metrics = createMockMetrics();
    const getMemoryStats = () => ({ totalEntries: 150, hasAnalysisCache: true });
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => ["file_read"],
      getMemoryStats,
    );

    const result = await tool.execute({ section: "all" }, dummyContext);

    expect(result.isError).toBeFalsy();
    // Should contain overview, tools, and memory sections
    expect(result.content).toContain("Overview"); // overview header
    expect(result.content).toContain("25"); // tool count
    expect(result.content).toContain("150"); // memory entries
  });

  it('name is "agent_status" and description mentions operational status', () => {
    const metrics = createMockMetrics();
    const tool = new AgentStatusTool(
      metrics as never,
      () => 0,
      () => [],
    );

    expect(tool.name).toBe("agent_status");
    expect(tool.description.toLowerCase()).toContain("operational status");
  });

  it('execute({section: "identity"}) returns formatted identity data when callback provided', async () => {
    const metrics = createMockMetrics();
    const identityState = makeIdentityState();
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => [],
      undefined,
      () => identityState,
    );

    const result = await tool.execute({ section: "identity" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Identity");
    expect(result.content).toContain("Strada Brain");
    expect(result.content).toContain("5"); // boot count
    expect(result.content).toContain("42"); // messages
    expect(result.content).toContain("10"); // tasks
  });

  it('execute({section: "identity"}) shows unavailable when callback returns undefined', async () => {
    const metrics = createMockMetrics();
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => [],
      undefined,
      () => undefined,
    );

    const result = await tool.execute({ section: "identity" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content.toLowerCase()).toContain("not available");
  });

  it('execute({section: "all"}) includes identity section when callback provided', async () => {
    const metrics = createMockMetrics();
    const getMemoryStats = () => ({ totalEntries: 150, hasAnalysisCache: true });
    const identityState = makeIdentityState({ bootCount: 3, cumulativeUptimeMs: 3600000, totalMessages: 20, totalTasks: 5, projectContext: "" });
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => ["file_read"],
      getMemoryStats,
      () => identityState,
    );

    const result = await tool.execute({ section: "all" }, dummyContext);

    expect(result.isError).toBeFalsy();
    // Should contain overview, tools, memory, AND identity sections
    expect(result.content).toContain("Overview");
    expect(result.content).toContain("Tools");
    expect(result.content).toContain("Memory");
    expect(result.content).toContain("Identity");
    expect(result.content).toContain("Strada Brain");
  });

  it('execute({section: "daemon"}) returns daemon status when callback provided', async () => {
    const metrics = createMockMetrics();
    const daemonStatus = {
      running: true,
      intervalMs: 60000,
      triggerCount: 3,
      lastTick: new Date("2026-03-08T12:00:00Z"),
      budgetUsage: { usedUsd: 2.50, limitUsd: 5.0 as number | undefined, pct: 0.5 },
    };
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => [],
      undefined,
      undefined,
      () => daemonStatus,
    );

    const result = await tool.execute({ section: "daemon" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Daemon");
    expect(result.content).toContain("yes"); // running
    expect(result.content).toContain("60s"); // heartbeat interval
    expect(result.content).toContain("3"); // trigger count
    expect(result.content).toContain("2.50"); // budget used
    expect(result.content).toContain("$5"); // budget limit
  });

  it('execute({section: "daemon"}) shows unavailable when callback returns undefined', async () => {
    const metrics = createMockMetrics();
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => [],
      undefined,
      undefined,
      () => undefined,
    );

    const result = await tool.execute({ section: "daemon" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content.toLowerCase()).toContain("not active");
  });

  it('execute({section: "all"}) includes daemon section when callback provided', async () => {
    const metrics = createMockMetrics();
    const getMemoryStats = () => ({ totalEntries: 150, hasAnalysisCache: true });
    const identityState = makeIdentityState();
    const daemonStatus = {
      running: true,
      intervalMs: 30000,
      triggerCount: 2,
      lastTick: null,
      budgetUsage: { usedUsd: 0, limitUsd: undefined, pct: 0 },
    };
    const tool = new AgentStatusTool(
      metrics as never,
      () => 25,
      () => ["file_read"],
      getMemoryStats,
      () => identityState,
      () => daemonStatus,
    );

    const result = await tool.execute({ section: "all" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Overview");
    expect(result.content).toContain("Tools");
    expect(result.content).toContain("Memory");
    expect(result.content).toContain("Identity");
    expect(result.content).toContain("Daemon");
    expect(result.content).toContain("2 registered"); // trigger count
  });
});
