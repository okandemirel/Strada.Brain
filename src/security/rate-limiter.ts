/**
 * Rate limiter and quota manager for Strada Brain.
 *
 * Provides:
 * - Per-user message rate limiting (token bucket)
 * - Global API token quota tracking (sliding window)
 * - Cost estimation and budget enforcement (daily/monthly)
 */

import { getLogger } from "../utils/logger.js";
import { estimateCost } from "../budget/cost-model.js";

export { estimateCost } from "../budget/cost-model.js";

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

// ---------- Implementation ----------

export class RateLimiter {
  private readonly config: RateLimitConfig;
  private readonly userBuckets = new Map<string, UserBucket>();

  /** Running token total for the current day. */
  private dailyTokens = 0;
  /** Running estimated cost for the current day (USD). */
  private dailyCost = 0;
  /** Running estimated cost for the current month (USD). */
  private monthlyCost = 0;
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

    // Evict drained buckets immediately rather than waiting for the UTC day
    // rollover, so userBuckets does not leak entries for idle users.
    if (bucket.minuteTimestamps.length === 0 && bucket.hourTimestamps.length === 0) {
      this.userBuckets.delete(userId);
    }

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

    // Allowed — record the message. The bucket may have been evicted above
    // when it drained to empty, so re-register it before recording.
    bucket.minuteTimestamps.push(now);
    bucket.hourTimestamps.push(now);
    this.userBuckets.set(userId, bucket);
    this.messagesToday++;

    return { allowed: true };
  }

  /**
   * Record token usage from an API call.
   *
   * @param model Concrete model id when the caller knows it. Without it a
   *   free-tier model ("-free"/":free") is priced at its provider's table rate,
   *   and the phantom dollars are what the daily/monthly budget wall measures —
   *   the wall fired on spend nobody was billed for (audited 2026-09-02).
   */
  recordTokenUsage(
    inputTokens: number,
    outputTokens: number,
    provider: string,
    model?: string
  ): void {
    const now = Date.now();
    this.rotatePeriods(now);

    const cost = estimateCost(inputTokens, outputTokens, provider, model);

    // Maintain running aggregates instead of unbounded per-call record arrays.
    this.dailyTokens += inputTokens + outputTokens;
    this.dailyCost += cost;
    this.monthlyCost += cost;

    const logger = getLogger();
    logger.debug("Token usage recorded", {
      inputTokens,
      outputTokens,
      provider,
      // Named so a $0 line is readable as "free model" rather than "lost cost".
      model: model ?? null,
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
    return this.dailyTokens;
  }

  private getDailyCost(): number {
    return this.dailyCost;
  }

  private getMonthlyCost(): number {
    return this.monthlyCost;
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
      this.dailyTokens = 0;
      this.dailyCost = 0;
      this.messagesToday = 0;
      this.dayStart = currentDayStart;
      // Prune user buckets older than 1 hour
      for (const [userId, bucket] of this.userBuckets) {
        bucket.minuteTimestamps = bucket.minuteTimestamps.filter(
          (t) => t > now - 60_000
        );
        bucket.hourTimestamps = bucket.hourTimestamps.filter(
          (t) => t > now - 3_600_000
        );
        if (
          bucket.minuteTimestamps.length === 0 &&
          bucket.hourTimestamps.length === 0
        ) {
          this.userBuckets.delete(userId);
        }
      }
    }

    const currentMonthStart = startOfMonthUTC(new Date(now));
    if (currentMonthStart > this.monthStart) {
      this.monthlyCost = 0;
      this.monthStart = currentMonthStart;
    }
  }
}

// ---------- Utility functions ----------

function startOfDayUTC(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfMonthUTC(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}
