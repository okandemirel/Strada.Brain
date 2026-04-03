# Intelligent Provider Resilience — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace restriction-based circuit breaker with an intelligent resilience system that adapts to failure patterns, provides user feedback, and supports both single and multi-provider scenarios.

**Architecture:** Three new components (IterationHealthTracker, resilience messages, orchestrator integration) plus one key wiring change (silentStream through FallbackChainProvider). Each task is independently testable.

**Tech Stack:** TypeScript, Vitest, Node.js ESM

---

### Task 1: IterationHealthTracker — Core Failure Tracking

**Files:**
- Create: `src/agents/iteration-health-tracker.ts`
- Create: `src/agents/iteration-health-tracker.test.ts`

Per-task health tracker with sliding window failure rate, exponential backoff, and status levels.

- [ ] **Step 1: Write failing tests for IterationHealthTracker**

```typescript
// src/agents/iteration-health-tracker.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { IterationHealthTracker } from "./iteration-health-tracker.js";

describe("IterationHealthTracker", () => {
  let tracker: IterationHealthTracker;

  beforeEach(() => {
    tracker = new IterationHealthTracker();
  });

  it("starts with ok status and zero backoff", () => {
    expect(tracker.getStatusLevel()).toBe("ok");
    expect(tracker.getBackoffMs()).toBe(0);
    expect(tracker.shouldAbort()).toBe(false);
  });

  it("returns retry action with escalating backoff on failures", () => {
    const r1 = tracker.recordFailure("kimi");
    expect(r1.kind).toBe("retry");
    expect(r1.backoffMs).toBe(0); // first failure: no backoff

    const r2 = tracker.recordFailure("kimi");
    expect(r2.kind).toBe("retry");
    expect(r2.backoffMs).toBe(10_000); // second: 10s

    const r3 = tracker.recordFailure("kimi");
    expect(r3.kind).toBe("ask_user");
    expect(r3.backoffMs).toBe(30_000); // third: 30s, escalates to ask_user
  });

  it("resets backoff and consecutive count on success", () => {
    tracker.recordFailure("kimi");
    tracker.recordFailure("kimi");
    tracker.recordSuccess();
    expect(tracker.getStatusLevel()).toBe("ok");
    expect(tracker.getBackoffMs()).toBe(0);
    const r = tracker.recordFailure("kimi");
    expect(r.backoffMs).toBe(0); // reset — first failure again
  });

  it("returns abort when failure rate exceeds threshold", () => {
    // 7 failures, 3 successes = 70% failure rate
    for (let i = 0; i < 7; i++) tracker.recordFailure("kimi");
    for (let i = 0; i < 3; i++) tracker.recordSuccess();
    // Need 3 more consecutive + high rate
    tracker.recordFailure("kimi");
    tracker.recordFailure("kimi");
    tracker.recordFailure("kimi");
    expect(tracker.shouldAbort()).toBe(true);
  });

  it("tracks status levels: ok → degraded → critical", () => {
    expect(tracker.getStatusLevel()).toBe("ok");
    tracker.recordFailure("kimi");
    expect(tracker.getStatusLevel()).toBe("degraded");
    tracker.recordFailure("kimi");
    expect(tracker.getStatusLevel()).toBe("degraded");
    tracker.recordFailure("kimi");
    expect(tracker.getStatusLevel()).toBe("critical");
  });

  it("getFailureRate returns correct sliding window rate", () => {
    tracker.recordSuccess();
    tracker.recordFailure("kimi");
    tracker.recordSuccess();
    tracker.recordFailure("kimi");
    expect(tracker.getFailureRate()).toBeCloseTo(0.5, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agents/iteration-health-tracker.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement IterationHealthTracker**

```typescript
// src/agents/iteration-health-tracker.ts

