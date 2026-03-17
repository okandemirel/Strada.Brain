# Memory Architecture Overhaul — Design Spec

> Historical design note: This file records a design snapshot. It is not the authoritative source for current runtime behavior or env defaults. Use [README.md](../../../README.md), [src/config/README.md](../../../src/config/README.md), [src/channels/README.md](../../../src/channels/README.md), and [SECURITY.md](../../../SECURITY.md) for the current system.

**Date:** 2026-03-15
**Status:** Approved
**Goal:** Transform Strada.Brain from an amnesic chatbot into a Jarvis-level persistent AI assistant that remembers users, conversations, preferences, and context across sessions.

---

## Problem Statement

The agent forgets everything between sessions:
- Conversations are stored but never retrieved (getChatHistory is a stub)
- Embedding provider is not wired into AgentDBMemory (hash-based fallback = no real semantic search)
- No user profile persistence (name, language, preferences lost on restart)
- Active persona not persisted (switch_personality resets on restart)
- No LLM-based conversation summarization (raw message dumps instead)
- Context injection is minimal (only 3 TF-IDF snippets in system prompt)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Bootstrap                               │
│  1. resolveEmbeddingProvider() → CachedEmbeddingProvider     │
│  2. initializeMemory(config, embeddingProvider) → AgentDB    │
│  3. AgentDBMemory receives real embedding function            │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentDBMemory                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ memories  │  │ user_profiles│  │ HNSW Vector Index     │  │
│  │ (SQLite)  │  │ (SQLite)     │  │ (real embeddings)     │  │
│  └──────────┘  └──────────────┘  └───────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Orchestrator                              │
│  ┌────────────────────────────────────────────────────┐      │
│  │  4-Layer Context Injection (every message):        │      │
│  │  1. User Profile (name, lang, persona, prefs)      │      │
│  │  2. Last Session Summary (LLM-generated)           │      │
│  │  3. Open Tasks / Goals                             │      │
│  │  4. Semantic Memory (real embedding search)        │      │
│  └────────────────────────────────────────────────────┘      │
│  ┌────────────────────────────────────────────────────┐      │
│  │  Hybrid Persistence:                               │      │
│  │  - Immediate: raw messages → Ephemeral tier        │      │
│  │  - Periodic: LLM summary → Persistent tier         │      │
│  │  - Session-end: profile + context_summary update   │      │
│  └────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## Component 1: Embedding Provider Wiring

### Problem
`initializeMemory()` creates AgentDBMemory without an `embeddingProvider`. The `CachedEmbeddingProvider` from RAG init is never passed to AgentDB. All memory embeddings use a hash-based character-frequency fallback — HNSW semantic search is effectively random.

### Solution
Extract embedding resolution from `initializeRAG()` into a standalone step that runs BEFORE `initializeMemory()`. Pass the resolved provider into `initializeMemory()` as a parameter.

Detailed steps:
1. New function `resolveAndCacheEmbeddings(config)` — calls `resolveEmbeddingProvider()` + wraps in `CachedEmbeddingProvider`. Returns the cached provider or `undefined`.
2. `initializeMemory(config, logger, embeddingProvider?)` — accepts optional provider param
3. Inside `initializeMemory`, the `agentdbConfig` object includes `embeddingProvider` field:
   ```typescript
   const agentdbConfig = {
     ...existingConfig,
     embeddingProvider: cachedProvider
       ? async (text: string) => {
           const batch = await cachedProvider.embed([text]);
           return batch.embeddings[0]!;
         }
       : undefined,
   };
   ```
4. This flows through ALL three instantiation paths: first attempt (line 1348), repair retry (line 1366), and `finalizeAgentDB()` (line 1319) — since `agentdbConfig` is shared by all three.
5. Bootstrap Phase 1 changes from `Promise.all([providerInit, memory, channel])` to sequential: embeddings first, then `Promise.all([providerInit, memory, channel])`.

### Dimension Mismatch Migration
Different embedding providers produce different dimension vectors (OpenAI: 1536, Gemini: 3072, Mistral: 1024, etc.). The HNSW index is created with a fixed dimension. Switching providers after initial setup would corrupt the index.

