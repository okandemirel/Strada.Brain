/**
 * Provider Health Registry
 *
 * Tracks runtime health status per provider. Failures are recorded with
 * automatic recovery after a configurable cooldown. Consumed by
 * FallbackChainProvider (skip unhealthy), ProviderRouter (scoring penalty),
 * and ProviderAssigner (healthy/nearRateLimit flags).
 *
 * Singleton — shared across the entire process.
 */

export type ProviderHealthStatus = "healthy" | "degraded" | "down";

export interface ProviderHealthEntry {
  status: ProviderHealthStatus;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Timestamp of the last failure */
  lastFailureAt: number;
  /** Most recent error message (truncated) */
  lastError: string;
  /** Timestamp when the provider will be reconsidered (0 = immediately) */
  cooldownUntil: number;
}

export interface ProviderHealthConfig {
  /** Number of consecutive failures before marking provider as "degraded" */
  degradedThreshold: number;
  /** Number of consecutive failures before marking provider as "down" */
  downThreshold: number;
  /** Cooldown in ms after which a "degraded" provider is reconsidered */
  degradedCooldownMs: number;
  /** Cooldown in ms after which a "down" provider is reconsidered */
  downCooldownMs: number;
}

function resolveDefaultConfig(): ProviderHealthConfig {
  const envInt = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    degradedThreshold: envInt("PROVIDER_HEALTH_DEGRADED_THRESHOLD", 2),
    downThreshold: envInt("PROVIDER_HEALTH_DOWN_THRESHOLD", 5),
    degradedCooldownMs: envInt("PROVIDER_HEALTH_DEGRADED_COOLDOWN_MS", 30_000),
    downCooldownMs: envInt("PROVIDER_HEALTH_DOWN_COOLDOWN_MS", 120_000),
  };
}

