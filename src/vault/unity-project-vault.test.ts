import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnityProjectVault } from './unity-project-vault.js';
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from '../test-helpers.js';
import type { EmbeddingProvider, VectorStore } from './embedding-adapter.js';
import type { IVault } from './vault.interface.js';

vi.mock('../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** In-memory VectorStore that records live ids so we can assert vector lifecycle. */
class FakeVectorStore implements VectorStore {
  private next = 0;
  readonly live = new Map<number, { vector: Float32Array; payload: unknown }>();
  add(vector: Float32Array, payload: unknown): number {
    const id = this.next++;
    this.live.set(id, { vector, payload });
    return id;
  }
  remove(id: number): void { this.live.delete(id); }
  search(): Array<{ id: number; score: number; payload?: unknown }> { return []; }
  clear(): void { this.live.clear(); }
}

class FakeEmbedding implements EmbeddingProvider {
  readonly model = "fake";
  readonly dim = 3;
  shouldFail = false;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.shouldFail) throw new Error("transient embed failure");
    return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
  }
}

describe('UnityProjectVault', () => {
  const tmp = createTempDirTracker('strada-unity-vault-');
  const vaults: IVault[] = [];

  function makeVault(root: string, embedding: EmbeddingProvider = createFakeEmbedding()): UnityProjectVault {
    const vault = new UnityProjectVault({
      id: 'test-unity',
      rootPath: root,
      embedding,
      vectorStore: createFakeVectorStore(),
    });
    vaults.push(vault);
    return vault;
  }

  afterEach(async () => {
    // Dispose BEFORE cleanup: better-sqlite3 keeps the db file open.
    for (const v of vaults.splice(0)) await v.dispose();
    tmp.cleanup();
  });

  it('indexes markdown files on init', async () => {
    const root = tmp.makeDir();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note\n\nbody text');
    const vault = makeVault(root);

    await vault.init();

    const files = vault.listFiles();
    expect(files.map((f) => f.path)).toContain('notes/a.md');
    expect(files.find((f) => f.path === 'notes/a.md')?.blobHash).not.toBe('');
    expect((await vault.stats()).fileCount).toBe(1);
  });

  it('short-circuits reindexFile on unchanged content hash (Fix C1)', async () => {
    const root = tmp.makeDir();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const vault = makeVault(root);
    await vault.init();

    expect(await vault.reindexFile('notes/a.md')).toBe(false);

    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note CHANGED');
    expect(await vault.reindexFile('notes/a.md')).toBe(true);

    const { changed } = await vault.sync();
    expect(changed).toBe(0);
  });

  it('confines reads to the vault root via the public API', async () => {
    const root = tmp.makeDir();
    const outside = tmp.makeDir('strada-unity-outside-');
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const outsideFile = join(outside, 'outside.md');
    writeFileSync(outsideFile, '# outside');
    symlinkSync(outsideFile, join(root, 'link.md'));
    const vault = makeVault(root);
    await vault.init();

    await expect(vault.readFile('../outside.md')).rejects.toThrow(/escapes vault root/);
    await expect(vault.readFile('/etc/hosts')).rejects.toThrow(/escapes vault root/);
    await expect(vault.readFile('link.md')).rejects.toThrow(/uses a symlink/);
    expect(await vault.readFile('notes/a.md')).toBe('# alpha note');
  });

  it('confines writes to the vault root', async () => {
    const root = tmp.makeDir();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const vault = makeVault(root);
    await vault.init();

    await vault.writeFile('notes/new.md', '# hi');
    expect(readFileSync(join(root, 'notes', 'new.md'), 'utf8')).toBe('# hi');

    await expect(vault.writeFile('../evil.md', 'x')).rejects.toThrow(/escapes vault root/);
    await expect(vault.writeFile('secrets.json', '{}')).rejects.toThrow(/not allowed/);
    expect(existsSync(join(root, '..', 'evil.md'))).toBe(false);
  });

  it('prunes deleted files on sync', async () => {
    const root = tmp.makeDir();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha');
    writeFileSync(join(root, 'notes', 'b.md'), '# beta');
    const vault = makeVault(root);
    await vault.init();
    expect(vault.listFiles()).toHaveLength(2);

    rmSync(join(root, 'notes', 'b.md'));
    const { changed } = await vault.sync();

    expect(changed).toBe(1);
    expect(vault.listFiles().map((f) => f.path)).not.toContain('notes/b.md');
  });

  it('keeps FTS indexing when the embedding provider fails (best-effort)', async () => {
    const root = tmp.makeDir();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const vault = makeVault(root, createFakeEmbedding({
      embed: async () => { throw new Error('provider down'); },
    }));

    await expect(vault.init()).resolves.toBeUndefined();
    expect(vault.listFiles().map((f) => f.path)).toContain('notes/a.md');
  });
});

describe("UnityProjectVault reindex vector lifecycle", () => {
  let dir: string;
  let store: FakeVectorStore;
  let embed: FakeEmbedding;
  let vault: UnityProjectVault;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strada-vault-test-"));
    store = new FakeVectorStore();
    embed = new FakeEmbedding();
    await writeFile(join(dir, "note.md"), "# Note\nfirst version of the note body\n", "utf8");
    vault = new UnityProjectVault({ id: "test", rootPath: dir, embedding: embed, vectorStore: store });
    await vault.init();
  });

  afterEach(async () => {
    await vault.dispose().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("throws VaultQueryError on a query that is empty after sanitization (parity with ObsidianVault)", async () => {
    await expect(vault.query({ text: "   " })).rejects.toMatchObject({
      name: "VaultQueryError",
      code: "empty_query",
    });
    // Operator/keyword-only queries also sanitize to empty.
    await expect(vault.query({ text: "AND OR NOT" })).rejects.toMatchObject({
      code: "empty_query",
    });
  });

  it("resolves a normal query without throwing", async () => {
    const result = await vault.query({ text: "note" });
    expect(Array.isArray(result.hits)).toBe(true);
  });

  it("keeps prior vectors when re-embedding fails transiently, then rebuilds on retry", async () => {
    // Initial index embedded the note → at least one live vector exists.
    const initialIds = [...store.live.keys()];
    expect(initialIds.length).toBeGreaterThan(0);

    // Change the file, then make embedding fail on the next reindex.
    await writeFile(join(dir, "note.md"), "# Note\na completely different second body\n", "utf8");
    embed.shouldFail = true;
    await vault.reindexFile("note.md");

    // Core guarantee (finding #3): a transient embed failure must NOT remove the
    // old vectors. The old ids are still live because the new embed threw before
    // any new vector was added and the old-removal only runs on success.
    for (const id of initialIds) {
      expect(store.live.has(id)).toBe(true);
    }

    // Recovery: embedding works again. Because the failed pass reset the stored
    // hash, this reindex must NOT short-circuit — it re-embeds (new id) and only
    // then removes the old vectors.
    embed.shouldFail = false;
    await vault.reindexFile("note.md");

    const finalIds = [...store.live.keys()];
    // The file is vector-searchable again: a fresh vector (id greater than any
    // initial id) was created on retry, proving the reset hash forced a
    // re-embed instead of short-circuiting — i.e. no permanent vector loss.
    expect(finalIds.some((id) => id > Math.max(...initialIds))).toBe(true);
  });
});
