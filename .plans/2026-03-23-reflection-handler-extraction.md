# Reflection Handler Extraction — Phase 4+5 of Orchestrator Restructuring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract ~800 lines of inline REFLECTING handler code from both loops in `orchestrator.ts` into a standalone `orchestrator-reflection-handler.ts` module, using Strategy A (return action enum, each loop handles its own control flow).

**Architecture:** Create two exported async functions — `handleBgReflectionDone()` and `handleInteractiveReflectionDone()` — that encapsulate the DONE/REPLAN/CONTINUE decision routing for each loop. Each function takes a context object carrying loop-scoped state and dependencies, and returns a `ReflectionLoopAction` discriminated union. The calling loop inspects the action and handles flow control (`continue`/`return`/`finish`). Session message mutation happens inside the functions (matching current behavior). Also remove 2 remaining thin PAOR wrappers from the Orchestrator class.

**Tech Stack:** TypeScript (strict mode), Vitest, ESM modules

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| **Create** | `src/agents/orchestrator-reflection-handler.ts` | `ReflectionLoopAction` type, context interfaces, `handleBgReflectionDone()`, `handleInteractiveReflectionDone()` |
| **Create** | `src/agents/orchestrator-reflection-handler.test.ts` | Unit tests for the outcome type contract and edge cases |
| **Modify** | `src/agents/orchestrator.ts` | Remove inline REFLECTING handlers, wire to new functions, remove thin wrappers |

### Key design decisions

1. **Two separate functions, not one shared** — BG has loop recovery interleaving + raw boundary + synthesize; interactive has goal decomposition + resolveVisibleDraftDecision. The control flows diverge too much to unify.
2. **Functions mutate `session.messages` directly** — matches existing code pattern, avoids complex message-return plumbing.
3. **Return `ReflectionLoopAction` for flow control only** — the function handles telemetry, verifier recording, worker collector updates internally. The caller only needs to know: continue, finish, or blocked.
4. **Preamble + pending checks stay inline** — `processReflectionPreamble()` and pending plan review/write rejection checks are 12-40 lines and tightly coupled to loop early-returns. Not worth extracting.
5. **Thin wrappers removed first** — `toExecutionPhase` and `transitionToVerifierReplan` become direct imports at call sites.
6. **Context objects, not flat params** — each function takes a typed context object grouping the 15+ parameters into logical clusters.

---

### Task 1: Remove thin PAOR wrappers from Orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts`

- [ ] **Step 1: Identify all call sites of thin wrappers**

Run:
```bash
grep -n "this\.toExecutionPhase\|this\.transitionToVerifierReplan" src/agents/orchestrator.ts
```

Expected: ~10 call sites for `toExecutionPhase`, ~2 for `transitionToVerifierReplan`.

- [ ] **Step 2: Replace `this.toExecutionPhase` with direct import**

At each call site, replace `this.toExecutionPhase(phase)` with `toExecutionPhaseModel(phase)`.

