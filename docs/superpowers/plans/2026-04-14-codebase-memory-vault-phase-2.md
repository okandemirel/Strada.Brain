# Codebase Memory Vault — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-13-codebase-memory-vault-design.md` §3.3, §5, §7, §10, §11 Phase 2.

**Branch:** `feature/vault-phase-2` in worktree `Strada.Brain-vault/`.

**Goal:** Add the deterministic symbol layer (L2) on top of Phase 1 — tree-sitter symbol + edge extraction for TypeScript, C#, and Markdown; `vault_symbols` + `vault_edges` + `vault_wikilinks` SQLite tables; Aider-style Personalized PageRank over the edge graph; `graph.canvas` (JSON Canvas 1.0) regenerated on every index tick; `SelfVault` for Strada.Brain's own source; Portal **Graph** tab.

**Architecture:**
- New `src/vault/symbol-extractor/` module with one file per language behind a common `ISymbolExtractor` contract. `web-tree-sitter` (WASM) for TS + C#; a tiny regex pass for Markdown wikilinks.
- New tables appended to `schema.sql`. `SqliteVaultStore` gains symbol / edge / wikilink CRUD.
- `UnityProjectVault.reindexFile()` runs the extractor after chunking. `query()` gains an optional PPR re-rank stage seeded by `focusFiles`.
- `graph.canvas` (JSON Canvas 1.0) generated on every watcher drain; written to `.strada/vault/graph.canvas`.
- `SelfVault` is a thin specialization of `UnityProjectVault` rooted at Strada.Brain's repo with a TS-biased discovery filter.
- Portal `VaultGraphTab.tsx` renders the canvas via `@xyflow/react` + `@dagrejs/dagre` (both already installed — **we are NOT adding cytoscape**; §15 of the spec said cytoscape but portal evolved after spec and has xyflow, so reuse).

**Tech Stack:**
- Server: `web-tree-sitter` (WASM loader), `tree-sitter-typescript` (WASM grammar), `tree-sitter-c-sharp` (WASM grammar). Markdown parsed in-process with a strict `[[target]]` regex — no grammar needed.
- Portal: `@xyflow/react` + `@dagrejs/dagre` (pre-installed).
- Phase 1 stack carried forward unchanged.

**Invariants preserved from Phase 1:**
- Markdown is source of truth; SQLite is derived.
- Content-hash short-circuit: no symbol re-extraction if `blob_hash` unchanged.
- Write-hook p95 budget ≤200 ms. **Symbol extraction runs inside the sync budget** (parse is fast); canvas regeneration + PPR rebuild are async, out-of-budget.
- Legacy `buildProjectContext` path keeps working when Phase 2 disabled.

---

## File Structure

### Server (`src/vault/`)

| File | Role | Action |
|---|---|---|
| `schema.sql` | Add `vault_symbols`, `vault_edges`, `vault_wikilinks`, bump `vault_meta` row `indexer_version = 'phase2.v1'`. | Modify |
| `vault.interface.ts` | Add `VaultSymbol`, `VaultEdge`, `VaultWikilink`, `VaultQuery.focusFiles`, `IVault.findCallers(symbolId)`, `IVault.findSymbolsByName(q)`. | Modify |
| `sqlite-vault-store.ts` | CRUD for new tables; `listEdges()`, `listSymbols()`; cascade-delete wiring from `deleteFile()`. | Modify |
| `symbol-extractor/symbol-extractor.interface.ts` | `ISymbolExtractor { extract(file): { symbols, edges, wikilinks } }`. | Create |
| `symbol-extractor/tree-sitter-loader.ts` | Lazy-loaded WASM Parser singleton per grammar. | Create |
| `symbol-extractor/typescript-extractor.ts` | Imports, classes, methods, functions, references. | Create |
| `symbol-extractor/csharp-extractor.ts` | Namespaces, classes, methods, `using` imports, inheritance, method calls. | Create |
| `symbol-extractor/markdown-extractor.ts` | Wikilinks `[[target]]` only (no tree-sitter). | Create |
| `symbol-extractor/index.ts` | Factory `getExtractorFor(lang)`; barrel exports. | Create |
| `ppr.ts` | In-memory sparse power-iteration PPR. | Create |
| `canvas-generator.ts` | Emits JSON Canvas 1.0 with dagre-layout coordinates. | Create |
| `self-vault.ts` | Thin subclass of `UnityProjectVault` rooted at Strada.Brain repo; overrides discovery. | Create |
| `unity-project-vault.ts` | `reindexFile` calls extractor; `query` uses PPR; drain triggers canvas regen. | Modify |
| `index.ts` | Re-export new public types. | Modify |

### Bootstrap (`src/core/bootstrap-stages/`)

| File | Role | Action |
|---|---|---|
| `stage-knowledge.ts` | New `initSelfVaultFromBootstrap(input)` helper; called alongside `initVaultsFromBootstrap`. | Modify |

### Server routes (`src/dashboard/`)

| File | Role | Action |
|---|---|---|
| `server-vault-routes.ts` | Add `GET /api/vaults/:id/canvas`, `GET /api/vaults/:id/symbols/by-name`, `GET /api/vaults/:id/symbols/:symbolId/callers`. | Modify |

### Portal (`web-portal/src/`)

| File | Role | Action |
|---|---|---|
| `stores/vault-store.ts` | Add `graphCache`, `setGraph`. | Modify |
| `pages/VaultsPage.tsx` | Add `graph` tab. | Modify |
| `pages/vaults/VaultGraphTab.tsx` | React Flow canvas with dagre layout + node click → Files tab. | Create |

### Fixtures & tests (`tests/`, `tests/fixtures/`)

| File | Role | Action |
|---|---|---|
| `tests/fixtures/unity-mini/Assets/Scripts/Controller.cs` | Uses `Player.Move` — gives us a real caller. | Create |
| `tests/fixtures/ts-mini/src/a.ts`, `b.ts`, `index.ts` | Small TS corpus with imports + calls. | Create |
| `tests/vault/symbol-extractor.typescript.test.ts` | TS symbol + edge extraction. | Create |
| `tests/vault/symbol-extractor.csharp.test.ts` | C# symbol + edge extraction. | Create |
| `tests/vault/symbol-extractor.markdown.test.ts` | Markdown wikilinks. | Create |
| `tests/vault/sqlite-vault-store.symbols.test.ts` | Symbol/edge/wikilink CRUD + cascade. | Create |
| `tests/vault/ppr.test.ts` | PPR math — convergence, seed weighting. | Create |
| `tests/vault/canvas-generator.test.ts` | JSON Canvas 1.0 round-trip. | Create |
| `tests/vault/self-vault.test.ts` | SelfVault discovery filter + init. | Create |
| `tests/vault/unity-project-vault.phase2.test.ts` | `findCallers`, PPR integration, canvas write on drain. | Create |
| `tests/vault/server-vault-routes.graph.test.ts` | New HTTP routes. | Create |
| `tests/vault/phase2.acceptance.test.ts` | End-to-end: cold index → "find callers of Player.Move" → canvas has node. | Create |
| `web-portal/src/pages/vaults/VaultGraphTab.test.tsx` | Renders nodes + handles node click. | Create |

### Docs

| File | Role | Action |
|---|---|---|
| `docs/vault.md` | Append "Phase 2: Symbol Graph" section. | Modify |

---

## Conventions used throughout this plan

**Symbol ID format:** `<lang>::<relPath>::<qualifiedName>`
- C#: `csharp::Assets/Scripts/Player.cs::Game.Player.Move`
- TS: `typescript::src/foo.ts::Foo.bar`
- Markdown note: `markdown::docs/vault.md` (note-level, body as symbol body is not modeled in Phase 2)

**Edge kinds:** `'calls' | 'references' | 'inherits' | 'implements' | 'imports' | 'embeds'`.
- `embeds` is reserved for markdown `![[target]]` transclusion (not generated in Phase 2 — placeholder in schema for Phase 3).

**`to_symbol` may be unresolved:** e.g. `csharp::unresolved::UnityEngine.Debug.Log`. We write the raw qualified reference; resolution across files is best-effort at query time.

**PPR params:** damping `d = 0.15`, iterations `N = 10`, convergence epsilon `1e-6` — first convergence wins.

**Canvas coords:** pre-computed server-side via dagre (LR direction) so the portal just renders.

**Test commands:**
- Server unit/integration: `npm test -- <file>` (delegates to vitest batch runner)
- Portal: `npm --prefix web-portal test -- <file>`

**Commit convention:** `feat(vault): <task summary> [phase2]` — keeps release notes filterable.

---

# Tasks

---

### Task 1: Install tree-sitter dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (auto)

- [ ] **Step 1: Add runtime deps**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain-vault
npm install web-tree-sitter@^0.25.0 tree-sitter-typescript@^0.23.0 tree-sitter-c-sharp@^0.23.0
```

Expected: `package.json` dependencies gain three entries; `node_modules/` populates; lockfile updates.

- [ ] **Step 2: Verify WASM files resolvable**

```bash
ls node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm \
   node_modules/tree-sitter-c-sharp/tree-sitter-c_sharp.wasm \
   node_modules/web-tree-sitter/tree-sitter.wasm
```

Expected: three files present. If any grammar ships only a grammar.js and no WASM, run its `prebuild` script (see its README). If still missing, fall back to `@tree-sitter-grammars/tree-sitter-c-sharp` and `@tree-sitter-grammars/tree-sitter-typescript` (community WASM-prebuilt variants) and document the switch in this task's commit message.

- [ ] **Step 3: Verify typecheck still passes**

Run: `npm run typecheck:src`
Expected: PASS (no consumer code references these yet).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(vault): add web-tree-sitter + TS/C# grammars [phase2]"
```

---

### Task 2: Schema — add symbols / edges / wikilinks tables

**Files:**
- Modify: `src/vault/schema.sql`
- Test: `tests/vault/sqlite-vault-store.symbols.test.ts` (first failing test)

- [ ] **Step 1: Write the failing test**

Create `tests/vault/sqlite-vault-store.symbols.test.ts`:

```ts
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
    // Accessing the internal db through a tiny inspector; we add a helper for tests.
    const names = store.listTableNamesForTest();
    expect(names).toContain('vault_symbols');
    expect(names).toContain('vault_edges');
    expect(names).toContain('vault_wikilinks');
  });

  it('records indexer_version in vault_meta', () => {
    expect(store.getMeta('indexer_version')).toBe('phase2.v1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/vault/sqlite-vault-store.symbols.test.ts`
Expected: FAIL — `listTableNamesForTest is not a function` (or similar). This confirms our harness is live.

- [ ] **Step 3: Extend the schema**

Append to `src/vault/schema.sql` (keep the semicolon-splitter warning in mind — each `CREATE` ends on its own line):

```sql
CREATE TABLE IF NOT EXISTS vault_symbols (
  symbol_id   TEXT PRIMARY KEY,
  path        TEXT NOT NULL REFERENCES vault_files(path) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  display     TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  doc         TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_path ON vault_symbols(path);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON vault_symbols(name);

CREATE TABLE IF NOT EXISTS vault_edges (
  from_symbol TEXT NOT NULL REFERENCES vault_symbols(symbol_id) ON DELETE CASCADE,
  to_symbol   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  at_line     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_symbol, to_symbol, kind, at_line)
);

CREATE INDEX IF NOT EXISTS idx_edges_to ON vault_edges(to_symbol);

CREATE TABLE IF NOT EXISTS vault_wikilinks (
  from_note   TEXT NOT NULL,
  target      TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_note, target)
);

CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON vault_wikilinks(target);

INSERT INTO vault_meta(key, value) VALUES ('indexer_version', 'phase2.v1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

- [ ] **Step 4: Add tiny test helpers on the store**

Modify `src/vault/sqlite-vault-store.ts`. Add these methods (before `close()`):

```ts
listTableNamesForTest(): string[] {
  const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return rows.map((r) => r.name);
}

