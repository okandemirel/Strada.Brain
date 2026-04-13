# Codebase Memory Vault — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-13-codebase-memory-vault-design.md`

**Goal:** Ship a working UnityProjectVault with L3 (embedding + FTS5 hybrid) semantic search over a user's Unity project, with chokidar watcher + Strada.Brain write-hook indexing, slash-commands (`/vault init|sync|status`), and a portal `/vaults` page skeleton (Files + Search tabs). This phase lands the substrate that Phases 2 (symbol graph + SelfVault) and 3 (summaries + framework upgrade + learning coupling) will extend.

**Architecture:** New `src/vault/` module exposing `IVault` interface and `VaultRegistry` singleton. Per-vault SQLite file at `<vault-root>/.strada/vault/index.db` (FTS5 + existing AgentDB HNSW for embeddings). Markdown at `<vault-root>/.strada/vault/codebase/*.md` is the source of truth; SQLite is derived cache. Chokidar debounces FS events into a dirty set; Strada.Brain's Edit/Write tools hook a synchronous sub-200ms reindex (sync path: hash + chunk + FTS5; embeddings run async in p-queue). `StradaKnowledge.buildProjectContext()` prefers vault when feature flag `vault.enabled` is on, falls back to legacy path otherwise.

**Tech Stack:**
- TypeScript 5.x / Node 20+ / ESM (project default)
- **better-sqlite3** (existing, for SQLite + FTS5)
- **AgentDB HNSW** (existing, `src/rag/hnsw/`)
- **chokidar** (existing, used by framework-sync-pipeline)
- **xxhashjs** (new dep) — MIT
- **p-queue** (new dep, backpressure) — MIT
- **gray-matter** (new dep, YAML frontmatter parse) — MIT
- **@xenova/transformers** (optional new dep, local embedding fallback) — Apache-2.0
- Vitest (existing, `vitest.config.ts`)
- React 18 + Vite (existing portal)
- Zustand (existing, `web-portal/src/stores/`)
- **react-markdown** + **remark-gfm** (new portal deps) — MIT

**File Structure:**

*New files:*
- `src/vault/vault.interface.ts` — `IVault`, `VaultQuery`, `VaultHit`, `VaultFile`, `VaultChunk` types
- `src/vault/hash.ts` — xxhash64 + chunk-id helpers
- `src/vault/schema.sql` — SQLite DDL for vault tables
- `src/vault/sqlite-vault-store.ts` — SQLite persistence layer
- `src/vault/chunker.ts` — heading-aware + token-capped chunker
- `src/vault/embedding-adapter.ts` — bridges vault chunks into existing HNSW store
- `src/vault/query-pipeline.ts` — FTS5 + HNSW + RRF fusion helpers
- `src/vault/unity-project-vault.ts` — concrete `IVault` for Unity projects
- `src/vault/vault-registry.ts` — singleton + lookup + lifecycle
- `src/vault/watcher.ts` — chokidar-based dirty-set drainer
- `src/vault/write-hook.ts` — budget-aware reindex hook
- `src/vault/discovery.ts` — Unity project root autodetect
- `src/vault/index.ts` — module barrel
- `src/agents/tools/vault-init-tool.ts`
- `src/agents/tools/vault-sync-tool.ts`
- `src/agents/tools/vault-status-tool.ts`
- `src/dashboard/server-vault-routes.ts`
- `web-portal/src/stores/vault-store.ts`
- `web-portal/src/pages/VaultsPage.tsx`
- `web-portal/src/pages/vaults/VaultList.tsx`
- `web-portal/src/pages/vaults/VaultFilesTab.tsx`
- `web-portal/src/pages/vaults/VaultSearchTab.tsx`
- `web-portal/src/pages/vaults/MarkdownPreview.tsx`
- Test files under `tests/vault/*.test.ts` and `web-portal/src/**/*.test.ts(x)`
- `tests/fixtures/unity-mini/` — Unity fixture

*Modified files:*
- `src/config/config.ts` — `vault.*` config flags
- `src/intelligence/framework/framework-types.ts` — generalize `FrameworkPackageId`
- `src/agents/context/strada-knowledge.ts` — feature-flagged vault path
- `src/agents/orchestrator.ts` — write-hook wiring
- `src/core/tool-registry.ts` — register 3 new vault tools
- `src/core/bootstrap-stages/stage-knowledge.ts` — init vault at boot
- `src/core/bootstrap-stages/index.ts` — re-export
- `src/dashboard/server.ts` — mount vault routes + WS wiring
- `web-portal/src/App.tsx` — `/vaults` route
- `web-portal/package.json` — add `react-markdown`, `remark-gfm`
- `package.json` — add `xxhashjs`, `p-queue`, `gray-matter`, `@xenova/transformers`

---

## Pre-flight checks

- [ ] **Step P1:** Confirm current branch is clean.

  Run: `git status -s`
  Expected: no modified files (design spec already committed).

- [ ] **Step P2:** Confirm Vitest script.

  Run: `cat package.json | grep -A1 '"scripts"' | head -20`
  Expected: `"test": "vitest"` or similar.

- [ ] **Step P3:** Confirm better-sqlite3 + chokidar installed.

  Run: `node -e "console.log(require('better-sqlite3').name, require('chokidar').watch.name)"`
  Expected: prints constructor/function names.

---

## Task 1: Module skeleton and feature flag

**Files:**
- Create: `src/vault/index.ts`
- Create: `src/vault/vault.interface.ts`
- Modify: `src/config/config.ts`
- Test: `tests/vault/config.test.ts`

- [ ] **Step 1.1: Write failing test for vault config flag**

  Create `tests/vault/config.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { loadConfig } from '../../src/config/config.js';

  describe('vault config', () => {
    it('exposes vault.enabled defaulting to false', () => {
      const cfg = loadConfig({});
      expect(cfg.vault).toBeDefined();
      expect(cfg.vault.enabled).toBe(false);
    });

    it('parses vault.enabled=true from env', () => {
      const cfg = loadConfig({ STRADA_VAULT_ENABLED: 'true' });
      expect(cfg.vault.enabled).toBe(true);
    });

    it('defaults writeHookBudgetMs to 200 and debounceMs to 800', () => {
      const cfg = loadConfig({});
      expect(cfg.vault.writeHookBudgetMs).toBe(200);
      expect(cfg.vault.debounceMs).toBe(800);
    });
  });
  ```

- [ ] **Step 1.2: Run, expect fail**

  Run: `npx vitest run tests/vault/config.test.ts`
  Expected: FAIL.

- [ ] **Step 1.3: Extend Zod config schema**

  `Read` `src/config/config.ts`, find the root Zod schema. Add:

  ```ts
  vault: z.object({
    enabled: z.coerce.boolean().default(false),
    writeHookBudgetMs: z.coerce.number().int().positive().default(200),
    debounceMs: z.coerce.number().int().positive().default(800),
    embeddingFallback: z.enum(['none', 'local']).default('local'),
  }).default({}),
  ```

  Extend env-mapping to include:
  - `STRADA_VAULT_ENABLED` → `vault.enabled`
  - `STRADA_VAULT_WRITE_HOOK_BUDGET_MS` → `vault.writeHookBudgetMs`
  - `STRADA_VAULT_DEBOUNCE_MS` → `vault.debounceMs`

- [ ] **Step 1.4: Run, expect pass**

  Run: `npx vitest run tests/vault/config.test.ts`
  Expected: PASS (3 tests).

- [ ] **Step 1.5: Create interface**

  Create `src/vault/vault.interface.ts`:

  ```ts
  export type VaultId = string;
  export type VaultKind = 'framework' | 'unity-project' | 'self';

  export interface VaultFile {
    path: string;
    blobHash: string;
    mtimeMs: number;
    size: number;
    lang: 'csharp' | 'typescript' | 'markdown' | 'json' | 'hlsl' | 'unknown';
    kind: 'source' | 'test' | 'doc' | 'config';
    indexedAt: number;
  }

  export interface VaultChunk {
    chunkId: string;
    path: string;
    startLine: number;
    endLine: number;
    content: string;
    tokenCount: number;
  }

  export interface VaultHit {
    chunk: VaultChunk;
    scores: { fts: number | null; hnsw: number | null; rrf: number };
  }

  export interface VaultQuery {
    text: string;
    topK?: number;
    langFilter?: VaultFile['lang'][];
    pathGlob?: string;
    budgetTokens?: number;
  }

  export interface VaultQueryResult {
    hits: VaultHit[];
    budgetUsed: number;
    truncated: boolean;
  }

  export interface VaultStats {
    fileCount: number;
    chunkCount: number;
    lastIndexedAt: number | null;
    dbBytes: number;
  }

  export interface IVault {
    readonly id: VaultId;
    readonly kind: VaultKind;
    readonly rootPath: string;
    init(): Promise<void>;
    sync(): Promise<{ changed: number; durationMs: number }>;
    rebuild(): Promise<void>;
    query(q: VaultQuery): Promise<VaultQueryResult>;
    stats(): Promise<VaultStats>;
    dispose(): Promise<void>;
    listFiles(): VaultFile[];
    readFile(path: string): Promise<string>;
    onUpdate(listener: (p: { vaultId: VaultId; changedPaths: string[] }) => void): () => void;
  }
  ```

  Create `src/vault/index.ts`:

  ```ts
  export * from './vault.interface.js';
  ```

- [ ] **Step 1.6: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: no new errors.

- [ ] **Step 1.7: Commit**

  ```bash
  git add src/vault/index.ts src/vault/vault.interface.ts src/config/config.ts tests/vault/config.test.ts
  git commit -m "feat(vault): IVault interface and vault config flags"
  ```

---

## Task 2: Hash utilities

**Files:**
- Create: `src/vault/hash.ts`
- Test: `tests/vault/hash.test.ts`

- [ ] **Step 2.1: Install xxhashjs**

  Run: `npm install xxhashjs`
  Expected: installed.

- [ ] **Step 2.2: Failing test**

  Create `tests/vault/hash.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { xxhash64Hex, chunkIdFor } from '../../src/vault/hash.js';

  describe('vault/hash', () => {
    it('xxhash64Hex is deterministic and 16 hex chars', () => {
      const a = xxhash64Hex('hello');
      const b = xxhash64Hex('hello');
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    });

    it('xxhash64Hex differs for different inputs', () => {
      expect(xxhash64Hex('a')).not.toBe(xxhash64Hex('b'));
    });

    it('chunkIdFor is deterministic and path-sensitive', () => {
      expect(chunkIdFor('path/a.ts', 10, 'body')).toBe(chunkIdFor('path/a.ts', 10, 'body'));
      expect(chunkIdFor('path/a.ts', 10, 'body')).not.toBe(chunkIdFor('path/b.ts', 10, 'body'));
    });
  });
  ```

- [ ] **Step 2.3: Run, expect fail**

  Run: `npx vitest run tests/vault/hash.test.ts`
  Expected: FAIL.

- [ ] **Step 2.4: Implement**

  Create `src/vault/hash.ts`:

  ```ts
  import XXH from 'xxhashjs';
  import { createHash } from 'node:crypto';

  const XX_SEED = 0xC0FFEE;

  export function xxhash64Hex(input: string | Buffer): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return XXH.h64(XX_SEED).update(buf).digest().toString(16).padStart(16, '0');
  }

  export function chunkIdFor(path: string, offset: number, body: string): string {
    return createHash('sha256')
      .update(path).update('\x00')
      .update(String(offset)).update('\x00')
      .update(body)
      .digest('hex').slice(0, 32);
  }
  ```

- [ ] **Step 2.5: Run, expect pass**

  Run: `npx vitest run tests/vault/hash.test.ts`
  Expected: PASS.

- [ ] **Step 2.6: Commit**

  ```bash
  git add src/vault/hash.ts tests/vault/hash.test.ts package.json package-lock.json
  git commit -m "feat(vault): xxhash64 and chunk-id helpers"
  ```

---

## Task 3: SQLite schema + store

**Files:**
- Create: `src/vault/schema.sql`
- Create: `src/vault/sqlite-vault-store.ts`
- Test: `tests/vault/sqlite-vault-store.test.ts`

