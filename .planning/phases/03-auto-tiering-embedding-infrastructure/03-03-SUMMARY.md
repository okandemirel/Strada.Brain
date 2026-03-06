---
phase: 03-auto-tiering-embedding-infrastructure
plan: 03
subsystem: memory
tags: [auto-tiering, memory-tiers, setInterval, zod-config, agentdb]

# Dependency graph
requires:
  - phase: 03-auto-tiering-embedding-infrastructure (plans 01-02)
    provides: SQLite pragma standardization, embedding queue, AgentDBMemory with 3-tier architecture
provides:
  - autoTieringSweep() periodic sweep promoting/demoting entries by access patterns
  - startAutoTiering/stopAutoTiering timer lifecycle methods
  - 3 new Zod config knobs (autoTieringIntervalMs, promotionThreshold, demotionTimeoutDays)
  - Bootstrap wiring for auto-tiering start/stop
affects: [04-event-driven-learning, 05-metrics-instrumentation]

# Tech tracking
tech-stack:
  added: []
  patterns: [setInterval-timer-lifecycle, access-pattern-based-tiering, periodic-sweep-with-cascade-eviction]

key-files:
  created:
    - src/memory/unified/auto-tiering.test.ts
  modified:
    - src/memory/unified/agentdb-memory.ts
    - src/config/config.ts
    - src/config/config.test.ts
    - src/core/bootstrap.ts

key-decisions:
  - "Promotion requires both accessCount >= threshold AND lastAccessedAt < 1 day (dual condition prevents stale-but-once-popular entries from promoting)"
  - "Demotion uses only staleness (daysSinceAccess > timeout) -- access count is irrelevant for cold detection"
  - "enforceTierLimits called for all 3 tiers after every sweep (not just tiers that changed) to handle cascade eviction correctly"
  - "stopAutoTiering placed before saveEntries in shutdown to prevent sweep firing during database teardown"
  - "Auto-tiering defaults to OFF (existing behavior preserved unless explicitly enabled via MEMORY_AUTO_TIERING=true)"

patterns-established:
  - "Timer lifecycle pattern: startX/stopX with null guard against duplicate timers"
  - "Periodic sweep pattern: iterate entries, evaluate criteria, apply changes, enforce limits"

requirements-completed: [MEM-04]

# Metrics
duration: 5min
completed: 2026-03-06
---

# Phase 3 Plan 3: Auto-Tiering Sweep Summary

**Periodic auto-tiering sweep promoting entries with high access + recent touch and demoting stale entries, with configurable interval/threshold/timeout via Zod schema**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-06T14:57:54Z
- **Completed:** 2026-03-06T15:03:00Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 5

## Accomplishments
- autoTieringSweep() promotes Persistent->Ephemeral->Working based on access frequency and recency
- autoTieringSweep() demotes Working->Ephemeral->Persistent based on staleness (days since last access)
- Timer lifecycle: startAutoTiering/stopAutoTiering with guard against duplicate timers
- 3 new Zod config fields with sensible defaults (300000ms interval, 5 access threshold, 7 day timeout)
- Bootstrap wires auto-tiering in both primary and repair init paths
- 13 tests covering promotion, demotion, boundaries, timer lifecycle, shutdown, logging

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Auto-tiering tests** - `0c4da7c` (test)
2. **Task 1 (GREEN): Auto-tiering implementation** - `7dcddd4` (feat)

_TDD task: test commit first, then implementation commit._

## Files Created/Modified
- `src/memory/unified/auto-tiering.test.ts` - 13 tests for promotion/demotion/timer/logging
- `src/memory/unified/agentdb-memory.ts` - Added tieringTimer field, startAutoTiering, stopAutoTiering, autoTieringSweep methods
- `src/config/config.ts` - 3 new Zod schema fields + MemoryConfig interface extension + EnvVars/loadFromEnv wiring
- `src/config/config.test.ts` - Updated unified config assertions for new fields
- `src/core/bootstrap.ts` - Wired auto-tiering start in both primary and repair init paths

## Decisions Made
- Promotion requires both high access count AND recent access (< 1 day) -- prevents stale-but-once-popular entries from promoting
- Demotion uses only staleness (daysSinceAccess > timeout) -- access count irrelevant for cold detection
- enforceTierLimits called for all 3 tiers after every sweep for cascade eviction correctness
- stopAutoTiering placed before saveEntries in shutdown to prevent sweep during teardown
- Auto-tiering defaults to OFF preserving existing behavior

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed config test assertions for new fields**
- **Found during:** Task 1 GREEN phase
- **Issue:** Existing config tests asserted exact shape of memory.unified without the 3 new fields
- **Fix:** Added autoTieringIntervalMs, promotionThreshold, demotionTimeoutDays to test assertions
- **Files modified:** src/config/config.test.ts
- **Verification:** All 29 config tests pass
- **Committed in:** 7dcddd4 (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Test assertion update was necessary for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 3 complete (all 3 plans done): SQLite pragma standardization, embedding queue, auto-tiering sweep
- Memory subsystem fully operational with 3-tier architecture, semantic search, auto-tiering
- Ready for Phase 4 (Event-Driven Learning)
- All 1829 tests pass, 0 type errors (2 pre-existing in agentdb-memory.ts loadEntries, unrelated)

---
*Phase: 03-auto-tiering-embedding-infrastructure*
*Completed: 2026-03-06*
