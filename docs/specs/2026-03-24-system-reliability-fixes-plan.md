# System Reliability Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 root causes preventing Strada.Brain from completing user tasks reliably.

**Architecture:** Targeted patches across provider chain, orchestrator loop, autonomy system, and session management. Each fix is independent — no cross-task dependencies except Task 4 builds on Task 3's Session interface change.

**Tech Stack:** TypeScript, Vitest, Node.js ESM

**Spec:** `docs/specs/2026-03-24-system-reliability-fixes-design.md`

---

### Task 1: Make reasoning_content Errors Fallback-Eligible

**Files:**
- Modify: `src/agents/providers/fallback-chain.ts:20-29`
- Test: `src/agents/providers/fallback-chain.test.ts`

- [ ] **Step 1: Write failing test**

In `src/agents/providers/fallback-chain.test.ts`, add a test that verifies a 400 error containing "reasoning_content" falls through to the next provider instead of being rethrown:

```typescript
it("falls through to next provider on reasoning_content 400 error", async () => {
  const failProvider = createMockProvider("kimi", () => {
    throw new Error('Kimi (Moonshot) API error 400: {"error":{"message":"thinking is enabled but reasoning_content is missing in assistant"}}');
  });
  const okProvider = createMockProvider("deepseek", () => ({
    text: "Hello",
    toolCalls: [],
    stopReason: "end_turn" as const,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  }));
  const chain = new FallbackChainProvider([failProvider, okProvider]);
  const result = await chain.chat("system", [], []);
  expect(result.text).toBe("Hello");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/providers/fallback-chain.test.ts --reporter=verbose`
Expected: FAIL — the 400 error currently might be rethrown as non-retryable (depending on error text matching), or it falls through already but we need to confirm behavior is correct.

- [ ] **Step 3: Implement the fix**

In `src/agents/providers/fallback-chain.ts`, modify `isNonRetryableRequestError`:

```typescript
function isNonRetryableRequestError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // reasoning_content errors are provider-specific (Kimi K2.5);
  // fallback providers won't have this requirement, so allow fallthrough
  if (/reasoning_content/i.test(msg)) return false;
  // HTTP 400 bad request — typically malformed body / invalid tool schema
  if (/\b400\b/.test(msg) && /bad.?request|invalid|malformed/i.test(msg)) return true;
  // HTTP 401/403 — auth errors won't resolve by switching provider
  if (/\b40[13]\b/.test(msg)) return true;
  // Explicit "invalid" schema / tool_calls format errors
  if (/invalid.*tool|tool.*invalid|invalid.*schema/i.test(msg)) return true;
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/providers/fallback-chain.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run full provider test suite**

Run: `npx vitest run src/agents/providers/ --reporter=verbose`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agents/providers/fallback-chain.ts src/agents/providers/fallback-chain.test.ts
git commit -m "$(cat <<'EOF'
fix: allow reasoning_content 400 errors to fall through to next provider

Kimi K2.5's reasoning_content requirement is provider-specific. When this
causes a 400, fallback providers (DeepSeek, Gemini, etc.) can handle the
request without reasoning_content. Add early return in
isNonRetryableRequestError to allow fallthrough.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Propagate silentStream Errors Instead of Swallowing

**Files:**
- Modify: `src/agents/orchestrator.ts:~3494-3512`
- Test: `src/agents/orchestrator.test.ts`

- [ ] **Step 1: Write failing test**

In `src/agents/orchestrator.test.ts`, add a test that the silentStream method throws when both streaming and fallback fail (rather than returning empty response). First check existing tests to find the test patterns used, then add:

```typescript
it("silentStream throws when both streaming and fallback fail", async () => {
  // Setup: provider where chatStream throws and chat also throws
  const provider = {
    ...mockProvider,
    chatStream: vi.fn().mockRejectedValue(new Error("stream failed")),
    chat: vi.fn().mockRejectedValue(new Error("fallback also failed")),
  };
  // Access silentStream through the orchestrator
  const orch = createTestOrchestrator({ provider });
  await expect(
    (orch as any).silentStream("test-chat", "system", { messages: [] }, provider, []),
  ).rejects.toThrow("fallback also failed");
});
```

Note: Adapt to actual test setup patterns in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/orchestrator.test.ts -t "silentStream throws" --reporter=verbose`
Expected: FAIL — currently returns empty response instead of throwing