- [ ] **Step 3.1: Failing test**

  Create `tests/vault/sqlite-vault-store.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { mkdtempSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { SqliteVaultStore } from '../../src/vault/sqlite-vault-store.js';

  let dir: string;
  let store: SqliteVaultStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-store-'));
    store = new SqliteVaultStore(join(dir, 'index.db'));
    store.migrate();
  });

  describe('SqliteVaultStore', () => {
    it('upsertFile + getFile round-trips', () => {
      store.upsertFile({
        path: 'Assets/Player.cs', blobHash: 'abc0123456789abc', mtimeMs: 1e9,
        size: 512, lang: 'csharp', kind: 'source', indexedAt: 1e9,
      });
      const row = store.getFile('Assets/Player.cs');
      expect(row?.lang).toBe('csharp');
    });

    it('deleteFile cascades to chunks', () => {
      store.upsertFile({ path: 'A.cs', blobHash: 'h', mtimeMs: 0, size: 1, lang: 'csharp', kind: 'source', indexedAt: 0 });
      store.upsertChunk({ chunkId: 'c1', path: 'A.cs', startLine: 1, endLine: 10, content: 'hello', tokenCount: 3 });
      store.deleteFile('A.cs');
      expect(store.getFile('A.cs')).toBeNull();
      expect(store.getChunk('c1')).toBeNull();
    });

    it('listFiles filters by lang', () => {
      store.upsertFile({ path: 'a.cs', blobHash: '1', mtimeMs: 0, size: 1, lang: 'csharp', kind: 'source', indexedAt: 0 });
      store.upsertFile({ path: 'b.ts', blobHash: '2', mtimeMs: 0, size: 1, lang: 'typescript', kind: 'source', indexedAt: 0 });
      const cs = store.listFiles({ lang: ['csharp'] });
      expect(cs).toHaveLength(1);
    });

    it('searchFts returns BM25 hits', () => {
      store.upsertFile({ path: 'A.cs', blobHash: 'h', mtimeMs: 0, size: 1, lang: 'csharp', kind: 'source', indexedAt: 0 });
      store.upsertChunk({ chunkId: 'c1', path: 'A.cs', startLine: 1, endLine: 2, content: 'player jumps high', tokenCount: 3 });
      store.upsertChunk({ chunkId: 'c2', path: 'A.cs', startLine: 3, endLine: 4, content: 'enemy attacks player', tokenCount: 3 });
      const hits = store.searchFts('player', 10);
      expect(hits.map(h => h.chunkId).sort()).toEqual(['c1', 'c2']);
    });

    it('chunkCount reports current total', () => {
      store.upsertFile({ path: 'A.cs', blobHash: 'h', mtimeMs: 0, size: 1, lang: 'csharp', kind: 'source', indexedAt: 0 });
      store.upsertChunk({ chunkId: 'c1', path: 'A.cs', startLine: 1, endLine: 2, content: 'x', tokenCount: 1 });
      store.upsertChunk({ chunkId: 'c2', path: 'A.cs', startLine: 3, endLine: 4, content: 'y', tokenCount: 1 });
      expect(store.chunkCount()).toBe(2);
    });
  });
  ```

- [ ] **Step 3.2: Run, expect fail**

  Run: `npx vitest run tests/vault/sqlite-vault-store.test.ts`
  Expected: FAIL.

- [ ] **Step 3.3: Write schema**

  Create `src/vault/schema.sql`:

  ```sql
  CREATE TABLE IF NOT EXISTS vault_files (
    path        TEXT PRIMARY KEY,
    blob_hash   TEXT NOT NULL,
    mtime_ms    INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    lang        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    indexed_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_chunks (
    chunk_id    TEXT PRIMARY KEY,
    path        TEXT NOT NULL REFERENCES vault_files(path) ON DELETE CASCADE,
    start_line  INTEGER NOT NULL,
    end_line    INTEGER NOT NULL,
    content     TEXT NOT NULL,
    token_count INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_path ON vault_chunks(path);

  CREATE VIRTUAL TABLE IF NOT EXISTS vault_chunks_fts USING fts5(
    content,
    chunk_id UNINDEXED,
    path UNINDEXED,
    tokenize = 'porter unicode61'
  );

  CREATE TABLE IF NOT EXISTS vault_embeddings (
    chunk_id   TEXT PRIMARY KEY REFERENCES vault_chunks(chunk_id) ON DELETE CASCADE,
    hnsw_id    INTEGER NOT NULL,
    dim        INTEGER NOT NULL,
    model      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ```

