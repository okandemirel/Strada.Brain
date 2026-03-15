# Memory Architecture Overhaul Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Strada.Brain from an amnesic chatbot into a Jarvis-level persistent AI assistant that remembers users, conversations, preferences, and context across sessions.

**Architecture:** 5 components built in dependency order: (1) embedding provider wiring into AgentDB, (2) user profile persistence with SQLite table + onboarding, (3) hybrid conversation persistence with SessionSummarizer, (4) 4-layer context injection in orchestrator, (5) AgentDBAdapter stub fixes. Each component is independently testable.

**Tech Stack:** TypeScript, better-sqlite3, HNSW vector store, existing LLM providers, Zod config validation

**Spec:** `docs/superpowers/specs/2026-03-15-memory-architecture-overhaul-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `src/memory/unified/user-profile-store.ts` | UserProfileStore class — SQLite CRUD for user profiles |
| `src/memory/unified/user-profile-store.test.ts` | Unit tests for UserProfileStore |
| `src/memory/unified/session-summarizer.ts` | SessionSummarizer class — LLM-based conversation summarization |
| `src/memory/unified/session-summarizer.test.ts` | Unit tests for SessionSummarizer |

### Modified Files
| File | Changes |
|---|---|
| `src/core/bootstrap.ts` | Reorder init: embeddings before memory; wire SessionSummarizer; auto-set dimensions |
| `src/core/bootstrap.test.ts` | Update tests for new init order |
| `src/config/config.ts` | Add `LANGUAGE_PREFERENCE` env var, Zod schema, Config type |
| `src/core/setup-wizard.ts` | Add language selection + Gemini recommendation |
| `src/memory/unified/agentdb-memory.ts` | Dimension mismatch detection; extend storeConversation; create UserProfileStore |
| `src/memory/unified/agentdb-adapter.ts` | Fix stubs; expose UserProfileStore; forward userMessage/assistantMessage |
| `src/memory/unified/agentdb-adapter.test.ts` | Update tests for new real implementations |
| `src/agents/soul/soul-loader.ts` | Add `getProfileContent()` read-only method |
| `src/agents/soul/soul-loader.test.ts` | Test getProfileContent |
| `src/agents/orchestrator.ts` | 4-layer context injection; onboarding; session-end trigger; persona restore |

---

## Chunk 1: Embedding Provider Wiring

### Task 1: Extract embedding resolution from initializeRAG

**Files:**
- Modify: `src/core/bootstrap.ts:195-210, 1291-1380, 1450-1510`

- [ ] **Step 1: Create `resolveAndCacheEmbeddings()` function**

Extract the embedding resolution logic from `initializeRAG()` into a standalone function. This runs BEFORE `initializeMemory()` so the provider is available for AgentDB.

```typescript
// Add near the other init functions (after line ~1450)

interface EmbeddingResult {
  cachedProvider?: CachedEmbeddingProvider;
  notice?: string;
}

