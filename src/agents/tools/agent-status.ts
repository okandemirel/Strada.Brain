import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import type { MetricsCollector } from "../../dashboard/metrics.js";
import type { IdentityState } from "../../identity/identity-state.js";
import { formatDowntime } from "../../identity/crash-recovery.js";
import type { DaemonStatusSnapshot } from "../../daemon/daemon-types.js";
import { buildSection, unavailableSection, checkToolRateLimit } from "./introspection-helpers.js";

/**
 * Introspection tool that lets the LLM query its own operational status.
 *
 * Returns uptime, session count, tool availability, and memory stats.
 * Read-only -- never modifies state.  Gracefully degrades when optional
 * dependencies (memory) are unavailable.
 *
 * Security: redacts provider name, omits token usage details, limits tool
 * enumeration to count only.  Per-tool rate limited.
 */
export class AgentStatusTool implements ITool {
  readonly name = "agent_status";
  readonly description =
    "Get your current operational status including uptime, active sessions, tool availability, " +
    "and memory stats. Use this when a user asks 'what can you do?' or " +
    "'how are you doing?' or wants to know your state.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      section: {
        type: "string",
        enum: ["overview", "tools", "memory", "identity", "daemon", "all"],
        description:
          "Which section to return. Defaults to overview. Use 'all' for every section.",
      },
    },
    required: [] as string[],
  };

  private readonly metrics: MetricsCollector;
  private readonly getToolCount: () => number;
  private readonly getToolNames: () => string[];
  private readonly getMemoryStats?: () =>
    | { totalEntries: number; hasAnalysisCache: boolean }
    | undefined;
  private readonly getIdentityState?: () => IdentityState | undefined;
  private readonly getDaemonStatus?: () => DaemonStatusSnapshot | undefined;

  constructor(
    metrics: MetricsCollector,
    getToolCount: () => number,
    getToolNames: () => string[],
    getMemoryStats?: () =>
      | { totalEntries: number; hasAnalysisCache: boolean }
      | undefined,
    getIdentityState?: () => IdentityState | undefined,
    getDaemonStatus?: () => DaemonStatusSnapshot | undefined,
  ) {
    this.metrics = metrics;
    this.getToolCount = getToolCount;
    this.getToolNames = getToolNames;
    this.getMemoryStats = getMemoryStats;
    this.getIdentityState = getIdentityState;
    this.getDaemonStatus = getDaemonStatus;
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // Per-tool rate limit
    const rateLimited = checkToolRateLimit(this.name);
    if (rateLimited) return rateLimited;

    const validSections = ["overview", "tools", "memory", "identity", "daemon", "all"];
    const raw = (input["section"] as string) ?? "overview";
    const section = validSections.includes(raw) ? raw : "overview";
    const memStats = this.getMemoryStats?.();
    const snapshot = this.metrics.getSnapshot(memStats ?? undefined);

    const sections: string[] = [];

    if (section === "overview" || section === "all") {
      const uptimeMin = Math.floor(snapshot.uptime / 60000);
      sections.push(
        buildSection("Overview", [
          `**Uptime:** ${uptimeMin} minutes`,
          `**Messages processed:** ${snapshot.totalMessages}`,
          `**Active sessions:** ${snapshot.activeSessions}`,
          `**Read-only mode:** ${snapshot.readOnlyMode ? "yes" : "no"}`,
        ]),
      );
    }

    if (section === "tools" || section === "all") {
      const count = this.getToolCount();
      const names = this.getToolNames();
      sections.push(
        buildSection("Tools", [
          `**Registered tools:** ${count}`,
          `**Available:** ${names.join(", ")}`,
        ]),
      );
    }

    if (section === "memory" || section === "all") {
      if (memStats) {
        sections.push(
          buildSection("Memory", [
            `**Total entries:** ${memStats.totalEntries}`,
            `**Analysis cache:** ${memStats.hasAnalysisCache ? "yes" : "no"}`,
          ]),
        );
      } else {
        sections.push(unavailableSection("Memory", "memory stats not available"));
      }
    }

    if (section === "identity" || section === "all") {
      const identityState = this.getIdentityState?.();
      if (identityState) {
        const uptimeStr = formatDowntime(identityState.cumulativeUptimeMs);
        const created = new Date(identityState.firstBootTs).toISOString().split("T")[0];
        sections.push(
          buildSection("Identity", [
            `**Name:** ${identityState.agentName}`,
            `**Boot #:** ${identityState.bootCount}`,
            `**Total uptime:** ${uptimeStr}`,
            `**Created:** ${created}`,
            `**Messages (lifetime):** ${identityState.totalMessages}`,
            `**Tasks (lifetime):** ${identityState.totalTasks}`,
          ]),
        );
      } else {
        sections.push(unavailableSection("Identity", "identity state not available"));
      }
    }

    if (section === "daemon" || section === "all") {
      const daemonStatus = this.getDaemonStatus?.();
      if (daemonStatus) {
        const limitStr =
          daemonStatus.budgetUsage.limitUsd !== undefined
            ? `$${daemonStatus.budgetUsage.limitUsd}`
            : "unlimited";
        const pctStr =
          daemonStatus.budgetUsage.limitUsd !== undefined
            ? ` (${(daemonStatus.budgetUsage.pct * 100).toFixed(1)}%)`
            : "";
        sections.push(
          buildSection("Daemon", [
            `**Running:** ${daemonStatus.running ? "yes" : "no"}`,
            `**Heartbeat:** every ${daemonStatus.intervalMs / 1000}s`,
            `**Triggers:** ${daemonStatus.triggerCount} registered`,
            `**Last tick:** ${daemonStatus.lastTick ? daemonStatus.lastTick.toISOString() : "never"}`,
            `**Budget:** $${daemonStatus.budgetUsage.usedUsd.toFixed(2)} / ${limitStr}${pctStr}`,
          ]),
        );
      } else {
        sections.push(unavailableSection("Daemon", "daemon not active"));
      }
    }

    return { content: sections.join("\n\n") };
  }
}
