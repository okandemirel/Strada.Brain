/**
 * Discord Rate Limiter
 * Implements rate limiting to comply with Discord API limits.
 *
 * Discord Rate Limits:
 * - Global: 50 requests per second
 * - Per-channel: 5 requests per 5 seconds
 * - Per-guild: 5 requests per 5 seconds (for non-modify operations)
 * - Per-route: Varies by endpoint
 *
 * This implementation focuses on the global limit of 50 req/s.
 *
 * NOTE: This rate limiter handles outgoing Discord API request throttling
 * (token bucket with queue). It is intentionally separate from the shared
 * RateLimiter in src/security/rate-limiter.ts, which handles per-user
 * message rate limiting and cost/budget tracking. The two serve different
 * purposes and should not be consolidated.
 */

import { getLogger } from "../../utils/logger.js";

interface RateLimitState {
  /** Timestamp of last request */
  lastRequest: number;
  /** Number of requests in current window */
  requestCount: number;
  /** Window start timestamp */
  windowStart: number;
}

export interface RateLimitConfig {
  /** Maximum requests per second (default: 50 for Discord global limit) */
  requestsPerSecond: number;
  /** Minimum delay between requests in ms (default: 20ms for 50/sec) */
  minDelayMs: number;
  /** Burst size - allow short bursts (default: 5) */
  burstSize: number;
  /** Cooldown period in ms after hitting limit (default: 1000) */
  cooldownMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  requestsPerSecond: 50,
  minDelayMs: 20,
  burstSize: 5,
  cooldownMs: 1000,
};

/**
 * Rate limiter for Discord API requests.
 * Implements token bucket algorithm for smooth rate limiting.
 */
export class DiscordRateLimiter {
  private readonly config: RateLimitConfig;
  private tokens: number;
  private lastTokenRefill: number;
  private readonly queue: Array<() => void> = [];
  private processing = false;
  private consecutiveErrors = 0;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokens = this.config.burstSize;
    this.lastTokenRefill = Date.now();
  }

  /**
   * Acquire permission to make a request.
   * Returns a promise that resolves when it's safe to proceed.
   */
  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      void this.processQueue();
    });
  }

  /**
   * Try to acquire immediately without waiting.
   * Returns true if allowed, false if would need to wait.
   */
  tryAcquire(): boolean {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }

    return false;
  }

  /**
   * Report a rate limit error from Discord.
   * This will trigger a cooldown period.
   */
  reportRateLimitError(retryAfterMs?: number): void {
    this.consecutiveErrors++;
    const cooldown = retryAfterMs ?? this.config.cooldownMs * this.consecutiveErrors;

    getLogger().warn("Discord rate limit hit", {
      cooldownMs: cooldown,
      consecutiveErrors: this.consecutiveErrors,
    });

    // Drain tokens to force a wait
    this.tokens = 0;

    // Schedule token refill after cooldown
    setTimeout(() => {
      this.tokens = this.config.burstSize;
      this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
      void this.processQueue();
    }, cooldown);
  }

  /**
   * Report a successful request.
   * This resets error counters.
   */
  reportSuccess(): void {
    if (this.consecutiveErrors > 0) {
      this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
    }
  }

  /**
   * Get current rate limiter status for monitoring.
   */
  getStatus(): {
    availableTokens: number;
    queueLength: number;
    consecutiveErrors: number;
    isThrottled: boolean;
  } {
    this.refillTokens();
    return {
      availableTokens: this.tokens,
      queueLength: this.queue.length,
      consecutiveErrors: this.consecutiveErrors,
      isThrottled: this.tokens < 1 || this.queue.length > 0,
    };
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        this.refillTokens();

        if (this.tokens >= 1) {
          // Process next item in queue
          const resolve = this.queue.shift();
          if (resolve) {
            this.tokens--;
            resolve();
          }
        } else {
          // Wait for tokens to refill
          const tokensNeeded = 1 - this.tokens;
          const msPerToken = 1000 / this.config.requestsPerSecond;
          const waitTime = Math.ceil(tokensNeeded * msPerToken);

          await this.delay(waitTime);
        }

        // Small delay between requests to smooth out traffic
        if (this.queue.length > 0) {
          await this.delay(this.config.minDelayMs);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private refillTokens(): void {
    const now = Date.now();
    const timePassed = now - this.lastTokenRefill;
    const msPerToken = 1000 / this.config.requestsPerSecond;
    const tokensToAdd = Math.floor(timePassed / msPerToken);

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.config.burstSize, this.tokens + tokensToAdd);
      this.lastTokenRefill = now;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Simple per-channel rate limiter for Discord.
 * Tracks rate limits per channel separately.
 */
export class PerChannelRateLimiter {
  private readonly globalLimiter: DiscordRateLimiter;
  private readonly channelStates = new Map<string, RateLimitState>();
  private readonly channelLimit = 5; // 5 messages per 5 seconds per channel
  private readonly channelWindow = 5000; // 5 seconds

  constructor(globalLimiter?: DiscordRateLimiter) {
    this.globalLimiter = globalLimiter ?? new DiscordRateLimiter();
  }

  /**
   * Acquire permission to send a message to a specific channel.
   */
  async acquire(channelId: string): Promise<void> {
    // First, respect global rate limit
    await this.globalLimiter.acquire();

    // Then check channel-specific limit
    const state = this.getChannelState(channelId);
    const now = Date.now();

    // Reset window if expired
    if (now - state.windowStart > this.channelWindow) {
      state.windowStart = now;
      state.requestCount = 0;
    }

    // Check if we've hit the channel limit
    if (state.requestCount >= this.channelLimit) {
      const waitTime = this.channelWindow - (now - state.windowStart);
      if (waitTime > 0) {
        getLogger().debug("Channel rate limit hit, waiting", {
          channelId,
          waitTime,
        });
        await this.delay(waitTime);
        // Recursively try again after wait
        return this.acquire(channelId);
      }
    }

    state.requestCount++;
    state.lastRequest = now;
  }

  /**
   * Report a rate limit error for a channel.
   */
  reportChannelRateLimit(channelId: string, retryAfterMs?: number): void {
    const state = this.getChannelState(channelId);
    state.requestCount = this.channelLimit; // Mark as exhausted
    state.windowStart = Date.now(); // Reset window

    this.globalLimiter.reportRateLimitError(retryAfterMs);
  }

  /**
   * Get status for all tracked channels.
   */
  getChannelStatuses(): Array<{
    channelId: string;
    requestCount: number;
    remainingInWindow: number;
  }> {
    const now = Date.now();
    const result = [];

    for (const [channelId, state] of this.channelStates) {
      // Clean up old entries
      if (now - state.windowStart > this.channelWindow * 2) {
        this.channelStates.delete(channelId);
        continue;
      }

      result.push({
        channelId,
        requestCount: state.requestCount,
        remainingInWindow: Math.max(0, this.channelLimit - state.requestCount),
      });
    }

    return result;
  }

  private getChannelState(channelId: string): RateLimitState {
    if (!this.channelStates.has(channelId)) {
      this.channelStates.set(channelId, {
        lastRequest: 0,
        requestCount: 0,
        windowStart: Date.now(),
      });
    }
    return this.channelStates.get(channelId)!;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
