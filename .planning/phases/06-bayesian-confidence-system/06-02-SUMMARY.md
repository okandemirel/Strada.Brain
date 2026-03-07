---
phase: 06-bayesian-confidence-system
plan: 02
subsystem: learning
tags: [bayesian, cooling, promotion, lifecycle, state-machine, event-bus]

requires:
  - phase: 06-bayesian-confidence-system
    plan: 01
    provides: "BayesianConfig, InstinctLifecycleEvent, ConfidenceScorer pure Beta posterior, lifecycle tables, permanent status"
  - phase: 04-event-driven-learning
    provides: "TypedEventBus, LearningEventMap, ToolResultEvent, event-driven pipeline"
provides:
  - "Cooling state machine in LearningPipeline (cooling start, deprecation, recovery)"
  - "Auto-promotion to permanent at > 0.95 confidence with >= 25 observations"
  - "Lifecycle event emission on TypedEventBus (cooling-started, deprecated, promoted)"
  - "Lifecycle log entries and weekly counters written on transitions"
  - "appliedInstinctIds wired from orchestrator through tool:result events"
  - "BayesianConfig and IEventBus injected into LearningPipeline via bootstrap"
affects: [06-03, learning-pipeline, orchestrator, bootstrap]

tech-stack:
  added: []
  patterns:
    - "Cooling state machine with hybrid deprecation trigger (time OR failures)"
    - "Per-session instinct ID tracking via Map<chatId, string[]> in orchestrator"
    - "Fire-and-forget lifecycle persistence (try/catch wrappers for non-critical writes)"

key-files:
  created:
    - ".planning/phases/06-bayesian-confidence-system/06-02-SUMMARY.md"
  modified:
    - "src/learning/pipeline/learning-pipeline.ts"
    - "src/learning/pipeline/learning-pipeline.test.ts"
    - "src/agents/orchestrator.ts"
    - "src/agents/orchestrator.test.ts"
    - "src/core/bootstrap.ts"

key-decisions:
  - "Default BayesianConfig in pipeline: provides sensible defaults when no config injected (same values as Zod defaults)"
  - "Cooling state machine uses status field to represent state: coolingStartedAt non-null means cooling, combined with existing status"
  - "Lifecycle log toStatus uses 'cooling' string for cooling-start entries (not a real InstinctStatus, but descriptive for log queries)"
  - "Per-session instinct IDs stored in Map and cleaned up in finally block to prevent memory leaks"
  - "EventBus created before LearningPipeline in bootstrap so it can be injected at construction"
  - "coolingFailures incremented in handleToolResult for failure events on cooling instincts"

patterns-established:
  - "Cooling state machine: confidence < threshold + min observations -> cooling -> time/failure trigger -> deprecation"
  - "Lifecycle event + log + counter triple on every status transition"
  - "appliedInstinctIds attribution: orchestrator captures IDs per-message, emits in tool:result events"

requirements-completed: [EVAL-04, EVAL-05, EVAL-06]

duration: 6min
completed: 2026-03-07
---

# Phase 6 Plan 2: Lifecycle State Machine & appliedInstinctIds Wiring Summary

**Cooling/promotion state machine with hybrid deprecation triggers, lifecycle event emission, and appliedInstinctIds attribution from orchestrator to tool:result events**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-07T12:06:43Z
- **Completed:** 2026-03-07T12:12:34Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Cooling state machine: instincts enter cooling at confidence < 0.3 with >= 10 observations, deprecate after 7 days or 3 consecutive failures, recover when confidence rises above 0.3
- Auto-promotion: instincts with > 0.95 confidence and >= 25 observations become permanent with frozen confidence
- Lifecycle events emitted on TypedEventBus for cooling-started, deprecated, and promoted transitions
- Lifecycle log entries and weekly counters persisted to SQLite on every transition
- appliedInstinctIds wired end-to-end: orchestrator captures per-message instinct IDs, includes them in tool:result events
- Bootstrap injects BayesianConfig and IEventBus into LearningPipeline constructor
- 18 new tests (15 pipeline + 3 orchestrator), all 1951 tests green

## Task Commits

Each task was committed atomically:

1. **Task 1: Cooling/promotion state machine and lifecycle events in pipeline** - `2322138` (feat)
2. **Task 2: Orchestrator appliedInstinctIds wiring and bootstrap config injection** - `aadce2e` (feat)

## Files Created/Modified
- `src/learning/pipeline/learning-pipeline.ts` - Added BayesianConfig/IEventBus constructor params, cooling/promotion state machine in updateInstinctStatus(), lifecycle event emission, lifecycle log/counter helpers, permanent instinct handling
- `src/learning/pipeline/learning-pipeline.test.ts` - Added 15 Bayesian lifecycle state machine tests covering cooling, deprecation, promotion, recovery, events, logs, counters, permanent freeze, attribution
- `src/agents/orchestrator.ts` - Added currentSessionInstinctIds Map, wired matchedInstinctIds into map at processMessage start, included in emitToolResult payload, cleanup in finally block
- `src/agents/orchestrator.test.ts` - Added 3 appliedInstinctIds wiring tests (matched IDs, empty array, per-message isolation)
- `src/core/bootstrap.ts` - EventBus created before pipeline for injection, config.bayesian and eventBus passed to LearningPipeline constructor

## Decisions Made
- **Default BayesianConfig in pipeline:** Provides sensible defaults matching Zod schema defaults when no external config is injected. This means the pipeline works standalone in tests without requiring full config.
- **Cooling state tracking:** Uses coolingStartedAt (timestamp) and coolingFailures (counter) fields on Instinct rather than a separate cooling status. The instinct's status remains "active" during cooling, with the cooling fields acting as a sub-state.
- **EventBus creation order in bootstrap:** Moved eventBus creation before pipeline construction so it can be injected at the constructor level rather than post-initialization.
- **Per-session ID cleanup:** Using Map.delete in the finally block ensures instinct IDs are cleaned up even on errors, preventing memory leaks for long-running agents.
- **coolingFailures increment location:** Incremented in handleToolResult (before updateConfidence) so the failure count is accurate when the state machine checks it during updateInstinctStatus.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- EVAL-04 (pure Bayesian updates wired end-to-end with appliedInstinctIds), EVAL-05 (cooling period with hybrid triggers), and EVAL-06 (promotion to permanent) are all complete
- Plan 03 (leaderboard, metrics CLI lifecycle section, dashboard integration) can proceed
- All 1951 tests pass with 0 regressions

## Self-Check: PASSED

All files exist, all commits verified, all 1951 tests pass.

---
*Phase: 06-bayesian-confidence-system*
*Completed: 2026-03-07*