**Solution:**
- On AgentDB initialization, detect if the configured `dimensions` differs from the existing HNSW index dimensions
- If mismatch detected: log a warning, rebuild HNSW index from scratch by re-embedding all entries with the new provider
- If no embedding provider available for re-embedding: keep hash-based fallback, do NOT corrupt the index
- `config.memory.unified.dimensions` must match the chosen provider's dimensions — add validation in bootstrap that auto-sets dimensions from the resolved provider's `dimensions` property
- First-time users: no migration needed, index created fresh with correct dimensions

### Files to Modify
- `src/core/bootstrap.ts` — extract embedding resolution, pass to `initializeMemory`, auto-set dimensions
- `src/memory/unified/agentdb-memory.ts` — add dimension mismatch detection + HNSW rebuild logic in `initialize()`

### Embedding Provider Support
All existing providers remain supported via `EMBEDDING_PRESETS` in `src/common/constants.ts`:
- **Recommended:** Gemini (`gemini-embedding-2-preview`, 3072d, free tier sufficient) — add recommendation note in setup wizard
- **Supported:** OpenAI (1536d), Mistral (1024d), Together (768d), Fireworks (768d), Qwen (1024d), Ollama (768d)
- **Not supported for embeddings:** Claude, Kimi, MiniMax, Groq, DeepSeek (no embedding endpoints)

### Config
- `EMBEDDING_PROVIDER=auto` (default) — `resolveEmbeddingProvider()` scans provider chain, then falls back to priority order: openai, deepseek, mistral, together, fireworks, qwen, gemini, ollama
- `EMBEDDING_DIMENSIONS` auto-set from resolved provider (no manual config needed)
- Setup wizard shows Gemini as recommended option. When user selects Gemini, wizard explicitly sets `EMBEDDING_PROVIDER=gemini` (not `auto`) to avoid being overridden by a higher-priority provider in the auto fallback chain

---

## Component 2: User Profile Persistence

### Schema
New `user_profiles` table in AgentDBMemory's SQLite database:

