# Codebase Memory Vault — Design Spec

**Date**: 2026-04-13
**Status**: Approved (autonomous decisions delegated by user)
**Owner**: Strada.Brain core
**Milestone**: v4.3 (proposed)

---

## 1. Problem & Goals

### Problem

`StradaKnowledge.buildProjectContext()` is called on every `Orchestrator.execute()` and rebuilds codebase context from scratch. The framework knowledge layer covers only `core|modules|mcp` (hardcoded `FrameworkPackageId`), has no semantic search, and omits docstrings/examples/lifecycle detail. The user's Unity project — the primary thing Strada.Brain is supposed to help with — is not indexed at all. Every user request re-reads files via Glob/Grep/Read, spending tokens and latency on information that rarely changes between turns.

### Goals

1. **Token + latency reduction**: replace request-time codebase re-reading with vault-backed retrieval. Target: p50 context-assembly time ≤150 ms (today: 2–5 s), p50 context tokens ≤40 % of current.
2. **Freshness guarantee**: when code changes (user edits in IDE, Strada.Brain writes via tools, git pull), the vault reflects it before the next turn starts.
3. **Human-readable + portable**: vault artifacts survive without Strada.Brain. User can open markdown in any editor, visualize `.canvas` in Obsidian, and diff/merge via git.
4. **Multi-vault**: three vault types coexisting — framework (extended), user's Unity project (new), Strada.Brain's own source (new).
5. **Bidirectional learning coupling**: vault feeds learning-pipeline with pattern seeds; learning feeds vault with refined pattern notes. Loose coupling via event bus — neither depends on the other's internals.
6. **Zero new persistence surface**: extend AgentDB (SQLite) rather than add LanceDB/Qdrant/SurrealDB.

### Non-goals (YAGNI)

- Vault-as-a-product (public publishing) — deferred; Quartz can be added later.
- Collaborative real-time vault sync between multiple Strada.Brain instances — deferred.
- Time-travel / version history on every chunk — deferred; git handles it for markdown.
- Plugin API for third-party vault kinds — deferred.
- C++ / non-C# Unity native code parsing — deferred; C# + shader (HLSL) covered only if cheap.

---

## 2. High-Level Architecture

```
                     ┌──────────────────────────────┐
                     │       Strada.Brain            │
                     │                               │
 User request ─► Orchestrator.execute()              │
                     │                               │
                     ├─► VaultRegistry.query(q, ctx) │
                     │        │                      │
                     │        ├─► FrameworkVault     │  (existing, extended)
                     │        ├─► UnityProjectVault  │  (new, per-project)
                     │        └─► SelfVault          │  (new)
                     │                               │
                     │   each IVault =               │
                     │     storage: SQLite           │
                     │     markdown+.canvas: <root>/.strada/vault/
                     │     indexer: tree-sitter + Merkle
                     │     watcher: chokidar + write-hook
                     │                               │
                     └─► Learning Pipeline ◄──┐      │
                                 │            │      │
                                 └─ event-bus ┘      │
                                                     │
                     ═══════════ WebSocket ═══════════
                                                     │
                           Web Portal /vaults        │
                             - list + status         │
                             - file tree + md view   │
                             - graph (d3/cytoscape)  │
                             - semantic search       │
```

### Invariants

- **Markdown is source of truth.** SQLite is a derived cache. Deleting `.strada/vault/*.db` MUST be recoverable by re-running `/vault rebuild`.
- **One SQLite file per vault.** No cross-vault joins. `vault_id` is implicit (per-db) not a column.
- **Every chunk has a content hash** (blake3 / xxhash). No chunk is re-embedded while its hash is unchanged.
- **Write-hooks are synchronous.** When Strada.Brain writes a file via Edit/Write tool, the affected chunks are reindexed **before the tool returns**. No stale-context window for the next turn.

---

## 3. Vault Types

### 3.1 FrameworkVault (existing, extended)