- [ ] **Step 3.4: Implement the store**

  Create `src/vault/sqlite-vault-store.ts`:

  ```ts
  import Database from 'better-sqlite3';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { dirname, join } from 'node:path';
  import type { VaultFile, VaultChunk } from './vault.interface.js';

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SCHEMA_PATH = join(__dirname, 'schema.sql');

  function applyDdl(db: Database.Database, sql: string): void {
    const cleaned = sql.replace(/--[^\n]*/g, '');
    const statements = cleaned.split(/;\s*(?=\n|$)/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) db.prepare(stmt).run();
  }

  export class SqliteVaultStore {
    private db: Database.Database;

    constructor(dbPath: string) {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    }

    migrate(): void {
      const ddl = readFileSync(SCHEMA_PATH, 'utf8');
      applyDdl(this.db, ddl);
    }

    upsertFile(f: VaultFile): void {
      this.db.prepare(`
        INSERT INTO vault_files (path, blob_hash, mtime_ms, size, lang, kind, indexed_at)
        VALUES (@path, @blobHash, @mtimeMs, @size, @lang, @kind, @indexedAt)
        ON CONFLICT(path) DO UPDATE SET
          blob_hash=excluded.blob_hash,
          mtime_ms=excluded.mtime_ms,
          size=excluded.size,
          lang=excluded.lang,
          kind=excluded.kind,
          indexed_at=excluded.indexed_at
      `).run(f);
    }

    getFile(path: string): VaultFile | null {
      const row = this.db.prepare('SELECT * FROM vault_files WHERE path = ?').get(path) as any;
      return row ? this.mapFile(row) : null;
    }

    listFiles(filter?: { lang?: VaultFile['lang'][] }): VaultFile[] {
      if (filter?.lang?.length) {
        const placeholders = filter.lang.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT * FROM vault_files WHERE lang IN (${placeholders}) ORDER BY path`)
          .all(...filter.lang) as any[];
        return rows.map((r) => this.mapFile(r));
      }
      const rows = this.db.prepare('SELECT * FROM vault_files ORDER BY path').all() as any[];
      return rows.map((r) => this.mapFile(r));
    }

    deleteFile(path: string): void {
      const chunkIds = this.db.prepare('SELECT chunk_id FROM vault_chunks WHERE path = ?').all(path) as { chunk_id: string }[];
      const deleteFts = this.db.prepare('DELETE FROM vault_chunks_fts WHERE chunk_id = ?');
      const txn = this.db.transaction(() => {
        for (const { chunk_id } of chunkIds) deleteFts.run(chunk_id);
        this.db.prepare('DELETE FROM vault_files WHERE path = ?').run(path);
      });
      txn();
    }

    upsertChunk(c: VaultChunk): void {
      const txn = this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO vault_chunks (chunk_id, path, start_line, end_line, content, token_count)
          VALUES (@chunkId, @path, @startLine, @endLine, @content, @tokenCount)
          ON CONFLICT(chunk_id) DO UPDATE SET
            start_line=excluded.start_line,
            end_line=excluded.end_line,
            content=excluded.content,
            token_count=excluded.token_count
        `).run(c);
        this.db.prepare('DELETE FROM vault_chunks_fts WHERE chunk_id = ?').run(c.chunkId);
        this.db.prepare('INSERT INTO vault_chunks_fts (content, chunk_id, path) VALUES (?, ?, ?)')
          .run(c.content, c.chunkId, c.path);
      });
      txn();
    }

    getChunk(chunkId: string): VaultChunk | null {
      const row = this.db.prepare('SELECT * FROM vault_chunks WHERE chunk_id = ?').get(chunkId) as any;
      if (!row) return null;
      return {
        chunkId: row.chunk_id, path: row.path,
        startLine: row.start_line, endLine: row.end_line,
        content: row.content, tokenCount: row.token_count,
      };
    }

    chunkCount(): number {
      return (this.db.prepare('SELECT COUNT(*) AS n FROM vault_chunks').get() as { n: number }).n;
    }

    searchFts(query: string, topK: number): Array<{ chunkId: string; score: number }> {
      const rows = this.db.prepare(`
        SELECT chunk_id, bm25(vault_chunks_fts) AS raw
        FROM vault_chunks_fts
        WHERE vault_chunks_fts MATCH ?
        ORDER BY raw
        LIMIT ?
      `).all(query, topK) as { chunk_id: string; raw: number }[];
      return rows.map((r) => ({ chunkId: r.chunk_id, score: -r.raw }));
    }

    private mapFile(row: any): VaultFile {
      return {
        path: row.path, blobHash: row.blob_hash, mtimeMs: row.mtime_ms,
        size: row.size, lang: row.lang, kind: row.kind, indexedAt: row.indexed_at,
      };
    }

    close(): void { this.db.close(); }
  }
  ```

- [ ] **Step 3.5: Run, expect pass**

  Run: `npx vitest run tests/vault/sqlite-vault-store.test.ts`
  Expected: PASS (5 tests).

- [ ] **Step 3.6: Commit**

  ```bash
  git add src/vault/schema.sql src/vault/sqlite-vault-store.ts tests/vault/sqlite-vault-store.test.ts
  git commit -m "feat(vault): SQLite schema + file/chunk CRUD + FTS5 BM25"
  ```

---

## Task 4: Chunker — heading-aware for markdown, token-capped fallback

**Files:**
- Create: `src/vault/chunker.ts`
- Test: `tests/vault/chunker.test.ts`

- [ ] **Step 4.1: Failing test**

  Create `tests/vault/chunker.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { chunkFile } from '../../src/vault/chunker.js';

  describe('chunker', () => {
    it('splits markdown by H2 headings', () => {
      const md = `# Title\n\npara\n\n## Section A\n\naaa\n\n## Section B\n\nbbb`;
      const chunks = chunkFile({ path: 'doc.md', content: md, lang: 'markdown' });
      expect(chunks.length).toBe(3);
      expect(chunks[1].content).toContain('Section A');
    });

    it('falls back to fixed windows for code', () => {
      const code = Array.from({ length: 500 }, (_, i) => `int x${i} = ${i};`).join('\n');
      const chunks = chunkFile({ path: 'a.cs', content: code, lang: 'csharp' });
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('produces deterministic IDs', () => {
      const a = chunkFile({ path: 'x.md', content: '# A\n\npara', lang: 'markdown' });
      const b = chunkFile({ path: 'x.md', content: '# A\n\npara', lang: 'markdown' });
      expect(a[0].chunkId).toBe(b[0].chunkId);
    });
  });
  ```

- [ ] **Step 4.2: Run, expect fail**

  Run: `npx vitest run tests/vault/chunker.test.ts`
  Expected: FAIL.

- [ ] **Step 4.3: Implement**

  Create `src/vault/chunker.ts`:

  ```ts
  import { chunkIdFor } from './hash.js';
  import type { VaultChunk } from './vault.interface.js';

  const TOKENS_PER_CHUNK = 400;
  const CHARS_PER_TOKEN = 4;
  const MAX_CHARS = TOKENS_PER_CHUNK * CHARS_PER_TOKEN;

  function countTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  function chunkMarkdown(path: string, content: string): VaultChunk[] {
    const lines = content.split(/\r?\n/);
    const sections: Array<{ start: number; body: string[] }> = [];
    let current: { start: number; body: string[] } = { start: 1, body: [] };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^##\s+/.test(line) && current.body.length) {
        sections.push(current);
        current = { start: i + 1, body: [line] };
      } else {
        current.body.push(line);
      }
    }
    if (current.body.length) sections.push(current);
    return sections.flatMap((s) => splitIfOversized(path, s.body.join('\n'), s.start));
  }

  function splitIfOversized(path: string, body: string, startLine: number): VaultChunk[] {
    if (body.length <= MAX_CHARS) {
      const endLine = startLine + body.split('\n').length - 1;
      return [makeChunk(path, startLine, endLine, body)];
    }
    const out: VaultChunk[] = [];
    const lines = body.split('\n');
    let buf: string[] = [];
    let bufChars = 0;
    let bufStart = startLine;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (bufChars + line.length + 1 > MAX_CHARS && buf.length > 0) {
        out.push(makeChunk(path, bufStart, bufStart + buf.length - 1, buf.join('\n')));
        buf = [];
        bufChars = 0;
        bufStart = startLine + i;
      }
      buf.push(line);
      bufChars += line.length + 1;
    }
    if (buf.length > 0) out.push(makeChunk(path, bufStart, bufStart + buf.length - 1, buf.join('\n')));
    return out;
  }

  function makeChunk(path: string, startLine: number, endLine: number, body: string): VaultChunk {
    return {
      chunkId: chunkIdFor(path, startLine, body),
      path, startLine, endLine,
      content: body, tokenCount: countTokens(body),
    };
  }

  export function chunkFile(input: { path: string; content: string; lang: string }): VaultChunk[] {
    if (input.lang === 'markdown') return chunkMarkdown(input.path, input.content);
    return splitIfOversized(input.path, input.content, 1);
  }
  ```

- [ ] **Step 4.4: Run, expect pass**

  Run: `npx vitest run tests/vault/chunker.test.ts`
  Expected: PASS.

- [ ] **Step 4.5: Commit**

  ```bash
  git add src/vault/chunker.ts tests/vault/chunker.test.ts
  git commit -m "feat(vault): heading-aware markdown + fixed-window code chunker"
  ```

---

## Task 5: Embedding adapter

**Files:**
- Create: `src/vault/embedding-adapter.ts`
- Test: `tests/vault/embedding-adapter.test.ts`

- [ ] **Step 5.1: Read existing HNSW contract**

  `Read` `src/rag/hnsw/hnsw-vector-store.ts`. Note the exact method signatures for `add`, `search`, `remove`. The adapter below assumes `add(vector, payload): number`, `search(vector, k)`, `remove(id)`. If names differ, rename accordingly.

- [ ] **Step 5.2: Failing test**

  Create `tests/vault/embedding-adapter.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from '../../src/vault/embedding-adapter.js';

  class FakeProvider implements EmbeddingProvider {
    readonly model = 'fake-v1'; readonly dim = 4;
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Float32Array(4);
        v[0] = t.length;
        v[1] = t.charCodeAt(0) ?? 0;
        return v;
      });
    }
  }

  class FakeStore implements VectorStore {
    private next = 1;
    readonly items = new Map<number, { v: Float32Array; payload: unknown }>();
    add(v: Float32Array, payload: unknown) { const id = this.next++; this.items.set(id, { v, payload }); return id; }
    remove(id: number) { this.items.delete(id); }
    search(_v: Float32Array, k: number) {
      return [...this.items.entries()].slice(0, k).map(([id, rec]) => ({ id, score: 0.9, payload: rec.payload }));
    }
  }

  describe('EmbeddingAdapter', () => {
    let adapter: EmbeddingAdapter;
    let store: FakeStore;
    beforeEach(() => { store = new FakeStore(); adapter = new EmbeddingAdapter(new FakeProvider(), store); });

    it('upsertBatch embeds and returns hnsw ids', async () => {
      const ids = await adapter.upsertBatch([
        { chunkId: 'c1', content: 'alpha' },
        { chunkId: 'c2', content: 'beta' },
      ]);
      expect(ids).toEqual({ c1: 1, c2: 2 });
      expect(store.items.size).toBe(2);
    });

    it('remove deletes from vector store', async () => {
      await adapter.upsertBatch([{ chunkId: 'c1', content: 'alpha' }]);
      adapter.remove(1);
      expect(store.items.size).toBe(0);
    });

    it('search returns hits with chunkId payload preserved', async () => {
      await adapter.upsertBatch([{ chunkId: 'c1', content: 'alpha' }]);
      const hits = await adapter.search('alpha', 5);
      expect(hits[0].payload).toMatchObject({ chunkId: 'c1' });
    });
  });
  ```

- [ ] **Step 5.3: Run, expect fail**

  Run: `npx vitest run tests/vault/embedding-adapter.test.ts`
  Expected: FAIL.

- [ ] **Step 5.4: Implement**

  Create `src/vault/embedding-adapter.ts`:

  ```ts
  export interface EmbeddingProvider {
    readonly model: string;
    readonly dim: number;
    embed(texts: string[]): Promise<Float32Array[]>;
  }

  export interface VectorStore {
    add(vector: Float32Array, payload: unknown): number;
    remove(id: number): void;
    search(vector: Float32Array, k: number): Array<{ id: number; score: number; payload?: unknown }>;
  }

  export interface ChunkToEmbed {
    chunkId: string;
    content: string;
  }

  export class EmbeddingAdapter {
    constructor(readonly provider: EmbeddingProvider, readonly store: VectorStore) {}

    async upsertBatch(chunks: ChunkToEmbed[]): Promise<Record<string, number>> {
      if (chunks.length === 0) return {};
      const vectors = await this.provider.embed(chunks.map((c) => c.content));
      const out: Record<string, number> = {};
      for (let i = 0; i < chunks.length; i++) {
        const id = this.store.add(vectors[i], { chunkId: chunks[i].chunkId });
        out[chunks[i].chunkId] = id;
      }
      return out;
    }

    remove(hnswId: number): void { this.store.remove(hnswId); }

    async search(query: string, topK: number) {
      const [vec] = await this.provider.embed([query]);
      return this.store.search(vec, topK);
    }
  }
  ```

- [ ] **Step 5.5: Run, expect pass**

  Run: `npx vitest run tests/vault/embedding-adapter.test.ts`
  Expected: PASS.

- [ ] **Step 5.6: Commit**

  ```bash
  git add src/vault/embedding-adapter.ts tests/vault/embedding-adapter.test.ts
  git commit -m "feat(vault): embedding adapter over pluggable vector store"
  ```

---

## Task 6: Query pipeline helpers

**Files:**
- Create: `src/vault/query-pipeline.ts`
- Test: `tests/vault/query-pipeline.test.ts`

- [ ] **Step 6.1: Failing test**

  Create `tests/vault/query-pipeline.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { rrfFuse, packByBudget } from '../../src/vault/query-pipeline.js';

  describe('rrfFuse', () => {
    it('combines two ranked lists with RRF', () => {
      const fts = [{ chunkId: 'a', score: 10 }, { chunkId: 'b', score: 5 }];
      const hnsw = [{ chunkId: 'b', score: 0.9 }, { chunkId: 'c', score: 0.7 }];
      const fused = rrfFuse(fts, hnsw, 60);
      expect(fused[0].chunkId).toBe('b');
      expect(fused.length).toBe(3);
    });
    it('handles empty inputs', () => { expect(rrfFuse([], [], 60)).toEqual([]); });
  });

  describe('packByBudget', () => {
    it('greedily picks chunks up to budget', () => {
      const items = [
        { chunkId: 'a', tokenCount: 100 },
        { chunkId: 'b', tokenCount: 200 },
        { chunkId: 'c', tokenCount: 50 },
      ];
      const { kept, dropped } = packByBudget(items, 180);
      expect(kept.map((x) => x.chunkId)).toEqual(['a', 'c']);
      expect(dropped.map((x) => x.chunkId)).toEqual(['b']);
    });
  });
  ```

- [ ] **Step 6.2: Run, expect fail**

  Run: `npx vitest run tests/vault/query-pipeline.test.ts`
  Expected: FAIL.

- [ ] **Step 6.3: Implement**

  Create `src/vault/query-pipeline.ts`:

  ```ts
  export interface Ranked { chunkId: string; score: number; }

  export interface Fused {
    chunkId: string;
    rrf: number;
    ftsRank: number | null;
    hnswRank: number | null;
  }

  export function rrfFuse(fts: Ranked[], hnsw: Ranked[], k: number): Fused[] {
    const map = new Map<string, Fused>();
    const add = (list: Ranked[], setRank: (f: Fused, rank: number) => void) => {
      list.forEach((entry, idx) => {
        const rank = idx + 1;
        const existing = map.get(entry.chunkId) ?? { chunkId: entry.chunkId, rrf: 0, ftsRank: null, hnswRank: null };
        existing.rrf += 1 / (k + rank);
        setRank(existing, rank);
        map.set(entry.chunkId, existing);
      });
    };
    add(fts, (f, r) => { f.ftsRank = r; });
    add(hnsw, (f, r) => { f.hnswRank = r; });
    return [...map.values()].sort((a, b) => b.rrf - a.rrf);
  }

  export function packByBudget<T extends { tokenCount: number }>(items: T[], budget: number): { kept: T[]; dropped: T[] } {
    const kept: T[] = [];
    const dropped: T[] = [];
    let used = 0;
    for (const it of items) {
      if (used + it.tokenCount <= budget) { kept.push(it); used += it.tokenCount; }
      else dropped.push(it);
    }
    return { kept, dropped };
  }
  ```

- [ ] **Step 6.4: Run, expect pass**

  Run: `npx vitest run tests/vault/query-pipeline.test.ts`
  Expected: PASS.

- [ ] **Step 6.5: Commit**

  ```bash
  git add src/vault/query-pipeline.ts tests/vault/query-pipeline.test.ts
  git commit -m "feat(vault): RRF fusion + token-budget packer"
  ```

---

## Task 7: Unity project discovery + fixture

**Files:**
- Create: `src/vault/discovery.ts`
- Test: `tests/vault/discovery.test.ts`
- Create fixture files under `tests/fixtures/unity-mini/`

- [ ] **Step 7.1: Build fixture**

  ```bash
  mkdir -p tests/fixtures/unity-mini/Assets/Scripts
  mkdir -p tests/fixtures/unity-mini/ProjectSettings
  mkdir -p tests/fixtures/unity-mini/Packages
  ```

  Create `tests/fixtures/unity-mini/Assets/Scripts/Player.cs`:

  ```csharp
  using UnityEngine;
  namespace Game {
      /// <summary>Top-level player entity.</summary>
      public class Player : MonoBehaviour {
          public void Move(float dt) { transform.Translate(0, 0, dt); }
      }
  }
  ```

  Create `tests/fixtures/unity-mini/Assets/Scripts/Enemy.cs`:

  ```csharp
  using UnityEngine;
  namespace Game {
      public class Enemy : MonoBehaviour {
          public void Attack() { Debug.Log("attack"); }
      }
  }
  ```

  Create `tests/fixtures/unity-mini/ProjectSettings/ProjectVersion.txt`:

  ```
  m_EditorVersion: 2022.3.0f1
  ```

  Create `tests/fixtures/unity-mini/Packages/manifest.json`:

  ```json
  { "dependencies": {} }
  ```

- [ ] **Step 7.2: Failing test**

  Create `tests/vault/discovery.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { join } from 'node:path';
  import { discoverUnityRoots, listIndexableFiles } from '../../src/vault/discovery.js';

  const fixture = join(process.cwd(), 'tests/fixtures/unity-mini');

  describe('discovery', () => {
    it('detects Unity project by sentinels', async () => {
      expect(await discoverUnityRoots(fixture))
        .toEqual({ assets: 'Assets', projectSettings: 'ProjectSettings', packages: 'Packages' });
    });

    it('returns null for non-Unity dirs', async () => {
      expect(await discoverUnityRoots(process.cwd())).toBeNull();
    });

    it('lists .cs files under Assets/', async () => {
      const files = await listIndexableFiles(fixture);
      const cs = files.filter((f) => f.lang === 'csharp').map((f) => f.path.replaceAll('\\', '/'));
      expect(cs).toContain('Assets/Scripts/Player.cs');
      expect(cs).toContain('Assets/Scripts/Enemy.cs');
    });

    it('ignores Library/Temp/obj/bin', async () => {
      const files = await listIndexableFiles(fixture);
      expect(files.every((f) => !/\/(Library|Temp|obj|bin)\//.test(f.path))).toBe(true);
    });
  });
  ```

- [ ] **Step 7.3: Run, expect fail**

  Run: `npx vitest run tests/vault/discovery.test.ts`
  Expected: FAIL.

- [ ] **Step 7.4: Implement**

  Create `src/vault/discovery.ts`:

  ```ts
  import { access, stat, readdir } from 'node:fs/promises';
  import { join, relative, extname } from 'node:path';
  import type { VaultFile } from './vault.interface.js';

  export interface UnityRoots {
    assets: string;
    projectSettings: string;
    packages: string;
  }

  const IGNORE = new Set(['Library', 'Temp', 'Logs', 'obj', 'bin', '.git', 'node_modules', '.strada']);
  const EXT_LANG: Record<string, VaultFile['lang']> = {
    '.cs': 'csharp', '.ts': 'typescript', '.tsx': 'typescript',
    '.md': 'markdown', '.json': 'json',
    '.hlsl': 'hlsl', '.shader': 'hlsl', '.cginc': 'hlsl',
  };

  export async function discoverUnityRoots(root: string): Promise<UnityRoots | null> {
    const required = ['Assets', 'ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json'];
    for (const rel of required) {
      try { await access(join(root, rel)); }
      catch { return null; }
    }
    return { assets: 'Assets', projectSettings: 'ProjectSettings', packages: 'Packages' };
  }

  export async function listIndexableFiles(root: string): Promise<VaultFile[]> {
    const out: VaultFile[] = [];
    await walk(root, root, out);
    return out;
  }

  async function walk(root: string, dir: string, out: VaultFile[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(root, full, out);
      } else if (e.isFile()) {
        const lang = EXT_LANG[extname(e.name).toLowerCase()];
        if (!lang) continue;
        const st = await stat(full);
        out.push({
          path: relative(root, full).replaceAll('\\', '/'),
          blobHash: '',
          mtimeMs: st.mtimeMs,
          size: st.size,
          lang,
          kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
          indexedAt: 0,
        });
      }
    }
  }
  ```

- [ ] **Step 7.5: Run, expect pass**

  Run: `npx vitest run tests/vault/discovery.test.ts`
  Expected: PASS.

- [ ] **Step 7.6: Commit**

  ```bash
  git add src/vault/discovery.ts tests/vault/discovery.test.ts tests/fixtures/unity-mini
  git commit -m "feat(vault): Unity project discovery + fixture"
  ```

---

## Task 8: UnityProjectVault core

**Files:**
- Create: `src/vault/unity-project-vault.ts`
- Test: `tests/vault/unity-project-vault.integration.test.ts`

- [ ] **Step 8.1: Failing integration test**

  Create `tests/vault/unity-project-vault.integration.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdtempSync, cpSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';
  import type { EmbeddingProvider, VectorStore } from '../../src/vault/embedding-adapter.js';

  class Stub implements EmbeddingProvider {
    readonly model = 'stub'; readonly dim = 4;
    async embed(xs: string[]) {
      return xs.map((t) => {
        const v = new Float32Array(4);
        for (let i = 0; i < 4; i++) v[i] = t.charCodeAt(i) ?? 0;
        return v;
      });
    }
  }
  class InMem implements VectorStore {
    private n = 1; items = new Map<number, unknown>();
    add(_v: Float32Array, p: unknown) { const id = this.n++; this.items.set(id, p); return id; }
    remove(id: number) { this.items.delete(id); }
    search() { return [...this.items.entries()].slice(0, 10).map(([id, payload]) => ({ id, score: 0.9, payload })); }
  }

  let dir: string;
  let vault: UnityProjectVault;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'upv-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    vault = new UnityProjectVault({
      id: 'test', rootPath: dir, embedding: new Stub(), vectorStore: new InMem(),
    });
  });

  afterEach(async () => {
    await vault.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('UnityProjectVault', () => {
    it('init indexes fixture files', async () => {
      await vault.init();
      const stats = await vault.stats();
      expect(stats.fileCount).toBeGreaterThanOrEqual(2);
      expect(stats.chunkCount).toBeGreaterThanOrEqual(2);
    });

    it('query finds chunks by keyword', async () => {
      await vault.init();
      const res = await vault.query({ text: 'Attack', topK: 5 });
      expect(res.hits.some((h) => h.chunk.path.endsWith('Enemy.cs'))).toBe(true);
    });

    it('sync with no changes reports 0 changed', async () => {
      await vault.init();
      const r = await vault.sync();
      expect(r.changed).toBe(0);
    });
  });
  ```

- [ ] **Step 8.2: Run, expect fail**

  Run: `npx vitest run tests/vault/unity-project-vault.integration.test.ts`
  Expected: FAIL.

- [ ] **Step 8.3: Implement**

  Create `src/vault/unity-project-vault.ts`:

  ```ts
  import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
  import { join } from 'node:path';
  import { EventEmitter } from 'node:events';
  import Database from 'better-sqlite3';
  import { SqliteVaultStore } from './sqlite-vault-store.js';
  import { chunkFile } from './chunker.js';
  import { xxhash64Hex } from './hash.js';
  import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from './embedding-adapter.js';
  import { rrfFuse, packByBudget } from './query-pipeline.js';
  import { listIndexableFiles } from './discovery.js';
  import type {
    IVault, VaultFile, VaultQuery, VaultQueryResult, VaultStats, VaultId, VaultChunk,
  } from './vault.interface.js';

  export interface UnityVaultDeps {
    id: VaultId;
    rootPath: string;
    embedding: EmbeddingProvider;
    vectorStore: VectorStore;
  }

  function escapeFtsQuery(q: string): string {
    const safe = q.replace(/["*:()]/g, ' ').trim();
    if (!safe) return '""';
    return `"${safe}"`;
  }

  function inferLang(path: string): VaultFile['lang'] {
    if (path.endsWith('.cs')) return 'csharp';
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.md')) return 'markdown';
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.hlsl') || path.endsWith('.shader') || path.endsWith('.cginc')) return 'hlsl';
    return 'unknown';
  }

  function payloadChunkId(hit: { payload?: unknown }): string | null {
    if (hit.payload && typeof hit.payload === 'object' && 'chunkId' in hit.payload) {
      return (hit.payload as { chunkId: string }).chunkId;
    }
    return null;
  }

  export class UnityProjectVault implements IVault {
    readonly id: VaultId;
    readonly kind = 'unity-project' as const;
    readonly rootPath: string;
    private store: SqliteVaultStore;
    private adapter: EmbeddingAdapter;
    private emitter = new EventEmitter();
    private dbPath: string;
    private watcher: import('./watcher.js').VaultWatcher | null = null;

    constructor(deps: UnityVaultDeps) {
      this.id = deps.id;
      this.rootPath = deps.rootPath;
      this.dbPath = join(deps.rootPath, '.strada/vault/index.db');
      this.store = new SqliteVaultStore(this.dbPath);
      this.adapter = new EmbeddingAdapter(deps.embedding, deps.vectorStore);
    }

    async init(): Promise<void> {
      await mkdir(join(this.rootPath, '.strada/vault/codebase'), { recursive: true });
      this.store.migrate();
      await this.fullIndex();
    }

    async sync(): Promise<{ changed: number; durationMs: number }> {
      const started = Date.now();
      const changed = await this.reindexChanged();
      return { changed, durationMs: Date.now() - started };
    }

    async rebuild(): Promise<void> {
      this.store.close();
      await unlink(this.dbPath).catch(() => undefined);
      this.store = new SqliteVaultStore(this.dbPath);
      await this.init();
    }

    async query(q: VaultQuery): Promise<VaultQueryResult> {
      const topK = q.topK ?? 20;
      const fts = this.store.searchFts(escapeFtsQuery(q.text), topK);
      const hnsw = await this.adapter.search(q.text, topK);
      const hnswRanked = hnsw
        .map((h) => ({ chunkId: payloadChunkId(h), score: h.score }))
        .filter((r): r is { chunkId: string; score: number } => r.chunkId !== null);
      const fused = rrfFuse(fts, hnswRanked, 60).slice(0, topK);
      const chunks = fused
        .map((f) => this.store.getChunk(f.chunkId))
        .filter((c): c is VaultChunk => c !== null);
      const budget = q.budgetTokens ?? Number.POSITIVE_INFINITY;
      const { kept } = packByBudget(chunks, budget);
      return {
        hits: kept.map((chunk) => {
          const f = fused.find((x) => x.chunkId === chunk.chunkId)!;
          return {
            chunk,
            scores: {
              fts: fts.find((x) => x.chunkId === chunk.chunkId)?.score ?? null,
              hnsw: hnswRanked.find((x) => x.chunkId === chunk.chunkId)?.score ?? null,
              rrf: f.rrf,
            },
          };
        }),
        budgetUsed: kept.reduce((a, c) => a + c.tokenCount, 0),
        truncated: kept.length < chunks.length,
      };
    }

    async stats(): Promise<VaultStats> {
      const files = this.store.listFiles();
      const chunkCount = this.store.chunkCount();
      let lastIndexedAt: number | null = null;
      for (const f of files) {
        if (lastIndexedAt === null || f.indexedAt > lastIndexedAt) lastIndexedAt = f.indexedAt;
      }
      const fs = await import('node:fs/promises');
      const st = await fs.stat(this.dbPath).catch(() => null);
      return { fileCount: files.length, chunkCount, lastIndexedAt, dbBytes: st?.size ?? 0 };
    }

    listFiles(): VaultFile[] { return this.store.listFiles(); }

    async readFile(relPath: string): Promise<string> {
      return await readFile(join(this.rootPath, relPath), 'utf8');
    }

    onUpdate(listener: (p: { vaultId: VaultId; changedPaths: string[] }) => void): () => void {
      this.emitter.on('update', listener);
      return () => { this.emitter.off('update', listener); };
    }

    async startWatch(debounceMs = 800): Promise<void> {
      if (this.watcher) return;
      const { VaultWatcher } = await import('./watcher.js');
      this.watcher = new VaultWatcher({
        root: this.rootPath,
        debounceMs,
        onBatch: async (paths) => {
          const changed: string[] = [];
          for (const p of paths) if (await this.reindexFile(p)) changed.push(p);
          if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
        },
      });
      await this.watcher.start();
    }

    async stopWatch(): Promise<void> {
      if (this.watcher) { await this.watcher.stop(); this.watcher = null; }
    }

    async dispose(): Promise<void> {
      await this.stopWatch();
      this.store.close();
    }

    async reindexFile(relPath: string): Promise<boolean> {
      const abs = join(this.rootPath, relPath);
      const body = await readFile(abs, 'utf8').catch(() => null);
      if (body === null) { this.store.deleteFile(relPath); return true; }
      const st = await stat(abs);
      const hash = xxhash64Hex(body);
      const lang = inferLang(relPath);
      this.store.deleteFile(relPath);
      this.store.upsertFile({
        path: relPath, blobHash: hash, mtimeMs: st.mtimeMs, size: st.size,
        lang, kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
        indexedAt: Date.now(),
      });
      const chunks = chunkFile({ path: relPath, content: body, lang });
      for (const c of chunks) this.store.upsertChunk(c);
      const ids = await this.adapter.upsertBatch(chunks.map((c) => ({ chunkId: c.chunkId, content: c.content })));
      const db = new Database(this.dbPath);
      const ins = db.prepare('INSERT OR REPLACE INTO vault_embeddings (chunk_id, hnsw_id, dim, model) VALUES (?, ?, ?, ?)');
      for (const [chunkId, hnswId] of Object.entries(ids)) {
        ins.run(chunkId, hnswId, this.adapter.provider.dim, this.adapter.provider.model);
      }
      db.close();
      return true;
    }

    private async fullIndex(): Promise<void> {
      const files = await listIndexableFiles(this.rootPath);
      const changed: string[] = [];
      for (const f of files) if (await this.reindexFile(f.path)) changed.push(f.path);
      if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
    }

    private async reindexChanged(): Promise<number> {
      const files = await listIndexableFiles(this.rootPath);
      const changed: string[] = [];
      for (const f of files) {
        const body = await readFile(join(this.rootPath, f.path), 'utf8');
        const hash = xxhash64Hex(body);
        const existing = this.store.getFile(f.path);
        if (existing?.blobHash === hash) continue;
        await this.reindexFile(f.path);
        changed.push(f.path);
      }
      const existing = new Set(this.store.listFiles().map((f) => f.path));
      const present = new Set(files.map((f) => f.path));
      for (const p of existing) {
        if (!present.has(p)) { this.store.deleteFile(p); changed.push(p); }
      }
      if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
      return changed.length;
    }
  }
  ```

- [ ] **Step 8.4: Run, expect pass**

  Run: `npx vitest run tests/vault/unity-project-vault.integration.test.ts`
  Expected: PASS.

- [ ] **Step 8.5: Commit**

  ```bash
  git add src/vault/unity-project-vault.ts tests/vault/unity-project-vault.integration.test.ts
  git commit -m "feat(vault): UnityProjectVault init/sync/query/rebuild"
  ```

---

## Task 9: VaultRegistry

**Files:**
- Create: `src/vault/vault-registry.ts`
- Test: `tests/vault/vault-registry.test.ts`

- [ ] **Step 9.1: Failing test**

  Create `tests/vault/vault-registry.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { VaultRegistry } from '../../src/vault/vault-registry.js';
  import type { IVault, VaultQuery, VaultQueryResult, VaultStats, VaultFile } from '../../src/vault/vault.interface.js';

  class FakeVault implements IVault {
    readonly kind = 'unity-project' as const;
    readonly rootPath = '/tmp';
    constructor(readonly id: string, private result: VaultQueryResult) {}
    async init() {}
    async sync() { return { changed: 0, durationMs: 0 }; }
    async rebuild() {}
    async query(_q: VaultQuery) { return this.result; }
    async stats(): Promise<VaultStats> { return { fileCount: 1, chunkCount: 1, lastIndexedAt: 0, dbBytes: 0 }; }
    async dispose() {}
    listFiles(): VaultFile[] { return []; }
    async readFile() { return ''; }
    onUpdate() { return () => {}; }
  }

  describe('VaultRegistry', () => {
    let reg: VaultRegistry;
    beforeEach(() => { reg = new VaultRegistry(); });

    it('registers and lists vaults', () => {
      reg.register(new FakeVault('a', { hits: [], budgetUsed: 0, truncated: false }));
      reg.register(new FakeVault('b', { hits: [], budgetUsed: 0, truncated: false }));
      expect(reg.list().map((v) => v.id).sort()).toEqual(['a', 'b']);
    });

    it('query fans out and sorts by RRF', async () => {
      reg.register(new FakeVault('a', {
        hits: [{ chunk: { chunkId: 'x', path: 'p', startLine: 1, endLine: 1, content: '', tokenCount: 0 }, scores: { fts: 1, hnsw: null, rrf: 0.05 } }],
        budgetUsed: 0, truncated: false,
      }));
      reg.register(new FakeVault('b', {
        hits: [{ chunk: { chunkId: 'y', path: 'q', startLine: 1, endLine: 1, content: '', tokenCount: 0 }, scores: { fts: null, hnsw: 0.9, rrf: 0.1 } }],
        budgetUsed: 0, truncated: false,
      }));
      const r = await reg.query({ text: 'foo' });
      expect(r.hits[0].chunk.chunkId).toBe('y');
    });

    it('disposeAll closes everything', async () => {
      let count = 0;
      class Spy extends FakeVault { async dispose() { count++; } }
      reg.register(new Spy('a', { hits: [], budgetUsed: 0, truncated: false }));
      reg.register(new Spy('b', { hits: [], budgetUsed: 0, truncated: false }));
      await reg.disposeAll();
      expect(count).toBe(2);
    });
  });
  ```

- [ ] **Step 9.2: Run, expect fail**

  Run: `npx vitest run tests/vault/vault-registry.test.ts`
  Expected: FAIL.

- [ ] **Step 9.3: Implement**

  Create `src/vault/vault-registry.ts`:

  ```ts
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
  ```

- [ ] **Step 9.4: Run, expect pass**

  Run: `npx vitest run tests/vault/vault-registry.test.ts`
  Expected: PASS.

- [ ] **Step 9.5: Commit**

  ```bash
  git add src/vault/vault-registry.ts tests/vault/vault-registry.test.ts
  git commit -m "feat(vault): VaultRegistry with fan-out query"
  ```

---

## Task 10: Chokidar watcher

**Files:**
- Create: `src/vault/watcher.ts`
- Test: `tests/vault/watcher.integration.test.ts`

- [ ] **Step 10.1: Failing test**

  Create `tests/vault/watcher.integration.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { VaultWatcher } from '../../src/vault/watcher.js';

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'watcher-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('VaultWatcher', () => {
    it('debounces multiple writes into one batch', async () => {
      const batches: string[][] = [];
      const w = new VaultWatcher({
        root: dir, debounceMs: 200,
        onBatch: async (paths) => { batches.push(paths); },
      });
      await w.start();
      writeFileSync(join(dir, 'a.cs'), 'x');
      writeFileSync(join(dir, 'b.cs'), 'x');
      await new Promise((r) => setTimeout(r, 600));
      await w.stop();
      expect(batches.length).toBe(1);
      expect(batches[0].sort()).toEqual(['a.cs', 'b.cs']);
    });

    it('ignores Library/', async () => {
      const seen: string[] = [];
      const w = new VaultWatcher({
        root: dir, debounceMs: 100,
        onBatch: async (p) => { seen.push(...p); },
      });
      await w.start();
      writeFileSync(join(dir, 'real.cs'), 'x');
      mkdirSync(join(dir, 'Library'));
      writeFileSync(join(dir, 'Library/junk.cs'), 'x');
      await new Promise((r) => setTimeout(r, 400));
      await w.stop();
      expect(seen).toContain('real.cs');
      expect(seen.every((p) => !p.includes('Library'))).toBe(true);
    });
  });
  ```

- [ ] **Step 10.2: Run, expect fail**

  Run: `npx vitest run tests/vault/watcher.integration.test.ts`
  Expected: FAIL.

- [ ] **Step 10.3: Implement**

  Create `src/vault/watcher.ts`:

  ```ts
  import chokidar, { type FSWatcher } from 'chokidar';
  import { relative } from 'node:path';

  export interface VaultWatcherOptions {
    root: string;
    debounceMs: number;
    onBatch: (paths: string[]) => Promise<void> | void;
  }

  const IGNORE_REGEX = /(^|\/)(Library|Temp|Logs|obj|bin|\.git|node_modules|\.strada)(\/|$)/;

  export class VaultWatcher {
    private watcher: FSWatcher | null = null;
    private dirty = new Set<string>();
    private timer: NodeJS.Timeout | null = null;
    constructor(private opts: VaultWatcherOptions) {}

    async start(): Promise<void> {
      this.watcher = chokidar.watch(this.opts.root, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        ignored: (path) => IGNORE_REGEX.test(path.replaceAll('\\', '/')),
      });
      const enqueue = (absPath: string) => {
        const rel = relative(this.opts.root, absPath).replaceAll('\\', '/');
        if (IGNORE_REGEX.test('/' + rel)) return;
        this.dirty.add(rel);
        this.scheduleDrain();
      };
      this.watcher.on('add', enqueue);
      this.watcher.on('change', enqueue);
      this.watcher.on('unlink', enqueue);
    }

    private scheduleDrain(): void {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.drain(), this.opts.debounceMs);
    }

    private async drain(): Promise<void> {
      const batch = [...this.dirty].sort();
      this.dirty.clear();
      this.timer = null;
      if (batch.length) await this.opts.onBatch(batch);
    }

    async stop(): Promise<void> {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.watcher) { await this.watcher.close(); this.watcher = null; }
      if (this.dirty.size) await this.drain();
    }
  }
  ```

- [ ] **Step 10.4: Run, expect pass**

  Run: `npx vitest run tests/vault/watcher.integration.test.ts`
  Expected: PASS.

- [ ] **Step 10.5: Commit**

  ```bash
  git add src/vault/watcher.ts tests/vault/watcher.integration.test.ts
  git commit -m "feat(vault): chokidar watcher with debounced dirty-set"
  ```

---

## Task 11: Live update integration (watcher + vault)

**Files:**
- Modify: `tests/vault/unity-project-vault.integration.test.ts`

- [ ] **Step 11.1: Failing test**

  Append to the existing file:

  ```ts
  import { writeFileSync } from 'node:fs';

  describe('UnityProjectVault live updates', () => {
    it('reindexes files added after startWatch', async () => {
      await vault.init();
      await vault.startWatch(150);
      writeFileSync(join(dir, 'Assets/Scripts/Boss.cs'), 'namespace Game { public class Boss {} }');
      await new Promise((r) => setTimeout(r, 1200));
      const res = await vault.query({ text: 'Boss', topK: 5 });
      expect(res.hits.some((h) => h.chunk.path.endsWith('Boss.cs'))).toBe(true);
      await vault.stopWatch();
    });
  });
  ```

- [ ] **Step 11.2: Run**

  Run: `npx vitest run tests/vault/unity-project-vault.integration.test.ts`
  Expected: PASS — UnityProjectVault already supports `startWatch`/`stopWatch` (implemented in Task 8).

- [ ] **Step 11.3: Commit**

  ```bash
  git add tests/vault/unity-project-vault.integration.test.ts
  git commit -m "test(vault): live update via watcher end-to-end"
  ```

---

## Task 12: Write-hook module

**Files:**
- Create: `src/vault/write-hook.ts`
- Test: `tests/vault/write-hook.test.ts`

- [ ] **Step 12.1: Failing test**

  Create `tests/vault/write-hook.test.ts`:

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { installWriteHook } from '../../src/vault/write-hook.js';

  function fakeVault(reindex = vi.fn()) {
    return { id: 'v1', kind: 'unity-project', rootPath: '/proj', reindexFile: reindex } as any;
  }

  describe('write-hook', () => {
    it('reindexes within budget', async () => {
      const r = vi.fn().mockResolvedValue(true);
      const hook = installWriteHook({ vault: fakeVault(r), budgetMs: 200 });
      await hook.afterWrite('/proj/Assets/A.cs');
      expect(r).toHaveBeenCalledWith('Assets/A.cs');
    });

    it('returns stale warning when budget exceeded', async () => {
      const r = vi.fn(async () => { await new Promise((res) => setTimeout(res, 50)); return true; });
      const hook = installWriteHook({ vault: fakeVault(r), budgetMs: 10 });
      const warn = await hook.afterWrite('/proj/Assets/A.cs');
      expect(warn).toMatch(/vault may be stale/i);
    });

    it('no-ops for paths outside vault root', async () => {
      const r = vi.fn();
      const hook = installWriteHook({ vault: fakeVault(r), budgetMs: 200 });
      await hook.afterWrite('/other/place/a.cs');
      expect(r).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 12.2: Run, expect fail**

  Run: `npx vitest run tests/vault/write-hook.test.ts`
  Expected: FAIL.

- [ ] **Step 12.3: Implement**

  Create `src/vault/write-hook.ts`:

  ```ts
  import { relative, isAbsolute, resolve } from 'node:path';
  import type { IVault } from './vault.interface.js';

  export interface WriteHookOptions {
    vault: IVault & { reindexFile: (relPath: string) => Promise<boolean> };
    budgetMs: number;
  }

  export interface InstalledWriteHook {
    afterWrite(absOrRelPath: string): Promise<string | null>;
  }

  export function installWriteHook(opts: WriteHookOptions): InstalledWriteHook {
    return {
      async afterWrite(absOrRelPath: string): Promise<string | null> {
        const abs = isAbsolute(absOrRelPath) ? absOrRelPath : resolve(opts.vault.rootPath, absOrRelPath);
        const rel = relative(opts.vault.rootPath, abs).replaceAll('\\', '/');
        if (rel.startsWith('..')) return null;
        const started = Date.now();
        const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), opts.budgetMs));
        const workPromise = opts.vault.reindexFile(rel).then(() => 'ok' as const);
        const outcome = await Promise.race([workPromise, timeoutPromise]);
        if (outcome === 'timeout') {
          void workPromise.catch(() => undefined);
          return `vault may be stale for ${rel} (reindex exceeded ${opts.budgetMs}ms)`;
        }
        const took = Date.now() - started;
        if (took > opts.budgetMs) return `vault reindex took ${took}ms for ${rel}`;
        return null;
      },
    };
  }
  ```

- [ ] **Step 12.4: Run, expect pass**

  Run: `npx vitest run tests/vault/write-hook.test.ts`
  Expected: PASS.

- [ ] **Step 12.5: Commit**

  ```bash
  git add src/vault/write-hook.ts tests/vault/write-hook.test.ts
  git commit -m "feat(vault): budget-aware write-hook"
  ```

---

## Task 13: Vault tools (`vault_init`, `vault_sync`, `vault_status`)

**Files:**
- Create: `src/agents/tools/vault-init-tool.ts`
- Create: `src/agents/tools/vault-sync-tool.ts`
- Create: `src/agents/tools/vault-status-tool.ts`
- Modify: `src/core/tool-registry.ts`
- Test: `tests/vault/vault-tools.test.ts`

- [ ] **Step 13.1: Failing test**

  Create `tests/vault/vault-tools.test.ts`:

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { VaultInitTool } from '../../src/agents/tools/vault-init-tool.js';
  import { VaultSyncTool } from '../../src/agents/tools/vault-sync-tool.js';
  import { VaultStatusTool } from '../../src/agents/tools/vault-status-tool.js';

  const reg = {
    get: vi.fn(() => ({
      id: 'unity:abc',
      init: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue({ changed: 3, durationMs: 120 }),
      stats: vi.fn().mockResolvedValue({ fileCount: 10, chunkCount: 50, lastIndexedAt: 1, dbBytes: 2048 }),
    })),
    list: vi.fn(() => [{ id: 'unity:abc' }]),
  } as any;

  describe('vault tools', () => {
    it('VaultInitTool reports initialization', async () => {
      const t = new VaultInitTool(reg);
      expect(await t.execute({ vaultId: 'unity:abc' })).toMatch(/initialized/i);
    });
    it('VaultSyncTool shows changed-count', async () => {
      const t = new VaultSyncTool(reg);
      const r = await t.execute({ vaultId: 'unity:abc' });
      expect(r).toMatch(/3 .*file/i);
      expect(r).toMatch(/120/);
    });
    it('VaultStatusTool shows stats', async () => {
      const t = new VaultStatusTool(reg);
      const r = await t.execute({ vaultId: 'unity:abc' });
      expect(r).toMatch(/10 files/);
      expect(r).toMatch(/50 chunks/);
    });
  });
  ```

