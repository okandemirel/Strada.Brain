import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    appendToHeading: vi.fn().mockResolvedValue({ reindexed: true }),
    appendNote: vi.fn().mockResolvedValue({ reindexed: true }),
    writeNote: vi.fn().mockResolvedValue({ reindexed: true }),
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
 * Appends `content` at the end of the section a heading target names. Like the
 * plugin, the target is the heading's full path of texts (no `#`), so `Log`
 * names a top-level `## Log` and `Day::Log` a `## Log` under `# Day`.
 */
function appendUnderHeading(doc: string, target: string[], content: string): string | null {
  const lines = doc.split('\n');
  const stack: Array<{ level: number; text: string }> = [];
  let level = 0;
  let end = -1;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const lvl = m[1]!.length;
    if (found && lvl <= level) { end = i; break; }
    while (stack.length && stack[stack.length - 1]!.level >= lvl) stack.pop();
    stack.push({ level: lvl, text: m[2]! });
    if (!found && stack.length === target.length && stack.every((h, j) => h.text === target[j])) {
      found = true;
      level = lvl;
    }
  }
  if (!found) return null;
  if (end < 0) end = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  lines.splice(end, 0, ...content.replace(/\n$/, '').split('\n'));
  return lines.join('\n');
}

/**
 * The Local REST API's own contract for /vault/{path} (5.x): PUT replaces the
 * whole file; POST without a target appends to it, creating it when missing;
 * a Target-Type/Target header target is the deprecated 1.x format and is only
 * served with `Markdown-Patch-Version: 1` (400 HeaderTargetingRequiresVersion1
 * otherwise); PATCH (1.x) needs Operation, a missing note is 404 and a missing
 * heading 400 PatchFailed; a patch answers 200 with the patched note as text.
 * The path is split on its raw slashes and each segment decoded, so a segment
 * that decodes to a slash (Daily%2Fx.md) names no file: 404 for every verb.
 */
async function fakeLocalRestApi(root: string): Promise<{ apiUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const segments = (req.url ?? '').replace(/^\/vault\//, '').split('/').map(decodeURIComponent);
      const rel = segments.join('/');
      if (req.method === 'GET' && rel === '') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
        return;
      }
      const abs = join(root, rel);
      const headerTarget = req.headers['target-type'] !== undefined || req.headers['target'] !== undefined;
      const fail = (status: number, message: string) =>
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message }));
      if (segments.some((segment) => segment.includes('/'))) {
        fail(404, 'Not Found');
        return;
      }
      if ((req.method === 'POST' || req.method === 'PATCH') && headerTarget) {
        if (req.headers['markdown-patch-version'] !== '1') {
          fail(400, 'HeaderTargetingRequiresVersion1');
          return;
        }
        const operation = req.method === 'POST' ? 'append' : req.headers['operation'];
        if (operation !== 'append' || req.headers['target-type'] !== 'heading') {
          fail(400, 'unsupported by this fake');
          return;
        }
        if (!existsSync(abs)) {
          fail(404, 'Not Found');
          return;
        }
        const target = decodeURIComponent(String(req.headers['target'])).split('::');
        const patched = appendUnderHeading(readFileSync(abs, 'utf8'), target, body);
        if (patched === null) {
          fail(400, 'PatchFailed: invalid-target');
          return;
        }
        writeFileSync(abs, patched);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(patched);
        return;
      }
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

describe('obsidian_append against the Local REST API', () => {
  const tmp = createTempDirTracker('strada-obsidian-append-');
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
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
    return { root, vault, tool: new ObsidianAppendTool(registry) };
  }

  /** The index.db write fails after the note changed (SQLITE_FULL, a read-only volume, SQLITE_BUSY). */
  function failReindexes(vault: ObsidianVault): void {
    const store = (vault as unknown as { store: { runReindexTxn: (...a: unknown[]) => unknown } }).store;
    vi.spyOn(store, 'runReindexTxn').mockReturnValue({ ok: false, error: 'SQLITE_FULL: database or disk is full' });
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

  it('appends under the heading the input names, not at the end of the note', async () => {
    const { root, tool } = await setup();
    writeFileSync(join(root, 'today.md'), '## Log\n- wrote the GDD\n## Todo\n- ship it\n');

    // The schema's own example spells the heading with its #s.
    const result = await tool.execute(
      { path: 'today.md', heading: '## Log', content: '- fixed the spawner\n' },
      context(false),
    );

    expect(result.isError, String(result.content)).toBeFalsy();
    expect(result.content).toContain('under "## Log"');
    expect(readFileSync(join(root, 'today.md'), 'utf8')).toBe(
      '## Log\n- wrote the GDD\n- fixed the spawner\n## Todo\n- ship it\n',
    );
  });

  it('appends under the heading of a note below the vault root', async () => {
    const { root, tool } = await setup();
    mkdirSync(join(root, 'Daily'));
    writeFileSync(join(root, 'Daily', '2026-10-11.md'), '## Log\n- wrote the GDD\n## Todo\n- ship it\n');

    const result = await tool.execute(
      { path: 'Daily/2026-10-11.md', heading: '## Log', content: '- fixed the spawner\n' },
      context(false),
    );

    expect(result.isError, String(result.content)).toBeFalsy();
    expect(readFileSync(join(root, 'Daily', '2026-10-11.md'), 'utf8')).toBe(
      '## Log\n- wrote the GDD\n- fixed the spawner\n## Todo\n- ship it\n',
    );
  });

  it('reports a heading the note does not have as an error and leaves the note as it was', async () => {
    const { root, tool } = await setup();
    writeFileSync(join(root, 'today.md'), '## Todo\n- ship it\n');

    const result = await tool.execute(
      { path: 'today.md', heading: 'Log', content: '- fixed the spawner\n' },
      context(false),
    );

    expect(result.isError).toBe(true);
    expect(readFileSync(join(root, 'today.md'), 'utf8')).toBe('## Todo\n- ship it\n');
  });

  it.each([
    ['at the end of the note', undefined],
    ['under a heading', 'Log'],
  ])('reports an append %s that landed but was not reindexed as appended, not failed', async (_where, heading) => {
    const { root, vault, tool } = await setup();
    writeFileSync(join(root, 'today.md'), '## Log\n- wrote the GDD\n');
    failReindexes(vault);

    const result = await tool.execute(
      { path: 'today.md', ...(heading ? { heading } : {}), content: '- fixed the spawner\n' },
      context(false),
    );

    // The entry is in the note. An error here makes the agent append it again,
    // and a second append is a second entry.
    expect(readFileSync(join(root, 'today.md'), 'utf8')).toBe('## Log\n- wrote the GDD\n- fixed the spawner\n');
    expect(result.isError, String(result.content)).toBeFalsy();
    expect(result.content).toMatch(/^appended to today\.md/);
    expect(result.content).toMatch(/not reindexed: .*SQLITE_FULL/);
  });
});
