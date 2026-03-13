# src/memory/

Persistent conversation memory with text search and vector retrieval. The memory system stores past conversations, project analyses, and notes, making them available to the agent as context for future interactions.

## Active Backend: AgentDBMemory

`AgentDBMemory` (`unified/agentdb-memory.ts`) is the production backend since v2.0, wired in `src/core/bootstrap.ts`. It uses SQLite + HNSW vector indexing for 150x-12,500x performance over the legacy file backend.

### Three-Tier Memory

| Tier | Max Entries | TTL | Assignment |
|------|-------------|-----|------------|
| Working | 100 | None | `importance >= 0.8` |
| Ephemeral | 1,000 | 24h | `importance <= 0.3` or marked ephemeral |
| Persistent | 10,000 | None | Everything else |

Tier enforcement is automatic — when a tier exceeds capacity, entries with the lowest combined score (`importance * 0.7 + accessFrequency * 0.3`) are evicted.

### SQLite Persistence

WAL mode, 16MB page cache, temp tables in memory. Every write immediately persists. Bulk save wraps in a transaction. Memory decay with exponential lambda (instincts exempt).

### HNSW Vector Search

Vectors stored alongside entries. Dual-path retrieval:
- `retrieveSemantic()` — HNSW nearest-neighbor search
- `retrieve()` — TF-IDF text search (backward compatible)
- `retrieveHybrid()` — 70% semantic + 30% text scores combined

### Idle Consolidation (v3.0)

When daemon detects idle time, `ConsolidationEngine` clusters similar memories using HNSW proximity and merges them via LLM summarization, reducing memory footprint while preserving knowledge.

### Embedding Fallback

When no embedding provider is configured, `generateEmbedding()` uses a character-position hash. This produces vectors that occupy HNSW space but have no semantic meaning — semantic search silently degrades.

## Legacy Backend: FileMemoryManager (Fallback Only)

`FileMemoryManager` is used only if AgentDB initialization fails.

**Storage:** JSON files in `MEMORY_DB_PATH` directory (default: `.strada-memory/`):
- `memory.json` — all memory entries + TF-IDF index state
- `analysis.json` — cached project analysis

**Search:** TF-IDF text indexing via `TextIndex`. Cosine similarity scoring.

## Migration Path

`unified/migration.ts` provides:
- `MemoryMigrator` — migrates FileMemoryManager data to AgentDB format
- `BackwardCompatibleMemory` — wraps `IUnifiedMemory` with `IMemoryManager` interface

## Interfaces

**`IMemoryManager`** (`memory.interface.ts`): Legacy interface. 7 entry types, 5 retrieval modes, full CRUD, import/export, compact, stats. Returns `Result<T, Error>`.

**`IUnifiedMemory`** (`unified/unified-memory.interface.ts`): Advanced interface. Adds batch writes, direct vector search, hybrid retrieval with semantic weight, tier promotion/demotion, access tracking, expired entry cleanup, HNSW lifecycle (rebuild, health, optimize).

## Key Files

| File | Purpose |
|------|---------|
| `memory.interface.ts` | `IMemoryManager`, entry types, retrieval options |
| `unified/agentdb-memory.ts` | Active production backend (SQLite + HNSW) |
| `unified/unified-memory.interface.ts` | `IUnifiedMemory`, tier enum, HNSW types |
| `unified/consolidation-engine.ts` | Idle-driven memory consolidation (v3.0) |
| `file-memory-manager.ts` | Legacy fallback backend (JSON + TF-IDF) |
| `text-index.ts` | TF-IDF engine: term extraction, cosine similarity |
| `unified/migration.ts` | Legacy-to-AgentDB migration, backward-compatible wrapper |