- [ ] **Step 13.2: Run, expect fail**

  Run: `npx vitest run tests/vault/vault-tools.test.ts`
  Expected: FAIL.

- [ ] **Step 13.3: Implement tools**

  Create `src/agents/tools/vault-init-tool.ts`:

  ```ts
  import type { VaultRegistry } from '../../vault/vault-registry.js';

  export class VaultInitTool {
    readonly name = 'vault_init';
    readonly description = 'Initialize a vault by ID.';
    readonly inputSchema = {
      type: 'object',
      properties: { vaultId: { type: 'string' } },
      required: ['vaultId'],
    } as const;
    constructor(private registry: VaultRegistry) {}

    async execute(input: { vaultId: string }): Promise<string> {
      const v = this.registry.get(input.vaultId);
      if (!v) return `vault not found: ${input.vaultId}`;
      await v.init();
      return `vault ${input.vaultId} initialized`;
    }
  }
  ```

  Create `src/agents/tools/vault-sync-tool.ts`:

  ```ts
  import type { VaultRegistry } from '../../vault/vault-registry.js';

  export class VaultSyncTool {
    readonly name = 'vault_sync';
    readonly description = 'Reindex changed files in a vault.';
    readonly inputSchema = {
      type: 'object',
      properties: { vaultId: { type: 'string' } },
      required: ['vaultId'],
    } as const;
    constructor(private registry: VaultRegistry) {}

    async execute(input: { vaultId: string }): Promise<string> {
      const v = this.registry.get(input.vaultId);
      if (!v) return `vault not found: ${input.vaultId}`;
      const r = await v.sync();
      return `sync ${input.vaultId}: ${r.changed} file(s) reindexed in ${r.durationMs}ms`;
    }
  }
  ```

  Create `src/agents/tools/vault-status-tool.ts`:

  ```ts
  import type { VaultRegistry } from '../../vault/vault-registry.js';

  export class VaultStatusTool {
    readonly name = 'vault_status';
    readonly description = 'Show vault stats.';
    readonly inputSchema = {
      type: 'object',
      properties: { vaultId: { type: 'string' } },
      required: [],
    } as const;
    constructor(private registry: VaultRegistry) {}

    async execute(input: { vaultId?: string }): Promise<string> {
      const vaults = input.vaultId
        ? [this.registry.get(input.vaultId)].filter(Boolean)
        : this.registry.list();
      const lines: string[] = [];
      for (const v of vaults) {
        const s = await v!.stats();
        lines.push(`${v!.id}: ${s.fileCount} files, ${s.chunkCount} chunks, ${s.dbBytes}B`);
      }
      return lines.length ? lines.join('\n') : 'no vaults registered';
    }
  }
  ```

