/**
 * Error Monitor for Strada.Brain
 * Tracks error rates and triggers alerts when thresholds are exceeded
 */

import { getAlertManager } from "../alert-manager.js";
import { AlertLevel, ErrorThresholds, MonitorConfig } from "../types.js";
import { getLogger } from "../../utils/logger.js";

interface ErrorEvent {
  timestamp: Date;
  error: Error;
  source: string;
  metadata?: Record<string, unknown>;
}

interface ErrorStats {
  totalErrors: number;
  errorsBySource: Map<string, number>;
  errorsByType: Map<string, number>;
  consecutiveErrors: number;
  lastErrorTime?: Date;
  errorRateLast5Min: number;
}

interface MonitorState {
  events: ErrorEvent[];
  maxEvents: number;
  lastAlertTime: Map<string, number>;
  alertCooldownMs: number;
  consecutiveErrors: number;
  lastErrorTime?: Date;
}

/**
 * Error Monitor class
 */
export class ErrorMonitor {
  private config: Required<MonitorConfig>;
  private thresholds: ErrorThresholds;
  private state: MonitorState;
  private checkInterval: number;
  private intervalId?: NodeJS.Timeout;
  private originalConsoleError?: typeof console.error;

  constructor(
    thresholds: Partial<ErrorThresholds> = {},
    checkIntervalMs: number = 60000,
    config: Partial<MonitorConfig> = {},
  ) {
    this.config = {
      enabled: config.enabled ?? true,
      intervalMs: config.intervalMs ?? 60000,
      alertLevel: config.alertLevel ?? "warning",
    };

    this.thresholds = {
      maxErrorsPerMinute: thresholds.maxErrorsPerMinute ?? 10,
      maxErrorRatePercent: thresholds.maxErrorRatePercent ?? 10,
      maxConsecutiveErrors: thresholds.maxConsecutiveErrors ?? 5,
    };

    this.checkInterval = checkIntervalMs;
    this.state = {
      events: [],
      maxEvents: 10000,
      lastAlertTime: new Map(),
      alertCooldownMs: 300000, // 5 minutes
      consecutiveErrors: 0,
    };
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (this.intervalId) {
      return;
    }

    // Hook into console.error
    this.hookConsoleError();

    // Start periodic checks
    this.intervalId = setInterval(() => {
      this.check();
    }, this.checkInterval);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    // Restore original console.error
    if (this.originalConsoleError) {
      console.error = this.originalConsoleError;
    }
  }

  /**
   * Check if monitoring is running
   */
  isRunning(): boolean {
    return !!this.intervalId;
  }

  /**
   * Hook into console.error to capture errors
   */
  private hookConsoleError(): void {
    this.originalConsoleError = console.error;
    const monitor = this;

    console.error = function (...args: unknown[]) {
      // Call original
      monitor.originalConsoleError!.apply(console, args);

      // Extract error information
      const error = args.find((arg) => arg instanceof Error) as Error | undefined;
      const message = args
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
        .join(" ");

      monitor.recordError(error || new Error(message), "console.error", {
        args: args.map((a) => String(a)),
      });
    };
  }

  /**
   * Record an error event
   */
  recordError(error: Error, source: string, metadata?: Record<string, unknown>): void {
    const event: ErrorEvent = {
      timestamp: new Date(),
      error,
      source,
      metadata,
    };

    this.state.events.push(event);
    this.state.consecutiveErrors++;
    this.state.lastErrorTime = new Date();

    if (this.state.events.length > this.state.maxEvents) {
      this.state.events.shift();
    }

    // Check for immediate alerting conditions
    this.checkImmediateAlert(event);
  }

  /**
   * Track an API call result
   */
  trackAPICall(
    success: boolean,
    endpoint: string,
    error?: Error,
    metadata?: Record<string, unknown>,
  ): void {
    if (!success && error) {
      this.recordError(error, `api:${endpoint}`, metadata);
    } else {
      // Reset consecutive errors on success
      this.state.consecutiveErrors = 0;
    }
  }

  /**
   * Track a function execution
   */
  trackFunction<T>(fn: () => T, functionName: string, metadata?: Record<string, unknown>): T {
    try {
      const result = fn();
      this.state.consecutiveErrors = 0;
      return result;
    } catch (error) {
      this.recordError(
        error instanceof Error ? error : new Error(String(error)),
        `function:${functionName}`,
        metadata,
      );
      throw error;
    }
  }

  /**
   * Track async function execution
   */
  async trackAsyncFunction<T>(
    fn: () => Promise<T>,
    functionName: string,
    metadata?: Record<string, unknown>,
  ): Promise<T> {
    try {
      const result = await fn();
      this.state.consecutiveErrors = 0;
      return result;
    } catch (error) {
      this.recordError(
        error instanceof Error ? error : new Error(String(error)),
        `function:${functionName}`,
        metadata,
      );
      throw error;
    }
  }

