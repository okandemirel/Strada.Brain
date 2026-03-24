# AutonomyTracker Extraction — Phase 2 of Orchestrator Restructuring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the duplicated autonomy object instantiation pattern (ErrorRecoveryEngine, TaskPlanner, SelfVerification, ExecutionJournal, ControlLoopTracker, StradaConformanceGuard) from both loops into a single factory function, eliminating code duplication and establishing a typed `AutonomyBundle` interface.

**Architecture:** Create a factory function `createAutonomyBundle()` that encapsulates the 6-object creation + initialization pattern currently duplicated in `runBackgroundTask()` (lines 2054-2081) and `runAgentLoop()` (lines 3898-3925). The bundle is a plain object, not a class — the autonomy objects are loop-scoped locals, not Orchestrator state. The existing `trackAndRecordToolResults` and `runConsensusVerification` helper modules remain unchanged (already clean).

**Tech Stack:** TypeScript (strict mode), Vitest, ESM modules

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| **Create** | `src/agents/orchestrator-autonomy-tracker.ts` | `AutonomyBundle` interface + `createAutonomyBundle()` factory |
| **Create** | `src/agents/orchestrator-autonomy-tracker.test.ts` | Unit tests for factory function |
| **Modify** | `src/agents/orchestrator.ts` | Replace instantiation blocks with factory calls |

### Key design decisions

1. **Factory function, not a class** — autonomy objects are loop-scoped locals (created per-execution, not per-Orchestrator). A class would add unnecessary state management.
2. **`AutonomyBundle` is a plain interface** — destructured at call sites, no wrapper methods. The autonomy objects' own APIs are already clean.
3. **`controlLoopTracker` is optional** — only used in background loops, `null` for interactive.
4. **Existing helpers untouched** — `orchestrator-tool-execution.ts` and `orchestrator-consensus.ts` remain separate (already well-extracted, different concerns).
5. **Re-export convenience** — `AutonomyBundle` re-exports from the new module so orchestrator doesn't need to import individual classes for type annotations.

---

### Task 1: Create AutonomyBundle interface and factory function

**Files:**
- Create: `src/agents/orchestrator-autonomy-tracker.ts`

- [ ] **Step 1: Create the file with imports and interface**

```typescript
// src/agents/orchestrator-autonomy-tracker.ts
import {
  ErrorRecoveryEngine,
  ExecutionJournal,
  TaskPlanner,
  SelfVerification,
  ControlLoopTracker,
} from "./autonomy/index.js";
import { StradaConformanceGuard } from "./autonomy/strada-conformance.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";

export interface AutonomyBundle {
  readonly errorRecovery: ErrorRecoveryEngine;
  readonly taskPlanner: TaskPlanner;
  readonly selfVerification: SelfVerification;
  readonly executionJournal: ExecutionJournal;
  readonly controlLoopTracker: ControlLoopTracker | null;
  readonly stradaConformance: StradaConformanceGuard;
}

export interface CreateAutonomyBundleParams {
  readonly prompt: string;
  readonly iterationBudget: number;
  readonly stradaDeps?: StradaDepsStatus;
  readonly projectWorldSummary?: string;
  readonly projectWorldFingerprint?: string;
  /** Set true for background loops — creates ControlLoopTracker. Omit/false for interactive. */
  readonly includeControlLoopTracker?: boolean;
}
```

- [ ] **Step 2: Implement the factory function**

```typescript
export function createAutonomyBundle(params: CreateAutonomyBundleParams): AutonomyBundle {
  const errorRecovery = new ErrorRecoveryEngine();
  const taskPlanner = new TaskPlanner({
    iterationBudget: params.iterationBudget,
  });
  const selfVerification = new SelfVerification();
  const executionJournal = new ExecutionJournal(params.prompt);
  const controlLoopTracker = params.includeControlLoopTracker
    ? new ControlLoopTracker()
    : null;

  if (params.projectWorldSummary && params.projectWorldFingerprint) {
    executionJournal.attachProjectWorldContext({
      summary: params.projectWorldSummary,
      fingerprint: params.projectWorldFingerprint,
    });
  }

  const stradaConformance = new StradaConformanceGuard(params.stradaDeps);
  stradaConformance.trackPrompt(params.prompt);

  return {
    errorRecovery,
    taskPlanner,
    selfVerification,
    executionJournal,
    controlLoopTracker,
    stradaConformance,
  };
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit src/agents/orchestrator-autonomy-tracker.ts`
Expected: 0 errors

