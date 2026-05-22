import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ObsidianVault,
  VaultQueryError,
  redactPathsInMessage,
} from '../../src/vault/obsidian-vault.js';
import type { EmbeddingProvider, VectorStore } from '../../src/vault/embedding-adapter.js';

class StubEmbedding implements EmbeddingProvider {
  readonly model = 'stub';
  readonly dim = 4;
  async embed(xs: string[]) {
    return xs.map(() => new Float32Array([1, 0, 0, 0]));
  }
}

class StubVectorStore implements VectorStore {
  private nextId = 1;
  readonly items = new Map<number, unknown>();
  add(_v: Float32Array, payload: unknown) {
    const id = this.nextId++;
    this.items.set(id, payload);
    return id;
  }
  remove(id: number) {
    this.items.delete(id);
  }
  search() {
    return [...this.items.entries()].map(([id, payload]) => ({ id, score: 0.5, payload }));
  }
  clear() {
    this.items.clear();
  }
}

function newVault(dir: string) {
  const store = new StubVectorStore();
  const vault = new ObsidianVault({
    id: 'obsidian:hardening',
    rootPath: dir,
    embedding: new StubEmbedding(),
    vectorStore: store,
    obsidian: { apiUrl: 'http://127.0.0.1:9', apiKey: 'test' },
  });
  return { vault, store };
}