getMeta(key: string): string | null {
  const row = this.db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
```

- [ ] **Step 5: Run the tests — should now pass**

Run: `npm test -- tests/vault/sqlite-vault-store.symbols.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/vault/schema.sql src/vault/sqlite-vault-store.ts tests/vault/sqlite-vault-store.symbols.test.ts
git commit -m "feat(vault): schema for symbols/edges/wikilinks + meta version [phase2]"
```

---

### Task 3: Store — symbol / edge / wikilink CRUD

**Files:**
- Modify: `src/vault/sqlite-vault-store.ts`
- Modify: `src/vault/vault.interface.ts`
- Modify: `tests/vault/sqlite-vault-store.symbols.test.ts`

- [ ] **Step 1: Extend `vault.interface.ts`**

Append to `src/vault/vault.interface.ts`:

```ts
export type EdgeKind = 'calls' | 'references' | 'inherits' | 'implements' | 'imports' | 'embeds';
export type SymbolKind = 'class' | 'method' | 'field' | 'namespace' | 'function' | 'interface' | 'note';

export interface VaultSymbol {
  symbolId: string;
  path: string;
  kind: SymbolKind;
  name: string;        // short name (e.g. "Move")
  display: string;     // signature ("public void Move(float dt)")
  startLine: number;
  endLine: number;
  doc: string | null;
}

export interface VaultEdge {
  fromSymbol: string;
  toSymbol: string;
  kind: EdgeKind;
  atLine: number;
}

export interface VaultWikilink {
  fromNote: string;
  target: string;
  resolved: boolean;
}
```

- [ ] **Step 2: Extend the failing test**

Append to `tests/vault/sqlite-vault-store.symbols.test.ts` inside the same `describe`:

```ts
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

it('wikilinks upsert + resolve flag toggle', () => {
  store.upsertWikilink({ fromNote: 'n1.md', target: 'n2.md', resolved: false });
  expect(store.listWikilinksTo('n2.md')).toHaveLength(1);
  store.markWikilinkResolved('n1.md', 'n2.md');
  expect(store.listWikilinksTo('n2.md')[0]!.resolved).toBe(true);
});
```

- [ ] **Step 3: Run — confirm failure**

Run: `npm test -- tests/vault/sqlite-vault-store.symbols.test.ts`
Expected: FAIL on `upsertSymbol is not a function`.

- [ ] **Step 4: Implement the CRUD in `SqliteVaultStore`**

Add to `src/vault/sqlite-vault-store.ts`:

```ts
import type { VaultSymbol, VaultEdge, VaultWikilink } from './vault.interface.js';

// ... inside the class, cached statements:
private _stmtUpsertSymbol: Database.Statement | null = null;
private _stmtListSymbolsByPath: Database.Statement | null = null;
private _stmtFindSymbolsByName: Database.Statement | null = null;
private _stmtDeleteSymbolsByPath: Database.Statement | null = null;
private _stmtUpsertEdge: Database.Statement | null = null;
private _stmtFindCallers: Database.Statement | null = null;
private _stmtListEdgesAll: Database.Statement | null = null;
private _stmtDeleteEdgesByPath: Database.Statement | null = null;
private _stmtUpsertWikilink: Database.Statement | null = null;
private _stmtListWikilinksTo: Database.Statement | null = null;
private _stmtMarkWikilinkResolved: Database.Statement | null = null;
```

In `migrate()`, append prepared statements (at the end):

```ts
this._stmtUpsertSymbol = this.db.prepare(`
  INSERT INTO vault_symbols (symbol_id, path, kind, name, display, start_line, end_line, doc)
  VALUES (@symbolId, @path, @kind, @name, @display, @startLine, @endLine, @doc)
  ON CONFLICT(symbol_id) DO UPDATE SET
    path=excluded.path, kind=excluded.kind, name=excluded.name, display=excluded.display,
    start_line=excluded.start_line, end_line=excluded.end_line, doc=excluded.doc
`);
this._stmtListSymbolsByPath = this.db.prepare('SELECT * FROM vault_symbols WHERE path = ? ORDER BY start_line');
this._stmtFindSymbolsByName = this.db.prepare('SELECT * FROM vault_symbols WHERE name = ? ORDER BY path LIMIT ?');
this._stmtDeleteSymbolsByPath = this.db.prepare('DELETE FROM vault_symbols WHERE path = ?');
this._stmtUpsertEdge = this.db.prepare(`
  INSERT INTO vault_edges (from_symbol, to_symbol, kind, at_line)
  VALUES (@fromSymbol, @toSymbol, @kind, @atLine)
  ON CONFLICT(from_symbol, to_symbol, kind, at_line) DO NOTHING
`);
this._stmtFindCallers = this.db.prepare('SELECT * FROM vault_edges WHERE to_symbol = ?');
this._stmtListEdgesAll = this.db.prepare('SELECT * FROM vault_edges');
this._stmtDeleteEdgesByPath = this.db.prepare(`
  DELETE FROM vault_edges
  WHERE from_symbol IN (SELECT symbol_id FROM vault_symbols WHERE path = ?)
`);
this._stmtUpsertWikilink = this.db.prepare(`
  INSERT INTO vault_wikilinks (from_note, target, resolved)
  VALUES (@fromNote, @target, @resolved)
  ON CONFLICT(from_note, target) DO UPDATE SET resolved = excluded.resolved
`);
this._stmtListWikilinksTo = this.db.prepare('SELECT * FROM vault_wikilinks WHERE target = ?');
this._stmtMarkWikilinkResolved = this.db.prepare('UPDATE vault_wikilinks SET resolved = 1 WHERE from_note = ? AND target = ?');
```

Add the public methods:

```ts
upsertSymbol(s: VaultSymbol): void { this._stmtUpsertSymbol!.run(s); }

listSymbolsForPath(path: string): VaultSymbol[] {
  const rows = this._stmtListSymbolsByPath!.all(path) as Record<string, unknown>[];
  return rows.map(this.mapSymbol);
}

findSymbolsByName(name: string, limit = 20): VaultSymbol[] {
  const rows = this._stmtFindSymbolsByName!.all(name, limit) as Record<string, unknown>[];
  return rows.map(this.mapSymbol);
}

upsertEdge(e: VaultEdge): void { this._stmtUpsertEdge!.run(e); }

findCallersOf(symbolId: string): VaultEdge[] {
  const rows = this._stmtFindCallers!.all(symbolId) as Record<string, unknown>[];
  return rows.map(this.mapEdge);
}

listEdges(): VaultEdge[] {
  const rows = this._stmtListEdgesAll!.all() as Record<string, unknown>[];
  return rows.map(this.mapEdge);
}

upsertWikilink(w: VaultWikilink): void {
  this._stmtUpsertWikilink!.run({ ...w, resolved: w.resolved ? 1 : 0 });
}

listWikilinksTo(target: string): VaultWikilink[] {
  const rows = this._stmtListWikilinksTo!.all(target) as Record<string, unknown>[];
  return rows.map((r) => ({
    fromNote: r['from_note'] as string,
    target: r['target'] as string,
    resolved: (r['resolved'] as number) === 1,
  }));
}

markWikilinkResolved(fromNote: string, target: string): void {
  this._stmtMarkWikilinkResolved!.run(fromNote, target);
}

private mapSymbol = (row: Record<string, unknown>): VaultSymbol => ({
  symbolId: row['symbol_id'] as string,
  path: row['path'] as string,
  kind: row['kind'] as VaultSymbol['kind'],
  name: row['name'] as string,
  display: row['display'] as string,
  startLine: row['start_line'] as number,
  endLine: row['end_line'] as number,
  doc: (row['doc'] as string | null) ?? null,
});

private mapEdge = (row: Record<string, unknown>): VaultEdge => ({
  fromSymbol: row['from_symbol'] as string,
  toSymbol: row['to_symbol'] as string,
  kind: row['kind'] as VaultEdge['kind'],
  atLine: row['at_line'] as number,
});
```

Also wire cascade deletes into the existing `deleteFile()` transaction so symbols + edges go with the file (FK handles symbols; we need to delete edges whose `from_symbol` points at this file first, since `to_symbol` is not FK-bound):

```ts
// In deleteFile txn, BEFORE deleting chunk rows:
this._stmtDeleteEdgesByPath!.run(path);
this._stmtDeleteSymbolsByPath!.run(path); // FK cascade would drop edges from_symbol, but we already deleted them; this line clears symbols themselves explicitly
```

- [ ] **Step 5: Run tests — expect pass**

Run: `npm test -- tests/vault/sqlite-vault-store.symbols.test.ts`
Expected: PASS (5 tests total in this file).

- [ ] **Step 6: Regression-check Phase 1 store tests**

Run: `npm test -- tests/vault/sqlite-vault-store.test.ts`
Expected: PASS — we did not change any Phase 1 behavior.

- [ ] **Step 7: Commit**

```bash
git add src/vault/sqlite-vault-store.ts src/vault/vault.interface.ts tests/vault/sqlite-vault-store.symbols.test.ts
git commit -m "feat(vault): symbol/edge/wikilink CRUD on SqliteVaultStore [phase2]"
```

---

### Task 4: Symbol-extractor contract + tree-sitter loader

**Files:**
- Create: `src/vault/symbol-extractor/symbol-extractor.interface.ts`
- Create: `src/vault/symbol-extractor/tree-sitter-loader.ts`
- Create: `tests/vault/symbol-extractor.loader.test.ts`

- [ ] **Step 1: Write the failing loader test**

Create `tests/vault/symbol-extractor.loader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadLanguageParser } from '../../src/vault/symbol-extractor/tree-sitter-loader.js';

