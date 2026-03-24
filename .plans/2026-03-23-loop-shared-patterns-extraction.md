# Loop Shared Patterns Extraction — Orchestrator Incremental Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract 4 identical inline patterns from both BG and Interactive loops into shared helper functions, saving ~270 lines from `orchestrator.ts`.

**Architecture:** Create `src/agents/orchestrator-loop-shared.ts` with standalone functions matching the existing helper module pattern. Each function takes explicit params (no class dependency). Both loops call the same function.

**Tech Stack:** TypeScript (strict mode), Vitest, ESM modules

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| **Create** | `src/agents/orchestrator-loop-shared.ts` | 4 shared loop functions |
| **Create** | `src/agents/orchestrator-loop-shared.test.ts` | Unit tests |
| **Modify** | `src/agents/orchestrator.ts` | Replace inline code with function calls |

---

## Patterns to Extract

### Pattern 1: Tool Execution + Tracking (~40 lines × 2)

**BG** (lines ~2557-2595) and **Interactive** (lines ~3953-3991) both do:
1. Push assistant message with tool_calls to session
2. Call `executeToolCalls(chatId, toolCalls, options)`
3. Call `trackAndRecordToolResults(...)` with autonomy objects
4. Update workerCollector (BG-only, optional)

Extract as:
```typescript
export async function executeAndTrackTools(params: {
  chatId: string;
  session: { messages: Array<ConversationMessage> };
  response: { text?: string; toolCalls: ToolCall[] };
  executeToolCalls: (chatId: string, toolCalls: ToolCall[], opts?: ToolExecutionOptions) => Promise<ToolResult[]>;
  trackParams: TrackAndRecordToolResultsParams;
  toolExecutionOptions?: ToolExecutionOptions;
}): Promise<{ toolResults: ToolResult[]; toolResultContent: ConversationMessage["content"] }>
```

### Pattern 2: Memory Re-retrieval (~44 lines × 2)

**BG** (lines ~2682-2725) and **Interactive** (lines ~4052-4095) both do:
1. Check if memory retrieval should refresh (iteration > 0, tool results touched files)
2. Call `retrieveMemoryContext(...)` with the prompt embedding
3. Update systemPrompt sections with new memory context
4. Build new `currentToolDefinitions` from updated context

Extract as:
```typescript
export async function refreshMemoryIfNeeded(params: {
  iteration: number;
  toolResults: ToolResult[];
  prompt: string;
  promptEmbedding: number[] | null;
  chatId: string;
  identityKey: string;
  retrieveMemory: (...) => Promise<MemoryContext>;
  currentSystemPrompt: string;
  // ... other needed params
}): Promise<{ updatedSystemPrompt: string; shouldRefresh: boolean }>
```

### Pattern 3: Consensus Verification (~33 lines × 3 instances)

**BG** (line ~2617) and **Interactive** (lines ~3998, ~3769) call `runConsensusVerification` with nearly identical params. Extract the param assembly:

```typescript
export function buildConsensusParams(params: {
  chatId: string;
  identityKey: string;
  toolResults: ToolResult[];
  executionStrategy: SupervisorExecutionStrategy;
  executionJournal: ExecutionJournal;
  selfVerification: SelfVerification;
  stradaConformance: StradaConformanceGuard;
  usageHandler?: (usage: TaskUsageEvent) => void;
}): ConsensusVerificationParams
```

### Pattern 4: Step Recording + Reflection Check (~18 lines × 2)

**BG** (lines ~2652-2669) and **Interactive** (lines ~4031-4041) both call `recordStepResultsAndCheckReflection` with the same param pattern, then handle the phase transition identically.

Extract as:
```typescript
export function recordStepAndTransition(params: {
  agentState: AgentState;
  executionJournal: ExecutionJournal;
  toolResults: ToolResult[];
  response: { text?: string };
  providerName: string;
  modelId?: string;
}): AgentState
```

---

### Task 1: Create module with Pattern 1 (Tool Execution + Tracking)

- [ ] Read BG tool execution (orchestrator.ts ~2557-2595)
- [ ] Read Interactive tool execution (orchestrator.ts ~3953-3991)
- [ ] Create `src/agents/orchestrator-loop-shared.ts` with `executeAndTrackTools`
- [ ] Verify compilation: `npx tsc --noEmit`

### Task 2: Add Patterns 2-4

- [ ] Read memory re-retrieval in both loops
- [ ] Read consensus verification in both loops (3 instances)
- [ ] Read step recording in both loops
- [ ] Add `refreshMemoryIfNeeded`, `buildConsensusParams`, `recordStepAndTransition`
- [ ] Verify compilation: `npx tsc --noEmit`

### Task 3: Wire into orchestrator — replace inline code

- [ ] Import new functions in orchestrator.ts
- [ ] Replace BG tool execution block with `executeAndTrackTools` call
- [ ] Replace Interactive tool execution block with `executeAndTrackTools` call
- [ ] Replace BG memory refresh with `refreshMemoryIfNeeded` call
- [ ] Replace Interactive memory refresh with `refreshMemoryIfNeeded` call
- [ ] Replace consensus verification instances with `buildConsensusParams`
- [ ] Replace step recording instances with `recordStepAndTransition`
- [ ] Verify TypeScript: `npx tsc --noEmit`
- [ ] Run tests: `npm test`
- [ ] Commit

### Task 4: Unit tests

- [ ] Create `src/agents/orchestrator-loop-shared.test.ts`
- [ ] Test `recordStepAndTransition`
- [ ] Test `buildConsensusParams`
- [ ] Run tests: `npx vitest run src/agents/orchestrator-loop-shared.test.ts`

### Task 5: Final verification

- [ ] Run full test suite
- [ ] TypeScript compilation
- [ ] Line count audit (expect orchestrator.ts ~5,500)
- [ ] Commit
