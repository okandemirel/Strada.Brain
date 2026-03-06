---
phase: 03-auto-tiering-embedding-infrastructure
plan: 02
subsystem: learning
tags: [embeddings, batching, async-queue, embedding-cache, learning-pipeline]

# Dependency graph
requires:
  - phase: 02-migration-hnsw-hardening
    provides: HNSW write mutex serialization for safe concurrent embedding writes
provides:
  - EmbeddingQueue class with ~500ms batched async embedding
  - LearningPipeline wired with optional IEmbeddingProvider
  - Bootstrap shares RAG CachedEmbeddingProvider with learning pipeline
affects: [04-event-driven-learning, instinct-retriever, hnsw-semantic-search]

# Tech tracking
tech-stack:
  added: []
  patterns: [fire-and-forget async queue, optional dependency injection, shared provider pattern]

key-files:
  created:
    - src/learning/pipeline/embedding-queue.ts
    - src/learning/pipeline/embedding-queue.test.ts
  modified:
    - src/learning/pipeline/learning-pipeline.ts
    - src/core/bootstrap.ts

key-decisions:
  - "Fire-and-forget embedding: failures logged at debug level, never rethrow"
  - "500ms default batch window balances latency vs. API efficiency"
  - "Shared CachedEmbeddingProvider: single instance for RAG and learning (no duplicate cache)"
  - "Optional provider pattern: when RAG disabled, embeddingQueue stays null (no crash)"
  - "Embedding text format: triggerPattern + space + action concatenation"

patterns-established:
  - "Optional dependency injection: constructor accepts undefined provider, feature simply disabled"
  - "Timer-based batching: collect items, flush on timer expiry, splice-and-process pattern"

requirements-completed: [LRN-03, LRN-04]

# Metrics
duration: 4min
completed: 2026-03-06
---

# Phase 3 Plan 2: Embedding Queue Summary

**Batched async EmbeddingQueue with 500ms window wired into LearningPipeline via shared CachedEmbeddingProvider from RAG bootstrap**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-06T14:49:53Z
- **Completed:** 2026-03-06T14:54:15Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- EmbeddingQueue class batches instinct texts for ~500ms then embeds in one API call
- Every createInstinct() call (3 sites) now enqueues embedding generation
- Bootstrap passes RAG's CachedEmbeddingProvider to learning pipeline (single shared instance)
- When RAG is disabled, learning pipeline works without embeddings (no crash)
- 8 new tests + all 1816 existing tests green

## Task Commits

Each task was committed atomically:

1. **Task 1: Create EmbeddingQueue with batched async embedding** - `6bf9a40` (test) + `e339742` (feat)
2. **Task 2: Wire embedding provider into LearningPipeline and bootstrap** - `b6ef1e2` (feat)

_Task 1 followed TDD: RED (failing tests) then GREEN (implementation)_

## Files Created/Modified
- `src/learning/pipeline/embedding-queue.ts` - EmbeddingQueue class with batched async embedding
- `src/learning/pipeline/embedding-queue.test.ts` - 8 tests covering batch window, flush, failure handling, lifecycle
- `src/learning/pipeline/learning-pipeline.ts` - Optional embeddingProvider param, enqueue after createInstinct, shutdown queue
- `src/core/bootstrap.ts` - initializeRAG returns { pipeline, cachedProvider }, passes to initializeLearning

## Decisions Made
- Fire-and-forget embedding strategy: instincts are already persisted to SQLite before queueing, so embedding failure only means no semantic search for those instincts
- 500ms batch window: balances between near-real-time embedding and batching efficiency
- Shared CachedEmbeddingProvider: single cache instance prevents duplicate API calls between RAG and learning
- Logger try-catch in error handler: prevents unhandled rejection when logger is not initialized (test environments)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Logger crash in error handler**
- **Found during:** Task 1 (EmbeddingQueue GREEN phase)
- **Issue:** getLogger() throws when logger not initialized, causing unhandled rejection in embed() error path
- **Fix:** Wrapped logger call in try-catch inside the catch block
- **Files modified:** src/learning/pipeline/embedding-queue.ts
- **Verification:** Tests pass without unhandled errors
- **Committed in:** e339742 (part of Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minor defensive fix for test environments. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Instincts now get embedding vectors via async batched generation
- HNSW semantic search for instinct retrieval is now functional (instincts have real embeddings when RAG is enabled)
- Ready for Phase 3 remaining plans or Phase 4 (Event-Driven Learning)

## Self-Check: PASSED

- FOUND: src/learning/pipeline/embedding-queue.ts
- FOUND: src/learning/pipeline/embedding-queue.test.ts
- FOUND: commit 6bf9a40 (test RED)
- FOUND: commit e339742 (feat GREEN)
- FOUND: commit b6ef1e2 (feat wiring)

---
*Phase: 03-auto-tiering-embedding-infrastructure*
*Completed: 2026-03-06*
