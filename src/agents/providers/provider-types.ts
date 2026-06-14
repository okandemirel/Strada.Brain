/**
 * Shared Provider Types
 *
 * Extracted from provider-manager.ts and model-intelligence.ts to break
 * circular module dependencies between model-intelligence, provider-manager,
 * and provider-catalog.
 */

import type { ProviderCapabilities } from "./provider.interface.js";
import type { ProviderSelectionMode } from "./provider-preferences.js";
import type { ProviderOfficialSnapshot } from "./provider-source-registry.js";
import type { ProviderHealthStatus } from "./provider-health.js";

// ---------------------------------------------------------------------------
// From model-intelligence.ts
// ---------------------------------------------------------------------------

export interface RefreshResult {
  readonly modelsUpdated: number;
  readonly source: "litellm" | "models.dev" | "cache" | "hardcoded";
  readonly errors: string[];
}

// ---------------------------------------------------------------------------
// From provider-manager.ts
// ---------------------------------------------------------------------------

export interface ProviderActiveInfo {
  providerName: string;
  model: string;
  isDefault: boolean;
  selectionMode: ProviderSelectionMode;
  executionPolicyNote: string;
  /**
   * Live health of the selected provider, attached ONLY when it is NOT healthy
   * (degraded/down) so callers can surface "this provider is failing" instead of the
   * user discovering it silently at call time (RC-3). Absent ⇒ healthy/unknown.
   */
  healthStatus?: ProviderHealthStatus;
  /** The provider's last recorded error, when unhealthy (for a user-facing hint). */
  healthError?: string;
}

export interface ProviderDescriptor {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities | null;
  readonly officialSnapshot: ProviderOfficialSnapshot | null;
}

export interface ProviderExecutionCandidate {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly contextWindow?: number;
  readonly thinkingSupported?: boolean;
  readonly specialFeatures?: string[];
  readonly officialSignals?: ProviderOfficialSnapshot["signals"];
  readonly officialSourceUrls?: string[];
  readonly catalogUpdatedAt?: number;
  readonly catalogFreshnessScore?: number;
  readonly catalogAgeMs?: number;
  readonly catalogStale?: boolean;
  readonly officialAlignmentScore?: number;
  readonly capabilityDriftReasons?: string[];
}

export interface ProviderCatalogHealth {
  readonly refreshIntervalMs: number;
  readonly stale: boolean;
  readonly snapshotAgeMs?: number;
}
