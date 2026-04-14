import type { IVault, VaultId, VaultQuery, VaultQueryResult, VaultHit } from './vault.interface.js';

export class VaultRegistry {
  private vaults = new Map<VaultId, IVault>();

  register(v: IVault): void { this.vaults.set(v.id, v); }
  unregister(id: VaultId): void { this.vaults.delete(id); }
  get(id: VaultId): IVault | undefined { return this.vaults.get(id); }
  list(): IVault[] { return [...this.vaults.values()]; }

  async query(q: VaultQuery, vaultIds?: VaultId[]): Promise<VaultQueryResult> {
    const targets = vaultIds?.length
      ? vaultIds.map((id) => this.vaults.get(id)).filter((v): v is IVault => !!v)
      : [...this.vaults.values()];
    const results = await Promise.all(targets.map((v) => v.query(q)));
    const merged: VaultHit[] = [];
    for (const r of results) merged.push(...r.hits);
    merged.sort((a, b) => b.scores.rrf - a.scores.rrf);
    const capped = q.topK ? merged.slice(0, q.topK) : merged;
    return {
      hits: capped,
      budgetUsed: capped.reduce((a, h) => a + h.chunk.tokenCount, 0),
      truncated: capped.length < merged.length,
    };
  }

  async disposeAll(): Promise<void> {
    for (const v of this.vaults.values()) await v.dispose();
    this.vaults.clear();
  }
}
