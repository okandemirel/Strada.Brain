# Intelligent Provider Resilience Design

## Problem

When a provider becomes intermittently unresponsive, the system wastes tokens and time:
- **Single provider:** Hammers the same dead provider with no backoff, burns 3.9M+ tokens over 1+ hours
- **Multi provider:** `silentStream` bypasses `FallbackChainProvider`, so failover never happens for streaming calls
- **No user awareness:** User waits in silence with no status updates
- **No adaptive behavior:** System doesn't learn from failure patterns or adjust strategy

## Design Decisions (from brainstorm)

1. Route `silentStream` through `FallbackChainProvider` (already has `chatStream` with `tryWithFallback`)
2. Reorder provider chain per iteration via `ProviderRouter.resolve()` based on task type
3. Sliding window failure rate + exponential backoff + time awareness for single-provider
4. Progressive disclosure + interactive choice for user notification
5. Adaptive cooldown + background health probe for multi-provider recovery
6. All user-facing messages respect session language (`progressLanguage`)

## Architecture

### Component 1: IterationHealthTracker

New class in `src/agents/iteration-health-tracker.ts`. Tracks per-task provider health signals across PAOR iterations.

**State:**
- `failureWindow: Array<{ timestamp: number; provider: string }>` — sliding window of recent failures
- `consecutiveFailures: number` — resets on success
- `totalFailures: number` — never resets (for time-based awareness)
- `taskStartedAt: number` — task start timestamp
- `lastFailureAt: number` — for backoff calculation
- `backoffMs: number` — current backoff delay, escalates on failure, resets on success

**Methods:**
- `recordFailure(provider: string): FailureAction` — records failure, returns recommended action
- `recordSuccess(): void` — resets consecutive counter and backoff
- `getBackoffMs(): number` — exponential: 10s → 30s → 60s → 120s (capped)
- `getFailureRate(windowMs: number): number` — failures per total calls in sliding window
- `shouldAbort(): boolean` — true when failure rate > 60% in last 10 calls AND consecutiveFailures >= 3
- `getTaskDurationMs(): number` — for time-based awareness
- `getStatusLevel(): "ok" | "degraded" | "critical"` — for progressive disclosure

**FailureAction type:**
```typescript
type FailureAction =
  | { kind: "retry"; backoffMs: number }           // Wait then retry
  | { kind: "ask_user"; backoffMs: number }         // Escalate to user
  | { kind: "abort"; reason: string }               // Give up
```

**Decision logic:**
- consecutiveFailures < 3 AND failureRate < 40%: `{ kind: "retry", backoffMs }`
- consecutiveFailures >= 3 OR failureRate >= 40%: `{ kind: "ask_user", backoffMs }`
- failureRate >= 60% AND task duration > 10min: `{ kind: "abort", reason }`

### Component 2: silentStream → FallbackChainProvider

**Current flow:**
```
prepareIteration → currentAssignment.provider (raw) → silentStream(raw) → raw.chatStream()
```

**New flow:**
```
prepareIteration → currentAssignment.provider (primary)
                 → buildResilientProvider(primary, otherHealthy)
                 → silentStream(resilientChain) → chain.chatStream()
                      ├─ primary fails → next healthy provider ✓
                      └─ all fail → silentStream catch → IterationHealthTracker
```

**Implementation:** In the background and interactive loops, where `silentStream` is called, wrap `currentProvider` in a FallbackChainProvider if multiple providers exist. If only one provider, pass it directly (same as now).

Key change in orchestrator.ts background loop (around the `silentStream` call):
```typescript
const resilientProvider = this.providerManager.buildStreamingFallbackChain?.(
  currentProvider,
  currentAssignment.providerName,
) ?? currentProvider;

const response = canBgStream
  ? await this.silentStream(chatId, activePrompt, session, resilientProvider, currentToolDefinitions)
  : await resilientProvider.chat(activePrompt, session.messages, currentToolDefinitions, { signal });
```

### Component 3: Chain Reordering via ProviderRouter

Each iteration, before the LLM call:
1. Get task classification from `executionStrategy.task`
2. Call `ProviderRouter.resolve(taskClassification, agentPhase)` for optimal provider
3. Build FallbackChainProvider with resolved provider first, others as fallback

**New method on ProviderManager:**
```typescript
buildStreamingFallbackChain(
  primaryProvider: IAIProvider,
  primaryName: string,
): FallbackChainProvider | null
```

Returns null if only one provider exists (single-provider scenario).

### Component 4: Exponential Backoff in PAOR Loop

When `IterationHealthTracker.recordFailure()` returns `{ kind: "retry", backoffMs }`, the PAOR loop waits before the next iteration:

```typescript
const failureAction = iterationHealth.recordFailure(currentAssignment.providerName);
if (failureAction.kind === "retry" && failureAction.backoffMs > 0) {
  logger.info("Backing off before retry", { backoffMs: failureAction.backoffMs, provider });
  await sleep(failureAction.backoffMs);
}
```

Backoff schedule: 0 → 10s → 30s → 60s → 120s (capped).
Resets to 0 on any successful response.

### Component 5: Progressive Disclosure + Interactive Choice

Uses existing `ProgressReporter` and `emitProgress` callback for real-time status updates.