---

### Task 2: Write unit tests for factory function

**Files:**
- Create: `src/agents/orchestrator-autonomy-tracker.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from "vitest";
import { createAutonomyBundle } from "./orchestrator-autonomy-tracker.js";

describe("createAutonomyBundle", () => {
  it("creates all 6 autonomy objects for background loop", () => {
    const bundle = createAutonomyBundle({
      prompt: "Build the feature",
      iterationBudget: 15,
      includeControlLoopTracker: true,
    });
    expect(bundle.errorRecovery).toBeDefined();
    expect(bundle.taskPlanner).toBeDefined();
    expect(bundle.selfVerification).toBeDefined();
    expect(bundle.executionJournal).toBeDefined();
    expect(bundle.controlLoopTracker).not.toBeNull();
    expect(bundle.stradaConformance).toBeDefined();
  });

  it("creates bundle without ControlLoopTracker for interactive loop", () => {
    const bundle = createAutonomyBundle({
      prompt: "Hello",
      iterationBudget: 10,
    });
    expect(bundle.controlLoopTracker).toBeNull();
    expect(bundle.errorRecovery).toBeDefined();
    expect(bundle.taskPlanner).toBeDefined();
  });

  it("attaches project world context when provided", () => {
    const bundle = createAutonomyBundle({
      prompt: "Task",
      iterationBudget: 10,
      projectWorldSummary: "Unity project",
      projectWorldFingerprint: "abc123",
    });
    const snapshot = bundle.executionJournal.snapshot();
    expect(snapshot).toBeDefined();
  });

  it("tracks prompt in stradaConformance", () => {
    const bundle = createAutonomyBundle({
      prompt: "Create a component",
      iterationBudget: 10,
    });
    // stradaConformance.trackPrompt was called during creation
    // Verify by checking the guard exists and is initialized
    expect(bundle.stradaConformance).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/agents/orchestrator-autonomy-tracker.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/agents/orchestrator-autonomy-tracker.ts src/agents/orchestrator-autonomy-tracker.test.ts
git commit -m "feat(agents): create AutonomyBundle factory function

Phase 2 of orchestrator restructuring milestone.
createAutonomyBundle() consolidates the 6-object autonomy
instantiation pattern used by both bg and interactive loops."
```

---

### Task 3: Wire factory into Orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts`

- [ ] **Step 1: Add import**

Add to imports section (after the existing autonomy imports at line ~68):
```typescript
import { createAutonomyBundle } from "./orchestrator-autonomy-tracker.js";
```

The existing imports of `ErrorRecoveryEngine`, `ExecutionJournal`, `TaskPlanner`, `SelfVerification`, `ControlLoopTracker` from `./autonomy/index.js` must STAY — they're used as type annotations in method signatures and helper params throughout the file (e.g., `selfVerification: SelfVerification` at lines 1335, 1360).

The import of `StradaConformanceGuard` from `./autonomy/strada-conformance.js` also stays — used in type annotations.

- [ ] **Step 2: Replace background loop instantiation (lines ~2054-2081)**

Replace these lines:
```typescript
// Autonomy layer
const errorRecovery = new ErrorRecoveryEngine();
const taskPlanner = new TaskPlanner({
  iterationBudget: this.getBackgroundEpochIterationLimit(),
});
const selfVerification = new SelfVerification();
const executionJournal = new ExecutionJournal(prompt);
const controlLoopTracker = new ControlLoopTracker();
const progressTitle = prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Task";
const progressLanguage = (profile?.language ?? this.defaultLanguage) as ProgressLanguage;
if (bgProjectWorldSummary && bgProjectWorldFingerprint) {
  executionJournal.attachProjectWorldContext({
    summary: bgProjectWorldSummary,
    fingerprint: bgProjectWorldFingerprint,
  });
}
const stradaConformance = new StradaConformanceGuard(this.stradaDeps);
const taskStartedAtMs = Date.now();
// ... (keep buildBgPhaseOutcomeTelemetry closure)
stradaConformance.trackPrompt(prompt);
```

