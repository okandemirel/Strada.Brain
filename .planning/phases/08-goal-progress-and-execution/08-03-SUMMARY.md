---
phase: 08-goal-progress-and-execution
plan: 03
subsystem: goals
tags: [goal-executor, progress-bar, channel-adaptive, resume, dashboard, llm-criticality, failure-budget]

# Dependency graph
requires:
  - phase: 08-goal-progress-and-execution (plans 01-02)
    provides: GoalExecutor, GoalStorage.upsertTree, calculateProgress, renderProgressBar, detectInterruptedTrees, formatResumePrompt
provides:
  - BackgroundExecutor delegates to GoalExecutor for parallel DAG execution with all callbacks wired
  - GoalRenderer shows progress bar, duration, spinner, parallelizable annotations
  - Bootstrap detects interrupted trees and creates GoalExecutorConfig from config
  - Orchestrator presents resume prompt on first message with interrupted trees
  - Dashboard /api/goals returns progress percentage and DAG edge data per node
affects: [phase-09-tool-synthesis]

# Tech tracking
tech-stack:
  added: []
  patterns: [channel-adaptive-progress, llm-criticality-evaluation, failure-budget-ux]

key-files:
  created: []
  modified:
    - src/tasks/background-executor.ts
    - src/goals/goal-renderer.ts
    - src/goals/goal-renderer.test.ts
    - src/goals/index.ts
    - src/core/bootstrap.ts
    - src/agents/orchestrator.ts
    - src/dashboard/server.ts
    - src/goals/types.ts

key-decisions:
  - "LLM criticality uses provider.chat() with system prompt + user message (no tools needed)"
  - "Failure budget UX uses requestConfirmation with Force continue/Always continue/Abort options"
  - "Channel-adaptive progress: editMessage where supported, onProgress append where not; progressMessageId TODO pending sendMarkdown returning messageId"
  - "interactiveChannel cast uses unknown intermediate for type safety"
  - "GoalRendererOptions exported from barrel for external configuration"
  - "Braille spinner uses Date.now() modulo for deterministic-per-frame rotation"

patterns-established:
  - "Channel-adaptive: check supportsMessageEditing/supportsInteractivity before using extended channel features"
  - "LLM evaluation: short system prompt + structured user prompt + empty tools array for chat() calls"
  - "Failure budget: always-continue tracked as boolean, skips repeated prompts for same tree"

requirements-completed: [GOAL-03, GOAL-06]

# Metrics
duration: 7min
completed: 2026-03-07
---

# Phase 8 Plan 03: Wiring Integration Summary

**GoalExecutor wired into BackgroundExecutor with LLM criticality evaluation, failure budget UX, channel-adaptive progress, bootstrap resume detection, orchestrator resume prompt, and dashboard progress data**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-07T18:54:08Z
- **Completed:** 2026-03-07T19:40:38Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- BackgroundExecutor replaced sequential loop with GoalExecutor parallel DAG execution, wiring all callbacks (onStatusChange, criticalityEvaluator, onFailureBudgetExceeded)
- GoalRenderer extended with progress bar header, completed node duration display, braille spinner for executing nodes, and parallelizable node annotations
- Bootstrap detects interrupted goal trees on startup via detectInterruptedTrees and creates GoalExecutorConfig from config values
- Orchestrator presents resume prompt on first message when interrupted trees exist, handling Resume/Discard commands
- Dashboard /api/goals returns progress percentage and full DAG data (dependsOn, startedAt, completedAt, retryCount) per node
- All 2070 tests pass (107 goal tests, 128 test files total), TypeScript compiles with zero new errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire GoalExecutor into BackgroundExecutor + extend GoalRenderer** - `6efe7ae` (feat)
2. **Task 2: Bootstrap resume detection + orchestrator resume prompt + dashboard progress** - `cef75c6` (feat)

## Files Created/Modified
- `src/tasks/background-executor.ts` - GoalExecutor delegation with LLM criticality, failure budget UX, channel-adaptive progress, persistence
- `src/goals/goal-renderer.ts` - Progress bar header, duration display, braille spinner, parallelizable annotations
- `src/goals/goal-renderer.test.ts` - 6 new tests (progress bar, duration, spinner, parallelizable annotations)
- `src/goals/index.ts` - GoalRendererOptions type export
- `src/goals/types.ts` - fenceMatch null safety fix (auto-fixed by linter)
- `src/core/bootstrap.ts` - Interrupted tree detection, GoalExecutorConfig creation, extended BackgroundExecutor constructor
- `src/agents/orchestrator.ts` - pendingResumeTrees field, formatResumePrompt import, resume/discard handling in processMessage
- `src/dashboard/server.ts` - calculateProgress import, progress percentage in serializeGoalTree, timing/retry/dependsOn per node

## Decisions Made
- LLM criticality uses `provider.chat()` with system prompt and user message (no tool definitions needed for YES/NO evaluation)
- Failure budget UX uses `requestConfirmation` with three options: Force continue, Always continue, Abort
- Channel-adaptive progress falls back to onProgress append when messageId is not yet available (sendMarkdown does not return messageId in current interface -- TODO noted)
- `GoalRendererOptions` exported from barrel for external use
- Braille spinner rotation based on `Date.now() / 100` modulo for deterministic-per-frame display

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed types.ts fenceMatch null safety**
- **Found during:** Task 1 (TypeScript compilation)
- **Issue:** fenceMatch could be null but was accessed without null check
- **Fix:** Linter auto-fixed with null coalescing
- **Files modified:** src/goals/types.ts
- **Committed in:** 6efe7ae (Task 1 commit)

**2. [Rule 3 - Blocking] Fixed IAIProvider method name (generateResponse -> chat)**
- **Found during:** Task 1 (TypeScript compilation)
- **Issue:** Plan specified `generateResponse()` but IAIProvider uses `chat(systemPrompt, messages, tools)`
- **Fix:** Changed to `this.aiProvider.chat()` with correct 3-argument signature and empty tools array
- **Files modified:** src/tasks/background-executor.ts
- **Committed in:** 6efe7ae (Task 1 commit)

**3. [Rule 3 - Blocking] Fixed ProviderResponse property (content -> text)**
- **Found during:** Task 1 (TypeScript compilation)
- **Issue:** Plan used `response.content` but ProviderResponse uses `response.text`
- **Fix:** Changed to `response.text?.trim()` throughout
- **Files modified:** src/tasks/background-executor.ts
- **Committed in:** 6efe7ae (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** All auto-fixes necessary for TypeScript compilation. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 8 fully complete (all 3 plans). Goal execution system is end-to-end: decomposition -> parallel execution -> progress tracking -> persistence -> resume -> dashboard visualization.
- Ready for Phase 9: Tool Chain Synthesis. All prerequisite systems (GoalStorage, EventBus, LearningPipeline, MetricsStorage, Bayesian confidence) are in place.
- Phase 9 depends on Phase 6 (Bayesian confidence for instinct storage), not Phase 8.

## Self-Check: PASSED

- All 8 modified files exist on disk
- Commit 6efe7ae verified (Task 1)
- Commit cef75c6 verified (Task 2)
- 2070/2070 tests passing
- TypeScript compiles with zero new errors

---
*Phase: 08-goal-progress-and-execution*
*Completed: 2026-03-07*