```sql
CREATE TABLE IF NOT EXISTS user_profiles (
  chat_id         TEXT PRIMARY KEY,
  display_name    TEXT,
  language        TEXT DEFAULT 'en',
  timezone        TEXT,
  active_persona  TEXT DEFAULT 'default',
  preferences     TEXT DEFAULT '{}',   -- JSON: {verbosity, theme, ...}
  context_summary TEXT,                -- LLM-generated last session summary
  last_topics     TEXT DEFAULT '[]',   -- JSON array of recent topic strings
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

### New Class: `UserProfileStore`
Location: `src/memory/unified/user-profile-store.ts`

```typescript
interface UserProfile {
  chatId: string;
  displayName?: string;
  language: string;
  timezone?: string;
  activePersona: string;
  preferences: Record<string, unknown>;
  contextSummary?: string;
  lastTopics: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

class UserProfileStore {
  constructor(db: Database.Database);
  getProfile(chatId: string): UserProfile | null;
  upsertProfile(chatId: string, updates: Partial<UserProfile>): UserProfile;
  setActivePersona(chatId: string, persona: string): void;
  updateContextSummary(chatId: string, summary: string, topics: string[]): void;
  touchLastSeen(chatId: string): void;
}
```

### Integration Points
- `AgentDBMemory` creates `UserProfileStore` during `initialize()`, shares its SQLite DB
- `AgentDBAdapter` exposes `getUserProfileStore()` for orchestrator access
- Orchestrator loads profile at start of `handleMessage()`, uses persona name for context injection

### Per-User Persona (SoulLoader Race Condition Fix)
`SoulLoader.switchProfile()` mutates global shared state — calling it for user A would change the personality for all concurrent users B, C, D. Instead of mutating `SoulLoader`, the orchestrator will:

1. Read `activePersona` from `UserProfileStore` per chatId
2. Call `SoulLoader.getProfileContent(personaName)` — a NEW read-only method that loads and returns the profile content without mutating the default cache
3. Pass the persona content directly to `injectSoulPersonality()` instead of relying on `getContent()`

Changes to `SoulLoader`:
- New method: `getProfileContent(profileName: string): Promise<string | null>` — reads `profiles/{name}.md`, returns content without caching to `"default"` key
- Existing `switchProfile()` remains for single-user CLI channel where global mutation is safe
- `injectSoulPersonality()` updated to accept optional `personaOverride: string` parameter

### Multi-Channel User Identity
`chatId` values are channel-specific (web: UUID, Telegram: numeric ID, Discord: snowflake). The same human user on different channels gets separate profiles. This is **by design for v1** — cross-channel identity linking is deferred to a future version. Each channel-chatId pair is treated as an independent user context.

Rationale: cross-channel linking requires an authentication/identity system that doesn't exist yet. Forcing it now would add complexity without a reliable way to link accounts. The per-chatId model is simple, correct, and sufficient for the Jarvis experience within each channel.

### Profile Data Lifecycle
- Created on first message from a chatId (first_seen_at set)
- Updated incrementally: display_name when detected, language when changed, etc.
- `last_seen_at` touched on every message
- `context_summary` and `last_topics` updated at session end
- Never deleted unless user explicitly requests it
- No TTL, no decay — user profiles are permanent

---

## Component 2.1: First Run Onboarding

### Trigger
`UserProfileStore.getProfile(chatId)` returns `null` → first interaction with this user.

### Flow
1. Agent introduces itself using soul.md personality
2. Sequential questions via `ask_user` tool (multi-choice + free text):
   - "How should I address you?" → `display_name`
   - "Which language do you prefer?" → `language` (suggests detected language, default from config)
   - "What communication style do you prefer?" → `active_persona` (casual/formal/minimal/default with descriptions)
   - "Anything specific about your project I should know?" → `preferences.project_context`
   - "How detailed should my explanations be?" → `preferences.verbosity` (brief/moderate/detailed)
3. Responses saved to `user_profiles`
4. Confirmation: "Got it, [name]. I'll communicate in [style]. You can change any of this anytime."
5. Normal message processing continues

### Implementation
- New method `Orchestrator.runOnboarding(chatId, channelType)` called before first `runAgentLoop`
- Uses existing `ask_user` tool infrastructure
- Skips onboarding if profile already exists (returning user)

---

## Component 2.2: Language Preference

### Setup Wizard Integration
- New config option: `LANGUAGE_PREFERENCE` (env var)
- Added to `EnvVarName` union type, Zod schema, `Config` type, and `loadConfig()` parser in `src/config/config.ts`
- Added to setup wizard flow alongside API key entry
- Default: `en`
- Options: EN, TR, JA, KO, ZH, DE, ES, FR (8 supported languages)
- Stored in `config.language`

### Files to Modify
- `src/config/config.ts` — add `LANGUAGE_PREFERENCE` to EnvVarName, Zod schema, Config type, loadConfig parser
- `src/core/setup-wizard.ts` — add language selection step

### Runtime Behavior
- `config.language` sets the system-wide default
- `user_profiles.language` overrides per-user (set during onboarding or later)
- Onboarding messages rendered in the configured language
- System prompt injection: `"Communicate with the user in {language}."`
- User can change at any time: "speak English" / "Turkce konus" → profile updated, immediate switch
- Language change is permanent until user requests another change

---

## Component 3: Hybrid Conversation Persistence

### Immediate Persist (existing, enhanced)
- After every message exchange: raw `[role] content` → `storeConversation()` → Ephemeral tier
- Debounce: 30s (unchanged)
- Enhancement: also store `userMessage` and `assistantMessage` as separate fields (for structured retrieval)

### Periodic Summarization (new) — SessionSummarizer
The existing `MemoryConsolidationEngine` operates on the entire memory store via cluster-based merging — it has no concept of `chatId` or per-session scoping. Rather than forcing session awareness into its cluster API (which risks breaking existing consolidation tests), we create a **new `SessionSummarizer` class** for per-session summarization.

**New class: `SessionSummarizer`**
Location: `src/memory/unified/session-summarizer.ts`

```typescript
class SessionSummarizer {
  constructor(
    private readonly llmProvider: IAIProvider,
    private readonly profileStore: UserProfileStore,
  );

  /** Summarize a batch of conversation messages into a structured summary */
  async summarize(chatId: string, messages: ConversationMessage[]): Promise<SessionSummary>;

