# Progress-Aware Gate Assessment (PAGA)

**Date**: 2026-03-24
**Status**: Approved
**Scope**: Background task loop — gate decision intelligence

## Problem

When the agent generates text-only responses (analysis/clarification) without executing tools, the system relies on hardcoded thresholds to detect loops. The `ControlLoopTracker` counts events and fingerprints but ignores the rich behavioral data already available (mutation counts, inspection counts, phase transitions, tool diversity, touched files). This leads to either slow detection (50+ iterations wasted) or false positives from aggressive thresholds.

The system has all the data it needs to understand whether the agent is making progress — it just doesn't use it.

## Solution

Replace threshold-based loop detection with an LLM-powered progress assessment that evaluates the agent's behavioral state at each gate decision. A haiku-tier model receives a compact behavioral snapshot and answers one question: "Is this agent making meaningful progress or is it stuck?"

## Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Model | Haiku-tier (cheapest available) | ~$0.00003/assessment, question is simple |
| Timing | Deferred — skip gate 1, assess from gate 2+ | Agent needs freedom for initial exploration |
| Existing override | `shouldKeepClarificationInternal` bypassed when stuck | Preserves autonomy when progressing, escalates when stuck |
| ControlLoopTracker | Kept as safety net with high thresholds (15/20/10) | Catches LLM assessment failures (timeout, parse error) |
| Affected systems | BG loop gate decisions only | DAG, Kanban, interactive loop, goal execution unchanged |

## Architecture

```
LLM Response (text-only, no tool calls)
        │
        ▼
Clarification / Visibility Gate → "internal_continue"
        │
        ▼
tracker.incrementTextOnlyGate()     ← always increments counter
        │
tracker.getConsecutiveTextOnlyGates()
        │
    count == 1? ──yes──→ Pass (free first analysis)
        │no (count >= 2)
        ▼
Progress Assessment (haiku LLM)
        │
    ┌───┴────────┐
progressing    stuck         (parse error / timeout)
    │            │                    │
    ▼            ▼                    ▼
recordGate()  Directive(1st)    recordGate() ← safety net
+ continue    or Block(2nd+)    + existing tracker logic
```

**"count" = `tracker.getConsecutiveTextOnlyGates()`** — the private `consecutiveNoToolGates` counter exposed via a public getter. Resets to 0 on `markToolExecution()`, `markVerificationClean()`, `markMeaningfulFileEvidence()`, and `markRecoveryAttempt()`.

### New Module

`src/agents/autonomy/progress-assessment.ts`

### Integration Point

Inside `handleBackgroundLoopRecovery` in `orchestrator-intervention-pipeline.ts`. The flow is:

1. **Increment counter first**: Call `tracker.incrementTextOnlyGate()` (new method that only increments `consecutiveNoToolGates`, does NOT record a gate event)
2. **Check gate count**: Read `tracker.getConsecutiveTextOnlyGates()`
3. **If count === 1**: Return `{ action: "none" }` — free first analysis
4. **If count >= 2**: Run progress assessment LLM call
5. **If assessment succeeds**: Act on verdict (skip `recordGate` entirely if stuck)
6. **If assessment fails**: Fall through to `recordGate()` and existing tracker logic

This separates the counter increment (always happens) from the gate event recording (only happens when assessment is unavailable or returns "progressing"). The existing `recordGate` + fingerprint/density detection becomes the safety net path.

## Behavioral Snapshot

All data derived from existing systems. Zero new data gathering infrastructure.

```typescript
interface BehavioralSnapshot {
  // Task context
  prompt: string;                    // user's original request (truncated 200 char)
  currentPhase: AgentPhase;          // PLANNING | EXECUTING | REFLECTING | REPLANNING

  // Step counts (from CompletionReviewEvidence)
  totalStepCount: number;
  mutationStepCount: number;         // file_write, file_edit, shell_exec
  inspectionStepCount: number;       // file_read, grep, list_directory
  verificationStepCount: number;     // dotnet_build, test, lint

  // Loop indicators
  consecutiveTextOnlyGates: number;  // from tracker.getConsecutiveTextOnlyGates()
  reflectionCount: number;           // from agentState.reflectionCount
  failedApproachCount: number;       // from agentState.failedApproaches.length
  consecutiveErrors: number;         // from agentState.consecutiveErrors

  // Progress signals
  touchedFileCount: number;          // from selfVerification.getState().touchedFiles.size
  hasActivePlan: boolean;            // derived: agentState.plan !== null
  lastToolName: string | null;       // derived: agentState.stepResults.at(-1)?.toolName ?? null
  timeSinceLastMutationMs: number;   // derived: see below

  // Current draft
  draftExcerpt: string;              // first 200 chars of LLM's latest text
}
```

