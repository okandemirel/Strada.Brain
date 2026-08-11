/**
 * Tier Router
 *
 * Resolves model tier specifications to provider:model strings,
 * manages escalation chains, and supports runtime tier overrides
 * (in-memory + optional SQLite persistence via daemon_state).
 *
 * Requirements: AGENT-03, AGENT-04
 */

import type Database from "better-sqlite3";
import { ESCALATION_CHAIN, type ModelTier } from "./delegation-types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const OVERRIDE_KEY_PREFIX = "delegation_tier_override:";

// =============================================================================
// TIER ROUTER
// =============================================================================

export class TierRouter {
  private readonly overrides = new Map<string, ModelTier>();
  private tierMap: Record<ModelTier, string>;

  constructor(
    tierMap: Record<ModelTier, string>,
    private readonly db?: Database.Database,
  ) {
    this.tierMap = { ...tierMap };
    // Load persisted overrides from SQLite on construction
    if (this.db) {
      this.loadOverridesFromDb();
    }
  }

  /**
   * Replace the tier→spec mapping for tiers the operator did NOT pin.
   *
   * Called after the model catalog is available (and again whenever it
   * refreshes) so derived tiers track the current model generation without a
   * restart. Entries whose configured value was non-empty are pins and are not
   * passed here by the caller, so they can never be clobbered.
   *
   * A tier that derivation could not resolve is left at its existing value
   * rather than being blanked — losing a working spec to a transient empty
   * catalog would be worse than keeping a stale one.
   */
  applyDerivedTiers(derived: Partial<Record<ModelTier, string>>): void {
    for (const [tier, spec] of Object.entries(derived) as Array<[ModelTier, string | undefined]>) {
      if (spec && spec.trim()) {
        this.tierMap[tier] = spec;
      }
    }
  }

  /** Current tier→spec mapping (pins and derived values merged). */
  getTierMap(): Readonly<Record<ModelTier, string>> {
    return { ...this.tierMap };
  }

  /**
   * Resolve a tier to its "provider:model" spec string.
   * Checks type-level overrides first (where the key maps to a different tier),
   * then falls back to the configured tier map.
   *
   * Note: When setOverride is called with a tier key (e.g., "cheap" -> "standard"),
   * subsequent resolveProviderSpec("cheap") will return standard's spec.
   */
  resolveProviderSpec(tier: ModelTier): string {
    // Check if this tier has been overridden to another tier
    const overrideTier = this.overrides.get(tier);
    if (overrideTier) {
      return this.tierMap[overrideTier];
    }
    return this.tierMap[tier];
  }

  /**
   * Parse the provider spec string into { name, model } for a given tier.
   */
  resolveProviderConfig(tier: ModelTier): { name: string; model: string } {
    const spec = this.resolveProviderSpec(tier);
    const colonIdx = spec.indexOf(":");
    if (colonIdx === -1) {
      return { name: spec, model: "" };
    }
    return {
      name: spec.substring(0, colonIdx),
      model: spec.substring(colonIdx + 1),
    };
  }

  /**
   * Get the next-higher tier in the escalation chain.
   * Returns null for local (excluded from escalation) and premium (top of chain).
   */
  getEscalationTier(currentTier: ModelTier): ModelTier | null {
    if (currentTier === "local") return null;

    const idx = ESCALATION_CHAIN.indexOf(currentTier as typeof ESCALATION_CHAIN[number]);
    if (idx === -1 || idx === ESCALATION_CHAIN.length - 1) return null;

    return ESCALATION_CHAIN[idx + 1] as ModelTier;
  }

  /**
   * Set a runtime tier override for a delegation type (or tier key).
   * Persists to SQLite if a database was provided.
   */
  setOverride(type: string, tier: ModelTier): void {
    this.overrides.set(type, tier);

    if (this.db) {
      this.db.prepare(
        `INSERT OR REPLACE INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)`,
      ).run(`${OVERRIDE_KEY_PREFIX}${type}`, tier, Date.now());
    }
  }

  /**
   * Get the current override for a delegation type.
   */
  getOverride(type: string): ModelTier | undefined {
    return this.overrides.get(type);
  }

  /**
   * Remove a runtime override.
   */
  clearOverride(type: string): void {
    this.overrides.delete(type);

    if (this.db) {
      this.db.prepare(
        `DELETE FROM daemon_state WHERE key = ?`,
      ).run(`${OVERRIDE_KEY_PREFIX}${type}`);
    }
  }

  /**
   * Get the effective tier for a delegation type, considering overrides.
   * Returns the override if set, otherwise the default tier.
   */
  getTypeEffectiveTier(type: string, defaultTier: ModelTier): ModelTier {
    return this.overrides.get(type) ?? defaultTier;
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private loadOverridesFromDb(): void {
    if (!this.db) return;

    const rows = this.db.prepare(
      `SELECT key, value FROM daemon_state WHERE key LIKE ?`,
    ).all(`${OVERRIDE_KEY_PREFIX}%`) as Array<{ key: string; value: string }>;

    const validTiers = new Set<string>(["local", "cheap", "standard", "premium"]);
    for (const row of rows) {
      if (!validTiers.has(row.value)) continue; // Skip invalid/tampered values
      const type = row.key.substring(OVERRIDE_KEY_PREFIX.length);
      this.overrides.set(type, row.value as ModelTier);
    }
  }
}
