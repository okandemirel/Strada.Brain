---
phase: 04-event-driven-learning
plan: 02
subsystem: learning
tags: [event-wiring, event-bus, orchestrator, task-planner, confidence-scoring, decoupling]

# Dependency graph
requires:
  - phase: 04-event-driven-learning
    plan: 01
    provides: TypedEventBus (IEventEmitter/IEventBus), LearningQueue, ToolResultEvent type
provides:
  - Orchestrator emits tool:result events for every tool call via IEventEmitter
  - LearningPipeline.handleToolResult() for per-event processing (observe + process + confidence)
  - getVerdictScore() weighted confidence tiers (0.9/0.6/0.2)
  - Bootstrap wiring of event bus, learning queue, and shutdown orchestration
affects: [05-metrics-instrumentation, 06-bayesian-confidence]

# Tech tracking
tech-stack:
  added: []
  patterns: [event-driven-learning, emit-only-interface, weighted-verdict-scoring, serial-queue-subscription]

key-files:
  created: []
  modified:
    - src/learning/scoring/confidence-scorer.ts
    - src/learning/scoring/confidence-scorer.test.ts
    - src/learning/pipeline/learning-pipeline.ts
    - src/learning/pipeline/learning-pipeline.test.ts
    - src/learning/index.ts
    - src/agents/orchestrator.ts
    - src/agents/orchestrator.test.ts
    - src/agents/autonomy/task-planner.ts
    - src/agents/autonomy/task-planner.test.ts
    - src/core/bootstrap.ts

key-decisions:
  - "Detection batch timer removed from start() -- only evolution timer remains, event-driven processing replaces batch detection"
  - "Confidence updates filtered by tool_name contextCondition match to prevent false attribution"
  - "appliedInstinctIds left undefined in orchestrator emit for now -- Phase 6 (Bayesian Confidence) will wire IDs through AgentState"
  - "Shutdown order: drain event bus -> drain queue -> stop pipeline (ensures in-flight events complete)"
  - "Event emission uses chatId as sessionId (orchestrator doesn't track separate session IDs)"

patterns-established:
  - "Emit-only injection: Orchestrator receives IEventEmitter (emit-only), cannot subscribe to events"
  - "Serial queue subscription: Bootstrap routes eventBus.on('tool:result') through LearningQueue.enqueue() for SQLite safety"
  - "Weighted verdict scoring: getVerdictScore maps tool outcomes to confidence impact tiers"
  - "Per-event processing: handleToolResult runs full pipeline (observe + process + confidence) for each event"

requirements-completed: [LRN-01, LRN-02, LRN-05]

# Metrics
duration: 7min
completed: 2026-03-06
---

# Phase 4 Plan 2: Event-Driven Learning Wiring Summary

**Orchestrator emits tool:result events, learning pipeline processes per-event with weighted confidence scoring, TaskPlanner decoupled via event bus**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-06T22:15:21Z
- **Completed:** 2026-03-06T22:21:55Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- Orchestrator emits `tool:result` events for every tool call in both runAgentLoop and runBackgroundTask
- LearningPipeline.handleToolResult() runs observation + pattern detection + confidence update per event, replacing batch detection timer
- TaskPlanner no longer directly calls pipeline.observeToolUse() -- events replace the coupling
- Bootstrap creates TypedEventBus, subscribes pipeline via LearningQueue, passes IEventEmitter to Orchestrator
- Weighted confidence scoring: clean success=0.9, retry-success=0.6, hard failure=0.2
- Shutdown sequence properly drains event bus and queue before stopping pipeline
- 15 new tests across 4 test files, full suite passes (1862 tests)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add weighted confidence scoring and handleToolResult** - `d63a056` (feat)
2. **Task 2: Orchestrator event emission and TaskPlanner decoupling** - `cf9733a` (feat)
3. **Task 3: Bootstrap wiring and shutdown orchestration** - `75c2c4e` (feat)

_Tasks 1 and 2 followed TDD: RED (failing tests) -> GREEN (implementation) -> verify_

## Files Created/Modified
- `src/learning/scoring/confidence-scorer.ts` - Added getVerdictScore() exported function with 3 weighted tiers
- `src/learning/scoring/confidence-scorer.test.ts` - 3 new tests for getVerdictScore
- `src/learning/pipeline/learning-pipeline.ts` - Added handleToolResult(), removed detection timer from start()
- `src/learning/pipeline/learning-pipeline.test.ts` - 6 new tests for handleToolResult and timer removal
- `src/learning/index.ts` - Export getVerdictScore from scoring module
- `src/agents/orchestrator.ts` - Added IEventEmitter injection and tool:result emission in both loops
- `src/agents/orchestrator.test.ts` - 4 new tests for event emission and graceful degradation
- `src/agents/autonomy/task-planner.ts` - Removed direct pipeline.observeToolUse() from trackToolCall
- `src/agents/autonomy/task-planner.test.ts` - 2 new tests for decoupling verification
- `src/core/bootstrap.ts` - Event bus creation, queue subscription, orchestrator wiring, shutdown ordering

## Decisions Made
- **Detection timer removal:** The batch detection timer is removed from `start()`. Only the evolution timer remains. Per-event processing via `handleToolResult()` replaces the batch timer. `runDetectionBatch()` method kept intact for potential manual/fallback use.
- **Confidence filtering:** Confidence updates only apply to instincts whose `contextConditions` include a `tool_name` matching the event's tool name. Instincts with no context conditions (length 0) also match (universal instincts).
- **appliedInstinctIds deferred:** Orchestrator does not yet populate `appliedInstinctIds` in emitted events -- InstinctRetriever returns formatted strings, not IDs. Phase 6 (Bayesian Confidence) will properly wire instinct IDs through AgentState.
- **Shutdown ordering:** Event bus shutdown first (stops accepting new events, drains in-flight), then learning queue shutdown (drains current item), then pipeline stop (clears evolution timer, shuts down embedding queue).
- **sessionId mapping:** Orchestrator uses `chatId` as the sessionId for emitted events since it does not maintain separate learning session IDs.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Event-driven learning fully wired: orchestrator -> event bus -> learning queue -> pipeline
- Phase 4 complete (both plans)
- Phase 5 (Metrics Instrumentation) can proceed
- Phase 6 (Bayesian Confidence) will add appliedInstinctIds to event payloads
- No new dependencies added

## Self-Check: PASSED

- All 10 modified files exist on disk
- All 3 commits found in git log (d63a056, cf9733a, 75c2c4e)
- 1862/1862 tests pass (118 test files)

---
*Phase: 04-event-driven-learning*
*Completed: 2026-03-06*
