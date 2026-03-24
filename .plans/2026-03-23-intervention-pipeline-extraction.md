# InterventionPipeline Extraction — Phase 3 of Orchestrator Restructuring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract ~700 lines of intervention methods from `orchestrator.ts` into a standalone `orchestrator-intervention-pipeline.ts` module, consolidating the clarification → visibility → verifier → loop recovery intervention chain behind a shared dependency interface.

**Architecture:** Create standalone functions (not a class) following the existing pattern of `orchestrator-consensus.ts` and `orchestrator-tool-execution.ts`. Each function takes its own params plus a shared `InterventionDeps` context object that carries orchestrator capabilities (telemetry, provider routing, execution) as callbacks. The deps object is created once per loop invocation in the orchestrator and passed to all intervention functions. Loop recovery methods are background-only — they exist in the same module but are only called from the background loop.

**Tech Stack:** TypeScript (strict mode), Vitest, ESM modules

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| **Create** | `src/agents/orchestrator-intervention-pipeline.ts` | All intervention functions + types + deps interface |
| **Create** | `src/agents/orchestrator-intervention-pipeline.test.ts` | Unit tests for pure helper functions |
| **Modify** | `src/agents/orchestrator.ts` | Remove methods, wire to new functions |

### Key design decisions

1. **Standalone functions, not a class** — matches existing helper module pattern
2. **Shared `InterventionDeps` interface** — carries orchestrator capabilities as callbacks, created once per loop invocation
3. **Pure helpers extracted first** — `selectLoopRecoveryDelegationTool`, `isNovelLoopRecoveryAction`, `buildLoopRecoveryGate`, `buildLoopRecoveryCheckpointMessage` have zero `this` dependencies
4. **`runCompletionReviewStages` stays in orchestrator** — it's a complex method with deep provider coupling, passed to the pipeline as a callback in deps. Extracting it is Phase 4+ scope
5. **Type exports** — `VerifierIntervention` and `LoopRecoveryIntervention` interfaces move to the new module

---

## Methods to extract (10 methods, ~700 lines total)

### Pure helpers (no `this` dependencies):
1. `selectLoopRecoveryDelegationTool` (lines 5742-5759, 17 lines)
2. `isNovelLoopRecoveryAction` (lines 5794-5809, 15 lines)
3. `buildLoopRecoveryGate` (lines 5811-5836, 25 lines)
4. `buildLoopRecoveryCheckpointMessage` (lines 5838-5856, 18 lines)

### With orchestrator coupling (need deps callbacks):
5. `reviewClarification` (lines 1462-1575, 114 lines)
6. `resolveDraftClarificationIntervention` (lines 1577-1605, 28 lines)
7. `resolveVisibleDraftDecision` (lines 1351-1425, 74 lines)
8. `resolveVerifierIntervention` (lines 5481-5660, 180 lines)
9. `resolveLoopRecoveryReview` (lines 5761-5792, 31 lines)
10. `handleBackgroundLoopRecovery` (lines 5858-6058, 200 lines)

### Also remove thin wrappers (replaced by direct imports):
11. `canInspectLocally` (lines 1319-1325, 6 lines) — call helper directly
12. `decideUserVisibleBoundary` (lines 1327-1340, 13 lines) — call helper directly
13. `buildSafeVisibleFallbackFromDraft` (lines 1342-1349, 7 lines) — call helper directly
14. `getClarificationContext` (lines 1312-1317, 5 lines) — **KEEP** on Orchestrator (used by 4 non-extracted `decideUserVisibleBoundary` call sites at lines 2317, 2608, 2945, 3229)
15. `getClarificationReviewAssignment` (lines 1427-1460, 33 lines) — pass as callback in deps

---

## InterventionDeps Interface Design