- [ ] **Step 3: Implement the fix**

In `src/agents/orchestrator.ts`, find the `silentStream` method (~line 3494). Replace the final catch block's empty-response return:

```typescript
// BEFORE (lines ~3498-3512):
    } catch (err) {
      timeoutGuard.clear();
      const errMsg = err instanceof Error ? err.message : "Unknown streaming error";
      getLogger().error("Silent stream error", { chatId, error: errMsg });
      try {
        return await provider.chat(systemPrompt, session.messages, toolDefinitions);
      } catch (fallbackErr) {
        getLogger().error("Silent stream fallback chat failed", {
          chatId,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
      return {
        text: "",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }

// AFTER:
    } catch (err) {
      timeoutGuard.clear();
      const errMsg = err instanceof Error ? err.message : "Unknown streaming error";
      getLogger().error("Silent stream error", { chatId, error: errMsg });
      try {
        return await provider.chat(systemPrompt, session.messages, toolDefinitions);
      } catch (fallbackErr) {
        getLogger().error("Silent stream fallback chat failed", {
          chatId,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        throw fallbackErr;
      }
      // unreachable — previous block always returns or throws
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/orchestrator.test.ts -t "silentStream throws" --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run full orchestrator test suite**

Run: `npx vitest run src/agents/orchestrator.test.ts --reporter=verbose`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts src/agents/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
fix: propagate silentStream errors instead of returning empty response

When both streaming and fallback chat fail, silentStream was returning
an empty ProviderResponse. The orchestrator loop interpreted this as a
normal end_turn with no content — the error was invisible to the user.
Now throws the fallback error so the outer catch block can display it.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Auto-Append Fallback Providers to Explicit Chain

**Files:**
- Modify: `src/core/bootstrap-providers.ts:47-79`
- Test: `src/core/bootstrap-stages.test.ts` or `src/core/bootstrap-providers.test.ts` (check which exists)

- [ ] **Step 1: Find existing test file**

Check: `ls src/core/bootstrap-stages.test.ts src/core/bootstrap-providers.test.ts 2>/dev/null`

- [ ] **Step 2: Write failing test**

Add test that verifies auto-detected providers are appended to explicit chain:

```typescript
it("appends auto-detected providers as fallbacks to explicit chain", async () => {
  const config = {
    ...baseConfig,
    providerChain: "kimi",
    // Also has deepseek key available
  };
  const apiKeys = { kimi: "key1", deepseek: "key2" };
  // After init, provider chain should include both
  const result = await initializeAIProvider(config, logger);
  expect(result.defaultProviderOrder).toContain("kimi");
  // deepseek should be appended as fallback
  expect(result.defaultProviderOrder.length).toBeGreaterThan(1);
});
```

Note: Adapt to actual test patterns in the file.

- [ ] **Step 3: Implement the fix**

In `src/core/bootstrap-providers.ts`, after the explicit chain is built (after line 79), add auto-detection of additional fallback providers:

```typescript
  // 1) Explicit provider chain
  if (config.providerChain) {
    // ... existing code that builds configuredNames and defaultProvider ...

    // Auto-detect additional providers with valid keys as silent fallbacks
    const explicitSet = new Set(configuredNames);
    const additionalNames = Object.entries(apiKeys)
      .filter(([name, key]) => !explicitSet.has(name) && name !== "claude" && name !== "anthropic" && key)
      .map(([name]) => name);

    if (additionalNames.length > 0) {
      const fallbackPreflight = await preflightResponseProviders(
        additionalNames,
        providerCredentials,
        config.providerModels,
      );
      if (fallbackPreflight.passedProviderIds.length > 0) {
        const allProviderIds = [...preflightResult.passedProviderIds, ...fallbackPreflight.passedProviderIds];
        defaultProviderOrder = allProviderIds;
        defaultProvider = buildProviderChain(allProviderIds, providerCredentials, {
          models: config.providerModels,
        });
        notices.push(
          `Auto-appended fallback providers: ${fallbackPreflight.passedProviderIds.join(", ")}`,
        );
        logger.info("AI provider chain with auto-fallbacks", { chain: allProviderIds });
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/bootstrap-stages.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/bootstrap-providers.ts src/core/bootstrap-stages.test.ts
git commit -m "$(cat <<'EOF'
feat: auto-append fallback providers to explicit provider chain

When PROVIDER_CHAIN is set (e.g., "kimi"), the system now auto-detects
additional providers with valid API keys and appends them as silent
fallbacks. User's priority order is preserved. Only providers that pass
preflight are added. This prevents total failure when the primary
provider is down.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Carry Execution Journal Across Session Messages

**Files:**
- Modify: `src/agents/orchestrator-session-manager.ts:41-49` (Session interface)
- Modify: `src/agents/autonomy/execution-journal.ts` (add seedFromSnapshot)
- Modify: `src/agents/orchestrator-autonomy-tracker.ts:29-47` (accept previous snapshot)
- Modify: `src/agents/orchestrator.ts:~2796` (pass previous snapshot)
- Test: `src/agents/autonomy/execution-journal.test.ts`
- Test: `src/agents/orchestrator-autonomy-tracker.test.ts`

- [ ] **Step 1: Write failing test for ExecutionJournal.seedFromSnapshot**

In `src/agents/autonomy/execution-journal.test.ts`:

```typescript
it("seeds from a previous snapshot preserving insights and verifier summary", () => {
  const original = new ExecutionJournal("original task");
  original.recordToolBatch([
    { toolName: "file_read", success: true, summary: "Read config.ts" },
  ], "acting", "kimi");
  original.addLearnedInsight("Config uses Zod validation");
  const snapshot = original.snapshot();

  const seeded = new ExecutionJournal("follow-up task");
  seeded.seedFromSnapshot(snapshot);
  const seededSnapshot = seeded.snapshot();
  expect(seededSnapshot.learnedInsights).toContain("Config uses Zod validation");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/autonomy/execution-journal.test.ts -t "seeds from" --reporter=verbose`
Expected: FAIL — seedFromSnapshot doesn't exist yet

- [ ] **Step 3: Implement seedFromSnapshot**

In `src/agents/autonomy/execution-journal.ts`, add method to `ExecutionJournal`:

```typescript
  seedFromSnapshot(previous: ExecutionJournalSnapshot): void {
    if (previous.learnedInsights) {
      for (const insight of previous.learnedInsights) {
        this.learnedInsights.add(insight);
      }
    }
    if (previous.verifierSummary) {
      this.lastVerifierSummary = previous.verifierSummary;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/autonomy/execution-journal.test.ts -t "seeds from" --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Update Session interface**

In `src/agents/orchestrator-session-manager.ts`, add to `Session` interface:

```typescript
export interface Session {
  messages: ConversationMessage[];
  visibleMessages?: ConversationMessage[];
  lastActivity: Date;
  conversationScope?: string;
  profileKey?: string;
  mixedParticipants?: boolean;
  postSetupBootstrapDelivered?: boolean;
  lastJournalSnapshot?: import("./autonomy/execution-journal.js").ExecutionJournalSnapshot;
}
```

- [ ] **Step 6: Update createAutonomyBundle to accept previous snapshot**

In `src/agents/orchestrator-autonomy-tracker.ts`:

```typescript
export interface CreateAutonomyBundleParams {
  readonly prompt: string;
  readonly iterationBudget: number;
  readonly stradaDeps?: StradaDepsStatus;
  readonly projectWorldSummary?: string;
  readonly projectWorldFingerprint?: string;
  readonly includeControlLoopTracker?: boolean;
  readonly previousJournalSnapshot?: import("./autonomy/execution-journal.js").ExecutionJournalSnapshot;
}

export function createAutonomyBundle(params: CreateAutonomyBundleParams): AutonomyBundle {
  // ... existing code ...
  const executionJournal = new ExecutionJournal(params.prompt);

  // Seed from previous session's journal if available
  if (params.previousJournalSnapshot) {
    executionJournal.seedFromSnapshot(params.previousJournalSnapshot);
  }

  // ... rest of existing code ...
}
```

- [ ] **Step 7: Wire it up in orchestrator.ts**

In `src/agents/orchestrator.ts`, find `createAutonomyBundle` call (~line 2798) and pass previous snapshot:

```typescript
const { errorRecovery, taskPlanner, selfVerification, executionJournal, stradaConformance } =
  createAutonomyBundle({
    prompt: lastUserMessage,
    iterationBudget: this.getInteractiveIterationLimit(),
    stradaDeps: this.stradaDeps,
    projectWorldSummary,
    projectWorldFingerprint,
    previousJournalSnapshot: session.lastJournalSnapshot,
  });
```

And in the finally block (~line 3417), save snapshot to session:

```typescript
finally {
  this.sessionManager.persistExecutionMemory(identityKey, executionJournal);
  session.lastJournalSnapshot = executionJournal.snapshot();
  // ... existing metrics code ...
}
```

- [ ] **Step 8: Write integration test**

In `src/agents/orchestrator-autonomy-tracker.test.ts`:

```typescript
it("seeds execution journal from previous snapshot when provided", () => {
  const previous: ExecutionJournalSnapshot = {
    learnedInsights: ["Config uses Zod"],
    verifierSummary: "Build passed",
  };
  const bundle = createAutonomyBundle({
    prompt: "continue",
    iterationBudget: 10,
    previousJournalSnapshot: previous,
  });
  const snapshot = bundle.executionJournal.snapshot();
  expect(snapshot.learnedInsights).toContain("Config uses Zod");
  expect(snapshot.verifierSummary).toBe("Build passed");
});
```

- [ ] **Step 9: Run all related tests**

Run: `npx vitest run src/agents/autonomy/execution-journal.test.ts src/agents/orchestrator-autonomy-tracker.test.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 10: Commit**

```bash
git add src/agents/autonomy/execution-journal.ts src/agents/orchestrator-session-manager.ts src/agents/orchestrator-autonomy-tracker.ts src/agents/orchestrator.ts src/agents/autonomy/execution-journal.test.ts src/agents/orchestrator-autonomy-tracker.test.ts
git commit -m "$(cat <<'EOF'
fix: carry execution journal across session messages

Previously each user message created a fresh ExecutionJournal, losing
all context from previous iterations. Now the journal snapshot is saved
to the session and seeded into the next message's journal. This means
"try again" or "continue" retains knowledge of previous tool calls,
learned insights, and verifier summaries.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Lenient Completion Review When Build Tools Unavailable

**Files:**
- Modify: `src/agents/autonomy/completion-review.ts:48-67`
- Modify: `src/agents/autonomy/verifier-pipeline.ts:61-68`
- Modify: `src/agents/orchestrator-intervention-pipeline.ts:~620`
- Test: `src/agents/autonomy/verifier-pipeline.test.ts`

- [ ] **Step 1: Write failing test**

In `src/agents/autonomy/verifier-pipeline.test.ts`:

```typescript
it("skips build verification when buildToolsAvailable is false", () => {
  const result = planVerifierPipeline({
    prompt: "fix the level editor",
    draft: "I updated the ArrowLevelEditorWindow.cs file.",
    state: mockAgentState,
    task: mockTask,
    verificationState: { ...mockVerificationState, touchedFiles: new Set(["test.cs"]) },
    buildVerificationGate: "[VERIFICATION REQUIRED] Run build",
    conformanceGate: null,
    logEntries: [],
    chatId: "test",
    taskStartedAtMs: Date.now(),
    buildToolsAvailable: false,
  });
  // Build check should be clean (not gating) when tools unavailable
  const buildCheck = result.checks.find(c => c.name === "build");
  expect(buildCheck?.status).toBe("not_applicable");
  expect(buildCheck?.gate).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/autonomy/verifier-pipeline.test.ts -t "skips build" --reporter=verbose`
Expected: FAIL — `buildToolsAvailable` parameter doesn't exist

- [ ] **Step 3: Implement the fix**

In `src/agents/autonomy/verifier-pipeline.ts`, add `buildToolsAvailable` to `planVerifierPipeline` params:

```typescript
export function planVerifierPipeline(params: {
  prompt: string;
  draft: string;
  state: AgentState;
  task: TaskClassification;
  verificationState: VerificationState;
  buildVerificationGate: string | null;
  conformanceGate: string | null;
  logEntries: readonly LogEntry[];
  chatId: string;
  taskStartedAtMs: number;
  buildToolsAvailable?: boolean;  // NEW
}): VerifierPipelinePlan {
```

Then modify the build check logic:

```typescript
  const buildCheck = params.buildToolsAvailable === false
    ? { name: "build" as const, status: "not_applicable" as const, summary: "Build tools unavailable in this environment." }
    : buildBuildVerifierCheck(params.buildVerificationGate);
```

Similarly for targeted reproduction:

```typescript
  const targetedCheck = params.buildToolsAvailable === false
    ? null
    : buildTargetedReproVerifierCheck(evidence);
```

In `src/agents/autonomy/completion-review.ts`, update `COMPLETION_REVIEW_SYSTEM_PROMPT` — append to the existing prompt:

```typescript
+ "\n\nWhen build/compile tools are unavailable, approve based on code analysis evidence alone. Do not require external build verification that cannot be performed in this environment."
```

In `src/agents/orchestrator-intervention-pipeline.ts`, where `planVerifierPipeline` is called (~line 620), pass the new flag:

```typescript
const buildToolsAvailable = params.availableToolNames
  ? ["shell_execute", "unity_compile", "run_tests", "build"].some(t =>
      [...(params.availableToolNames ?? [])].includes(t))
  : true; // assume available if tool list unknown

// ... in planVerifierPipeline call:
buildToolsAvailable,
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agents/autonomy/verifier-pipeline.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run completion review tests**

Run: `npx vitest run src/agents/autonomy/completion-review.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/autonomy/completion-review.ts src/agents/autonomy/verifier-pipeline.ts src/agents/orchestrator-intervention-pipeline.ts src/agents/autonomy/verifier-pipeline.test.ts
git commit -m "$(cat <<'EOF'
fix: skip build verification when build tools are unavailable

The completion review system was blocking task completion when
build/compile tools weren't available (e.g., Unity projects without
shell access). Now build and targeted-reproduction checks are marked
not_applicable when buildToolsAvailable is false, and the LLM reviewer
is instructed to approve based on code analysis alone.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Persist Sessions to Disk

**Files:**
- Modify: `src/agents/orchestrator-session-manager.ts`
- Test: `src/agents/orchestrator-session-manager.test.ts`

- [ ] **Step 1: Write failing test for serialize/deserialize**

In `src/agents/orchestrator-session-manager.test.ts`:

```typescript
describe("session disk persistence", () => {
  it("round-trips a session through serialize/deserialize", () => {
    const session: Session = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      lastActivity: new Date("2026-03-24T10:00:00Z"),
      conversationScope: "scope-1",
      lastJournalSnapshot: { learnedInsights: ["test insight"] },
    };
    const json = SessionManager.serializeSession(session);
    const restored = SessionManager.deserializeSession(json);
    expect(restored).not.toBeNull();
    expect(restored!.messages).toHaveLength(2);
    expect(restored!.messages[0].content).toBe("hello");
    expect(restored!.conversationScope).toBe("scope-1");
    expect(restored!.lastJournalSnapshot?.learnedInsights).toContain("test insight");
  });

  it("caps serialized messages at 50", () => {
    const messages = Array.from({ length: 80 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}`,
    }));
    const session: Session = { messages, lastActivity: new Date() };
    const json = SessionManager.serializeSession(session);
    const restored = SessionManager.deserializeSession(json);
    expect(restored!.messages).toHaveLength(50);
    // Should keep the most recent 50
    expect(restored!.messages[0].content).toBe("msg-30");
  });

  it("returns null for expired sessions (>24h)", () => {
    const session: Session = {
      messages: [{ role: "user", content: "old" }],
      lastActivity: new Date(Date.now() - 25 * 60 * 60 * 1000),
    };
    const json = SessionManager.serializeSession(session);
    const restored = SessionManager.deserializeSession(json);
    expect(restored).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/orchestrator-session-manager.test.ts -t "session disk" --reporter=verbose`
Expected: FAIL — serializeSession/deserializeSession don't exist

- [ ] **Step 3: Implement serialize/deserialize**

In `src/agents/orchestrator-session-manager.ts`, add static methods:

```typescript
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// Inside SessionManager class:

  private static readonly MAX_PERSISTED_MESSAGES = 50;
  private static readonly SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

  static serializeSession(session: Session): string {
    const messages = session.messages.slice(-SessionManager.MAX_PERSISTED_MESSAGES);
    return JSON.stringify({
      messages,
      lastActivity: session.lastActivity.toISOString(),
      conversationScope: session.conversationScope,
      profileKey: session.profileKey,
      lastJournalSnapshot: session.lastJournalSnapshot,
    });
  }

  static deserializeSession(json: string): Session | null {
    try {
      const data = JSON.parse(json);
      const lastActivity = new Date(data.lastActivity);
      if (Date.now() - lastActivity.getTime() > SessionManager.SESSION_EXPIRY_MS) {
        return null; // expired
      }
      return {
        messages: data.messages ?? [],
        visibleMessages: [],
        lastActivity,
        conversationScope: data.conversationScope,
        profileKey: data.profileKey,
        lastJournalSnapshot: data.lastJournalSnapshot,
      };
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/orchestrator-session-manager.test.ts -t "session disk" --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Wire disk persistence into getOrCreateSession and persistSessionToMemory**

Add a `sessionsDir` to the constructor deps:

```typescript
export interface SessionManagerDeps {
  // ... existing fields ...
  readonly sessionsDir?: string; // e.g., ".strada-memory/sessions"
}
```

Add disk write in `persistSessionToMemory` (after the existing memory store logic):

```typescript
  // At end of persistSessionToMemory, after the try/catch:
  if (this.deps.sessionsDir) {
    this.persistSessionToDisk(chatId, session).catch((err) => {
      getLogger().debug("Session disk persist failed", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
```

Add private helper:

```typescript
  private async persistSessionToDisk(chatId: string, session: Session): Promise<void> {
    const dir = this.deps.sessionsDir!;
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const safeName = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(dir, `${safeName}.json`);
    await writeFile(filePath, SessionManager.serializeSession(session), "utf-8");
  }
```

Add disk restore in `getOrCreateSession`:

```typescript
  getOrCreateSession(chatId: string): Session {
    let session = this.sessions.get(chatId);
    if (session) {
      this.sessions.delete(chatId);
      this.sessions.set(chatId, session);
      return session;
    }

    // Try disk restore before creating fresh session
    if (this.deps.sessionsDir) {
      const restored = this.restoreSessionFromDisk(chatId);
      if (restored) {
        this.sessions.set(chatId, restored);
        return restored;
      }
    }

    // ... existing eviction and creation code ...
  }

  private restoreSessionFromDisk(chatId: string): Session | null {
    try {
      const safeName = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = join(this.deps.sessionsDir!, `${safeName}.json`);
      if (!existsSync(filePath)) return null;
      const json = require("node:fs").readFileSync(filePath, "utf-8");
      return SessionManager.deserializeSession(json);
    } catch {
      return null;
    }
  }
```

- [ ] **Step 6: Wire sessionsDir in orchestrator construction**

Find where `SessionManager` is constructed in `orchestrator.ts` and pass the sessions directory. Use the project's `.strada-memory/sessions` path.

- [ ] **Step 7: Run all session manager tests**

Run: `npx vitest run src/agents/orchestrator-session-manager.test.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/agents/orchestrator-session-manager.ts src/agents/orchestrator-session-manager.test.ts src/agents/orchestrator.ts
git commit -m "$(cat <<'EOF'
feat: persist sessions to disk for cross-restart continuity

Sessions were purely in-memory — a process restart lost all context.
Now sessions are serialized to .strada-memory/sessions/{chatId}.json
on every persist cycle and restored on getOrCreateSession when no
in-memory session exists. Caps at 50 messages, expires after 24 hours,
includes the journal snapshot from the execution journal carry-over fix.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass, no regressions

- [ ] **Step 2: TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Verify git status is clean**

Run: `git status`
Expected: Clean working tree with 6 new commits