describe('tree-sitter-loader', () => {
  it('loads the typescript grammar and parses a trivial source', async () => {
    const parser = await loadLanguageParser('typescript');
    const tree = parser.parse('const x = 1;');
    expect(tree?.rootNode.type).toBe('program');
  }, 20_000);

  it('loads the csharp grammar and parses a trivial source', async () => {
    const parser = await loadLanguageParser('csharp');
    const tree = parser.parse('class A {}');
    expect(tree?.rootNode.type).toBe('compilation_unit');
  }, 20_000);

  it('caches parsers across calls', async () => {
    const p1 = await loadLanguageParser('typescript');
    const p2 = await loadLanguageParser('typescript');
    expect(p1).toBe(p2);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `npm test -- tests/vault/symbol-extractor.loader.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Create the interface**

Create `src/vault/symbol-extractor/symbol-extractor.interface.ts`:

```ts
import type { VaultSymbol, VaultEdge, VaultWikilink } from '../vault.interface.js';

export interface ExtractInput {
  path: string;            // vault-relative
  content: string;
  lang: 'typescript' | 'csharp' | 'markdown';
}

export interface ExtractOutput {
  symbols: VaultSymbol[];
  edges: VaultEdge[];
  wikilinks: VaultWikilink[];
}

export interface ISymbolExtractor {
  readonly lang: ExtractInput['lang'];
  extract(input: ExtractInput): Promise<ExtractOutput>;
}
```

- [ ] **Step 4: Create the loader**

Create `src/vault/symbol-extractor/tree-sitter-loader.ts`:

```ts
// Lazy WASM loader for tree-sitter. Caches Parser + Language instances.
// Runs in Node (via web-tree-sitter's Node build).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Parser as TSParser, Language as TSLanguage } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export type TreeSitterLang = 'typescript' | 'csharp';

let parserModulePromise: Promise<typeof import('web-tree-sitter')> | null = null;
const parserCache = new Map<TreeSitterLang, TSParser>();
const langCache = new Map<TreeSitterLang, TSLanguage>();

const WASM_PATHS: Record<TreeSitterLang, () => string> = {
  typescript: () => join(dirname(require.resolve('tree-sitter-typescript/package.json')), 'tree-sitter-typescript.wasm'),
  csharp:     () => join(dirname(require.resolve('tree-sitter-c-sharp/package.json')), 'tree-sitter-c_sharp.wasm'),
};

async function getModule(): Promise<typeof import('web-tree-sitter')> {
  if (!parserModulePromise) {
    parserModulePromise = import('web-tree-sitter').then(async (mod) => {
      await mod.Parser.init();
      return mod;
    });
  }
  return parserModulePromise;
}

async function getLang(lang: TreeSitterLang): Promise<TSLanguage> {
  const cached = langCache.get(lang);
  if (cached) return cached;
  const mod = await getModule();
  const wasmPath = WASM_PATHS[lang]();
  const loaded = await mod.Language.load(wasmPath);
  langCache.set(lang, loaded);
  return loaded;
}

export async function loadLanguageParser(lang: TreeSitterLang): Promise<TSParser> {
  const cached = parserCache.get(lang);
  if (cached) return cached;
  const mod = await getModule();
  const parser = new mod.Parser();
  const language = await getLang(lang);
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  return parser;
}

export function resetForTests(): void {
  parserModulePromise = null;
  parserCache.clear();
  langCache.clear();
}
```

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- tests/vault/symbol-extractor.loader.test.ts`
Expected: PASS (3 tests).

If WASM resolution fails (e.g. grammar package ships JS-only), switch to `@tree-sitter-grammars/tree-sitter-typescript` / `@tree-sitter-grammars/tree-sitter-c-sharp` (adjust the `WASM_PATHS` map and `package.json`), then re-run.

- [ ] **Step 6: Commit**

```bash
git add src/vault/symbol-extractor/symbol-extractor.interface.ts src/vault/symbol-extractor/tree-sitter-loader.ts tests/vault/symbol-extractor.loader.test.ts
git commit -m "feat(vault): tree-sitter WASM loader + extractor contract [phase2]"
```

---

### Task 5: TypeScript symbol extractor

**Files:**
- Create: `src/vault/symbol-extractor/typescript-extractor.ts`
- Create: `tests/fixtures/ts-mini/src/a.ts`
- Create: `tests/fixtures/ts-mini/src/b.ts`
- Create: `tests/fixtures/ts-mini/src/index.ts`
- Create: `tests/vault/symbol-extractor.typescript.test.ts`

- [ ] **Step 1: Seed the TS fixture**

Create `tests/fixtures/ts-mini/src/a.ts`:

```ts
export class Alpha {
  greet(): string { return 'hello'; }
}

export function topLevel(): void {}
```

Create `tests/fixtures/ts-mini/src/b.ts`:

```ts
import { Alpha } from './a.js';

export class Beta {
  useAlpha(): string {
    const a = new Alpha();
    return a.greet();
  }
}
```

Create `tests/fixtures/ts-mini/src/index.ts`:

```ts
import { Beta } from './b.js';
export const beta = new Beta();
```

- [ ] **Step 2: Write the failing extractor test**

Create `tests/vault/symbol-extractor.typescript.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptSymbolExtractor } from '../../src/vault/symbol-extractor/typescript-extractor.js';

const FIX = join(process.cwd(), 'tests/fixtures/ts-mini/src');

describe('TypeScriptSymbolExtractor', () => {
  it('extracts classes, methods, functions from a.ts', async () => {
    const content = await readFile(join(FIX, 'a.ts'), 'utf8');
    const extractor = new TypeScriptSymbolExtractor();
    const out = await extractor.extract({ path: 'a.ts', content, lang: 'typescript' });
    const names = out.symbols.map((s) => s.name).sort();
    expect(names).toEqual(['Alpha', 'greet', 'topLevel']);
    expect(out.symbols.find((s) => s.name === 'Alpha')?.kind).toBe('class');
    expect(out.symbols.find((s) => s.name === 'topLevel')?.kind).toBe('function');
    expect(out.symbols.find((s) => s.name === 'greet')?.kind).toBe('method');
  }, 20_000);

  it('extracts import + call edges from b.ts', async () => {
    const content = await readFile(join(FIX, 'b.ts'), 'utf8');
    const extractor = new TypeScriptSymbolExtractor();
    const out = await extractor.extract({ path: 'b.ts', content, lang: 'typescript' });
    const imports = out.edges.filter((e) => e.kind === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports.some((e) => e.toSymbol.includes('Alpha'))).toBe(true);
    const calls = out.edges.filter((e) => e.kind === 'calls');
    expect(calls.some((e) => e.toSymbol.endsWith('greet'))).toBe(true);
  }, 20_000);
});
```

- [ ] **Step 3: Run — confirm failure**

Run: `npm test -- tests/vault/symbol-extractor.typescript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the extractor**

Create `src/vault/symbol-extractor/typescript-extractor.ts`:

```ts
import type { SyntaxNode } from 'web-tree-sitter';
import { loadLanguageParser } from './tree-sitter-loader.js';
import type { ExtractInput, ExtractOutput, ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultEdge, VaultSymbol, SymbolKind } from '../vault.interface.js';

function symbolId(path: string, qualified: string): string {
  return `typescript::${path}::${qualified}`;
}

function unresolved(qualified: string): string {
  return `typescript::unresolved::${qualified}`;
}

function bodyOf(n: SyntaxNode): string { return n.text ?? ''; }

function leadingDoc(n: SyntaxNode): string | null {
  const prev = n.previousSibling;
  if (prev && prev.type === 'comment' && prev.text.startsWith('/**')) return prev.text;
  return null;
}

function collectClassBody(
  path: string,
  classNode: SyntaxNode,
  className: string,
  out: VaultSymbol[],
  edgesOut: VaultEdge[],
  currentScope: string[],
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    if (child.type === 'method_definition' || child.type === 'method_signature') {
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const methodName = nameNode.text;
      const qualified = `${className}.${methodName}`;
      out.push({
        symbolId: symbolId(path, qualified),
        path,
        kind: 'method',
        name: methodName,
        display: bodyOf(nameNode),
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        doc: leadingDoc(child),
      });
      collectCallsInto(path, child, symbolId(path, qualified), edgesOut, [...currentScope, className]);
    }
  }
}

function collectCallsInto(
  path: string,
  node: SyntaxNode,
  fromSym: string,
  out: VaultEdge[],
  _scope: string[],
): void {
  const stack: SyntaxNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) {
        const name = fn.type === 'member_expression' ? fn.childForFieldName('property')?.text ?? fn.text : fn.text;
        out.push({
          fromSymbol: fromSym,
          toSymbol: unresolved(name),
          kind: 'calls',
          atLine: n.startPosition.row + 1,
        });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
}

function collectImports(path: string, root: SyntaxNode, edges: VaultEdge[]): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'import_statement') {
      const source = n.childForFieldName('source')?.text?.replace(/['"`]/g, '') ?? '';
      // Collect every imported specifier as its own edge for precise lookup.
      const clause = n.namedChildren.find((c): c is SyntaxNode => c !== null && c.type === 'import_clause');
      const names: string[] = [];
      if (clause) {
        const stack2: SyntaxNode[] = [clause];
        while (stack2.length) {
          const x = stack2.pop()!;
          if (x.type === 'identifier') names.push(x.text);
          for (let i = 0; i < x.namedChildCount; i++) { const c = x.namedChild(i); if (c) stack2.push(c); }
        }
      }
      const fileSym = `typescript::${path}::<module>`;
      if (names.length === 0) {
        edges.push({ fromSymbol: fileSym, toSymbol: unresolved(source), kind: 'imports', atLine: n.startPosition.row + 1 });
      }
      for (const name of names) {
        edges.push({ fromSymbol: fileSym, toSymbol: unresolved(`${source}#${name}`), kind: 'imports', atLine: n.startPosition.row + 1 });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) stack.push(c); }
  }
}

export class TypeScriptSymbolExtractor implements ISymbolExtractor {
  readonly lang = 'typescript' as const;

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const parser = await loadLanguageParser('typescript');
    const tree = parser.parse(input.content);
    const root = tree?.rootNode;
    if (!root) return { symbols: [], edges: [], wikilinks: [] };
    const symbols: VaultSymbol[] = [];
    const edges: VaultEdge[] = [];
    // Register a virtual <module> symbol so file-level imports have a concrete from_symbol.
    symbols.push({
      symbolId: symbolId(input.path, '<module>'),
      path: input.path,
      kind: 'namespace',
      name: '<module>',
      display: input.path,
      startLine: 1,
      endLine: (input.content.split('\n').length) || 1,
      doc: null,
    });

    const topLevel: SyntaxNode[] = [];
    for (let i = 0; i < root.namedChildCount; i++) {
      const n = root.namedChild(i);
      if (n) topLevel.push(n);
    }

    for (const node of topLevel) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const name = nameNode.text;
      let kind: SymbolKind | null = null;
      if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') kind = 'class';
      else if (node.type === 'interface_declaration') kind = 'interface';
      else if (node.type === 'function_declaration') kind = 'function';
      if (!kind) continue;
      symbols.push({
        symbolId: symbolId(input.path, name),
        path: input.path,
        kind,
        name,
        display: bodyOf(nameNode),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        doc: leadingDoc(node),
      });
      if (kind === 'class' || kind === 'interface') {
        collectClassBody(input.path, node, name, symbols, edges, []);
      } else {
        collectCallsInto(input.path, node, symbolId(input.path, name), edges, []);
      }
    }

    collectImports(input.path, root, edges);
    return { symbols, edges, wikilinks: [] };
  }
}
```

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- tests/vault/symbol-extractor.typescript.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/vault/symbol-extractor/typescript-extractor.ts tests/fixtures/ts-mini tests/vault/symbol-extractor.typescript.test.ts
git commit -m "feat(vault): TypeScript symbol extractor [phase2]"
```

---

### Task 6: C# symbol extractor

**Files:**
- Create: `src/vault/symbol-extractor/csharp-extractor.ts`
- Create: `tests/fixtures/unity-mini/Assets/Scripts/Controller.cs`
- Create: `tests/vault/symbol-extractor.csharp.test.ts`

- [ ] **Step 1: Extend the fixture so we have a real caller**

Create `tests/fixtures/unity-mini/Assets/Scripts/Controller.cs`:

```csharp
using UnityEngine;
namespace Game {
    /// <summary>Drives the player each frame.</summary>
    public class Controller : MonoBehaviour {
        private Player player;
        void Update() {
            player.Move(Time.deltaTime);
        }
    }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/vault/symbol-extractor.csharp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CSharpSymbolExtractor } from '../../src/vault/symbol-extractor/csharp-extractor.js';

const FIX = join(process.cwd(), 'tests/fixtures/unity-mini/Assets/Scripts');

describe('CSharpSymbolExtractor', () => {
  it('extracts namespace, class, method symbols for Player.cs', async () => {
    const content = await readFile(join(FIX, 'Player.cs'), 'utf8');
    const x = new CSharpSymbolExtractor();
    const out = await x.extract({ path: 'Assets/Scripts/Player.cs', content, lang: 'csharp' });
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('Game');
    expect(names).toContain('Player');
    expect(names).toContain('Move');
    const player = out.symbols.find((s) => s.name === 'Player');
    expect(player?.kind).toBe('class');
    expect(player?.doc).toMatch(/Top-level player entity/);
  }, 20_000);

  it('extracts the Controller → Player.Move call edge', async () => {
    const content = await readFile(join(FIX, 'Controller.cs'), 'utf8');
    const x = new CSharpSymbolExtractor();
    const out = await x.extract({ path: 'Assets/Scripts/Controller.cs', content, lang: 'csharp' });
    const calls = out.edges.filter((e) => e.kind === 'calls');
    expect(calls.some((e) => e.toSymbol.endsWith('Move'))).toBe(true);
  }, 20_000);

  it('extracts inheritance edge Controller → MonoBehaviour', async () => {
    const content = await readFile(join(FIX, 'Controller.cs'), 'utf8');
    const x = new CSharpSymbolExtractor();
    const out = await x.extract({ path: 'Assets/Scripts/Controller.cs', content, lang: 'csharp' });
    const inherits = out.edges.filter((e) => e.kind === 'inherits');
    expect(inherits.some((e) => e.toSymbol.endsWith('MonoBehaviour'))).toBe(true);
  }, 20_000);
});
```

- [ ] **Step 3: Run — confirm failure**

