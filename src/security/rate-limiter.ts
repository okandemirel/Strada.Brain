/**
 * Rate limiter and quota manager for Strada Brain.
 *
 * Provides:
 * - Per-user message rate limiting (token bucket)
 * - Global API token quota tracking (sliding window)
 * - Cost estimation and budget enforcement (daily/monthly)
 */

import { getLogger } from "../utils/logger.js";
import { estimateCostWithCache } from "../budget/cost-model.js";

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

/**
 * The rate-limit fields a dashboard POST may change, with the `settings`
 * override key each one is stored under and the ceiling above which a value
 * is not a policy but a typo. ONE table drives validation, the live update
 * and the startup restore, so the API, the store and the limiter cannot
 * disagree about what a legal limit is (item 2.7: the POST handler
 * stringified whatever arrived — "abc", -5 and 1e15 were all persisted as the
 * enforced limit, and the running limiter was never told).
 *
 * 0 means UNLIMITED everywhere in this file — it is how the dashboard says
 * "no limit", so it must stay legal.
 */
export const RATE_LIMIT_SETTINGS = [
  { field: "messagesPerMinute", storageKey: "rate_limit_messages_per_minute", max: 100_000 },
  { field: "messagesPerHour", storageKey: "rate_limit_messages_per_hour", max: 1_000_000 },
  { field: "tokensPerDay", storageKey: "rate_limit_tokens_per_day", max: 10_000_000_000 },
] as const satisfies ReadonlyArray<{ field: keyof RateLimitConfig; storageKey: string; max: number }>;

export type RateLimitSettingField = (typeof RATE_LIMIT_SETTINGS)[number]["field"];

/**
 * The number this value means, or the reason it is not a limit. Accepts a
 * number or a numeric string (API clients send strings); rejects NaN,
 * Infinity, booleans, fractions, negatives and absurd magnitudes.
 */
export function parseRateLimitValue(
  field: RateLimitSettingField,
  raw: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  const max = RATE_LIMIT_SETTINGS.find((s) => s.field === field)!.max;
  const refuse = (why: string): { ok: false; error: string } => ({ ok: false, error: `${field}: ${why}` });
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    n = Number(raw);
  } else {
    return refuse(`expected a number, got ${typeof raw === "string" ? JSON.stringify(raw) : typeof raw}`);
  }
  if (!Number.isFinite(n)) return refuse("must be a finite number");
  if (!Number.isInteger(n)) return refuse("must be a whole number");
  if (n < 0) return refuse("must not be negative (0 means unlimited)");
  if (n > max) return refuse(`must not exceed ${max.toLocaleString("en-US")}`);
  return { ok: true, value: n };
}

/** What the limiter is told to enforce. Every value has passed the table above. */
export type RateLimitPatch = Partial<Record<RateLimitSettingField, number>>;

/**
 * The durable spend ledger the cost counters are seeded from
 * (UnifiedBudgetManager satisfies it). Every channel message runs as a task
 * whose usage the ledger books at the same cache-aware, per-model price this
 * limiter uses, so its rows are the spend these caps measure.
 */
export interface SpendLedgerReader {
  /** Recorded USD spend at or after `windowStart` (epoch ms). */
  recordedSpendSince(windowStart: number): number;
}

/** The least a stored-override source has to offer (DaemonStorage satisfies it). */
export interface RateLimitOverrideSource {
  getSettingsOverride(key: string, scope?: string): string | undefined;
}

/**
 * Put the dashboard's stored rate-limit overrides in force on a limiter that
 * was just constructed from config. Without this a restart silently reverted
 * to the config numbers: the dashboard wrote the override, the GET read it
 * back, and nothing ever enforced it (item 2.7).
 *
 * A corrupt or out-of-range stored value is IGNORED and logged, never
 * enforced — a bad row in settings must not unlimit (or freeze) the daemon.
 * Returns the overrides that were applied.
 */
