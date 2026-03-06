---
phase: 02-memory-migration-hnsw-hardening
plan: 03
subsystem: memory
tags: [hnsw, mutex, concurrency, agentdb, write-safety]

# Dependency graph
requires:
  - phase: 02-01
    provides: HnswWriteMutex class and initial 3-site wrapping pattern
provides:
  - All 6 HNSW write sites in AgentDBMemory serialized through writeMutex
  - MEM-06 verification gap fully closed
affects: [03-auto-tiering-embedding-infra]

# Tech tracking
tech-stack:
  added: []
  patterns: [batched-remove-in-single-lock for enforceTierLimits]

key-files:
  created: []
  modified:
    - src/memory/unified/agentdb-memory.ts
    - src/memory/unified/hnsw-write-mutex.test.ts

key-decisions:
  - "enforceTierLimits uses batched removes in single withLock (fewer lock acquisitions, matches rebuildIndex pattern)"

patterns-established:
  - "All HNSW mutations must go through writeMutex.withLock() -- no exceptions"

requirements-completed: [MEM-06]

# Metrics
duration: 2min
completed: 2026-03-06
---

# Phase 2 Plan 3: HNSW Write Mutex Gap Closure Summary

**All 6 HNSW write sites in AgentDBMemory serialized through writeMutex, closing MEM-06 verification gap for remove() calls in cleanupExpired, delete, and enforceTierLimits**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-06T13:01:51Z
- **Completed:** 2026-03-06T13:03:04Z
- **Tasks:** 1 (TDD: test + implementation)
- **Files modified:** 2

## Accomplishments
- Wrapped 3 unprotected HNSW remove() call sites with writeMutex.withLock()
- All 6 HNSW write sites (3 upsert + 3 remove) now mutex-serialized
- Zero raw hnswStore mutation calls remain outside writeMutex.withLock()
- Added test confirming remove+upsert serialization (no interleaving)
- enforceTierLimits uses batched removes in single lock acquisition (matches rebuildIndex pattern)

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Add remove+upsert serialization test** - `c17778a` (test)
2. **Task 1 (GREEN): Wrap 3 unprotected remove() calls** - `912e2f7` (feat)

_TDD task: test committed first, then implementation._

## Files Created/Modified
- `src/memory/unified/agentdb-memory.ts` - Wrapped cleanupExpired(), delete(), enforceTierLimits() remove() calls with writeMutex
- `src/memory/unified/hnsw-write-mutex.test.ts` - Added serialization test for remove queued during active upsert

## Decisions Made
- enforceTierLimits: batched all removes into a single withLock() call (fewer lock acquisitions) rather than per-entry locking. This matches the rebuildIndex() pattern established in 02-01.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 2 fully complete (all 3 plans done)
- HNSW write safety guaranteed across all mutation paths
- Ready for Phase 3: Auto-Tiering & Embedding Infrastructure

## Self-Check: PASSED

- [x] src/memory/unified/agentdb-memory.ts: FOUND
- [x] src/memory/unified/hnsw-write-mutex.test.ts: FOUND
- [x] Commit c17778a: FOUND
- [x] Commit 912e2f7: FOUND

---
*Phase: 02-memory-migration-hnsw-hardening*
*Completed: 2026-03-06*
