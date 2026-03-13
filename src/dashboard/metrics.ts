/**
 * Metrics collector for Strada Brain monitoring.
 * Aggregates token usage, tool calls, session stats, and provider health.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  timestamp: Date;
  provider: string;
}

export interface ToolCallMetric {
  name: string;
  durationMs: number;
  success: boolean;
  timestamp: Date;
}

export interface SessionMetric {
  chatId: string;
  messageCount: number;
  lastActivity: Date;
}

export interface DashboardSnapshot {
  uptime: number;
  totalMessages: number;
  totalTokens: { input: number; output: number };
  activeSessions: number;
  recentTokenUsage: TokenUsage[];
  toolCallCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
  providerName: string;
  memoryStats: { totalEntries: number; hasAnalysisCache: boolean } | null;
  readOnlyMode: boolean;
  securityStats: {
    secretsSanitized: number;
    toolsBlocked: number;
  } | null;
}

export class MetricsCollector {
  private readonly startTime = Date.now();
  private totalMessages = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private activeSessions = 0;
  private providerName = "unknown";
  private readOnlyMode = false;
  private secretsSanitized = 0;
  private toolsBlocked = 0;
  private readonly recentTokenUsage: TokenUsage[] = [];
  private readonly toolCallCounts = new Map<string, number>();
  private readonly toolErrorCounts = new Map<string, number>();

  private static readonly MAX_RECENT_TOKENS = 100;

  /** Get the start time in epoch milliseconds. */
  getStartTime(): number {
    return this.startTime;
  }

  recordMessage(): void {
    this.totalMessages++;
  }

  recordTokenUsage(input: number, output: number, provider: string): void {
    this.totalInputTokens += input;
    this.totalOutputTokens += output;
    this.providerName = provider;

    this.recentTokenUsage.push({
      inputTokens: input,
      outputTokens: output,
      timestamp: new Date(),
      provider,
    });

    // Keep only recent entries
    if (this.recentTokenUsage.length > MetricsCollector.MAX_RECENT_TOKENS) {
      const excess = this.recentTokenUsage.length - MetricsCollector.MAX_RECENT_TOKENS;
      this.recentTokenUsage.splice(0, excess);
    }
  }

  recordToolCall(name: string, _durationMs: number, success: boolean): void {
    this.toolCallCounts.set(name, (this.toolCallCounts.get(name) ?? 0) + 1);
    if (!success) {
      this.toolErrorCounts.set(name, (this.toolErrorCounts.get(name) ?? 0) + 1);
    }
  }

  setActiveSessions(count: number): void {
    this.activeSessions = count;
  }

  /**
   * Set read-only mode status for dashboard display.
   */
  setReadOnlyMode(enabled: boolean): void {
    this.readOnlyMode = enabled;
  }

  /**
   * Record a secret sanitization event.
   */
  recordSecretSanitized(count: number = 1): void {
    this.secretsSanitized += count;
  }

  /**
   * Record a tool blocked by read-only guard.
   */
  recordToolBlocked(): void {
    this.toolsBlocked++;
  }

  getSnapshot(memoryStats?: {
    totalEntries: number;
    hasAnalysisCache: boolean;
  }): DashboardSnapshot {
    return {
      uptime: Date.now() - this.startTime,
      totalMessages: this.totalMessages,
      totalTokens: {
        input: this.totalInputTokens,
        output: this.totalOutputTokens,
      },
      activeSessions: this.activeSessions,
      recentTokenUsage: [...this.recentTokenUsage],
      toolCallCounts: Object.fromEntries(this.toolCallCounts),
      toolErrorCounts: Object.fromEntries(this.toolErrorCounts),
      providerName: this.providerName,
      memoryStats: memoryStats ?? null,
      readOnlyMode: this.readOnlyMode,
      securityStats: {
        secretsSanitized: this.secretsSanitized,
        toolsBlocked: this.toolsBlocked,
      },
    };
  }
}
