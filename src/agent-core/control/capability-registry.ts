/**
 * Agent Core v2 — CapabilityRegistry (Phase 3b, ARCHITECTURE §7).
 *
 * The single owner of tool-substrate liveness — the tool-side analogue of the (KEEP)
 * `ProviderHealthRegistry`. v1 conflated tool availability across three places; v2 makes ONE owner of
 * "which capability is live, and what happens when it isn't". A **Capability** is a health-probed
 * substrate (`unity-bridge`, `dotnet-cli`, `mcp:strada`, `network`, `in-process`); a Tool binds to
 * zero-or-one capability (the binding + advertise/guardExecute wiring is the NEXT increment).
 *
 * The state machine mirrors `ProviderHealthEntry` field-for-field (`live`/`degraded`/`down`/`unknown`,
 * escalating cooldown via `downEpisodes`) with the borrowed nuance the spec calls out:
 *   - a REAL successful call heals fully to `live` (proof the substrate works);
 *   - a PROBE success heals only to `degraded` (a TCP ping proving the bridge answers is NOT proof a
 *     real compile will succeed) and deliberately KEEPS `downEpisodes` so escalation persists.
 * The registry is the ONLY mutator of capability health; the loop reads, never writes (no triplicated
 * counters). Time comes from the injected control-plane `Clock` (SystemClock in prod / FakeClock in
 * tests) so cooldown behavior is deterministic — unlike `ProviderHealthRegistry`'s raw `Date.now()`.
 *
 * ADDITIVE / UNWIRED: this ships the state-machine core + the typed BLOCKED contract. The read-path
 * `advertise` (into `prepareIteration`) and write-path `guardExecute` (revive-once → BLOCKED, with
 * heartbeat-through-revive + `classifyToolError` against `CancelReason`) land in the wiring increment.
 * Nothing imports this yet; it is gated by the default-off `capabilityRegistry` flag.
 */

import type { Clock } from "./clock.js";

export type CapabilityStatus = "live" | "degraded" | "down" | "unknown";

/** Per-capability health, mirroring `ProviderHealthEntry` + the 4th `unknown` state + `downEpisodes`. */
export interface CapabilityState {
  readonly status: CapabilityStatus;
  /** Consecutive substrate-attributed failures. */
  readonly consecutiveFailures: number;
  readonly lastFailureAt: number;
  /** Most recent error (truncated). */
  readonly lastError: string;
  /** Timestamp when a `down`/`degraded` capability is reconsidered (0 = immediately). */
  readonly cooldownUntil: number;
  /** Down episodes — drives the escalating (doubling) cooldown, persists across probe heals. */
  readonly downEpisodes: number;
}

export interface CapabilityRegistryConfig {
  /** Consecutive failures before `degraded`. */
  readonly degradedThreshold: number;
  /** Consecutive failures before `down`. */
  readonly downThreshold: number;
  readonly degradedCooldownMs: number;
  readonly downCooldownMs: number;
  /** Ceiling on the escalating `down` cooldown. */
  readonly maxCooldownMs: number;
}

/** Defaults mirror `ProviderHealthRegistry`'s proven thresholds/cooldowns. */
export const DEFAULT_CAPABILITY_CONFIG: CapabilityRegistryConfig = {
  degradedThreshold: 2,
  downThreshold: 5,
  degradedCooldownMs: 30_000,
  downCooldownMs: 120_000,
  maxCooldownMs: 10 * 60_000,
};

/** Read-path advertise decision for one capability (consumed by `prepareIteration` in the wiring increment). */
export interface CapabilityAdvertisement {
  /** false ⇒ withhold the bound tools from the prompt entirely (zero tokens). */
  readonly advertise: boolean;
  /** true ⇒ advertise WITH a one-clause degraded warning suffix. */
  readonly warn: boolean;
}

/**
 * The stable, parseable BLOCKED contract (write path) — one shape read by three consumers: the model
 * (to re-plan), the reflection layer (to NOT escalate into re-calling the dead tool), and the
 * partial-result surfacer. `needs` is `<capability>` or `<capability>#<feature>`.
 */
export interface BlockedCapabilityResult {
  readonly kind: "blocked";
  readonly capability: string;
  readonly feature?: string;
  readonly needs: string;
  readonly reason: string;
}

/** Build the typed BLOCKED result. */
export function buildBlocked(
  capability: string,
  reason: string,
  feature?: string,
): BlockedCapabilityResult {
  return {
    kind: "blocked",
    capability,
    ...(feature ? { feature } : {}),
    needs: feature ? `${capability}#${feature}` : capability,
    reason,
  };
}

/** Render the BLOCKED result to the stable wire string the three consumers parse. */
export function formatBlocked(b: BlockedCapabilityResult): string {
  return `BLOCKED needs=${b.needs} — ${b.reason}`;
}

