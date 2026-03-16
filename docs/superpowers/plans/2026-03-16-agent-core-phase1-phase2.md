# Agent Core v5.0 — Phase 1 & Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the PAOR/TaskPlanner planning conflict and unify interactive + background execution into a single PAOR-driven loop, so all tasks (user, daemon, agent-core) get the same quality of reasoning.

**Architecture:** Phase 1 migrates TaskPlanner's C#-specific rules into PAOR prompts, then removes the conflicting `PLANNING_PROMPT` injection. Phase 2 extracts shared system prompt assembly from the orchestrator, then creates a `UnifiedAgentLoop` that both `runAgentLoop()` and `runBackgroundTask()` delegate to — giving background tasks PAOR reflection and replanning for the first time.

**Tech Stack:** TypeScript, Vitest, existing PAOR state machine (`agent-state.ts`, `paor-prompts.ts`), existing orchestrator (`orchestrator.ts`), existing autonomy modules (`task-planner.ts`)

**Spec:** `docs/superpowers/specs/2026-03-16-agent-core-design.md`

---

## Chunk 1: Phase 1 — Unify PAOR + Remove TaskPlanner Conflict

### Task 1: Migrate C# Verification Rules to PAOR Prompts

**Files:**
- Modify: `src/agents/paor-prompts.ts:14-23` (buildPlanningPrompt)
- Modify: `src/agents/paor-prompts.ts:146-160` (buildExecutionContext)
- Test: `src/agents/orchestrator.test.ts` (existing PAOR tests)

The `PLANNING_PROMPT` in `src/agents/autonomy/task-planner.ts:47-66` contains two things:
1. The conflicting `OBSERVE → PLAN → ACT → VERIFY → RESPOND` protocol (will be REMOVED)
2. Unity/C#-specific operational rules that must be PRESERVED:
   - "After editing files, run dotnet_build. After bug fixes, run dotnet_test."
   - "NEVER declare done without verifying compilation."
   - "Fix in dependency order: missing types → undefined symbols → type mismatches → logic."
   - "After fixing, rebuild to verify. If stuck after 3 attempts, try a different approach."

These rules must be migrated to PAOR prompts BEFORE removing the TaskPlanner prompt.

- [ ] **Step 1: Add verification rules to buildPlanningPrompt()**

In `src/agents/paor-prompts.ts`, modify the `buildPlanningPrompt` function. After the "Each step should be a concrete, actionable item." line (line 22), add:

```typescript
    "",
    "### Verification Protocol",
    "- After editing compilable files (.cs, .csproj, .sln), run dotnet_build to verify.",
    "- After bug fixes, run dotnet_test to confirm the fix.",
    "- NEVER declare done without verifying compilation succeeds.",
    "",
    "### Error Recovery Order",
    "- When build/test fails, fix in dependency order: missing types → undefined symbols → type mismatches → logic errors.",
    "- After each fix, rebuild to verify. If stuck after 3 attempts, try a fundamentally different approach.",
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npx vitest run src/agents/orchestrator.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All existing PAOR tests pass (the new prompt content doesn't break anything)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: 3350+ tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agents/paor-prompts.ts
git commit -m "feat(paor): migrate C# verification and error recovery rules from TaskPlanner to PAOR prompts"
```

---

### Task 2: Remove TaskPlanner Conflicting Prompt

**Files:**
- Modify: `src/agents/autonomy/task-planner.ts:47-66` (remove PLANNING_PROMPT constant)
- Modify: `src/agents/autonomy/task-planner.ts` (remove getPlanningPrompt method)
- Modify: `src/agents/orchestrator.ts:661` (remove background path injection)
- Modify: `src/agents/orchestrator.ts:1336` (remove interactive path injection)
- Test: `src/agents/autonomy/task-planner.test.ts` (update/remove getPlanningPrompt tests)

- [ ] **Step 1: Remove PLANNING_PROMPT constant from task-planner.ts**

In `src/agents/autonomy/task-planner.ts`, delete lines 46-66 (the `PLANNING_PROMPT` constant).

- [ ] **Step 2: Remove getPlanningPrompt() method from task-planner.ts**

