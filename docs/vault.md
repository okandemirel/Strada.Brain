# Codebase Memory Vault

Persistent, per-project codebase memory for Strada.Brain. The vault replaces per-request file re-reading with hybrid (BM25 + vector) and symbolic (Personalized PageRank over a call/import graph) retrieval, so the agent can answer questions about a Unity project — or its own source — without streaming the full file tree into every turn.

---

## 1. Overview

### Problem

Every turn, the agent tends to re-read files it has seen before:

- Context windows fill up with duplicated source.
- Token budgets burn on repetitive file I/O.
- Cross-file reasoning (who calls `Player.Move`? which systems touch `HealthComponent`?) requires fresh greps.

### Solution

A SQLite-backed per-project index (`<project>/.strada/vault/index.db`) that:

1. Chunks and indexes source (BM25 FTS5 + HNSW vector embeddings).
2. Extracts symbols and call/import edges into a graph.
3. Serves ranked, token-budget-aware retrieval through a hybrid query pipeline.
4. Updates itself via a chokidar watcher, a write-hook, or manual `/vault sync`.
5. Indexes Strada.Brain's own source automatically via **SelfVault**, so the agent can introspect its own code.

The vault is opt-in (`config.vault.enabled = false` by default). Once enabled it boots alongside the agent and exposes tools, HTTP APIs, and a portal page.

---

## 2. Quick start

```bash
# Enable the subsystem
export STRADA_VAULT_ENABLED=true

# Start Strada.Brain
npm start
```

In any channel:

```
/vault init /path/to/unity/project
/vault sync
/vault status
```