function freshState(status: CapabilityStatus): CapabilityState {
  return {
    status,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    lastError: "",
    cooldownUntil: 0,
    downEpisodes: 0,
  };
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityState>();
  private readonly config: CapabilityRegistryConfig;
  private readonly clock: Clock;

  constructor(clock: Clock, config: Partial<CapabilityRegistryConfig> = {}) {
    this.clock = clock;
    this.config = { ...DEFAULT_CAPABILITY_CONFIG, ...config };
  }

  /**
   * Register a capability with an initial status. In-process capabilities (no external substrate to
   * probe) should register as `live`; external substrates (bridge/mcp/network) register `unknown`
   * until a real call or probe proves them. Idempotent — re-registering never resets live state.
   */
  register(capabilityId: string, initialStatus: CapabilityStatus = "unknown"): void {
    if (this.entries.has(capabilityId)) return;
    this.entries.set(capabilityId, freshState(initialStatus));
  }

  /** A REAL successful call → fully heal to `live` and clear escalation (proof the substrate works). */
  recordRealSuccess(capabilityId: string): void {
    const prev = this.entries.get(capabilityId);
    this.entries.set(capabilityId, {
      status: "live",
      consecutiveFailures: 0,
      lastFailureAt: prev?.lastFailureAt ?? 0,
      lastError: "",
      cooldownUntil: 0,
      downEpisodes: 0,
    });
  }

  /**
   * A PROBE success → heal only to `degraded` (allows advertising-with-warning, but a real call is
   * not yet proven). KEEPS `downEpisodes` so the escalating cooldown stays if it fails again. A probe
   * never downgrades an already-`live` capability.
   */
  recordProbeSuccess(capabilityId: string): void {
    const prev = this.entries.get(capabilityId);
    if (prev?.status === "live") return;
    this.entries.set(capabilityId, {
      status: "degraded",
      consecutiveFailures: prev ? Math.max(0, prev.consecutiveFailures - 1) : 0,
      lastFailureAt: prev?.lastFailureAt ?? 0,
      lastError: prev?.lastError ?? "",
      cooldownUntil: 0,
      downEpisodes: prev?.downEpisodes ?? 0,
    });
  }

  /**
   * A substrate-attributed failure → escalate by consecutive count: `downThreshold` → `down` (with a
   * doubling, capped cooldown that escalates per down episode); `degradedThreshold` → `degraded`;
   * below threshold → status unchanged (a transient blip), just tracked.
   */
  recordFailure(capabilityId: string, error: string): void {
    const prev = this.entries.get(capabilityId);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const now = this.clock.now();
    const lastError = error.slice(0, 200);

    if (failures >= this.config.downThreshold) {
      const episodes = prev?.downEpisodes ?? 0;
      const cooldown = Math.min(
        this.config.downCooldownMs * Math.pow(2, episodes),
        this.config.maxCooldownMs,
      );
      this.entries.set(capabilityId, {
        status: "down",
        consecutiveFailures: failures,
        lastFailureAt: now,
        lastError,
        cooldownUntil: now + cooldown,
        downEpisodes: episodes + 1,
      });
    } else if (failures >= this.config.degradedThreshold) {
      this.entries.set(capabilityId, {
        status: "degraded",
        consecutiveFailures: failures,
        lastFailureAt: now,
        lastError,
        cooldownUntil: now + this.config.degradedCooldownMs,
        downEpisodes: prev?.downEpisodes ?? 0,
      });
    } else {
      // Below the degrade threshold: status unchanged (don't promote `unknown`/`down`, don't degrade
      // `live`), just record the blip. A single failure on a `live` substrate stays `live`.
      this.entries.set(capabilityId, {
        status: prev?.status ?? "unknown",
        consecutiveFailures: failures,
        lastFailureAt: now,
        lastError,
        cooldownUntil: prev?.cooldownUntil ?? 0,
        downEpisodes: prev?.downEpisodes ?? 0,
      });
    }
  }

  /** The raw stored state (no cooldown reconsideration). undefined ⇒ never registered. */
  getState(capabilityId: string): CapabilityState | undefined {
    return this.entries.get(capabilityId);
  }

  /**
   * The EFFECTIVE status, applying cooldown auto-recovery: a `down`/`degraded` capability whose
   * cooldown has elapsed is reconsidered as `unknown` (eligible for a revive/probe before it can be
   * advertised again — mirrors `ProviderHealthRegistry.isAvailable`'s post-cooldown recovery, but
   * resolves to `unknown` rather than silently advertising an unproven substrate). Unregistered →
   * `unknown`.
   */
  effectiveStatus(capabilityId: string): CapabilityStatus {
    const e = this.entries.get(capabilityId);
    if (!e) return "unknown";
    // Auto-recover ONLY entries that were placed in a cooldown (cooldownUntil > 0) which has now
    // elapsed. A PROBE-healed `degraded` carries cooldownUntil = 0 ("usable now, degraded scoring",
    // mirroring ProviderHealthRegistry's probe heal) and must STAY `degraded` (advertise-with-warning)
    // until a real success/failure — never silently reconsidered to `unknown` (which would withhold a
    // probe-proven tool from the prompt, contra §7).
    if (
      (e.status === "down" || e.status === "degraded") &&
      e.cooldownUntil > 0 &&
      this.clock.now() >= e.cooldownUntil
    ) {
      return "unknown";
    }
    return e.status;
  }

  /** Read-path advertise decision: live → advertise; degraded → advertise+warn; down/unknown → withhold. */
  advertisement(capabilityId: string): CapabilityAdvertisement {
    switch (this.effectiveStatus(capabilityId)) {
      case "live":
        return { advertise: true, warn: false };
      case "degraded":
        return { advertise: true, warn: true };
      default:
        return { advertise: false, warn: false };
    }
  }

  /** True iff the capability is effectively `live`. */
  isLive(capabilityId: string): boolean {
    return this.effectiveStatus(capabilityId) === "live";
  }

  /**
   * True iff a guarded execution may ATTEMPT the capability (write path): anything but a still-cooling
   * `down`. A cooled-down `down` (effective `unknown`) is eligible for the revive-once attempt.
   */
  canAttempt(capabilityId: string): boolean {
    return this.effectiveStatus(capabilityId) !== "down";
  }
}
