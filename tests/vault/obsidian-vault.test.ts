import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsidianVault } from '../../src/vault/obsidian-vault.js';
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
  private items = new Map<number, unknown>();
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

describe('ObsidianVault', () => {
  let dir: string;
  let vault: ObsidianVault;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'obsidian-vault-'));
    mkdirSync(join(dir, 'Folder'), { recursive: true });
    writeFileSync(join(dir, 'Folder/Sub.md'), '# Nested\n\nNestedNeedle');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    vault = new ObsidianVault({
      id: 'obsidian:test',
      rootPath: dir,
      embedding: new StubEmbedding(),
      vectorStore: new StubVectorStore(),
      obsidian: { apiUrl: 'http://127.0.0.1:9', apiKey: 'test' },
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await vault.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes nested note paths relative to the vault root', async () => {
    await vault.init();

    expect(vault.listFiles().map((f) => f.path)).toContain('Folder/Sub.md');
    const result = await vault.query({ text: 'NestedNeedle', topK: 5 });
    expect(result.hits.some((h) => h.chunk.path === 'Folder/Sub.md')).toBe(true);
  });

  it('does not index Obsidian metadata or secret-like JSON files', async () => {
    mkdirSync(join(dir, '.obsidian'), { recursive: true });
    writeFileSync(join(dir, '.obsidian/app.json'), '{"token":"hidden"}');
    writeFileSync(join(dir, 'Folder/credentials.json'), '{"token":"hidden"}');

    await vault.init();

    const paths = vault.listFiles().map((f) => f.path);
    expect(paths).not.toContain('.obsidian/app.json');
    expect(paths).not.toContain('Folder/credentials.json');
  });

  it('enforces the shared vault path policy for reads and writes', async () => {
    mkdirSync(join(dir, '.obsidian'), { recursive: true });
    writeFileSync(join(dir, '.obsidian/app.json'), '{"theme":"dark"}');
    writeFileSync(join(dir, 'Folder/credentials.json'), '{"token":"hidden"}');

    await expect(vault.readFile('/Folder/Sub.md')).rejects.toThrow(/path escapes vault root/i);
    await expect(vault.readFile('.obsidian/app.json')).rejects.toThrow(/not allowed/i);
    await expect(vault.readFile('Folder/credentials.json')).rejects.toThrow(/not allowed/i);
    await expect(vault.writeFile('/Folder/New.md', 'content')).rejects.toThrow(/path escapes vault root/i);
    await expect(vault.writeFile('Folder/credentials.json', '{}')).rejects.toThrow(/not allowed/i);
  });

  it('rejects symlink reads and fallback writes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'obsidian-outside-'));
    try {
      writeFileSync(join(outside, 'Leak.md'), 'leak');
      symlinkSync(join(outside, 'Leak.md'), join(dir, 'Folder/Leak.md'));

      await expect(vault.readFile('Folder/Leak.md')).rejects.toThrow(/symlink|vault root/i);
      await expect(vault.writeFile('Folder/Leak.md', 'changed')).rejects.toThrow(/symlink|vault root/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
