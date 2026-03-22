# Stage 5: Orchestrator Maximal Extraction

## Context
orchestrator.ts is 7,773 lines with two near-identical agent loops:
- `runBackgroundTask` (1,915 lines) — epoch-cycling, progress emission, loop recovery
- `runAgentLoop` (1,387 lines) — streaming, goal decomposition, direct user delivery

Stage 4 extracted 5 shared functions into `orchestrator-loop-utils.ts` (182 lines).
Stage 5 continues with deeper extraction to reduce orchestrator.ts to ~5,200 lines.

## Approach: Maximal Extraction (not unification)
Keep two loop functions but reduce each to thin orchestration wrappers (~300 lines each).
Shared logic moves to focused utility modules.

## Extraction Targets (order = safe → risky)

### 1. buildContentBlocks + recordStepResults → orchestrator-loop-utils.ts
**Lines saved:** ~90
- `buildContentBlocks()` — assembles state context + reflection prompt + tool results into content blocks
  - bg: lines 3783-3809, interactive: lines 5494-5517
  - 100% identical pattern
- `recordStepResults()` — records each tool call as StepResult, checks reflection trigger
  - bg: lines 3743-3781, interactive: lines 5463-5492
  - Only difference: bg emits progress on reflection trigger, interactive doesn't
  - Extract core logic, return `{ agentState, shouldReflect }`, caller handles progress

### 2. runConsensusFlow → orchestrator-consensus.ts (~100 lines)
**Lines saved:** ~160
- 4 call sites: bg tool (3662-3741), interactive text (5081-5151), interactive tool (5382-5461), bg text (implicit in reflecting)
- Pattern: classify → estimate confidence → shouldConsult → resolve reviewer → verify → record trace + outcome
- Self-contained: receives classifiers + managers as params, returns void

### 3. executeAndTrackTools → orchestrator-tool-execution.ts (~120 lines)
**Lines saved:** ~130
- bg: lines 3579-3661, interactive: lines 5316-5380
- Pattern: executeToolCalls → for each result: track in planner/verifier/conformance → error recovery → emit → journal
- Differences: bg has workerCollector, interactive has stradaConformance deep tracking
- Extract shared tracking, caller passes optional workerCollector/stradaConformance

### 4. buildLoopPrompt → orchestrator-loop-utils.ts
**Lines saved:** ~40
- bg: lines 2232-2255, interactive: lines 4363-4395
- Phase-aware switch (PLANNING/EXECUTING/REPLANNING) + journal section
- Already designed in reverted Stage 1 as `buildPhasePromptSection()`

### 5. Setup phase → orchestrator-loop-utils.ts
**Lines saved:** ~150
- `buildSharedAutonomyContext()` — creates ErrorRecoveryEngine, TaskPlanner, SelfVerification, ExecutionJournal, StradaConformanceGuard, ControlLoopTracker
- `buildSharedPAORState()` — creates initial agent state, execution strategy, instinct retrieval
- bg: lines 2134-2185, interactive: lines 4284-4352
- ~80% overlap, differences parameterized

### 6. REFLECTING handler → orchestrator-reflecting.ts (~450 lines)
**Lines saved:** ~700
- Largest extraction, highest risk
- **Strategy pattern**: caller provides callbacks for loop-specific behavior:
  - `deliverMessage(session, text)` — bg: appendVisible, interactive: sendMarkdown
  - `finishLoop(text, status?)` — bg: finish(), interactive: return
  - `persistSession?()` — bg: persistSessionToMemory, interactive: no-op
  - `getLoopRecovery?(params)` — bg: handleBackgroundLoopRecovery, interactive: null
  - `getVisibilityBoundary(params)` — bg: decideUserVisibleBoundary, interactive: resolveVisibleDraftDecision
- Shared decision tree: preamble → plan review → write rejection → clarification → verifier → visibility → REPLAN/CONTINUE
- Each intervention point delegates to strategy for loop-specific handling

## File Changes Summary

| File | Before | After | Delta |
|------|--------|-------|-------|
| orchestrator.ts | 7,773 | ~5,200 | -2,573 |
| orchestrator-loop-utils.ts | 182 | ~450 | +268 |
| orchestrator-consensus.ts | 0 | ~100 | +100 |
| orchestrator-tool-execution.ts | 0 | ~120 | +120 |
| orchestrator-reflecting.ts | 0 | ~450 | +450 |
| **Net** | 7,955 | **~6,320** | **-1,635** |

## Constraints
- Pure extraction: behavior MUST NOT change
- Test files MUST NOT be modified
- 105 orchestrator tests must pass after each extraction
- 4,162 full suite tests must pass at end
- Each extraction is an atomic step verified independently
