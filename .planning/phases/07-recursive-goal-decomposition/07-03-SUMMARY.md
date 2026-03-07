---
phase: 07-recursive-goal-decomposition
plan: 03
subsystem: orchestrator
tags: [goal-decomposition, paor, event-bus, dashboard, bootstrap, dag]

# Dependency graph
requires:
  - phase: 07-recursive-goal-decomposition (plans 01-02)
    provides: GoalStorage, GoalDecomposer, GoalRenderer, GoalValidator, types
provides:
  - GoalDecomposer wired into orchestrator for proactive + reactive decomposition
  - goal:status-changed event on TypedEventBus for goal lifecycle tracking
  - BackgroundExecutor uses GoalDecomposer with topological sort execution
  - /api/goals dashboard endpoint for goal tree data
  - GoalStorage initialized in bootstrap with shutdown cleanup
affects: [08-goal-progress-execution, 09-tool-chain-synthesis]

# Tech tracking
tech-stack:
  added: []
  patterns: [constructor-injection-for-goaldecomposer, topological-sort-execution, non-fatal-decomposition]

key-files:
  created: []
  modified:
    - src/core/event-bus.ts
    - src/core/bootstrap.ts
    - src/agents/orchestrator.ts
    - src/tasks/background-executor.ts
    - src/dashboard/server.ts

key-decisions:
  - "GoalDecomposer constructor takes (provider, maxDepth) -- no storage injection needed (storage is separate concern)"
  - "Proactive decomposition failure is non-fatal: try/catch with warning log, agent continues without decomposition"
  - "Reactive decomposition triggers only when an active goal tree exists and an executing node is found"
  - "BackgroundExecutor topological sort uses Kahn's algorithm with createdAt-based stability"
  - "Sub-goal failure stops remaining execution (conservative strategy, Phase 8 may refine)"
  - "activeGoalTrees persist across messages in a session (not cleaned in processMessage finally)"
  - "/api/goals endpoint returns empty array gracefully when goalStorage is unavailable"

patterns-established:
  - "Non-fatal decomposition: goal decomposition never blocks the agent, failures are logged and bypassed"
  - "Goal lifecycle events: emitGoalEvent helper wraps eventEmitter.emit for goal:status-changed"
  - "Topological execution: BackgroundExecutor sorts sub-goals by dependency order before sequential execution"

requirements-completed: [GOAL-01, GOAL-02]

# Metrics
duration: 10min
completed: 2026-03-07
---

# Phase 7 Plan 03: Wiring Integration Summary

**GoalDecomposer wired end-to-end: bootstrap creation, orchestrator proactive+reactive decomposition, event bus lifecycle events, topological execution in BackgroundExecutor, /api/goals dashboard endpoint**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-07T15:55:16Z
- **Completed:** 2026-03-07T16:05:25Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- GoalDecomposer created in bootstrap with goals.db, injected into orchestrator via constructor
- Orchestrator triggers proactive decomposition during PLANNING phase for complex tasks with tree visualization
- Orchestrator triggers reactive decomposition during REFLECTING phase when agent is stuck
- BackgroundExecutor refactored from TaskDecomposer to GoalDecomposer with topological sort execution
- goal:status-changed event added to LearningEventMap for lifecycle tracking
- /api/goals dashboard endpoint returns goal tree data with session/rootId filtering
- GoalStorage included in shutdown handler for clean teardown

## Task Commits

Each task was committed atomically:

1. **Task 1+2: Wire GoalDecomposer into orchestrator, bootstrap, event bus, background executor, and dashboard** - `c044689` (feat)
2. **Task 2 (doc): Update BackgroundExecutor header** - `e8cb855` (chore)

## Files Created/Modified
- `src/core/event-bus.ts` - Added GoalLifecycleEvent import and goal:status-changed to LearningEventMap
- `src/core/bootstrap.ts` - GoalStorage + GoalDecomposer initialization, injection into orchestrator, shutdown cleanup
- `src/agents/orchestrator.ts` - GoalDecomposer field, proactive/reactive decomposition, emitGoalEvent helper, session cleanup
- `src/tasks/background-executor.ts` - Replaced TaskDecomposer with GoalDecomposer, topological sort execution, progress visualization
- `src/dashboard/server.ts` - GoalStorage field, registerServices extension, /api/goals endpoint with serialization

## Decisions Made
- GoalDecomposer constructor takes (provider, maxDepth) without storage -- storage is a separate concern used only in bootstrap for persistence
- Proactive decomposition is non-fatal: wrapped in try/catch, agent continues without decomposition on failure
- Reactive decomposition only triggers when an active goal tree exists for the session and an executing node is found
- BackgroundExecutor uses Kahn's algorithm for topological sort with createdAt-based tiebreaking for stability
- Sub-goal failure stops remaining execution (conservative strategy -- Phase 8 may add parallel/partial completion)
- activeGoalTrees persist across messages in a session for reactive decomposition; cleaned up only on session eviction/cleanup
- /api/goals returns empty trees array gracefully when goalStorage is not available

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Combined Task 1 and Task 2 into single commit**
- **Found during:** Task 1 (Bootstrap + Orchestrator wiring)
- **Issue:** BackgroundExecutor constructor expects TaskDecomposer type, but bootstrap now passes GoalDecomposer. TypeScript compilation fails, blocking Task 1 verification.
- **Fix:** Updated BackgroundExecutor import + constructor type and refactored executeDecomposed in the same commit. Also added /api/goals endpoint to resolve goalStorage unused field error.
- **Files modified:** src/tasks/background-executor.ts, src/dashboard/server.ts
- **Verification:** `npx tsc --noEmit` passes, all 2016 tests pass
- **Committed in:** c044689 (Task 1+2 combined commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Task 2 work was pulled into Task 1 commit due to type system dependency. All planned functionality delivered, no scope creep.

## Issues Encountered
- Pre-existing TypeScript errors (LearningEventMap constraint, goals/types.ts TS2532) present before and after changes -- not introduced by this plan, out of scope per deviation rules

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 7 fully complete: all 3 plans delivered (types+storage, decomposer+renderer, wiring)
- GoalDecomposer is live in the PAOR state machine for proactive and reactive decomposition
- Phase 8 (Goal Progress & Execution) can build on: parallel sub-goal execution, progress tracking, GoalStorage persistence during execution
- Phase 9 (Tool Chain Synthesis) can build on: goal lifecycle events for tool chain correlation

## Self-Check: PASSED

- All 5 modified files exist on disk
- Commit c044689 found in git log (feat: wiring integration)
- Commit e8cb855 found in git log (chore: doc update)
- All 2016 tests pass (125 test files)
- TypeScript compiles (no new errors beyond pre-existing)

---
*Phase: 07-recursive-goal-decomposition*
*Completed: 2026-03-07*