SelfVault (indexing Strada.Brain's own source) bootstraps automatically at startup when `vault.enabled=true`. Disable it with `config.vault.self.enabled=false`.

The portal exposes the same functionality at [`/admin/vaults`](http://localhost:3000/admin/vaults): Files / Search / Graph tabs.

---

## 3. Architecture overview

The vault has three conceptual layers:

| Layer | Content | Source |
|---|---|---|
| **L1 — File metadata** | Path, content hash (xxhash64), mtime, size, language, kind | `discovery.ts`, `reindexFile` |
| **L2 — Symbol graph** | Symbols, call/import edges, markdown wikilinks | Tree-sitter WASM extractors in `src/vault/symbol-extractor/` |
| **L3 — Hybrid chunks** | Chunked text + FTS5 BM25 + HNSW vector embeddings | `chunker.ts`, embeddings provider |

Cross-layer:

- **PPR (Personalized PageRank)** over L2 re-ranks L3 results when `VaultQuery.focusFiles` is set.
- **graph.canvas** (JSON Canvas 1.0) is a derived artifact at `<project>/.strada/vault/graph.canvas`, rebuilt on cold start, `/vault sync`, and watcher drain.

---

## 4. Phase 1 — Hybrid retrieval

### Storage

SQLite per vault (`better-sqlite3`, WAL + `foreign_keys=ON`):

| Table | Purpose |
|---|---|
| `vault_files` | Path, xxhash64 blob hash, mtime, size, lang, kind |
| `vault_chunks` | chunkId (sha256-truncated), path FK, line range, content, token count |
| `vault_chunks_fts` | FTS5 virtual table, BM25 ranked |
| `vault_embeddings` | Pointer into the external HNSW vector store |
| `vault_meta` | Key/value; holds `indexer_version`, migration markers |

### Chunking

Language-aware chunking via `chunker.ts`; kind detection (source / test / config / markdown) via `discovery.ts`. Unchanged files are short-circuited by xxhash64 — no re-embed.

### Update paths

Three paths keep the index fresh:

| Path | Trigger | Budget |
|---|---|---|
| chokidar watcher | User FS changes | 800ms debounce (default) |
| Write-hook | Strada.Brain's own tool writes | 200ms sync budget |
| `/vault sync` tool | Manual, full reindex | No budget |

All three honor `reindexFile`'s hash short-circuit.

### Query pipeline

`VaultRegistry.query({ text })`:

1. Per-vault: BM25 (FTS5) + vector (HNSW) recall.
2. **Reciprocal Rank Fusion** (k = 60) merges the two ranked lists.
3. Optional `langFilter` / `pathGlob` narrow the results.
4. If `focusFiles` is set, **Personalized PageRank** over the symbol graph re-ranks.
5. `packByBudget` greedy-packs chunks up to the requested token budget.
6. Across vaults: sort by fused score, cap to `topK`.

### Tools

Three tools register with the agent tool registry at bootstrap (`initVaultsFromBootstrap` in `stage-knowledge.ts`):

| Tool | Purpose |
|---|---|
| `vault_init` | Attach a project path and build its vault |
| `vault_sync` | Full reindex of an existing vault |
| `vault_status` | Report vault health, file count, symbol count, last sync |

---

## 5. Phase 2 — Symbol graph, PPR, SelfVault, Graph UI

Phase 2 adds a deterministic L2 symbol layer on top of Phase 1's L3 hybrid search.

### New tables

Added in `schema.sql`; `vault_meta.indexer_version = 'phase2.v1'`.

| Table | Purpose |
|---|---|
| `vault_symbols` | Functions, classes, methods, fields with location info |
| `vault_edges` | Call/import/reference edges between symbols |
| `vault_wikilinks` | Markdown `[[wikilink]]` references |

### Extractors

Tree-sitter WASM extractors, one per language, in `src/vault/symbol-extractor/`:

- TypeScript
- C#
- Markdown (regex wikilink extractor)

A fresh `Parser` instance is created per call for concurrency safety. Per-file extraction is capped at 2 MB.

### Symbol IDs

```
<lang>::<relPath>::<qualifiedName>
```

Examples:

```
csharp::Assets/Scripts/Player.cs::Game.Player.Move
typescript::src/foo.ts::Foo.bar
```

Unresolved externs (references whose target isn't in the vault) use:

```
<lang>::unresolved::<label>
```

### graph.canvas

A JSON Canvas 1.0 artifact at `<project>/.strada/vault/graph.canvas`, regenerated on:

- Cold start
- `/vault sync`
- Watcher drain

Writes are atomic (temp file + rename).

### Personalized PageRank

`src/vault/ppr.ts` runs when `VaultQuery.focusFiles` is set, re-ranking hybrid results via the edge graph. The damping formula is normalized so the stationary distribution sums to 1. When `focusFiles` is omitted, the RRF-only path is preserved.

### SelfVault

`src/vault/self-vault.ts` indexes Strada.Brain's own source automatically. It covers:

- `src/`
- `web-portal/src/`
- `tests/`
- `docs/`
- `AGENTS.md`
- `CLAUDE.md`

Symlinks are skipped during discovery (prevents directory escape).

### Graph tab

The portal `/admin/vaults` page gains a **Graph** tab rendering `graph.canvas` via `@xyflow/react` + `@dagrejs/dagre`. No new frontend dependencies.

---

## 6. Configuration reference

All flags live under `config.vault` (`src/config/config.ts`).

| Flag | Default | Env var | Description |
|---|---|---|---|
| `enabled` | `false` | `STRADA_VAULT_ENABLED` | Master switch for the vault subsystem |
| `writeHookBudgetMs` | `200` | `STRADA_VAULT_WRITE_HOOK_BUDGET_MS` | Max ms the write-hook may block tool writes |
| `debounceMs` | `800` | `STRADA_VAULT_DEBOUNCE_MS` | chokidar debounce for FS change bursts |
| `embeddingFallback` | `'local'` | — | `'none'` disables fallback; `'local'` uses a local embedder when provider returns null |
| `self.enabled` | `true` | — | Set to `false` to opt out of SelfVault |

---

## 7. HTTP API reference

All endpoints live under `/api/vaults/*` and require dashboard auth.

### `GET /api/vaults`

List vaults.

```json
[
  {
    "id": "unity-project",
    "kind": "unity-project",
    "rootPath": "/absolute/path/to/unity",
    "fileCount": 1243,
    "symbolCount": 9128,
    "lastSyncAt": "2026-04-14T14:02:11.000Z"
  }
]
```

### `POST /api/vaults/:id/search`

Hybrid search. Request body capped at `maxBytes` for DoS protection.

Request:

```json
{
  "text": "damage calculation",
  "topK": 20,
  "tokenBudget": 4000,
  "langFilter": "csharp",
  "pathGlob": "Assets/**",
  "focusFiles": ["Assets/Scripts/Player.cs"]
}
```

Response:

```json
{
  "results": [
    {
      "chunkId": "...",
      "path": "Assets/Scripts/DamageSystem.cs",
      "range": [12, 48],
      "score": 0.82,
      "content": "..."
    }
  ]
}
```

### `GET /api/vaults/:id/files/*`

Browse the file tree and fetch per-file markdown/raw content (used by the Files tab).

### `GET /api/vaults/:id/canvas`

Serves `graph.canvas` (JSON Canvas 1.0).

### `GET /api/vaults/:id/symbols/by-name?q=<shortName>`

Look up symbols by short name.

```json
[
  {
    "symbolId": "csharp::Assets/Scripts/Player.cs::Game.Player.Move",
    "kind": "method",
    "path": "Assets/Scripts/Player.cs",
    "range": [42, 58]
  }
]
```

### `GET /api/vaults/:id/symbols/:symbolId/callers`

List incoming call edges (bounded result set).

```json
{
  "symbolId": "csharp::Assets/Scripts/Player.cs::Game.Player.Move",
  "callers": [
    {
      "symbolId": "csharp::Assets/Scripts/InputHandler.cs::Game.InputHandler.Update",
      "path": "Assets/Scripts/InputHandler.cs",
      "line": 27
    }
  ]
}
```

### WebSocket events

- `vault:update` — broadcasts dirty-set batches to connected portal clients.

---

## 8. Portal UI guide

The `/admin/vaults` page (`web-portal/src/pages/VaultsPage.tsx`) has three tabs:

### Files

- Lazy-loaded file tree of the vault root.
- Per-file preview: rendered markdown for `.md`, raw source otherwise.
- Agent-touched files are highlighted.

### Search

- Query box + topK / token budget controls.
- Optional language filter and path glob.
- Results show score, path, line range, and chunk content.

### Graph

- Renders `graph.canvas` via `@xyflow/react` + `@dagrejs/dagre`.
- Nodes: symbols, grouped by file.
- Edges: calls, imports, wikilinks.
- Click a node to open the symbol in the Files tab.

---

## 9. Security posture

Hardening applied during Phase 2 review (commit `5563d48`):

- **Atomic canvas writes** — temp file + rename; no partial-write reads.
- **Symlink-skip** in SelfVault discovery — prevents directory escape via symlinks pointing outside the repo.
- **Fresh tree-sitter `Parser` per call** — concurrency safety; no shared parser state.
- **Request body `maxBytes` cap** on the search endpoint — DoS protection.
- **Orphaned edge GC** — edges referencing deleted files are removed on reindex.
- **PPR damping normalization** — stationary distribution sums to 1 (no drift or bias).
- **2 MB cap on symbol extraction per file** — bounds memory/CPU per parse.
- **Edge cache invalidation on `reindexFile`** — prevents stale graph state.
- **Bounded `findCallers` results** — no unbounded graph walks.

Standard Strada.Brain security applies: the vault respects path sanitization, lives under `<project>/.strada/vault/`, and all portal/HTTP access goes through the dashboard auth layer.

---

## 10. Roadmap

### Phase 3 (planned)

- **Haiku rolling summaries** — low-cost model summarizes files/modules on change; summaries stored in `vault_meta` and injected into prompts as a cheaper alternative to full chunk packing.
- **FrameworkVault upgrade** — extends the vault abstraction to Strada.Core framework docs with semantic search and docstring extraction.
- **Bidirectional Learning pipeline coupling** — vault symbol graph feeds the learning system (pattern provenance tied to symbols); learning artifacts (`skill`, `workflow`, `knowledge_patch`) link back to their originating symbols.

---

## 11. Links

- **Source**: [`src/vault/`](../src/vault/)
  - Interface: `src/vault/vault.interface.ts`
  - Unity vault: `src/vault/unity-project-vault.ts`
  - Self vault: `src/vault/self-vault.ts`
  - Registry: `src/vault/vault-registry.ts`
  - PPR: `src/vault/ppr.ts`
  - Symbol extractors: `src/vault/symbol-extractor/`
  - Chunking: `src/vault/chunker.ts`
  - Discovery: `src/vault/discovery.ts`
- **Design spec**: [`docs/superpowers/specs/2026-04-13-codebase-memory-vault-design.md`](./superpowers/specs/2026-04-13-codebase-memory-vault-design.md)
- **Portal page**: `web-portal/src/pages/VaultsPage.tsx`
- **Tool registration**: `stage-knowledge.ts :: initVaultsFromBootstrap`