/** Backoff schedule: 0s, 10s, 30s, 60s, 120s (capped) */
const BACKOFF_SCHEDULE_MS = [0, 10_000, 30_000, 60_000, 120_000];
const ABORT_FAILURE_RATE = 0.6;
const ASK_USER_CONSECUTIVE = 3;
const ABORT_CONSECUTIVE = 3;
const SLIDING_WINDOW_SIZE = 10;

export type FailureAction =
  | { kind: "retry"; backoffMs: number }
  | { kind: "ask_user"; backoffMs: number }
  | { kind: "abort"; reason: string };

export type StatusLevel = "ok" | "degraded" | "critical";

export class IterationHealthTracker {
  private results: Array<{ success: boolean; timestamp: number; provider?: string }> = [];
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private backoffIndex = 0;
  private readonly taskStartedAt = Date.now();

  recordFailure(provider: string): FailureAction {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.results.push({ success: false, timestamp: Date.now(), provider });

    const backoffMs = BACKOFF_SCHEDULE_MS[Math.min(this.backoffIndex, BACKOFF_SCHEDULE_MS.length - 1)]!;
    this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_SCHEDULE_MS.length - 1);

    if (this.shouldAbort()) {
      return { kind: "abort", reason: `Provider ${provider} failure rate ${(this.getFailureRate() * 100).toFixed(0)}% with ${this.consecutiveFailures} consecutive failures` };
    }

    if (this.consecutiveFailures >= ASK_USER_CONSECUTIVE || this.getFailureRate() >= 0.4) {
      return { kind: "ask_user", backoffMs };
    }

