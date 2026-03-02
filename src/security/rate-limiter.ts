/**
 * Rate limiter and quota manager for Strata Brain.
 *
 * Provides:
 * - Per-user message rate limiting (token bucket)
 * - Global API token quota tracking (sliding window)
 * - Cost estimation and budget enforcement (daily/monthly)
 */

import { getLogger } from "../utils/logger.js";

// ---------- Cost model ----------

/** Approximate cost per 1M tokens for each provider (USD). */
const PROVIDER_COSTS: Record<string, { input: number; output: number }> = {
  claude: { input: 3.0, output: 15.0 },
  openai: { input: 2.5, output: 10.0 },
  deepseek: { input: 0.14, output: 0.28 },
  groq: { input: 0.05, output: 0.08 },
  mistral: { input: 0.25, output: 0.25 },
  ollama: { input: 0, output: 0 },
};

/** Fallback cost for unknown providers. */
const DEFAULT_COST = { input: 2.0, output: 10.0 };

// ---------- Types ----------

export interface RateLimitConfig {
  /** Max messages per user per minute (0 = unlimited). */
  messagesPerMinute: number;
  /** Max messages per user per hour (0 = unlimited). */
  messagesPerHour: number;
  /** Max total API tokens per day across all users (0 = unlimited). */
  tokensPerDay: number;
  /** Max daily spend in USD (0 = unlimited). */
  dailyBudgetUsd: number;
  /** Max monthly spend in USD (0 = unlimited). */
  monthlyBudgetUsd: number;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export interface QuotaSnapshot {
  /** Tokens used today. */
  tokensToday: number;
  /** Estimated cost today (USD). */
  costToday: number;
  /** Estimated cost this month (USD). */
  costThisMonth: number;
  /** Messages processed today. */
  messagesToday: number;
  /** Per-user message counts in the current minute window. */
  activeUsers: number;
}

interface UserBucket {
  /** Timestamps of messages in the current minute. */
  minuteTimestamps: number[];
  /** Timestamps of messages in the current hour. */
  hourTimestamps: number[];
}

interface TokenRecord {
  inputTokens: number;
  outputTokens: number;
  provider: string;
  timestamp: number;
}

// ---------- Implementation ----------

export class RateLimiter {
  private readonly config: RateLimitConfig;
  private readonly userBuckets = new Map<string, UserBucket>();

  /** Token usage records for the current day. */
  private dailyTokenRecords: TokenRecord[] = [];
  /** Token usage records for the current month. */
  private monthlyTokenRecords: TokenRecord[] = [];
  /** Start of the current day (midnight UTC). */
  private dayStart: number;
  /** Start of the current month (first day UTC). */
  private monthStart: number;

  private messagesToday = 0;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      messagesPerMinute: config.messagesPerMinute ?? 0,
      messagesPerHour: config.messagesPerHour ?? 0,
      tokensPerDay: config.tokensPerDay ?? 0,
      dailyBudgetUsd: config.dailyBudgetUsd ?? 0,
      monthlyBudgetUsd: config.monthlyBudgetUsd ?? 0,
    };