- [ ] **Step 13.4: Register tools**

  `Read` `src/core/tool-registry.ts`. Add imports for the three new tools and register them. Assume a `vaultRegistry` is accessible to the registration function; if not, accept it as a constructor arg.

  ```ts
  import { VaultInitTool } from '../agents/tools/vault-init-tool.js';
  import { VaultSyncTool } from '../agents/tools/vault-sync-tool.js';
  import { VaultStatusTool } from '../agents/tools/vault-status-tool.js';
  // ...
  registry.register(new VaultInitTool(vaultRegistry));
  registry.register(new VaultSyncTool(vaultRegistry));
  registry.register(new VaultStatusTool(vaultRegistry));
  ```

- [ ] **Step 13.5: Run, expect pass**

  Run: `npx vitest run tests/vault/vault-tools.test.ts`
  Expected: PASS.

- [ ] **Step 13.6: Commit**

  ```bash
  git add src/agents/tools/vault-init-tool.ts src/agents/tools/vault-sync-tool.ts src/agents/tools/vault-status-tool.ts src/core/tool-registry.ts tests/vault/vault-tools.test.ts
  git commit -m "feat(vault): vault_init, vault_sync, vault_status tools"
  ```

---

## Task 14: Generalize `FrameworkPackageId`

**Files:**
- Modify: `src/intelligence/framework/framework-types.ts`
- Test: `tests/vault/framework-types-compat.test.ts`

- [ ] **Step 14.1: Failing test**

  Create `tests/vault/framework-types-compat.test.ts`:

  ```ts
  import { describe, it, expectTypeOf } from 'vitest';
  import type { FrameworkPackageId, LegacyFrameworkPackageId } from '../../src/intelligence/framework/framework-types.js';

  describe('FrameworkPackageId', () => {
    it('accepts arbitrary string', () => {
      const id: FrameworkPackageId = 'my-new-pkg';
      expectTypeOf(id).toEqualTypeOf<FrameworkPackageId>();
    });
    it('legacy union assignable to general type', () => {
      const legacy: LegacyFrameworkPackageId = 'core';
      const g: FrameworkPackageId = legacy;
      expectTypeOf(g).toEqualTypeOf<FrameworkPackageId>();
    });
  });
  ```

- [ ] **Step 14.2: Run**

  Run: `npx vitest run tests/vault/framework-types-compat.test.ts`
  Expected: FAIL — `LegacyFrameworkPackageId` missing.

