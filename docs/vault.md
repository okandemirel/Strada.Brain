# Vault Subsystem (Phase 1 + Phase 2)

Persistent, per-project codebase memory that replaces per-request file re-reading.

## Shapes

- `IVault` (`src/vault/vault.interface.ts`) — contract all vaults satisfy.
- `UnityProjectVault` (`src/vault/unity-project-vault.ts`) — indexes `<unity-project>/` into `<unity-project>/.strada/vault/index.db`, produces markdown under `<unity-project>/.strada/vault/codebase/`.
- `VaultRegistry` (`src/vault/vault-registry.ts`) — singleton lookup; fan-out `query()` merges per-vault results by RRF score.

## Query pipeline

`VaultRegistry.query({ text })` →
1. Per-vault: BM25 (FTS5) + vector (HNSW) recall
2. Reciprocal Rank Fusion (k = 60) merges the two ranked lists
3. Optional `langFilter` / `pathGlob` narrow the results
4. `packByBudget` greedy-packs chunks up to the requested token budget
5. Across vaults: sort by RRF, cap to `topK`

## Updates (hybrid)

- chokidar watcher (default 800 ms debounce) for user's FS changes
- Write-hook (`installWriteHook`, 200 ms sync budget) for Strada.Brain's own tool writes
- Manual `/vault sync` tool for on-demand full reindex

All three honor `reindexFile`'s hash short-circuit — unchanged files never re-embed.

## Storage

SQLite per vault (better-sqlite3, WAL + foreign_keys):

- `vault_files` — path, xxhash64 blob hash, mtime, size, lang, kind
- `vault_chunks` — chunkId (sha256-truncated), path FK, line range, content, token count
- `vault_chunks_fts` — FTS5 virtual table, BM25 scored
- `vault_embeddings` — pointer into the external HNSW store
- `vault_meta` — key/value for future migrations

## Config flags

`src/config/config.ts :: vault`:

- `enabled` (default `false`)
- `writeHookBudgetMs` (default 200 ms)
- `debounceMs` (default 800 ms)
- `embeddingFallback` (`'none' | 'local'`, default `'local'`)

Env: `STRADA_VAULT_ENABLED`, `STRADA_VAULT_WRITE_HOOK_BUDGET_MS`, `STRADA_VAULT_DEBOUNCE_MS`.

## Portal

`/admin/vaults` page (`web-portal/src/pages/VaultsPage.tsx`) — vault list + Files tab (tree + markdown/raw preview) + Search tab (hybrid query). HTTP surface at `/api/vaults/*`, WS event `vault:update` broadcasts dirty-set batches.

## Tools

`vault_init`, `vault_sync`, `vault_status` are registered with the agent tool registry at bootstrap (bootstrap integration lands via `initVaultsFromBootstrap` helper in `stage-knowledge.ts`).

## Phase 2 — Symbol Graph & PPR

Phase 2 adds a deterministic L2 symbol layer on top of Phase 1's L3 hybrid search.

### What's new

- `vault_symbols`, `vault_edges`, `vault_wikilinks` tables in `schema.sql`. `vault_meta.indexer_version = 'phase2.v1'`.
- Tree-sitter WASM extractors for TypeScript and C# (`src/vault/symbol-extractor/`); regex wikilink extractor for markdown.
- `.strada/vault/graph.canvas` — JSON Canvas 1.0, regenerated on every cold start, `/vault sync`, and watcher drain.
- `VaultQuery.focusFiles` triggers Personalized PageRank re-rank (`src/vault/ppr.ts`) over the edge graph; RRF-only path preserved when omitted.
- `SelfVault` (`src/vault/self-vault.ts`) — indexes Strada.Brain's own source (`src/`, `web-portal/src/`, `tests/`, `docs/`, `AGENTS.md`, `CLAUDE.md`).
- Portal `/vaults` gains a **Graph** tab rendering the canvas via `@xyflow/react` + `@dagrejs/dagre` (no new frontend deps).

### New HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vaults/:id/canvas` | Serve `graph.canvas` |
| GET | `/api/vaults/:id/symbols/by-name?q=X` | Find symbols by short name |
| GET | `/api/vaults/:id/symbols/:symbolId/callers` | List incoming call edges |

### Symbol ID format

`<lang>::<relPath>::<qualifiedName>` — e.g. `csharp::Assets/Scripts/Player.cs::Game.Player.Move` or `typescript::src/foo.ts::Foo.bar`. Unresolved externs use `<lang>::unresolved::<label>`.

### Feature flag

`config.vault.enabled` activates the subsystem; `config.vault.self.enabled = false` opts out of SelfVault specifically.

## Next phases

- **Phase 3**: Haiku rolling summaries, FrameworkVault upgrade (semantic search + docstring extraction), bidirectional Learning pipeline coupling.
