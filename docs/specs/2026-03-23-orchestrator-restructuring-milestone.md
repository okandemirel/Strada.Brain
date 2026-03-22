# Orchestrator Architectural Restructuring

## Problem

orchestrator.ts is 7,315 lines with 50+ class methods. Two near-identical loops (runBackgroundTask: 1,750 lines, runAgentLoop: 1,250 lines) share ~70% logic but can't be merged because they diverge at every intervention point:

- **Background**: loop recovery gates, epoch cycling, progress emission, worker collection, finish() return
- **Interactive**: streaming, goal decomposition, direct user delivery, void return

Every new feature must be implemented in both loops. The REFLECTING handler alone is ~1,000 lines across both. Stage 4+5 extracted 13 shared functions but hit diminishing returns at -535 lines due to deep `this.` coupling.

## Target Architecture

```
Orchestrator (thin coordinator, ~500 lines)
│
├── PAORStateMachine
│   - Phase transitions (PLANNING → EXECUTING → REFLECTING → REPLANNING)
│   - Agent state management (immutable updates)
│   - Reflection decision routing (DONE/REPLAN/CONTINUE)
│   - ~200 lines
│
├── InterventionPipeline
│   - Clarification intervention
│   - Verifier intervention
│   - Visibility boundary / draft decision
│   - Loop recovery (bg-specific, injected via strategy)
│   - ~400 lines
│
├── SessionManager
│   - Session creation, message assembly
│   - Visible transcript management
│   - Memory persistence (persistSessionToMemory)
│   - Plan review / write rejection checks
│   - ~300 lines
│
├── AutonomyTracker
│   - TaskPlanner, SelfVerification, StradaConformance, ErrorRecovery
│   - ExecutionJournal, ControlLoopTracker
│   - Tool tracking + consensus verification (already extracted)
│   - ~200 lines
│
└── LoopRunner (abstract base + 2 implementations)
    │
    ├── BackgroundLoopRunner
    │   - Epoch cycling (while + for)
    │   - Progress emission (emitProgress)
    │   - Worker collector instrumentation
    │   - finish() + bgFinishBlocked() return semantics
    │   - ~300 lines
    │
    └── InteractiveLoopRunner
        - Single for loop with iteration limit
        - Silent streaming support
        - Goal decomposition (proactive + reactive)
        - sendVisibleAssistantMarkdown delivery
        - ~250 lines
```

**Total: ~2,150 lines** across 6 modules vs current 7,315 in one file.

## Migration Strategy: Staged Extraction

Each phase extracts one module, replaces inline code with module calls, verifies all 4,162 tests pass.

### Phase 1: SessionManager (~2 days)
**Why first:** Most method calls, least complex logic. 20+ `this.appendVisibleAssistantMessage`, `this.persistSessionToMemory`, `this.getVisibleTranscript`, `this.sendVisibleAssistantMarkdown` calls.

Extract: session creation, message assembly, visible transcript, memory persistence, plan review checks, write rejection checks.

### Phase 2: AutonomyTracker (~1 day)
**Why second:** Already partially extracted (trackAndRecordToolResults, runConsensusVerification). Consolidate remaining setup code and tracking patterns.

Extract: ErrorRecoveryEngine/TaskPlanner/SelfVerification/ExecutionJournal/StradaConformance instantiation, step recording (already done), tool tracking (already done), consensus (already done).

### Phase 3: InterventionPipeline (~3 days)
**Why third:** Highest complexity, but SessionManager must exist first. The intervention chain (clarification → verifier → visibility) is the core of the REFLECTING handler duplication.

Extract: `resolveDraftClarificationIntervention`, `resolveVerifierIntervention`, `resolveVisibleDraftDecision`, `decideUserVisibleBoundary`, `handleBackgroundLoopRecovery` — unified behind a pipeline interface with bg/interactive strategy.

### Phase 4: PAORStateMachine (~1 day)
**Why fourth:** Small, well-defined. Already partially extracted in loop-utils (handlePlanPhaseTransition, processReflectionPreamble, applyReflectionContinuation, handleReplanDecision).

Extract: remaining phase transition logic, reflection decision routing, PAOR prompt building (already done).

### Phase 5: LoopRunner split (~2 days)
**Why last:** Depends on all other modules. Once SessionManager, InterventionPipeline, AutonomyTracker, and PAORStateMachine are extracted, the loops become thin wrappers that can be split into separate classes.

Extract: BackgroundLoopRunner, InteractiveLoopRunner. Orchestrator becomes a coordinator that instantiates the right runner.

## Constraints

- **Pure restructuring**: behavior MUST NOT change
- **Test-driven**: 4,162 tests must pass after each phase
- **TypeScript strict**: 0 TS errors maintained throughout
- **No new dependencies**: restructuring only, no new npm packages
- **Incremental commits**: each phase is a separate commit/PR, independently reviewable

## Risk Mitigation

- Each phase starts with a snapshot of passing tests
- If a phase breaks tests, revert and try a smaller extraction
- The intervention pipeline (Phase 3) is highest risk — may need sub-phases
- Keep orchestrator.ts as the "source of truth" until each module is fully verified

## Success Criteria

- orchestrator.ts < 1,000 lines
- No feature requires editing more than 2 files
- New loop feature can be added by implementing one interface method
- All 4,162+ tests passing
- 0 TypeScript errors