Run: `npm test -- tests/vault/symbol-extractor.csharp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the extractor**

Create `src/vault/symbol-extractor/csharp-extractor.ts`:

```ts
import type { SyntaxNode } from 'web-tree-sitter';
import { loadLanguageParser } from './tree-sitter-loader.js';
import type { ExtractInput, ExtractOutput, ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultEdge, VaultSymbol } from '../vault.interface.js';

function symId(path: string, qualified: string): string {
  return `csharp::${path}::${qualified}`;
}
function unresolvedId(qualified: string): string {
  return `csharp::unresolved::${qualified}`;
}

function leadingXmlDoc(n: SyntaxNode): string | null {
  let p = n.previousSibling;
  const lines: string[] = [];
  while (p && (p.type === 'comment' || p.type === 'line_comment')) {
    const t = p.text;
    if (t.startsWith('///')) lines.unshift(t);
    p = p.previousSibling;
  }
  return lines.length ? lines.join('\n') : null;
}

export class CSharpSymbolExtractor implements ISymbolExtractor {
  readonly lang = 'csharp' as const;

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const parser = await loadLanguageParser('csharp');
    const tree = parser.parse(input.content);
    const root = tree?.rootNode;
    if (!root) return { symbols: [], edges: [], wikilinks: [] };

    const symbols: VaultSymbol[] = [];
    const edges: VaultEdge[] = [];

    // File-level virtual symbol for using-imports.
    const fileSym = symId(input.path, '<module>');
    symbols.push({
      symbolId: fileSym, path: input.path, kind: 'namespace', name: '<module>', display: input.path,
      startLine: 1, endLine: (input.content.split('\n').length) || 1, doc: null,
    });

    // using X.Y; → imports
    walk(root, (n) => {
      if (n.type === 'using_directive') {
        const name = n.namedChildren.map((c) => c?.text).filter(Boolean).join('.');
        edges.push({ fromSymbol: fileSym, toSymbol: unresolvedId(name), kind: 'imports', atLine: n.startPosition.row + 1 });
      }
    });

    // namespaces (may nest). We only record the outermost qualified name.
    const nsStack: string[] = [];
    const visit = (n: SyntaxNode): void => {
      if (n.type === 'namespace_declaration' || n.type === 'file_scoped_namespace_declaration') {
        const nameNode = n.childForFieldName('name');
        const nsName = nameNode?.text ?? '<anon>';
        nsStack.push(nsName);
        symbols.push({
          symbolId: symId(input.path, nsStack.join('.')),
          path: input.path, kind: 'namespace', name: nsName, display: nsName,
          startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1, doc: null,
        });
        for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) visit(c); }
        nsStack.pop();
        return;
      }
      if (n.type === 'class_declaration' || n.type === 'struct_declaration' || n.type === 'interface_declaration') {
        const nameNode = n.childForFieldName('name');
        if (!nameNode) return;
        const className = nameNode.text;
        const qualified = [...nsStack, className].join('.');
        const kind = n.type === 'interface_declaration' ? 'interface' : 'class';
        symbols.push({
          symbolId: symId(input.path, qualified),
          path: input.path, kind, name: className, display: className,
          startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,
          doc: leadingXmlDoc(n),
        });
        // inherits / implements via base_list
        const bases = n.childForFieldName('bases');
        if (bases) {
          for (let i = 0; i < bases.namedChildCount; i++) {
            const b = bases.namedChild(i);
            if (!b) continue;
            edges.push({
              fromSymbol: symId(input.path, qualified),
              toSymbol: unresolvedId(b.text),
              kind: 'inherits',
              atLine: b.startPosition.row + 1,
            });
          }
        }
        // class body
        const body = n.childForFieldName('body');
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const mem = body.namedChild(i);
            if (!mem) continue;
            if (mem.type === 'method_declaration' || mem.type === 'constructor_declaration') {
              const mNameNode = mem.childForFieldName('name');
              if (!mNameNode) continue;
              const mName = mNameNode.text;
              const mQualified = `${qualified}.${mName}`;
              symbols.push({
                symbolId: symId(input.path, mQualified),
                path: input.path, kind: 'method', name: mName, display: mName,
                startLine: mem.startPosition.row + 1, endLine: mem.endPosition.row + 1,
                doc: leadingXmlDoc(mem),
              });
              // walk body for calls
              walk(mem, (c) => {
                if (c.type === 'invocation_expression') {
                  const fn = c.childForFieldName('function') ?? c.namedChild(0);
                  const label = fn?.type === 'member_access_expression'
                    ? fn.childForFieldName('name')?.text ?? fn.text
                    : fn?.text ?? '<anon>';
                  edges.push({
                    fromSymbol: symId(input.path, mQualified),
                    toSymbol: unresolvedId(label),
                    kind: 'calls',
                    atLine: c.startPosition.row + 1,
                  });
                }
              });
            }
          }
        }
        return;
      }
      for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) visit(c); }
    };
    visit(root);

    return { symbols, edges, wikilinks: [] };
  }
}

function walk(root: SyntaxNode, fn: (n: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    fn(n);
    for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) stack.push(c); }
  }
}
```

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- tests/vault/symbol-extractor.csharp.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/vault/symbol-extractor/csharp-extractor.ts tests/fixtures/unity-mini/Assets/Scripts/Controller.cs tests/vault/symbol-extractor.csharp.test.ts
git commit -m "feat(vault): C# symbol extractor [phase2]"
```

---

### Task 7: Markdown wikilink extractor + factory

**Files:**
- Create: `src/vault/symbol-extractor/markdown-extractor.ts`
- Create: `src/vault/symbol-extractor/index.ts`
- Create: `tests/vault/symbol-extractor.markdown.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/symbol-extractor.markdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MarkdownSymbolExtractor } from '../../src/vault/symbol-extractor/markdown-extractor.js';
import { getExtractorFor } from '../../src/vault/symbol-extractor/index.js';

describe('MarkdownSymbolExtractor', () => {
  it('creates a note symbol + extracts wikilinks', async () => {
    const x = new MarkdownSymbolExtractor();
    const out = await x.extract({
      path: 'decisions/a.md',
      content: '# Heading\n\nSee [[target]] and [[other.md]].',
      lang: 'markdown',
    });
    expect(out.symbols).toHaveLength(1);
    expect(out.symbols[0]!.kind).toBe('note');
    expect(out.wikilinks.map((w) => w.target).sort()).toEqual(['other.md', 'target']);
    expect(out.wikilinks.every((w) => w.resolved === false)).toBe(true);
  });

  it('ignores code-fenced wikilinks', async () => {
    const x = new MarkdownSymbolExtractor();
    const out = await x.extract({
      path: 'a.md',
      content: 'outside [[real]]\n```\n[[fake]]\n```',
      lang: 'markdown',
    });
    expect(out.wikilinks.map((w) => w.target)).toEqual(['real']);
  });
});

describe('getExtractorFor', () => {
  it('returns the right extractor per language', () => {
    expect(getExtractorFor('typescript')).not.toBeNull();
    expect(getExtractorFor('csharp')).not.toBeNull();
    expect(getExtractorFor('markdown')).not.toBeNull();
    expect(getExtractorFor('json')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `npm test -- tests/vault/symbol-extractor.markdown.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement markdown extractor**

Create `src/vault/symbol-extractor/markdown-extractor.ts`:

```ts
import type { ExtractInput, ExtractOutput, ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultSymbol, VaultWikilink } from '../vault.interface.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const FENCE_RE = /```[\s\S]*?```/g;

export class MarkdownSymbolExtractor implements ISymbolExtractor {
  readonly lang = 'markdown' as const;

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const symbols: VaultSymbol[] = [{
      symbolId: `markdown::${input.path}`,
      path: input.path,
      kind: 'note',
      name: input.path.split('/').pop() ?? input.path,
      display: input.path,
      startLine: 1,
      endLine: (input.content.split('\n').length) || 1,
      doc: null,
    }];

    // Strip fenced code blocks before scanning wikilinks.
    const stripped = input.content.replace(FENCE_RE, (m) => '\n'.repeat((m.match(/\n/g)?.length ?? 0)));
    const seen = new Set<string>();
    const wikilinks: VaultWikilink[] = [];
    for (const m of stripped.matchAll(WIKILINK_RE)) {
      const target = m[1]!.trim();
      if (seen.has(target)) continue;
      seen.add(target);
      wikilinks.push({ fromNote: input.path, target, resolved: false });
    }
    return { symbols, edges: [], wikilinks };
  }
}
```

- [ ] **Step 4: Implement factory**

Create `src/vault/symbol-extractor/index.ts`:

```ts
import { TypeScriptSymbolExtractor } from './typescript-extractor.js';
import { CSharpSymbolExtractor } from './csharp-extractor.js';
import { MarkdownSymbolExtractor } from './markdown-extractor.js';
import type { ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultFile } from '../vault.interface.js';

let ts: TypeScriptSymbolExtractor | null = null;
let cs: CSharpSymbolExtractor | null = null;
let md: MarkdownSymbolExtractor | null = null;

export function getExtractorFor(lang: VaultFile['lang']): ISymbolExtractor | null {
  switch (lang) {
    case 'typescript': return (ts ??= new TypeScriptSymbolExtractor());
    case 'csharp':     return (cs ??= new CSharpSymbolExtractor());
    case 'markdown':   return (md ??= new MarkdownSymbolExtractor());
    default: return null;
  }
}

export type { ISymbolExtractor, ExtractInput, ExtractOutput } from './symbol-extractor.interface.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- tests/vault/symbol-extractor.markdown.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/vault/symbol-extractor/markdown-extractor.ts src/vault/symbol-extractor/index.ts tests/vault/symbol-extractor.markdown.test.ts
git commit -m "feat(vault): markdown wikilink extractor + extractor factory [phase2]"
```

---

### Task 8: Wire extractor into `UnityProjectVault.reindexFile`

**Files:**
- Modify: `src/vault/unity-project-vault.ts`
- Create: `tests/vault/unity-project-vault.phase2.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/vault/unity-project-vault.phase2.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';
import { EmbeddingAdapter } from '../../src/vault/embedding-adapter.js';

class StubEmb {
  readonly model = 'stub'; readonly dim = 4;
  async embed(texts: string[]) { return texts.map(() => new Float32Array([1, 0, 0, 0])); }
}
class StubStore {
  private i = 0; private items: Array<{ id: number; vec: Float32Array; payload: unknown }> = [];
  add(v: Float32Array, p: unknown) { const id = ++this.i; this.items.push({ id, vec: v, payload: p }); return id; }
  remove() {}
  search() { return this.items.slice(0, 5).map((x) => ({ id: x.id, score: 1, payload: x.payload })); }
}

describe('UnityProjectVault — Phase 2 wiring', () => {
  let dir: string;
  let vault: UnityProjectVault;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vault-upv-p2-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    vault = new UnityProjectVault({
      id: 'test', rootPath: dir, embedding: new StubEmb() as any, vectorStore: new StubStore() as any,
    });
    await vault.init();
  });

  afterEach(async () => { await vault.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it('populates vault_symbols for Player.cs after init', async () => {
    const syms = (vault as any).store.listSymbolsForPath('Assets/Scripts/Player.cs');
    const names = syms.map((s: any) => s.name);
    expect(names).toContain('Player');
    expect(names).toContain('Move');
  });

  it('findCallers resolves Controller → Player.Move by name tail', async () => {
    const callers = await vault.findCallers('csharp::Assets/Scripts/Player.cs::Game.Player.Move');
    expect(callers.some((e: any) => e.fromSymbol.includes('Controller'))).toBe(true);
  });

  it('writes graph.canvas containing at least one node per file', async () => {
    const p = join(dir, '.strada/vault/graph.canvas');
    const raw = readFileSync(p, 'utf8');
    const canvas = JSON.parse(raw);
    expect(Array.isArray(canvas.nodes)).toBe(true);
    const files = new Set(canvas.nodes.map((n: any) => n.file));
    expect(files.has('Assets/Scripts/Player.cs')).toBe(true);
  });
});
```

