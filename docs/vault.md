# Vault Subsystem (Phase 1)

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

## Next phases

- **Phase 2**: tree-sitter symbol graph, personalized PageRank, Graph tab, SelfVault.
- **Phase 3**: Haiku rolling summaries, FrameworkVault upgrade (semantic search + docstring extraction), bidirectional Learning pipeline coupling.
