---
phase: 09-tool-chain-synthesis
plan: 03
subsystem: learning
tags: [tool-chain, lifecycle, bootstrap, composite-tool, detection, invalidation]

# Dependency graph
requires:
  - phase: 09-tool-chain-synthesis (plans 01-02)
    provides: ChainDetector, ChainSynthesizer, CompositeTool, ToolChainConfig, LearningStorage with trajectories
provides:
  - ChainManager lifecycle orchestrator (startup loading, periodic detection, auto-invalidation, shutdown)
  - Orchestrator addTool/removeTool for dynamic tool registration
  - CompositeTool.containsTool() and toolSequence getter
  - Full bootstrap wiring with shutdown integration
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [duck-type checking for CompositeTool in invalidation, lazy logger access pattern]

key-files:
  created:
    - src/learning/chains/chain-manager.ts
    - src/learning/chains/chain-manager.test.ts
  modified:
    - src/agents/orchestrator.ts
    - src/core/bootstrap.ts
    - src/learning/chains/composite-tool.ts
    - src/learning/chains/index.ts

key-decisions:
  - "Duck-type check (containsTool in tool) instead of instanceof CompositeTool for invalidation -- enables mocking and loose coupling"
  - "Lazy getLogger() calls inside methods instead of module-level const -- avoids logger-not-initialized errors in tests"
  - "ChainManager.start() non-fatal in bootstrap -- chain synthesis init failure does not block agent startup"
  - "Chain detection timer stopped before event bus drain in shutdown -- prevents new events during teardown"

patterns-established:
  - "Dynamic tool registration: addTool/removeTool on Orchestrator for runtime tool mutations"
  - "Lifecycle manager pattern: ChainManager encapsulates startup/detection/invalidation/shutdown cycle"

requirements-completed: [TOOL-01, TOOL-02, TOOL-03, TOOL-04, TOOL-05]

# Metrics
duration: 9min
completed: 2026-03-07
---

# Phase 9 Plan 03: Chain Manager Lifecycle & Bootstrap Wiring Summary

**ChainManager lifecycle orchestrator with startup chain loading, periodic detection, auto-invalidation, and full bootstrap wiring including shutdown integration**

## Performance

- **Duration:** 9 min
- **Started:** 2026-03-07T21:27:35Z
- **Completed:** 2026-03-07T21:36:02Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Orchestrator supports dynamic tool addition/removal via addTool()/removeTool()
- ChainManager loads existing chains on startup, runs periodic detection, auto-invalidates on tool removal
- Bootstrap wires ChainManager with proper dependency order (toolRegistry -> orchestrator -> learningStorage -> chainManager)
- Shutdown cleanly stops detection timer before draining event bus
- TOOL_CHAIN_ENABLED=false disables all chain synthesis (no loading, no timer)
- 2142 tests passing across 133 test files (12 new chain-manager tests)

## Task Commits

Each task was committed atomically:

1. **Task 1: Orchestrator addTool/removeTool + ChainManager lifecycle class** - `7b8e4ce` (test: RED), `dcc20b8` (feat: GREEN)
2. **Task 2: Bootstrap wiring and shutdown integration** - `bc3875e` (feat)

## Files Created/Modified
- `src/learning/chains/chain-manager.ts` - Lifecycle orchestrator: startup loading, periodic detection, auto-invalidation, shutdown
- `src/learning/chains/chain-manager.test.ts` - 12 test cases covering lifecycle, detection cycle, invalidation, timer
- `src/agents/orchestrator.ts` - addTool() and removeTool() methods for dynamic tool registration
- `src/core/bootstrap.ts` - ChainManager wired into bootstrap with config, storage, registry, provider, orchestrator
- `src/learning/chains/composite-tool.ts` - containsTool() method and toolSequence getter for invalidation checks
- `src/learning/chains/index.ts` - Barrel export of ChainManager

## Decisions Made
- Used duck-type checking (`"containsTool" in tool`) instead of `instanceof CompositeTool` for the invalidation path -- enables clean mocking in tests and loose coupling
- Lazy `getLogger()` calls inside methods rather than module-level `const logger = getLogger()` -- avoids logger initialization errors in test environments
- ChainManager.start() wrapped in try/catch in bootstrap -- chain synthesis is non-fatal, agent starts even if chain loading fails
- Chain detection timer stopped before event bus drain in shutdown order -- prevents new chain events during teardown

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Logger initialization at module scope**
- **Found during:** Task 1 (ChainManager implementation)
- **Issue:** `const logger = getLogger()` at module top level throws "Logger not initialized" in test environment
- **Fix:** Changed to lazy `getLogger()` calls inside each method (same pattern as embedding-queue.ts)
- **Files modified:** src/learning/chains/chain-manager.ts
- **Verification:** All 12 tests pass
- **Committed in:** dcc20b8

**2. [Rule 1 - Bug] instanceof check fails for mock objects**
- **Found during:** Task 1 (handleToolRemoved tests)
- **Issue:** `instanceof CompositeTool` check fails for mock objects in tests, causing invalidation to silently skip
- **Fix:** Changed to duck-type check: `"containsTool" in tool && typeof tool.containsTool === "function"`
- **Files modified:** src/learning/chains/chain-manager.ts
- **Verification:** handleToolRemoved tests pass
- **Committed in:** dcc20b8

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both auto-fixes necessary for correct test execution and runtime behavior. No scope creep.

## Issues Encountered
- Pre-existing TypeScript errors for `LearningEventMap` constraint (does not satisfy `Record<string, unknown>`) exist across 9 files -- not introduced by this plan, same pattern used in all event bus consumers

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 9 (Tool Chain Synthesis) is now COMPLETE -- all 3 plans executed
- All 5 TOOL requirements (TOOL-01 through TOOL-05) delivered
- The full chain synthesis pipeline is operational end-to-end: detection -> synthesis -> execution -> invalidation
- Agent Level 3 -> 4 evolution milestone complete (all 9 phases done)

## Self-Check: PASSED

- Files: All 6 source files verified present
- Commits: 7b8e4ce, dcc20b8, bc3875e all verified in git log
- Tests: 2142 passing (133 test files), 66 chain tests (5 test files)

---
*Phase: 09-tool-chain-synthesis*
*Completed: 2026-03-07*