  /**
   * Perform periodic check
   */
  private async check(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      await this.checkErrorRates();
    } catch (error) {
      try {
        getLogger().error("[ErrorMonitor] Error checking error rates:", error);
      } catch {
        console.error("[ErrorMonitor] Error checking error rates:", error);
      }
    }
  }

  /**
   * Check for immediate alerting conditions
   */
  private checkImmediateAlert(event: ErrorEvent): void {
    // Check consecutive errors
    if (this.state.consecutiveErrors >= this.thresholds.maxConsecutiveErrors) {
      this.sendAlertIfNotRateLimited(
        "consecutive-errors",
        "critical",
        "Multiple Consecutive Errors",
        `${this.state.consecutiveErrors} consecutive errors detected. Latest: ${event.error.message}`,
        {
          consecutiveErrors: this.state.consecutiveErrors,
          lastError: event.error.message,
          source: event.source,
        },
      );
    }
  }

  /**
   * Check error rates
   */
  private async checkErrorRates(): Promise<void> {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60000);

    // Get recent events
    const eventsLast5Min = this.state.events.filter((e) => e.timestamp >= fiveMinutesAgo);

    // Check errors per minute
    const errorsPerMinute = eventsLast5Min.length / 5;
    if (errorsPerMinute > this.thresholds.maxErrorsPerMinute) {
      this.sendAlertIfNotRateLimited(
        "high-error-rate",
        "warning",
        "High Error Rate",
        `Error rate of ${errorsPerMinute.toFixed(2)}/min exceeds threshold of ${this.thresholds.maxErrorsPerMinute}/min`,
        {
          errorsPerMinute,
          totalErrors5Min: eventsLast5Min.length,
          threshold: this.thresholds.maxErrorsPerMinute,
        },
      );
    }

    // Group errors by source for more specific alerts
    const errorsBySource = new Map<string, number>();
    for (const event of eventsLast5Min) {
      const count = errorsBySource.get(event.source) || 0;
      errorsBySource.set(event.source, count + 1);
    }

    // Alert on specific sources with high error counts
    for (const [source, count] of errorsBySource) {
      if (count > this.thresholds.maxErrorsPerMinute * 2) {
        this.sendAlertIfNotRateLimited(
          `source-errors-${source}`,
          "warning",
          `High Error Rate: ${source}`,
          `Source "${source}" has ${count} errors in the last 5 minutes`,
          { source, errorCount: count },
        );
      }
    }
  }

  /**
   * Send alert if not rate limited
   */
  private async sendAlertIfNotRateLimited(
    alertKey: string,
    level: AlertLevel,
    title: string,
    message: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();
    const lastAlert = this.state.lastAlertTime.get(alertKey);

    if (lastAlert && now - lastAlert < this.state.alertCooldownMs) {
      return;
    }

    this.state.lastAlertTime.set(alertKey, now);

    const alertManager = getAlertManager();
    await alertManager.sendAlert(level, title, message, {
      source: "error-monitor",
      context,
    });
  }

  /**
   * Get error statistics
   */
  getStats(timeWindowMinutes: number = 5): ErrorStats {
    const cutoff = new Date(Date.now() - timeWindowMinutes * 60000);
    const recentEvents = this.state.events.filter((e) => e.timestamp >= cutoff);

    const errorsBySource = new Map<string, number>();
    const errorsByType = new Map<string, number>();

    for (const event of recentEvents) {
      // Count by source
      const sourceCount = errorsBySource.get(event.source) || 0;
      errorsBySource.set(event.source, sourceCount + 1);

      // Count by error type
      const typeName = event.error.constructor.name;
      const typeCount = errorsByType.get(typeName) || 0;
      errorsByType.set(typeName, typeCount + 1);
    }

    return {
      totalErrors: recentEvents.length,
      errorsBySource,
      errorsByType,
      consecutiveErrors: this.state.consecutiveErrors,
      lastErrorTime: this.state.lastErrorTime,
      errorRateLast5Min: recentEvents.length / timeWindowMinutes,
    };
  }

  /**
   * Get recent errors
   */
  getRecentErrors(limit: number = 10): ErrorEvent[] {
    return this.state.events.slice(-limit);
  }

  /**
   * Get errors by source
   */
  getErrorsBySource(source: string, limit: number = 10): ErrorEvent[] {
    return this.state.events.filter((e) => e.source === source).slice(-limit);
  }

  /**
   * Clear error history
   */
  clearHistory(): void {
    this.state.events = [];
    this.state.consecutiveErrors = 0;
  }

  /**
   * Get monitor status
   */
  getStatus(): {
    running: boolean;
    enabled: boolean;
    thresholds: ErrorThresholds;
    stats: ErrorStats;
    eventsCount: number;
  } {
    return {
      running: this.isRunning(),
      enabled: this.config.enabled,
      thresholds: { ...this.thresholds },
      stats: this.getStats(),
      eventsCount: this.state.events.length,
    };
  }
}

// Singleton instance
let errorMonitorInstance: ErrorMonitor | null = null;

export function getErrorMonitor(
  thresholds?: Partial<ErrorThresholds>,
  checkIntervalMs?: number,
): ErrorMonitor {
  if (!errorMonitorInstance) {
    errorMonitorInstance = new ErrorMonitor(thresholds, checkIntervalMs);
  }
  return errorMonitorInstance;
}

export function resetErrorMonitor(): void {
  errorMonitorInstance?.stop();
  errorMonitorInstance = null;
}