export function applyStoredRateLimitOverrides(
  limiter: RateLimiter,
  storage: RateLimitOverrideSource,
  logger?: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void },
): RateLimitPatch {
  const patch: RateLimitPatch = {};
  for (const { field, storageKey } of RATE_LIMIT_SETTINGS) {
    let raw: string | undefined;
    try {
      raw = storage.getSettingsOverride(storageKey);
    } catch {
      continue; // an unreadable store is not a limit change
    }
    if (raw === undefined) continue;
    const parsed = parseRateLimitValue(field, raw);
    if (!parsed.ok) {
      logger?.warn("Stored rate-limit override ignored", { key: storageKey, value: raw, reason: parsed.error });
      continue;
    }
    patch[field] = parsed.value;
  }
  if (Object.keys(patch).length > 0) {
    limiter.updateConfig(patch);
    logger?.info("Stored rate-limit overrides applied", patch);
  }
  return patch;
}

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

  constructor(config: Partial<RateLimitConfig> = {}, opts: { spendLedger?: SpendLedgerReader } = {}) {
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
    if (opts.spendLedger) this.seedSpend(opts.spendLedger);
  }

  /**
   * Seed the daily/monthly cost counters from the durable ledger (SEC-21).
   * They lived in memory only, so every restart (a crash loop, a deploy)
   * zeroed the spend caps while the money stayed spent. Takes the LARGER of
   * what this process already counted and what the ledger holds for the
   * current UTC day/month, so seeding never lowers a counter and never counts
   * a cost twice. An unreadable ledger leaves the counters as they are.
   */
  seedSpend(ledger: SpendLedgerReader): void {
    const now = Date.now();
    this.rotatePeriods(now);
    let daily: number;
    let monthly: number;
    try {
      daily = ledger.recordedSpendSince(this.dayStart);
      monthly = ledger.recordedSpendSince(this.monthStart);
    } catch (error) {
      getLogger().warn("Rate limiter could not read the spend ledger; cost counters not seeded", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (Number.isFinite(daily) && daily > 0) this.dailyCost = Math.max(this.dailyCost, daily);
    if (Number.isFinite(monthly) && monthly > 0) this.monthlyCost = Math.max(this.monthlyCost, monthly);
  }

  /** What this limiter is enforcing right now (a copy — callers cannot poke it). */
  getConfig(): RateLimitConfig {
    return { ...this.config };
  }

  /**
   * Change what the RUNNING limiter enforces. The dashboard's POST
   * /api/settings/rate-limits used to write a settings row and stop there, so
   * the new limit took effect only at the next restart — and nothing applied
   * it then either (item 2.7).
   *
   * Every value is re-validated here, not only at the HTTP edge: this is the
   * last gate before a number becomes policy, and a caller that skipped the
   * route (a script, a future endpoint) must not be able to install `-1` or
   * `NaN` as a limit. In-flight per-user counters are deliberately kept: a
   * tightened limit applies to the traffic already seen this minute.
   */
  updateConfig(patch: RateLimitPatch): void {
    const validated: RateLimitPatch = {};
    for (const [field, raw] of Object.entries(patch) as Array<[RateLimitSettingField, unknown]>) {
      if (raw === undefined) continue;
      const parsed = parseRateLimitValue(field, raw);
      if (!parsed.ok) throw new RangeError(`Invalid rate limit — ${parsed.error}`);
      validated[field] = parsed.value;
    }
    // Assigned only after EVERY field validated, so a bad field cannot leave
    // the limiter half-updated.
    for (const [field, value] of Object.entries(validated) as Array<[RateLimitSettingField, number]>) {
      this.config[field] = value;
    }
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
    model?: string,
    /** The cached share of the prompt, priced like the ledger prices it (audit 03.2 / D21). */
    cache?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number },
  ): void {
    const now = Date.now();
    this.rotatePeriods(now);

    const cost = estimateCostWithCache(
      {
        inputTokens,
        outputTokens,
        ...(cache?.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: cache.cacheCreationInputTokens }),
        ...(cache?.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: cache.cacheReadInputTokens }),
        ...(model === undefined ? {} : { model }),
      },
      provider,
    );

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