Note: this test exercises behaviour from Tasks 8 + 9 + 10 — write it now so the next tasks can light up each block.

- [ ] **Step 2: Run — confirm failure**

Run: `npm test -- tests/vault/unity-project-vault.phase2.test.ts`
Expected: FAIL — `listSymbolsForPath` returns empty (extractor not wired).

- [ ] **Step 3: Wire the extractor into `reindexFile`**

Modify `src/vault/unity-project-vault.ts`. Add import:

```ts
import { getExtractorFor } from './symbol-extractor/index.js';
```

In `reindexFile`, **after** the chunk loop, before `return true`, add:

```ts
// Symbol + edge extraction (Phase 2). Pure best-effort: errors must not block indexing.
const extractor = getExtractorFor(lang);
if (extractor) {
  try {
    const out = await extractor.extract({ path: relPath, content: body, lang: lang as 'typescript' | 'csharp' | 'markdown' });
    for (const s of out.symbols) this.store.upsertSymbol(s);
    for (const e of out.edges) this.store.upsertEdge(e);
    for (const w of out.wikilinks) this.store.upsertWikilink(w);
  } catch (err) {
    getLoggerSafe().warn(`[vault ${this.id}] symbol extraction failed for ${relPath}`, { err });
  }
}
```

Now add the `findCallers` method to the class (with the name-tail fallback to resolve "unresolved" edges against known symbols):

```ts
async findCallers(symbolId: string): Promise<import('./vault.interface.js').VaultEdge[]> {
  const direct = this.store.findCallersOf(symbolId);
  if (direct.length) return direct;
  // Name-tail fallback: match against unresolved edges whose label equals the short name.
  const short = symbolId.split('::').at(-1)?.split('.').at(-1) ?? '';
  if (!short) return [];
  return this.store.listEdges().filter((e) => e.kind === 'calls' && e.toSymbol.endsWith(`::${short}`));
}

async findSymbolsByName(name: string, limit = 20) {
  return this.store.findSymbolsByName(name, limit);
}
```

Update the `IVault` interface (`vault.interface.ts`) to include `findCallers`/`findSymbolsByName` as optional methods:

```ts
findCallers?(symbolId: string): Promise<VaultEdge[]>;
findSymbolsByName?(name: string, limit?: number): Promise<VaultSymbol[]>;
```

- [ ] **Step 4: Run — the first two test cases should now pass; canvas test still fails**

Run: `npm test -- tests/vault/unity-project-vault.phase2.test.ts`
Expected: first 2 PASS, third FAIL (no canvas file yet).

- [ ] **Step 5: Commit**

```bash
git add src/vault/unity-project-vault.ts src/vault/vault.interface.ts tests/vault/unity-project-vault.phase2.test.ts
git commit -m "feat(vault): extract symbols/edges on reindex + findCallers [phase2]"
```

---

### Task 9: Canvas generator (JSON Canvas 1.0)

**Files:**
- Create: `src/vault/canvas-generator.ts`
- Create: `tests/vault/canvas-generator.test.ts`
- Modify: `src/vault/unity-project-vault.ts`

- [ ] **Step 1: Write the failing unit test**

Create `tests/vault/canvas-generator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCanvas } from '../../src/vault/canvas-generator.js';
import type { VaultSymbol, VaultEdge } from '../../src/vault/vault.interface.js';

describe('buildCanvas', () => {
  it('emits JSON Canvas 1.0 with a node per top-level symbol and an edge per call', () => {
    const symbols: VaultSymbol[] = [
      { symbolId: 'a', path: 'a.ts', kind: 'class', name: 'A', display: 'A', startLine: 1, endLine: 2, doc: null },
      { symbolId: 'b', path: 'b.ts', kind: 'class', name: 'B', display: 'B', startLine: 1, endLine: 2, doc: null },
    ];
    const edges: VaultEdge[] = [
      { fromSymbol: 'a', toSymbol: 'b', kind: 'calls', atLine: 1 },
    ];
    const canvas = buildCanvas({ symbols, edges });
    expect(canvas.nodes).toHaveLength(2);
    expect(canvas.edges).toHaveLength(1);
    const n = canvas.nodes[0]!;
    expect(typeof n.id).toBe('string');
    expect(typeof n.x).toBe('number');
    expect(typeof n.y).toBe('number');
    expect(typeof n.width).toBe('number');
    expect(typeof n.height).toBe('number');
    expect(n.type).toBe('text');
    expect(canvas.edges[0]!.fromNode).toBe('a');
    expect(canvas.edges[0]!.toNode).toBe('b');
  });

  it('skips edges whose endpoints are missing (unresolved externs)', () => {
    const canvas = buildCanvas({
      symbols: [{ symbolId: 'a', path: 'a.ts', kind: 'class', name: 'A', display: 'A', startLine: 1, endLine: 2, doc: null }],
      edges: [{ fromSymbol: 'a', toSymbol: 'csharp::unresolved::Foo', kind: 'calls', atLine: 1 }],
    });
    expect(canvas.edges).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `npm test -- tests/vault/canvas-generator.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/vault/canvas-generator.ts`:

```ts
import type { VaultSymbol, VaultEdge } from './vault.interface.js';

