import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVaultStore } from '../../src/vault/sqlite-vault-store.js';

describe('SqliteVaultStore — Phase 2 tables', () => {
  let dir: string;
  let store: SqliteVaultStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-phase2-'));
    store = new SqliteVaultStore(join(dir, 'db.sqlite'));
    store.migrate();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates vault_symbols, vault_edges, vault_wikilinks tables', () => {
    const names = store.listTableNamesForTest();
    expect(names).toContain('vault_symbols');
    expect(names).toContain('vault_edges');
    expect(names).toContain('vault_wikilinks');
  });

  it('records indexer_version in vault_meta', () => {
    expect(store.getMeta('indexer_version')).toBe('phase2.v1');
  });
});
