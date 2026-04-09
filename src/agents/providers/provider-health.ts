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
const OVERLOAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const QUOTA_COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours

export class ProviderHealthRegistry {
  private static instance: ProviderHealthRegistry | null = null;

  private readonly entries = new Map<string, ProviderHealthEntry>();
  private readonly downEpisodes = new Map<string, number>();
  private readonly config: ProviderHealthConfig;

  private norm(name: string): string { return name.trim().toLowerCase(); }

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
   * @param kind - "real" for actual user-facing requests, "probe" for lightweight
   *   health probes. Probes move the provider to "degraded" instead of fully
   *   resetting to "healthy" so that a single tiny request cannot mask an
   *   ongoing overload situation. Only a real successful request fully heals.
   */
  recordSuccess(providerName: string, kind: "real" | "probe" = "real"): void {
    const normalized = this.norm(providerName);
    const existing = this.entries.get(normalized);
    if (!existing || existing.consecutiveFailures === 0) return;

    if (kind === "probe") {
      // Probe success: downgrade severity but do NOT fully reset.
      // Keep downEpisodes so escalation stays if the provider fails again.
      this.entries.set(normalized, {
        status: "degraded",
        consecutiveFailures: Math.max(1, existing.consecutiveFailures - 1),
        lastFailureAt: existing.lastFailureAt,
        lastError: existing.lastError,
        cooldownUntil: 0, // Allow traffic through, but degraded scoring
      });
      // Intentionally do NOT delete downEpisodes — probe is not proof of health
    } else {
      // Real success: full reset
      this.entries.set(normalized, {
        status: "healthy",
        consecutiveFailures: 0,
        lastFailureAt: existing.lastFailureAt,
        lastError: "",
        cooldownUntil: 0,
      });
      this.downEpisodes.delete(normalized);
    }
  }

  /**
   * Record a provider failure — increments failure count and may change status.
   */
  recordFailure(providerName: string, error: string): void {
    const normalized = this.norm(providerName);
    const failures = this.nextFailureCount(normalized);

    if (failures >= this.config.downThreshold) {
      this.markDown(normalized, this.config.downCooldownMs, error, true);
    } else if (failures >= this.config.degradedThreshold) {
      const now = Date.now();
      this.entries.set(normalized, {
        status: "degraded",
        consecutiveFailures: failures,
        lastFailureAt: now,
        lastError: error.slice(0, 200),
        cooldownUntil: now + this.config.degradedCooldownMs,
      });
    } else {
      const now = Date.now();
      this.entries.set(normalized, {
        status: "healthy",
        consecutiveFailures: failures,
        lastFailureAt: now,
        lastError: error.slice(0, 200),
        cooldownUntil: 0,
      });
    }
  }

  /**
   * Record a server overload (HTTP 529 / 503) — sets a medium cooldown (5 minutes)
   * to give the server cluster time to recover. Unlike transient errors which
   * use short degraded cooldowns, overload errors indicate systemic capacity issues.
   */
  recordOverloaded(providerName: string, error: string): void {
    this.markDown(this.norm(providerName), OVERLOAD_COOLDOWN_MS, error, true);
  }

  /**
   * Record a quota/billing exhaustion — sets a long cooldown (8 hours)
   * so the provider is not retried until the quota resets.
   */
  recordQuotaExhausted(providerName: string, error: string): void {
    const normalized = this.norm(providerName);
    const existing = this.entries.get(normalized);
    const now = Date.now();
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

  /** Shared helper: mark a provider as "down" with escalating cooldown. */
  private markDown(normalized: string, baseCooldownMs: number, error: string, escalate: boolean): void {
    const now = Date.now();
    const episodes = this.downEpisodes.get(normalized) ?? 0;
    const cooldownUntil = escalate
      ? now + Math.min(baseCooldownMs * Math.pow(2, episodes), MAX_ADAPTIVE_COOLDOWN_MS)
      : now + baseCooldownMs;

    this.entries.set(normalized, {
      status: "down",
      consecutiveFailures: this.nextFailureCount(normalized),
      lastFailureAt: now,
      lastError: error.slice(0, 200),
      cooldownUntil,
    });
    if (escalate) this.downEpisodes.set(normalized, episodes + 1);
  }

  private nextFailureCount(normalizedName: string): number {
    return (this.entries.get(normalizedName)?.consecutiveFailures ?? 0) + 1;
  }

  /**
   * Check if a provider is currently available for use.
   * Returns true if healthy, or if cooldown has expired (auto-recovery).
   */
  isAvailable(providerName: string): boolean {
    const normalized = this.norm(providerName);
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
    const normalized = this.norm(providerName);
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
    const normalized = this.norm(providerName);
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
    return this.downEpisodes.get(this.norm(providerName)) ?? 0;
  }

  /**
   * Check if ALL tracked providers are currently unavailable (in cooldown).
   * Returns false when no providers are tracked.
   */
  areAllUnavailable(): boolean {
    if (this.entries.size === 0) return false;
    for (const [name] of this.entries) {
      if (this.isAvailable(name)) return false;
    }
    return true;
  }

  /**
   * Check if a provider is in recovery state (was down, cooldown just expired).
   * Callers should probe before sending real traffic.
   */
  isRecovering(providerName: string): boolean {
    const normalized = this.norm(providerName);
    const entry = this.entries.get(normalized);
    if (!entry) return false;
    // Non-healthy entries always have consecutiveFailures > 0 by construction
    // (recordFailure/recordQuotaExhausted both increment the counter).
    // When cooldown expires without an explicit recordSuccess, the provider is "recovering".
    return entry.status !== "healthy" && Date.now() >= entry.cooldownUntil;
  }
}
