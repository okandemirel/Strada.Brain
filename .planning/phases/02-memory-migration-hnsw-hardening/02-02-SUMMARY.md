---
phase: 02-memory-migration-hnsw-hardening
plan: 02
subsystem: memory/unified
tags: [migration, idempotency, bootstrap, data-integrity, capacity-check]

# Dependency graph
requires:
  - phase: 02-01
    provides: HNSW write mutex serializing all vector writes
  - phase: 01-02
    provides: AgentDB bootstrap wiring with self-healing init
provides:
  - idempotent legacy-to-AgentDB migration with marker file
  - count validation ensuring zero data loss
  - capacity check preventing HNSW overflow
  - bootstrap-triggered automatic migration after AgentDB init
affects: [auto-tiering, embedding-infrastructure, learning-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns: [idempotency-marker-file, capacity-guard, non-blocking-migration]

key-files:
  created: []
  modified:
    - src/memory/unified/migration.ts
    - src/memory/unified/migration.test.ts
    - src/core/bootstrap.ts
    - src/core/bootstrap.test.ts

key-decisions:
  - "Marker file (migration-complete.json) written to sourcePath for idempotency"
  - "Capacity check sorts by createdAt descending (most recent entries preserved first)"
  - "triggerLegacyMigration is a standalone helper to keep initializeMemory readable"
  - "Migration called in both primary and repair AgentDB init paths"
  - "File backend path excluded from migration (already on legacy system)"

patterns-established:
  - "Idempotency via marker file: write JSON marker after operation, check before re-run"
  - "Non-blocking migration: catch at call site, log warning, continue with empty state"

requirements-completed: [MEM-02]

# Metrics
duration: 5min
completed: 2026-03-06
---

# Phase 02 Plan 02: Legacy Memory Migration with Safety Guarantees Summary

**Idempotent FileMemoryManager-to-AgentDB migration with count validation, capacity guard, and non-blocking bootstrap integration**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-06T12:05:34Z
- **Completed:** 2026-03-06T12:10:30Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Migration writes idempotency marker file preventing duplicate runs (migration-complete.json)
- Count validation ensures entriesMigrated + entriesFailed == source entryCount (zero data loss)
- Capacity check truncates entries to maxEntries (default 11100) sorted by recency to prevent HNSW overflow
- Bootstrap triggers migration automatically after AgentDB init in both primary and repair paths
- Migration failure never blocks agent startup (caught and logged as warning)

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration idempotency, count validation, capacity check** - `d76b3d9` (feat)
2. **Task 2: Wire migration into bootstrap** - `71994ad` (feat)

_TDD: Both tasks followed RED-GREEN cycle with tests written first._

## Files Created/Modified
- `src/memory/unified/migration.ts` - Added MIGRATION_MARKER constant, marker file writing, isMigrationNeeded marker check, capacity truncation, count validation, maxEntries config field
- `src/memory/unified/migration.test.ts` - 6 new tests for idempotency, marker detection, count validation, capacity truncation, error logging
- `src/core/bootstrap.ts` - Added runAutomaticMigration import, triggerLegacyMigration helper, migration calls in both init paths
- `src/core/bootstrap.test.ts` - 5 new tests for migration wiring, failure resilience, skip behavior, file backend exclusion, repair path

## Decisions Made
- Marker file approach chosen over database flag for idempotency (works even if AgentDB is wiped and rebuilt)
- Capacity check preserves most recent entries when truncating (sorted by createdAt descending)
- Migration extracted into triggerLegacyMigration() helper to keep initializeMemory() clean
- File backend path excluded from migration (if we are on FileMemoryManager, migration makes no sense)
- Migration runs in repair path too (user who had corrupted DB should still get their data migrated)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 2 (Migration & HNSW Hardening) is now complete (both plans done)
- All legacy data migration safety guarantees in place
- Ready for Phase 3 (Auto-Tiering & Embedding Infrastructure)

## Test Results
- 6 new migration tests + 5 new bootstrap tests = 11 new tests
- Total: 1801 tests pass, 0 regressions, 27 skipped (pre-existing)

## Self-Check: PASSED

- [x] src/memory/unified/migration.ts exists
- [x] src/memory/unified/migration.test.ts exists
- [x] src/core/bootstrap.ts exists
- [x] src/core/bootstrap.test.ts exists
- [x] 02-02-SUMMARY.md exists
- [x] Commit d76b3d9 exists
- [x] Commit 71994ad exists

---
*Phase: 02-memory-migration-hnsw-hardening*
*Completed: 2026-03-06*
