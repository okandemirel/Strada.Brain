import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import type { MetricsCollector } from "../../dashboard/metrics.js";

/**
 * Introspection tool that lets the LLM query its own operational status.
 *
 * Returns uptime, session count, token usage, tool availability, and memory
 * stats.  Read-only -- never modifies state.  Gracefully degrades when
 * optional dependencies (memory) are unavailable.
 */
export class AgentStatusTool implements ITool {
  readonly name = "agent_status";
  readonly description =
    "Get your current operational status including uptime, active sessions, tool availability, " +
    "token usage, and memory stats. Use this when a user asks 'what can you do?' or " +
    "'how are you doing?' or wants to know your state.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      section: {
        type: "string",
        enum: ["overview", "tools", "memory", "all"],
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

  constructor(
    metrics: MetricsCollector,
    getToolCount: () => number,
    getToolNames: () => string[],
    getMemoryStats?: () =>
      | { totalEntries: number; hasAnalysisCache: boolean }
      | undefined,
  ) {
    this.metrics = metrics;
    this.getToolCount = getToolCount;
    this.getToolNames = getToolNames;
    this.getMemoryStats = getMemoryStats;
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const validSections = ["overview", "tools", "memory", "all"];
    const raw = (input["section"] as string) ?? "overview";
    const section = validSections.includes(raw) ? raw : "overview";
    const memStats = this.getMemoryStats?.();
    const snapshot = this.metrics.getSnapshot(memStats ?? undefined);

    const sections: string[] = [];

    if (section === "overview" || section === "all") {
      const uptimeMin = Math.floor(snapshot.uptime / 60000);
      sections.push(
        [
          "## Overview",
          `- **Uptime:** ${uptimeMin} minutes`,
          `- **Messages processed:** ${snapshot.totalMessages}`,
          `- **Active sessions:** ${snapshot.activeSessions}`,
          `- **Tokens used:** ${snapshot.totalTokens.input} input / ${snapshot.totalTokens.output} output`,
          `- **Provider:** ${snapshot.providerName}`,
          `- **Read-only mode:** ${snapshot.readOnlyMode ? "yes" : "no"}`,
        ].join("\n"),
      );
    }

    if (section === "tools" || section === "all") {
      const count = this.getToolCount();
      const names = this.getToolNames();
      sections.push(
        [
          "## Tools",
          `- **Registered tools:** ${count}`,
          `- **Available:** ${names.join(", ")}`,
        ].join("\n"),
      );
    }

    if (section === "memory" || section === "all") {
      if (memStats) {
        sections.push(
          [
            "## Memory",
            `- **Total entries:** ${memStats.totalEntries}`,
            `- **Analysis cache:** ${memStats.hasAnalysisCache ? "yes" : "no"}`,
          ].join("\n"),
        );
      } else {
        sections.push("## Memory\n\nMemory stats not available.");
      }
    }

    return { content: sections.join("\n\n") };
  }
}