    return { kind: "retry", backoffMs };
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.backoffIndex = 0;
    this.results.push({ success: true, timestamp: Date.now() });
  }

  getBackoffMs(): number {
    if (this.consecutiveFailures === 0) return 0;
    return BACKOFF_SCHEDULE_MS[Math.min(this.backoffIndex, BACKOFF_SCHEDULE_MS.length - 1)]!;
  }

  getFailureRate(): number {
    const recent = this.results.slice(-SLIDING_WINDOW_SIZE);
    if (recent.length === 0) return 0;
    return recent.filter(r => !r.success).length / recent.length;
  }

  shouldAbort(): boolean {
    return this.getFailureRate() >= ABORT_FAILURE_RATE && this.consecutiveFailures >= ABORT_CONSECUTIVE;
  }

  getStatusLevel(): StatusLevel {
    if (this.consecutiveFailures === 0) return "ok";
    if (this.consecutiveFailures < ASK_USER_CONSECUTIVE) return "degraded";
    return "critical";
  }

  getTaskDurationMs(): number {
    return Date.now() - this.taskStartedAt;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getTotalFailures(): number {
    return this.totalFailures;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agents/iteration-health-tracker.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/iteration-health-tracker.ts src/agents/iteration-health-tracker.test.ts
git commit -m "feat(resilience): add IterationHealthTracker with sliding window and backoff"
```

---

### Task 2: Language-Aware Resilience Messages

**Files:**
- Create: `src/agents/resilience-messages.ts`
- Create: `src/agents/resilience-messages.test.ts`

Localized status messages for 8 languages (EN, TR, JA, KO, ZH, DE, ES, FR).

- [ ] **Step 1: Write failing tests**

```typescript
// src/agents/resilience-messages.test.ts
import { describe, it, expect } from "vitest";
import { getResilienceMessage } from "./resilience-messages.js";

describe("getResilienceMessage", () => {
  it("returns English message by default", () => {
    const msg = getResilienceMessage("provider_slow", "en");
    expect(msg).toContain("experiencing delays");
  });

  it("returns Turkish message for TR", () => {
    const msg = getResilienceMessage("provider_slow", "tr");
    expect(msg).toContain("gecikme");
  });

  it("interpolates parameters", () => {
    const msg = getResilienceMessage("provider_backoff", "en", { seconds: 30, attempt: 2, max: 5 });
    expect(msg).toContain("30");
  });

  it("falls back to English for unknown language", () => {
    const msg = getResilienceMessage("provider_slow", "xx");
    expect(msg).toContain("experiencing delays");
  });

  it("supports all 4 message keys", () => {
    for (const key of ["provider_slow", "provider_failing", "provider_ask_user", "provider_abort"] as const) {
      expect(getResilienceMessage(key, "en")).toBeTruthy();
      expect(getResilienceMessage(key, "tr")).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement resilience-messages.ts**

```typescript
// src/agents/resilience-messages.ts

type MessageKey = "provider_slow" | "provider_failing" | "provider_backoff" | "provider_ask_user" | "provider_abort";

const MESSAGES: Record<string, Record<MessageKey, string>> = {
  en: {
    provider_slow: "The AI provider is experiencing delays. Retrying...",
    provider_failing: "The AI provider is not responding. Waiting {seconds}s before retry ({attempt}/{max}).",
    provider_backoff: "Provider unreliable — backing off for {seconds}s before next attempt ({attempt}/{max}).",
    provider_ask_user: "The AI provider has been unreliable for this task. You can continue waiting, switch to a different provider, or cancel.",
    provider_abort: "Unable to complete this task — the AI provider is not responding. Please try again later or switch to a different provider.",
  },
  tr: {
    provider_slow: "Yapay zeka sağlayıcısı gecikme yaşıyor. Yeniden deneniyor...",
    provider_failing: "Yapay zeka sağlayıcısı yanıt vermiyor. {seconds}s sonra tekrar denenecek ({attempt}/{max}).",
    provider_backoff: "Sağlayıcı güvenilir değil — sonraki deneme için {seconds}s bekleniyor ({attempt}/{max}).",
    provider_ask_user: "Yapay zeka sağlayıcısı bu görev için güvenilir çalışmıyor. Beklemeye devam edebilir, farklı bir sağlayıcıya geçebilir veya görevi iptal edebilirsiniz.",
    provider_abort: "Bu görev tamamlanamadı — yapay zeka sağlayıcısı yanıt vermiyor. Lütfen daha sonra tekrar deneyin veya farklı bir sağlayıcı kullanın.",
  },
  ja: {
    provider_slow: "AIプロバイダーに遅延が発生しています。再試行中...",
    provider_failing: "AIプロバイダーが応答していません。{seconds}秒後に再試行します ({attempt}/{max})。",
    provider_backoff: "プロバイダーが不安定です — 次の試行まで{seconds}秒待機中 ({attempt}/{max})。",
    provider_ask_user: "AIプロバイダーがこのタスクで不安定な状態が続いています。待機を続けるか、別のプロバイダーに切り替えるか、タスクをキャンセルできます。",
    provider_abort: "このタスクを完了できませんでした — AIプロバイダーが応答していません。後でもう一度お試しいただくか、別のプロバイダーをご利用ください。",
  },
  ko: {
    provider_slow: "AI 제공업체에서 지연이 발생하고 있습니다. 재시도 중...",
    provider_failing: "AI 제공업체가 응답하지 않습니다. {seconds}초 후 재시도합니다 ({attempt}/{max}).",
    provider_backoff: "제공업체가 불안정합니다 — 다음 시도까지 {seconds}초 대기 중 ({attempt}/{max}).",
    provider_ask_user: "AI 제공업체가 이 작업에 대해 불안정한 상태입니다. 계속 대기하거나, 다른 제공업체로 전환하거나, 작업을 취소할 수 있습니다.",
    provider_abort: "이 작업을 완료할 수 없습니다 — AI 제공업체가 응답하지 않습니다. 나중에 다시 시도하거나 다른 제공업체를 사용해 주세요.",
  },
  zh: {
    provider_slow: "AI提供商正在经历延迟。正在重试...",
    provider_failing: "AI提供商未响应。将在{seconds}秒后重试 ({attempt}/{max})。",
    provider_backoff: "提供商不稳定 — 等待{seconds}秒后进行下一次尝试 ({attempt}/{max})。",
    provider_ask_user: "AI提供商在此任务中一直不稳定。您可以继续等待、切换到其他提供商或取消任务。",
    provider_abort: "无法完成此任务 — AI提供商未响应。请稍后再试或使用其他提供商。",
  },
  de: {
    provider_slow: "Der KI-Anbieter hat Verzögerungen. Wird erneut versucht...",
    provider_failing: "Der KI-Anbieter antwortet nicht. Erneuter Versuch in {seconds}s ({attempt}/{max}).",
    provider_backoff: "Anbieter unzuverlässig — Wartezeit von {seconds}s vor dem nächsten Versuch ({attempt}/{max}).",
    provider_ask_user: "Der KI-Anbieter war für diese Aufgabe unzuverlässig. Sie können weiter warten, zu einem anderen Anbieter wechseln oder die Aufgabe abbrechen.",
    provider_abort: "Diese Aufgabe konnte nicht abgeschlossen werden — der KI-Anbieter antwortet nicht. Bitte versuchen Sie es später erneut oder verwenden Sie einen anderen Anbieter.",
  },
  es: {
    provider_slow: "El proveedor de IA está experimentando retrasos. Reintentando...",
    provider_failing: "El proveedor de IA no responde. Reintentando en {seconds}s ({attempt}/{max}).",
    provider_backoff: "Proveedor inestable — esperando {seconds}s antes del próximo intento ({attempt}/{max}).",
    provider_ask_user: "El proveedor de IA ha sido inestable para esta tarea. Puede seguir esperando, cambiar a otro proveedor o cancelar la tarea.",
    provider_abort: "No se pudo completar esta tarea — el proveedor de IA no responde. Inténtelo de nuevo más tarde o use otro proveedor.",
  },
  fr: {
    provider_slow: "Le fournisseur d'IA subit des retards. Nouvelle tentative...",
    provider_failing: "Le fournisseur d'IA ne répond pas. Nouvelle tentative dans {seconds}s ({attempt}/{max}).",
    provider_backoff: "Fournisseur instable — attente de {seconds}s avant la prochaine tentative ({attempt}/{max}).",
    provider_ask_user: "Le fournisseur d'IA a été instable pour cette tâche. Vous pouvez continuer à attendre, passer à un autre fournisseur ou annuler la tâche.",
    provider_abort: "Impossible de terminer cette tâche — le fournisseur d'IA ne répond pas. Veuillez réessayer plus tard ou utiliser un autre fournisseur.",
  },
};

export function getResilienceMessage(
  key: MessageKey,
  language: string,
  params?: Record<string, string | number>,
): string {
  const lang = language.toLowerCase().slice(0, 2);
  const messages = MESSAGES[lang] ?? MESSAGES.en!;
  let msg = messages[key] ?? MESSAGES.en![key]!;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return msg;
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/agents/resilience-messages.ts src/agents/resilience-messages.test.ts
git commit -m "feat(resilience): add language-aware resilience status messages (8 languages)"
```

---

### Task 3: Wire silentStream Through FallbackChainProvider

**Files:**
- Modify: `src/agents/providers/provider-manager.ts` — add `buildStreamingFallbackChain()`
- Modify: `src/agents/orchestrator.ts` — use chain in silentStream calls
- Test: `src/agents/orchestrator.test.ts`

- [ ] **Step 1: Read provider-manager.ts to understand buildResilientProvider pattern**

Check how existing `buildResilientProvider` works. The new method follows the same pattern but returns a chain specifically for streaming with the assigned provider as primary.

- [ ] **Step 2: Add `buildStreamingFallbackChain` to ProviderManager**

```typescript
// In provider-manager.ts
buildStreamingFallbackChain(
  primaryProvider: IAIProvider,
  primaryName: string,
): IAIProvider {
  // If only one provider available, return it directly
  const allProviders = this.getAllProviders();
  if (allProviders.length <= 1) return primaryProvider;

  // Build chain: primary first, then other healthy providers
  const others = allProviders.filter(p => p.name !== primaryName);
  if (others.length === 0) return primaryProvider;

  return new FallbackChainProvider([primaryProvider, ...others]);
}
```

- [ ] **Step 3: Update orchestrator to use chain in background loop**

In the background loop, before the `silentStream` call:
```typescript
const resilientProvider = this.providerManager.buildStreamingFallbackChain?.(
  currentProvider,
  currentAssignment.providerName,
) ?? currentProvider;
```

Then pass `resilientProvider` to `silentStream` and `provider.chat` calls.

- [ ] **Step 4: Same for interactive loop**

- [ ] **Step 5: Write test for multi-provider failover**

```typescript
it("silentStream falls through to next provider when primary fails", async () => {
  // Setup: mock provider manager with 2 providers
  // Primary (kimi) fails, secondary (openai) succeeds
  // Assert: response comes from secondary provider
});
```

- [ ] **Step 6: Write test for single-provider preserved behavior**

```typescript
it("single provider scenario preserves existing synthetic response behavior", async () => {
  // Setup: mock provider manager with 1 provider that fails
  // Assert: synthetic empty response returned (same as before)
});
```

- [ ] **Step 7: Run tests, commit**

```bash
git commit -m "feat(resilience): wire silentStream through FallbackChainProvider for streaming failover"
```

---

### Task 4: Integrate IterationHealthTracker + Backoff + Progressive Disclosure

**Files:**
- Modify: `src/agents/orchestrator.ts` — replace `consecutiveProviderFailures` counter with IterationHealthTracker, add backoff sleep, emit progressive status
- Test: `src/agents/orchestrator.test.ts`

This is the integration task that ties everything together.

- [ ] **Step 1: Replace consecutiveProviderFailures with IterationHealthTracker in background loop**

```typescript
// Before the while(true) loop:
const iterationHealth = new IterationHealthTracker();

// Replace the circuit breaker block with:
const cbResult = checkProviderFailureCircuitBreaker(response, iterationHealth.getConsecutiveFailures());
if (cbResult.action !== "ok") {
  const failureAction = iterationHealth.recordFailure(currentAssignment.providerName);

  // Progressive disclosure
  const statusLevel = iterationHealth.getStatusLevel();
  if (statusLevel === "degraded") {
    emitProgress(this.buildStructuredProgressSignal(
      prompt, progressTitle,
      { kind: "provider_health", message: getResilienceMessage("provider_slow", progressLanguage ?? "en") },
      progressLanguage,
    ));
  } else if (statusLevel === "critical") {
    emitProgress(this.buildStructuredProgressSignal(
      prompt, progressTitle,
      { kind: "provider_health", message: getResilienceMessage("provider_failing", progressLanguage ?? "en", {
        seconds: Math.round(failureAction.backoffMs / 1000),
        attempt: iterationHealth.getConsecutiveFailures(),
        max: 5,
      }) },
      progressLanguage,
    ));
  }

  if (failureAction.kind === "abort") {
    return finish(
      getResilienceMessage("provider_abort", progressLanguage ?? "en"),
      "completed",
      failureAction.reason,
    );
  }

  // Backoff before retry
  if (failureAction.backoffMs > 0) {
    logger.info("Provider failure backoff", { backoffMs: failureAction.backoffMs, provider: currentAssignment.providerName });
    await new Promise(resolve => setTimeout(resolve, failureAction.backoffMs));
  }

  continue;
} else {
  iterationHealth.recordSuccess();
}
```

- [ ] **Step 2: Same pattern for interactive loop**

- [ ] **Step 3: Write tests for backoff and progressive disclosure**

- [ ] **Step 4: Run full test suite, commit**

```bash
git commit -m "feat(resilience): integrate IterationHealthTracker with backoff and progressive disclosure"
```

---

### Task 5: Final Integration Verification

- [ ] **Step 1: Run full test suite**
- [ ] **Step 2: TypeScript type check**
- [ ] **Step 3: Lint**