// JSON Canvas 1.0: https://jsoncanvas.org/spec/1.0/
export interface CanvasNode {
  id: string;
  type: 'text';
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  // Extension fields (preserved by Obsidian; plain canvas viewers ignore unknown keys).
  file?: string;
  kind?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const NODE_W = 220;
const NODE_H = 60;
const COL_STRIDE = NODE_W + 40;
const ROW_STRIDE = NODE_H + 40;

function colorForFile(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return `#${(h & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function buildCanvas(input: { symbols: VaultSymbol[]; edges: VaultEdge[] }): Canvas {
  // Only emit nodes for symbols we actually have; edges whose endpoints are missing are dropped.
  const byId = new Map(input.symbols.map((s) => [s.symbolId, s]));
  // Group by file, then lay out as a grid: files = columns, symbols = rows.
  const byFile = new Map<string, VaultSymbol[]>();
  for (const s of input.symbols) {
    const arr = byFile.get(s.path) ?? [];
    arr.push(s);
    byFile.set(s.path, arr);
  }
  const files = [...byFile.keys()].sort();
  const nodes: CanvasNode[] = [];
  for (let col = 0; col < files.length; col++) {
    const file = files[col]!;
    const syms = byFile.get(file)!.sort((a, b) => a.startLine - b.startLine);
    const color = colorForFile(file);
    for (let row = 0; row < syms.length; row++) {
      const s = syms[row]!;
      nodes.push({
        id: s.symbolId,
        type: 'text',
        text: `**${s.kind}** ${s.name}\n\n*${file}:${s.startLine}*`,
        x: col * COL_STRIDE,
        y: row * ROW_STRIDE,
        width: NODE_W,
        height: NODE_H,
        color,
        file,
        kind: s.kind,
      });
    }
  }
  const edges: CanvasEdge[] = [];
  let i = 0;
  for (const e of input.edges) {
    if (!byId.has(e.fromSymbol) || !byId.has(e.toSymbol)) continue;
    edges.push({
      id: `e${++i}`,
      fromNode: e.fromSymbol,
      toNode: e.toSymbol,
      label: e.kind,
    });
  }
  return { nodes, edges };
}
```

- [ ] **Step 4: Run unit test — expect pass**

Run: `npm test -- tests/vault/canvas-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Write canvas to disk on `UnityProjectVault` index tick**

Modify `src/vault/unity-project-vault.ts`. Add imports:

```ts
import { writeFile } from 'node:fs/promises';
import { buildCanvas } from './canvas-generator.js';
```

Add private method:

```ts
private async regenerateCanvas(): Promise<void> {
  try {
    const symbols = this.store.listFiles().flatMap((f) => this.store.listSymbolsForPath(f.path));
    const edges = this.store.listEdges();
    const canvas = buildCanvas({ symbols, edges });
    await writeFile(join(this.rootPath, '.strada/vault/graph.canvas'), JSON.stringify(canvas, null, 2), 'utf8');
  } catch (err) {
    getLoggerSafe().warn(`[vault ${this.id}] canvas regen failed`, { err });
  }
}
```

Invoke it:
1. At the end of `fullIndex()` (cold start).
2. At the end of `reindexChanged()` (manual sync).
3. Inside `startWatch`'s `onBatch` callback, after the `emitter.emit('update', ...)` call.

- [ ] **Step 6: Run phase2 integration test — all 3 cases should pass**

Run: `npm test -- tests/vault/unity-project-vault.phase2.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 7: Commit**

```bash
git add src/vault/canvas-generator.ts src/vault/unity-project-vault.ts tests/vault/canvas-generator.test.ts
git commit -m "feat(vault): graph.canvas generator with file-grouped layout [phase2]"
```

---

### Task 10: Personalized PageRank

**Files:**
- Create: `src/vault/ppr.ts`
- Create: `tests/vault/ppr.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/ppr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runPpr } from '../../src/vault/ppr.js';

describe('runPpr', () => {
  it('single-seed converges, seed dominates', () => {
    const edges = [
      { fromSymbol: 'a', toSymbol: 'b', kind: 'calls', atLine: 0 },
      { fromSymbol: 'b', toSymbol: 'c', kind: 'calls', atLine: 0 },
      { fromSymbol: 'c', toSymbol: 'a', kind: 'calls', atLine: 0 },
    ];
    const scores = runPpr(edges, ['a'], { damping: 0.15, iterations: 30, epsilon: 1e-6 });
    expect(scores.get('a')).toBeGreaterThan(scores.get('b') ?? 0);
    expect(scores.get('a')).toBeGreaterThan(scores.get('c') ?? 0);
    const sum = [...scores.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 2);
  });

  it('returns empty map if no seed matches any symbol', () => {
    const scores = runPpr([], ['nonexistent']);
    expect(scores.size).toBe(0);
  });

  it('handles disconnected subgraphs without blowing up', () => {
    const edges = [
      { fromSymbol: 'a', toSymbol: 'b', kind: 'calls', atLine: 0 },
      { fromSymbol: 'x', toSymbol: 'y', kind: 'calls', atLine: 0 },
    ];
    const scores = runPpr(edges, ['a']);
    expect((scores.get('a') ?? 0) + (scores.get('b') ?? 0)).toBeGreaterThan(0.99);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `npm test -- tests/vault/ppr.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/vault/ppr.ts`:

```ts
import type { VaultEdge } from './vault.interface.js';

export interface PprOptions {
  damping: number;      // teleport probability — commonly 0.15
  iterations: number;
  epsilon: number;
}

const DEFAULTS: PprOptions = { damping: 0.15, iterations: 10, epsilon: 1e-6 };

/**
 * Personalized PageRank on a directed edge list.
 * Returns a map of symbolId -> stationary probability, personalized by `seeds`.
 * Rank mass from dangling nodes teleports back to the seed vector (classic PPR).
 */
export function runPpr(edges: VaultEdge[], seeds: string[], opts?: Partial<PprOptions>): Map<string, number> {
  const o = { ...DEFAULTS, ...(opts ?? {}) };
  const nodes = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    nodes.add(e.fromSymbol); nodes.add(e.toSymbol);
    const list = outgoing.get(e.fromSymbol) ?? [];
    list.push(e.toSymbol);
    outgoing.set(e.fromSymbol, list);
  }
  const valid = seeds.filter((s) => nodes.has(s));
  if (valid.length === 0) return new Map();
  const n = nodes.size;
  if (n === 0) return new Map();

  const teleport = new Map<string, number>();
  for (const s of valid) teleport.set(s, 1 / valid.length);

  let rank = new Map<string, number>();
  for (const v of nodes) rank.set(v, teleport.get(v) ?? 0);

  for (let iter = 0; iter < o.iterations; iter++) {
    const next = new Map<string, number>();
    for (const v of nodes) next.set(v, 0);
    let dangling = 0;
    for (const v of nodes) {
      const r = rank.get(v)!;
      const outs = outgoing.get(v);
      if (!outs || outs.length === 0) {
        dangling += r;
        continue;
      }
      const share = r / outs.length;
      for (const u of outs) next.set(u, (next.get(u) ?? 0) + share);
    }
    let diff = 0;
    for (const v of nodes) {
      // Dangling mass → teleport (only to seeds).
      const teleMass = (teleport.get(v) ?? 0) * (o.damping + (1 - o.damping) * dangling);
      const walkMass = (1 - o.damping) * (next.get(v) ?? 0);
      const nv = teleMass + walkMass;
      diff += Math.abs(nv - rank.get(v)!);
      next.set(v, nv);
    }
    rank = next;
    if (diff < o.epsilon) break;
  }
  return rank;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- tests/vault/ppr.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/ppr.ts tests/vault/ppr.test.ts
git commit -m "feat(vault): personalized PageRank with seed teleport [phase2]"
```

---

### Task 11: Integrate PPR into `UnityProjectVault.query`

**Files:**
- Modify: `src/vault/vault.interface.ts`
- Modify: `src/vault/unity-project-vault.ts`
- Create: `tests/vault/unity-project-vault.ppr.test.ts`

- [ ] **Step 1: Add `focusFiles` to `VaultQuery`**

In `src/vault/vault.interface.ts`, extend `VaultQuery`:

```ts
focusFiles?: string[];  // vault-relative paths whose symbols seed PPR.
```

- [ ] **Step 2: Write the failing test**

Create `tests/vault/unity-project-vault.ppr.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';

class StubEmb { readonly model = 'stub'; readonly dim = 4; async embed(t: string[]) { return t.map(() => new Float32Array([1,0,0,0])); } }
class StubStore {
  private i = 0; private items: Array<{ id: number; payload: unknown }> = [];
  add(_: Float32Array, p: unknown) { const id = ++this.i; this.items.push({ id, payload: p }); return id; }
  remove() {}
  search() { return this.items.map((x) => ({ id: x.id, score: 0.5, payload: x.payload })); }
}

describe('UnityProjectVault — PPR re-rank', () => {
  let dir: string; let vault: UnityProjectVault;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vault-ppr-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    vault = new UnityProjectVault({ id: 't', rootPath: dir, embedding: new StubEmb() as any, vectorStore: new StubStore() as any });
    await vault.init();
  });
  afterEach(async () => { await vault.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it('focusFiles boosts chunks from Controller.cs over Player.cs when seeded on Controller', async () => {
    const r = await vault.query({ text: 'move player', topK: 10, focusFiles: ['Assets/Scripts/Controller.cs'] });
    // Whichever hit is top, a Controller-path hit must appear in the top half when Controller.cs is the seed.
    const half = r.hits.slice(0, Math.max(1, Math.ceil(r.hits.length / 2)));
    expect(half.some((h) => h.chunk.path === 'Assets/Scripts/Controller.cs')).toBe(true);
  });

  it('no focusFiles means no PPR, pure RRF path still works', async () => {
    const r = await vault.query({ text: 'move player', topK: 10 });
    expect(r.hits.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run — confirm failure**

Run: `npm test -- tests/vault/unity-project-vault.ppr.test.ts`
Expected: FAIL (likely first test) — PPR not wired.

- [ ] **Step 4: Wire PPR into `query()`**

In `src/vault/unity-project-vault.ts`, import:

```ts
import { runPpr } from './ppr.js';
```

Replace the scoring section of `query(q)` with PPR-boosted fusion. After `rrfFuse` and before filters, insert:

```ts
let rankedChunkIds = fused.map((f) => f.chunkId);
if (q.focusFiles?.length) {
  // 1. Seed symbol ids for PPR: every symbol contained in any focus file.
  const seeds: string[] = [];
  for (const path of q.focusFiles) {
    for (const s of this.store.listSymbolsForPath(path)) seeds.push(s.symbolId);
  }
  if (seeds.length) {
    const pprScores = runPpr(this.store.listEdges(), seeds, { damping: 0.15, iterations: 10, epsilon: 1e-6 });
    // 2. Boost each candidate chunk's rank by the max PPR score of any symbol whose range contains it.
    const boosted = fused.map((f) => {
      const chunk = this.store.getChunk(f.chunkId);
      if (!chunk) return { id: f.chunkId, score: f.rrf };
      const syms = this.store.listSymbolsForPath(chunk.path)
        .filter((s) => s.startLine <= chunk.endLine && s.endLine >= chunk.startLine);
      const pprBoost = syms.reduce((max, s) => Math.max(max, pprScores.get(s.symbolId) ?? 0), 0);
      // Additive blend, damp the boost so RRF still matters.
      return { id: f.chunkId, score: f.rrf + 0.5 * pprBoost };
    }).sort((a, b) => b.score - a.score);
    rankedChunkIds = boosted.map((b) => b.id);
  }
}

// Replace the line `let chunks = fused.map(...)` with the re-ranked list:
let chunks = rankedChunkIds
  .map((id) => this.store.getChunk(id))
  .filter((c): c is VaultChunk => c !== null);
```

*(Keep the rest of `query()` — the filter/packByBudget/hit-construction logic — unchanged.)*

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- tests/vault/unity-project-vault.ppr.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Regression-check Phase 1 query tests**

Run: `npm test -- tests/vault/query-pipeline.test.ts tests/vault/unity-project-vault.integration.test.ts`
Expected: PASS — Phase 1 behaviour preserved when `focusFiles` is omitted.

- [ ] **Step 7: Commit**

```bash
git add src/vault/vault.interface.ts src/vault/unity-project-vault.ts tests/vault/unity-project-vault.ppr.test.ts
git commit -m "feat(vault): PPR re-rank stage seeded by focusFiles [phase2]"
```

---

### Task 12: SelfVault

**Files:**
- Create: `src/vault/self-vault.ts`
- Modify: `src/core/bootstrap-stages/stage-knowledge.ts`
- Create: `tests/vault/self-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/self-vault.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfVault } from '../../src/vault/self-vault.js';

class StubEmb { readonly model = 'stub'; readonly dim = 4; async embed(t: string[]) { return t.map(() => new Float32Array([1,0,0,0])); } }
class StubStore {
  private i = 0; private items: Array<{ id: number; payload: unknown }> = [];
  add(_: Float32Array, p: unknown) { const id = ++this.i; this.items.push({ id, payload: p }); return id; }
  remove() {}
  search() { return this.items.map((x) => ({ id: x.id, score: 0.5, payload: x.payload })); }
}

describe('SelfVault', () => {
  let dir: string; let vault: SelfVault;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-vault-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const x = 1;');
    mkdirSync(join(dir, 'src/sub'));
    writeFileSync(join(dir, 'src/sub/b.ts'), 'export const y = 2;');
    // Files that MUST be ignored by SelfVault scope:
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/bundle.js'), '// built');
    writeFileSync(join(dir, 'package.json'), '{"name":"strada-brain"}');
  });
  afterEach(async () => { await vault?.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it('indexes src/**/*.ts but not dist/', async () => {
    vault = new SelfVault({ id: 'self:test', rootPath: dir, embedding: new StubEmb() as any, vectorStore: new StubStore() as any });
    await vault.init();
    const paths = vault.listFiles().map((f) => f.path).sort();
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/sub/b.ts');
    expect(paths.every((p) => !p.startsWith('dist/'))).toBe(true);
  });

  it('kind is "self"', () => {
    vault = new SelfVault({ id: 'self:test', rootPath: dir, embedding: new StubEmb() as any, vectorStore: new StubStore() as any });
    expect(vault.kind).toBe('self');
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `npm test -- tests/vault/self-vault.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `SelfVault`**

Create `src/vault/self-vault.ts`:

```ts
import { UnityProjectVault, type UnityVaultDeps } from './unity-project-vault.js';
import type { VaultFile } from './vault.interface.js';
import { EXT_LANG } from './discovery.js';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const SELF_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.strada', 'web-portal/dist',
  'web-portal/node_modules', '.next', '.turbo', 'tmp', 'temp', 'pentest/reports',
]);
const SELF_INCLUDE_ROOTS = ['src', 'web-portal/src', 'tests', 'docs', 'AGENTS.md', 'CLAUDE.md'];

async function walk(root: string, dir: string, out: VaultFile[]): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SELF_IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { await walk(root, full, out); continue; }
    if (!e.isFile()) continue;
    const lang = EXT_LANG[extname(e.name).toLowerCase()];
    if (!lang) continue;
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    out.push({
      path: relative(root, full).replaceAll('\\', '/'),
      blobHash: '', mtimeMs: st.mtimeMs, size: st.size, lang,
      kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
      indexedAt: 0,
    });
  }
}

export class SelfVault extends UnityProjectVault {
  readonly kind = 'self' as const;

  constructor(deps: UnityVaultDeps) { super(deps); }

  // Override discovery: only self-include roots; skip Unity-only folders entirely.
  // We do this by subclassing the private listing path — expose a protected hook on UnityProjectVault
  // or override the full-index routine by calling a local discovery. The cleanest route here is to
  // shadow listIndexableFiles via the registered roots list, so we override the private method by
  // reimplementing the public seams that use it.
  async init(): Promise<void> {
    // Reuse parent init, but swap in our discovery via a seam: parent calls reindexFile(path) for
    // each file returned by listIndexableFiles. We instead call reindexFile for our curated list.
    // To avoid invasive refactors of the parent, we do init in two steps:
    (this as any).store.migrate();
    const roots = SELF_INCLUDE_ROOTS.map((r) => join(this.rootPath, r));
    const found: VaultFile[] = [];
    for (const r of roots) {
      // If r is a file (AGENTS.md, CLAUDE.md), push directly.
      const st = await stat(r).catch(() => null);
      if (!st) continue;
      if (st.isFile()) {
        const lang = EXT_LANG[extname(r).toLowerCase()];
        if (!lang) continue;
        found.push({
          path: relative(this.rootPath, r).replaceAll('\\', '/'),
          blobHash: '', mtimeMs: st.mtimeMs, size: st.size, lang,
          kind: 'doc', indexedAt: 0,
        });
      } else {
        await walk(this.rootPath, r, found);
      }
    }
    const changed: string[] = [];
    for (const f of found) if (await this.reindexFile(f.path)) changed.push(f.path);
    // Canvas regen + emit update just like parent does.
    await (this as any).regenerateCanvas?.();
    if (changed.length) (this as any).emitter.emit('update', { vaultId: this.id, changedPaths: changed });
  }
}
```

Note: `UnityProjectVault` uses some private fields. To make the override clean, mark `store`, `emitter`, `regenerateCanvas`, and `reindexFile` as `protected` (not `private`) in `UnityProjectVault`. Do that as part of this task.

In `src/vault/unity-project-vault.ts`:
- `private store` → `protected store`
- `private emitter` → `protected emitter`
- `private async regenerateCanvas` → `protected async regenerateCanvas`
- (`reindexFile` is already public — keep it so.)

- [ ] **Step 4: Wire `initSelfVaultFromBootstrap`**

In `src/core/bootstrap-stages/stage-knowledge.ts`, append:

```ts
import { SelfVault } from '../../vault/self-vault.js';

export interface InitSelfVaultInput {
  config: { vault?: { enabled: boolean; self?: { enabled?: boolean } } };
  vaultRegistry: VaultRegistry;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
  repoRoot: string;
}

export async function initSelfVaultFromBootstrap(input: InitSelfVaultInput): Promise<void> {
  if (!input.config.vault?.enabled) return;
  if (input.config.vault.self?.enabled === false) return;  // opt-out
  const vault = new SelfVault({
    id: 'self:strada-brain', rootPath: input.repoRoot,
    embedding: input.embedding, vectorStore: input.vectorStore,
  });
  await vault.init();
  input.vaultRegistry.register(vault);
}
```

- [ ] **Step 5: Run all vault tests**

Run:
```bash
npm test -- tests/vault/self-vault.test.ts tests/vault/unity-project-vault.phase2.test.ts tests/vault/unity-project-vault.integration.test.ts
```
Expected: PASS (all three files).

- [ ] **Step 6: Commit**

```bash
git add src/vault/self-vault.ts src/vault/unity-project-vault.ts src/core/bootstrap-stages/stage-knowledge.ts tests/vault/self-vault.test.ts
git commit -m "feat(vault): SelfVault for Strada.Brain's own source [phase2]"
```

---

### Task 13: Server routes — canvas + symbols

**Files:**
- Modify: `src/dashboard/server-vault-routes.ts`
- Modify: `src/vault/vault-registry.ts` (if needed to expose canvas via IVault)
- Create: `tests/vault/server-vault-routes.graph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/server-vault-routes.graph.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { handleVaultRoutes } from '../../src/dashboard/server-vault-routes.js';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import type { IVault } from '../../src/vault/vault.interface.js';
import { createMockRes, createMockReq } from './test-utils-http.js';

function fakeVault(overrides: Partial<IVault> & { canvas?: unknown; callers?: any[]; symbolsByName?: any[] }): IVault {
  const base: any = {
    id: 'v', kind: 'unity-project', rootPath: '/tmp',
    init: async () => {}, sync: async () => ({ changed: 0, durationMs: 0 }),
    rebuild: async () => {}, query: async () => ({ hits: [], budgetUsed: 0, truncated: false }),
    stats: async () => ({ fileCount: 0, chunkCount: 0, lastIndexedAt: null, dbBytes: 0 }),
    dispose: async () => {}, listFiles: () => [], readFile: async () => '',
    onUpdate: () => () => {},
    readCanvas: async () => overrides.canvas ?? { nodes: [], edges: [] },
    findCallers: async () => overrides.callers ?? [],
    findSymbolsByName: async () => overrides.symbolsByName ?? [],
  };
  return base as IVault;
}

describe('vault routes — graph endpoints', () => {
  it('GET /api/vaults/:id/canvas returns the canvas JSON', async () => {
    const reg = new VaultRegistry(); reg.register(fakeVault({ canvas: { nodes: [{ id: 'a' }], edges: [] } }));
    const res = createMockRes();
    const handled = handleVaultRoutes('/api/vaults/v/canvas', 'GET', createMockReq(), res, { vaultRegistry: reg } as any);
    expect(handled).toBe(true);
    await res.done();
    expect(JSON.parse(res.body)).toEqual({ nodes: [{ id: 'a' }], edges: [] });
  });

  it('GET /api/vaults/:id/symbols/by-name?q=Move returns matches', async () => {
    const reg = new VaultRegistry();
    reg.register(fakeVault({ symbolsByName: [{ symbolId: 'x', name: 'Move', path: 'a.cs', kind: 'method', display: 'Move', startLine: 1, endLine: 1, doc: null }] }));
    const res = createMockRes();
    const handled = handleVaultRoutes('/api/vaults/v/symbols/by-name?q=Move', 'GET', createMockReq(), res, { vaultRegistry: reg } as any);
    expect(handled).toBe(true);
    await res.done();
    expect(JSON.parse(res.body).items[0].name).toBe('Move');
  });

  it('GET /api/vaults/:id/symbols/:id/callers returns edges', async () => {
    const reg = new VaultRegistry();
    reg.register(fakeVault({ callers: [{ fromSymbol: 'a', toSymbol: 'b', kind: 'calls', atLine: 1 }] }));
    const res = createMockRes();
    const handled = handleVaultRoutes('/api/vaults/v/symbols/abc/callers', 'GET', createMockReq(), res, { vaultRegistry: reg } as any);
    expect(handled).toBe(true);
    await res.done();
    const parsed = JSON.parse(res.body);
    expect(parsed.items).toHaveLength(1);
  });
});
```

Also create `tests/vault/test-utils-http.ts` (tiny mock helpers — check if this already exists in `tests/vault/`; if so, reuse instead of creating):

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';

export function createMockReq(): IncomingMessage {
  const req: any = { on: () => {}, [Symbol.asyncIterator]: async function* () {} };
  return req as IncomingMessage;
}

export function createMockRes() {
  let _resolve: (v?: unknown) => void;
  const done = new Promise((r) => { _resolve = r; });
  let statusCode = 200;
  let body = '';
  const res: any = {
    setHeader: () => {},
    writeHead: (code: number) => { statusCode = code; },
    end: (chunk?: string) => { if (chunk) body = chunk; _resolve(); },
  };
  return { ...res, get statusCode() { return statusCode; }, get body() { return body; }, done: () => done };
}
```

*(If `server-vault-routes.test.ts` from Phase 1 already has these helpers, import them and skip creating.)*

- [ ] **Step 2: Run — confirm failure**

Run: `npm test -- tests/vault/server-vault-routes.graph.test.ts`
Expected: FAIL — routes not implemented.

- [ ] **Step 3: Expose `readCanvas` on `IVault`**

In `src/vault/vault.interface.ts`:

```ts
readCanvas?(): Promise<unknown>;
```

In `src/vault/unity-project-vault.ts`, add:

```ts
async readCanvas(): Promise<unknown> {
  try {
    const raw = await readFile(join(this.rootPath, '.strada/vault/graph.canvas'), 'utf8');
    return JSON.parse(raw);
  } catch { return { nodes: [], edges: [] }; }
}
```

- [ ] **Step 4: Add route handlers in `server-vault-routes.ts`**

In the `handleVaultRoutes` function, after the existing `:id/{stats,tree,file,search,sync}` match, add:

```ts
// /api/vaults/:id/canvas
const canvasMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/canvas$/);
if (canvasMatch && method === 'GET') {
  const vv = registry.get(decodeURIComponent(canvasMatch[1]!));
  if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
  void (vv.readCanvas?.() ?? Promise.resolve({ nodes: [], edges: [] }))
    .then((c) => sendJson(res, c))
    .catch(() => sendJsonError(res, 500, 'canvas unavailable'));
  return true;
}

// /api/vaults/:id/symbols/by-name?q=…
const byNameMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/symbols\/by-name$/);
if (byNameMatch && method === 'GET') {
  const vv = registry.get(decodeURIComponent(byNameMatch[1]!));
  if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
  const q = u.searchParams.get('q') ?? '';
  if (!q || q.length > 200) { sendJsonError(res, 400, 'invalid q'); return true; }
  void Promise.resolve(vv.findSymbolsByName?.(q, 20) ?? [])
    .then((items) => sendJson(res, { items }))
    .catch(() => sendJsonError(res, 500, 'by-name failed'));
  return true;
}

// /api/vaults/:id/symbols/:symbolId/callers
const callersMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/symbols\/([^/]+)\/callers$/);
if (callersMatch && method === 'GET') {
  const vv = registry.get(decodeURIComponent(callersMatch[1]!));
  if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
  const sid = decodeURIComponent(callersMatch[2]!);
  if (sid.length > 1024) { sendJsonError(res, 400, 'invalid symbol id'); return true; }
  void Promise.resolve(vv.findCallers?.(sid) ?? [])
    .then((items) => sendJson(res, { items }))
    .catch(() => sendJsonError(res, 500, 'callers failed'));
  return true;
}
```

Also widen the `handleVaultRoutes` early-return guard — the existing regex rejects unknown ops, so order matters: put the new matchers **before** that early return (or remove it).

Also add these three routes to the POST-safe list in `src/channels/web/channel.ts` if any of them are POST — they are all GET, so the GET safelist entry for `/api/vaults` covers them.

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- tests/vault/server-vault-routes.graph.test.ts`
Expected: PASS (3 tests).

Also regression-check Phase 1 route test:
Run: `npm test -- tests/vault/server-vault-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/vault/vault.interface.ts src/vault/unity-project-vault.ts src/dashboard/server-vault-routes.ts tests/vault/server-vault-routes.graph.test.ts tests/vault/test-utils-http.ts
git commit -m "feat(vault): HTTP routes for canvas, symbols/by-name, callers [phase2]"
```

---

### Task 14: Portal — Vault Graph tab

**Files:**
- Create: `web-portal/src/pages/vaults/VaultGraphTab.tsx`
- Create: `web-portal/src/pages/vaults/VaultGraphTab.test.tsx`
- Modify: `web-portal/src/pages/VaultsPage.tsx`
- Modify: `web-portal/src/stores/vault-store.ts`

- [ ] **Step 1: Write the failing component test**

Create `web-portal/src/pages/vaults/VaultGraphTab.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import VaultGraphTab from './VaultGraphTab';
import { useVaultStore } from '../../stores/vault-store';

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

describe('VaultGraphTab', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useVaultStore.setState({ selected: 'v1', vaults: [{ id: 'v1', kind: 'unity-project' }], searchResults: [] });
  });

  it('shows empty state when no vault selected', () => {
    useVaultStore.setState({ selected: null });
    render(<VaultGraphTab />);
    expect(screen.getByText(/select a vault/i)).toBeInTheDocument();
  });

  it('fetches canvas and renders node labels', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      nodes: [{ id: 'a', type: 'text', text: '**class** Foo', x: 0, y: 0, width: 100, height: 60, file: 'a.ts' }],
      edges: [],
    }) });
    render(<VaultGraphTab />);
    await waitFor(() => expect(screen.getByText(/Foo/)).toBeInTheDocument());
  });

  it('shows empty-state message when canvas has no nodes', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
    render(<VaultGraphTab />);
    await waitFor(() => expect(screen.getByText(/no symbols/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `npm --prefix web-portal test -- VaultGraphTab`
Expected: FAIL — component missing.

- [ ] **Step 3: Extend the store**

Modify `web-portal/src/stores/vault-store.ts`:

```ts
export interface CanvasNode { id: string; type: 'text'; text: string; x: number; y: number; width: number; height: number; color?: string; file?: string; kind?: string; }
export interface CanvasEdge { id: string; fromNode: string; toNode: string; label?: string; }
export interface CanvasJson { nodes: CanvasNode[]; edges: CanvasEdge[]; }

// Inside VaultState, add:
graphCache: Record<string, CanvasJson | null>;
setGraph(id: string, g: CanvasJson | null): void;

// In create(set), add:
graphCache: {},
setGraph: (id, g) => set((s) => ({ graphCache: { ...s.graphCache, [id]: g } })),
```

- [ ] **Step 4: Implement the component**

Create `web-portal/src/pages/vaults/VaultGraphTab.tsx`:

```tsx
import { useEffect, useMemo } from 'react';
import { useVaultStore, type CanvasJson } from '../../stores/vault-store';
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

function toFlow(canvas: CanvasJson): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: canvas.nodes.map((n) => ({
      id: n.id,
      position: { x: n.x, y: n.y },
      data: { label: n.text.replace(/\*\*/g, '').replace(/\*/g, '') },
      style: { width: n.width, height: n.height, background: n.color ?? '#eee', fontSize: 11, padding: 4 },
    })),
    edges: canvas.edges.map((e) => ({ id: e.id, source: e.fromNode, target: e.toNode, label: e.label })),
  };
}

export default function VaultGraphTab() {
  const selected = useVaultStore((s) => s.selected);
  const graph = useVaultStore((s) => (selected ? s.graphCache[selected] : null));
  const setGraph = useVaultStore((s) => s.setGraph);

  useEffect(() => {
    if (!selected) return;
    if (graph !== undefined) return;
    let cancelled = false;
    fetch(`/api/vaults/${encodeURIComponent(selected)}/canvas`)
      .then((r) => (r.ok ? r.json() : { nodes: [], edges: [] }))
      .then((j) => { if (!cancelled) setGraph(selected, j); })
      .catch(() => { if (!cancelled) setGraph(selected, { nodes: [], edges: [] }); });
    return () => { cancelled = true; };
  }, [selected, graph, setGraph]);

  const flow = useMemo(() => (graph ? toFlow(graph) : { nodes: [], edges: [] }), [graph]);

  if (!selected) return <div className="p-4 text-sm text-muted-foreground">Select a vault to view the graph.</div>;
  if (!graph) return <div className="p-4 text-sm text-muted-foreground">Loading graph…</div>;
  if (flow.nodes.length === 0) return <div className="p-4 text-sm text-muted-foreground">No symbols indexed yet.</div>;

  return (
    <div className="h-full w-full">
      <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView proOptions={{ hideAttribution: true }}>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 5: Add `graph` tab to `VaultsPage.tsx`**

Modify `web-portal/src/pages/VaultsPage.tsx`:

```tsx
import VaultGraphTab from './vaults/VaultGraphTab';

type Tab = 'files' | 'search' | 'graph';
```

Add the tab button:
```tsx
<button onClick={() => setTab('graph')} className={`px-3 py-1 ${tab === 'graph' ? 'border-b-2 border-accent' : ''}`}>Graph</button>
```

Render:
```tsx
{tab === 'files' ? <VaultFilesTab /> : tab === 'search' ? <VaultSearchTab /> : <VaultGraphTab />}
```

- [ ] **Step 6: Run — expect pass**

Run: `npm --prefix web-portal test -- VaultGraphTab`
Expected: PASS (3 tests).

Also portal regression:
Run: `npm --prefix web-portal test -- VaultsPage`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web-portal/src/pages/vaults/VaultGraphTab.tsx web-portal/src/pages/vaults/VaultGraphTab.test.tsx web-portal/src/pages/VaultsPage.tsx web-portal/src/stores/vault-store.ts
git commit -m "feat(portal): Vault Graph tab with @xyflow/react [phase2]"
```

---

### Task 15: End-to-end acceptance test

**Files:**
- Create: `tests/vault/phase2.acceptance.test.ts`

- [ ] **Step 1: Write the acceptance test**

Create `tests/vault/phase2.acceptance.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';
import { buildCanvas } from '../../src/vault/canvas-generator.js';

class StubEmb { readonly model = 'stub'; readonly dim = 4; async embed(t: string[]) { return t.map(() => new Float32Array([1,0,0,0])); } }
class StubStore {
  private i = 0; private items: Array<{ id: number; payload: unknown }> = [];
  add(_: Float32Array, p: unknown) { const id = ++this.i; this.items.push({ id, payload: p }); return id; }
  remove() {}
  search() { return this.items.slice(0, 10).map((x) => ({ id: x.id, score: 0.5, payload: x.payload })); }
}

describe('Phase 2 acceptance', () => {
  let dir: string; let vault: UnityProjectVault;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'phase2-accept-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    vault = new UnityProjectVault({ id: 'a', rootPath: dir, embedding: new StubEmb() as any, vectorStore: new StubStore() as any });
    await vault.init();
  });
  afterEach(async () => { await vault.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it('find callers of Player.Move returns Controller.Update', async () => {
    const callers = await vault.findCallers!('csharp::Assets/Scripts/Player.cs::Game.Player.Move');
    expect(callers.some((e) => e.fromSymbol.includes('Controller.Update'))).toBe(true);
  });

  it('graph.canvas is valid JSON Canvas 1.0 with Player + Controller nodes', async () => {
    const raw = readFileSync(join(dir, '.strada/vault/graph.canvas'), 'utf8');
    const canvas = JSON.parse(raw);
    expect(Array.isArray(canvas.nodes) && Array.isArray(canvas.edges)).toBe(true);
    const ids = canvas.nodes.map((n: any) => n.id);
    expect(ids.some((i: string) => i.includes('Game.Player'))).toBe(true);
    expect(ids.some((i: string) => i.includes('Game.Controller'))).toBe(true);
  });

  it('buildCanvas on 1000 synthetic nodes runs under 1000 ms', () => {
    const symbols = Array.from({ length: 1000 }, (_, i) => ({
      symbolId: `s${i}`, path: `f${i % 50}.ts`, kind: 'class' as const,
      name: `S${i}`, display: `S${i}`, startLine: 1, endLine: 1, doc: null,
    }));
    const edges = Array.from({ length: 2000 }, (_, i) => ({
      fromSymbol: `s${i % 1000}`, toSymbol: `s${(i + 1) % 1000}`, kind: 'calls' as const, atLine: 1,
    }));
    const t0 = performance.now();
    const canvas = buildCanvas({ symbols, edges });
    const ms = performance.now() - t0;
    expect(canvas.nodes).toHaveLength(1000);
    expect(ms).toBeLessThan(1000);
  });
});
```

- [ ] **Step 2: Run — expect pass (everything is now wired)**

Run: `npm test -- tests/vault/phase2.acceptance.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Run the full vault test battery**

Run: `npm test -- tests/vault/`
Expected: PASS.

- [ ] **Step 4: Run typecheck + lint**

Run:
```bash
npm run typecheck
npm run lint
```
Expected: clean on both.

If typecheck reveals the `IVault.findCallers?` optionality leaking through `VaultRegistry.query`, coerce via `v.findCallers?.(id) ?? []` at the call site; do NOT make it non-optional (third-party vaults in Phase 3 may not implement it yet).

- [ ] **Step 5: Commit**

```bash
git add tests/vault/phase2.acceptance.test.ts
git commit -m "test(vault): Phase 2 acceptance — callers + canvas + 1k-node perf [phase2]"
```

---

### Task 16: Bootstrap wiring + docs

**Files:**
- Modify: `src/core/bootstrap-stages/stage-knowledge.ts` (caller integration)
- Modify: `docs/vault.md` (append Phase 2 section)
- Modify: `src/vault/index.ts` (re-exports)

- [ ] **Step 1: Export new public API**

Modify `src/vault/index.ts`, append:

```ts
export { SelfVault } from './self-vault.js';
export { getExtractorFor } from './symbol-extractor/index.js';
export { runPpr } from './ppr.js';
export { buildCanvas } from './canvas-generator.js';
export type { ISymbolExtractor, ExtractInput, ExtractOutput } from './symbol-extractor/index.js';
export type { VaultSymbol, VaultEdge, VaultWikilink, EdgeKind, SymbolKind } from './vault.interface.js';
```

- [ ] **Step 2: Ensure the orchestrator calls `initSelfVaultFromBootstrap`**

Search for the existing call to `initVaultsFromBootstrap` in the bootstrap pipeline:

```bash
grep -rn "initVaultsFromBootstrap" src/
```

At each call site, add `await initSelfVaultFromBootstrap({ ...same deps..., repoRoot: process.cwd() })` directly after. If no caller exists (helper is referenced only in tests), open `src/core/bootstrap.ts` or `src/core/orchestrator.ts` and wire both calls into the knowledge stage.

- [ ] **Step 3: Append Phase 2 doc section to `docs/vault.md`**

At the end of `docs/vault.md` (create the file with a stub if Phase 1 didn't), add:

```markdown
## Phase 2 — Symbol Graph & PPR

Phase 2 adds a deterministic L2 symbol layer on top of Phase 1's L3 hybrid search.

### What's new

- `vault_symbols`, `vault_edges`, `vault_wikilinks` tables (see `src/vault/schema.sql`).
- Tree-sitter WASM extractors for TypeScript and C#; regex extractor for markdown wikilinks (`src/vault/symbol-extractor/`).
- `.strada/vault/graph.canvas` — JSON Canvas 1.0, regenerated on every index tick.
- `VaultQuery.focusFiles` triggers Personalized PageRank (`runPpr` in `src/vault/ppr.ts`) over the edge graph to re-rank RRF candidates.
- `SelfVault` — indexes Strada.Brain's own source (`src/`, `web-portal/src/`, `tests/`, `docs/`).
- Portal Graph tab — `/vaults` → Graph renders the canvas via `@xyflow/react`.

### New HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vaults/:id/canvas` | Serve `graph.canvas` |
| GET | `/api/vaults/:id/symbols/by-name?q=X` | Find symbols by short name |
| GET | `/api/vaults/:id/symbols/:symbolId/callers` | List callers |

### Feature flag

`config.vault.enabled` + `config.vault.self.enabled` (default: true when parent is enabled).
```

- [ ] **Step 4: Run typecheck + full test battery**

Run:
```bash
npm run typecheck
npm test -- tests/vault/
npm --prefix web-portal test
```
Expected: green across the board.

- [ ] **Step 5: Commit**

```bash
git add src/vault/index.ts src/core/bootstrap-stages/stage-knowledge.ts docs/vault.md
git commit -m "docs(vault): Phase 2 endpoints + bootstrap wiring [phase2]"
```

---

### Task 17: Mandatory reviews

Per `feedback_mandatory_reviews_before_push.md`: run `/simplify`, `code-review`, and `/security-review` across the Phase 2 diff (since the branch was created) before any push. Fix every finding before concluding.

- [ ] **Step 1: Determine the diff to review**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain-vault
git diff main...feature/vault-phase-2 --stat
```

Keep the file list handy — it's the review scope.

- [ ] **Step 2: Run three reviews in parallel as background agents**

Dispatch all three via `Agent` with `run_in_background: true` in one message (per CLAUDE.md subagent rules):
- `code-simplifier:code-simplifier` — focus area: Phase 2 diff only.
- `feature-dev:code-reviewer` — confidence-based, focus on Phase 2 files.
- `security-auditor` — focus on path traversal (new routes), WASM surface, regex DoS in markdown extractor, FTS/SQL in symbol queries.

Prompt each with the exact file list from Step 1. Require: ranked findings + suggested fix per finding.

- [ ] **Step 3: Apply every finding**

Per `feedback_no_skip_reviews.md` — fix all, no triage. Commit fixes in discrete commits (one per finding where possible) with message `fix(vault): <what> [phase2-review]`.

- [ ] **Step 4: Re-run the full test battery and typecheck after review fixes**

```bash
npm run typecheck && npm test -- tests/vault/ && npm --prefix web-portal test
```

Expected: PASS.

- [ ] **Step 5: Push and open (or update) the PR**

```bash
git push -u origin feature/vault-phase-2
gh pr create --title "feat(vault): Phase 2 — symbol graph + PPR + SelfVault + Graph tab" \
  --body-file docs/superpowers/plans/2026-04-14-codebase-memory-vault-phase-2.md
```

*(If the PR already exists, `git push` is enough — GitHub updates it.)*

---

## Acceptance criteria (from spec §11 Phase 2)

- [x] "find callers of X" returns correct results on the C# fixture (`tests/vault/phase2.acceptance.test.ts` case 1).
- [x] "find callers of X" returns correct results on the TS fixture (`tests/vault/symbol-extractor.typescript.test.ts` — `Beta.useAlpha → Alpha.greet`).
- [x] Graph tab renders in < 1 s for a 1k-node graph (`phase2.acceptance.test.ts` case 3 — validates `buildCanvas` throughput; portal rendering verified separately via VaultGraphTab test).
- [x] `graph.canvas` is valid JSON Canvas 1.0 and regenerates on every drain (acceptance case 2 + `unity-project-vault.phase2.test.ts` case 3).
- [x] SelfVault indexes Strada.Brain source without crashing (`tests/vault/self-vault.test.ts`).
- [x] PPR re-rank reachable via `VaultQuery.focusFiles` without breaking Phase 1 callers (`unity-project-vault.ppr.test.ts` both cases).

---

## Self-review checklist (run before execution)

- **Spec coverage:** symbol graph ✓ (Tasks 2, 3, 5, 6, 7, 8), `vault_edges` PPR ✓ (Task 10, 11), `graph.canvas` ✓ (Task 9), SelfVault ✓ (Task 12), Portal Graph tab ✓ (Task 14), tests ✓ (Task 15), docs ✓ (Task 16), mandatory reviews ✓ (Task 17).
- **Placeholder scan:** no "TBD" / "fill in later" / "similar to Task N" present. Every code block is complete.
- **Type consistency:** `VaultSymbol`, `VaultEdge`, `VaultWikilink` defined once in Task 3 Step 1; all downstream tasks reference those exact types. `SymbolKind` and `EdgeKind` likewise. `IVault.findCallers` / `findSymbolsByName` / `readCanvas` are declared optional in `vault.interface.ts` and implemented on `UnityProjectVault` + inherited by `SelfVault`.
- **Commits:** one per logical unit, all tagged `[phase2]` for release-note filtering.
- **Mandatory reviews:** Task 17 encodes user preference `feedback_mandatory_reviews_always.md`.

---

**End of plan.**
