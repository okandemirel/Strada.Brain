# src/memory/

Persistent conversation memory with text search. The memory system stores past conversations, project analyses, and notes, making them available to the agent as context for future interactions.

## Active Backend: FileMemoryManager

`FileMemoryManager` is the production backend, wired in `src/core/bootstrap.ts`.

**Storage:** JSON files in `MEMORY_DB_PATH` directory (default: `.strata-memory/`):
- `memory.json` — all memory entries + TF-IDF index state (`{ df, docCount }`)
- `analysis.json` — cached project analysis

**Search:** TF-IDF text indexing via `TextIndex`. Term extraction with stop-word filtering. Cosine similarity scoring for retrieval.

**Write behavior:** Debounced flush — 5-second delay after last write, hard 30-second deadline. This batches multiple writes into a single disk I/O.

**Entry types:** conversation, analysis, note, error, learning, context, system.

**How the agent uses memory:**
1. At the start of each message, the orchestrator calls `retrieve({ mode: "text", query, limit: 3, minScore: 0.15 })` and injects results into the system prompt
2. When session history exceeds 40 messages, trimmed content is summarized and stored via `storeConversation(chatId, summary)`
3. `strata_analyze_project` caches project structure via `cacheAnalysis()`
4. The agent can explicitly call `memory_search` tool during conversations

## Advanced Backend: AgentDBMemory (Not Yet Wired)

`AgentDBMemory` in `unified/agentdb-memory.ts` is fully implemented but **not connected to bootstrap**. It provides:

### Three-Tier Memory

| Tier | Max Entries | TTL | Assignment |
|------|-------------|-----|------------|
| Working | 100 | None | `importance >= 0.8` |
| Ephemeral | 1,000 | 24h | `importance <= 0.3` or marked ephemeral |
| Persistent | 10,000 | None | Everything else |

Tier enforcement is automatic — when a tier exceeds capacity, entries with the lowest combined score (`importance * 0.7 + accessFrequency * 0.3`) are evicted.

### SQLite Persistence

```sql
CREATE TABLE memories (id, key, value, metadata, embedding, created_at, updated_at);
CREATE TABLE patterns (id, pattern_key, data, confidence, created_at);
```

WAL mode, 16MB page cache, temp tables in memory. Every write immediately persists. Bulk save wraps in a transaction.

### HNSW Vector Search

Vectors stored alongside entries. Dual-path retrieval:
- `retrieveSemantic()` — HNSW nearest-neighbor search
- `retrieve()` — TF-IDF text search (backward compatible)
- `retrieveHybrid()` — 70% semantic + 30% text scores combined

### Embedding Fallback

When no embedding provider is configured, `generateEmbedding()` uses a character-position hash. This produces vectors that occupy HNSW space but have no semantic meaning — semantic search silently degrades.

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
| `file-memory-manager.ts` | Active production backend (JSON + TF-IDF) |
| `text-index.ts` | TF-IDF engine: term extraction, cosine similarity |
| `unified/unified-memory.interface.ts` | `IUnifiedMemory`, tier enum, HNSW types |
| `unified/agentdb-memory.ts` | SQLite + HNSW backend (not yet wired) |
| `unified/migration.ts` | Legacy-to-AgentDB migration, backward-compatible wrapper |