The import `toExecutionPhaseModel` from `./orchestrator-phase-telemetry.js` should already exist (it's used by the method body). Verify:
```bash
grep -n "toExecutionPhaseModel" src/agents/orchestrator.ts | head -5
```

- [ ] **Step 3: Replace `this.transitionToVerifierReplan` with direct import**

At each call site, replace `this.transitionToVerifierReplan(state, text)` with `transitionToVerifierReplanModel(state, text)`.

If no call sites remain (Phase 3 extracted all usages into intervention pipeline), skip this step.

- [ ] **Step 4: Remove the wrapper method definitions**

Remove from the Orchestrator class:
```typescript
// Remove: private toExecutionPhase (line ~753-755)
// Remove: private transitionToVerifierReplan (line ~757-762)
```

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "refactor(agents): remove thin PAOR wrapper methods from Orchestrator

Replace this.toExecutionPhase and this.transitionToVerifierReplan
with direct imports of toExecutionPhaseModel and transitionToVerifierReplanModel."
```

---

### Task 2: Create reflection handler module with types and context interfaces

**Files:**
- Create: `src/agents/orchestrator-reflection-handler.ts`

- [ ] **Step 1: Read source types and imports needed**

Read these sections of orchestrator.ts to understand the exact types used in the REFLECTING handlers:
- Lines 1930-1965 (BG DONE handler start — to see param types)
- Lines 3833-3845 (Interactive DONE handler start)
- Lines 2148-2165 (Verifier intervention call in BG)
- Lines 2324-2340 (Synthesize call in BG)

- [ ] **Step 2: Create the file with imports, action type, and context interfaces**

```typescript
// src/agents/orchestrator-reflection-handler.ts
import type { AgentState } from "./agent-state.js";
import { AgentPhase, transitionPhase } from "./agent-state.js";
import {
  applyReflectionContinuation,
  handleReplanDecision,
  handleVerifierReplan,
} from "./orchestrator-loop-utils.js";
import {
  resolveDraftClarificationIntervention as resolveDraftClarificationInterventionPipeline,
  resolveVerifierIntervention as resolveVerifierInterventionPipeline,
  handleBackgroundLoopRecovery as handleBackgroundLoopRecoveryPipeline,
  type InterventionDeps,
} from "./orchestrator-intervention-pipeline.js";
import {
  resolveVisibleDraftDecision as resolveVisibleDraftDecisionPipeline,
} from "./orchestrator-intervention-pipeline.js";
import {
  decideUserVisibleBoundary as decideUserVisibleBoundaryHelper,
  type ClarificationContext,
} from "./orchestrator-clarification.js";
import type { ExecutionJournal } from "./autonomy/execution-journal.js";
import type { SelfVerification } from "./autonomy/self-verification.js";
import type { StradaConformanceGuard } from "./autonomy/strada-conformance.js";
import type { ControlLoopTracker } from "./autonomy/control-loop-tracker.js";
import type {
  SupervisorExecutionStrategy,
  SupervisorAssignment,
} from "./orchestrator-supervisor-routing.js";
import type { ProviderResponse } from "./providers/provider-core.interface.js";
import type { TaskUsageEvent } from "./agent-budget-tracker.js";
import type { TaskProgressSignal, ProgressLanguage } from "../types/index.js";
import type { CompletionReviewResult } from "./orchestrator-intervention-pipeline.js";
import { getLogger } from "../utils/logger.js";

// ─── Action types returned to the calling loop ──────────────────────────────

/** Discriminated union telling the loop what to do after reflection resolves. */
export type ReflectionLoopAction =
  /** Loop should `continue` — state updated, messages pushed to session */
  | { flow: "continue"; newState: AgentState }
  /** Task completed — caller surfaces visibleText, records metric end, returns/finishes */
  | { flow: "done"; visibleText: string; newState: AgentState; status?: "blocked" | "completed" }
  /** Task blocked — caller surfaces visibleText (or uses bgFinishBlocked), records metric end */
  | { flow: "blocked"; visibleText: string; status?: "blocked" | "completed" };

// ─── Shared context carried by both loops ───────────────────────────────────

export interface ReflectionCoreContext {
  readonly chatId: string;
  readonly identityKey: string;
  readonly prompt: string;

  // Current LLM response
  readonly responseText: string | undefined;
  readonly responseUsage: ProviderResponse["usage"] | undefined;
  readonly toolCallCount: number;

  // Strategy & autonomy
  readonly executionStrategy: SupervisorExecutionStrategy;
  readonly executionJournal: ExecutionJournal;
  readonly selfVerification: SelfVerification;
  readonly stradaConformance: StradaConformanceGuard;
  readonly taskStartedAtMs: number;
  readonly currentToolNames: string[];

  // Assignment for telemetry
  readonly currentAssignment: SupervisorAssignment;

  // Dependencies (callbacks to orchestrator)
  readonly interventionDeps: InterventionDeps;

  // Session (mutable — messages pushed inside functions)
  readonly session: { messages: Array<{ role: string; content: string }> };

  // Telemetry callbacks
  readonly recordPhaseOutcome: (params: {
    chatId: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: string;
    source?: string;
    status: string;
    task: import("./task-classifier.js").TaskClassification;
    reason: string;
    telemetry?: unknown;
  }) => void;
  readonly buildPhaseOutcomeTelemetry: (params: {
    state?: AgentState;
    usage?: ProviderResponse["usage"];
    verifierDecision?: string;
    failureReason?: string | null;
    projectWorldFingerprint?: string;
  }) => unknown;

  // Usage handler
  readonly usageHandler?: (usage: TaskUsageEvent) => void;
}

// ─── BG-specific context ────────────────────────────────────────────────────

export interface BgReflectionContext extends ReflectionCoreContext {
  readonly controlLoopTracker: ControlLoopTracker;
  readonly workerCollector: { verifierResult?: CompletionReviewResult; lastAssignment?: SupervisorAssignment } | null;
  readonly progressTitle: string;
  readonly progressLanguage: ProgressLanguage;
  readonly iteration: number;
  readonly workspaceLease?: unknown;
  readonly emitProgress: (signal: TaskProgressSignal) => void;
  readonly buildStructuredProgressSignal: (
    prompt: string,
    title: string,
    signal: { kind: string; message: string },
    language?: ProgressLanguage,
  ) => TaskProgressSignal;

  // Session manager callbacks needed by BG
  readonly getClarificationContext: () => ClarificationContext;
  readonly formatBoundaryVisibleText: (boundary: { kind: string; visibleText?: string }) => string | undefined;
  readonly appendVisibleAssistantMessage: (session: { messages: Array<{ role: string; content: string }> }, text: string) => void;
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
  readonly persistSessionToMemory: (chatId: string, transcript: string, force: boolean) => Promise<void>;
  readonly getVisibleTranscript: (session: { messages: Array<{ role: string; content: string }> }) => string;
  readonly systemPrompt: string;
}

// ─── Interactive-specific context ───────────────────────────────────────────

export interface InteractiveReflectionContext extends ReflectionCoreContext {
  readonly systemPrompt: string;
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit src/agents/orchestrator-reflection-handler.ts`
Expected: 0 errors (or only missing function implementations)

Adjust imports based on actual type locations. The import paths above are best-effort — read the actual import section of orchestrator.ts (lines 1-120) to get exact paths.

---

### Task 3: Extract BG DONE handler

**Files:**
- Modify: `src/agents/orchestrator-reflection-handler.ts`

- [ ] **Step 1: Read the full BG DONE handler**

Read `src/agents/orchestrator.ts` lines 1954-2448 (the `if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS")` block in the background loop).

- [ ] **Step 2: Extract helper `applyBgLoopRecoveryResult`**

The pattern after every `handleBackgroundLoopRecoveryPipeline` call repeats 4 times (~25 lines each). Extract it:

```typescript
/**
 * Applies the result of a background loop recovery call.
 * Returns a ReflectionLoopAction if the loop should break/finish,
 * or null if the caller should continue with its own logic.
 */
function applyBgLoopRecoveryResult(
  loopRecovery: { action: string; message?: string; gate?: string; summary?: string },
  ctx: BgReflectionContext,
  agentState: AgentState,
  fallbackGate: string,
  replanProgressMessage: string,
  defaultProgressKind: string,
  defaultProgressMessage: string,
): ReflectionLoopAction {
  if (loopRecovery.action === "blocked" && loopRecovery.message) {
    return { flow: "blocked", visibleText: loopRecovery.message };
  }
  if (loopRecovery.action === "replan" && loopRecovery.gate) {
    const newState = handleVerifierReplan({
      agentState,
      executionJournal: ctx.executionJournal,
      responseText: ctx.responseText,
      reason: loopRecovery.summary ?? "Loop recovery requested a different approach.",
      providerName: ctx.executionStrategy.reviewer.providerName,
      modelId: ctx.executionStrategy.reviewer.modelId,
    });
    if (ctx.responseText) {
      ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
    }
    ctx.session.messages.push({ role: "user", content: loopRecovery.gate });
    ctx.emitProgress(ctx.buildStructuredProgressSignal(
      ctx.prompt, ctx.progressTitle,
      { kind: "loop_recovery", message: replanProgressMessage },
      ctx.progressLanguage,
    ));
    return { flow: "continue", newState };
  }
  // Default: continue with gate — use fallbackGate when loopRecovery.gate is absent
  const newState = applyReflectionContinuation(agentState, ctx.responseText);
  if (ctx.responseText) {
    ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
  }
  ctx.session.messages.push({
    role: "user",
    content: loopRecovery.gate ?? fallbackGate,
  });
  ctx.emitProgress(ctx.buildStructuredProgressSignal(
    ctx.prompt, ctx.progressTitle,
    { kind: defaultProgressKind, message: defaultProgressMessage },
    ctx.progressLanguage,
  ));
  return { flow: "continue", newState };
}
```

- [ ] **Step 3: Implement `handleBgReflectionDone`**

Create the function that replaces the BG DONE branch (lines 1954-2448). The function:
1. Calls `resolveDraftClarificationInterventionPipeline` → routes result
2. Calls `decideUserVisibleBoundaryHelper` → routes result (with loop recovery)
3. Calls `resolveVerifierInterventionPipeline` → routes result (with loop recovery)
4. Calls `synthesizeUserFacingResponse` → second boundary check → routes result
5. Returns `ReflectionLoopAction`

```typescript
export async function handleBgReflectionDone(
  agentState: AgentState,
  ctx: BgReflectionContext,
): Promise<ReflectionLoopAction> {
  // 1. Clarification intervention
  const clarificationIntervention = await resolveDraftClarificationInterventionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    draft: ctx.responseText ?? "",
    state: agentState,
    strategy: ctx.executionStrategy,
    touchedFiles: [...ctx.selfVerification.getState().touchedFiles],
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  // ... (copy the full logic from orchestrator.ts, replacing this.X with ctx.X)
  // ... (use applyBgLoopRecoveryResult for the 4 loop recovery patterns)
  // ... (return { flow: "done", ... } / { flow: "blocked", ... } / { flow: "continue", ... })
}
```

**Critical:** Copy the logic faithfully from orchestrator.ts lines 1954-2448. Replace:
- `this.X(...)` → `ctx.X(...)`
- `bgAgentState` → `agentState` (local param, returned via action)
- `return bgFinishBlocked(text)` → `return { flow: "blocked", visibleText: text }`
- `return finish(text)` → `return { flow: "done", visibleText: text, newState: agentState }`
- `continue` → `return { flow: "continue", newState: agentState }`
- `emitProgress(...)` → `ctx.emitProgress(...)`
- `workerCollector.X = Y` → `if (ctx.workerCollector) ctx.workerCollector.X = Y`
- Loop recovery patterns → `applyBgLoopRecoveryResult(...)`

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`

---

### Task 4: Extract BG REPLAN and CONTINUE handlers

**Files:**
- Modify: `src/agents/orchestrator-reflection-handler.ts`

- [ ] **Step 1: Read the BG REPLAN and CONTINUE handlers**

Read `src/agents/orchestrator.ts` lines 2451-2499.

- [ ] **Step 2: Implement `handleBgReflectionReplan`**

```typescript
export function handleBgReflectionReplan(
  agentState: AgentState,
  ctx: BgReflectionContext,
): ReflectionLoopAction {
  const newState = handleReplanDecision({
    agentState,
    executionJournal: ctx.executionJournal,
    responseText: ctx.responseText,
    providerName: ctx.currentAssignment.providerName,
    modelId: ctx.currentAssignment.modelId,
  });
  if (ctx.responseText) {
    ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
  }
  ctx.recordPhaseOutcome({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    assignment: ctx.currentAssignment,
    phase: "reflecting",
    status: "replanned",
    task: ctx.executionStrategy.task,
    reason: ctx.responseText ?? "reflection requested a new plan",
    telemetry: ctx.buildPhaseOutcomeTelemetry({
      state: newState,
      usage: ctx.responseUsage,
      failureReason: ctx.responseText,
    }),
  });
  ctx.session.messages.push({ role: "user", content: "Please create a new plan." });
  ctx.emitProgress(ctx.buildStructuredProgressSignal(
    ctx.prompt, ctx.progressTitle,
    { kind: "replanning", message: "Replanning: current approach needs adjustment" },
    ctx.progressLanguage,
  ));
  return { flow: "continue", newState };
}
```

- [ ] **Step 3: Implement `handleBgReflectionContinue`**

```typescript
export function handleBgReflectionContinue(
  agentState: AgentState,
  ctx: BgReflectionContext,
  hasToolCalls: boolean,
): ReflectionLoopAction {
  const newState = applyReflectionContinuation(agentState, ctx.responseText, { skipLastReflection: true });
  if (!hasToolCalls) {
    if (ctx.responseText) {
      ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
    }
    ctx.session.messages.push({ role: "user", content: "Please continue." });
  }
  return { flow: "continue", newState };
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`

---

### Task 5: Extract Interactive DONE handler

**Files:**
- Modify: `src/agents/orchestrator-reflection-handler.ts`

- [ ] **Step 1: Read the full Interactive DONE handler**

Read `src/agents/orchestrator.ts` lines 3833-4021 (the `if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS")` block in the interactive loop).

- [ ] **Step 2: Implement `handleInteractiveReflectionDone`**

```typescript
export async function handleInteractiveReflectionDone(
  agentState: AgentState,
  ctx: InteractiveReflectionContext,
): Promise<ReflectionLoopAction> {
  // 1. Clarification intervention
  const clarificationIntervention = await resolveDraftClarificationInterventionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    draft: ctx.responseText ?? "",
    state: agentState,
    strategy: ctx.executionStrategy,
    touchedFiles: [...ctx.selfVerification.getState().touchedFiles],
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
    const newState = applyReflectionContinuation(agentState, ctx.responseText);
    if (ctx.responseText) {
      ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
    }
    ctx.session.messages.push({ role: "user", content: clarificationIntervention.gate });
    return { flow: "continue", newState };
  }
  if (
    (clarificationIntervention.kind === "ask_user" || clarificationIntervention.kind === "blocked") &&
    clarificationIntervention.message
  ) {
    return { flow: "blocked", visibleText: clarificationIntervention.message };
  }

  // 2. Verifier intervention
  const verifierIntervention = await resolveVerifierInterventionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    state: agentState,
    draft: ctx.responseText,
    selfVerification: ctx.selfVerification,
    stradaConformance: ctx.stradaConformance,
    strategy: ctx.executionStrategy,
    taskStartedAtMs: ctx.taskStartedAtMs,
    availableToolNames: ctx.currentToolNames,
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  ctx.executionJournal.recordVerifierResult(
    verifierIntervention.result,
    ctx.executionStrategy.reviewer.providerName,
    ctx.executionStrategy.reviewer.modelId,
  );

  if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: "reflecting",
      status: "continued",
      task: ctx.executionStrategy.task,
      reason: verifierIntervention.result.summary,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: agentState,
        usage: ctx.responseUsage,
        verifierDecision: "continue",
        failureReason: verifierIntervention.result.summary,
      }),
    });
    const newState = applyReflectionContinuation(agentState, ctx.responseText);
    if (ctx.responseText) {
      ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
    }
    ctx.session.messages.push({ role: "user", content: verifierIntervention.gate });
    return { flow: "continue", newState };
  }

  if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
    const newState = handleVerifierReplan({
      agentState,
      executionJournal: ctx.executionJournal,
      responseText: ctx.responseText,
      reason: verifierIntervention.result.summary,
      providerName: ctx.executionStrategy.reviewer.providerName,
      modelId: ctx.executionStrategy.reviewer.modelId,
      onBeforeTransition: () => ctx.recordPhaseOutcome({
        chatId: ctx.chatId,
        identityKey: ctx.identityKey,
        assignment: ctx.currentAssignment,
        phase: "reflecting",
        status: "replanned",
        task: ctx.executionStrategy.task,
        reason: verifierIntervention.result.summary,
        telemetry: ctx.buildPhaseOutcomeTelemetry({
          state: agentState,
          usage: ctx.responseUsage,
          verifierDecision: "replan",
          failureReason: verifierIntervention.result.summary,
        }),
      }),
    });
    if (ctx.responseText) {
      ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
    }
    ctx.session.messages.push({ role: "user", content: verifierIntervention.gate });
    return { flow: "continue", newState };
  }

  // 3. Visibility decision (interactive uses resolveVisibleDraftDecision)
  const visibilityDecision = await resolveVisibleDraftDecisionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    draft: ctx.responseText ?? "",
    agentState,
    strategy: ctx.executionStrategy,
    systemPrompt: ctx.systemPrompt,
    selfVerification: ctx.selfVerification,
    taskStartedAtMs: ctx.taskStartedAtMs,
    availableToolNames: ctx.currentToolNames,
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  if (visibilityDecision.kind === "internal_continue" && visibilityDecision.gate) {
    if (ctx.responseText) {
      ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
    }
    ctx.session.messages.push({ role: "user", content: visibilityDecision.gate });
    const newState = applyReflectionContinuation(agentState, ctx.responseText);
    return { flow: "continue", newState };
  }

  if (
    (visibilityDecision.kind === "plan_review" ||
      visibilityDecision.kind === "blocked" ||
      visibilityDecision.kind === "ask_user") &&
    visibilityDecision.visibleText
  ) {
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: "reflecting",
      status: "blocked",
      task: ctx.executionStrategy.task,
      reason: visibilityDecision.reason,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: agentState,
        usage: ctx.responseUsage,
        verifierDecision: "approve",
      }),
    });
    return { flow: "blocked", visibleText: visibilityDecision.visibleText };
  }

  // Approved
  const finalText = visibilityDecision.visibleText?.trim() ?? "";
  ctx.recordPhaseOutcome({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    assignment: ctx.currentAssignment,
    phase: "reflecting",
    status: "approved",
    task: ctx.executionStrategy.task,
    reason: visibilityDecision.reason,
    telemetry: ctx.buildPhaseOutcomeTelemetry({
      state: agentState,
      usage: ctx.responseUsage,
      verifierDecision: "approve",
    }),
  });
  return { flow: "done", visibleText: finalText, newState: agentState };
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

---

### Task 6: Extract Interactive REPLAN and CONTINUE handlers

**Files:**
- Modify: `src/agents/orchestrator-reflection-handler.ts`

- [ ] **Step 1: Read the Interactive REPLAN handler**

Read `src/agents/orchestrator.ts` lines 4024-4104.

Note: The interactive REPLAN handler includes goal decomposition logic (lines 4035-4082). This goal decomposition code calls `this.goalDecomposer`, `this.activeGoalTrees`, `this.emitGoalEvent`, and `this.sessionManager.sendVisibleAssistantMarkdown`. These are deeply coupled to Orchestrator state (activeGoalTrees Map, goalDecomposer instance).

**Decision:** Keep goal decomposition inline in the loop. Extract only the replan state transition + telemetry. The loop handles goal decomposition before/after calling the extracted function, then applies `transitionPhase(agentState, AgentPhase.REPLANNING)`.

- [ ] **Step 2: Implement `handleInteractiveReflectionReplan`**

```typescript
/**
 * Handles the REPLAN reflection decision for interactive loops.
 * NOTE: Goal decomposition is NOT included — the caller handles it between
 * calling this function and pushing session messages.
 *
 * This function ONLY does: replan state transition via handleReplanDecision.
 * The caller is responsible for (in this order):
 *   1. Running goal decomposition on the returned state
 *   2. Calling transitionPhase(state, AgentPhase.REPLANNING)
 *   3. Pushing response.text to session as assistant message
 *   4. Recording phase outcome telemetry
 *   5. Pushing "Please create a new plan." to session
 *   6. Continuing the loop
 *
 * This preserves the original message ordering where goal decomposition
 * output appears before "Please create a new plan." in the conversation.
 */
export function handleInteractiveReflectionReplan(
  agentState: AgentState,
  ctx: InteractiveReflectionContext,
): ReflectionLoopAction {
  const replannedState = handleReplanDecision({
    agentState,
    executionJournal: ctx.executionJournal,
    responseText: ctx.responseText,
    providerName: ctx.currentAssignment.providerName,
    modelId: ctx.currentAssignment.modelId,
    autoTransition: false, // Goal decomposition may happen before transition
  });
  // Caller handles: goal decomp → transitionPhase → messages → telemetry
  return { flow: "continue", newState: replannedState };
}
```

- [ ] **Step 3: Implement `handleInteractiveReflectionContinue`**

Read `src/agents/orchestrator.ts` lines 4107-4154 first. Note: includes terminal failure check with `shouldSurfaceTerminalFailureFromReflection` + `resolveVisibleDraftDecisionPipeline`.

```typescript
export async function handleInteractiveReflectionContinue(
  agentState: AgentState,
  ctx: InteractiveReflectionContext,
  hasToolCalls: boolean,
  shouldSurfaceTerminalFailure: boolean,
): Promise<ReflectionLoopAction> {
  const newState = applyReflectionContinuation(agentState, ctx.responseText, { skipLastReflection: true });

  if (!hasToolCalls) {
    if (shouldSurfaceTerminalFailure) {
      const visibilityDecision = await resolveVisibleDraftDecisionPipeline({
        chatId: ctx.chatId,
        identityKey: ctx.identityKey,
        prompt: ctx.prompt,
        draft: ctx.responseText ?? "",
        agentState: newState,
        strategy: ctx.executionStrategy,
        systemPrompt: ctx.systemPrompt,
        selfVerification: ctx.selfVerification,
        taskStartedAtMs: ctx.taskStartedAtMs,
        availableToolNames: ctx.currentToolNames,
        terminalFailureReported: true,
        usageHandler: ctx.usageHandler,
      }, ctx.interventionDeps);
      if (visibilityDecision.kind === "internal_continue" && visibilityDecision.gate) {
        if (ctx.responseText) {
          ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
        }
        ctx.session.messages.push({ role: "user", content: visibilityDecision.gate });
        return { flow: "continue", newState };
      }
      if (visibilityDecision.visibleText) {
        return { flow: "done", visibleText: visibilityDecision.visibleText, newState };
      }
      return { flow: "done", visibleText: "", newState };
    }

    if (ctx.responseText) {
      ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
    }
    ctx.session.messages.push({ role: "user", content: "Please continue." });
  }
  return { flow: "continue", newState };
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`

---

### Task 7: Wire handlers into Orchestrator — Background loop

**Files:**
- Modify: `src/agents/orchestrator.ts`

- [ ] **Step 1: Add imports**

Add to the imports section:
```typescript
import {
  handleBgReflectionDone,
  handleBgReflectionReplan,
  handleBgReflectionContinue,
  type BgReflectionContext,
  type ReflectionLoopAction,
} from "./orchestrator-reflection-handler.js";
```

- [ ] **Step 2: Create a `buildBgReflectionContext` helper method on Orchestrator**

Add a private method that builds the `BgReflectionContext`:
```typescript
private buildBgReflectionContext(params: {
  chatId: string;
  identityKey: string;
  prompt: string;
  responseText: string | undefined;
  responseUsage: ProviderResponse["usage"] | undefined;
  toolCallCount: number;
  executionStrategy: SupervisorExecutionStrategy;
  executionJournal: ExecutionJournal;
  selfVerification: SelfVerification;
  stradaConformance: StradaConformanceGuard;
  taskStartedAtMs: number;
  currentToolNames: string[];
  currentAssignment: SupervisorAssignment;
  interventionDeps: InterventionDeps;
  session: ConversationSession;
  controlLoopTracker: ControlLoopTracker;
  workerCollector: WorkerCollector | null;
  progressTitle: string;
  progressLanguage: ProgressLanguage;
  iteration: number;
  emitProgress: (signal: TaskProgressSignal) => void;
  usageHandler?: (usage: TaskUsageEvent) => void;
  workspaceLease?: unknown;
  buildPhaseOutcomeTelemetry: (...) => unknown;
  systemPrompt: string;
}): BgReflectionContext {
  return {
    ...params,
    recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
    getClarificationContext: () => this.getClarificationContext(),
    formatBoundaryVisibleText: (b) => this.sessionManager.formatBoundaryVisibleText(b),
    appendVisibleAssistantMessage: (s, t) => this.sessionManager.appendVisibleAssistantMessage(s, t),
    synthesizeUserFacingResponse: (p) => this.synthesizeUserFacingResponse(p),
    persistSessionToMemory: (c, t, f) => this.sessionManager.persistSessionToMemory(c, t, f),
    getVisibleTranscript: (s) => this.sessionManager.getVisibleTranscript(s),
    buildStructuredProgressSignal: (p, t, s, l) => this.buildStructuredProgressSignal(p, t, s, l),
  };
}
```

- [ ] **Step 3: Replace BG REFLECTING handler (lines ~1931-2499)**

Replace the DONE/REPLAN/CONTINUE branches with:

```typescript
// ─── PAOR: Handle REFLECTING phase response ─────────────────────
if (bgAgentState.phase === AgentPhase.REFLECTING) {
  const { decision } = await processReflectionPreamble({
    agentState: bgAgentState,
    executionJournal,
    responseText: response.text,
    providerName: currentAssignment.providerName,
    modelId: currentAssignment.modelId,
    logLabel: "bg",
  });

  if (response.toolCalls.length === 0) {
    const pendingPlanReviewText = this.sessionManager.getPendingPlanReviewVisibleText(chatId);
    if (pendingPlanReviewText) {
      return bgFinishBlocked(pendingPlanReviewText);
    }
    const pendingWriteRejectionText =
      this.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(session, response.text);
    if (pendingWriteRejectionText) {
      return bgFinishBlocked(pendingWriteRejectionText);
    }
  }

  const bgCtx = this.buildBgReflectionContext({
    chatId, identityKey, prompt,
    responseText: response.text,
    responseUsage: response.usage,
    toolCallCount: response.toolCalls.length,
    executionStrategy, executionJournal,
    selfVerification, stradaConformance,
    taskStartedAtMs, currentAssignment,
    currentToolNames: currentToolDefinitions.map((d) => d.name),
    interventionDeps, session,
    controlLoopTracker, workerCollector,
    progressTitle, progressLanguage,
    iteration: bgIteration,
    emitProgress, workspaceLease: options.workspaceLease,
    usageHandler: options.onUsage ?? this.onUsage,
    buildPhaseOutcomeTelemetry: buildBgPhaseOutcomeTelemetry,
    systemPrompt,
  });

  let bgAction: ReflectionLoopAction;
  if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS") {
    bgAction = await handleBgReflectionDone(bgAgentState, bgCtx);
  } else if (decision === "REPLAN") {
    bgAction = handleBgReflectionReplan(bgAgentState, bgCtx);
  } else {
    bgAction = handleBgReflectionContinue(bgAgentState, bgCtx, response.toolCalls.length > 0);
  }

  if (bgAction.flow === "continue") {
    bgAgentState = bgAction.newState;
    if (decision !== "DONE" && decision !== "DONE_WITH_SUGGESTIONS" && response.toolCalls.length > 0) {
      // Fall through to tool execution below (CONTINUE with tool calls)
    } else {
      continue;
    }
  } else if (bgAction.flow === "done") {
    this.recordMetricEnd(metricId, {
      agentPhase: AgentPhase.COMPLETE,
      iterations: bgAgentState.iteration,
      toolCallCount: bgToolCallCount,
      hitMaxIterations: false,
    });
    await this.sessionManager.persistSessionToMemory(
      chatId,
      this.sessionManager.getVisibleTranscript(session),
      true,
    );
    // Use status from action — terminal_failure → "completed", plan_review → "blocked"
    return finish(
      bgAction.visibleText || "Task completed without output.",
      bgAction.status ?? "completed",
      bgAction.visibleText || "Task completed without output.",
    );
  } else {
    // blocked — use status from action if provided, otherwise bgFinishBlocked default
    if (bgAction.status === "completed") {
      return finish(bgAction.visibleText, "completed", bgAction.visibleText);
    }
    return bgFinishBlocked(bgAction.visibleText);
  }
}
```

**IMPORTANT:** The exact wiring depends on how the current code flows between the REFLECTING handler and the tool execution section below it. Read the code carefully at lines 2499-2510 to ensure the CONTINUE-with-toolcalls path still falls through to tool execution.

- [ ] **Step 4: Verify TypeScript**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

---

### Task 8: Wire handlers into Orchestrator — Interactive loop

**Files:**
- Modify: `src/agents/orchestrator.ts`

- [ ] **Step 1: Add interactive imports**

Add to the existing import:
```typescript
import {
  // ... existing bg imports ...
  handleInteractiveReflectionDone,
  handleInteractiveReflectionReplan,
  handleInteractiveReflectionContinue,
  type InteractiveReflectionContext,
} from "./orchestrator-reflection-handler.js";
```

- [ ] **Step 2: Replace Interactive REFLECTING handler (lines ~3791-4155)**

Replace the DONE/REPLAN/CONTINUE branches. Keep goal decomposition inline (the REPLAN handler returns early, then goal decomposition runs, then `transitionPhase`).

```typescript
// ─── PAOR: Handle REFLECTING phase response ─────────────────────
if (agentState.phase === AgentPhase.REFLECTING) {
  const { decision } = await processReflectionPreamble({
    agentState,
    executionJournal,
    responseText: response.text,
    providerName: currentAssignment.providerName,
    modelId: currentAssignment.modelId,
  });

  if (response.toolCalls.length === 0) {
    const pendingPlanReviewText = this.sessionManager.getPendingPlanReviewVisibleText(chatId);
    if (pendingPlanReviewText) {
      await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, pendingPlanReviewText);
      this.recordMetricEnd(metricId, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: agentState.iteration,
        toolCallCount: agentState.stepResults.length,
        hitMaxIterations: false,
      });
      return;
    }
    const pendingWriteRejectionText = this.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(
      session, response.text,
    );
    if (pendingWriteRejectionText) {
      await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, pendingWriteRejectionText);
      this.recordMetricEnd(metricId, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: agentState.iteration,
        toolCallCount: agentState.stepResults.length,
        hitMaxIterations: false,
      });
      return;
    }
  }

  const interactiveCtx: InteractiveReflectionContext = {
    chatId, identityKey, prompt: lastUserMessage,
    responseText: response.text,
    responseUsage: response.usage,
    toolCallCount: response.toolCalls.length,
    executionStrategy, executionJournal,
    selfVerification, stradaConformance,
    taskStartedAtMs, currentAssignment,
    currentToolNames: currentToolDefinitions.map((d) => d.name),
    interventionDeps, session, systemPrompt,
    usageHandler: this.onUsage,
    recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
    buildPhaseOutcomeTelemetry: buildInteractivePhaseOutcomeTelemetry,
  };

  let interactiveAction: ReflectionLoopAction;
  if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS") {
    interactiveAction = await handleInteractiveReflectionDone(agentState, interactiveCtx);
  } else if (decision === "REPLAN") {
    interactiveAction = handleInteractiveReflectionReplan(agentState, interactiveCtx);
    // handleInteractiveReflectionReplan only does state transition — caller handles the rest
    // to preserve message ordering: goal decomp output → assistant message → "Please create a new plan."
    if (interactiveAction.flow === "continue") {
      let replanState = interactiveAction.newState;
      // ─── Goal Decomposition: reactive decomposition when stuck ──────
      // ... (keep the existing goal decomposition code from lines 4035-4082,
      //      operating on replanState) ...
      // ────────────────────────────────────────────────────────────────
      replanState = transitionPhase(replanState, AgentPhase.REPLANNING);
      if (response.text) {
        session.messages.push({ role: "assistant", content: response.text });
      }
      this.recordPhaseOutcome({
        chatId, identityKey,
        assignment: currentAssignment,
        phase: "reflecting",
        status: "replanned",
        task: executionStrategy.task,
        reason: response.text ?? "reflection requested a new plan",
        telemetry: buildInteractivePhaseOutcomeTelemetry({
          state: replanState,
          usage: response.usage,
          failureReason: response.text,
        }),
      });
      session.messages.push({ role: "user", content: "Please create a new plan." });
      agentState = replanState;
      continue;
    }
  } else {
    interactiveAction = await handleInteractiveReflectionContinue(
      agentState,
      interactiveCtx,
      response.toolCalls.length > 0,
      shouldSurfaceTerminalFailureFromReflection(response),
    );
  }

  if (interactiveAction.flow === "continue") {
    agentState = interactiveAction.newState;
    if (decision !== "DONE" && decision !== "DONE_WITH_SUGGESTIONS" && response.toolCalls.length > 0) {
      // Fall through to tool execution
    } else {
      continue;
    }
  } else if (interactiveAction.flow === "done") {
    if (interactiveAction.visibleText) {
      await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, interactiveAction.visibleText);
    }
    this.recordMetricEnd(metricId, {
      agentPhase: AgentPhase.COMPLETE,
      iterations: agentState.iteration,
      toolCallCount: agentState.stepResults.length,
      hitMaxIterations: false,
    });
    return;
  } else {
    // blocked
    await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, interactiveAction.visibleText);
    this.recordMetricEnd(metricId, {
      agentPhase: AgentPhase.COMPLETE,
      iterations: agentState.iteration,
      toolCallCount: agentState.stepResults.length,
      hitMaxIterations: false,
    });
    return;
  }
}
```

- [ ] **Step 3: Remove old inline REFLECTING code**

Delete the old DONE/REPLAN/CONTINUE branches that were replaced by the function calls above.

- [ ] **Step 4: Verify TypeScript**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts src/agents/orchestrator-reflection-handler.ts
git commit -m "refactor(agents): extract reflection handlers from Orchestrator loops

Phase 4+5 of orchestrator restructuring milestone.
Extract DONE/REPLAN/CONTINUE reflection decision routing into standalone
functions in orchestrator-reflection-handler.ts:
- handleBgReflectionDone: clarification → boundary → verifier → synthesize
- handleBgReflectionReplan: state transition + telemetry
- handleBgReflectionContinue: plain continuation
- handleInteractiveReflectionDone: clarification → verifier → visibility
- handleInteractiveReflectionReplan: state transition (goal decomp stays inline)
- handleInteractiveReflectionContinue: terminal failure check + continuation

Functions return ReflectionLoopAction enum; loops handle flow control.
Also removes thin PAOR wrappers (toExecutionPhase, transitionToVerifierReplan)."
```