```typescript
export interface InterventionDeps {
  // Provider routing
  readonly getReviewerAssignment: (
    identityKey: string,
    strategy?: SupervisorExecutionStrategy,
  ) => SupervisorAssignment;
  readonly classifyTask: (prompt: string) => TaskClassification;
  readonly buildSupervisorRolePrompt: (
    strategy: SupervisorExecutionStrategy,
    assignment: SupervisorAssignment,
  ) => string;
  readonly systemPrompt: string;
  readonly projectPath?: string;

  // Clarification context
  readonly clarificationContext: ClarificationContext;
  readonly stripInternalDecisionMarkers: (text: string | null | undefined) => string;
  readonly interactionPolicy: {
    requirePlanReview(chatId: string, reason: string, planText: string): void;
  };
  readonly formatPlanReviewMessage: (draft: string) => string;

  // Telemetry
  readonly recordExecutionTrace: (params: {
    chatId: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: string;
    source: string;
    task: TaskClassification;
  }) => void;
  readonly recordAuxiliaryUsage: (
    providerName: string,
    usage: ProviderResponse["usage"],
    handler?: (usage: TaskUsageEvent) => void,
  ) => void;
  readonly recordPhaseOutcome: (params: {
    chatId: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: string;
    source: string;
    status: string;
    task: TaskClassification;
    reason: string;
    telemetry?: unknown;
  }) => void;
  readonly buildPhaseOutcomeTelemetry: (params: {
    state?: AgentState;
    usage?: ProviderResponse["usage"];
    verifierDecision?: VerifierDecision;
    failureReason?: string | null;
    projectWorldFingerprint?: string;
  }) => unknown;
  readonly recordRuntimeArtifactEvaluation: (params: {
    chatId: string;
    taskRunId?: string;
    decision: string;
    summary: string;
    failureReason?: string | null;
  }) => void;
  readonly getTaskRunId: () => string | undefined;

  // Execution capabilities (callbacks to orchestrator)
  readonly synthesizeUserFacingResponse: (params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    agentState: AgentState;
    strategy: SupervisorExecutionStrategy;
    systemPrompt: string;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }) => Promise<string>;
  readonly runCompletionReviewStages: (params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    state: AgentState;
    draft: string;
    plan: ReturnType<typeof planVerifierPipeline>;
    strategy: SupervisorExecutionStrategy;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }) => Promise<{
    decision: ReturnType<typeof parseCompletionReviewDecision>;
    stageResults: CompletionReviewStageResult[];
    usage?: ProviderResponse["usage"];
  }>;
  // Matches actual signature: (chatId, toolCalls, options?) — NOT object params
  readonly executeToolCalls: (
    chatId: string,
    toolCalls: ToolCall[],
    options?: ToolExecutionOptions,
  ) => Promise<ToolResult[]>;
  readonly getLogRingBuffer: () => string[];

  // Progress signaling (used by handleBackgroundLoopRecovery)
  readonly buildStructuredProgressSignal: (
    prompt: string,
    title: string,
    signal: Omit<TaskProgressSignal, "userSummary"> & { userSummary?: string },
    language?: ProgressLanguage,
  ) => TaskProgressSignal;
}
```

---

### Task 1: Create module with types, pure helpers, and deps interface

**Files:**
- Create: `src/agents/orchestrator-intervention-pipeline.ts`

- [ ] **Step 1: Read source methods**

Read `src/agents/orchestrator.ts` at these line ranges to copy method bodies:
- Lines 288-299 (VerifierIntervention + LoopRecoveryIntervention types)
- Lines 5742-5856 (4 pure loop recovery helpers)

- [ ] **Step 2: Create file with imports, types, deps interface, and pure helpers**