Find and remove the `getPlanningPrompt()` method. It simply returns the `PLANNING_PROMPT` constant.

- [ ] **Step 3: Remove prompt injection from orchestrator background path**

In `src/agents/orchestrator.ts` at line 661, remove:
```typescript
    systemPrompt += taskPlanner.getPlanningPrompt();
```

- [ ] **Step 4: Remove prompt injection from orchestrator interactive path**

In `src/agents/orchestrator.ts` at line 1336, remove:
```typescript
    systemPrompt += taskPlanner.getPlanningPrompt();
```

- [ ] **Step 5: Update task-planner tests**

In `src/agents/autonomy/task-planner.test.ts`, find and remove any tests that call `getPlanningPrompt()` or assert on `PLANNING_PROMPT` content. Keep all other tests (trackToolCall, getStateInjection, startTask, endTask, recordError).

- [ ] **Step 6: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Clean compilation (no errors)

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: 3350+ tests pass (minus any removed getPlanningPrompt tests)

- [ ] **Step 8: Commit**

```bash
git add src/agents/autonomy/task-planner.ts src/agents/orchestrator.ts src/agents/autonomy/task-planner.test.ts
git commit -m "refactor: remove TaskPlanner conflicting PLANNING_PROMPT — PAOR is now single planning authority"
```

---

## Chunk 2: Phase 2 — Unified Agent Loop (Part A: Extract Shared Prompt Assembly)

### Task 3: Extract buildSystemPromptWithContext() from Orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts` (extract method from both paths)

The orchestrator has ~150 lines of duplicated system prompt assembly in both `runAgentLoop()` (lines ~1244-1330) and `runBackgroundTask()` (lines ~547-650). Both do:
1. Soul personality injection
2. Autonomous mode directive
3. Provider intelligence
4. Language directive
5. User profile context
6. Memory retrieval (semantic search)
7. RAG injection
8. Analysis cache injection
9. Instinct retrieval

Extract this into a single private method.

- [ ] **Step 1: Create the shared method signature**

Add a new private method to the Orchestrator class:

```typescript
private async buildSystemPromptWithContext(params: {
  chatId: string;
  channelType?: string;
  prompt: string;
  personaContent?: string;
  isUserTask: boolean;
  profile: UserProfile | null;
  preComputedEmbedding?: number[];
}): Promise<{ systemPrompt: string; initialContentHashes: string[] }>
```

This method should contain the merged logic from both paths. The key difference between paths is:
- Interactive: uses `buildContextLayers()` method
- Background: does memory/RAG/instinct inline

The unified method should use the `buildContextLayers()` approach for both.

- [ ] **Step 2: Implement the method**

Move the following from `runAgentLoop()` into `buildSystemPromptWithContext()`:
- Soul personality injection (line 1244)
- Autonomous mode directive (line 1247-1249)
- Provider intelligence (line 1252-1255)
- Language directive (line 1257-1260)
- Context layers (line 1286 — calls buildContextLayers)
- RAG injection (line 1293-1313)
- Analysis cache injection (line 1316-1329)
- Instinct retrieval (line 1345-1353)

- [ ] **Step 3: Refactor runAgentLoop() to use the shared method**

Replace the ~80 lines of prompt assembly in `runAgentLoop()` with a call to `buildSystemPromptWithContext()`.

- [ ] **Step 4: Refactor runBackgroundTask() to use the shared method**

Replace the ~100 lines of inline prompt assembly in `runBackgroundTask()` with a call to `buildSystemPromptWithContext()`.

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Clean

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: All tests pass (behavior unchanged, just DRY refactor)

- [ ] **Step 7: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "refactor: extract buildSystemPromptWithContext() — DRY system prompt assembly"
```

---

## Chunk 3: Phase 2 — Unified Agent Loop (Part B: Create UnifiedAgentLoop)

### Task 4: Create UnifiedAgentLoop Class

**Files:**
- Create: `src/agents/unified-agent-loop.ts`
- Create: `src/agents/unified-agent-loop.test.ts`

This is the core of Phase 2. The UnifiedAgentLoop provides a single PAOR-driven execution path that both interactive and background tasks use.

- [ ] **Step 1: Write the failing integration test**

Create `src/agents/unified-agent-loop.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnifiedAgentLoop } from "./unified-agent-loop.js";
import { AgentPhase } from "./agent-state.js";