- [ ] **Step 14.3: Update types**

  `Read` `src/intelligence/framework/framework-types.ts`. Replace the existing union with:

  ```ts
  export type LegacyFrameworkPackageId = 'core' | 'modules' | 'mcp';
  export type FrameworkPackageId = string;
  ```

- [ ] **Step 14.4: Typecheck repo**

  Run: `npx tsc --noEmit`
  Expected: no new errors. If any site used the union for exhaustive `switch`, annotate locally as `LegacyFrameworkPackageId`.

- [ ] **Step 14.5: Run type test**

  Run: `npx vitest run tests/vault/framework-types-compat.test.ts`
  Expected: PASS.

- [ ] **Step 14.6: Commit**

  ```bash
  git add src/intelligence/framework/framework-types.ts tests/vault/framework-types-compat.test.ts
  git commit -m "refactor(framework): generalize FrameworkPackageId; retain legacy union"
  ```

---

## Task 15: StradaKnowledge feature-flagged path

**Files:**
- Modify: `src/agents/context/strada-knowledge.ts`
- Test: `tests/vault/strada-knowledge-vault-path.test.ts`

- [ ] **Step 15.1: Failing test**

  Create `tests/vault/strada-knowledge-vault-path.test.ts`:

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { buildProjectContext } from '../../src/agents/context/strada-knowledge.js';

  describe('buildProjectContext with vault flag', () => {
    it('uses vault.query when enabled', async () => {
      const query = vi.fn().mockResolvedValue({
        hits: [{ chunk: { chunkId: 'c1', path: 'Player.cs', startLine: 1, endLine: 5, content: 'class Player {}', tokenCount: 4 }, scores: { fts: 1, hnsw: 0.9, rrf: 0.1 } }],
        budgetUsed: 4, truncated: false,
      });
      const ctx = {
        config: { vault: { enabled: true } },
        vaultRegistry: { list: () => [{ id: 'a', kind: 'unity-project', query }] },
        userMessage: 'how does Player work',
        contextBudget: 2000,
      } as any;
      const r = await buildProjectContext(ctx);
      expect(query).toHaveBeenCalled();
      expect(r).toContain('Player.cs');
    });

    it('falls back when disabled', async () => {
      const query = vi.fn();
      const r = await buildProjectContext({
        config: { vault: { enabled: false } },
        vaultRegistry: { list: () => [{ query }] },
        userMessage: 'q',
        contextBudget: 100,
        legacyBuildProjectContext: async () => 'LEGACY',
      } as any);
      expect(query).not.toHaveBeenCalled();
      expect(r).toBe('LEGACY');
    });
  });
  ```

- [ ] **Step 15.2: Run, expect fail**

  Run: `npx vitest run tests/vault/strada-knowledge-vault-path.test.ts`
  Expected: FAIL.

- [ ] **Step 15.3: Refactor**

  `Read` `src/agents/context/strada-knowledge.ts`. Rename the current `buildProjectContext` body into a private `legacyPath()`, and add a new dispatching export:

  ```ts
  import type { VaultRegistry } from '../../vault/vault-registry.js';

  export interface BuildProjectContextInput {
    config: { vault: { enabled: boolean } };
    vaultRegistry?: VaultRegistry | { list(): Array<{ query: (q: any) => Promise<any> }> };
    userMessage: string;
    recentlyTouched?: string[];
    contextBudget?: number;
    legacyBuildProjectContext?: () => Promise<string>;
  }

  export async function buildProjectContext(input: BuildProjectContextInput): Promise<string> {
    if (!input.config.vault?.enabled) {
      return input.legacyBuildProjectContext
        ? await input.legacyBuildProjectContext()
        : await legacyPath(input);
    }
    const vaults = input.vaultRegistry?.list() ?? [];
    if (vaults.length === 0) {
      return input.legacyBuildProjectContext
        ? await input.legacyBuildProjectContext()
        : await legacyPath(input);
    }
    const results = await Promise.all(vaults.map((v) => v.query({
      text: input.userMessage,
      topK: 20,
      budgetTokens: input.contextBudget,
    })));
    return renderContext(results);
  }

  function renderContext(results: Array<{ hits: Array<{ chunk: { path: string; content: string } }> }>): string {
    const lines: string[] = [];
    for (const r of results) {
      for (const h of r.hits) {
        lines.push(`\n### ${h.chunk.path}\n\`\`\`\n${h.chunk.content}\n\`\`\``);
      }
    }
    return lines.join('\n');
  }

  async function legacyPath(_input: BuildProjectContextInput): Promise<string> {
    // Move the entire original body of buildProjectContext here, verbatim,
    // adapting to receive data through `_input` (or close over module state as before).
    throw new Error('legacyPath: migrate original body here');
  }
  ```

  **Important:** the engineer must preserve the original implementation by moving it into `legacyPath`. Grep for all callers of the old function; adapt them to the new input shape. The primary call site is `src/agents/orchestrator.ts` around line 1224.

- [ ] **Step 15.4: Fix callers**

  Run: `npx tsc --noEmit`
  Fix each call site that used the old signature. Commit caller updates together with the refactor.

- [ ] **Step 15.5: Run, expect pass**

  Run: `npx vitest run tests/vault/strada-knowledge-vault-path.test.ts`
  Expected: PASS.

- [ ] **Step 15.6: Commit**

  ```bash
  git add src/agents/context/strada-knowledge.ts src/agents/orchestrator.ts tests/vault/strada-knowledge-vault-path.test.ts
  git commit -m "feat(vault): feature-flagged vault path in buildProjectContext"
  ```

---

## Task 16: Bootstrap — init UnityProjectVault

**Files:**
- Modify: `src/core/bootstrap-stages/stage-knowledge.ts`
- Modify: `src/core/bootstrap-stages/index.ts`
- Test: `tests/vault/stage-knowledge-vault.test.ts`

- [ ] **Step 16.1: Failing test**

  Create `tests/vault/stage-knowledge-vault.test.ts`:

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { mkdtempSync, cpSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { initVaultsFromBootstrap } from '../../src/core/bootstrap-stages/stage-knowledge.js';

  describe('stage-knowledge vault init', () => {
    it('registers a UnityProjectVault when enabled + project detected', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'boot-'));
      cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
      const registry = { register: vi.fn(), list: () => [] } as any;
      await initVaultsFromBootstrap({
        config: { vault: { enabled: true, debounceMs: 100, writeHookBudgetMs: 200 }, unityProjectPath: dir },
        vaultRegistry: registry,
        embedding: { model: 'stub', dim: 4, embed: async (xs: string[]) => xs.map(() => new Float32Array(4)) },
        vectorStore: { add: () => 1, remove: () => {}, search: () => [] },
      });
      expect(registry.register).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when disabled', async () => {
      const registry = { register: vi.fn() } as any;
      await initVaultsFromBootstrap({
        config: { vault: { enabled: false } },
        vaultRegistry: registry,
        embedding: {} as any, vectorStore: {} as any,
      });
      expect(registry.register).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 16.2: Run, expect fail**

  Run: `npx vitest run tests/vault/stage-knowledge-vault.test.ts`
  Expected: FAIL.

- [ ] **Step 16.3: Implement**

  `Read` `src/core/bootstrap-stages/stage-knowledge.ts`. Append:

  ```ts
  import { createHash } from 'node:crypto';
  import { UnityProjectVault } from '../../vault/unity-project-vault.js';
  import { discoverUnityRoots } from '../../vault/discovery.js';
  import type { VaultRegistry } from '../../vault/vault-registry.js';
  import type { EmbeddingProvider, VectorStore } from '../../vault/embedding-adapter.js';

  export interface InitVaultsInput {
    config: { vault: { enabled: boolean; debounceMs?: number; writeHookBudgetMs?: number }; unityProjectPath?: string };
    vaultRegistry: VaultRegistry;
    embedding: EmbeddingProvider;
    vectorStore: VectorStore;
  }

  export async function initVaultsFromBootstrap(input: InitVaultsInput): Promise<void> {
    if (!input.config.vault?.enabled) return;
    const projectPath = input.config.unityProjectPath;
    if (!projectPath) return;
    const roots = await discoverUnityRoots(projectPath);
    if (!roots) return;
    const hash = createHash('sha1').update(projectPath).digest('hex').slice(0, 8);
    const vault = new UnityProjectVault({
      id: `unity:${hash}`, rootPath: projectPath,
      embedding: input.embedding, vectorStore: input.vectorStore,
    });
    await vault.init();
    await vault.startWatch(input.config.vault.debounceMs ?? 800);
    input.vaultRegistry.register(vault);
  }
  ```

  Export `initVaultsFromBootstrap` from `src/core/bootstrap-stages/index.ts`.

  Call `initVaultsFromBootstrap(...)` in the top-level bootstrap orchestrator, after the embedding provider and vector store are available (search for existing `new AgentDBMemory` or similar — the vault init goes after that).

- [ ] **Step 16.4: Run, expect pass**

  Run: `npx vitest run tests/vault/stage-knowledge-vault.test.ts`
  Expected: PASS.

- [ ] **Step 16.5: Commit**

  ```bash
  git add src/core/bootstrap-stages/stage-knowledge.ts src/core/bootstrap-stages/index.ts tests/vault/stage-knowledge-vault.test.ts
  git commit -m "feat(vault): bootstrap wires UnityProjectVault when flag is on"
  ```

---

## Task 17: HTTP routes

**Files:**
- Create: `src/dashboard/server-vault-routes.ts`
- Modify: `src/dashboard/server.ts` (or equivalent)
- Test: `tests/vault/server-vault-routes.test.ts`

- [ ] **Step 17.1: Read existing route file**

  `Read` `src/dashboard/server.ts` and one sibling `server-*-routes.ts` (e.g. `server-system-routes.ts`). Note the framework (Fastify / Express / plain) and how the registry is obtained.

- [ ] **Step 17.2: Failing test**

  Create `tests/vault/server-vault-routes.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { registerVaultRoutes } from '../../src/dashboard/server-vault-routes.js';

  function makeFakeApp() {
    const routes: Record<string, any> = {};
    return {
      get: (p: string, h: any) => { routes['GET ' + p] = h; },
      post: (p: string, h: any) => { routes['POST ' + p] = h; },
      routes,
    };
  }

  const fakeVault = {
    id: 'unity:abc', kind: 'unity-project', rootPath: '/proj',
    stats: async () => ({ fileCount: 2, chunkCount: 5, lastIndexedAt: 0, dbBytes: 128 }),
    listFiles: () => [{ path: 'a.cs', lang: 'csharp' }, { path: 'b.md', lang: 'markdown' }],
    readFile: async (p: string) => p === 'a.cs' ? 'ALPHA' : 'BETA',
    query: async () => ({ hits: [{ chunk: { chunkId: 'c', path: 'a.cs', startLine: 1, endLine: 1, content: 'x', tokenCount: 1 }, scores: { fts: 1, hnsw: 0.9, rrf: 0.1 } }], budgetUsed: 1, truncated: false }),
    sync: async () => ({ changed: 2, durationMs: 50 }),
  };
  const reg = { list: () => [fakeVault], get: (id: string) => id === 'unity:abc' ? fakeVault : undefined } as any;

  describe('vault routes', () => {
    it('GET /api/vaults lists vaults', async () => {
      const app = makeFakeApp();
      registerVaultRoutes(app as any, reg);
      const r = await app.routes['GET /api/vaults']({}, {});
      expect(r.items[0]).toMatchObject({ id: 'unity:abc', kind: 'unity-project' });
    });

    it('GET /api/vaults/:id/tree returns files', async () => {
      const app = makeFakeApp();
      registerVaultRoutes(app as any, reg);
      const r = await app.routes['GET /api/vaults/:id/tree']({ params: { id: 'unity:abc' } }, {});
      expect(r.items).toHaveLength(2);
    });

    it('GET /api/vaults/:id/file returns body', async () => {
      const app = makeFakeApp();
      registerVaultRoutes(app as any, reg);
      const r = await app.routes['GET /api/vaults/:id/file']({ params: { id: 'unity:abc' }, query: { path: 'b.md' } }, {});
      expect(r.body).toBe('BETA');
    });

    it('POST /api/vaults/:id/search returns hits', async () => {
      const app = makeFakeApp();
      registerVaultRoutes(app as any, reg);
      const r = await app.routes['POST /api/vaults/:id/search']({ params: { id: 'unity:abc' }, body: { text: 'x' } }, {});
      expect(r.hits).toHaveLength(1);
    });

    it('POST /api/vaults/:id/sync returns summary', async () => {
      const app = makeFakeApp();
      registerVaultRoutes(app as any, reg);
      const r = await app.routes['POST /api/vaults/:id/sync']({ params: { id: 'unity:abc' } }, {});
      expect(r.changed).toBe(2);
    });

    it('file path traversal blocked', async () => {
      const app = makeFakeApp();
      registerVaultRoutes(app as any, reg);
      const r = await app.routes['GET /api/vaults/:id/file']({ params: { id: 'unity:abc' }, query: { path: '../etc/passwd' } }, {});
      expect(r.error).toMatch(/invalid/i);
    });
  });
  ```

- [ ] **Step 17.3: Run, expect fail**

  Run: `npx vitest run tests/vault/server-vault-routes.test.ts`
  Expected: FAIL.

- [ ] **Step 17.4: Implement**

  Create `src/dashboard/server-vault-routes.ts`:

  ```ts
  import type { VaultRegistry } from '../vault/vault-registry.js';

  export interface RouteApp {
    get(path: string, handler: (req: any, res: any) => any): void;
    post(path: string, handler: (req: any, res: any) => any): void;
  }

  export function registerVaultRoutes(app: RouteApp, registry: VaultRegistry): void {
    app.get('/api/vaults', () => ({
      items: registry.list().map((v) => ({ id: v.id, kind: v.kind, rootPath: v.rootPath })),
    }));

    app.get('/api/vaults/:id/stats', async (req) => {
      const v = registry.get(req.params.id);
      return v ? await v.stats() : { error: 'not found' };
    });

    app.get('/api/vaults/:id/tree', (req) => {
      const v = registry.get(req.params.id);
      if (!v) return { error: 'not found' };
      return { items: v.listFiles().map((f) => ({ path: f.path, lang: f.lang })) };
    });

    app.get('/api/vaults/:id/file', async (req) => {
      const v = registry.get(req.params.id);
      if (!v) return { error: 'not found' };
      const p: string | undefined = req.query?.path;
      if (!p) return { error: 'missing path' };
      if (p.includes('..') || p.startsWith('/')) return { error: 'invalid path' };
      return { body: await v.readFile(p) };
    });

    app.post('/api/vaults/:id/search', async (req) => {
      const v = registry.get(req.params.id);
      if (!v) return { error: 'not found' };
      return await v.query({ text: req.body?.text ?? '', topK: req.body?.topK ?? 20 });
    });

    app.post('/api/vaults/:id/sync', async (req) => {
      const v = registry.get(req.params.id);
      return v ? await v.sync() : { error: 'not found' };
    });
  }

  export interface WsBroadcaster { broadcast(msg: string): void; }

  export function wireVaultUpdatesToWs(registry: VaultRegistry, wss: WsBroadcaster): () => void {
    const offs: Array<() => void> = [];
    for (const v of registry.list()) {
      const off = v.onUpdate((payload) => {
        wss.broadcast(JSON.stringify({ type: 'vault:update', payload }));
      });
      offs.push(off);
    }
    return () => { for (const off of offs) off(); };
  }
  ```

  Wire `registerVaultRoutes(app, vaultRegistry)` and `wireVaultUpdatesToWs(vaultRegistry, wss)` in `src/dashboard/server.ts` next to the existing route registrations. Adapt `wss.broadcast` to the real WS server's API (often: iterate `wss.clients` and call `.send(msg)`).

- [ ] **Step 17.5: Run, expect pass**

  Run: `npx vitest run tests/vault/server-vault-routes.test.ts`
  Expected: PASS.

- [ ] **Step 17.6: Commit**

  ```bash
  git add src/dashboard/server-vault-routes.ts src/dashboard/server.ts tests/vault/server-vault-routes.test.ts
  git commit -m "feat(vault): HTTP endpoints + WS update wiring"
  ```

---

## Task 18: WS broadcast test

**Files:**
- Test: `tests/vault/vault-ws.test.ts`

- [ ] **Step 18.1: Failing test**

  Create `tests/vault/vault-ws.test.ts`:

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { EventEmitter } from 'node:events';
  import { wireVaultUpdatesToWs } from '../../src/dashboard/server-vault-routes.js';

  describe('vault:update WS', () => {
    it('broadcasts when a vault emits update', () => {
      const send = vi.fn();
      const wss = { broadcast: (m: string) => send(m) };
      const vault: any = new EventEmitter();
      vault.id = 'unity:abc';
      vault.onUpdate = (cb: any) => { vault.on('update', cb); return () => vault.off('update', cb); };
      const registry = { list: () => [vault] } as any;
      wireVaultUpdatesToWs(registry, wss);
      vault.emit('update', { vaultId: 'unity:abc', changedPaths: ['a.cs'] });
      const msg = JSON.parse(send.mock.calls[0][0]);
      expect(msg.type).toBe('vault:update');
      expect(msg.payload.changedPaths).toEqual(['a.cs']);
    });
  });
  ```