The file should contain:
1. All necessary imports (autonomy types, clarification types, provider types)
2. `VerifierIntervention` interface (from orchestrator.ts:288-292)
3. `LoopRecoveryIntervention` interface (from orchestrator.ts:294-299)
4. `InterventionDeps` interface (see design above — read source methods to determine exact callback signatures)
5. `selectLoopRecoveryDelegationTool()` — copy from orchestrator.ts:5742-5759, make `export function`
6. `isNovelLoopRecoveryAction()` — copy from orchestrator.ts:5794-5809, make `export function`
7. `buildLoopRecoveryGate()` — copy from orchestrator.ts:5811-5836, make `export function`
8. `buildLoopRecoveryCheckpointMessage()` — copy from orchestrator.ts:5838-5856, make `export function`

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit src/agents/orchestrator-intervention-pipeline.ts`

---

### Task 2: Extract loop recovery functions

**Files:**
- Modify: `src/agents/orchestrator-intervention-pipeline.ts`

- [ ] **Step 1: Read source methods**

Read `src/agents/orchestrator.ts`:
- Lines 5761-5792 (`resolveLoopRecoveryReview`)
- Lines 5858-6058 (`handleBackgroundLoopRecovery`)

- [ ] **Step 2: Extract resolveLoopRecoveryReview**

Copy from orchestrator.ts:5761-5792. Convert to standalone function:
```typescript
export async function resolveLoopRecoveryReview(
  params: { ... },  // keep existing params
  deps: InterventionDeps,
): Promise<LoopRecoveryReviewDecision> { ... }
```

Replace `this.X` references:
- `params.strategy.reviewer` stays (already in params)
- Provider call stays (uses reviewer.provider.chat)
- `this.recordExecutionTrace(...)` → `deps.recordExecutionTrace(...)`
- `this.recordAuxiliaryUsage(...)` → `deps.recordAuxiliaryUsage(...)`
- `this.buildSupervisorRolePrompt(...)` → `deps.buildSupervisorRolePrompt(...)`

- [ ] **Step 3: Extract handleBackgroundLoopRecovery**

Copy from orchestrator.ts:5858-6058. Convert to standalone function:
```typescript
export async function handleBackgroundLoopRecovery(
  params: { ... },  // keep existing params
  deps: InterventionDeps,
): Promise<LoopRecoveryIntervention> { ... }
```

Replace `this.X` references:
- `this.selectLoopRecoveryDelegationTool(...)` → `selectLoopRecoveryDelegationTool(...)` (local call)
- `this.resolveLoopRecoveryReview(...)` → `resolveLoopRecoveryReview(..., deps)` (local call)
- `this.isNovelLoopRecoveryAction(...)` → `isNovelLoopRecoveryAction(...)` (local call)
- `this.buildLoopRecoveryGate(...)` → `buildLoopRecoveryGate(...)` (local call)
- `this.buildLoopRecoveryCheckpointMessage(...)` → `buildLoopRecoveryCheckpointMessage(...)` (local call)
- `this.executeToolCalls(chatId, [toolCall], opts)` → `deps.executeToolCalls(chatId, [toolCall], opts)` (callback — uses positional args, not object params)
- `this.buildStructuredProgressSignal(...)` → `deps.buildStructuredProgressSignal(...)` (callback)
- `this.recordExecutionTrace(...)` → `deps.recordExecutionTrace(...)` (callback)
- `this.recordAuxiliaryUsage(...)` → `deps.recordAuxiliaryUsage(...)`
- `this.recordPhaseOutcome(...)` → `deps.recordPhaseOutcome(...)`
- `this.buildPhaseOutcomeTelemetry(...)` → `deps.buildPhaseOutcomeTelemetry(...)`
- `this.systemPrompt` → `deps.systemPrompt`
- `this.buildSupervisorRolePrompt(...)` → `deps.buildSupervisorRolePrompt(...)`

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`

---

### Task 3: Extract verifier intervention

**Files:**
- Modify: `src/agents/orchestrator-intervention-pipeline.ts`

- [ ] **Step 1: Read source method**

Read `src/agents/orchestrator.ts` lines 5481-5660 (`resolveVerifierIntervention`)

- [ ] **Step 2: Extract resolveVerifierIntervention**

Convert to standalone function:
```typescript
export async function resolveVerifierIntervention(
  params: { ... },  // keep existing params
  deps: InterventionDeps,
): Promise<VerifierIntervention> { ... }
```

Replace `this.X` references:
- `this.canInspectLocally(...)` → `canInspectLocallyHelper(deps.clarificationContext, ...)` (direct import from orchestrator-clarification)
- `this.runCompletionReviewStages(...)` → `deps.runCompletionReviewStages(...)` (callback)
- `this.recordPhaseOutcome(...)` → `deps.recordPhaseOutcome(...)`
- `this.recordRuntimeArtifactEvaluation(...)` → `deps.recordRuntimeArtifactEvaluation(...)`
- `this.buildPhaseOutcomeTelemetry(...)` → `deps.buildPhaseOutcomeTelemetry(...)`
- `this.getTaskExecutionContext()?.taskRunId` → `deps.getTaskRunId()`
- `this.toPhaseOutcomeStatus(...)` → `toPhaseOutcomeStatusModel(...)` (import directly from `orchestrator-phase-telemetry.ts` — the wrapper is trivial: `return toPhaseOutcomeStatusModel(decision)`)
- `typeof getLogRingBuffer === "function" ? getLogRingBuffer() : []` → `deps.getLogRingBuffer()`
- `this.recordExecutionTrace(...)` → `deps.recordExecutionTrace(...)`
- `this.recordAuxiliaryUsage(...)` → `deps.recordAuxiliaryUsage(...)`

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

