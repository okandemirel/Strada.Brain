---
phase: 02-memory-migration-hnsw-hardening
plan: 01
subsystem: memory/unified
tags: [hnsw, mutex, concurrency, semantic-search, retrieval-routing]
dependency_graph:
  requires: [01-01, 01-02]
  provides: [hnsw-write-safety, semantic-retrieval-routing]
  affects: [agentdb-memory, agentdb-adapter, unified-memory-barrel]
tech_stack:
  added: [HnswWriteMutex]
  patterns: [promise-queue-mutex, semantic-first-retrieval]
key_files:
  created:
    - src/memory/unified/hnsw-write-mutex.ts
    - src/memory/unified/hnsw-write-mutex.test.ts
  modified:
    - src/memory/unified/agentdb-memory.ts
    - src/memory/unified/agentdb-adapter.ts
    - src/memory/unified/agentdb-adapter.test.ts
    - src/memory/unified/index.ts
decisions:
  - Mutex uses Promise-chain pattern (zero dependencies, ~30 lines)
  - shutdown() not wrapped in mutex (lifecycle method, not a concurrent write path)
  - loadEntries() upsert wrapped even though called during init (defensive against future concurrent init)
  - Chat and type modes retain TF-IDF path (structural filters, not similarity searches)
  - Empty query falls back to TF-IDF (no embedding to search against)
metrics:
  duration: 5min
  completed: "2026-03-06T11:01:36Z"
  tasks_completed: 2
  tasks_total: 2
  tests_added: 14
  tests_total: 1790
  files_created: 2
  files_modified: 4
---

# Phase 02 Plan 01: HNSW Write Mutex + Semantic Retrieval Routing Summary

Promise-based async write queue preventing HNSW index corruption from interleaved writes, plus semantic-first retrieval routing replacing TF-IDF for text queries.

## Completed Tasks

| # | Task | Commit | Key Changes |
|---|------|--------|-------------|
| 1 | HnswWriteMutex + AgentDBMemory integration | d63cbe0 | Created HnswWriteMutex class, wrapped all 3 HNSW write paths in agentdb-memory.ts, 5 concurrency tests |
| 2 | Semantic retrieval routing in AgentDBAdapter | 017f87a | retrieve() routes text/semantic/hybrid to retrieveSemantic(), chat/type retain TF-IDF, 9 new routing tests |

## Implementation Details

### Task 1: HnswWriteMutex

Created `HnswWriteMutex` class (30 lines, zero dependencies) using Promise-chain serialization:
- Single `queue: Promise<void>` field chains all write operations
- `withLock<T>(fn)` method ensures FIFO serial execution
- Errors propagate to caller without breaking the queue
- Reads bypass the mutex entirely (no performance impact on search)

Wrapped 3 HNSW write sites in AgentDBMemory:
- `storeEntry()` -- upsert of new entries
- `rebuildIndex()` -- remove + upsertBatch cycle
- `loadEntries()` -- bulk upsert from SQLite during initialization

### Task 2: Semantic Retrieval Routing

Modified `AgentDBAdapter.retrieve()` to route through HNSW vector similarity:
- Text, semantic, and hybrid mode queries with non-empty text go through `agentdb.retrieveSemantic()`
- Chat mode (structural chat ID filter) and type mode (structural type filter) stay on TF-IDF path
- Empty queries fall back to TF-IDF (nothing to embed)

Replaced `retrieveSemantic()` stub with real delegation to `agentdb.retrieveSemantic()`.

## Deviations from Plan

None -- plan executed exactly as written.

## Test Results

- 5 mutex concurrency tests (serial execution, FIFO order, error propagation, return values, non-blocking reads)
- 9 new adapter routing tests (semantic routing for text/semantic modes, TF-IDF for chat/type, empty query fallback, error handling)
- Total: 1790 tests pass, 0 regressions, 0 skipped failures

## Verification

1. All HNSW write operations wrapped with `writeMutex.withLock()` (3 call sites)
2. No raw `hnswStore.upsert/remove/upsertBatch` calls remain outside mutex
3. `retrieve()` routes text queries to `retrieveSemantic()` (verified via grep)
4. Full unified memory test suite: 57/57 pass
5. Full project test suite: 1790/1790 pass

## Self-Check: PASSED

- [x] src/memory/unified/hnsw-write-mutex.ts exists
- [x] src/memory/unified/hnsw-write-mutex.test.ts exists
- [x] 02-01-SUMMARY.md exists
- [x] Commit d63cbe0 exists
- [x] Commit 017f87a exists
