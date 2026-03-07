---
phase: 07-recursive-goal-decomposition
plan: 01
subsystem: goals
tags: [dag, kahn-algorithm, sqlite, zod, branded-types, goal-decomposition]

requires:
  - phase: 04-event-driven-learning
    provides: TypedEventBus for GoalLifecycleEvent emission
provides:
  - GoalNodeId branded type and GoalNode/GoalTree interfaces
  - Zod-validated LLM decomposition output schema
  - DAG validator with Kahn's algorithm (cycle detection + topological sort)
  - GoalStorage SQLite persistence (goals.db) with CRUD + cascade delete
affects: [07-02 goal-decomposer, 07-03 orchestrator-integration, 08 goal-execution]

tech-stack:
  added: [goals.db SQLite database]
  patterns: [GoalNodeId branded type, DAG validation via Kahn's algorithm, GoalStorage prepared statement pattern]

key-files:
  created:
    - src/goals/types.ts
    - src/goals/goal-validator.ts
    - src/goals/goal-validator.test.ts
    - src/goals/goal-storage.ts
    - src/goals/goal-storage.test.ts

key-decisions:
  - "GoalNodeId uses branded type pattern (string & __brand) matching TaskId convention"
  - "Kahn's algorithm chosen for cycle detection (O(V+E), also produces topological order)"
  - "GoalStorage uses 'tasks' SQLite profile (8MB cache) following LearningStorage pattern"
  - "FK cascade delete on goal_nodes ensures tree cleanup is atomic"
  - "parseLLMOutput strips markdown fences before JSON parsing for robust LLM output handling"
  - "Zod schema limits nodes to max 20 per decomposition (prevents runaway expansion)"

patterns-established:
  - "GoalNodeId branded type: goal_<timestamp>_<hex>"
  - "GoalTree uses ReadonlyMap for immutable node access"
  - "DAG validation before tree persistence (validate then persist)"
  - "GoalStorage follows LearningStorage SQLite pattern (pragmas, prepared statements, schema)"

requirements-completed: [GOAL-02, GOAL-04, GOAL-05]

duration: 3min
completed: 2026-03-07
---

# Phase 7 Plan 01: Goal Foundation Summary

**GoalNode DAG types with Zod-validated LLM output, Kahn's cycle detection, and SQLite persistence in goals.db**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-07T15:37:02Z
- **Completed:** 2026-03-07T15:40:52Z
- **Tasks:** 2
- **Files created:** 5

## Accomplishments
- GoalNode/GoalTree types with branded GoalNodeId and readonly interfaces
- Zod schema validates LLM decomposition output (1-20 nodes, required id/task fields)
- parseLLMOutput handles markdown fences, invalid JSON, and missing fields gracefully
- validateDAG detects cycles via Kahn's algorithm and rejects dangling dependency refs
- GoalStorage persists/retrieves/updates/deletes goal trees in goals.db with cascade
- 32 tests covering all behaviors: cycles, dangling refs, topological order, CRUD, cascade

## Task Commits

Each task was committed atomically:

1. **Task 1: GoalNode types, Zod LLM schema, DAG validator** - `314403c` (feat)
2. **Task 2: GoalStorage with SQLite persistence** - `abf7f69` (feat)

## Files Created/Modified
- `src/goals/types.ts` - GoalNodeId, GoalNode, GoalTree, GoalStatus, LLMDecompositionOutput, Zod schema, parseLLMOutput
- `src/goals/goal-validator.ts` - validateDAG with Kahn's algorithm, DAGValidationResult
- `src/goals/goal-validator.test.ts` - 23 tests: cycles, dangling refs, topological order, Zod validation, parseLLMOutput
- `src/goals/goal-storage.ts` - GoalStorage class with SQLite persistence (goals.db)
- `src/goals/goal-storage.test.ts` - 9 tests: CRUD, cascade delete, session queries, close behavior

## Decisions Made
- GoalNodeId uses `goal_<timestamp>_<hex>` branded type pattern matching TaskId convention
- Kahn's algorithm chosen for cycle detection (O(V+E), produces topological order as byproduct)
- GoalStorage uses "tasks" SQLite profile (8MB cache, WAL mode, FK ON)
- FK CASCADE DELETE on goal_nodes ensures tree cleanup without manual node deletion
- parseLLMOutput strips markdown code fences before JSON parsing for robust LLM output handling
- Zod schema limits to max 20 nodes per decomposition to prevent runaway expansion

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- GoalNode types and GoalStorage ready for GoalDecomposer (Plan 02)
- validateDAG ready for integration with LLM decomposition pipeline
- GoalLifecycleEvent type ready for event bus emission in orchestrator integration (Plan 03)

## Self-Check: PASSED

All 5 files verified on disk. Both commit hashes (314403c, abf7f69) found in git log. 32 tests passing.

---
*Phase: 07-recursive-goal-decomposition*
*Completed: 2026-03-07*