---

### Task 4: Extract clarification + visibility chain

**Files:**
- Modify: `src/agents/orchestrator-intervention-pipeline.ts`

- [ ] **Step 1: Read source methods**

Read `src/agents/orchestrator.ts`:
- Lines 1462-1575 (`reviewClarification`)
- Lines 1577-1605 (`resolveDraftClarificationIntervention`)
- Lines 1351-1425 (`resolveVisibleDraftDecision`)

- [ ] **Step 2: Extract reviewClarification**

Convert to standalone function:
```typescript
export async function reviewClarification(
  params: { ... },
  deps: InterventionDeps,
): Promise<{ decision: ...; evidence: ... }> { ... }
```

Replace `this.X` references:
- `this.projectPath` → `deps.projectPath`
- `this.getClarificationReviewAssignment(...)` → `deps.getReviewerAssignment(...)`
- `this.taskClassifier.classify(...)` → `deps.classifyTask(...)`
- `this.systemPrompt` → `deps.systemPrompt`
- `this.buildSupervisorRolePrompt(...)` → `deps.buildSupervisorRolePrompt(...)`
- `this.recordExecutionTrace(...)` → `deps.recordExecutionTrace(...)`
- `this.recordAuxiliaryUsage(...)` → `deps.recordAuxiliaryUsage(...)`
- `this.recordPhaseOutcome(...)` → `deps.recordPhaseOutcome(...)`
- `this.buildPhaseOutcomeTelemetry(...)` → `deps.buildPhaseOutcomeTelemetry(...)`

- [ ] **Step 3: Extract resolveDraftClarificationIntervention**

Convert to standalone function. Replace:
- `this.stripInternalDecisionMarkers(...)` → `deps.stripInternalDecisionMarkers(...)`
- `this.reviewClarification(...)` → `reviewClarification(..., deps)` (local call)

- [ ] **Step 4: Extract resolveVisibleDraftDecision**