  /** Extract user profile updates from conversation (name changes, preference mentions) */
  async extractProfileUpdates(messages: ConversationMessage[]): Promise<Partial<UserProfile>>;
}

interface SessionSummary {
  summary: string;        // LLM-generated narrative summary
  keyDecisions: string[]; // important decisions made
  openItems: string[];    // unfinished tasks/questions
  topics: string[];       // main topics discussed
}
```

- Trigger: every 10 messages OR session end (whichever comes first)
- LLM generates structured summary: key decisions, user requests, outcomes, open items
- Summary stored in Persistent tier via `storeConversation()` with `tier: Persistent`
- Original Ephemeral entries soft-deleted after successful summarization
- `MemoryConsolidationEngine` continues to run independently for cross-session cluster-based consolidation (unchanged)

### Session-End Processing (new)
- Trigger: session cleanup (inactivity timeout in `cleanupSessions()`) or explicit session end
- Steps:
  1. `SessionSummarizer.summarize(chatId, unsummarizedMessages)` → structured summary
  2. `SessionSummarizer.extractProfileUpdates(messages)` → preference changes
  3. `UserProfileStore.updateContextSummary(chatId, summary, topics)`
  4. `UserProfileStore.upsertProfile(chatId, extractedUpdates)` if any detected

### Immediate Persist Enhancement
The current flow drops `userMessage`/`assistantMessage` at three levels. All three must be fixed:

1. **Orchestrator** (`persistSessionToMemory`): Currently calls `storeConversation(chatId, sanitized)` with no options. Fix: extract first user message and last assistant message from the `messages` array, pass as `options.userMessage` and `options.assistantMessage`.
2. **AgentDBAdapter** (`storeConversation`): Currently forwards only `chatId, summary, tags` at line 141. Fix: forward `options.userMessage` and `options.assistantMessage` to `agentdb.storeConversation()`.
3. **AgentDBMemory** (`storeConversation`): Currently accepts only `(chatId, summary, tags, tier)`. Fix: extend signature to accept `userMessage` and `assistantMessage`, store them as separate fields in the SQLite `value` JSON blob.

This enables structured retrieval of individual user/assistant messages later.

### Bootstrap Wiring Order
`SessionSummarizer` requires both an `IAIProvider` (from `initializeAIProvider`) and a `UserProfileStore` (from `AgentDBMemory` inside `initializeMemory`). Both are available only after Phase 1 `Promise.all` resolves. Wiring sequence:

1. `resolveAndCacheEmbeddings(config)` → `cachedProvider` (BEFORE Promise.all)
2. `Promise.all([initializeAIProvider, initializeMemory(config, logger, cachedProvider), initializeChannel])` → `[providerInit, memoryManager, channel]`
3. Extract `providerManager` from `providerInit.manager`
4. Extract `userProfileStore` from `memoryManager` (via `AgentDBAdapter.getUserProfileStore()`)
5. Construct `SessionSummarizer(providerManager.getProvider(""), userProfileStore)` (AFTER Promise.all)
6. Pass `sessionSummarizer` to Orchestrator constructor

### Files to Modify
- `src/memory/unified/session-summarizer.ts` — NEW file
- `src/agents/orchestrator.ts` — session-end trigger, enhanced persist (3-level fix), wire SessionSummarizer
- `src/memory/unified/agentdb-memory.ts` — extend storeConversation signature
- `src/memory/unified/agentdb-adapter.ts` — pass userMessage/assistantMessage through
- `src/core/bootstrap.ts` — reorder init, create and wire SessionSummarizer per wiring sequence above

---

## Component 4: 4-Layer Context Injection

### Injection Order (in system prompt, every message)

**Layer 1 — User Profile** (direct SQL, <1ms):
```
## User Context
Name: {display_name}
Language: {language}
Communication Style: {active_persona}
Preferences: {verbosity}, {other prefs}
```

**Layer 2 — Last Session Summary** (from user_profiles.context_summary):
```
## Previous Session
{LLM-generated summary of last session: what was discussed, decisions made, open items}
```

**Layer 3 — Open Tasks** (from goal/task storage):
```
## Open Tasks
- {task description} — {status}
- {task description} — {status}
```

**Layer 4 — Semantic Memory** (real embedding search, 3-5 results):
```
## Relevant Memory
{semantically similar past conversations/notes, retrieved via HNSW with real embeddings}
```

### Implementation
- New method: `Orchestrator.buildContextLayers(chatId, userMessage)` → string
- Called at the start of `runAgentLoop()` before LLM call
- Each layer is optional — gracefully omitted if data unavailable
- Total injection target: <2000 tokens to avoid context bloat

### Interaction with MemoryRefresher (Re-Retrieval)
The existing `MemoryRefresher` system dynamically refreshes memory context mid-conversation using `<!-- re-retrieval:memory:start -->` markers. The 4-layer injection runs ONCE at conversation start; `MemoryRefresher` continues to run mid-loop as before.

To avoid duplication:
- `buildContextLayers()` uses different markers: `<!-- context-layers:start -->` ... `<!-- context-layers:end -->`
- `MemoryRefresher` continues to use `<!-- re-retrieval:memory:start -->` markers (unchanged)
- `MemoryRefresher` is updated to use real embeddings (it already receives `embeddingProvider` via orchestrator constructor at line 450)
- Layer 4 (Semantic Memory) content hashes are seeded into `MemoryRefresher.initialContentHashes` to prevent re-injection of the same memories

### Files to Modify
- `src/agents/orchestrator.ts` — new `buildContextLayers()`, seed MemoryRefresher hashes, replace current ad-hoc injection

---

## Component 5: AgentDBAdapter Stub Fixes

### Methods to Implement

| Method | Current | Fix |
|---|---|---|
| `getChatHistory()` | Returns `ok([])` | Delegate to `agentdb.getChatHistory()` |
| `storeNote()` | Returns stub ID | Delegate to `agentdb.storeNote()` |
| `storeEntry()` | Returns error | Delegate to `agentdb.storeEntry()` |
| `getEntry()` | Returns `none()` | Delegate to `agentdb.getById()` |
| `retrieveFromChat()` | Returns `ok([])` | Implement via chatId filter on retrieve |

### New Adapter Methods
- `getUserProfileStore(): UserProfileStore` — exposes profile store to orchestrator

### Files to Modify
- `src/memory/unified/agentdb-adapter.ts` — replace stubs with real implementations

---

## Testing Strategy

### Unit Tests
- `UserProfileStore`: CRUD operations, upsert idempotency, persona persistence
- Embedding provider wiring: verify real embeddings flow through AgentDBMemory
- Context injection: verify all 4 layers render correctly
- Onboarding flow: mock ask_user tool responses, verify profile creation
- Session-end summarization: verify ConsolidationEngine trigger and profile update

### Integration Tests
- Full bootstrap with embedding provider → memory → orchestrator wiring
- Cross-session persona persistence: set persona → restart → verify restore
- Cross-session memory: store conversation → new session → verify retrieval
- Language preference: set in config → verify onboarding language → verify runtime language

### Existing Test Preservation
- All 3,229 existing tests must continue to pass
- Memory tests that mock AgentDBMemory must be updated for new embeddingProvider config
- Adapter tests must be updated for new real implementations
- `initializeMemory()` is exported and called directly in `bootstrap.test.ts` — the new optional `embeddingProvider?` third parameter is backward-compatible (defaults to `undefined`), so existing test call sites remain valid without changes
- `AgentDBMemory.storeConversation()` extended params are optional — existing test calls without them continue to work

---

## Migration & Backwards Compatibility

- New `user_profiles` table created automatically on AgentDB init via `CREATE TABLE IF NOT EXISTS` (idempotent)
- **HNSW dimension migration**: On first boot with a real embedding provider, if existing HNSW index dimensions differ from the provider's dimensions, the index is rebuilt from scratch. All existing entries are re-embedded with the new provider. This is a one-time cost at startup.
- If no embedding provider is available: hash-based fallback continues, no index corruption
- `EMBEDDING_PROVIDER=auto` remains default — no breaking config changes
- `LANGUAGE_PREFERENCE` defaults to `en` — no change for existing users
- `AgentDBMemory.storeConversation()` signature extension is backward-compatible (new params are optional)

---

## Dependencies

- No new npm packages required
- Uses existing: better-sqlite3, HNSW vector store, ConsolidationEngine, ask_user tool
- LLM calls for summarization use the configured provider (same as chat)

---

## Success Criteria

1. Agent remembers user's name, language, and persona across restarts
2. Agent can reference previous session context ("last time we discussed X")
3. Semantic memory search returns genuinely relevant results (not random)
4. First-time users get a personalized onboarding experience
5. Language preference flows from setup wizard through entire UX
6. All 3,229+ existing tests pass
7. Jarvis-level continuity: the agent feels like it knows you