**Location**: `~/.strada/vaults/framework/` (moved from current `framework_snapshots` SQLite). Symlinked markdown mirror at same dir.

**Coverage**: Strada.Core, Strada.Modules, Strada.MCP, plus future Strada packages. `FrameworkPackageId` generalized from union type to `string`; driven by `FrameworkPackageConfig[]` (loaded from `framework-package-configs.ts`, dynamically extendable).

**Depth**:
- L2 symbols (C# AST via tree-sitter-c-sharp; current extractor retained)
- L3 embeddings + FTS5 (**new** — currently text-lookup only)
- L4 docstring + usage example summaries (**new** — Haiku pass on XML doc comments + sample code)
- L1 curated ADRs (**new** — framework design decisions, capability manifests)

**Update**: git shallow-clone diff on startup + hourly (existing `bootSync` + `startWatcher`). No file-watcher on external packages (they're read-only).

### 3.2 UnityProjectVault (new, per-project)

**Location**: `<unity-project>/.strada/vault/`
- `index.db` — SQLite (chunks/symbols/edges/hashes/summaries)
- `codebase/*.md` — auto-generated per-module markdown summaries
- `decisions/*.md` — curated ADRs / design notes (by agent or user)
- `memory/*.md` — session-specific observations about this project
- `graph.canvas` — dependency graph in JSON Canvas format

**Coverage**: all `.cs`, `.cginc`, `.shader`, `.json` (manifest/prefab meta), `.md` under user-provided project roots (Assets/, Packages/, ProjectSettings/).

**Depth**: full L1+L2+L3+L4.

**Update**: chokidar watcher + Strada.Brain write-hook + `/vault sync` manual. Merkle tree + xxhash per-file; dirty set diffed on every tick.

**Lifecycle**: created on first `/vault init` or first time Strada.Brain opens a Unity project path not seen before. `.gitignore` receives `.strada/vault/index.db` by default (markdown is gitable, db is derived). User can opt-in to commit the db with a flag.

### 3.3 SelfVault (new)

**Location**: `~/.strada/self-vault/` (also mirrored at `<strada-brain-repo>/.strada/self-vault/` when developing Strada.Brain itself).

**Coverage**: `src/`, `web-portal/src/`, `tests/`, `docs/architecture.md`, `docs/web-channel.md`, `AGENTS.md`, `CLAUDE.md`, `memory/`.

**Depth**: L2 + L3 (enough for self-diagnosis). L1 curated notes come from existing `CLAUDE.md` and `memory/MEMORY.md` (no duplication). L4 only for top-level modules (provider/, agents/, memory/, rag/).

**Update**: chokidar watcher on Strada.Brain source + write-hook when agent edits own code (rare but real for self-improvement flows).

**Lifecycle**: built on first boot if absent. Useful answers: "which file handles X?", "what tools does the agent expose?", "what provider did we use last time for Y?".

---

## 4. Storage Schema (per-vault SQLite)

```sql
-- files tracked in the vault
CREATE TABLE vault_files (
  path        TEXT PRIMARY KEY,      -- relative to vault root
  blob_hash   TEXT NOT NULL,          -- xxhash64 of contents
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  lang        TEXT NOT NULL,          -- 'csharp' | 'typescript' | 'markdown' | 'json' | 'hlsl'
  kind        TEXT NOT NULL,          -- 'source' | 'test' | 'doc' | 'config'
  indexed_at  INTEGER NOT NULL,
  merkle_dir  TEXT NOT NULL           -- hash of parent dir, for subtree invalidation
);

-- chunk-level entries (400-token windows, heading-aware for md)
CREATE TABLE vault_chunks (
  chunk_id    TEXT PRIMARY KEY,       -- blake3(path + offset + content)
  path        TEXT NOT NULL REFERENCES vault_files(path) ON DELETE CASCADE,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL
);

CREATE VIRTUAL TABLE vault_chunks_fts USING fts5(
  content, chunk_id UNINDEXED, path UNINDEXED,
  tokenize = 'porter unicode61'
);

-- embeddings (reuses existing HNSW store; here just a pointer)
CREATE TABLE vault_embeddings (
  chunk_id    TEXT PRIMARY KEY REFERENCES vault_chunks(chunk_id) ON DELETE CASCADE,
  hnsw_id     INTEGER NOT NULL,       -- id inside the HNSW index
  dim         INTEGER NOT NULL,
  model       TEXT NOT NULL
);

-- symbol graph (tree-sitter extracted; SCIP-shaped)
CREATE TABLE vault_symbols (
  symbol_id   TEXT PRIMARY KEY,       -- 'csharp . MyNs . MyClass # MyMethod(int)'
  path        TEXT NOT NULL REFERENCES vault_files(path) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- 'class' | 'method' | 'field' | 'namespace' | 'function' | 'interface'
  name        TEXT NOT NULL,
  display     TEXT NOT NULL,          -- human signature
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  doc         TEXT                    -- xml doc comment / jsdoc / leading block comment
);

CREATE TABLE vault_edges (
  from_symbol TEXT NOT NULL REFERENCES vault_symbols(symbol_id) ON DELETE CASCADE,
  to_symbol   TEXT NOT NULL,          -- may be unresolved extern
  kind        TEXT NOT NULL,          -- 'calls' | 'references' | 'inherits' | 'implements' | 'imports' | 'embeds'
  at_line     INTEGER,
  PRIMARY KEY (from_symbol, to_symbol, kind, at_line)
);

CREATE INDEX idx_edges_to ON vault_edges(to_symbol);

-- rolling summaries (per-file, per-directory)
CREATE TABLE vault_summaries (
  scope       TEXT PRIMARY KEY,       -- 'file:Assets/Scripts/Player.cs' or 'dir:Assets/Scripts/'
  content     TEXT NOT NULL,          -- ≤200 tokens
  content_hash TEXT NOT NULL,         -- blake3 of input content used to generate this
  model       TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  generated_at INTEGER NOT NULL
);

-- curated notes index (L1)
CREATE TABLE vault_notes (
  note_id     TEXT PRIMARY KEY,       -- relative md path under decisions/ or memory/
  title       TEXT NOT NULL,
  tags        TEXT,                   -- json array
  frontmatter TEXT,                   -- raw YAML
  body_chunks TEXT                    -- json array of chunk_ids
);

-- pointer to wikilink targets (for graph expansion and validity)
CREATE TABLE vault_wikilinks (
  from_note   TEXT NOT NULL,
  target      TEXT NOT NULL,          -- resolved symbol_id OR note_id OR file path OR unresolved label
  resolved    INTEGER NOT NULL        -- 0 / 1
);
```

### Markdown convention

- `codebase/<module-path>.md` — auto-generated. Frontmatter:
  ```yaml
  ---
  kind: codebase-summary
  path: Assets/Scripts/Player.cs
  symbols: [Player, Player.Move, Player.Jump]
  imports: [UnityEngine, Strada.Core.Input]
  hash: <xxhash64>
  tokens: 156
  generated_by: haiku-4.5
  generated_at: 2026-04-13T12:00:00Z
  ---
  ```
  Body: 150–200-token prose summary + symbol bullet list + wikilinks to dependencies.

- `decisions/*.md` — ADR-style, curated by agent or user. Wikilinks mandatory.
- `memory/*.md` — append-only session notes, grouped by date.
- `graph.canvas` — JSON Canvas 1.0 (https://jsoncanvas.org/), auto-regenerated from `vault_edges`, 1 node per file/symbol.

---

## 5. Four Layers

**L1 — Curated notes** (`decisions/`, `memory/`): hand-written or agent-authored markdown; always included in context for anchoring/provenance. Low volume (≤50 notes typical).

**L2 — Symbol graph** (tree-sitter extraction → `vault_symbols` + `vault_edges`): deterministic, fast, no LLM cost. Enables "find all callers of X", "what imports Y". Serves Aider-style personalized PageRank for context packing.

**L3 — Embedding + FTS5 hybrid**: every chunk indexed in both HNSW (semantic) and FTS5 (lexical). Query uses Reciprocal Rank Fusion (RRF, k=60) to combine the two ranked lists. Filters: `lang`, `kind`, `path_glob`.

**L4 — Rolling summaries** (`vault_summaries`): Haiku (claude-haiku-4-5-20251001) generates ≤200-token summary per file and per top-level dir. Regenerated only when file hash changes (invalidation cascade: file → dir). Serves "explain this module" queries without touching raw source.

---

## 6. Indexing Pipeline

### Cold start (`/vault init` or first boot)

```
1. discover(roots)                → list of files matching lang patterns
2. hash(file) via xxhash64         → vault_files rows + merkle_dir precomputed
3. parse(tree-sitter)              → vault_symbols + vault_edges
4. chunk(file, 400 tokens, heading-aware)
                                   → vault_chunks + vault_chunks_fts insert
5. embed(chunk, batch=32)          → vault_embeddings (via existing AgentDB HNSW)
6. summarize(file, haiku)          → vault_summaries (parallel, bounded 4-way)
7. generate(codebase/*.md)         → Obsidian-visible markdown mirrors
8. regenerate(graph.canvas)        → node+edge JSON
9. VaultRegistry.emit('ready', vault_id)
```

Cold start budget for a 1000-file Unity project: target ≤60 s with local embedding fallback, ≤120 s with cloud embedding (batched).

### Incremental (watcher + write-hook)

- `chokidar` with `awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }`.
- Every 800 ms, drain dirty-set:
  1. `xxhash` changed files.
  2. For each file whose hash changed: delete dependent rows (cascading FK), re-parse, re-chunk, re-embed, re-summarize.
  3. For each file whose parent-dir aggregate hash changed: re-summarize the dir.
  4. Emit `vault:update` event → Learning bridge + Portal WS.
- **Write-hook**: `Orchestrator.tools.Edit` / `Write` wrap `fs.writeFile` → on success, queue synchronous reindex for that one file (bypassing debounce).
- **Backpressure**: indexing pipeline behind `p-queue` with concurrency 4; embedding calls further gated by existing provider rate limiters.

### Invalidation rules

- File deleted → cascade via FK on `vault_files.path`.
- File renamed → detected as delete + create (chokidar emits both); symbol-level diff is best-effort (out of scope for v1).
- Grammar update (tree-sitter version bump) → bump `indexer_version` meta row → forced full reparse on next boot.

---

## 7. Query Pipeline

```
VaultRegistry.query(q: string, ctx: QueryCtx): QueryResult

Step 1 — Recall (per vault, parallel):
  - FTS5 top-K1=20 (BM25)
  - HNSW top-K2=20 (cosine)
  - RRF fusion: score(d) = Σ 1/(k + rank_i(d))   where k=60
  - Result: top-K=30 candidate chunks per vault

Step 2 — Expansion (symbol-aware):
  - For each candidate chunk, find enclosing symbol → fetch 1-hop in vault_edges
  - Add linked symbol's enclosing chunks (budget: +10 chunks)

Step 3 — Personalized PageRank (Aider-style):
  - Seed vector = chunks matching recent conversation mentions + ctx.focusFiles
  - Run PPR over vault_edges, damp=0.15, iterations=10
  - Boost candidate rank by PPR score

Step 4 — Optional rerank (when ctx.rerank = true):
  - Haiku-as-judge on top-K (batched, single call with all candidates)
  - Skipped when query marked as "cheap" by supervisor

Step 5 — Token-budget fit:
  - Binary-search top-N where Σ chunk.token_count ≤ ctx.budgetTokens
  - Always include L1 pinned notes (≤1k tokens) first

Step 6 — Assemble:
  - L1 pinned + L4 file/dir summaries for surviving files + L3 chunks
  - Return structured: { pinned, summaries, chunks, symbols, budget_used }
```

### StradaKnowledge integration

`buildProjectContext()` becomes a thin adapter:

```ts
async function buildProjectContext(ctx: RequestCtx): Promise<string> {
  const vaults = VaultRegistry.resolveFor(ctx);  // framework + unity + self
  const result = await VaultRegistry.query(ctx.userMessage, {
    vaultIds: vaults,
    budgetTokens: ctx.contextBudget,
    focusFiles: ctx.recentlyTouched,
    rerank: ctx.complexityScore > 0.7,
  });
  return renderContext(result);
}
```

Legacy fallback: if any vault missing/unhealthy, old `buildProjectContext` path runs (degraded mode, logged).

---

## 8. Obsidian Compatibility

- `codebase/<module>.md`: YAML frontmatter + `[[wikilinks]]` pointing to symbol notes.
- Symbol notes optional in v1 (`symbols/<SymbolId>.md`) — deferred; wikilinks from codebase notes resolve via `vault_wikilinks` table.
- `graph.canvas`: JSON Canvas 1.0 spec; regenerated on every index tick.
- `.obsidian/` folder: **not** created by us. If user wants Obsidian settings, they bring their own. Our vault works without Obsidian being installed.

---

## 9. Learning Integration (Bidirectional, Loose)

Event bus: existing `memory_bridge` (see memory-bridge_status).

**Vault → Learning**:
- `vault:pattern-candidate` event whenever a chunk appears >N times in top-K results across sessions. Learning pipeline evaluates, may promote to pattern.
- `vault:decision-made` event when an ADR markdown is added under `decisions/`. Learning pipeline seeds an instinct.

**Learning → Vault**:
- `learning:pattern-distilled` event → vault appends a note under `decisions/patterns/<pattern-id>.md` (auto-generated markdown, agent-owned).
- `learning:user-correction` event → vault `memory/corrections.md` append.

Both sides communicate through events only. Vault module does NOT import learning module and vice versa. `memory_bridge` owns the schema.

---

## 10. Web Portal — `/vaults` Page

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [Vaults]  [Memory] [Personality] [Settings] …             │  ← existing tabs
├──────────────┬──────────────────────────────────────────────┤
│ FRAMEWORK    │  <selected vault view>                       │
│ ◉ core       │                                              │
│ ○ modules    │  ┌────── Tabs ──────────┐                   │
│ ○ mcp        │  │ Files | Graph | Search | Stats │         │
│              │  └────────────────────────────────┘         │
│ UNITY-PROJECT│                                              │
│ ○ MyGame     │  <content>                                   │
│ ○ Prototype  │                                              │
│              │                                              │
│ SELF         │                                              │
│ ○ Strada.Brain                                              │
└──────────────┴──────────────────────────────────────────────┘
```

- **Files tab**: collapsible file tree from `vault_files`, click → markdown preview via `react-markdown` + `remark-gfm` + custom `[[wikilink]]` remark plugin. Wikilinks are clickable (navigate to target file).
- **Graph tab**: `.canvas` rendered via Cytoscape.js (already in portal's potential stack). Force-directed layout by default, with option to switch to hierarchical. Node click → opens Files tab on that file.
- **Search tab**: single input. Executes `VaultRegistry.query()` on the selected vault. Results list with score + RRF + PPR contribution.
- **Stats tab**: chunk count, symbol count, last index time, byte size, hit rate (from query logs).

### State + transport

- New Zustand store: `vault-store.ts` — selected vault, file tree cache, graph cache, search cache.
- WS channel: `vault:update` messages pushed from server on dirty-set drain; UI invalidates affected caches.
- HTTP endpoints:
  - `GET /api/vaults` — list
  - `GET /api/vaults/:id/tree` — file tree
  - `GET /api/vaults/:id/file?path=…` — markdown body
  - `GET /api/vaults/:id/canvas` — graph JSON
  - `POST /api/vaults/:id/search` — query
  - `POST /api/vaults/:id/sync` — force reindex

Existing `MemoryPage` stays (it covers session memory, not vault). Left-nav gains new "Vaults" entry above "Memory".

---

## 11. Rollout — Phases

> Single milestone (v4.3), phased ship. Each phase ship-ready on main.

**Phase 1 — Substrate + UnityProjectVault L3 (Week 1)**
- New `src/vault/` module with `IVault`, `VaultRegistry`, `SqliteVaultStore`.
- Generalize `FrameworkPackageId` to `string` (back-compat shim).
- Tree-sitter WASM bootstrap, grammar loading for TS + C# + Markdown + JSON.
- Chunker + FTS5 + HNSW pipeline (reuse AgentDB HNSW).
- `/vault init` + `/vault sync` slash commands.
- Portal `/vaults` page skeleton (Files tab + Search tab).
- chokidar watcher + Strada.Brain write-hook.
- Acceptance: UnityProjectVault answers semantic search in portal for a sample Unity project; `buildProjectContext` A/B flag uses vault when available.

**Phase 2 — Symbol graph + PPR + SelfVault (Week 2)**
- Symbol + edge extraction pipeline (TS, C#, markdown wikilinks).
- `vault_edges` PageRank query stage.
- `graph.canvas` generator.
- SelfVault init at Strada.Brain boot.
- Portal Graph tab (Cytoscape.js).
- Acceptance: "find callers of X" returns correct results for both TS and C# test corpora; Graph tab renders in <1 s on 1k-node graph.

**Phase 3 — Summaries + FrameworkVault upgrade + Learning coupling (Week 3)**
- Haiku-based L4 summaries, file + dir scope.
- FrameworkVault migrated to new schema; docstring + example extraction added.
- Vault ↔ Learning event wires.
- ADR markdown generator for `decisions/patterns/`.
- Portal Stats tab + per-chunk score breakdown.
- Acceptance: p50 request context-assembly ≤150 ms on sample corpus; token usage reduced ≥30 % on workload benchmark; learning pipeline emits/consumes events end-to-end.

**Phase 4 — Polish (Week 4, optional buffer)**
- `.gitignore` auto-maintenance, migration tooling for existing `framework_snapshots`, UX refinement (empty states, progress indicators), documentation in 8 languages.

---

## 12. Testing Strategy

- **Unit**: chunker boundaries, hash stability, FTS5 query escaping, RRF math, PPR convergence, tree-sitter symbol extraction per language, markdown frontmatter round-trip.
- **Integration**: full cold-start on a 200-file fixture Unity project; write-hook latency (≤200 ms single-file reindex p95); watcher debounce correctness under rapid editor saves.
- **Contract**: `IVault` conformance suite run against each vault implementation; ensures every vault answers the same query API.
- **E2E**: portal Vaults page renders all three vault types from a seeded fixture; WS live update arrives within 2 s of FS change.
- **Regression**: legacy `buildProjectContext` path still works when all vaults disabled via feature flag.
- **Perf**: benchmark suite (reuse existing `benchmarks/`) with cold-start, incremental-update, query-p50/p95 metrics; fail CI if regression >20 %.

Target coverage on new modules: ≥85 % statement.

---

## 13. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| tree-sitter-c-sharp doesn't parse Unity-specific syntax (attributes, generics edge cases) | M | Fallback to ctags-based symbol list; mark symbols with `confidence: 'low'`. |
| Haiku summary drift (hallucinates APIs) | M | Content-hash-pinned; prompt includes "only describe what is in the source"; unit test verifies no symbol appears in summary that isn't in `vault_symbols`. |
| Write-hook latency blocks tool responses | M | 200 ms sync budget (parse + chunk + FTS5 + symbol update); embedding + Haiku summary run async. If sync path >200 ms, fall back to full-async reindex and log; marker injected in context warning "vault may be stale for file X". |
| Index corruption on crash | L | SQLite WAL + atomic rename of `index.db.new` → `index.db`; on boot, PRAGMA integrity_check; if fail → `/vault rebuild` auto-triggered. |
| FrameworkPackageId generalization breaks existing callers | M | Type alias retained as `type FrameworkPackageId = string` with legacy union kept as branded subtype where static checks needed; migration lint for 1 release cycle. |
| HNSW index size explodes on large Unity projects | L | Chunk cap 400 tokens × ~50k chunks typical = bounded; quantization already available in existing HNSW store. |
| Watcher misses changes on macOS for nested node_modules-like trees | L | Explicit ignore patterns: `Library/`, `Temp/`, `Logs/`, `obj/`, `bin/`, `.git/`, `node_modules/`. Plus `/vault sync` manual escape hatch. |
| Portal graph performance at >10k nodes | M | Level-of-detail rendering (collapse directories); virtualized file tree; Cytoscape webgl renderer. |

---

## 14. Migration

- Existing `framework_snapshots` SQLite → one-shot migration script in Phase 3. Source-of-truth is git clones, so worst case = redownload.
- Existing `RAGIndexTool` deprecated in favor of `VaultRegistry`. Adapter provides behavioral compat for 1 minor version; then removed.
- `StradaKnowledge.buildProjectContext()` keeps its signature; body swaps out. Caller code unchanged.

---

## 15. Open Questions (auto-decided)

Per user direction, all gray-area decisions autonomous:

- **Embedding model**: default to existing Gemini embedding provider; fall back to local transformers.js (@xenova/transformers) if rate-limited or offline. Chosen for zero new network dependency and offline resilience.
- **Chunk size**: 400 tokens, heading-aware for markdown, function-aware for code. Rationale: aligns with existing RAG pipeline defaults and fits Aider's empirical sweet spot.
- **Canvas layout engine**: Cytoscape.js (portal) — Magic UI / shadcn have no graph primitive; d3-force considered but cytoscape has built-in node selection + events needed for "click to open file".
- **Unity project roots**: autodetect by presence of `Assets/`, `ProjectSettings/`, `Packages/manifest.json` under configured `unityProjectPath`. Multi-root (Assets + Packages) supported out of the gate.
- **Write-hook sync vs async split**: sync path = hash + parse + chunk + FTS5 + symbol rows (budget 200 ms p95). Async path = embedding + Haiku summary (no budget, p-queue bounded). Rationale: FTS5 + symbol graph alone are enough to serve the next turn's context retrieval; embeddings catch up within 1–2 s. Warning header in context if sync path degrades.

---

## 16. Deliverables Summary

- New module: `src/vault/` (storage, indexer, registry, query pipeline, chokidar watcher, write-hook)
- Extended module: `src/intelligence/framework/` (generalized package ID, semantic search adapter, docstring extractor)
- New portal page: `web-portal/src/pages/VaultsPage.tsx` + `vault-store.ts` + `/vaults` route
- New tree-sitter grammars: tree-sitter-c-sharp, tree-sitter-markdown, tree-sitter-json (WASM)
- Slash commands: `/vault init`, `/vault sync`, `/vault rebuild`, `/vault status`
- Tests: `tests/vault/*.test.ts` covering contract, integration, perf
- Docs: `docs/vault.md` (8-language parity deferred to Phase 4)

---

## 17. Out of Scope (explicit)

- Multi-machine vault replication
- Vault encryption at rest (SQLite stays plaintext; user-responsibility if repo is public)
- Public publishing (Quartz integration)
- Realtime collaborative editing of vault markdown
- Vault plugin system (third-party vault types)
- C++ / HLSL semantic parsing (syntax-highlight only, no symbols)

---

**End of design.**
