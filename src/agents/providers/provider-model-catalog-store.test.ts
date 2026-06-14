import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderModelCatalogStore } from "./provider-model-catalog-store.js";
import type { Snapshot } from "./provider-model-catalog.js";

describe("ProviderModelCatalogStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strada-catalog-store-"));
    filePath = join(dir, "provider-model-catalog.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a snapshot via save() then load()", async () => {
    const store = new ProviderModelCatalogStore(filePath);
    const snapshot: Snapshot = {
      providers: {
        openai: {
          models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
          fetchedAt: 1_700_000_000_000,
        },
        claude: {
          models: [{ id: "claude-sonnet" }],
          fetchedAt: 1_700_000_001_000,
        },
      },
    };

    await store.save(snapshot);
    const loaded = await store.load();

    expect(loaded).toEqual(snapshot);
  });

  it("creates the parent directory when saving to a missing dir", async () => {
    const nested = join(dir, "a", "b", "c", "provider-model-catalog.json");
    const store = new ProviderModelCatalogStore(nested);
    const snapshot: Snapshot = {
      providers: { gemini: { models: [{ id: "gemini-pro" }], fetchedAt: 1 } },
    };

    await store.save(snapshot);
    const loaded = await store.load();

    expect(loaded).toEqual(snapshot);
  });

  it("returns null when the file is missing (without throwing)", async () => {
    const store = new ProviderModelCatalogStore(join(dir, "does-not-exist.json"));
    await expect(store.load()).resolves.toBeNull();
  });

  it("returns null when the file is corrupt/unparseable (without throwing)", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, "{not json", "utf8");
    const store = new ProviderModelCatalogStore(filePath);
    await expect(store.load()).resolves.toBeNull();
  });
});
