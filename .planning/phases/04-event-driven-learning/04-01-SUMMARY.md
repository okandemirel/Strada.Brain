---
phase: 04-event-driven-learning
plan: 01
subsystem: learning
tags: [event-bus, async-queue, node-events, typed-events, serial-processing]

# Dependency graph
requires:
  - phase: 03-auto-tiering
    provides: EmbeddingQueue pattern (bounded FIFO, serial async, graceful shutdown)
provides:
  - TypedEventBus with IEventEmitter (emit-only) and IEventBus (full) interfaces
  - LearningEventMap with tool:result -> ToolResultEvent typed event mapping
  - LearningQueue serial async processor with FIFO eviction
affects: [04-02-event-wiring, 05-metrics-instrumentation]

# Tech tracking
tech-stack:
  added: []
  patterns: [typed-event-bus, serial-async-queue, emit-only-interface, drain-signal-testing]

key-files:
  created:
    - src/core/event-bus.ts
    - src/core/event-bus.test.ts
    - src/learning/pipeline/learning-queue.ts
    - src/learning/pipeline/learning-queue.test.ts
  modified: []

key-decisions:
  - "ToolResultEvent errorDetails defined inline (not imported from learning/types.ts) to keep core self-contained"
  - "TypedEventBus wraps Node.js EventEmitter with listener-to-wrapper map for correct off() behavior"
  - "LearningQueue shutdown discards remaining items (only in-flight item completes) matching plan spec"
  - "Async listener in-flight tracking uses counter + drain resolvers pattern for shutdown await"

patterns-established:
  - "Emit-only interface pattern: IEventEmitter restricts orchestrator to emit() only at compile time"
  - "Drain signal pattern: enqueue a sentinel to wait for all items to complete (used in tests)"
  - "Wrapper-map pattern: on() wraps listeners for error isolation; off() looks up wrapper from map"

requirements-completed: [LRN-02, LRN-06]

# Metrics
duration: 5min
completed: 2026-03-06
---

# Phase 4 Plan 1: Event-Driven Learning Infrastructure Summary

**TypedEventBus on Node.js EventEmitter with typed LearningEventMap and LearningQueue serial async processor with bounded FIFO eviction**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-06T22:06:05Z
- **Completed:** 2026-03-06T22:11:20Z
- **Tasks:** 2
- **Files created:** 4

## Accomplishments
- TypedEventBus provides compile-time typed events via LearningEventMap with IEventEmitter (emit-only) and IEventBus (full on/off/shutdown) interfaces
- LearningQueue processes async functions serially with bounded 1000-item capacity and FIFO eviction, preventing SQLite lock contention
- Both components handle errors with log-and-continue strategy and support graceful shutdown with in-flight draining
- 18 tests total (10 event-bus + 8 learning-queue) covering all required behaviors

## Task Commits

Each task was committed atomically:

1. **Task 1: TypedEventBus with emit-only and full interfaces** - `1e603de` (feat)
2. **Task 2: LearningQueue serial async processor** - `849e812` (feat)

_Both tasks followed TDD: RED (failing tests) -> GREEN (implementation) -> verify_

## Files Created/Modified
- `src/core/event-bus.ts` - TypedEventBus, IEventEmitter, IEventBus, LearningEventMap, ToolResultEvent (191 lines)
- `src/core/event-bus.test.ts` - 10 tests: sync/async emit, on/off, shutdown drain, error isolation (155 lines)
- `src/learning/pipeline/learning-queue.ts` - LearningQueue serial async processor with FIFO eviction (90 lines)
- `src/learning/pipeline/learning-queue.test.ts` - 8 tests: serial ordering, FIFO eviction, shutdown, error isolation (200 lines)

## Decisions Made
- **Inline errorDetails type:** ToolResultEvent defines `errorDetails?: { code?: string; category: string; message: string }` inline rather than importing ErrorDetails from learning/types.ts. This keeps src/core/ self-contained and avoids coupling core to learning types. The learning pipeline listener can map the full ErrorDetails type to this shape.
- **Wrapper-map for off():** TypedEventBus maintains a Map from original listeners to wrapped listeners so that off() can correctly remove the error-catching wrapper from the underlying EventEmitter.
- **Shutdown discards remaining:** LearningQueue.shutdown() sets stopped flag, then awaits the currently in-flight item. The stopped flag causes processNext() loop to exit, discarding items remaining in the queue. This matches the plan specification.
- **Drain signal testing pattern:** Tests that need all items processed use a sentinel enqueue (withDrainSignal helper) rather than shutdown(), since shutdown discards remaining items.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- TypedEventBus and LearningQueue are ready for Plan 02 to wire into existing subsystems
- Orchestrator will receive IEventEmitter to emit tool:result events
- Learning pipeline will subscribe via IEventBus and route events through LearningQueue
- No new dependencies added (only node:events built-in)

## Self-Check: PASSED

- All 4 files exist on disk
- Both commits (1e603de, 849e812) found in git log
- 18/18 tests pass

---
*Phase: 04-event-driven-learning*
*Completed: 2026-03-06*
