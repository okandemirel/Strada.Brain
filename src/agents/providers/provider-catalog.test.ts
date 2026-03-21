import { describe, expect, it, vi } from "vitest";
import { ProviderCatalog } from "./provider-catalog.js";
import type { ProviderCatalogSource } from "./provider-catalog.js";

function createSource(overrides: Partial<ProviderCatalogSource> = {}): ProviderCatalogSource {
  return {
    describeAvailable: () => [],
    listExecutionCandidates: () => [],
    getActiveInfo: () => ({
      providerName: "alpha",
      model: "alpha-model",
      isDefault: false,
      selectionMode: "strada-preference-bias",
      executionPolicyNote: "Strada remains the control plane.",
    }),
    refreshModelCatalog: vi.fn().mockResolvedValue({
      modelsUpdated: 1,
      source: "litellm",
      errors: [],
    }),
    ...overrides,
  };
}

describe("ProviderCatalog", () => {
  it("marks an empty catalog as stale and degraded", () => {
    const catalog = new ProviderCatalog(createSource());

    const snapshot = catalog.snapshot("chat-1");

    expect(snapshot.stale).toBe(true);
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.health.stale).toBe(true);
    expect(snapshot.health.degraded).toBe(true);
  });

  it("surfaces routing metadata for stale providers", () => {
    const catalog = new ProviderCatalog(
      createSource({
        listExecutionCandidates: () => [
          {
            name: "alpha",
            label: "Alpha",
            defaultModel: "alpha-model",
            catalogUpdatedAt: Date.now() - 2 * 60 * 60 * 1000,
            catalogFreshnessScore: 0.32,
            catalogAgeMs: 2 * 60 * 60 * 1000,
            catalogStale: true,
            officialAlignmentScore: 0.24,
            capabilityDriftReasons: ["default-model-missing-from-official-catalog"],
          },
        ],
      }),
    );

    const decision = catalog.getRoutingMetadata("alpha", "alpha-model", "chat-1");

    expect(decision).toEqual(expect.objectContaining({
      provider: "alpha",
      model: "alpha-model",
      assignmentVersion: expect.any(Number),
      reason: "default-model-missing-from-official-catalog",
    }));
    expect(decision.catalog).toEqual(expect.objectContaining({
      stale: true,
      degraded: true,
      freshnessScore: 0.32,
      alignmentScore: 0.24,
    }));
  });

  it("increments assignment version after refresh", async () => {
    const source = createSource();
    const catalog = new ProviderCatalog(source);

    const before = catalog.snapshot("chat-1").assignmentVersion;
    await catalog.refresh();
    const after = catalog.snapshot("chat-1").assignmentVersion;

    expect(after).toBe(before + 1);
  });
});