// Test: background tasks now use PAOR phases
describe("UnifiedAgentLoop", () => {
  it("daemon-origin tasks go through PLANNING → EXECUTING → COMPLETE phases", async () => {
    const mockProvider = {
      chat: vi.fn()
        // First call: PLANNING phase — LLM returns a plan
        .mockResolvedValueOnce({
          text: "Plan:\n1. Read file\n2. Edit file",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
    };

    const phaseLog: string[] = [];
    const loop = new UnifiedAgentLoop({
      provider: mockProvider,
      tools: new Map(),
      channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
      projectPath: "/tmp/test",
      readOnly: false,
      onPhaseChange: (phase) => phaseLog.push(phase),
    });

    await loop.execute({
      prompt: "Fix the build error",
      chatId: "daemon",
      channelType: "daemon",
      systemPrompt: "You are a helpful assistant.",
      origin: "daemon",
      skipOnboarding: true,
    });

    // Verify PAOR phases were used (not flat loop)
    expect(phaseLog).toContain(AgentPhase.PLANNING);
  });

  it("reflects after errors in background tasks", async () => {
    const mockProvider = {
      chat: vi.fn()
        // PLANNING: return plan
        .mockResolvedValueOnce({
          text: "1. Run build",
          toolCalls: [{ id: "tc1", name: "dotnet_build", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 100, outputTokens: 50 },
        })
        // REFLECTING: return DONE
        .mockResolvedValueOnce({
          text: "Build succeeded.\n\n**DONE**",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
    };

    const phaseLog: string[] = [];
    const loop = new UnifiedAgentLoop({
      provider: mockProvider,
      tools: new Map([["dotnet_build", {
        name: "dotnet_build",
        description: "Build",
        execute: vi.fn().mockResolvedValue({ content: "Build failed: CS0246", isError: true }),
      }]]),
      channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
      projectPath: "/tmp/test",
      readOnly: false,
      onPhaseChange: (phase) => phaseLog.push(phase),
    });

    await loop.execute({
      prompt: "Fix the build error",
      chatId: "daemon",
      channelType: "daemon",
      systemPrompt: "You are a helpful assistant.",
      origin: "daemon",
      skipOnboarding: true,
    });

    // Background task should reflect on error (not just continue blindly)
    expect(phaseLog).toContain(AgentPhase.REFLECTING);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/unified-agent-loop.test.ts --reporter=verbose 2>&1 | tail -10`
Expected: FAIL — module not found

- [ ] **Step 3: Create UnifiedAgentLoop implementation**

Create `src/agents/unified-agent-loop.ts` with the PAOR-driven execution loop. This is a significant file (~300 lines) that extracts the core loop logic from the orchestrator's `runAgentLoop()` method.

The key parts to include:
- PAOR state machine initialization (`createInitialState`)
- Phase-aware prompt building (PLANNING/EXECUTING/REFLECTING/REPLANNING)
- Reflection decision parsing (`parseReflectionDecision`)
- Tool execution with autonomy tracking (ErrorRecoveryEngine, SelfVerification, TaskPlanner tracking)
- Step result recording and reflection triggers
- Goal detection in PLANNING phase
- Memory re-retrieval per iteration
- Verification gate (SelfVerification.needsVerification)

The implementation should be extracted from the existing `runAgentLoop()` code in orchestrator.ts, preserving exact behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/unified-agent-loop.test.ts --reporter=verbose 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/agents/unified-agent-loop.ts src/agents/unified-agent-loop.test.ts
git commit -m "feat: create UnifiedAgentLoop with PAOR-driven execution for all task types"
```

---

### Task 5: Wire Orchestrator to Delegate to UnifiedAgentLoop

**Files:**
- Modify: `src/agents/orchestrator.ts` (refactor runAgentLoop + runBackgroundTask)
- Test: existing orchestrator tests + integration tests

- [ ] **Step 1: Add UnifiedAgentLoop as orchestrator dependency**

In the Orchestrator constructor, create and store a `UnifiedAgentLoop` instance.

- [ ] **Step 2: Refactor runAgentLoop() to delegate**

Replace the PAOR loop body in `runAgentLoop()` with a call to `this.unifiedLoop.execute()`. Keep the session management, typing indicator, and memory persistence in the orchestrator — only the core PAOR loop moves.

- [ ] **Step 3: Refactor runBackgroundTask() to delegate**

Replace the simple for-loop in `runBackgroundTask()` with a call to `this.unifiedLoop.execute()` with `origin: "daemon"` and `skipOnboarding: true` (for daemon/agent-core origin).

Preserve the natural onboarding extraction for user-initiated background tasks (when origin is "user").

- [ ] **Step 4: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Clean

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -15`
Expected: All 3350+ tests pass

- [ ] **Step 6: Run integration tests specifically**

Run: `npx vitest run src/tests/integration/ --reporter=verbose 2>&1 | tail -20`
Expected: All integration tests pass

- [ ] **Step 7: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "refactor: orchestrator delegates to UnifiedAgentLoop — background tasks now use PAOR"
```

---

### Task 6: Update BackgroundExecutor to Use UnifiedAgentLoop

**Files:**
- Modify: `src/tasks/background-executor.ts`
- Test: existing background executor tests

- [ ] **Step 1: Verify BackgroundExecutor calls orchestrator.runBackgroundTask()**

Check that `BackgroundExecutor.executeTask()` delegates to `orchestrator.runBackgroundTask()` (which now delegates to UnifiedAgentLoop). No changes needed if the refactor in Task 5 was transparent.

- [ ] **Step 2: Run BackgroundExecutor-related tests**

Run: `npx vitest run src/tasks/ --reporter=verbose 2>&1 | tail -20`
Expected: All task system tests pass

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: All 3350+ tests pass

- [ ] **Step 4: Build web portal**

Run: `cd web-portal && npm run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit (if any changes needed)**

```bash
git add src/tasks/background-executor.ts
git commit -m "refactor: BackgroundExecutor uses PAOR via UnifiedAgentLoop"
```

---

## Chunk 4: Validation + Future Phase Outlines

### Task 7: Final Validation

- [ ] **Step 1: TypeScript strict check**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Clean

- [ ] **Step 2: Full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 3: Verify PAOR conflict is resolved**

Search for TaskPlanner planning prompt usage — should be zero:
```bash
grep -rn "getPlanningPrompt\|PLANNING_PROMPT" src/agents/ --include="*.ts" | grep -v test | grep -v ".d.ts"
```
Expected: No results (only test files may reference it)

- [ ] **Step 4: Verify background path uses PAOR**

Search for PAOR phase usage in the unified loop:
```bash
grep -rn "AgentPhase\|transitionPhase" src/agents/unified-agent-loop.ts
```
Expected: Multiple hits showing PAOR is active

---

## Future Phases (Separate Plans)

### Phase 3: Observation Engine
Will be planned after Phase 1-2 validation. Creates `src/agent-core/` directory with:
- `observation-types.ts` — `AgentObservation` interface
- `observation-engine.ts` — Collects from observers, priority queue
- `observers/file-watch-observer.ts` — Wraps FileWatchTrigger
- `observers/trigger-observer.ts` — Wraps TriggerRegistry
- `observers/user-activity-observer.ts` — Wraps idle detection
- `observers/git-state-observer.ts` — New: periodic `git status`
- `observers/build-state-observer.ts` — Wraps SelfVerification state

### Phase 4: Agent Core + Priority Scoring
Will be planned after Phase 3. Creates:
- `src/agent-core/agent-core.ts` — OODA reasoning loop with tickInFlight guard
- `src/agent-core/priority-scorer.ts` — Learning-informed observation ranking
- `src/agent-core/reasoning-prompt.ts` — LLM prompt for autonomous decisions
- Wiring into HeartbeatLoop as second tick phase

### Phase 5: Communication + Polish
Will be planned after Phase 4. Creates:
- `src/agent-core/agent-notifier.ts` — Proactive user notifications
- `/agent` chat command
- Dashboard agent activity panel
- Web portal agent toggle
