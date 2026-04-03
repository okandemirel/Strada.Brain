# Provider Resilience & Loop Safety Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the 48-minute infinite failure loop observed when Kimi became unresponsive — add circuit breakers, health registry integration, and token estimation fixes.

**Architecture:** Three-layer defense: (1) `silentStream` records failures in `ProviderHealthRegistry` so cooldowns activate, (2) a `consecutiveProviderFailures` counter in the PAOR loop aborts after 3 consecutive dead-provider cycles, (3) `estimateTokens` accounts for system prompt overhead so compaction triggers earlier. Each fix is independent and tested in isolation.

**Tech Stack:** TypeScript, Vitest, Node.js ESM

---

### Task 1: Provider Failure Circuit Breaker in PAOR Background Loop

**Files:**
- Modify: `src/agents/orchestrator.ts:2549-2560` (background loop init)
- Modify: `src/agents/orchestrator.ts:2610-2617` (after silentStream call)
- Modify: `src/agents/orchestrator.ts:3645-3655` (interactive loop — same pattern)
- Test: `src/agents/orchestrator.test.ts`

This is the most critical fix. Currently `consecutiveMaxTokens >= 3` aborts for max_tokens, but there is NO equivalent for provider failures. The synthetic empty response from `silentStream` (text: "", toolCalls: [], stopReason: "end_turn") enters `handleBgEndTurn` which returns `flow: "continue"`, creating an infinite loop.

- [ ] **Step 1: Write the failing test for background loop circuit breaker**

```typescript
// In orchestrator.test.ts — find the "runBackgroundTask" or "runWorkerTask" describe block
// Add near the existing "max_tokens on 3 consecutive calls" test

it("aborts after 3 consecutive provider failures (synthetic empty responses)", async () => {
  // Simulate silentStream returning synthetic empty responses
  // by making the provider always throw
  const error = new Error("This operation was aborted");
  mockProvider.chatStream.mockRejectedValue(error);
  mockProvider.chat.mockRejectedValue(error);

  const result = await orchestrator.runBackgroundTask(
    "test-chat",
    "identity-key",
    "Analyze the project structure",
    { signal: new AbortController().signal, onProgress: vi.fn() },
  );

  // Should abort with a provider-failure message, not hang forever
  expect(result.status).toBe("completed"); // graceful stop
  expect(result.text).toContain("provider");
  // Should NOT have made more than ~6 LLM attempts (3 stream + 3 fallback)
  expect(mockProvider.chatStream.mock.calls.length).toBeLessThanOrEqual(6);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/agents/orchestrator.test.ts -t "aborts after 3 consecutive provider failures" --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — the loop runs indefinitely (or times out) because there is no circuit breaker.

- [ ] **Step 3: Add consecutiveProviderFailures counter to background loop**

In `src/agents/orchestrator.ts`, at line ~2549 (next to `let consecutiveMaxTokens = 0;`):

```typescript
let consecutiveMaxTokens = 0;
let consecutiveProviderFailures = 0;
let maxTokensAbort = false;
```

Then after the `silentStream` / `provider.chat` call at line ~2611, detect the synthetic empty response:

```typescript
const response = canBgStream
  ? await this.silentStream(chatId, activePrompt, session, currentProvider, currentToolDefinitions)
  : await currentProvider.chat(
      activePrompt,
      session.messages,
      currentToolDefinitions,
      { signal },
    );

