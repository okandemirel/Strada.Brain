/**
 * Provider Model Catalog Store
 *
 * On-disk persistence for the `ProviderModelCatalog` `Snapshot`. Satisfies the
 * Phase-1 `CatalogPersist` interface by reading/writing a single JSON file in
 * the strada data dir.
 *
 * Writes are atomic (write to `<file>.tmp`, then `rename` over the target) so a
 * crash mid-write can never leave a half-written/corrupt catalog. Reads never
 * throw: a missing or unparseable file yields `null`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CatalogPersist, Snapshot } from "./provider-model-catalog.js";

/** Default on-disk filename for the persisted catalog snapshot. */
export const PROVIDER_MODEL_CATALOG_FILENAME = "provider-model-catalog.json";

export class ProviderModelCatalogStore implements CatalogPersist {
  constructor(private readonly filePath: string) {}

  /**
   * Atomically persist the snapshot: create the parent dir if missing, write to
   * a temp sibling, then rename over the target (rename is atomic on a single
   * filesystem, so readers never observe a partial write).
   */
  async save(snapshot: Snapshot): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }

  /**
   * Load the persisted snapshot. Returns `null` if the file is missing or
   * cannot be parsed. Never throws.
   */
  async load(): Promise<Snapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // Missing file (ENOENT) or any read error → no persisted snapshot.
      return null;
    }
    try {
      return JSON.parse(raw) as Snapshot;
    } catch {
      // Corrupt/unparseable file → treat as no persisted snapshot.
      return null;
    }
  }
}

/**
 * Resolve the default catalog file path inside the strada data dir, mirroring
 * the convention used by `ProviderManager`/`ProviderPreferenceStore`
 * (`<dbPath>/<file>`, where `dbPath` falls back to `MEMORY_DB_PATH` then
 * `<cwd>/.strada-memory`).
 */
export function resolveProviderModelCatalogPath(dbPath?: string): string {
  const base = dbPath ?? process.env["MEMORY_DB_PATH"] ?? join(process.cwd(), ".strada-memory");
  return join(base, PROVIDER_MODEL_CATALOG_FILENAME);
}

/** Construct a store at the default strada data-dir path. */
export function createProviderModelCatalogStore(dbPath?: string): ProviderModelCatalogStore {
  return new ProviderModelCatalogStore(resolveProviderModelCatalogPath(dbPath));
}
