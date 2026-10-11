import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { ObsidianAppendTool } from './obsidian-append-tool.js';
import type { ToolContext } from './tool.interface.js';
import { VaultRegistry } from '../../vault/vault-registry.js';
import { ObsidianVault } from '../../vault/obsidian-vault.js';
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from '../../test-helpers.js';

function makeRegistry() {
  const vault = {
    id: 'obsidian:test',
    kind: 'obsidian',
    appendToHeading: vi.fn().mockResolvedValue(undefined),
    appendNote: vi.fn().mockResolvedValue(undefined),
    writeNote: vi.fn().mockResolvedValue(undefined),
  };
  const registry = {
    list: () => [vault],
    get: (id: string) => (id === vault.id ? vault : undefined),
  } as unknown as VaultRegistry;
  return { vault, registry };
}

function context(readOnly: boolean): ToolContext {
  return { projectPath: '/project', workingDirectory: '/project', readOnly } as ToolContext;
}

describe('ObsidianAppendTool', () => {
  it('appends under a heading when writes are allowed', async () => {
    const { vault, registry } = makeRegistry();
    const result = await new ObsidianAppendTool(registry).execute(
      { path: 'Daily/today.md', heading: '## Notes', content: 'x' },
      context(false),
    );
    expect(result.isError).toBeFalsy();
    expect(vault.appendToHeading).toHaveBeenCalledWith('Daily/today.md', '## Notes', 'x');
  });

  it('refuses to write in read-only mode', async () => {
    const { vault, registry } = makeRegistry();
    const tool = new ObsidianAppendTool(registry);

    const withHeading = await tool.execute(
      { path: 'Daily/today.md', heading: '## Notes', content: 'x' },
      context(true),
    );
    const withoutHeading = await tool.execute({ path: 'Daily/today.md', content: 'x' }, context(true));

    for (const result of [withHeading, withoutHeading]) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('read-only mode');
    }
    expect(vault.appendToHeading).not.toHaveBeenCalled();
    expect(vault.appendNote).not.toHaveBeenCalled();
    expect(vault.writeNote).not.toHaveBeenCalled();
  });
});

/**
 * The Local REST API's own contract for /vault/{path}: PUT replaces the whole
 * file, POST without a target appends to it, creating it when missing.
 */
async function fakeLocalRestApi(root: string): Promise<{ apiUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const rel = decodeURIComponent((req.url ?? '').replace(/^\/vault\//, ''));
      if (req.method === 'GET' && rel === '') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
        return;
      }
      const abs = join(root, rel);
      if (req.method === 'PUT' || req.method === 'POST') {
        mkdirSync(dirname(abs), { recursive: true });
        if (req.method === 'PUT') writeFileSync(abs, body);
        else appendFileSync(abs, body);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('obsidian_append without a heading, against the Local REST API', () => {
  const tmp = createTempDirTracker('strada-obsidian-append-');
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    tmp.cleanup();
  });

  async function setup() {
    const root = tmp.makeDir();
    const api = await fakeLocalRestApi(root);
    cleanups.push(api.close);
    const vault = new ObsidianVault({
      id: 'obsidian:test',
      rootPath: root,
      embedding: createFakeEmbedding(),
      vectorStore: createFakeVectorStore(),
      obsidian: { apiUrl: api.apiUrl, apiKey: 'k' },
    });
    cleanups.push(() => vault.dispose());
    await vault.init();
    const registry = new VaultRegistry();
    registry.register(vault);
    return { root, tool: new ObsidianAppendTool(registry) };
  }

  it("keeps the note's existing content and adds the new line after it", async () => {
    const { root, tool } = await setup();
    mkdirSync(join(root, 'Daily'));
    writeFileSync(join(root, 'Daily', '2026-10-11.md'), '# 2026-10-11\n- wrote the GDD\n');

    const result = await tool.execute(
      { path: 'Daily/2026-10-11.md', content: '- fixed the spawner\n' },
      context(false),
    );

    expect(result.isError, String(result.content)).toBeFalsy();
    expect(readFileSync(join(root, 'Daily', '2026-10-11.md'), 'utf8')).toBe(
      '# 2026-10-11\n- wrote the GDD\n- fixed the spawner\n',
    );
  });

  it('creates the note when it does not exist yet', async () => {
    const { root, tool } = await setup();

    const result = await tool.execute({ path: 'Inbox/new.md', content: '- first line\n' }, context(false));

    expect(result.isError, String(result.content)).toBeFalsy();
    expect(readFileSync(join(root, 'Inbox', 'new.md'), 'utf8')).toBe('- first line\n');
  });
});