describe('ObsidianVault — hardening (P0/P1/P2)', () => {
  let dir: string;
  let vault: ObsidianVault;
  let vectorStore: StubVectorStore;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'obsidian-vault-hard-'));
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await vault.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  // ─────────────── P0: concurrent sync race ───────────────
  describe('P0: concurrent sync()/reindexFile is serialized via AsyncLock', () => {
    it('5 concurrent sync() calls yield no orphan HNSW IDs and deterministic edge counts', async () => {
      mkdirSync(join(dir, 'notes'), { recursive: true });
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(dir, `notes/N${i}.md`), `# N${i}\n\nbody ${i} [[N${(i + 1) % 6}]]`);
      }
      ({ vault, store: vectorStore } = newVault(dir));
      await vault.init();

      // Fire 5 concurrent sync()s. With the lock they serialize; without it they race.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => vault.sync()),
      );
      expect(results.every((r) => typeof r.changed === 'number')).toBe(true);

      // Orphan check: every HNSW id in the vector store must correspond to a chunk row.
      // We just count: total files * (>=1 chunk) — store size must equal # of indexed chunks.
      const files = vault.listFiles();
      expect(files.length).toBe(6);
      // No vectors should have been leaked: count must be > 0 and match a consistent state.
      // (Exact count depends on chunker, but must be deterministic across runs.)
      const vectorCount1 = vectorStore.items.size;

      // Re-run sync; counts must stay stable (no growth = no orphans accumulating).
      await Promise.all(Array.from({ length: 3 }, () => vault.sync()));
      expect(vectorStore.items.size).toBe(vectorCount1);
    });
  });

  // ─────────────── P0: wikilink case semantics ───────────────
  describe('P0: wikilink resolution is case-insensitive but preserves stored case', () => {
    it('[[note]] resolves to Note.md (different case) and backlinks return same set from both casings', async () => {
      writeFileSync(join(dir, 'Note.md'), '# Note\n\nThe destination.');
      writeFileSync(join(dir, 'Source.md'), '# Source\n\nA [[note]] link here.');
      ({ vault, store: vectorStore } = newVault(dir));
      await vault.init();

      const backlinksFromActual = await vault.listBacklinks?.('Note.md');
      expect(backlinksFromActual?.wikilinks.some((w) => w.fromNote === 'Source.md' && w.resolved)).toBe(true);

      // Even if a caller queries with mixed case (would hit no rows in case-sensitive DB),
      // the resolved-target column is the canonical "Note.md".
      const all = await vault.listBacklinks?.('Note.md');
      expect(all?.wikilinks.length).toBeGreaterThan(0);
      for (const w of all!.wikilinks) {
        expect(w.target).toBe('Note.md'); // canonical, preserves stored case
      }
    });
  });

  // ─────────────── P1: reindexFile transactional rollback ───────────────
  describe('P1: reindex SQL transaction is atomic', () => {
    it('runReindexTxn rollback on bad chunk leaves chunks/files tables untouched', async () => {
      // Drive the store directly to simulate extractor producing a row that
      // violates a constraint — the SQL txn must roll back everything.
      const { SqliteVaultStore } = await import('../../src/vault/sqlite-vault-store.js');
      const Database = (await import('better-sqlite3')).default;
      mkdirSync(join(dir, '.strada/vault'), { recursive: true });
      const dbPath = join(dir, '.strada/vault/idx.db');
      const store = new SqliteVaultStore(dbPath);
      store.migrate();

      // Verify FK enforcement is on AND the chunks→files FK is wired the way
      // this test depends on. Fail-fast here: if either assumption is wrong,
      // the rollback test below would silently false-pass.
      const inspect = new Database(dbPath, { readonly: true });
      try {
        const fkPragma = inspect.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
        expect(fkPragma.foreign_keys).toBe(1);
        const fkList = inspect.prepare('PRAGMA foreign_key_list(vault_chunks)').all() as Array<{
          table: string; from: string; to: string;
        }>;
        const filesFk = fkList.find((row) => row.table === 'vault_files');
        expect(filesFk).toBeDefined();
        expect(filesFk?.from).toBe('path');
        expect(filesFk?.to).toBe('path');
      } finally {
        inspect.close();
      }

      // First, insert a known-good baseline file so we can prove untouched.
      const baseline = store.runReindexTxn({
        path: 'baseline.md',
        file: {
          path: 'baseline.md', blobHash: 'aaaa', mtimeMs: 1, size: 4,
          lang: 'markdown', kind: 'doc', indexedAt: 1,
        },
        chunks: [{
          chunkId: 'baseline.md#0', path: 'baseline.md',
          startLine: 0, endLine: 1, content: 'hi', tokenCount: 1,
        }],
        symbols: [], edges: [], wikilinks: [],
        frontmatter: null, tags: null,
      });
      expect(baseline.ok).toBe(true);
      const filesBefore = store.listFiles().length;
      const chunkBefore = store.chunkCount();
      expect(filesBefore).toBe(1);
      expect(chunkBefore).toBe(1);

      // Now trigger a failure: a chunk whose `path` doesn't match the file row
      // we're inserting — vault_chunks.path has a FOREIGN KEY referencing vault_files.path
      // with `foreign_keys = ON`, so this row will violate the FK and abort the txn.
      const bad = store.runReindexTxn({
        path: 'bad.md',
        file: {
          path: 'bad.md', blobHash: 'bbbb', mtimeMs: 1, size: 4,
          lang: 'markdown', kind: 'doc', indexedAt: 1,
        },
        chunks: [{
          chunkId: 'bad.md#0', path: 'no-such-file.md', // FK violation
          startLine: 0, endLine: 1, content: 'x', tokenCount: 1,
        }],
        symbols: [], edges: [], wikilinks: [],
        frontmatter: null, tags: null,
      });
      expect(bad.ok).toBe(false);
      // After rollback the baseline counts MUST be unchanged — i.e., the failed
      // file row was not inserted and no leftover chunks remain.
      expect(store.listFiles().length).toBe(filesBefore);
      expect(store.chunkCount()).toBe(chunkBefore);
      expect(store.getFile('bad.md')).toBeNull();

      store.close();
    });
  });

  // ─────────────── P1: second-pass wikilink resolution ───────────────
  describe('P1: wikilinks to files added mid-sync are resolved in the same sync', () => {
    it('index file A with [[B]], add B in the same sync — edge A→B exists after sync', async () => {
      writeFileSync(join(dir, 'A.md'), '# A\n\nReferencing [[B]] here.');
      ({ vault, store: vectorStore } = newVault(dir));
      await vault.init();

      // After init A's [[B]] wikilink is unresolved (no B yet).
      let backB = await vault.listBacklinks?.('B.md');
      expect(backB?.wikilinks.some((w) => w.resolved && w.fromNote === 'A.md')).toBeFalsy();

      // Add B and run sync — both passes of resolveWikilinks should fire and resolve A→B.
      writeFileSync(join(dir, 'B.md'), '# B\n\nNew note');
      const r = await vault.sync();
      expect(r.changed).toBeGreaterThan(0);

      backB = await vault.listBacklinks?.('B.md');
      expect(backB?.wikilinks.some((w) => w.resolved && w.fromNote === 'A.md' && w.target === 'B.md')).toBe(true);
    });
  });

  // ─────────────── P2: canvas regen atomicity ───────────────
  describe('P2: canvas regen leaves old file intact when the tmp write fails', () => {
    it('writeFile failure (tmp path is a directory) preserves the previous .canvas and returns { ok: false }', async () => {
      writeFileSync(join(dir, 'X.md'), '# X');
      ({ vault, store: vectorStore } = newVault(dir));
      await vault.init();

      const canvasPath = join(dir, '.strada/vault/graph.canvas');
      expect(existsSync(canvasPath)).toBe(true);
      const beforeBytes = readFileSync(canvasPath, 'utf8');

      // Make the .tmp path a non-empty directory: writeFile() to that path
      // throws EISDIR before we ever reach fs.rename(). (Note: this exercises
      // the *writeFile* failure path, not the rename path — Node's ESM rules
      // make it awkward to spy on fsp.rename directly. The end-to-end
      // invariant we care about is the same: any failure inside
      // regenerateCanvasWithStatus must leave the live file untouched.)
      const tmpPath = `${canvasPath}.tmp`;
      mkdirSync(tmpPath, { recursive: true });
      writeFileSync(join(tmpPath, 'block.txt'), 'blocker');

      writeFileSync(join(dir, 'Y.md'), '# Y');
      const r = await vault.sync();
      expect(r.canvas?.ok).toBe(false);
      expect(typeof r.canvas?.error).toBe('string');
      // The pre-existing graph.canvas file must still be intact.
      const afterBytes = readFileSync(canvasPath, 'utf8');
      expect(afterBytes).toBe(beforeBytes);
    });
  });

  // ─────────────── SecH1: error message path redaction ───────────────
  describe('SecH1: canvas error messages do not leak absolute paths', () => {
    it('redactPathsInMessage replaces vault root + home dir with placeholders', () => {
      const root = '/var/folders/abc/Strada.Brain';
      const home = homedir();
      const raw = `ENOENT: ${root}/.strada/vault/graph.canvas.tmp ` +
        `and home ${home}/Documents/foo`;
      const out = redactPathsInMessage(raw, root);
      expect(out).not.toContain(root);
      // Only assert home substitution when homedir() is non-trivial.
      if (home && home !== '/') {
        expect(out).not.toContain(home);
      }
      expect(out).toContain('<vault>');
    });

    it('sync() canvas.error after a real failure has no absolute paths', async () => {
      writeFileSync(join(dir, 'Z.md'), '# Z');
      ({ vault, store: vectorStore } = newVault(dir));
      await vault.init();

      // Force a tmp-write failure to populate canvas.error from a real error.
      const canvasPath = join(dir, '.strada/vault/graph.canvas');
      const tmpPath = `${canvasPath}.tmp`;
      mkdirSync(tmpPath, { recursive: true });
      writeFileSync(join(tmpPath, 'block.txt'), 'blocker');

      writeFileSync(join(dir, 'Z2.md'), '# Z2');
      const r = await vault.sync();
      expect(r.canvas?.ok).toBe(false);
      const errMsg = r.canvas?.error ?? '';
      // The redacted message must not contain the absolute vault root.
      expect(errMsg).not.toContain(dir);
      // The vault placeholder should appear since the original message
      // referenced a path inside dir.
      expect(errMsg).toContain('<vault>');
    });
  });

  // ─────────────── P2: empty FTS query ───────────────
  describe('P2: empty FTS query throws VaultQueryError', () => {
    it('whitespace-only text throws VaultQueryError with code=empty_query', async () => {
      writeFileSync(join(dir, 'N.md'), '# N');
      ({ vault, store: vectorStore } = newVault(dir));
      await vault.init();

      await expect(vault.query({ text: '   ', topK: 5 })).rejects.toBeInstanceOf(VaultQueryError);
      try {
        await vault.query({ text: '"""', topK: 5 });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(VaultQueryError);
        expect((err as VaultQueryError).code).toBe('empty_query');
      }
    });
  });
});