**Status levels based on IterationHealthTracker.getStatusLevel():**

| Level | Trigger | User sees | Language |
|-------|---------|-----------|----------|
| ok | No failures | Nothing | — |
| degraded | 1-2 consecutive fails | Light status: "Provider is experiencing delays, retrying..." | progressLanguage |
| critical | 3+ consecutive OR failureRate > 40% | Warning: "Provider is not responding. Waiting {backoff}s before retry ({n}/{max})" | progressLanguage |
| ask_user | failureRate > 40% AND duration > 5min | Interactive: "Provider has been unreliable. Continue waiting / Switch provider / Cancel task" | progressLanguage |
| abort | failureRate > 60% AND consecutiveFailures >= 3 | Final: "Unable to complete — provider not responding. Try again later or use a different provider." | progressLanguage |

**Interactive choice** uses existing `ask_user` / confirmation mechanism from the channel interface.

### Component 6: Adaptive Cooldown in ProviderHealthRegistry

Modify `recordFailure` to escalate cooldown on repeated failures to the same provider:

**Current:** Fixed cooldown (degraded: 30s, down: 2min).
**New:** Cooldown escalates on repeated down cycles:

```typescript
// In ProviderHealthRegistry.recordFailure():
if (failures >= downThreshold) {
  const downEpisodes = this.getDownEpisodeCount(normalized);
  const escalatedCooldown = Math.min(
    this.config.downCooldownMs * Math.pow(2, downEpisodes),
    MAX_ADAPTIVE_COOLDOWN_MS,  // cap at 10 minutes
  );
  cooldownUntil = now + escalatedCooldown;
}
```

Reset `downEpisodes` to 0 when `recordSuccess` is called.

### Component 7: Background Health Probe

Before re-routing tasks to a provider that was previously down, verify it's actually healthy:

**New method on ProviderManager:**
```typescript
async probeProviderHealth(providerName: string): Promise<boolean>
```

- Sends a minimal `chat` call: system prompt "Reply with OK", single user message "health check"
- Timeout: 15 seconds
- On success: calls `recordSuccess`, returns true
- On failure: extends cooldown, returns false
- Cost: ~50 tokens per probe (minimal)

**When probed:** Only when a provider transitions from `down` → cooldown expired (auto-recovery). The first real task doesn't go to the provider until the probe passes.

Integration point: `FallbackChainProvider.tryWithFallback` checks `isAvailable()`. Add `probeIfRecovering()` call before attempting a recently-down provider.

### Component 8: Language-Aware Messages

All user-facing messages go through a message resolver that uses `progressLanguage`:

```typescript
// In src/agents/resilience-messages.ts
export function getResilienceMessage(
  key: "provider_slow" | "provider_failing" | "provider_ask_user" | "provider_abort",
  language: string,
  params?: Record<string, string | number>,
): string
```

Built-in translations for the 8 supported languages (EN, TR, JA, KO, ZH, DE, ES, FR).

## File Structure

| File | Responsibility |
|------|---------------|
| `src/agents/iteration-health-tracker.ts` | NEW — Per-task failure tracking, backoff, sliding window |
| `src/agents/iteration-health-tracker.test.ts` | NEW — Tests |
| `src/agents/resilience-messages.ts` | NEW — Language-aware status messages |
| `src/agents/resilience-messages.test.ts` | NEW — Tests |
| `src/agents/orchestrator.ts` | MODIFY — Use resilient chain in silentStream, integrate IterationHealthTracker, backoff, progressive disclosure |
| `src/agents/providers/fallback-chain.ts` | MODIFY — Add probeIfRecovering before attempting recovered providers |
| `src/agents/providers/provider-health.ts` | MODIFY — Adaptive cooldown with escalation, down episode tracking |
| `src/agents/providers/provider-manager.ts` | MODIFY — Add buildStreamingFallbackChain(), probeProviderHealth() |
| `src/agents/orchestrator-runtime-utils.ts` | MODIFY — Update checkProviderFailureCircuitBreaker to use IterationHealthTracker |

## What This Solves

**Single provider (Kimi only):**
- Fail #1: Silent, retry immediately
- Fail #2: Light status to user, 10s backoff
- Fail #3: Warning + 30s backoff
- Fail #4+: "Provider unreliable" + interactive choice (continue/cancel)
- Abort threshold: 60% failure rate + 3 consecutive + >10min duration
- Token savings: backoff reduces wasted calls from ~60/hour to ~15/hour

**Multi provider (Kimi + OpenAI):**
- Kimi fails → FallbackChainProvider automatically tries OpenAI
- Zero user-visible impact
- Kimi gets adaptive cooldown (30s → 2min → 5min)
- Background probe verifies Kimi before re-routing tasks to it
- ProviderRouter ensures the best provider for each task type is primary

**Both scenarios:**
- Real-time status in user's language
- No more silent 1+ hour waits
- Health registry cooldowns actually work (silentStream integrated)
- Task-aware decision making (duration, failure rate, not just consecutive count)

## Non-Goals

- Provider auto-discovery (out of scope — providers are configured)
- Cost-based routing changes (ProviderRouter already handles this)
- Token estimation improvements (separate concern, already fixed in this branch)
- Changes to the PAOR loop structure itself
