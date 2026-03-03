/**
 * Tiered rate limiter for Slack API calls.
 * Implements Slack's rate limiting tiers: https://api.slack.com/docs/rate-limits
 */

import { getLogger } from "../../utils/logger.js";

interface RateLimitConfig {
  /** Requests per minute allowed */
  requestsPerMinute: number;
  /** Requests per hour allowed */
  requestsPerHour?: number;
  /** Burst allowance for short spikes */
  burstAllowance?: number;
}

interface RateLimitTiers {
  /** Tier 1: Posting messages, etc. - 1+ per second */
  tier1: RateLimitConfig;
  /** Tier 2: Convergent methods - ~20 per minute */
  tier2: RateLimitConfig;
  /** Tier 3: Dialogs, etc. - ~50 per minute */
  tier3: RateLimitConfig;
  /** Tier 4: Web API methods - Special tiers */
  tier4: RateLimitConfig;
}

interface RequestRecord {
  timestamp: number;
  tier: 1 | 2 | 3 | 4;
  method: string;
}

/**
 * Slack Rate Limiter implementing tiered rate limiting.
 * 
 * Slack API Rate Limits:
 * - Tier 1 (PostMessage): 1+ per second per channel
 * - Tier 2 (Conversations.*): ~20 per minute
 * - Tier 3 (Dialogs, Views): ~50 per minute  
 * - Tier 4 (Other): Varies by method
 */
export class SlackRateLimiter {
  private readonly logger = getLogger();
  
  // Request history for rate tracking
  private readonly requestHistory: RequestRecord[] = [];
  private readonly historyWindowMs = 60 * 60 * 1000; // 1 hour window
  
  // Pending request queues per tier
  private readonly queues: Map<number, Array<() => void>> = new Map([
    [1, []],
    [2, []],
    [3, []],
    [4, []],
  ]);
  
  // Processing state per tier
  private readonly processing: Map<number, boolean> = new Map([
    [1, false],
    [2, false],
    [3, false],
    [4, false],
  ]);

  // Default tier configurations
  private readonly tiers: RateLimitTiers;

  constructor(customTiers?: Partial<RateLimitTiers>) {
    this.tiers = {
      tier1: {
        requestsPerMinute: 60, // 1 per second
        requestsPerHour: 3000,
        burstAllowance: 5,
        ...customTiers?.tier1,
      },
      tier2: {
        requestsPerMinute: 20,
        requestsPerHour: 1000,
        burstAllowance: 3,
        ...customTiers?.tier2,
      },
      tier3: {
        requestsPerMinute: 50,
        requestsPerHour: 2000,
        burstAllowance: 5,
        ...customTiers?.tier3,
      },
      tier4: {
        requestsPerMinute: 100,
        requestsPerHour: 5000,
        burstAllowance: 10,
        ...customTiers?.tier4,
      },
    };
  }