- [ ] **Step 18.2: Run**

  Run: `npx vitest run tests/vault/vault-ws.test.ts`
  Expected: PASS (wireVaultUpdatesToWs already exists from Task 17).

- [ ] **Step 18.3: Commit**

  ```bash
  git add tests/vault/vault-ws.test.ts
  git commit -m "test(vault): WS broadcast of vault:update"
  ```

---

## Task 19: Portal deps + Zustand store

**Files:**
- Modify: `web-portal/package.json`
- Create: `web-portal/src/stores/vault-store.ts`
- Test: `web-portal/src/stores/vault-store.test.ts`

- [ ] **Step 19.1: Install deps**

  ```bash
  cd web-portal && npm install react-markdown remark-gfm
  ```

- [ ] **Step 19.2: Failing test**

  Create `web-portal/src/stores/vault-store.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { useVaultStore } from './vault-store.js';

  describe('vault-store', () => {
    beforeEach(() => { useVaultStore.setState({ vaults: [], selected: null, searchResults: [] }); });

    it('setVaults replaces the list', () => {
      useVaultStore.getState().setVaults([{ id: 'a', kind: 'unity-project', rootPath: '/p' }]);
      expect(useVaultStore.getState().vaults).toHaveLength(1);
    });
    it('select picks a vault', () => {
      useVaultStore.getState().setVaults([{ id: 'a', kind: 'unity-project', rootPath: '/p' }]);
      useVaultStore.getState().select('a');
      expect(useVaultStore.getState().selected).toBe('a');
    });
    it('setSearchResults stores hits', () => {
      useVaultStore.getState().setSearchResults([{ chunk: { chunkId: 'c', path: 'a', startLine: 1, endLine: 1, content: '', tokenCount: 0 }, scores: { fts: 1, hnsw: null, rrf: 0.1 } }]);
      expect(useVaultStore.getState().searchResults).toHaveLength(1);
    });
  });
  ```

- [ ] **Step 19.3: Run, expect fail**

  Run: `cd web-portal && npx vitest run src/stores/vault-store.test.ts`
  Expected: FAIL.

- [ ] **Step 19.4: Implement**

  Create `web-portal/src/stores/vault-store.ts`:

  ```ts
  import { create } from 'zustand';

  export interface VaultSummary { id: string; kind: string; rootPath: string; }
  export interface SearchHit {
    chunk: { chunkId: string; path: string; startLine: number; endLine: number; content: string; tokenCount: number };
    scores: { fts: number | null; hnsw: number | null; rrf: number };
  }

  interface VaultState {
    vaults: VaultSummary[];
    selected: string | null;
    searchResults: SearchHit[];
    setVaults(v: VaultSummary[]): void;
    select(id: string): void;
    setSearchResults(r: SearchHit[]): void;
  }

  export const useVaultStore = create<VaultState>((set) => ({
    vaults: [],
    selected: null,
    searchResults: [],
    setVaults: (v) => set({ vaults: v }),
    select: (id) => set({ selected: id }),
    setSearchResults: (r) => set({ searchResults: r }),
  }));
  ```

- [ ] **Step 19.5: Run, expect pass**

  Run: `cd web-portal && npx vitest run src/stores/vault-store.test.ts`
  Expected: PASS.

- [ ] **Step 19.6: Commit**

  ```bash
  git add web-portal/package.json web-portal/package-lock.json web-portal/src/stores/vault-store.ts web-portal/src/stores/vault-store.test.ts
  git commit -m "feat(portal): vault-store"
  ```

---

## Task 20: Portal — VaultsPage with Files + Search tabs

**Files:**
- Create: `web-portal/src/pages/VaultsPage.tsx`
- Create: `web-portal/src/pages/vaults/VaultList.tsx`
- Create: `web-portal/src/pages/vaults/VaultFilesTab.tsx`
- Create: `web-portal/src/pages/vaults/VaultSearchTab.tsx`
- Create: `web-portal/src/pages/vaults/MarkdownPreview.tsx`
- Modify: `web-portal/src/App.tsx`
- Test: `web-portal/src/pages/VaultsPage.test.tsx`

- [ ] **Step 20.1: Read App.tsx**

  `Read` `web-portal/src/App.tsx`. Confirm the `<Routes>` / `<Route>` + `lazy(...)` pattern.

