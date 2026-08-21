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

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalizeProviderName } from "./provider-identity.js";

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

/**
 * Parse an integer env override, falling back to `fallback` when unset, non-numeric, or
 * below `min`. Single source of truth for the file's env-int knobs (thresholds, cooldowns,
 * recovery-wait) so the validity predicate can't drift between them. `min` distinguishes
 * knobs that accept 0 (thresholds/waits) from those that require a positive value (cooldown
 * ceilings, where 0 is meaningless).
 */
function parseEnvIntMs(key: string, fallback: number, min = 0): number {
  const raw = process.env[key];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function resolveDefaultConfig(): ProviderHealthConfig {
  return {
    degradedThreshold: parseEnvIntMs("PROVIDER_HEALTH_DEGRADED_THRESHOLD", 2),
    downThreshold: parseEnvIntMs("PROVIDER_HEALTH_DOWN_THRESHOLD", 5),
    degradedCooldownMs: parseEnvIntMs("PROVIDER_HEALTH_DEGRADED_COOLDOWN_MS", 30_000),
    downCooldownMs: parseEnvIntMs("PROVIDER_HEALTH_DOWN_COOLDOWN_MS", 120_000),
  };
}

const MAX_ADAPTIVE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const OVERLOAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const QUOTA_COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours
const SINGLE_PROVIDER_QUOTA_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes (when no fallbacks exist)

/**
 * Upper bound for a hard-quota-stop cooldown sized from a provider's Retry-After. A
 * provider may advertise a multi-DAY reset (e.g. OpenCode's "resets in 3 days"); we
 * honor it but never lock a provider out longer than this ceiling, so a stale/bogus
 * Retry-After can't sideline a provider effectively forever. Overridable via env
 * PROVIDER_HEALTH_MAX_QUOTA_COOLDOWN_MS. Default 24h — long enough to skip a
 * day/week-scale quota block for the rest of the session, bounded enough to self-heal.
 */
function resolveMaxQuotaCooldownMs(): number {
  return parseEnvIntMs("PROVIDER_HEALTH_MAX_QUOTA_COOLDOWN_MS", 24 * 60 * 60 * 1000, 1); // 24h, must be > 0
}

/**
 * Upper bound on how long a caller (FallbackChain / delegation gate) may BLOCK waiting
 * for the soonest cooled provider to exit cooldown before aborting. Rides out a transient
 * all-cooled blip (every provider briefly degraded) rather than failing the whole task,
 * while never stalling on a genuinely-down or quota-blocked provider (recovery beyond this
 * window returns null → fail fast). Overridable via env PROVIDER_HEALTH_RECOVERY_WAIT_MS.
 * Default 60s == fetch-with-retry maxDelayMs (the longest single backoff the system already
 * tolerates) and comfortably under the 90s first-response timeout.
 */
function resolveRecoveryWaitMs(): number {
  return parseEnvIntMs("PROVIDER_HEALTH_RECOVERY_WAIT_MS", 60_000); // 60s
}

export class ProviderHealthRegistry {
  private static instance: ProviderHealthRegistry | null = null;

  private readonly entries = new Map<string, ProviderHealthEntry>();
  private readonly downEpisodes = new Map<string, number>();
  private readonly config: ProviderHealthConfig;

  /** Providers whose thinking/reasoning is suppressed after a reasoning timeout. */
  private readonly thinkingDisabledProviders = new Set<string>();
  /** Consecutive successes with thinking disabled — re-enable after threshold. */
  private readonly thinkingReEnableCounters = new Map<string, number>();
  private static readonly THINKING_RE_ENABLE_THRESHOLD = 3;

  /**
   * One provider, one name.
   *
   * ProviderAssigner canonicalizes before it asks ("kimi"); a 403 arrives under
   * whatever the provider calls itself ("Kimi (Moonshot)"). Keying on the raw
   * string let those two miss each other, and a miss reads as healthy — which
   * is how a quota-blocked provider kept being handed goals for five runs.
   * Unknown names still get their own entry via the lowercase fallback.
   */
  private norm(name: string): string {
    return canonicalizeProviderName(name) ?? name.trim().toLowerCase();
  }

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
  /**
   * The one place an entry changes, and therefore the one place persistence
   * has to be remembered.
   *
   * It was remembered in four of the five record methods. The fifth,
   * recordFailure, is the one the chain's recovery probe calls — so run 37
   * learned at 23:02 that Kimi was refusing, skipped it correctly for the rest
   * of the hour, wrote none of that down, and run 38 booted free to hand it
   * goals again. Hanging the write off the state change means the next record
   * method added cannot forget.
   *
   * Only a real transition writes. A healthy provider answering a hundred
   * calls stays healthy, changes nothing, and costs no I/O.
   */
  private setEntry(normalized: string, entry: ProviderHealthEntry): void {
    const previous = this.entries.get(normalized);
    this.entries.set(normalized, entry);
    if (
      previous?.status !== entry.status ||
      previous?.cooldownUntil !== entry.cooldownUntil
    ) {
      this.persistNow();
    }
  }

  recordSuccess(providerName: string, kind: "real" | "probe" = "real"): void {
    const normalized = this.norm(providerName);
    const existing = this.entries.get(normalized);
    if (!existing || existing.consecutiveFailures === 0) return;

    if (kind === "probe") {
      // Probe success: downgrade severity but do NOT fully reset.
      // Keep downEpisodes so escalation stays if the provider fails again.
      this.setEntry(normalized, {
        status: "degraded",
        consecutiveFailures: Math.max(1, existing.consecutiveFailures - 1),
        lastFailureAt: existing.lastFailureAt,
        lastError: existing.lastError,
        cooldownUntil: 0, // Allow traffic through, but degraded scoring
      });
      // Intentionally do NOT delete downEpisodes — probe is not proof of health
    } else {
      // Real success: full reset
      this.setEntry(normalized, {
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
      this.setEntry(normalized, {
        status: "degraded",
        consecutiveFailures: failures,
        lastFailureAt: now,
        lastError: error.slice(0, 200),
        cooldownUntil: now + this.config.degradedCooldownMs,
      });
    } else {
      const now = Date.now();
      this.setEntry(normalized, {
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
    this.persistNow();
  }

  /**
   * Record a server overload for a single-provider setup — uses a shorter
   * cooldown (30 seconds, non-escalating) so the lone provider retries sooner.
   */
  recordOverloadedShort(providerName: string, error: string): void {
    this.markDown(this.norm(providerName), 30_000, error, false);
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

    this.setEntry(normalized, {
      status: "down",
      consecutiveFailures: this.nextFailureCount(normalized),
      lastFailureAt: now,
      lastError: error.slice(0, 200),
      cooldownUntil,
    });
    this.persistNow();
  }

  /**
   * Record a quota exhaustion for a single-provider setup — uses a shorter
   * cooldown (15 min) so the lone provider recovers sooner instead of being
   * locked out for 8 hours with no fallback available.
   */
  recordQuotaExhaustedShort(providerName: string, error: string): void {
    const normalized = this.norm(providerName);
    const existing = this.entries.get(normalized);
    const now = Date.now();
    const existingCooldown = existing?.cooldownUntil ?? 0;
    const cooldownUntil = existingCooldown > now ? existingCooldown : now + SINGLE_PROVIDER_QUOTA_COOLDOWN_MS;

    this.setEntry(normalized, {
      status: "down",
      consecutiveFailures: this.nextFailureCount(normalized),
      lastFailureAt: now,
      lastError: error.slice(0, 200),
      cooldownUntil,
    });
    this.persistNow();
  }

  /**
   * Record a HARD QUOTA STOP (a 429 whose Retry-After exceeds our entire retry budget —
   * the provider cannot recover within our window, e.g. a weekly usage-limit reset days
   * out). Sets the cooldown to the requested duration (≈ the provider's Retry-After) so
   * the provider is skipped for the rest of the session instead of being futilely
   * retried, capped to a sane maximum (PROVIDER_HEALTH_MAX_QUOTA_COOLDOWN_MS, default
   * 24h) so a stale/bogus Retry-After can't lock it out effectively forever. Does NOT
   * extend an already-longer active cooldown (keep the original, later expiry).
   */
  recordQuotaHardStop(providerName: string, retryAfterMs: number, error: string): void {
    const normalized = this.norm(providerName);
    const existing = this.entries.get(normalized);
    const now = Date.now();
    const cap = resolveMaxQuotaCooldownMs();
    const requested = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, cap)
      : QUOTA_COOLDOWN_MS;
    const desired = now + requested;
    const existingCooldown = existing?.cooldownUntil ?? 0;
    const cooldownUntil = existingCooldown > desired ? existingCooldown : desired;

    this.setEntry(normalized, {
      status: "down",
      consecutiveFailures: this.nextFailureCount(normalized),
      lastFailureAt: now,
      lastError: error.slice(0, 200),
      cooldownUntil,
    });
    this.persistNow();
  }

  /** Shared helper: mark a provider as "down" with escalating cooldown. */
  private markDown(normalized: string, baseCooldownMs: number, error: string, escalate: boolean): void {
    const now = Date.now();
    const episodes = this.downEpisodes.get(normalized) ?? 0;
    const cooldownUntil = escalate
      ? now + Math.min(baseCooldownMs * Math.pow(2, episodes), MAX_ADAPTIVE_COOLDOWN_MS)
      : now + baseCooldownMs;

    this.setEntry(normalized, {
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

  // ── Thinking disable state (singleton-owned) ──────────────────────────

  disableThinking(providerName: string): void {
    const normalized = this.norm(providerName);
    this.thinkingDisabledProviders.add(normalized);
    this.thinkingReEnableCounters.set(normalized, 0);
  }

  isThinkingDisabled(providerName: string): boolean {
    return this.thinkingDisabledProviders.has(this.norm(providerName));
  }

  enableThinking(providerName: string): void {
    const normalized = this.norm(providerName);
    this.thinkingDisabledProviders.delete(normalized);
    this.thinkingReEnableCounters.delete(normalized);
  }

  /** Returns true when consecutive success count reaches threshold (3). */
  recordThinkingSuccess(providerName: string): boolean {
    const normalized = this.norm(providerName);
    const count = (this.thinkingReEnableCounters.get(normalized) ?? 0) + 1;
    this.thinkingReEnableCounters.set(normalized, count);
    return count >= ProviderHealthRegistry.THINKING_RE_ENABLE_THRESHOLD;
  }

  resetThinkingSuccessCounter(providerName: string): void {
    this.thinkingReEnableCounters.set(this.norm(providerName), 0);
  }

  /** Remove all state for a provider (health, episodes, thinking). */
  clearProviderState(providerName: string): void {
    const normalized = this.norm(providerName);
    this.entries.delete(normalized);
    this.downEpisodes.delete(normalized);
    this.thinkingDisabledProviders.delete(normalized);
    this.thinkingReEnableCounters.delete(normalized);
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

  /**
   * When ALL of the caller's providers are currently unavailable, return the bounded number of
   * milliseconds to wait for the SOONEST one to exit cooldown — but ONLY when that recovery
   * is imminent (within resolveRecoveryWaitMs()). Returns null when: the set is empty, at least
   * one provider is already available (no wait needed — use it), or the soonest recovery is
   * beyond the wait window (a genuinely-down / quota-blocked provider — waiting synchronously
   * would just stall the caller, so fail fast instead). Lets a caller ride out a transient
   * all-cooled blip rather than aborting the whole task on a brief cooldown overlap.
   *
   * @param providerNames Scope the decision to exactly these providers (e.g. a FallbackChain's
   *   own `this.providers`). A chain holding a strict subset of the globally-tracked providers
   *   must NOT wait for — or be blocked by — a provider it cannot use. Omit to consider every
   *   tracked provider (the coarse delegation pre-flight gate). An untracked name counts as
   *   available (never failed ⇒ healthy), so a chain with any fresh provider never waits.
   */
  suggestRecoveryWaitMs(now: number = Date.now(), providerNames?: readonly string[]): number | null {
    const names = providerNames ?? [...this.entries.keys()];
    if (names.length === 0) return null;
    let soonest = Infinity;
    for (const rawName of names) {
      if (this.isAvailable(rawName)) return null; // a usable provider exists — no wait
      // Unavailable ⇒ tracked, status !== healthy, AND cooldownUntil > now (isAvailable
      // auto-recovers once now >= cooldownUntil), so cooldownUntil is a real future instant.
      const entry = this.entries.get(this.norm(rawName));
      if (entry && entry.cooldownUntil < soonest) soonest = entry.cooldownUntil;
    }
    if (!Number.isFinite(soonest)) return null;
    const waitMs = Math.max(0, soonest - now);
    return waitMs <= resolveRecoveryWaitMs() ? waitMs : null;
  }

  /** Persist health state to disk so it survives process restarts. */
  save(path: string): void {
    try {
      const data = {
        entries: Array.from(this.entries.entries()),
        thinkingDisabled: Array.from(this.thinkingDisabledProviders),
        thinkingCounters: Array.from(this.thinkingReEnableCounters.entries()),
      };
      writeFileSync(path, JSON.stringify(data, null, 2));
    } catch {
      // Persistence is best-effort
    }
  }

  /**
   * Where to write a long cooldown the moment it is recorded.
   *
   * Set by load(), which bootstrap calls with the same path the shutdown hook
   * saves to. Measured 2026-08-21: the file never existed, because saving
   * happened only on a clean shutdown and every run that day ended with a hard
   * kill. Each new process therefore started blind, assigned goals to a
   * provider whose quota had run out hours earlier, and spent its first minute
   * discovering that by failing.
   */
  private persistPath: string | null = null;

  /** Write now, for facts that must survive a kill. Best-effort, like save(). */
  private persistNow(): void {
    if (this.persistPath) this.save(this.persistPath);
  }

  /** Load health state from disk (idempotent — safe to call multiple times). */
  /**
   * Who is currently not usable, and until when — for the boot line that proves
   * the restore happened at all.
   */
  unavailableProviders(): string[] {
    const out: string[] = [];
    for (const [name, entry] of this.entries) {
      if (!this.isAvailable(name)) {
        const until = entry.cooldownUntil
          ? ` until ${new Date(entry.cooldownUntil).toISOString()}`
          : "";
        out.push(`${name} (${entry.status}${until})`);
      }
    }
    return out;
  }

  load(path: string): void {
    this.persistPath = path;
    try {
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        entries?: Array<[string, ProviderHealthEntry]>;
        thinkingDisabled?: string[];
        thinkingCounters?: Array<[string, number]>;
      };
      if (raw.entries) {
        for (const [k, v] of raw.entries) {
          // Re-key: files written before names were canonicalized hold the
          // display name, and a cooldown nobody can look up is a cooldown lost.
          this.entries.set(this.norm(k), v);
        }
      }
      if (raw.thinkingDisabled) {
        for (const p of raw.thinkingDisabled) {
          this.thinkingDisabledProviders.add(p);
        }
      }
      if (raw.thinkingCounters) {
        for (const [k, v] of raw.thinkingCounters) {
          this.thinkingReEnableCounters.set(k, v);
        }
      }
    } catch {
      // Ignore corrupt or missing persistence file
    }
  }
}
