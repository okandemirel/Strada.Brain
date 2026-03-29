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

export class ProviderHealthRegistry {
  private static instance: ProviderHealthRegistry | null = null;

  private readonly entries = new Map<string, ProviderHealthEntry>();
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
    }
  }

  /**
   * Record a provider failure — increments failure count and may change status.
   */
  recordFailure(providerName: string, error: string): void {
    const normalized = providerName.trim().toLowerCase();
    const existing = this.entries.get(normalized);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    const now = Date.now();

    let status: ProviderHealthStatus = "healthy";
    let cooldownUntil = 0;

    if (failures >= this.config.downThreshold) {
      status = "down";
      cooldownUntil = now + this.config.downCooldownMs;
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
}