---

### Task 9: Unit tests for reflection handler

**Files:**
- Create: `src/agents/orchestrator-reflection-handler.test.ts`

- [ ] **Step 1: Write tests for `handleBgReflectionReplan`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleBgReflectionReplan } from "./orchestrator-reflection-handler.js";
import { createInitialState, AgentPhase } from "./agent-state.js";

describe("handleBgReflectionReplan", () => {
  it("returns continue with REPLANNING state", () => {
    const state = createInitialState("test prompt");
    // Advance to REFLECTING
    state.phase = AgentPhase.REFLECTING;
    state.iteration = 3;

    const ctx = buildMockBgCtx({ responseText: "This approach isn't working." });
    const result = handleBgReflectionReplan(state, ctx);

    expect(result.flow).toBe("continue");
    expect(result.newState.phase).toBe(AgentPhase.REPLANNING);
    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "replanned" }),
    );
  });

  it("pushes replan messages to session", () => {
    const state = { ...createInitialState("test"), phase: AgentPhase.REFLECTING };
    const ctx = buildMockBgCtx({ responseText: "Need new plan." });
    handleBgReflectionReplan(state, ctx);

    expect(ctx.session.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "Please create a new plan." }),
    );
  });
});
```

- [ ] **Step 2: Write tests for `handleBgReflectionContinue`**

Test that it returns `{ flow: "continue" }` with updated state, and pushes "Please continue." when no tool calls.

- [ ] **Step 3: Write mock builder helper**

```typescript
function buildMockBgCtx(overrides: Partial<BgReflectionContext> = {}): BgReflectionContext {
  return {
    chatId: "test-chat",
    identityKey: "test-user",
    prompt: "test prompt",
    responseText: undefined,
    responseUsage: undefined,
    toolCallCount: 0,
    executionStrategy: { /* minimal mock */ } as any,
    executionJournal: { recordVerifierResult: vi.fn() } as any,
    selfVerification: { getState: () => ({ touchedFiles: new Set() }) } as any,
    stradaConformance: {} as any,
    taskStartedAtMs: Date.now(),
    currentToolNames: [],
    currentAssignment: { providerName: "test", modelId: "test" } as any,
    interventionDeps: {} as any,
    session: { messages: [] },
    controlLoopTracker: {} as any,
    workerCollector: null,
    progressTitle: "Test",
    progressLanguage: "en" as any,
    iteration: 1,
    emitProgress: vi.fn(),
    buildStructuredProgressSignal: vi.fn(() => ({} as any)),
    usageHandler: undefined,
    recordPhaseOutcome: vi.fn(),
    buildPhaseOutcomeTelemetry: vi.fn(() => ({})),
    getClarificationContext: vi.fn(() => ({} as any)),
    formatBoundaryVisibleText: vi.fn(),
    appendVisibleAssistantMessage: vi.fn(),
    synthesizeUserFacingResponse: vi.fn(async () => "synthesized"),
    persistSessionToMemory: vi.fn(async () => {}),
    getVisibleTranscript: vi.fn(() => ""),
    systemPrompt: "You are a helpful assistant.",
    ...overrides,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agents/orchestrator-reflection-handler.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator-reflection-handler.test.ts
git commit -m "test(agents): add reflection handler unit tests"
```

---

### Task 10: Final verification + line count audit

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Count lines**

Run: `wc -l src/agents/orchestrator.ts src/agents/orchestrator-reflection-handler.ts`

Expected:
- `orchestrator.ts`: ~5,600-5,800 lines (down from 6,434 — ~650-800 lines removed)
- `orchestrator-reflection-handler.ts`: ~600-700 lines

- [ ] **Step 4: Verify no remaining inline DONE/REPLAN/CONTINUE handlers**

Run:
```bash
grep -c "decision === .DONE" src/agents/orchestrator.ts
```

Expected: 2 matches (the dispatching `if` checks), not the full inline handlers.

- [ ] **Step 5: Verify no remaining thin wrappers**

Run:
```bash
grep -n "private toExecutionPhase\|private transitionToVerifierReplan" src/agents/orchestrator.ts
```

Expected: 0 matches