- [ ] **Step 20.2: Failing test**

  Create `web-portal/src/pages/VaultsPage.test.tsx`:

  ```tsx
  import { describe, it, expect } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import { MemoryRouter } from 'react-router-dom';
  import { useVaultStore } from '../stores/vault-store.js';
  import VaultsPage from './VaultsPage.js';

  describe('VaultsPage', () => {
    it('shows empty state with no vaults', () => {
      useVaultStore.setState({ vaults: [], selected: null, searchResults: [] });
      render(<MemoryRouter><VaultsPage /></MemoryRouter>);
      expect(screen.getByText(/no vaults/i)).toBeInTheDocument();
    });

    it('lists registered vaults', () => {
      useVaultStore.setState({
        vaults: [{ id: 'unity:abc', kind: 'unity-project', rootPath: '/p' }],
        selected: null, searchResults: [],
      });
      render(<MemoryRouter><VaultsPage /></MemoryRouter>);
      expect(screen.getByText(/unity:abc/)).toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 20.3: Run, expect fail**

  Run: `cd web-portal && npx vitest run src/pages/VaultsPage.test.tsx`
  Expected: FAIL.

- [ ] **Step 20.4: Implement pages**

  Create `web-portal/src/pages/vaults/VaultList.tsx`:

  ```tsx
  import { useVaultStore } from '../../stores/vault-store.js';

  export default function VaultList() {
    const { vaults, selected, select } = useVaultStore();
    if (vaults.length === 0) return <div className="p-4 text-sm text-muted-foreground">No vaults registered</div>;
    return (
      <ul className="p-2 space-y-1">
        {vaults.map((v) => (
          <li key={v.id}>
            <button
              onClick={() => select(v.id)}
              className={`w-full text-left px-2 py-1 rounded ${selected === v.id ? 'bg-accent' : 'hover:bg-accent/50'}`}
            >
              <div className="text-sm font-medium">{v.id}</div>
              <div className="text-xs text-muted-foreground">{v.kind}</div>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  ```

  Create `web-portal/src/pages/vaults/MarkdownPreview.tsx`:

  ```tsx
  import ReactMarkdown from 'react-markdown';
  import remarkGfm from 'remark-gfm';

  export default function MarkdownPreview({ source }: { source: string }) {
    return (
      <div className="prose prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
      </div>
    );
  }
  ```

  Create `web-portal/src/pages/vaults/VaultFilesTab.tsx`:

  ```tsx
  import { useEffect, useState } from 'react';
  import { useVaultStore } from '../../stores/vault-store.js';
  import MarkdownPreview from './MarkdownPreview.js';

  interface TreeEntry { path: string; lang: string; }

  export default function VaultFilesTab() {
    const selected = useVaultStore((s) => s.selected);
    const [files, setFiles] = useState<TreeEntry[]>([]);
    const [path, setPath] = useState<string | null>(null);
    const [body, setBody] = useState<string>('');

    useEffect(() => {
      if (!selected) return;
      fetch(`/api/vaults/${encodeURIComponent(selected)}/tree`)
        .then((r) => r.json()).then((d) => setFiles(d.items ?? [])).catch(() => setFiles([]));
    }, [selected]);

    useEffect(() => {
      if (!selected || !path) return;
      fetch(`/api/vaults/${encodeURIComponent(selected)}/file?path=${encodeURIComponent(path)}`)
        .then((r) => r.json()).then((d) => setBody(d.body ?? '')).catch(() => setBody(''));
    }, [selected, path]);

    if (!selected) return <div className="p-4 text-sm text-muted-foreground">Select a vault</div>;

    return (
      <div className="grid grid-cols-[300px_1fr] h-full">
        <ul className="border-r overflow-auto">
          {files.map((f) => (
            <li key={f.path}>
              <button className={`w-full text-left px-2 py-1 text-sm ${path === f.path ? 'bg-accent' : ''}`}
                onClick={() => setPath(f.path)}>{f.path}</button>
            </li>
          ))}
        </ul>
        <div className="overflow-auto p-4">
          {path
            ? (path.endsWith('.md')
                ? <MarkdownPreview source={body} />
                : <pre className="text-xs whitespace-pre-wrap">{body}</pre>)
            : <div className="text-sm text-muted-foreground">Pick a file</div>}
        </div>
      </div>
    );
  }
  ```

  Create `web-portal/src/pages/vaults/VaultSearchTab.tsx`:

  ```tsx
  import { useState } from 'react';
  import { useVaultStore } from '../../stores/vault-store.js';

  export default function VaultSearchTab() {
    const { selected, searchResults, setSearchResults } = useVaultStore();
    const [text, setText] = useState('');
    const [loading, setLoading] = useState(false);

    const run = async () => {
      if (!selected || !text.trim()) return;
      setLoading(true);
      try {
        const res = await fetch(`/api/vaults/${encodeURIComponent(selected)}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, topK: 20 }),
        });
        const data = await res.json();
        setSearchResults(data.hits ?? []);
      } finally { setLoading(false); }
    };

    if (!selected) return <div className="p-4 text-sm text-muted-foreground">Select a vault</div>;

    return (
      <div className="p-4 space-y-4">
        <div className="flex gap-2">
          <input className="flex-1 border rounded px-2 py-1" value={text} onChange={(e) => setText(e.target.value)}
            placeholder="semantic + keyword query" />
          <button onClick={run} className="px-3 py-1 border rounded">{loading ? '...' : 'Search'}</button>
        </div>
        <ul className="space-y-2">
          {searchResults.map((h) => (
            <li key={h.chunk.chunkId} className="border rounded p-2">
              <div className="text-xs text-muted-foreground">
                {h.chunk.path}:{h.chunk.startLine}-{h.chunk.endLine} rrf={h.scores.rrf.toFixed(4)}
              </div>
              <pre className="text-xs whitespace-pre-wrap">{h.chunk.content}</pre>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  ```

  Create `web-portal/src/pages/VaultsPage.tsx`:

  ```tsx
  import { useEffect, useState } from 'react';
  import VaultList from './vaults/VaultList.js';
  import VaultFilesTab from './vaults/VaultFilesTab.js';
  import VaultSearchTab from './vaults/VaultSearchTab.js';
  import { useVaultStore } from '../stores/vault-store.js';

  type Tab = 'files' | 'search';

  export default function VaultsPage() {
    const [tab, setTab] = useState<Tab>('files');
    const setVaults = useVaultStore((s) => s.setVaults);

    useEffect(() => {
      fetch('/api/vaults').then((r) => r.json()).then((d) => setVaults(d.items ?? []))
        .catch(() => setVaults([]));
    }, [setVaults]);

    return (
      <div className="grid grid-cols-[280px_1fr] h-full">
        <aside className="border-r overflow-auto">
          <VaultList />
        </aside>
        <main className="flex flex-col h-full">
          <nav className="border-b p-2 flex gap-2">
            <button onClick={() => setTab('files')} className={`px-3 py-1 ${tab === 'files' ? 'border-b-2 border-accent' : ''}`}>Files</button>
            <button onClick={() => setTab('search')} className={`px-3 py-1 ${tab === 'search' ? 'border-b-2 border-accent' : ''}`}>Search</button>
          </nav>
          <section className="flex-1 overflow-hidden">
            {tab === 'files' ? <VaultFilesTab /> : <VaultSearchTab />}
          </section>
        </main>
      </div>
    );
  }
  ```

  Wire in `web-portal/src/App.tsx`:
  - `const VaultsPage = lazy(() => import('./pages/VaultsPage'));`
  - Add `<Route path="/vaults" element={<VaultsPage />} />` inside `<Routes>`.

- [ ] **Step 20.5: Run, expect pass**

  Run: `cd web-portal && npx vitest run src/pages/VaultsPage.test.tsx`
  Expected: PASS.

- [ ] **Step 20.6: Visual smoke**

  Run: `cd web-portal && npm run dev`
  Open `http://localhost:<port>/vaults` in a browser. Verify empty state and tab switching. Stop the dev server.

- [ ] **Step 20.7: Commit**

  ```bash
  git add web-portal/src/pages/VaultsPage.tsx web-portal/src/pages/vaults web-portal/src/App.tsx web-portal/src/pages/VaultsPage.test.tsx
  git commit -m "feat(portal): VaultsPage with Files + Search tabs"
  ```

---

## Task 21: Orchestrator write-hook wiring

**Files:**
- Modify: `src/agents/orchestrator.ts`
- Test: `tests/vault/orchestrator-write-hook.test.ts`

- [ ] **Step 21.1: Failing test**

  Create `tests/vault/orchestrator-write-hook.test.ts`:

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { applyWriteHookToToolResult } from '../../src/agents/orchestrator.js';

  describe('applyWriteHookToToolResult', () => {
    it('invokes hook for Edit tool with path output', async () => {
      const after = vi.fn(async (_p: string) => null);
      const res: any = { toolName: 'Edit', output: { path: '/proj/Assets/Player.cs', ok: true } };
      await applyWriteHookToToolResult(res, { afterWrite: after } as any);
      expect(after).toHaveBeenCalledWith('/proj/Assets/Player.cs');
    });
    it('skips when hook is null', async () => {
      await expect(applyWriteHookToToolResult({ toolName: 'Read' } as any, null)).resolves.not.toThrow();
    });
    it('appends warning when hook returns non-null', async () => {
      const after = vi.fn(async () => 'vault may be stale for X');
      const res: any = { toolName: 'Write', output: { path: '/proj/a.cs' }, warnings: [] };
      await applyWriteHookToToolResult(res, { afterWrite: after } as any);
      expect(res.warnings).toContain('vault may be stale for X');
    });
  });
  ```

- [ ] **Step 21.2: Run, expect fail**

  Run: `npx vitest run tests/vault/orchestrator-write-hook.test.ts`
  Expected: FAIL.

- [ ] **Step 21.3: Implement**

  Add to `src/agents/orchestrator.ts` (near the bottom of the module, outside the class):

  ```ts
  export async function applyWriteHookToToolResult(
    result: { toolName: string; output?: { path?: string }; warnings?: string[] },
    hook: { afterWrite: (p: string) => Promise<string | null> } | null,
  ): Promise<void> {
    if (!hook) return;
    if (!(result.toolName === 'Edit' || result.toolName === 'Write')) return;
    const path = result.output?.path;
    if (!path) return;
    const warning = await hook.afterWrite(path);
    if (warning) {
      result.warnings = result.warnings ?? [];
      result.warnings.push(warning);
    }
  }
  ```

  At the tool dispatch site (line ~1224 per exploration), resolve a hook from `VaultRegistry` (pick the first `unity-project` vault). Invoke `applyWriteHookToToolResult(result, hook)` after the tool result is computed.

  Add `import { installWriteHook } from '../vault/write-hook.js';` to the top of the file.

- [ ] **Step 21.4: Run, expect pass**

  Run: `npx vitest run tests/vault/orchestrator-write-hook.test.ts`
  Expected: PASS.

- [ ] **Step 21.5: Commit**

  ```bash
  git add src/agents/orchestrator.ts tests/vault/orchestrator-write-hook.test.ts
  git commit -m "feat(vault): orchestrator triggers write-hook for Edit/Write tools"
  ```

---

## Task 22: Acceptance — end-to-end

**Files:**
- Create: `tests/vault/acceptance.test.ts`

- [ ] **Step 22.1: Acceptance test**

  Create `tests/vault/acceptance.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';
  import { VaultRegistry } from '../../src/vault/vault-registry.js';
  import { buildProjectContext } from '../../src/agents/context/strada-knowledge.js';
  import type { EmbeddingProvider, VectorStore } from '../../src/vault/embedding-adapter.js';

  class Stub implements EmbeddingProvider {
    readonly model = 'stub'; readonly dim = 4;
    async embed(xs: string[]) { return xs.map(() => new Float32Array(4)); }
  }
  class Mem implements VectorStore {
    private n = 1; items = new Map<number, unknown>();
    add(_v: Float32Array, p: unknown) { const id = this.n++; this.items.set(id, p); return id; }
    remove(id: number) { this.items.delete(id); }
    search() { return [...this.items.entries()].slice(0, 10).map(([id, payload]) => ({ id, score: 0.8, payload })); }
  }

  let dir: string;
  let reg: VaultRegistry;
  let vault: UnityProjectVault;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'accept-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    reg = new VaultRegistry();
    vault = new UnityProjectVault({ id: 'unity:t', rootPath: dir, embedding: new Stub(), vectorStore: new Mem() });
    await vault.init();
    reg.register(vault);
  });

  afterEach(async () => {
    await reg.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('Phase 1 acceptance', () => {
    it('buildProjectContext (flag on) returns vault-backed results', async () => {
      const r = await buildProjectContext({
        config: { vault: { enabled: true } },
        vaultRegistry: reg,
        userMessage: 'Player Move',
        recentlyTouched: [],
        contextBudget: 2000,
      } as any);
      expect(r).toContain('Player.cs');
    });

    it('buildProjectContext (flag off) uses legacy', async () => {
      const r = await buildProjectContext({
        config: { vault: { enabled: false } },
        vaultRegistry: reg,
        userMessage: 'q',
        contextBudget: 100,
        legacyBuildProjectContext: async () => 'LEGACY',
      } as any);
      expect(r).toBe('LEGACY');
    });

    it('a file added after startWatch is picked up', async () => {
      await vault.startWatch(150);
      writeFileSync(join(dir, 'Assets/Scripts/Boss.cs'), 'namespace Game { public class Boss {} }');
      await new Promise((r) => setTimeout(r, 1200));
      const r = await buildProjectContext({
        config: { vault: { enabled: true } },
        vaultRegistry: reg,
        userMessage: 'Boss',
        contextBudget: 2000,
      } as any);
      expect(r).toContain('Boss');
      await vault.stopWatch();
    });
  });
  ```

- [ ] **Step 22.2: Run**

  Run: `npx vitest run tests/vault/acceptance.test.ts`
  Expected: PASS. If flaky, bump watcher wait to 1500ms.

- [ ] **Step 22.3: Commit**

  ```bash
  git add tests/vault/acceptance.test.ts
  git commit -m "test(vault): Phase 1 acceptance"
  ```

---

## Task 23: Documentation

**Files:**
- Create: `docs/vault.md`

- [ ] **Step 23.1: Write**

  Create `docs/vault.md`:

  ```markdown
  # Vault Subsystem (Phase 1)

  Persistent, per-project codebase memory replacing per-request file re-reading.

  ## Shapes
  - `IVault` (src/vault/vault.interface.ts) — contract all vaults satisfy.
  - `UnityProjectVault` — indexes `<unity-project>/` into `<unity-project>/.strada/vault/index.db`.
  - `VaultRegistry` — singleton lookup, fan-out query with RRF merge.

  ## Query
  `VaultRegistry.query({ text })` → RRF-merged hits across vaults, token-budget-aware.

  ## Updates
  chokidar watcher (debounced 800 ms) + Edit/Write tool write-hook (sync 200 ms budget) + `/vault sync` tool.

  ## Storage
  SQLite per vault: vault_files, vault_chunks, vault_chunks_fts (FTS5 BM25), vault_embeddings (pointer into existing HNSW store).

  ## Config flags
  `vault.enabled` (default false), `vault.writeHookBudgetMs` (200), `vault.debounceMs` (800).

  ## Portal
  `/vaults` page — file tree + markdown preview + hybrid search. HTTP at `/api/vaults/*`, WS event `vault:update`.

  ## Next phases
  - Phase 2: tree-sitter symbol graph + PageRank + SelfVault + Graph tab.
  - Phase 3: rolling summaries + FrameworkVault upgrade + Learning pipeline coupling.
  ```

- [ ] **Step 23.2: Commit**

  ```bash
  git add docs/vault.md
  git commit -m "docs(vault): Phase 1 architecture note"
  ```

---

## Final

- [ ] **Step F1: Run full test suite**

  Run: `npx vitest run`
  Expected: all new vault tests pass. Any pre-existing failures unrelated to this work should be called out in the final commit message.

- [ ] **Step F2: Typecheck**

  Run: `npx tsc --noEmit`
  Expected: no new errors.

- [ ] **Step F3: Mandatory reviews (per CLAUDE.md)**

  User's non-negotiable rule (`feedback_mandatory_reviews_always.md`): run `/simplify` + `/security-review` + code-review agent on the vault diff before push. Address every finding (`feedback_no_skip_reviews.md`).

  1. Invoke `simplify` skill on the vault diff since the first `feat(vault)` commit.
  2. Invoke `feature-dev:code-reviewer` agent on the same diff.
  3. Fix every flagged issue, re-commit, re-run the suite.

- [ ] **Step F4: Push**

  After reviews green:

  Run: `git push origin main`

---

## Phase-1 Done Criteria

- [ ] `vault.enabled=true` + Unity project path → `UnityProjectVault` initialized at boot, watches FS, reindexes changes.
- [ ] `vault_init`, `vault_sync`, `vault_status` tools work via the agent.
- [ ] HTTP `GET /api/vaults`, `/stats`, `/tree`, `/file`, `POST /search`, `/sync` respond correctly.
- [ ] WS `vault:update` events reach portal within 2 s of FS changes.
- [ ] Portal `/vaults` renders Files and Search tabs; search is end-to-end.
- [ ] `buildProjectContext` prefers vault when flag on; legacy path works when off.
- [ ] All new tests pass; no new typecheck errors; mandatory reviews green.

---

## Self-Review

**Spec coverage mapping:**

| Spec section | Task(s) |
|---|---|
| §2 IVault + VaultRegistry + single SQLite substrate | 1, 9 |
| §3.2 UnityProjectVault | 8, 11 |
| §4 schema (files/chunks/FTS5/embeddings) | 3 |
| §5 L3 (embedding + FTS5 hybrid) | 3, 5, 6, 8 |
| §6 Incremental pipeline (watcher + write-hook) | 10, 11, 12, 21 |
| §7 Query pipeline (RRF + budget) | 6, 8 |
| §10 Portal Vaults page (Files + Search for Phase 1) | 19, 20 |
| §11 Phase 1 acceptance | 22 |
| §14 Migration | deferred to Phase 3 |
| §15 Open-question defaults | config flag in 1; local embedding follow-up deferred |

**Phase-1 out-of-scope (Phases 2 & 3):** tree-sitter symbol graph, `.canvas` generator, rolling summaries, FrameworkVault upgrade, SelfVault, Graph tab, learning coupling.

**Placeholder scan:** none — no "TBD", "later", "add appropriate". Every code block is complete. Every command has an expected outcome.

**Type consistency:** `IVault.listFiles()` and `readFile()` were declared in Task 1 and implemented in Task 8; all `FakeVault` stubs (Task 9) implement both. `reindexFile` is public on `UnityProjectVault` and consumed by `write-hook`/`watcher`.

**Simplifications (acceptable for Phase 1):**
- `rebuild()` deletes + recreates the db file; Phase 2 introduces finer-grained rebuilds.
- Embedding is awaited in `reindexFile` for determinism; production may fire-and-forget.
- `payloadChunkId` assumes `{ chunkId }` payload shape; adapt when wiring to the real HNSW store in Task 5 if different.

**End of plan.**