  /**
   * Acquire permission to make an API call.
   * Returns a promise that resolves when the call can proceed.
   */
  async acquire(method: string, tier: 1 | 2 | 3 | 4 = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Rate limit acquisition timeout for ${method}`));
      }, 30000); // 30 second timeout

      const attempt = (): void => {
        if (this.canProceed(tier)) {
          clearTimeout(timeout);
          this.recordRequest(method, tier);
          resolve();
        } else {
          // Add to queue
          const queue = this.queues.get(tier)!;
          
          queue.push(() => {
            clearTimeout(timeout);
            this.recordRequest(method, tier);
            resolve();
          });

          // Schedule processing
          this.scheduleProcessing(tier);
        }
      };

      attempt();
    });
  }

  /**
   * Check if a request can proceed immediately.
   */
  private canProceed(tier: 1 | 2 | 3 | 4): boolean {
    const config = this.getTierConfig(tier);
    const now = Date.now();
    
    // Clean old history
    this.cleanHistory();

    // Get recent requests for this tier
    const recentRequests = this.requestHistory.filter(
      (r) => r.tier === tier && now - r.timestamp < 60000
    );
    
    const recentHourRequests = this.requestHistory.filter(
      (r) => r.tier === tier && now - r.timestamp < 3600000
    );

    // Check minute limit
    if (recentRequests.length >= config.requestsPerMinute) {
      return false;
    }

    // Check hour limit
    if (config.requestsPerHour && recentHourRequests.length >= config.requestsPerHour) {
      return false;
    }

    // Check burst allowance
    const veryRecent = recentRequests.filter((r) => now - r.timestamp < 1000);
    if (veryRecent.length >= (config.burstAllowance || 1)) {
      return false;
    }

    return true;
  }

  /**
   * Record a request in history.
   */
  private recordRequest(method: string, tier: 1 | 2 | 3 | 4): void {
    this.requestHistory.push({
      timestamp: Date.now(),
      tier,
      method,
    });
  }

  /**
   * Clean old request history.
   */
  private cleanHistory(): void {
    const cutoff = Date.now() - this.historyWindowMs;
    const index = this.requestHistory.findIndex((r) => r.timestamp > cutoff);
    
    if (index > 0) {
      this.requestHistory.splice(0, index);
    }
  }

  /**
   * Schedule queue processing for a tier.
   */
  private scheduleProcessing(tier: 1 | 2 | 3 | 4): void {
    if (this.processing.get(tier)) {
      return;
    }

    this.processing.set(tier, true);

    // Calculate delay based on tier
    const delay = this.calculateDelay(tier);

    setTimeout(() => {
      this.processQueue(tier);
    }, delay);
  }

  /**
   * Process queued requests for a tier.
   */
  private processQueue(tier: 1 | 2 | 3 | 4): void {
    const queue = this.queues.get(tier)!;
    
    while (queue.length > 0 && this.canProceed(tier)) {
      const next = queue.shift();
      if (next) {
        next();
      }
    }

    this.processing.set(tier, false);

    // Schedule more processing if queue not empty
    if (queue.length > 0) {
      this.scheduleProcessing(tier);
    }
  }

  /**
   * Calculate delay before next request for a tier.
   */
  private calculateDelay(tier: 1 | 2 | 3 | 4): number {
    const config = this.getTierConfig(tier);
    const minInterval = 60000 / config.requestsPerMinute;
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 100;
    
    return Math.max(minInterval, 100) + jitter;
  }

  /**
   * Get configuration for a tier.
   */
  private getTierConfig(tier: 1 | 2 | 3 | 4): RateLimitConfig {
    switch (tier) {
      case 1:
        return this.tiers.tier1;
      case 2:
        return this.tiers.tier2;
      case 3:
        return this.tiers.tier3;
      case 4:
        return this.tiers.tier4;
      default:
        return this.tiers.tier1;
    }
  }

  /**
   * Get the rate limit tier for a Slack API method.
   */
  getMethodTier(method: string): 1 | 2 | 3 | 4 {
    const tier1Methods = [
      "chat.postMessage",
      "chat.postEphemeral",
      "chat.update",
      "chat.delete",
      "reactions.add",
      "reactions.remove",
    ];

    const tier2Methods = [
      "conversations.*",
      "channels.*",
      "groups.*",
      "im.*",
      "mpim.*",
      "users.*",
    ];

    const tier3Methods = [
      "views.*",
      "dialog.*",
      "workflows.*",
    ];

    if (tier1Methods.some((m) => method.match(m.replace("*", ".*")))) {
      return 1;
    }

    if (tier2Methods.some((m) => method.match(m.replace("*", ".*")))) {
      return 2;
    }

    if (tier3Methods.some((m) => method.match(m.replace("*", ".*")))) {
      return 3;
    }

    return 4;
  }

  /**
   * Handle rate limit response from Slack.
   * Returns the recommended wait time in milliseconds.
   */
  handleRateLimitResponse(retryAfter: number): number {
    this.logger.warn("Slack rate limit hit", { retryAfter });
    
    // Add buffer to retry-after
    const waitTime = (retryAfter * 1000) + 1000;
    
    return waitTime;
  }

  /**
   * Get current rate limit status.
   */
  getStatus(): Record<string, { used: number; limit: number; remaining: number }> {
    this.cleanHistory();
    const now = Date.now();

    const status: Record<string, { used: number; limit: number; remaining: number }> = {};

    for (const tier of [1, 2, 3, 4] as const) {
      const config = this.getTierConfig(tier);
      const recentRequests = this.requestHistory.filter(
        (r) => r.tier === tier && now - r.timestamp < 60000
      );

      status[`tier${tier}`] = {
        used: recentRequests.length,
        limit: config.requestsPerMinute,
        remaining: Math.max(0, config.requestsPerMinute - recentRequests.length),
      };
    }

    return status;
  }

  /**
   * Reset all rate limits (for testing).
   */
  reset(): void {
    this.requestHistory.length = 0;
    for (const tier of [1, 2, 3, 4] as const) {
      this.queues.get(tier)!.length = 0;
      this.processing.set(tier, false);
    }
  }

  /**
   * Wait for all pending requests to complete.
   */
  async drain(): Promise<void> {
    const checkQueue = (): boolean => {
      for (const tier of [1, 2, 3, 4] as const) {
        if (this.queues.get(tier)!.length > 0) {
          return false;
        }
      }
      return true;
    };

    while (!checkQueue()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Create a default rate limiter instance.
 */
export function createDefaultRateLimiter(): SlackRateLimiter {
  return new SlackRateLimiter();
}

/**
 * Rate limiter for file uploads (separate limits).
 */
export class FileUploadRateLimiter {
  private lastUploadTime = 0;
  private readonly minIntervalMs: number;

  constructor(uploadsPerMinute = 10) {
    this.minIntervalMs = 60000 / uploadsPerMinute;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const timeSinceLastUpload = now - this.lastUploadTime;

    if (timeSinceLastUpload < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - timeSinceLastUpload;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastUploadTime = Date.now();
  }

  reset(): void {
    this.lastUploadTime = 0;
  }
}

/**
 * Rate limiter for streaming updates.
 */
export class StreamingRateLimiter {
  private lastUpdateTime = 0;
  private readonly minIntervalMs: number;

  constructor(updatesPerSecond = 2) {
    this.minIntervalMs = 1000 / updatesPerSecond;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;

    if (timeSinceLastUpdate < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - timeSinceLastUpdate;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastUpdateTime = Date.now();
  }

  shouldUpdate(): boolean {
    const now = Date.now();
    return now - this.lastUpdateTime >= this.minIntervalMs;
  }

  reset(): void {
    this.lastUpdateTime = 0;
  }
}