const MAX_ADAPTIVE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export class ProviderHealthRegistry {
  private static instance: ProviderHealthRegistry | null = null;

  private readonly entries = new Map<string, ProviderHealthEntry>();
  private readonly downEpisodes = new Map<string, number>();
  private readonly config: ProviderHealthConfig;

  constructor(config: Partial<ProviderHealthConfig> = {}) {
    this.config = { ...resolveDefaultConfig(), ...config };
  }

  static getInstance(config?: Partial<ProviderHealthConfig>): ProviderHealthRegistry {
    if (!ProviderHealthRegistry.instance) {
      ProviderHealthRegistry.instance = new ProviderHealthRegistry(config);
    }
    return ProviderHealthRegistry.instance;
  }

  /** Reset for testing */
  static resetInstance(): void {
    ProviderHealthRegistry.instance = null;
  }

  /**
   * Record a successful provider call — resets failure state.
   */
  recordSuccess(providerName: string): void {
    const normalized = providerName.trim().toLowerCase();
    const existing = this.entries.get(normalized);
    if (existing && existing.consecutiveFailures > 0) {
      this.entries.set(normalized, {
        status: "healthy",
        consecutiveFailures: 0,
        lastFailureAt: existing.lastFailureAt,
        lastError: "",
        cooldownUntil: 0,
      });
      this.downEpisodes.delete(normalized); // Reset escalation on success
    }
  }

  /**
   * Record a provider failure — increments failure count and may change status.
   */
  recordFailure(providerName: string, error: string): void {
    const normalized = providerName.trim().toLowerCase();
    const failures = this.nextFailureCount(normalized);
    const now = Date.now();

    let status: ProviderHealthStatus = "healthy";
    let cooldownUntil = 0;

    if (failures >= this.config.downThreshold) {
      const episodes = this.downEpisodes.get(normalized) ?? 0;
      const escalatedCooldown = Math.min(
        this.config.downCooldownMs * Math.pow(2, episodes),
        MAX_ADAPTIVE_COOLDOWN_MS,
      );
      status = "down";
      cooldownUntil = now + escalatedCooldown;
      this.downEpisodes.set(normalized, episodes + 1);
    } else if (failures >= this.config.degradedThreshold) {
      status = "degraded";
      cooldownUntil = now + this.config.degradedCooldownMs;
    }

    this.entries.set(normalized, {
      status,
      consecutiveFailures: failures,
      lastFailureAt: now,
      lastError: error.slice(0, 200),
      cooldownUntil,
    });
  }

  /**
   * Record an overloaded response (HTTP 529/503) — sets a moderate cooldown
   * (5 minutes) so the provider has time to recover from load.
   */
  recordOverloaded(providerName: string, error: string): void {
    const normalized = providerName.trim().toLowerCase();
    const existing = this.entries.get(normalized);
    const now = Date.now();
    const OVERLOAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

    // Don't extend an existing active cooldown — keep the original expiry
    const existingCooldown = existing?.cooldownUntil ?? 0;
    const cooldownUntil = existingCooldown > now ? existingCooldown : now + OVERLOAD_COOLDOWN_MS;

    this.entries.set(normalized, {
      status: "down",
      consecutiveFailures: this.nextFailureCount(normalized),
      lastFailureAt: now,
      lastError: error.slice(0, 200),
      cooldownUntil,
    });
  }

  /**
   * Record a quota/billing exhaustion — sets a long cooldown (8 hours)
   * so the provider is not retried until the quota resets.
   */
  recordQuotaExhausted(providerName: string, error: string): void {
    const normalized = providerName.trim().toLowerCase();
    const existing = this.entries.get(normalized);
    const now = Date.now();
    const QUOTA_COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours

    // Don't extend an existing active cooldown — keep the original expiry
    const existingCooldown = existing?.cooldownUntil ?? 0;
    const cooldownUntil = existingCooldown > now ? existingCooldown : now + QUOTA_COOLDOWN_MS;

    this.entries.set(normalized, {
      status: "down",
      consecutiveFailures: this.nextFailureCount(normalized),
      lastFailureAt: now,
      lastError: error.slice(0, 200),
      cooldownUntil,
    });
  }

  private nextFailureCount(normalizedName: string): number {
    return (this.entries.get(normalizedName)?.consecutiveFailures ?? 0) + 1;
  }

  /**
   * Check if a provider is currently available for use.
   * Returns true if healthy, or if cooldown has expired (auto-recovery).
   */
  isAvailable(providerName: string): boolean {
    const normalized = providerName.trim().toLowerCase();
    const entry = this.entries.get(normalized);
    if (!entry || entry.status === "healthy") return true;
    // Auto-recover after cooldown
    if (Date.now() >= entry.cooldownUntil) return true;
    return false;
  }

  /**
   * Get the health status of a provider.
   */
  getStatus(providerName: string): ProviderHealthStatus {
    const normalized = providerName.trim().toLowerCase();
    const entry = this.entries.get(normalized);
    if (!entry) return "healthy";
    // Auto-recover after cooldown
    if (entry.status !== "healthy" && Date.now() >= entry.cooldownUntil) return "healthy";
    return entry.status;
  }

  /**
   * Get the full health entry for a provider (or undefined if never tracked).
   */
  getEntry(providerName: string): ProviderHealthEntry | undefined {
    const normalized = providerName.trim().toLowerCase();
    return this.entries.get(normalized);
  }

  /**
   * Get all provider health entries (for dashboard/monitoring).
   */
  getAllEntries(): ReadonlyMap<string, ProviderHealthEntry> {
    return this.entries;
  }

  /**
   * Check if a provider is near its rate limit (degraded but not down).
   */
  isNearRateLimit(providerName: string): boolean {
    return this.getStatus(providerName) === "degraded";
  }

  /**
   * Get the number of down episodes for a provider (for testing/observability).
   */
  getDownEpisodes(providerName: string): number {
    return this.downEpisodes.get(providerName.trim().toLowerCase()) ?? 0;
  }

  /**
   * Check if a provider is in recovery state (was down, cooldown just expired).
   * Callers should probe before sending real traffic.
   */
  isRecovering(providerName: string): boolean {
    const normalized = providerName.trim().toLowerCase();
    const entry = this.entries.get(normalized);
    if (!entry) return false;
    // Non-healthy entries always have consecutiveFailures > 0 by construction
    // (recordFailure/recordQuotaExhausted both increment the counter).
    // When cooldown expires without an explicit recordSuccess, the provider is "recovering".
    return entry.status !== "healthy" && Date.now() >= entry.cooldownUntil;
  }
}