// Circuit breaker: detect synthetic empty responses from silentStream provider failures
if (response.text === "" && response.toolCalls.length === 0 && response.usage.totalTokens === 0) {
  consecutiveProviderFailures++;
  if (consecutiveProviderFailures >= 3) {
    logger.error("Provider failed on 3 consecutive calls — aborting to prevent infinite loop", {
      chatId,
      provider: currentAssignment.providerName,
      epoch: bgEpochCount,
      iteration: bgIteration,
    });
    return finish(
      "I was unable to complete this task because the AI provider is not responding. Please try again later or switch to a different provider.",
      "completed",
      "Provider failure circuit breaker triggered after 3 consecutive failures.",
    );
  }
  logger.warn("Provider returned synthetic empty response — possible failure", {
    chatId,
    consecutiveProviderFailures,
    provider: currentAssignment.providerName,
  });
  continue; // skip end-turn handler, go straight to next iteration
} else {
  consecutiveProviderFailures = 0;
}
```

Note: The `continue` after detection is critical — it prevents the synthetic empty response from entering `handleBgEndTurn` which would trigger synthesis (another dead LLM call) and loop recovery (more dead LLM calls).

- [ ] **Step 4: Apply the same pattern to the interactive loop**

In `src/agents/orchestrator.ts` at line ~3645 (interactive loop), add the same counter next to `let consecutiveMaxTokens = 0;`:

```typescript
let consecutiveMaxTokens = 0;
let consecutiveProviderFailures = 0;
```

And after the response is received (around line ~3720, after the `silentStream` call in the interactive path), add the same detection:

```typescript
if (response.text === "" && response.toolCalls.length === 0 && response.usage.totalTokens === 0) {
  consecutiveProviderFailures++;
  if (consecutiveProviderFailures >= 3) {
    logger.error("Provider failed on 3 consecutive calls — aborting interactive loop", {
      chatId,
      provider: currentAssignment.providerName,
    });
    break;
  }
  continue;
} else {
  consecutiveProviderFailures = 0;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/agents/orchestrator.test.ts -t "aborts after 3 consecutive provider failures" --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Run the full orchestrator test suite**

Run: `npx vitest run src/agents/orchestrator.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: All existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/agents/orchestrator.ts src/agents/orchestrator.test.ts
git commit -m "fix(orchestrator): add provider failure circuit breaker — abort after 3 consecutive dead-provider cycles

Prevents the 48-minute infinite loop observed when silentStream returns synthetic
empty responses due to unresponsive providers. Mirrors the existing
consecutiveMaxTokens abort pattern."
```

---

### Task 2: Integrate silentStream with ProviderHealthRegistry

**Files:**
- Modify: `src/agents/orchestrator.ts:4365-4422` (silentStream method)
- Test: `src/agents/orchestrator.test.ts`

Currently `silentStream` calls `provider.chat()` directly — not through `FallbackChainProvider.tryWithFallback` — so `ProviderHealthRegistry.recordFailure()` is never called. The provider stays "healthy" and the next iteration hammers it again with no cooldown.

- [ ] **Step 1: Write the failing test**

```typescript
it("silentStream records provider failure in ProviderHealthRegistry", async () => {
  const { ProviderHealthRegistry } = await import("../providers/provider-health.js");
  ProviderHealthRegistry.resetInstance();
  const health = ProviderHealthRegistry.getInstance();

  // Make streaming and fallback both fail
  mockProvider.chatStream.mockRejectedValue(new Error("stream timeout"));
  mockProvider.chat.mockRejectedValue(new Error("This operation was aborted"));
  mockProvider.name = "test-provider";

  // Call silentStream (it's private, so call through runBackgroundTask with 1 iteration)
  // ... or extract the test via a minimal orchestrator setup
  // The key assertion:
  const entry = health.getEntry("test-provider");
  expect(entry?.consecutiveFailures).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/orchestrator.test.ts -t "silentStream records provider failure" --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — health registry has no entry because `recordFailure` is never called.

- [ ] **Step 3: Add health registry calls to silentStream**

In `src/agents/orchestrator.ts`, modify the `silentStream` method:

```typescript
private readonly silentStream = async (
  chatId: string,
  systemPrompt: string,
  session: Session,
  provider: IAIProvider,
  toolDefinitions: Array<{
    name: string;
    description: string;
    input_schema: import("../types/index.js").JsonObject;
  }>,
): Promise<ProviderResponse> => {
  const timeoutGuard = createStreamingProgressTimeout(
    this.streamInitialTimeoutMs,
    this.streamStallTimeoutMs,
  );
  try {
    const streamPromise = (provider as IStreamingProvider).chatStream(
      systemPrompt,
      session.messages,
      toolDefinitions,
      () => {
        timeoutGuard.markProgress();
      },
    );
    const response = await Promise.race([streamPromise, timeoutGuard.timeoutPromise]);
    timeoutGuard.clear();
    ProviderHealthRegistry.getInstance().recordSuccess(provider.name);
    return response;
  } catch (err) {
    timeoutGuard.clear();
    const errMsg = err instanceof Error ? err.message : "Unknown streaming error";
    getLogger().error("Silent stream error", { chatId, error: errMsg });
    try {
      // Fallback to non-streaming with a timeout so it doesn't hang
      // indefinitely if the provider is genuinely unresponsive.
      const fallbackResponse = await provider.chat(systemPrompt, session.messages, toolDefinitions, {
        signal: AbortSignal.timeout(this.streamInitialTimeoutMs),
      });
      ProviderHealthRegistry.getInstance().recordSuccess(provider.name);
      return fallbackResponse;
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      getLogger().error("Silent stream fallback chat failed", { chatId, error: fallbackMsg });
      // Record failure in health registry so cooldown kicks in
      ProviderHealthRegistry.getInstance().recordFailure(provider.name, fallbackMsg);
      // Surface the failure to the agent so it can adapt its approach
      session.messages.push({
        role: "user",
        content: `[System: The AI provider (${provider.name}) failed to respond. Error: ${fallbackMsg}. You may need to: simplify your current step, reduce the number of tool calls, or skip non-critical analysis. Adapt your approach and continue.]`,
      } as ConversationMessage);
      // Return a synthetic empty response so the PAOR loop can continue
      // with the agent's awareness of the failure.
      return {
        text: "",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  }
};
```

Add the import at the top of orchestrator.ts if not already present:

```typescript
import { ProviderHealthRegistry } from "./providers/provider-health.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/orchestrator.test.ts -t "silentStream records provider failure" --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Run the full orchestrator test suite**

Run: `npx vitest run src/agents/orchestrator.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts src/agents/orchestrator.test.ts
git commit -m "fix(orchestrator): integrate silentStream with ProviderHealthRegistry

silentStream previously called provider.chat() directly, bypassing the
FallbackChainProvider and ProviderHealthRegistry. Now records both successes
and failures so cooldown/degraded states activate correctly."
```

---

### Task 3: Fix AbortSignal Retry Cascade in fetchWithRetry

**Files:**
- Modify: `src/common/fetch-with-retry.ts:54-67`
- Test: `src/common/fetch-with-retry.test.ts`

When `AbortSignal.timeout()` fires, the same expired signal is forwarded to all 3 retry attempts via `opts.signal`. The `sleep(delay, opts.signal)` at line 102 immediately rejects because the signal is already aborted. All retries fail instantly — the retry mechanism is completely ineffective for abort scenarios.

- [ ] **Step 1: Write the failing test**

```typescript
it("does not cascade abort to retry sleep when AbortSignal times out", async () => {
  // Create a signal that aborts after 50ms
  const signal = AbortSignal.timeout(50);
  const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));

  // Without the fix, all retries fire instantly because sleep rejects on aborted signal
  const startTime = Date.now();
  await expect(
    fetchWithRetry("http://test.invalid/api", { method: "GET" }, {
      callerName: "test",
      maxRetries: 2,
      baseDelayMs: 200,
      signal,
    }),
  ).rejects.toThrow();
  const elapsed = Date.now() - startTime;

  // With the fix, retries should use their own delay without the expired signal
  // At minimum, 1 retry with 200ms base delay should take >150ms
  // Without fix: all retries complete in <10ms because sleep(delay, abortedSignal) rejects instantly
  expect(elapsed).toBeGreaterThan(100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/common/fetch-with-retry.test.ts -t "does not cascade abort" --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — elapsed time is <10ms because all retries abort instantly.

- [ ] **Step 3: Don't pass the expired signal to retry sleep**

In `src/common/fetch-with-retry.ts`, modify the sleep call at line ~67 and ~102. The fix is to not pass the signal to `sleep` when the error was a network error (not a server response). The signal should only abort the `fetch()` call itself, not the retry delay:

```typescript
    } catch (err) {
      // If the signal itself caused the abort, don't retry — propagate immediately
      if (opts.signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (attempt === maxRetries) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      logger.debug(`${callerName} network error, retrying`, {
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't pass signal to sleep — the signal may be expired from the fetch timeout
      // but we still want the retry delay to complete normally
      await sleep(baseDelayMs * Math.pow(2, attempt) + Math.random() * 100);
      continue;
    }
```

And similarly for the 429/5xx retry sleep at line ~102:

```typescript
    // Don't pass signal to retry sleep — same reason as above
    await sleep(delay);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/common/fetch-with-retry.test.ts -t "does not cascade abort" --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Run the full fetch-with-retry test suite**

Run: `npx vitest run src/common/fetch-with-retry.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/common/fetch-with-retry.ts src/common/fetch-with-retry.test.ts
git commit -m "fix(fetch-with-retry): prevent AbortSignal cascade to retry sleep

When AbortSignal.timeout() fires during fetch(), the same expired signal was
forwarded to sleep() in retry loops, causing all retries to abort instantly.
Now: if the signal caused the abort, propagate immediately; otherwise retry
without passing the expired signal to sleep."
```

---

### Task 4: Account for System Prompt in Token Estimation

**Files:**
- Modify: `src/agents/orchestrator.ts:4331-4357` (maybeCompactSession)
- Modify: `src/agents/session-compaction.ts:103-109` (estimateTokens — add optional systemPromptChars param)
- Test: `src/agents/session-compaction.test.ts`

The system prompt (PAOR instructions, SOUL.md, framework knowledge, tool definitions) is passed separately to each LLM call and NOT counted in `estimateTokens`. This means the real context usage is 10-20K tokens higher than estimated, and compaction triggers too late.

- [ ] **Step 1: Write the failing test**

```typescript
it("estimateTokens includes system prompt overhead when provided", () => {
  const messages: CompactableMessage[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ];
  const withoutOverhead = estimateTokens(messages);
  const withOverhead = estimateTokens(messages, 40000); // 40K chars system prompt = ~10K tokens
  expect(withOverhead).toBeGreaterThan(withoutOverhead);
  expect(withOverhead - withoutOverhead).toBe(Math.ceil(40000 / 4));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/session-compaction.test.ts -t "includes system prompt overhead" --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `estimateTokens` doesn't accept a second parameter.

- [ ] **Step 3: Add systemPromptChars parameter to estimateTokens**

In `src/agents/session-compaction.ts`:

```typescript
/**
 * Estimate tokens for a message array.
 * Uses a direct chars/4 heuristic rather than allocating a synthetic string —
 * this runs on every PAOR iteration so memory efficiency matters.
 *
 * @param systemPromptChars - Optional character count of the system prompt
 *   (not included in messages). Accounts for the gap where compaction doesn't
 *   see the system prompt but it still consumes context window space.
 */
export function estimateTokens(
  messages: readonly CompactableMessage[],
  systemPromptChars = 0,
): number {
  if (messages.length === 0 && systemPromptChars === 0) return 0;
  let totalChars = systemPromptChars;
  for (const msg of messages) totalChars += messageChars(msg);
  if (totalChars === 0) return 0;
  return Math.ceil(totalChars / 4);
}
```

- [ ] **Step 4: Pass system prompt length from maybeCompactSession**

In `src/agents/orchestrator.ts`, modify `maybeCompactSession` to accept and forward the system prompt:

```typescript
private maybeCompactSession(
  session: Session,
  providerName: string,
  modelId?: string,
  systemPrompt?: string,
): void {
  const ctxWindow =
    this.providerManager.getProviderCapabilities?.(providerName, modelId)?.contextWindow
    ?? DEFAULT_CONTEXT_WINDOW;
  const msgs = session.messages as unknown as CompactableMessage[];
  const tokenEstimate = estimateTokens(msgs, systemPrompt?.length ?? 0);
  if (tokenEstimate <= ctxWindow * COMPACTION_TRIGGER_RATIO) return;
  const result = compactSession(msgs, {
    maxTokens: Math.floor(ctxWindow * COMPACTION_TARGET_RATIO),
    preserveRecent: 4,
    maxGroups: 20,
  });
  if (result.compacted) {
    session.messages = result.messages as unknown as ConversationMessage[];
    getLogger().info("Session compacted", {
      stage: result.stageApplied,
      originalTokens: result.originalTokens,
      finalTokens: result.finalTokens,
      systemPromptEstimate: systemPrompt ? Math.ceil(systemPrompt.length / 4) : 0,
    });
  }
}
```

Then update the two call sites to pass `systemPrompt`:

Background loop (line ~2601):
```typescript
this.maybeCompactSession(session, currentAssignment.providerName, currentAssignment.modelId, activePrompt);
```

Interactive loop (line ~3667):
```typescript
this.maybeCompactSession(session, currentAssignment.providerName, currentAssignment.modelId, activePrompt);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/agents/session-compaction.test.ts -t "includes system prompt overhead" --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Run the full compaction test suite**

Run: `npx vitest run src/agents/session-compaction.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 7: Run orchestrator tests to verify call-site changes**

Run: `npx vitest run src/agents/orchestrator.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass (maybeCompactSession's new optional param doesn't break existing calls).

- [ ] **Step 8: Commit**

```bash
git add src/agents/session-compaction.ts src/agents/session-compaction.test.ts src/agents/orchestrator.ts
git commit -m "fix(compaction): account for system prompt in token estimation

estimateTokens now accepts an optional systemPromptChars parameter.
maybeCompactSession forwards the system prompt length so compaction triggers
earlier — closes the 10-20K token gap where system prompt consumed context
window space invisibly."
```

---

### Task 5: Increase Delegation Analysis Timeout

**Files:**
- Modify: `src/agents/multi/delegation/delegation-types.ts:129`
- Test: `src/agents/multi/delegation/delegation-manager.test.ts`

The `analysis` delegation type has a 90-second timeout, but Kimi calls take 30-60 seconds each. A single slow LLM response exhausts the entire delegation budget.

- [ ] **Step 1: Write the failing test**

```typescript
it("analysis delegation type has at least 180s timeout", () => {
  const analysisType = DEFAULT_DELEGATION_TYPES.find((t) => t.name === "analysis");
  expect(analysisType).toBeDefined();
  expect(analysisType!.timeoutMs).toBeGreaterThanOrEqual(180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/multi/delegation/delegation-manager.test.ts -t "analysis delegation type has at least 180s" --reporter=verbose 2>&1 | tail -10`
Expected: FAIL — current value is 90000.

- [ ] **Step 3: Update the timeout**

In `src/agents/multi/delegation/delegation-types.ts`, line 129:

```typescript
{ name: "analysis", tier: "standard", timeoutMs: 180_000, maxIterations: 15 },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/multi/delegation/delegation-manager.test.ts -t "analysis delegation type has at least 180s" --reporter=verbose 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Run the full delegation test suite**

Run: `npx vitest run src/agents/multi/delegation/ --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/multi/delegation/delegation-types.ts src/agents/multi/delegation/delegation-manager.test.ts
git commit -m "fix(delegation): increase analysis timeout from 90s to 180s

A single Kimi call takes 30-60s. The 90s budget was too aggressive for
analysis delegations that may need 2-3 LLM calls to complete."
```

---

### Task 6: Fix totalMessages Counter for Background Tasks

**Files:**
- Modify: `src/agents/orchestrator.ts` (add recordMessage call in background path)
- Modify: `src/dashboard/metrics.ts:64` (no code change, just for reference)
- Test: `src/dashboard/metrics.test.ts` (or orchestrator.test.ts)

`recordMessage()` is only called in the interactive `handleMessage` path. Background tasks (which handle all web channel messages) never increment the counter.

- [ ] **Step 1: Write the failing test**

```typescript
it("records message count for background tasks", async () => {
  const metrics = orchestrator.getMetrics(); // or however metrics are accessed
  const before = metrics.getSnapshot().totalMessages;

  await orchestrator.runBackgroundTask(
    "test-chat",
    "identity-key",
    "Hello",
    { signal: new AbortController().signal, onProgress: vi.fn() },
  );

  const after = metrics.getSnapshot().totalMessages;
  expect(after).toBe(before + 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/orchestrator.test.ts -t "records message count for background" --reporter=verbose 2>&1 | tail -10`
Expected: FAIL — totalMessages is unchanged.

- [ ] **Step 3: Add recordMessage call to background task entry**

In `src/agents/orchestrator.ts`, find `runBackgroundTask` (or `runWorkerTask`) entry point. Add near the top:

```typescript
this.metrics?.recordMessage();
```

This should go right after the task begins executing, before the PAOR loop starts.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/orchestrator.test.ts -t "records message count for background" --reporter=verbose 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator.ts src/agents/orchestrator.test.ts
git commit -m "fix(metrics): count background task messages in totalMessages

recordMessage() was only called in the interactive handleMessage path.
Web channel messages routed through the task system were never counted."
```

---

### Task 7: Final Integration Verification

**Files:**
- No code changes — verification only

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -50`
Expected: All tests pass.

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: No type errors.

- [ ] **Step 3: Verify the fix scenario manually**

To verify the circuit breaker works, check that:
1. `consecutiveProviderFailures` counter exists in both loops
2. `ProviderHealthRegistry.recordFailure` is called from silentStream catch block
3. `ProviderHealthRegistry.recordSuccess` is called on silentStream success
4. `estimateTokens` accepts optional `systemPromptChars`
5. `maybeCompactSession` forwards `systemPrompt` to `estimateTokens`
6. `fetchWithRetry` doesn't pass expired signal to retry sleep
7. Analysis delegation timeout is 180_000ms
8. Background task calls `recordMessage()`

- [ ] **Step 4: Run lint**

Run: `npx eslint src/agents/orchestrator.ts src/agents/session-compaction.ts src/common/fetch-with-retry.ts src/agents/multi/delegation/delegation-types.ts --no-warn-ignored 2>&1 | tail -10`
Expected: No errors.