async function resolveAndCacheEmbeddings(
  config: Config,
  logger: winston.Logger,
): Promise<EmbeddingResult> {
  if (!config.rag.enabled) {
    return {};
  }

  try {
    const resolution = resolveEmbeddingProvider(config);
    if (!resolution) {
      return {
        notice: "No compatible embedding provider found. Memory semantic search uses hash-based fallback.",
      };
    }

    logger.info(`Embeddings: using ${resolution.provider.name}`, {
      source: resolution.source,
      dimensions: resolution.provider.dimensions,
    });

    const cachedProvider = new CachedEmbeddingProvider(resolution.provider, {
      persistPath: join(config.memory.dbPath, "cache"),
    });
    await cachedProvider.initialize();

    return { cachedProvider };
  } catch (error) {
    logger.warn("Embedding resolution failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { notice: "Embedding resolution failed. Memory semantic search uses hash-based fallback." };
  }
}
```

- [ ] **Step 2: Update `initializeMemory()` signature to accept embedding provider**

Modify `initializeMemory()` at line 1291 to accept optional `CachedEmbeddingProvider`:

```typescript
export async function initializeMemory(
  config: Config,
  logger: winston.Logger,
  embeddingProvider?: CachedEmbeddingProvider,
): Promise<IMemoryManager | undefined> {
```

Inside the function, update `agentdbConfig` at line 1306 to include the provider:

```typescript
  const agentdbConfig = {
    dbPath: agentdbPath,
    dimensions: embeddingProvider?.dimensions ?? config.memory.unified.dimensions,
    maxEntriesPerTier: {
      working: config.memory.unified.tierLimits.working,
      ephemeral: config.memory.unified.tierLimits.ephemeral,
      persistent: config.memory.unified.tierLimits.persistent,
    },
    enableAutoTiering: config.memory.unified.autoTiering,
    ephemeralTtlMs: (config.memory.unified.ephemeralTtlHours * 3600000) as DurationMs,
    // Wire real embedding provider into AgentDBMemory
    embeddingProvider: embeddingProvider
      ? async (text: string) => {
          const batch = await embeddingProvider.embed([text]);
          return batch.embeddings[0]!;
        }
      : undefined,
  };
```

- [ ] **Step 3: Reorder bootstrap() init sequence**

Change lines 195-210 in `bootstrap()`:

```typescript
  // Phase 0: Resolve embeddings FIRST (needed by memory)
  const embeddingResult = await resolveAndCacheEmbeddings(config, logger);
  const cachedEmbeddingProvider = embeddingResult.cachedProvider;
  if (embeddingResult.notice) {
    startupNotices.push(embeddingResult.notice);
  }

  // Phase 1: Initialize independent services in parallel
  const [providerInit, memoryManager, channel] = await Promise.all([
    initializeAIProvider(config, logger),
    initializeMemory(config, logger, cachedEmbeddingProvider),
    initializeChannel(channelType, config, auth, logger),
  ]);
  const providerManager = providerInit.manager;
  const startupNotices2 = [...providerInit.notices];
  startupNotices.push(...startupNotices2);

  // Phase 2: RAG pipeline (reuse already-resolved embedding provider)
  const ragResult = await initializeRAGWithProvider(config, logger, cachedEmbeddingProvider);
  const ragPipeline = ragResult.pipeline;
  if (ragResult.notice) {
    startupNotices.push(ragResult.notice);
  }
```

- [ ] **Step 4: Simplify `initializeRAG()` to reuse existing provider**

Rename to `initializeRAGWithProvider()` and accept the already-resolved provider instead of resolving again. Remove the duplicate `resolveEmbeddingProvider()` call and `CachedEmbeddingProvider` construction. The rest of the function (vector store, pipeline creation, dimension mismatch check for RAG vectors) stays the same but uses `cachedProvider` directly.

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run src/core/bootstrap.test.ts --reporter=verbose`
Expected: All existing tests pass (new param is optional, backward-compatible)

- [ ] **Step 6: Commit**

```
feat(memory): wire embedding provider into AgentDBMemory via bootstrap reorder
```

---

### Task 2: Add dimension mismatch detection to AgentDBMemory

**Files:**
- Modify: `src/memory/unified/agentdb-memory.ts:162-189, 1240-1275`

- [ ] **Step 1: Add dimension mismatch detection in `initialize()`**

After HNSW store creation at line 181, add detection logic. Check if the HNSW store reports existing dimensions that differ from config. If mismatch and embedding provider available, call `rebuildHnswIndex()`.

- [ ] **Step 2: Implement `rebuildHnswIndex()` private method**

New private method that: (1) recreates the HNSW store with new dimensions, (2) iterates all entries in `this.entries`, (3) re-embeds each entry via `generateEmbedding()`, (4) upserts into new HNSW index, (5) persists updated embeddings to SQLite. Logs progress and handles individual entry failures gracefully.

- [ ] **Step 3: Run existing memory tests**

Run: `npx vitest run src/memory/unified/ --reporter=verbose`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```
feat(memory): add HNSW dimension mismatch detection and auto-rebuild
```

---

## Chunk 2: User Profile Persistence

### Task 3: Create UserProfileStore

**Files:**
- Create: `src/memory/unified/user-profile-store.ts`
- Create: `src/memory/unified/user-profile-store.test.ts`

- [ ] **Step 1: Write failing tests for UserProfileStore**

Tests cover: getProfile returns null for unknown ID, upsertProfile creates new profile, upsertProfile updates without overwriting unrelated fields, setActivePersona persists, updateContextSummary with topics, touchLastSeen updates timestamp, JSON preferences round-trip, setActivePersona auto-creates profile.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/memory/unified/user-profile-store.test.ts --reporter=verbose`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement UserProfileStore**

Class with SQLite prepared statements for: CREATE TABLE IF NOT EXISTS, SELECT, UPSERT (INSERT ON CONFLICT UPDATE), touch lastSeenAt, set persona, update summary. Uses `COALESCE` in upsert to avoid overwriting existing fields with null. Stores preferences and lastTopics as JSON strings.

Interface `UserProfile`: chatId, displayName?, language, timezone?, activePersona, preferences (Record), contextSummary?, lastTopics (string[]), firstSeenAt, lastSeenAt.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/memory/unified/user-profile-store.test.ts --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
feat(memory): add UserProfileStore with SQLite persistence
```

---

### Task 4: Wire UserProfileStore into AgentDBMemory and Adapter

**Files:**
- Modify: `src/memory/unified/agentdb-memory.ts:140-156, 162-189`
- Modify: `src/memory/unified/agentdb-adapter.ts:48-54`

- [ ] **Step 1: Add UserProfileStore to AgentDBMemory**

Add `private userProfileStore: UserProfileStore | null = null` field. In `initialize()`, after `this.initSqlite()`, create `new UserProfileStore(this.sqliteDb)` if sqliteDb is available. Add `getUserProfileStore()` getter.

- [ ] **Step 2: Expose UserProfileStore via AgentDBAdapter**

Add `getUserProfileStore(): UserProfileStore | null` method that delegates to `this.agentdb.getUserProfileStore()`.

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run src/memory/unified/ --reporter=verbose`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```
feat(memory): wire UserProfileStore into AgentDBMemory and adapter
```

---

### Task 5: Add `getProfileContent()` to SoulLoader

**Files:**
- Modify: `src/agents/soul/soul-loader.ts:159-198`
- Modify: `src/agents/soul/soul-loader.test.ts`

- [ ] **Step 1: Write failing test**

Tests: getProfileContent returns content without mutating default cache, returns null for nonexistent profile, rejects path traversal in profile name.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/soul/soul-loader.test.ts --reporter=verbose`
Expected: FAIL -- getProfileContent is not a function

- [ ] **Step 3: Implement `getProfileContent()`**

Read-only method that validates profile name (alphanumeric + dash/underscore only), constructs `profiles/{name}.md` path, validates via existing `validateFilePath()`, reads file, enforces size limit, returns trimmed content. Does NOT touch `this.cache`. For "default" profile, returns current cache value.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agents/soul/soul-loader.test.ts --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
feat(soul): add getProfileContent() for per-user persona without global mutation
```

---

### Task 6: Add LANGUAGE_PREFERENCE to config

**Files:**
- Modify: `src/config/config.ts:32-129` (EnvVarName), Zod schema section, Config type, loadConfig

- [ ] **Step 1: Add `LANGUAGE_PREFERENCE` to EnvVarName union**

Add `| "LANGUAGE_PREFERENCE"` to the union type.

- [ ] **Step 2: Add to Zod schema, Config type, and loadConfig**

Add `language` field with enum validation `["en", "tr", "ja", "ko", "zh", "de", "es", "fr"]` defaulting to `"en"`. Map from `process.env.LANGUAGE_PREFERENCE`.

- [ ] **Step 3: Run config tests**

Run: `npx vitest run src/config/ --reporter=verbose`
Expected: All tests pass

- [ ] **Step 4: Commit**

```
feat(config): add LANGUAGE_PREFERENCE env var and config field
```

---

## Chunk 3: Conversation Persistence and SessionSummarizer

### Task 7: Extend storeConversation to accept userMessage/assistantMessage

**Files:**
- Modify: `src/memory/unified/agentdb-memory.ts:444-468`
- Modify: `src/memory/unified/agentdb-adapter.ts:129-146`
- Modify: `src/agents/orchestrator.ts:1718-1757`

- [ ] **Step 1: Extend AgentDBMemory.storeConversation signature**

Add optional `options?: { userMessage?: string; assistantMessage?: string }` param after `tier`. Store these fields in the `metadata` object of the entry.

- [ ] **Step 2: Update AgentDBAdapter.storeConversation to forward fields**

Change the call at line 141 to pass `options.userMessage` and `options.assistantMessage` to `agentdb.storeConversation()`.

- [ ] **Step 3: Update Orchestrator.persistSessionToMemory to extract messages**

After building `sanitized`, extract the first user message and last assistant message from the `messages` array. Pass as `options.userMessage` and `options.assistantMessage` to `storeConversation()`. Truncate each to 500 chars.

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run src/memory/unified/agentdb-adapter.test.ts src/agents/orchestrator.test.ts --reporter=verbose`
Expected: All pass (new params are optional)

- [ ] **Step 5: Commit**

```
feat(memory): extend storeConversation with userMessage/assistantMessage fields
```

---

### Task 8: Create SessionSummarizer

**Files:**
- Create: `src/memory/unified/session-summarizer.ts`
- Create: `src/memory/unified/session-summarizer.test.ts`

- [ ] **Step 1: Write failing tests**

Tests: summarizes conversation messages via LLM call, updates profile after summarization via `summarizeAndUpdateProfile`, handles LLM failure gracefully (returns empty summary).

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/memory/unified/session-summarizer.test.ts --reporter=verbose`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement SessionSummarizer**

Class with constructor accepting `IAIProvider` and `UserProfileStore`. Method `summarize(chatId, messages)` formats messages as `[role] text`, sends to LLM with JSON output instruction, parses response into `SessionSummary` (summary, keyDecisions, openItems, topics). Method `summarizeAndUpdateProfile(chatId, messages)` calls summarize then updates profile store. All failures are non-fatal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/memory/unified/session-summarizer.test.ts --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
feat(memory): add SessionSummarizer for LLM-based conversation summarization
```

---

### Task 9: Wire SessionSummarizer into bootstrap and orchestrator

**Files:**
- Modify: `src/core/bootstrap.ts:428-452`
- Modify: `src/agents/orchestrator.ts` (constructor, cleanupSessions)

- [ ] **Step 1: Add SessionSummarizer and UserProfileStore to orchestrator constructor**

Add optional params `sessionSummarizer` and `userProfileStore`. Store as private fields.

- [ ] **Step 2: Add session-end summarization trigger in cleanupSessions()**

In `cleanupSessions()`, before deleting an expired session, call `sessionSummarizer.summarizeAndUpdateProfile(chatId, session.messages)` as a fire-and-forget with error catch.

- [ ] **Step 3: Wire in bootstrap.ts after Promise.all**

After orchestrator construction, create SessionSummarizer using `providerManager.getProvider("")` and the UserProfileStore from `AgentDBAdapter.getUserProfileStore()`. Pass both to orchestrator.

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run src/core/bootstrap.test.ts src/agents/orchestrator.test.ts --reporter=verbose`
Expected: All pass (new params are optional)

- [ ] **Step 5: Commit**

```
feat(memory): wire SessionSummarizer into bootstrap and orchestrator lifecycle
```

---

## Chunk 4: 4-Layer Context Injection

### Task 10: Implement buildContextLayers() in Orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts`

- [ ] **Step 1: Add `buildContextLayers()` private method**

Returns `{ context: string, contentHashes: string[] }`. Builds 4 layers:
- Layer 1 (User Profile): reads from UserProfileStore, formats name/language/persona/prefs
- Layer 2 (Last Session Summary): reads contextSummary from profile
- Layer 3 (Open Tasks): reads from activeGoalTrees map
- Layer 4 (Semantic Memory): calls memoryManager.retrieve with user message query

Uses `<!-- context-layers:start/end -->` markers. Each layer is optional.

- [ ] **Step 2: Replace ad-hoc context injection in runAgentLoop()**

Replace the existing memory retrieval block (lines 781-830) with a call to `buildContextLayers()`. Add per-user persona override via `soulLoader.getProfileContent()`. Add language directive from profile. Seed content hashes into MemoryRefresher to prevent duplicate injection.

- [ ] **Step 3: Update injectSoulPersonality() to accept persona override**

Add optional `personaOverride?: string` parameter. If provided, use it instead of `soulLoader.getContent()`.

- [ ] **Step 4: Touch lastSeenAt at handleMessage start**

In `processMessage()`, call `userProfileStore.touchLastSeen(chatId)`.

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run src/agents/orchestrator.test.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 6: Commit**

```
feat(memory): implement 4-layer context injection with per-user persona
```

---

## Chunk 5: Adapter Stub Fixes and Onboarding

### Task 11: Fix AgentDBAdapter stubs

**Files:**
- Modify: `src/memory/unified/agentdb-adapter.ts:148-265`
- Modify: `src/memory/unified/agentdb-adapter.test.ts`

- [ ] **Step 1: Implement getChatHistory()**

Replace stub returning `ok([])` with delegation to `agentdb.getChatHistory()`. Map `UnifiedConversationMemoryEntry` to `ConversationMemoryEntry`.

- [ ] **Step 2: Implement storeNote()**

Replace stub returning fake ID with delegation to `agentdb.storeNote()`.

- [ ] **Step 3: Implement retrieveFromChat()**

Replace stub returning `ok([])` with delegation to `agentdb.retrieve()` with `mode: "chat"` and chatId filter.

- [ ] **Step 4: Update adapter tests**

Add tests for getChatHistory delegation, storeNote delegation, retrieveFromChat filtering.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/memory/unified/agentdb-adapter.test.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 6: Commit**

```
feat(memory): replace AgentDBAdapter stubs with real implementations
```

---

### Task 12: Add first-run onboarding to Orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts`

- [ ] **Step 1: Add runOnboarding() method**

Checks if UserProfileStore has a profile for this chatId. If not, creates minimal profile (so re-triggers are prevented). The actual onboarding questions are driven by a system prompt directive that instructs the LLM to use `ask_user` tool.

- [ ] **Step 2: Inject onboarding directive for new users**

In `runAgentLoop()`, after building system prompt, check if profile exists but has no displayName. If so, append an onboarding instruction block to the system prompt telling the agent to ask for name, language, style, and detail level preferences using ask_user tool.

- [ ] **Step 3: Wire onboarding in processMessage()**

Call `runOnboarding(chatId, channelType)` in `processMessage()` before `runAgentLoop()`.

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run src/agents/orchestrator.test.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 5: Commit**

```
feat(memory): add first-run onboarding with ask_user tool for new users
```

---

### Task 13: Add language selection to setup wizard

**Files:**
- Modify: `src/core/setup-wizard.ts`

- [ ] **Step 1: Read current setup wizard to understand flow**

- [ ] **Step 2: Add language selection step after API key entry**

List of 8 supported languages with English as default.

- [ ] **Step 3: Add Gemini embedding recommendation note**

When user has Gemini API key, suggest `EMBEDDING_PROVIDER=gemini` with explanation.

- [ ] **Step 4: Run setup wizard tests if they exist**

- [ ] **Step 5: Commit**

```
feat(config): add language selection and Gemini embedding recommendation to setup wizard
```

---

## Chunk 6: Full Integration and Final Review

### Task 14: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: All 3229+ existing tests pass + all new tests pass

- [ ] **Step 2: Fix any regressions**

- [ ] **Step 3: Commit fixes if needed**

```
fix: resolve test regressions from memory architecture overhaul
```

---

### Task 15: Mandatory review chain (before push)

- [ ] **Step 1: Run /simplify** on all changed code
- [ ] **Step 2: Run /security-review** focusing on UserProfileStore SQL, SessionSummarizer LLM input, config validation
- [ ] **Step 3: Run code-review agent** against the spec
- [ ] **Step 4: Fix all review findings**
- [ ] **Step 5: Final test run** -- all tests must pass
- [ ] **Step 6: Commit review fixes**

```
fix: address review findings from simplify, security, and code review
```

- [ ] **Step 7: Push** -- only after all reviews pass and user approves
