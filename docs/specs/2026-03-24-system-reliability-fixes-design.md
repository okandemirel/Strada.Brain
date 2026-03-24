# System Reliability Fixes — Design Specification

**Date**: 2026-03-24
**Status**: Approved
**Scope**: 6 root-cause fixes for task execution failures

## Problem Statement

Strada.Brain fails to complete user tasks due to a chain of interacting failures:
1. Provider errors are silently swallowed, producing empty responses
2. Single-provider chains have zero resilience
3. Execution state resets on every message (no continuity)
4. Completion review blocks tasks that can't run build verification
5. Sessions are lost on process restart
6. Kimi reasoning_content 400 errors aren't handled as fallback-eligible

## Fix #1: silentStream Must Propagate Errors

**File**: `src/agents/orchestrator.ts` (~line 3506)

When both streaming and fallback `provider.chat()` fail, `silentStream` currently returns an empty response object. The orchestrator interprets this as a normal "end_turn" with no content — the error is completely invisible to the user.

**Change**: Replace the empty-response return with a thrown error. The outer catch block at line 2697 already calls `classifyErrorMessage(error)` and sends it to the user, so no additional error handling is needed.

```typescript
// Remove:
return { text: "", toolCalls: [], stopReason: "end_turn", usage: { ... } };

// Replace with:
throw fallbackErr instanceof Error
  ? fallbackErr
  : new Error("Streaming and fallback chat both failed");
```

**Risk**: Low. The outer catch already handles this path.

## Fix #2: Auto-Append Fallback Providers to Explicit Chain

**File**: `src/core/bootstrap-providers.ts` (~line 47-79)

When `PROVIDER_CHAIN` is explicitly set (e.g., `kimi`), only those providers are used. If Kimi fails, the entire system fails even if other API keys (DeepSeek, Gemini) are configured.

**Change**: After building the explicit chain, auto-detect additional providers with valid credentials that are NOT already in the chain. Append them as silent fallbacks. Only providers that pass preflight are added.

```
Before: PROVIDER_CHAIN=kimi → chain(kimi)
After:  PROVIDER_CHAIN=kimi → chain(kimi→deepseek→gemini)  [if keys exist]
```

The user's priority order is preserved. Auto-detected providers are appended, not prepended. A log notice is emitted when fallback providers are added.

**Risk**: Low. Fallback providers only activate when all explicit providers fail.

## Fix #3: Carry Execution Journal Across Messages

**Files**: `src/agents/orchestrator-session-manager.ts`, `src/agents/orchestrator-autonomy-tracker.ts`, `src/agents/orchestrator.ts`

Each user message creates a fresh `AutonomyBundle` with an empty `ExecutionJournal`. This means "try again" or "continue" starts from zero — no knowledge of previous tool calls, findings, or plans.

**Change**:
1. Add `lastJournalSnapshot?: ExecutionJournalSnapshot` to the `Session` interface
2. After each message completes, save `executionJournal.snapshot()` to the session
3. In `createAutonomyBundle`, accept an optional `previousSnapshot` parameter
4. When present, seed the new `ExecutionJournal` with the previous snapshot's step results and touched files
5. `ExecutionJournal` gets a new `seedFromSnapshot(snapshot)` method

**Risk**: Medium. Journal data grows over time. Mitigated by only carrying the last snapshot (not cumulative history) and capping at 50 steps.

## Fix #4: Lenient Completion Review When Build Tools Unavailable

**File**: `src/agents/autonomy/completion-review.ts`

The completion review system requires build verification, conformance checks, and targeted reproduction. When these tools aren't available (e.g., Unity project without shell access), the reviewer blocks indefinitely.

**Change**:
1. Add a `buildToolsAvailable` flag to `CompletionReviewEvidence`
2. Derive it from available tool names (check for `unity_compile`, `shell_execute`, `run_tests`, etc.)
3. When `buildToolsAvailable === false`:
   - Build verification check → `not_applicable`
   - Targeted reproduction check → `not_applicable`
   - Conformance check → best-effort (code analysis only)
4. Update `COMPLETION_REVIEW_SYSTEM_PROMPT` to include:
   > "When build/compile tools are unavailable, approve based on code analysis evidence alone. Do not require external build verification that cannot be performed in this environment."

**Risk**: Medium. Reduces verification rigor for non-buildable contexts. Acceptable because false-blocking is worse than lenient approval for interactive tasks.

## Fix #5: Persist Sessions to Disk

**File**: `src/agents/orchestrator-session-manager.ts`

Sessions exist only in `Map<string, Session>`. Process restart = total context loss.

**Change**:
1. Add `serializeSession(session)` and `deserializeSession(data)` methods
2. On every `persistSessionToMemory` call, also write serialized session to a JSON file at `{dataDir}/sessions/{chatId}.json`
3. In `getOrCreateSession`, if no in-memory session exists, attempt disk restore
4. Serialize only last 50 messages (prevent bloat)
5. Expire sessions older than 24 hours on restore
6. Include `lastJournalSnapshot` from Fix #3 in serialized data

**Data directory**: Use the existing AgentDB data directory (same location as SQLite database).

**Risk**: Low. Disk writes are non-blocking (fire-and-forget with error logging). Corrupt JSON files are silently ignored (fresh session created).

## Fix #6: Kimi reasoning_content Errors Are Fallback-Eligible

**File**: `src/agents/providers/fallback-chain.ts`

The `isNonRetryableRequestError` function may prevent fallback to other providers when Kimi throws a 400 about `reasoning_content`. This is a provider-specific issue — other providers don't need reasoning_content and would succeed.

**Change**: Add an early return in `isNonRetryableRequestError`:
```typescript
// reasoning_content errors are Kimi-specific; fallback providers won't have this issue
if (/reasoning_content/i.test(msg)) return false;
```

**Risk**: Very low. Only affects the specific reasoning_content error pattern.

## Files Modified

| File | Fix | Change Type |
|------|-----|-------------|
| `src/agents/orchestrator.ts` | #1, #3 | Error propagation, journal carry-over |
| `src/core/bootstrap-providers.ts` | #2 | Auto-fallback append |
| `src/agents/orchestrator-session-manager.ts` | #3, #5 | Session interface, disk persistence |
| `src/agents/orchestrator-autonomy-tracker.ts` | #3 | Accept previous snapshot |
| `src/agents/autonomy/completion-review.ts` | #4 | Lenient mode |
| `src/agents/providers/fallback-chain.ts` | #6 | reasoning_content exception |
| `src/agents/autonomy/index.ts` | #3 | Export ExecutionJournalSnapshot type |

## Testing Strategy

- Fix #1: Unit test — silentStream throws when both paths fail
- Fix #2: Unit test — bootstrap appends detected providers to explicit chain
- Fix #3: Unit test — journal seeded from previous snapshot retains steps
- Fix #4: Unit test — completion review approves when build tools unavailable
- Fix #5: Unit test — session round-trips through serialize/deserialize
- Fix #6: Unit test — reasoning_content errors bypass non-retryable check
