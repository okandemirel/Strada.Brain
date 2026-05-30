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

  it('upserts & lists symbols, cascades on file delete', () => {
    store.upsertFile({ path: 'a.cs', blobHash: 'h', mtimeMs: 1, size: 1, lang: 'csharp', kind: 'source', indexedAt: 1 });
    store.upsertSymbol({
      symbolId: 'csharp::a.cs::Foo', path: 'a.cs', kind: 'class', name: 'Foo',
      display: 'public class Foo', startLine: 1, endLine: 10, doc: null,
    });
    expect(store.listSymbolsForPath('a.cs')).toHaveLength(1);
    store.deleteFile('a.cs');
    expect(store.listSymbolsForPath('a.cs')).toHaveLength(0);
  });

  it('upserts & lists edges; findCallers returns incoming edges', () => {
    store.upsertFile({ path: 'a.cs', blobHash: 'h', mtimeMs: 1, size: 1, lang: 'csharp', kind: 'source', indexedAt: 1 });
    store.upsertSymbol({ symbolId: 'csharp::a.cs::Foo', path: 'a.cs', kind: 'class', name: 'Foo', display: 'Foo', startLine: 1, endLine: 1, doc: null });
    store.upsertSymbol({ symbolId: 'csharp::a.cs::Bar', path: 'a.cs', kind: 'method', name: 'Bar', display: 'Bar', startLine: 2, endLine: 2, doc: null });
    store.upsertEdge({ fromSymbol: 'csharp::a.cs::Bar', toSymbol: 'csharp::a.cs::Foo', kind: 'calls', atLine: 2 });
    expect(store.findCallersOf('csharp::a.cs::Foo')).toHaveLength(1);
  });

  it('listSymbolsForPath returns inserted rows; findSymbolsByName matches by short name', () => {
    store.upsertFile({ path: 'a.cs', blobHash: 'h', mtimeMs: 1, size: 1, lang: 'csharp', kind: 'source', indexedAt: 1 });
    store.upsertSymbol({ symbolId: 'csharp::a.cs::Move', path: 'a.cs', kind: 'method', name: 'Move', display: 'Move', startLine: 1, endLine: 1, doc: null });
    expect(store.findSymbolsByName('Move')).toHaveLength(1);
    expect(store.findSymbolsByName('Nope')).toHaveLength(0);
  });

  it('wikilinks upsert + resolve flag toggle', () => {
    store.upsertWikilink({ fromNote: 'n1.md', target: 'n2.md', resolved: false });
    expect(store.listWikilinksTo('n2.md')).toHaveLength(1);
    store.markWikilinkResolved('n1.md', 'n2.md');
    expect(store.listWikilinksTo('n2.md')[0]!.resolved).toBe(true);
  });

  it('updateWikilinkTarget changes target, marks resolved, and preserves the original token', () => {
    store.upsertWikilink({ fromNote: 'n1.md', target: 'n2', resolved: false });
    store.updateWikilinkTarget('n1.md', 'n2', 'folder/n2.md', 'n2');
    expect(store.listWikilinksTo('n2')).toHaveLength(0);
    const resolved = store.listWikilinksTo('folder/n2.md');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.target).toBe('folder/n2.md');
    expect(resolved[0]!.resolved).toBe(true);
    // The raw authored token is preserved so a later rename can re-resolve.
    expect(resolved[0]!.originalTarget).toBe('n2');
  });

  it('updateWikilinkTarget re-resolves to a new path while keeping the original token', () => {
    store.upsertWikilink({ fromNote: 'n1.md', target: 'n2', resolved: false });
    store.updateWikilinkTarget('n1.md', 'n2', 'folder/n2.md', 'n2');
    // Target renamed folder/n2.md -> archive/n2.md: re-resolve from the token 'n2'.
    store.updateWikilinkTarget('n1.md', 'folder/n2.md', 'archive/n2.md', 'n2');
    expect(store.listWikilinksTo('folder/n2.md')).toHaveLength(0);
    const reresolved = store.listWikilinksTo('archive/n2.md');
    expect(reresolved).toHaveLength(1);
    expect(reresolved[0]!.target).toBe('archive/n2.md');
    expect(reresolved[0]!.originalTarget).toBe('n2');
  });
});