With:
```typescript
// Autonomy layer
const {
  errorRecovery,
  taskPlanner,
  selfVerification,
  executionJournal,
  controlLoopTracker,
  stradaConformance,
} = createAutonomyBundle({
  prompt,
  iterationBudget: this.getBackgroundEpochIterationLimit(),
  stradaDeps: this.stradaDeps,
  projectWorldSummary: bgProjectWorldSummary,
  projectWorldFingerprint: bgProjectWorldFingerprint,
  includeControlLoopTracker: true,
});
const progressTitle = prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Task";
const progressLanguage = (profile?.language ?? this.defaultLanguage) as ProgressLanguage;
const taskStartedAtMs = Date.now();
// ... (keep buildBgPhaseOutcomeTelemetry closure unchanged)
```

**IMPORTANT:** `controlLoopTracker` is used later as a non-null value (e.g., `controlLoopTracker.markVerificationClean()`). Since the factory returns `ControlLoopTracker | null` but we pass `includeControlLoopTracker: true`, TypeScript will infer `ControlLoopTracker | null`. To avoid null checks throughout the bg loop, add a non-null assertion after destructuring:

```typescript
const controlLoopTrackerNonNull = controlLoopTracker!;
```

Or alternatively, keep `controlLoopTracker` as a separate const after the bundle:
```typescript
const bgControlLoopTracker = new ControlLoopTracker();
```

**Simplest approach:** Since background ALWAYS needs it, just create it separately:
```typescript
const {
  errorRecovery, taskPlanner, selfVerification,
  executionJournal, stradaConformance,
} = createAutonomyBundle({
  prompt,
  iterationBudget: this.getBackgroundEpochIterationLimit(),
  stradaDeps: this.stradaDeps,
  projectWorldSummary: bgProjectWorldSummary,
  projectWorldFingerprint: bgProjectWorldFingerprint,
});
const controlLoopTracker = new ControlLoopTracker();
```

This avoids the null-typing issue entirely. Use whichever approach produces cleaner code.

- [ ] **Step 3: Replace interactive loop instantiation (lines ~3898-3925)**

Replace:
```typescript
const errorRecovery = new ErrorRecoveryEngine();
const taskPlanner = new TaskPlanner({
  iterationBudget: this.getInteractiveIterationLimit(),
});
const selfVerification = new SelfVerification();
const executionJournal = new ExecutionJournal(lastUserMessage);
if (projectWorldSummary && projectWorldFingerprint) {
  executionJournal.attachProjectWorldContext({
    summary: projectWorldSummary,
    fingerprint: projectWorldFingerprint,
  });
}
const stradaConformance = new StradaConformanceGuard(this.stradaDeps);
const taskStartedAtMs = Date.now();
// ... (keep buildInteractivePhaseOutcomeTelemetry closure)
stradaConformance.trackPrompt(lastUserMessage);
```

With:
```typescript
const {
  errorRecovery, taskPlanner, selfVerification,
  executionJournal, stradaConformance,
} = createAutonomyBundle({
  prompt: lastUserMessage,
  iterationBudget: this.getInteractiveIterationLimit(),
  stradaDeps: this.stradaDeps,
  projectWorldSummary,
  projectWorldFingerprint,
});
const taskStartedAtMs = Date.now();
// ... (keep buildInteractivePhaseOutcomeTelemetry closure unchanged)
```

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (694+)

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "refactor(agents): use createAutonomyBundle in both loops

Replace duplicated 6-object autonomy instantiation with factory call.
~25 lines removed from orchestrator.ts per loop."
```

---

### Task 4: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Count lines**

Run: `wc -l src/agents/orchestrator.ts src/agents/orchestrator-autonomy-tracker.ts`

Expected:
- `orchestrator.ts`: ~7,120 lines (down from 7,160 — ~40 lines saved)
- `orchestrator-autonomy-tracker.ts`: ~70 lines

- [ ] **Step 4: Verify no remaining inline instantiation**

Run: `grep -n "new ErrorRecoveryEngine\|new TaskPlanner\|new SelfVerification\|new ExecutionJournal\|new StradaConformanceGuard" src/agents/orchestrator.ts`

Expected: 0 matches (all moved to factory). `new ControlLoopTracker()` may remain once if kept separate for background.