    const now = new Date();
    this.dayStart = startOfDayUTC(now);
    this.monthStart = startOfMonthUTC(now);
  }

  /**
   * Check if a user's message is allowed under rate limits.
   */
  checkMessageRate(userId: string): RateLimitResult {
    const now = Date.now();
    this.rotatePeriods(now);

    const bucket = this.getOrCreateBucket(userId);

    // Prune expired timestamps
    const oneMinuteAgo = now - 60_000;
    const oneHourAgo = now - 3_600_000;

    bucket.minuteTimestamps = bucket.minuteTimestamps.filter((t) => t > oneMinuteAgo);
    bucket.hourTimestamps = bucket.hourTimestamps.filter((t) => t > oneHourAgo);

    // Check per-minute limit
    if (
      this.config.messagesPerMinute > 0 &&
      bucket.minuteTimestamps.length >= this.config.messagesPerMinute
    ) {
      const oldestInMinute = bucket.minuteTimestamps[0]!;
      const retryAfterMs = oldestInMinute + 60_000 - now;
      return {
        allowed: false,
        reason: `Rate limit: max ${this.config.messagesPerMinute} messages/minute`,
        retryAfterMs: Math.max(retryAfterMs, 1000),
      };
    }

    // Check per-hour limit
    if (
      this.config.messagesPerHour > 0 &&
      bucket.hourTimestamps.length >= this.config.messagesPerHour
    ) {
      const oldestInHour = bucket.hourTimestamps[0]!;
      const retryAfterMs = oldestInHour + 3_600_000 - now;
      return {
        allowed: false,
        reason: `Rate limit: max ${this.config.messagesPerHour} messages/hour`,
        retryAfterMs: Math.max(retryAfterMs, 1000),
      };
    }

    // Check daily token quota
    if (this.config.tokensPerDay > 0) {
      const tokensUsed = this.getDailyTokens();
      if (tokensUsed >= this.config.tokensPerDay) {
        return {
          allowed: false,
          reason: `Daily token quota exceeded (${tokensUsed.toLocaleString()}/${this.config.tokensPerDay.toLocaleString()})`,
        };
      }
    }

    // Check daily budget
    if (this.config.dailyBudgetUsd > 0) {
      const cost = this.getDailyCost();
      if (cost >= this.config.dailyBudgetUsd) {
        return {
          allowed: false,
          reason: `Daily budget exceeded ($${cost.toFixed(2)}/$${this.config.dailyBudgetUsd.toFixed(2)})`,
        };
      }
    }

    // Check monthly budget
    if (this.config.monthlyBudgetUsd > 0) {
      const cost = this.getMonthlyCost();
      if (cost >= this.config.monthlyBudgetUsd) {
        return {
          allowed: false,
          reason: `Monthly budget exceeded ($${cost.toFixed(2)}/$${this.config.monthlyBudgetUsd.toFixed(2)})`,
        };
      }
    }

    // Allowed — record the message
    bucket.minuteTimestamps.push(now);
    bucket.hourTimestamps.push(now);
    this.messagesToday++;

    return { allowed: true };
  }

  /**
   * Record token usage from an API call.
   */
  recordTokenUsage(
    inputTokens: number,
    outputTokens: number,
    provider: string
  ): void {
    const now = Date.now();
    this.rotatePeriods(now);

    const record: TokenRecord = { inputTokens, outputTokens, provider, timestamp: now };
    this.dailyTokenRecords.push(record);
    this.monthlyTokenRecords.push(record);

    const cost = estimateCost(inputTokens, outputTokens, provider);
    const logger = getLogger();
    logger.debug("Token usage recorded", {
      inputTokens,
      outputTokens,
      provider,
      estimatedCostUsd: cost.toFixed(4),
    });
  }

  /**
   * Get current quota snapshot for dashboard/monitoring.
   */
  getSnapshot(): QuotaSnapshot {
    this.rotatePeriods(Date.now());

    return {
      tokensToday: this.getDailyTokens(),
      costToday: this.getDailyCost(),
      costThisMonth: this.getMonthlyCost(),
      messagesToday: this.messagesToday,
      activeUsers: this.userBuckets.size,
    };
  }

  // ---------- Internal helpers ----------

  private getDailyTokens(): number {
    return this.dailyTokenRecords.reduce(
      (sum, r) => sum + r.inputTokens + r.outputTokens,
      0
    );
  }

  private getDailyCost(): number {
    return this.dailyTokenRecords.reduce(
      (sum, r) => sum + estimateCost(r.inputTokens, r.outputTokens, r.provider),
      0
    );
  }

  private getMonthlyCost(): number {
    return this.monthlyTokenRecords.reduce(
      (sum, r) => sum + estimateCost(r.inputTokens, r.outputTokens, r.provider),
      0
    );
  }

  private getOrCreateBucket(userId: string): UserBucket {
    let bucket = this.userBuckets.get(userId);
    if (!bucket) {
      bucket = { minuteTimestamps: [], hourTimestamps: [] };
      this.userBuckets.set(userId, bucket);
    }
    return bucket;
  }

  /**
   * Reset daily/monthly counters when a new period begins.
   */
  private rotatePeriods(now: number): void {
    const currentDayStart = startOfDayUTC(new Date(now));
    if (currentDayStart > this.dayStart) {
      this.dailyTokenRecords = [];
      this.messagesToday = 0;
      this.dayStart = currentDayStart;
      // Prune user buckets older than 1 hour
      for (const [userId, bucket] of this.userBuckets) {
        bucket.minuteTimestamps = [];
        bucket.hourTimestamps = bucket.hourTimestamps.filter(
          (t) => t > now - 3_600_000
        );
        if (bucket.hourTimestamps.length === 0) {
          this.userBuckets.delete(userId);
        }
      }
    }

    const currentMonthStart = startOfMonthUTC(new Date(now));
    if (currentMonthStart > this.monthStart) {
      this.monthlyTokenRecords = [];
      this.monthStart = currentMonthStart;
    }
  }
}

// ---------- Utility functions ----------

/**
 * Estimate cost in USD for a given token usage.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  provider: string
): number {
  const costs = PROVIDER_COSTS[provider] ?? DEFAULT_COST;
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

function startOfDayUTC(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfMonthUTC(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}