### Data Sources & Derivation

| Field | Source | How |
|-------|--------|-----|
| `prompt` | `params.prompt` | Direct, truncated to 200 chars |
| `currentPhase` | `params.state.phase` | Direct |
| `totalStepCount` | `params.state.stepResults.length` | Direct |
| `mutationStepCount` | `params.state.stepResults` | Filter by MUTATION_TOOLS set |
| `inspectionStepCount` | `params.state.stepResults` | Filter by INSPECTION_TOOLS set |
| `verificationStepCount` | `params.state.stepResults` | Filter by VERIFICATION_TOOLS set |
| `consecutiveTextOnlyGates` | `ControlLoopTracker` | New public getter: `getConsecutiveTextOnlyGates()` |
| `reflectionCount` | `params.state.reflectionCount` | Direct |
| `failedApproachCount` | `params.state.failedApproaches.length` | Direct |
| `consecutiveErrors` | `params.state.consecutiveErrors` | Direct |
| `touchedFileCount` | `params.selfVerification.getState().touchedFiles.size` | Direct |
| `hasActivePlan` | `params.state.plan !== null` | Derived |
| `lastToolName` | `params.state.stepResults.at(-1)?.toolName ?? null` | Derived from last step |
| `timeSinceLastMutationMs` | `params.state.stepResults` | Find last mutation step's timestamp, compute `Date.now() - ts`. If no mutations: `Date.now() - taskStartedAtMs` |
| `draftExcerpt` | `params.draft` or `ctx.responseText` | Truncated to 200 chars |

### Required Code Changes for Data Access

1. **ControlLoopTracker**: Add public getter `getConsecutiveTextOnlyGates(): number` (returns private `consecutiveNoToolGates`)
2. **Tool classification sets**: Define `MUTATION_TOOLS`, `INSPECTION_TOOLS`, `VERIFICATION_TOOLS` in `progress-assessment.ts` (mirrors existing classification in `self-verification.ts`)

## Assessment Prompt

### System Prompt (~150 tokens, static)

```
You are Strada Brain's progress assessor.
Given a behavioral snapshot of an executing agent, determine whether
it is making meaningful progress toward the user's goal or is stuck
in a repetitive analysis/clarification loop.

"progressing" means: the agent has used tools, touched files, made
mutations, or is in an early exploration phase with clear next steps.

"stuck" means: the agent keeps generating text-only responses without
tool execution, repeats the same analysis pattern, or has not
transitioned from analysis to implementation despite sufficient context.

Return JSON only:
{"verdict":"progressing"|"stuck","confidence":"high"|"medium"|"low",
"directive":"one concrete next action if stuck"}
```

### User Message (~200 tokens, dynamic)

```
User goal: {prompt}
Phase: {currentPhase}
Steps: {totalStepCount} total ({mutationStepCount} mutations,
  {inspectionStepCount} inspections, {verificationStepCount} verifications)
Consecutive text-only gates: {consecutiveTextOnlyGates}
Reflections: {reflectionCount}, Failed approaches: {failedApproachCount}
Files touched: {touchedFileCount}
Has plan: {hasActivePlan}
Last tool: {lastToolName ?? "none"}
Time since last mutation: {timeSinceLastMutationMs}ms
Current draft excerpt: {draftExcerpt}

Is this agent making meaningful progress or stuck?
```

### Response Schema

```typescript
interface ProgressAssessment {
  verdict: "progressing" | "stuck";
  confidence: "high" | "medium" | "low";
  directive?: string;  // concrete next action when stuck
}
```

**Cost per assessment**: ~350 input + ~30 output tokens = ~$0.00003 at haiku pricing.

## Decision Matrix

| Verdict | Confidence | Action |
|---------|-----------|--------|
| `progressing` | any | Continue with standard gate |
| `stuck` | `high` | Directive gate: "STOP analyzing. Do this: {directive}" |
| `stuck` | `medium` | Directive gate: same but softer tone |
| `stuck` | `low` | Continue with standard gate (not confident enough) |
| Parse error / timeout | — | Fallback to ControlLoopTracker |

### Escalation on repeated "stuck"

- **1st stuck**: Inject directive gate with replan. Agent gets a fresh window to execute tools.
- **2nd stuck**: Forced blocked checkpoint. Task stops with honest summary.

This uses the existing `markRecoveryAttempt` mechanism — recovery attempt 1 replans, attempt 2+ blocks.

## Changes to Existing Systems

### shouldKeepClarificationInternal (orchestrator-clarification.ts)