Convert to standalone function. Replace:
- `this.stripInternalDecisionMarkers(...)` → `deps.stripInternalDecisionMarkers(...)`
- `this.interactionPolicy.requirePlanReview(...)` → `deps.interactionPolicy.requirePlanReview(...)`
- `this.sessionManager.formatPlanReviewMessage(...)` → `deps.formatPlanReviewMessage(...)`
- `this.decideUserVisibleBoundary(...)` → `decideUserVisibleBoundaryHelper(deps.clarificationContext, ...)` (direct import)
- `this.synthesizeUserFacingResponse(...)` → `deps.synthesizeUserFacingResponse(...)` (callback)

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`

---

### Task 5: Wire into Orchestrator + remove old methods

**Files:**
- Modify: `src/agents/orchestrator.ts`

- [ ] **Step 1: Add import**

```typescript
import {
  resolveVerifierIntervention,
  handleBackgroundLoopRecovery,
  reviewClarification as reviewClarificationHelper,
  resolveDraftClarificationIntervention as resolveDraftClarificationInterventionHelper,
  resolveVisibleDraftDecision as resolveVisibleDraftDecisionHelper,
  type VerifierIntervention,
  type LoopRecoveryIntervention,
  type InterventionDeps,
} from "./orchestrator-intervention-pipeline.js";
```

- [ ] **Step 2: Create deps builder method on Orchestrator**

Add a private method that builds the `InterventionDeps` object:
```typescript
private buildInterventionDeps(): InterventionDeps {
  return {
    getReviewerAssignment: (id, s) => this.getClarificationReviewAssignment(id, s),
    classifyTask: (p) => this.taskClassifier.classify(p),
    buildSupervisorRolePrompt: (s, a) => this.buildSupervisorRolePrompt(s, a),
    systemPrompt: this.systemPrompt,
    projectPath: this.projectPath,
    clarificationContext: this.getClarificationContext(),
    stripInternalDecisionMarkers: (t) => stripInternalDecisionMarkersHelper(t),
    interactionPolicy: this.interactionPolicy,
    formatPlanReviewMessage: (d) => this.sessionManager.formatPlanReviewMessage(d),
    recordExecutionTrace: (p) => this.recordExecutionTrace(p),
    recordAuxiliaryUsage: (n, u, h) => this.recordAuxiliaryUsage(n, u, h),
    recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
    buildPhaseOutcomeTelemetry: (p) => this.buildPhaseOutcomeTelemetry(p),
    recordRuntimeArtifactEvaluation: (p) => this.recordRuntimeArtifactEvaluation(p),
    getTaskRunId: () => this.getTaskExecutionContext()?.taskRunId,
    synthesizeUserFacingResponse: (p) => this.synthesizeUserFacingResponse(p),
    runCompletionReviewStages: (p) => this.runCompletionReviewStages(p),
    executeToolCalls: (p) => this.executeToolCalls(p),
    getLogRingBuffer: () => typeof getLogRingBuffer === "function" ? getLogRingBuffer() : [],
  };
}
```

- [ ] **Step 3: Create interventionDeps in both loops**

In `runBackgroundTask()`, after autonomy bundle creation, add:
```typescript
const interventionDeps = this.buildInterventionDeps();
```

In `runAgentLoop()`, after autonomy bundle creation, add:
```typescript
const interventionDeps = this.buildInterventionDeps();
```

- [ ] **Step 4: Replace all call sites**

Replace each `this.methodName(params)` with `importedFunction(params, interventionDeps)`:

| Find | Replace |
|------|---------|
| `this.resolveDraftClarificationIntervention(` | `resolveDraftClarificationInterventionHelper(` + add `interventionDeps` as 2nd arg |
| `this.resolveVerifierIntervention(` | `resolveVerifierIntervention(` + add `interventionDeps` as 2nd arg |
| `this.resolveVisibleDraftDecision(` | `resolveVisibleDraftDecisionHelper(` + add `interventionDeps` as 2nd arg |
| `this.handleBackgroundLoopRecovery(` | `handleBackgroundLoopRecovery(` + add `interventionDeps` as 2nd arg |

Also replace thin wrapper calls with direct imports (using `this.getClarificationContext()` which is KEPT on Orchestrator):
- `this.decideUserVisibleBoundary(...)` → `decideUserVisibleBoundaryHelper(this.getClarificationContext(), ...)` (4 call sites at lines ~2317, 2608, 2945, 3229)
- `this.buildSafeVisibleFallbackFromDraft(...)` → `buildSafeVisibleFallbackFromDraftHelper(...)` (4 call sites at lines ~965, 1002, 1115, 1134)

Note: `this.canInspectLocally(...)` has only 1 call site inside `resolveVerifierIntervention` which is being extracted — no remaining call sites in orchestrator.

- [ ] **Step 5: Remove all extracted methods from Orchestrator**

Remove these method definitions:
- `canInspectLocally` (lines ~1319-1325)
- `decideUserVisibleBoundary` (lines ~1327-1340)
- `buildSafeVisibleFallbackFromDraft` (lines ~1342-1349)
- `resolveVisibleDraftDecision` (lines ~1351-1425)
- `getClarificationReviewAssignment` (lines ~1427-1460)
- `reviewClarification` (lines ~1462-1575)
- `resolveDraftClarificationIntervention` (lines ~1577-1605)
- `resolveVerifierIntervention` (lines ~5481-5660)
- `selectLoopRecoveryDelegationTool` (lines ~5742-5759)
- `resolveLoopRecoveryReview` (lines ~5761-5792)
- `isNovelLoopRecoveryAction` (lines ~5794-5809)
- `buildLoopRecoveryGate` (lines ~5811-5836)
- `buildLoopRecoveryCheckpointMessage` (lines ~5838-5856)
- `handleBackgroundLoopRecovery` (lines ~5858-6058)

Also remove type definitions:
- `VerifierIntervention` (lines 288-292)
- `LoopRecoveryIntervention` (lines 294-299)

**KEEP** `getClarificationContext` (lines ~1312-1317) — still used by 4 `decideUserVisibleBoundary` call sites in the background loop that are NOT inside extracted methods.

**KEEP** `toPhaseOutcomeStatus` (line ~797) — still used elsewhere; the extracted `resolveVerifierIntervention` will import `toPhaseOutcomeStatusModel` directly.

- [ ] **Step 6: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/agents/orchestrator-intervention-pipeline.ts src/agents/orchestrator.ts
git commit -m "refactor(agents): extract InterventionPipeline from Orchestrator

Phase 3 of orchestrator restructuring milestone.
Extract 14 intervention methods (~700 lines) into standalone functions:
- Clarification chain: reviewClarification, resolveDraftClarificationIntervention
- Visibility: resolveVisibleDraftDecision
- Verification: resolveVerifierIntervention
- Loop recovery: handleBackgroundLoopRecovery + 5 helpers
- Remove 3 thin wrappers (delegate to clarification-ts directly)
InterventionDeps interface carries orchestrator capabilities as callbacks."
```

---

### Task 6: Unit tests for pure helpers

**Files:**
- Create: `src/agents/orchestrator-intervention-pipeline.test.ts`

- [ ] **Step 1: Write tests for selectLoopRecoveryDelegationTool**

```typescript
import { describe, it, expect } from "vitest";
import {
  selectLoopRecoveryDelegationTool,
  isNovelLoopRecoveryAction,
  buildLoopRecoveryGate,
  buildLoopRecoveryCheckpointMessage,
} from "./orchestrator-intervention-pipeline.js";

describe("selectLoopRecoveryDelegationTool", () => {
  it("returns null when no tools available", () => {
    expect(selectLoopRecoveryDelegationTool(undefined, [])).toBeNull();
    expect(selectLoopRecoveryDelegationTool([], [])).toBeNull();
  });

  it("prefers delegate_code_review when files touched", () => {
    const result = selectLoopRecoveryDelegationTool(
      ["delegate_analysis", "delegate_code_review"],
      ["src/foo.ts"],
    );
    expect(result).toBe("delegate_code_review");
  });

  it("falls back to delegate_analysis when no files touched", () => {
    const result = selectLoopRecoveryDelegationTool(
      ["delegate_analysis", "delegate_code_review"],
      [],
    );
    expect(result).toBe("delegate_analysis");
  });
});
```

- [ ] **Step 2: Write tests for isNovelLoopRecoveryAction and buildLoopRecoveryGate**

Test that `isNovelLoopRecoveryAction` returns true for novel actions and false for repeated ones. Test that `buildLoopRecoveryGate` produces a string containing the fingerprint, reason, and required actions from the brief.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/agents/orchestrator-intervention-pipeline.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/agents/orchestrator-intervention-pipeline.test.ts
git commit -m "test(agents): add InterventionPipeline unit tests"
```

---

### Task 7: Final verification + line count audit

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Count lines**

Run: `wc -l src/agents/orchestrator.ts src/agents/orchestrator-intervention-pipeline.ts`

Expected:
- `orchestrator.ts`: ~6,400 lines (down from 7,159 — ~750 lines removed)
- `orchestrator-intervention-pipeline.ts`: ~750 lines

- [ ] **Step 4: Verify no remaining intervention methods**

Run: `grep -n "private.*resolveVerifierIntervention\|private.*handleBackgroundLoopRecovery\|private.*resolveDraftClarificationIntervention\|private.*resolveVisibleDraftDecision\|private.*reviewClarification\|private.*selectLoopRecoveryDelegation\|private.*resolveLoopRecoveryReview\|private.*isNovelLoopRecoveryAction\|private.*buildLoopRecoveryGate\|private.*buildLoopRecoveryCheckpointMessage\|private.*canInspectLocally\|private.*decideUserVisibleBoundary\|private.*buildSafeVisibleFallbackFromDraft" src/agents/orchestrator.ts`

Expected: 0 matches
