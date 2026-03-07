---
phase: 08-goal-progress-and-execution
plan: 02
subsystem: goals
tags: [dag-execution, semaphore, failure-budget, criticality-evaluation, resume, tdd]

# Dependency graph
requires:
  - phase: 08-goal-progress-and-execution plan 01
    provides: GoalNode timing fields, GoalStorage upsert/interrupted-tree methods, progress functions, execution config options
provides:
  - GoalExecutor class with wave-based parallel DAG execution
  - Semaphore class for concurrency limiting
  - LLM criticality evaluation callback for failure propagation decisions
  - Failure budget with force-continue and alwaysContinue options
  - FailureReport with failed node details for user-facing display
  - Per-node retry logic (up to maxRetries)
  - Per-node timing (startedAt, completedAt)
  - goal-resume module for interrupted tree detection and smart resume
  - formatResumePrompt for user-facing resume messages with ASCII tree
affects: [08-goal-progress-and-execution plan 03 (wiring), background-executor integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [wave-based parallel execution via Promise.allSettled, queue-based semaphore, callback injection for LLM criticality and failure budget decisions]

key-files:
  created:
    - src/goals/goal-executor.ts
    - src/goals/goal-executor.test.ts
    - src/goals/goal-resume.ts
    - src/goals/goal-resume.test.ts
  modified:
    - src/goals/index.ts

key-decisions:
  - "Failure budget threshold uses >= comparison (failureCount >= maxFailures) not > for immediate trigger"
  - "CriticalityEvaluator is a callback injected by caller (BackgroundExecutor), GoalExecutor does not call LLM directly"
  - "Non-critical failed nodes tracked in separate Set (nonCriticalFailedIds) to allow dependents to proceed"
  - "Dependency-blocked nodes get skipped status (distinct from failed) via a separate code path"
  - "Root node excluded from execution (pre-populated in completedIds)"
  - "Resume module resets executing nodes to pending, preserves completed/failed nodes"
  - "Staleness threshold is 24 hours based on latest node updatedAt"

patterns-established:
  - "Wave-based execution: while loop finds ready nodes, executes wave via Promise.allSettled, checks budget/abort after each wave"
  - "Callback injection: NodeExecutor, CriticalityEvaluator, OnFailureBudgetExceeded injected by caller for decoupled design"
  - "Smart resume: reset executing->pending, preserve completed (don't re-do work)"

requirements-completed: [GOAL-06]

# Metrics
duration: 6min
completed: 2026-03-07
---

# Phase 8 Plan 02: GoalExecutor & Goal Resume Summary

**Wave-based parallel DAG executor with semaphore concurrency, LLM criticality evaluation, failure budgets with force-continue, and smart resume for interrupted trees**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-07T18:43:04Z
- **Completed:** 2026-03-07T18:48:50Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- GoalExecutor executes DAG nodes in wave-based parallel order with semaphore limiting concurrent execution to configurable max
- CriticalityEvaluator callback determines if a node's failure propagates to dependents (LLM decides at runtime)
- Failure budget with FailureReport, force-continue option, and alwaysContinue flag to skip repeated prompts
- Failed nodes retry up to maxRetries times before being marked as failed
- Independent siblings continue executing when one fails (Promise.allSettled pattern)
- goal-resume module detects interrupted trees and prepares them for smart resume (executing->pending)
- formatResumePrompt renders user-facing ASCII tree with progress bar and Resume/Discard options
- 33 new tests (21 executor + 12 resume), 101 total goal tests passing

## Task Commits

Each task was committed atomically:

1. **Task 1: GoalExecutor with wave-based parallel execution, semaphore, failure budget, LLM criticality evaluation, and retries** - `46f7f23` (feat)
2. **Task 2: Goal resume module for interrupted tree detection and smart resume preparation** - `1a4b1b7` (feat)

_Both tasks followed TDD: RED (failing tests with stubs) then GREEN (implementation to pass)._

## Files Created/Modified
- `src/goals/goal-executor.ts` - GoalExecutor class, Semaphore, FailureReport, callback types (~260 lines)
- `src/goals/goal-executor.test.ts` - 21 tests for parallel execution, dependency ordering, failure budget, retries, semaphore, criticality
- `src/goals/goal-resume.ts` - detectInterruptedTrees, prepareTreeForResume, isTreeStale, formatResumePrompt (~95 lines)
- `src/goals/goal-resume.test.ts` - 12 tests for resume detection, tree preparation, staleness, prompt formatting
- `src/goals/index.ts` - Updated barrel exports with executor, resume, and all new types

## Decisions Made
- Failure budget threshold uses >= comparison (failureCount >= maxFailures) so budget triggers immediately when limit reached, not on the next failure
- CriticalityEvaluator is a callback injected by the caller (BackgroundExecutor in Plan 03), not an LLM call inside GoalExecutor -- keeps executor decoupled from AI providers
- Non-critical failed nodes tracked in a separate Set (nonCriticalFailedIds) so their dependents can proceed while critical failures still block
- Dependency-blocked nodes get "skipped" status through a distinct code path from retry-exhausted failures
- Root node excluded from execution by pre-populating completedIds with already-completed nodes
- Resume module resets only executing nodes to pending; completed and failed nodes are preserved for user review
- Staleness threshold set at 24 hours using the latest node updatedAt timestamp

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. GoalExecutor uses config values from Plan 01 (GOAL_MAX_RETRIES, GOAL_MAX_FAILURES, GOAL_PARALLEL_EXECUTION, GOAL_MAX_PARALLEL).

## Next Phase Readiness
- GoalExecutor ready for wiring into BackgroundExecutor (Plan 03)
- CriticalityEvaluator hook ready for LLM integration via BackgroundExecutor's AI provider access
- OnFailureBudgetExceeded hook ready for user-facing prompt integration
- goal-resume ready for bootstrap startup detection and user prompt flow
- All callback types exported from barrel for consumer use

## Self-Check: PASSED

- All 5 files verified on disk (goal-executor.ts, goal-executor.test.ts, goal-resume.ts, goal-resume.test.ts, index.ts)
- Commit 46f7f23 verified (Task 1: GoalExecutor)
- Commit 1a4b1b7 verified (Task 2: goal-resume + barrel)
- 101 goal tests passing (7 test files)

---
*Phase: 08-goal-progress-and-execution*
*Completed: 2026-03-07*
