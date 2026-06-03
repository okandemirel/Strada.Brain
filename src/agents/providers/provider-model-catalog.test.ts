import { describe, expect, it, vi } from "vitest";
import { ProviderModelCatalog } from "./provider-model-catalog.js";
import type { LoadedProviders, CatalogPersist, Snapshot } from "./provider-model-catalog.js";

function makeLoaded(): LoadedProviders {
  return [
    { name: "openai", label: "OpenAI", defaultModel: "gpt-4o", models: ["gpt-4o", "gpt-4o-mini"] },
    { name: "claude", label: "Anthropic Claude", defaultModel: "claude-sonnet-4-6-20250514", models: ["claude-sonnet-4-6-20250514", "claude-opus-4-6"] },
  ];
}

describe("ProviderModelCatalog", () => {
  it("refresh() populates the cache and getProviderModels returns loaded models", async () => {
    const load = vi.fn<[], Promise<LoadedProviders>>().mockResolvedValue(makeLoaded());
    const catalog = new ProviderModelCatalog({ load, now: () => 1_000, ttlMs: 60_000 });

    const result = await catalog.refresh();

    expect(load).toHaveBeenCalledTimes(1);
    expect(catalog.getProviderModels("openai")).toEqual([{ id: "gpt-4o" }, { id: "gpt-4o-mini" }]);
    expect(catalog.getProviderModels("claude")).toEqual([
      { id: "claude-sonnet-4-6-20250514" },
      { id: "claude-opus-4-6" },
    ]);
    // unknown provider -> []
    expect(catalog.getProviderModels("nope")).toEqual([]);
    // refresh reports what it updated
    expect(result.modelsUpdated).toBe(4);
    expect(result.errors).toEqual([]);
  });

  it("isStale reflects the TTL window against the injected clock", async () => {
    let clock = 1_000;
    const load = vi.fn<[], Promise<LoadedProviders>>().mockResolvedValue(makeLoaded());
    const catalog = new ProviderModelCatalog({ load, now: () => clock, ttlMs: 60_000 });

    // Absent provider is stale before any refresh.
    expect(catalog.isStale("openai")).toBe(true);

    await catalog.refresh();
    // Just refreshed -> fresh.
    expect(catalog.isStale("openai")).toBe(false);

    // Advance within TTL -> still fresh.
    clock = 1_000 + 60_000;
    expect(catalog.isStale("openai")).toBe(false);

    // Advance past TTL -> stale.
    clock = 1_000 + 60_001;
    expect(catalog.isStale("openai")).toBe(true);

    // Unknown provider is always stale.
    expect(catalog.isStale("nope")).toBe(true);
  });

  it("refresh() captures a loader rejection in errors without throwing", async () => {
    const load = vi.fn<[], Promise<LoadedProviders>>().mockRejectedValue(new Error("boom"));
    const catalog = new ProviderModelCatalog({ load, now: () => 1_000, ttlMs: 60_000 });

    const result = await catalog.refresh();

    expect(result.modelsUpdated).toBe(0);
    expect(result.errors).toEqual(["boom"]);
    // Cache left untouched -> reads still empty.
    expect(catalog.getProviderModels("openai")).toEqual([]);
  });

  it("refresh() persists the current snapshot via persist.save()", async () => {
    const load = vi.fn<[], Promise<LoadedProviders>>().mockResolvedValue(makeLoaded());
    const persist: CatalogPersist = {
      load: vi.fn<[], Promise<Snapshot | null>>().mockResolvedValue(null),
      save: vi.fn<[Snapshot], Promise<void>>().mockResolvedValue(undefined),
    };
    const catalog = new ProviderModelCatalog({ load, now: () => 5_000, ttlMs: 60_000, persist });

    await catalog.refresh();

    expect(persist.save).toHaveBeenCalledTimes(1);
    const saved = (persist.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as Snapshot;
    expect(saved.providers["openai"]).toEqual({
      models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
      fetchedAt: 5_000,
    });
  });

  it("seeds the cache from persist.load() so reads are warm before any refresh", async () => {
    const load = vi.fn<[], Promise<LoadedProviders>>().mockResolvedValue(makeLoaded());
    const seeded: Snapshot = {
      providers: {
        openai: { models: [{ id: "gpt-seed" }], fetchedAt: 2_000 },
      },
    };
    const persist: CatalogPersist = {
      load: vi.fn<[], Promise<Snapshot | null>>().mockResolvedValue(seeded),
      save: vi.fn<[Snapshot], Promise<void>>().mockResolvedValue(undefined),
    };

    const catalog = await ProviderModelCatalog.create({
      load,
      now: () => 2_500,
      ttlMs: 60_000,
      persist,
    });

    // Warm read before any refresh().
    expect(load).not.toHaveBeenCalled();
    expect(catalog.getProviderModels("openai")).toEqual([{ id: "gpt-seed" }]);
    // Seeded entry honors its persisted fetchedAt for staleness.
    expect(catalog.isStale("openai")).toBe(false);
  });
});
