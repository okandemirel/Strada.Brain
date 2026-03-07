---
phase: 07-recursive-goal-decomposition
plan: 02
subsystem: goals
tags: [goal-decomposer, ascii-tree, dag-decomposition, llm, heuristic, tdd]

requires:
  - phase: 07-recursive-goal-decomposition
    plan: 01
    provides: GoalNode/GoalTree types, validateDAG, GoalStorage, parseLLMOutput
provides:
  - GoalDecomposer class with proactive and reactive DAG decomposition
  - GoalRenderer ASCII tree visualization with status icons
  - GOAL_MAX_DEPTH config option (1-5, default 3)
  - Module barrel exports (src/goals/index.ts)
affects: [07-03 orchestrator-integration, 08 goal-execution]

tech-stack:
  added: []
  patterns: [GoalDecomposer proactive/reactive dual-path, ASCII tree rendering with box-drawing, LLM ID remapping to branded GoalNodeId]

key-files:
  created:
    - src/goals/goal-decomposer.ts
    - src/goals/goal-decomposer.test.ts
    - src/goals/goal-renderer.ts
    - src/goals/goal-renderer.test.ts
    - src/goals/index.ts
  modified:
    - src/config/config.ts

key-decisions:
  - "GoalDecomposer takes IAIProvider | undefined (graceful fallback to single-node tree)"
  - "LLM string IDs remapped to branded GoalNodeId via idMap for type safety"
  - "Proactive decomposition uses hybrid depth strategy: depth 1-2 in LLM calls, needsFurtherDecomposition flag for recursion"
  - "Reactive decomposition includes completed-so-far context for LLM awareness"
  - "GOAL_MAX_DEPTH is a top-level config field (not nested) for simplicity"
  - "ASCII renderer uses box-drawing chars (+-- and \\--) for monospace compatibility across all channels"
  - "Large trees truncated at 3000 chars with summary and /api/goals pointer"

patterns-established:
  - "GoalDecomposer proactive/reactive dual-path: proactive for upfront tree, reactive for failing nodes"
  - "LLM ID remapping: create Map<string, GoalNodeId> then remap dependsOn references"
  - "ASCII tree rendering: STATUS_ICON + task text, box-drawing hierarchy with recursive renderNode"
  - "Module barrel: src/goals/index.ts re-exports all public types and classes"

requirements-completed: [GOAL-01, GOAL-02, GOAL-04, GOAL-05]

duration: 6min
completed: 2026-03-07
---

# Phase 7 Plan 02: GoalDecomposer and GoalRenderer Summary

**GoalDecomposer with proactive/reactive DAG decomposition, ASCII tree renderer with status icons, and GOAL_MAX_DEPTH config**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-07T15:44:49Z
- **Completed:** 2026-03-07T15:50:47Z
- **Tasks:** 2
- **Files created:** 5
- **Files modified:** 1

## Accomplishments
- GoalDecomposer replaces TaskDecomposer with DAG-based proactive and reactive decomposition
- Heuristic pre-check (shouldDecompose) reuses complexity/simple patterns from TaskDecomposer
- Proactive path: LLM produces DAG, validates with Kahn's cycle detection, retries once, falls back to single-node
- Reactive path: decomposes failing nodes with failure context, depth guard prevents infinite recursion
- GoalRenderer produces ASCII tree with status icons ([ ] [~] [x] [!] [-]) and box-drawing hierarchy
- Large trees (>3000 chars) truncated with summary and /api/goals pointer
- GOAL_MAX_DEPTH config added (1-5, default 3) with Zod validation
- Module barrel exports all public types and classes from src/goals/index.ts
- 21 new tests (13 decomposer + 8 renderer), 53 total goals tests passing

## Task Commits

Each task was committed atomically:

1. **Task 1: GoalDecomposer with proactive/reactive decomposition and GOAL_MAX_DEPTH config** - `9bba445` (feat)
2. **Task 2: GoalRenderer ASCII tree visualization and module barrel exports** - `70ad7a0` (feat)

## Files Created/Modified
- `src/goals/goal-decomposer.ts` - GoalDecomposer class with proactive/reactive decomposition, heuristic pre-check
- `src/goals/goal-decomposer.test.ts` - 13 tests: shouldDecompose, proactive DAG, depth limit, retry/fallback, reactive, cycles
- `src/goals/goal-renderer.ts` - renderGoalTree ASCII visualization, summarizeTree status counts
- `src/goals/goal-renderer.test.ts` - 8 tests: status icons, hierarchy, truncation, deep nesting, single-node
- `src/goals/index.ts` - Module barrel exports for all public types and classes
- `src/config/config.ts` - Added GOAL_MAX_DEPTH env var with Zod validation (int, 1-5, default 3)

## Decisions Made
- GoalDecomposer accepts IAIProvider | undefined -- gracefully falls back to single-node tree when no provider
- LLM string IDs (s1, s2, etc.) are remapped to branded GoalNodeIds via Map for type safety
- Proactive decomposition uses hybrid depth: depth 1-2 via LLM calls, needsFurtherDecomposition flag triggers recursion
- Reactive decomposition includes completed-so-far context so LLM knows what succeeded
- GOAL_MAX_DEPTH is a top-level Config field (not nested) since it is a single value
- ASCII renderer uses +-- and \-- box-drawing for monospace compatibility across all channels
- Truncation at 3000 chars with summary line and /api/goals pointer for full tree

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- GoalRenderer had TypeScript strict mode issues with `Record<string, number>` indexing (counts possibly undefined). Fixed by switching to individual counter variables instead of a record.
- Deep tree test initially failed due to indentation comparison using `search(/\S/)` on lines starting with box-drawing chars at column 0. Fixed by comparing `indexOf("[")` positions instead.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- GoalDecomposer and GoalRenderer ready for orchestrator integration (Plan 03)
- Module barrel exports provide clean import surface for consumers
- GOAL_MAX_DEPTH config ready for bootstrap wiring
- All 53 goals tests passing (32 foundation + 21 new)

## Self-Check: PASSED

All 5 new files verified on disk. Both commit hashes (9bba445, 70ad7a0) found in git log. 53 tests passing.

---
*Phase: 07-recursive-goal-decomposition*
*Completed: 2026-03-07*
