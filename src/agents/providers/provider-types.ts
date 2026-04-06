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