New `progressStuck` parameter. When `true`, the hardcoded `escalationPolicy === "hard-blockers-only"` override is bypassed, allowing the clarification reviewer's original decision to reach the user.

```typescript
export function shouldKeepClarificationInternal(
  ctx: ClarificationContext,
  decision: ClarificationReviewDecision | null | undefined,
  text: string,
  progressStuck?: boolean,
): boolean {
  if (progressStuck) return false;
  // ... existing logic unchanged
}
```

### ControlLoopTracker (control-loop-tracker.ts)

Thresholds raised to safety-net levels:

| Threshold | Before | After | Role |
|-----------|--------|-------|------|
| `fpThreshold` | 3 | 15 | Safety net only |
| `densityThreshold` | 5 | 20 | Safety net only |
| `staleAnalysisThreshold` | 3 | 10 | Safety net only |

Tracker is no longer primary defense — only fires if LLM assessment fails.

### handleBackgroundLoopRecovery (orchestrator-intervention-pipeline.ts)

New flow inserted at the TOP of the function, before existing `tracker.recordGate()`:

```typescript
// 1. Always increment text-only counter
params.tracker.incrementTextOnlyGate();
const gateCount = params.tracker.getConsecutiveTextOnlyGates();

// 2. Free first analysis
if (gateCount <= 1) {
  return { action: "none" };
}

// 3. Progress assessment (haiku-tier LLM)
if (params.progressAssessmentEnabled !== false) {
  const snapshot = buildBehavioralSnapshot(params);
  const assessment = await runProgressAssessment(snapshot, deps);

  if (assessment) {
    if (assessment.verdict === "progressing") {
      // Agent is fine — record gate for safety net tracking, continue
      params.tracker.recordGate({ kind, reason, gate, iteration });
      return { action: "none" };
    }
    if (assessment.verdict === "stuck" && assessment.confidence !== "low") {
      // Agent is stuck — act without recording gate
      const recoveryAttempt = params.tracker.markRecoveryAttempt(fingerprint);
      if (recoveryAttempt >= 2) {
        return { action: "blocked", message: buildStuckCheckpoint(params, assessment) };
      }
      return { action: "replan", gate: buildDirectiveGate(assessment) };
    }
    // stuck + low confidence — fall through to safety net
  }
  // assessment is null (parse error / timeout) — fall through to safety net
}

// 4. Existing tracker logic (safety net) — unchanged
const trigger = params.tracker.recordGate({ kind, reason, gate, iteration });
if (!trigger) return { action: "none" };
// ... rest of existing recovery pipeline
```

### ControlLoopTracker new methods

```typescript
// New method: increment counter without recording gate event
incrementTextOnlyGate(): void {
  this.consecutiveNoToolGates++;
}

// New method: expose counter for assessment
getConsecutiveTextOnlyGates(): number {
  return this.consecutiveNoToolGates;
}
```

### Config (config.ts)

New env var: `STRADA_PROGRESS_ASSESSMENT_ENABLED` (default: true). Allows disabling the feature without code changes if needed.

## Files Changed

| File | Change |
|------|--------|
| `src/agents/autonomy/progress-assessment.ts` | **NEW** — BehavioralSnapshot, buildSnapshot, runProgressAssessment, parseAssessment |
| `src/agents/orchestrator-intervention-pipeline.ts` | Insert progress assessment before tracker logic |
| `src/agents/orchestrator-clarification.ts` | Add `progressStuck` parameter to shouldKeepClarificationInternal |
| `src/agents/autonomy/control-loop-tracker.ts` | Raise default thresholds to safety-net levels |
| `src/config/config.ts` | Add STRADA_PROGRESS_ASSESSMENT_ENABLED |
| `src/agents/autonomy/index.ts` | Export new module |

## What Does NOT Change

- Interactive loop (no ControlLoopTracker involvement)
- DAG / GoalDecomposer / GoalExecutor
- Kanban / web portal task rendering
- Clarification reviewer LLM call (still runs, PAGA runs after it)
- Visibility boundary (still runs, PAGA runs after it)
- Verifier pipeline
- Daemon mode / heartbeat / progress signals

## Testing Strategy

1. **Unit tests** for `progress-assessment.ts`: snapshot building, prompt construction, response parsing, fallback on parse error
2. **Unit tests** for updated `shouldKeepClarificationInternal`: verify bypass when `progressStuck=true`
3. **Integration test**: simulate the exact stuck-loop scenario — verify assessment catches it at gate 2 instead of gate 5+
4. **Integration test**: simulate productive agent — verify assessment returns "progressing" and doesn't interfere
5. **Fallback test**: simulate LLM timeout — verify ControlLoopTracker safety net activates
