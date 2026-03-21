import type {
  ProviderActiveInfo,
  ProviderDescriptor,
  ProviderExecutionCandidate,
} from "./provider-manager.js";
import type { RefreshResult } from "./model-intelligence.js";
import type { ProviderRoutingDecision } from "../../agent-core/routing/routing-types.js";

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0.5;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pickLatestTimestamp(entries: readonly ProviderCatalogEntry[]): number | undefined {
  let latest = 0;
  for (const entry of entries) {
    if (typeof entry.catalogUpdatedAt === "number" && entry.catalogUpdatedAt > latest) {
      latest = entry.catalogUpdatedAt;
    }
  }
  return latest > 0 ? latest : undefined;
}

export interface ProviderCatalogSource {
  describeAvailable(): ProviderDescriptor[];
  listExecutionCandidates?(identityKey?: string): ProviderExecutionCandidate[];
  getActiveInfo?(chatId: string): ProviderActiveInfo;
  refreshModelCatalog?(): Promise<RefreshResult | null>;
}

export interface ProviderCatalogEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly model: string;
  readonly active: boolean;
  readonly catalogUpdatedAt?: number;
  readonly catalogFreshnessScore?: number;
  readonly catalogAgeMs?: number;
  readonly catalogStale?: boolean;
  readonly officialAlignmentScore?: number;
  readonly capabilityDriftReasons?: readonly string[];
}

export interface ProviderCatalogSnapshot {
  readonly generatedAt: number;
  readonly assignmentVersion: number;
  readonly stale: boolean;
  readonly degraded: boolean;
  readonly health: {
    readonly stale: boolean;
    readonly degraded: boolean;
    readonly freshnessScore: number;
    readonly alignmentScore: number;
    readonly updatedAt?: number;
  };
  readonly activeProvider?: string;
  readonly activeModel?: string;
  readonly providers: readonly ProviderCatalogEntry[];
}

export class ProviderCatalog {
  private revision = 1;

  constructor(private readonly source: ProviderCatalogSource) {}

  async refresh(): Promise<RefreshResult | null> {
    const result = await this.source.refreshModelCatalog?.();
    if (result) {
      this.revision += 1;
    }
    return result ?? null;
  }

  snapshot(identityKey?: string): ProviderCatalogSnapshot {
    const candidates = this.source.listExecutionCandidates?.(identityKey);
    const activeInfo = identityKey ? this.source.getActiveInfo?.(identityKey) : undefined;
    const providers = candidates
      ? candidates.map((entry) => this.toCatalogEntry(entry, activeInfo))
      : this.source.describeAvailable().map((entry) => this.toDescriptorCatalogEntry(entry, activeInfo));

    const freshnessScores = providers
      .map((entry) => entry.catalogFreshnessScore)
      .filter((score): score is number => typeof score === "number");
    const alignmentScores = providers
      .map((entry) => entry.officialAlignmentScore)
      .filter((score): score is number => typeof score === "number");
    const stale = providers.length === 0 || providers.some((entry) => entry.catalogStale === true);
    const degraded =
      providers.length === 0 ||
      stale ||
      (freshnessScores.length === 0 && alignmentScores.length === 0) ||
      average(freshnessScores) < 0.45 ||
      average(alignmentScores) < 0.45;
    const latest = pickLatestTimestamp(providers);

    return {
      generatedAt: Date.now(),
      assignmentVersion: this.revision,
      stale,
      degraded,
      health: {
        stale,
        degraded,
        freshnessScore: freshnessScores.length > 0 ? average(freshnessScores) : (stale ? 0.35 : 0.5),
        alignmentScore: alignmentScores.length > 0 ? average(alignmentScores) : 0.5,
        updatedAt: latest,
      },
      activeProvider: activeInfo?.providerName,
      activeModel: activeInfo?.model,
      providers,
    };
  }

  getRoutingMetadata(
    providerName: string,
    model?: string,
    identityKey?: string,
  ): ProviderRoutingDecision {
    const snapshot = this.snapshot(identityKey);
    const normalizedProvider = normalizeName(providerName);
    const provider = snapshot.providers.find((entry) => normalizeName(entry.name) === normalizedProvider);
    const resolvedModel = model ?? provider?.model ?? provider?.defaultModel ?? "";
    const stale = provider?.catalogStale ?? snapshot.stale;
    const degraded = snapshot.degraded;
    const freshnessScore = provider?.catalogFreshnessScore ?? snapshot.health.freshnessScore;
    const alignmentScore = provider?.officialAlignmentScore ?? snapshot.health.alignmentScore;
    const updatedAt = provider?.catalogUpdatedAt ?? snapshot.health.updatedAt;
    const driftReason = provider?.capabilityDriftReasons?.length
      ? provider.capabilityDriftReasons.join(", ")
      : stale
        ? "catalog-stale"
        : degraded
          ? "catalog-degraded"
          : "catalog-fresh";

    return {
      provider: normalizedProvider,
      model: resolvedModel,
      reason: driftReason,
      timestamp: snapshot.generatedAt,
      assignmentVersion: snapshot.assignmentVersion,
      catalog: {
        stale,
        degraded,
        freshnessScore,
        alignmentScore,
        updatedAt,
      },
    };
  }

  private toCatalogEntry(
    entry: ProviderExecutionCandidate,
    activeInfo?: ProviderActiveInfo,
  ): ProviderCatalogEntry {
    const active = Boolean(activeInfo && normalizeName(activeInfo.providerName) === normalizeName(entry.name));
    return {
      name: entry.name,
      label: entry.label,
      defaultModel: entry.defaultModel,
      model: activeInfo && active ? activeInfo.model : entry.defaultModel,
      active,
      catalogUpdatedAt: entry.catalogUpdatedAt,
      catalogFreshnessScore: entry.catalogFreshnessScore,
      catalogAgeMs: entry.catalogAgeMs,
      catalogStale: entry.catalogStale,
      officialAlignmentScore: entry.officialAlignmentScore,
      capabilityDriftReasons: entry.capabilityDriftReasons ?? [],
    };
  }

  private toDescriptorCatalogEntry(
    entry: ProviderDescriptor,
    activeInfo?: ProviderActiveInfo,
  ): ProviderCatalogEntry {
    const active = Boolean(activeInfo && normalizeName(activeInfo.providerName) === normalizeName(entry.name));
    return {
      name: entry.name,
      label: entry.label,
      defaultModel: entry.defaultModel,
      model: activeInfo && active ? activeInfo.model : entry.defaultModel,
      active,
      catalogStale: Boolean(!entry.officialSnapshot),
      catalogFreshnessScore: entry.officialSnapshot ? 0.5 : undefined,
      catalogUpdatedAt: entry.officialSnapshot?.lastUpdated,
      catalogAgeMs: entry.officialSnapshot ? Math.max(0, Date.now() - entry.officialSnapshot.lastUpdated) : undefined,
      officialAlignmentScore: entry.officialSnapshot ? 0.5 : undefined,
      capabilityDriftReasons: [],
    };
  }
}
