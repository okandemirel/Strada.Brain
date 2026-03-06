# Codebase Concerns

**Analysis Date:** 2026-03-06

## Tech Debt

**Legacy Memory System Not Replaced (FileMemoryManager still active):**
- Issue: Bootstrap (`src/core/bootstrap.ts:320`) instantiates `FileMemoryManager` (TF-IDF based, 1148 lines), while the newer `AgentDBMemory` (HNSW vector-based, 1582 lines) exists in `src/memory/unified/agentdb-memory.ts` but is never wired into `bootstrap()`. The migration system in `src/memory/unified/migration.ts` (490 lines) bridges them but is also not called at startup.
- Files: `src/core/bootstrap.ts`, `src/memory/file-memory-manager.ts`, `src/memory/unified/agentdb-memory.ts`, `src/memory/unified/migration.ts`
- Impact: The application runs on the legacy TF-IDF retrieval path, missing the 150x-12,500x performance improvement promised by HNSW vector search. All `AgentDBMemory` code is dead code in production.
- Fix approach: Replace `FileMemoryManager` instantiation in `bootstrap()` with `AgentDBMemory`, run migration on first startup, remove `FileMemoryManager` once verified.

**Backup Files Committed to Source:**
- Issue: `.bak` files exist in the source tree and should be removed.
- Files: `src/memory/unified/agentdb-memory.ts.bak`, `src/memory/unified/migration.ts.bak`
- Impact: Confusing for developers; stale code that may mislead future changes.
- Fix approach: Delete both `.bak` files and add `*.bak` to `.gitignore`.

**Stale Root-Level Files:**
- Issue: Several leftover/stale files exist at the project root: `firebase-debug.log`, `strata-brain.log`, `test.log`, `Dockerfile.backup`, `docker-compose.backup.yml`.
- Files: `firebase-debug.log`, `strata-brain.log`, `test.log`, `Dockerfile.backup`, `docker-compose.backup.yml`
- Impact: Clutters the repository; log files may contain sensitive runtime data.
- Fix approach: Delete these files, ensure `.gitignore` excludes `*.log` and `*.backup` patterns.

**Autonomy Instances Duplicated Per Request:**
- Issue: `ErrorRecoveryEngine`, `TaskPlanner`, and `SelfVerification` are instantiated fresh on every single message/agent loop invocation in `src/agents/orchestrator.ts:225-227` and `src/agents/orchestrator.ts:571-573`. Meanwhile, `bootstrap()` also creates separate `ErrorRecoveryEngine` and `TaskPlanner` instances (`src/core/bootstrap.ts:462-468`) that are passed to the learning system. The per-request instances in the orchestrator have no learning hooks wired, so error recovery learning does not function inside the agent loop.
- Files: `src/agents/orchestrator.ts` (lines 225-227, 571-573), `src/core/bootstrap.ts` (lines 462-468)
- Impact: Error patterns learned in `bootstrap()`'s `ErrorRecoveryEngine` are never available during actual agent execution. Learning is effectively disconnected from the main request path.
- Fix approach: Inject the bootstrap-created `ErrorRecoveryEngine` and `TaskPlanner` into the `Orchestrator` constructor instead of creating new throwaway instances per request.

**Massive Type Casting with `as unknown as`:**
- Issue: 40+ occurrences of `as unknown as` double-casts across the codebase, heavily concentrated in `src/memory/unified/agentdb-memory.ts` (15+ occurrences) and `src/memory/file-memory-manager.ts` (10+ occurrences). This is a type system escape hatch that defeats TypeScript's safety guarantees.
- Files: `src/memory/unified/agentdb-memory.ts`, `src/memory/file-memory-manager.ts`, `src/memory/unified/migration.ts`, `src/learning/pipeline/learning-pipeline.ts:348`
- Impact: Runtime type errors become possible; refactoring is unsafe because the compiler cannot catch mismatches. The `learning-pipeline.ts:348` case is particularly dangerous: it casts `this.storage` to access internal `db` property directly, breaking encapsulation.
- Fix approach: Align `UnifiedMemoryEntry` and `MemoryEntry` interfaces to share a common base, or create proper adapter functions. Add a public method to `LearningStorage` for evolution proposals instead of casting to access `db`.

**Plugin System Has No Sandboxing:**
- Issue: `src/plugins/registry.ts` has a prominent `TODO: Implement plugin sandboxing via vm.runInNewContext or worker_threads`. Plugins run with full Node.js process access.
- Files: `src/plugins/registry.ts`
- Impact: Any third-party plugin can access the filesystem, network, and all secrets. This is acceptable only if plugins are exclusively first-party.
- Fix approach: If third-party plugins are planned, implement `worker_threads` isolation with restricted APIs. If plugins remain first-party only, document the trust model and remove the TODO.

**SIEM Integration is a No-Op:**
- Issue: `sendToSiem()` in `src/audit/security-audit.ts:622-642` constructs a payload with `void { ... }` (which evaluates and discards the object), logs a debug message, and never actually sends anything.
- Files: `src/audit/security-audit.ts` (lines 622-642)
- Impact: Security event forwarding to SIEM appears functional but does nothing. The `void { ... }` pattern silently discards data.
- Fix approach: Either implement actual SIEM HTTP posting or remove the dead code path and its configuration.

**AgentDBMemory compact() Always Returns Zero:**
- Issue: `compact()` at `src/memory/unified/agentdb-memory.ts:816` always returns `{ freedBytes: 0 }` with a TODO comment.
- Files: `src/memory/unified/agentdb-memory.ts` (line 816)
- Impact: Callers cannot track compaction effectiveness. Minor issue since the class is not wired into production yet.
- Fix approach: Calculate freed bytes by comparing entry/index sizes before and after cleanup.

## Known Bugs

**Hash-Based Fallback Embedding is Not Semantic:**
- Symptoms: When no embedding provider is configured, `AgentDBMemory.generateEmbedding()` (`src/memory/unified/agentdb-memory.ts:1052-1074`) uses a character-code hash to fill a vector. This produces arbitrary numeric vectors that have no semantic meaning.
- Files: `src/memory/unified/agentdb-memory.ts` (lines 1052-1074)
- Trigger: Running without an embedding API key configured while using `AgentDBMemory`.
- Workaround: Ensure an embedding provider (OpenAI, Gemini, etc.) is always configured when memory is enabled.

**learning.db Schema Migration Not Automated:**
- Symptoms: Existing `learning.db` databases from before the agent-evolution work lack the `embedding TEXT` column on the `instincts` table, causing SQLite errors.
- Files: `src/learning/storage/learning-storage.ts` (schema at line 50)
- Trigger: Upgrading from a pre-evolution version without manually running `ALTER TABLE instincts ADD COLUMN embedding TEXT`.
- Workaround: Manually run the ALTER TABLE statement, or delete `learning.db` to recreate it.

**Gemini Null Embeddings for Certain Files:**
- Symptoms: Gemini embedding API returns null vectors for some C# files (e.g., `AutoKeystore.cs`), causing RAG indexing failures for those files.
- Files: `src/rag/embeddings/` (Gemini provider), `src/rag/rag-pipeline.ts`
- Trigger: Indexing specific Unity C# files with unusual content patterns.
- Workaround: Skip files that produce null embeddings; the pipeline handles this with a warning log.

## Security Considerations

**Plugin System Runs Unsandboxed:**
- Risk: Any registered plugin has full access to the Node.js process: filesystem, network, environment variables (including API keys).
- Files: `src/plugins/registry.ts`
- Current mitigation: Warning comment in source code. No actual enforcement.
- Recommendations: Implement `worker_threads`-based isolation if external plugins are ever loaded. At minimum, add filesystem and network ACLs.

**Hardcoded Turkish Language in Dependency Setup Flow:**
- Risk: The dependency setup prompts in `src/agents/orchestrator.ts:345-387` are hardcoded in Turkish ("Strada.Core kuruluyor...", "evet/hayir"). This is not a security risk per se, but the `text.includes("evet")` matching at line 345 could be unintentionally triggered by Turkish text in non-Turkish-speaking user contexts.
- Files: `src/agents/orchestrator.ts` (lines 345-387, 398)
- Current mitigation: None.
- Recommendations: Internationalize these strings or match more precisely.

**WhatsApp Channel Uses `@ts-expect-error` for Dynamic Import:**
- Risk: The baileys WhatsApp library import at `src/channels/whatsapp/client.ts:119` uses `@ts-expect-error` to suppress type checking on a dynamic import, bypassing compile-time verification.
- Files: `src/channels/whatsapp/client.ts` (line 119)
- Current mitigation: Runtime error handling wraps the import.
- Recommendations: Create a proper type declaration file for the baileys module.

**Slack App Accesses Internal Properties:**
- Risk: `src/channels/slack/app.ts:193-195` uses `@ts-expect-error` twice to access internal Slack SDK properties, which could break on SDK updates.
- Files: `src/channels/slack/app.ts` (lines 193-195)
- Current mitigation: The `@ts-expect-error` comments document the intentional override.
- Recommendations: Check if newer Slack SDK versions expose these properties officially.

## Performance Bottlenecks

**System Prompt Rebuilt on Every Agent Loop Iteration:**
- Problem: Inside `runAgentLoop()`, the system prompt is reconstructed by appending PAOR phase prompts, memory context, RAG context, and analysis summaries on every loop iteration (`src/agents/orchestrator.ts:602-614`). Memory retrieval, RAG search, and analysis cache lookups happen before the loop but the PAOR prompt changes per iteration.
- Files: `src/agents/orchestrator.ts` (lines 500-614)
- Cause: The system prompt grows with each injected context (memory, RAG, analysis, planning, reflection). For complex tasks with 10+ iterations, this means sending increasingly large prompts to the LLM.
- Improvement path: Cache the base system prompt (memory + RAG + analysis) once before the loop. Only append the changing PAOR phase prompt per iteration.

**AgentDBMemory TF-IDF Retrieval Iterates All Entries:**
- Problem: `retrieve()` in `src/memory/unified/agentdb-memory.ts:487-520` computes TF-IDF vectors for every entry in memory on each query, performing O(n) cosine similarity calculations.
- Files: `src/memory/unified/agentdb-memory.ts` (lines 487-520)
- Cause: The TF-IDF path is a backward-compatibility fallback that doesn't leverage the HNSW index.
- Improvement path: Use `retrieveSemantic()` (which uses HNSW) as the primary path. The TF-IDF path should only be used when HNSW is unavailable.

**storeEntries() is Sequential, Not Batched:**
- Problem: `storeEntries()` at `src/memory/unified/agentdb-memory.ts:463-481` calls `storeEntry()` in a serial loop. Each call generates an embedding, inserts into HNSW, persists to SQLite, and enforces tier limits individually.
- Files: `src/memory/unified/agentdb-memory.ts` (lines 463-481)
- Cause: No batch optimization for bulk inserts.
- Improvement path: Batch embedding generation, use SQLite transactions for bulk inserts, and enforce tier limits once after all entries are stored.

**Orchestrator Streaming Type Assertions:**
- Problem: The `streamResponse()` method at `src/agents/orchestrator.ts:847-911` uses inline type assertions to call streaming methods on the channel, creating a new anonymous type on each call.
- Files: `src/agents/orchestrator.ts` (lines 847-911)
- Cause: The `IChannelAdapter` interface doesn't include optional streaming methods.
- Improvement path: Add `startStreamingMessage`, `updateStreamingMessage`, and `finalizeStreamingMessage` as optional methods on `IChannelAdapter` or use the existing `IStreamingProvider` pattern.

## Fragile Areas

**Orchestrator (1157 lines, God Object):**
- Files: `src/agents/orchestrator.ts`
- Why fragile: This single file handles session management, PAOR state machine, message processing, tool execution, streaming, dependency setup flow, write confirmations, rate limiting, memory injection, RAG injection, and autonomy tracking. All cross-cutting concerns converge here.
- Safe modification: Extract the PAOR state machine logic (lines 570-840) into a dedicated class. Extract the dependency setup flow (lines 339-413) into a separate handler. Extract streaming logic (lines 847-911) into a streaming adapter.
- Test coverage: `src/agents/orchestrator.test.ts` exists but cannot fully cover the deeply nested logic paths.

**Memory Interface Compatibility Layer:**
- Files: `src/memory/memory.interface.ts`, `src/memory/unified/unified-memory.interface.ts`, `src/memory/unified/agentdb-memory.ts`
- Why fragile: `AgentDBMemory` implements `IUnifiedMemory` but must also satisfy `IMemoryManager` (the interface used by the orchestrator). This is achieved through 15+ `as unknown as` casts, meaning any interface change will silently break at runtime instead of at compile time.
- Safe modification: Always run the full test suite after any change to memory interfaces. Consider creating a proper adapter class instead of inline casts.
- Test coverage: `src/memory/unified/unified-memory.test.ts` covers the unified interface; `src/memory/file-memory-manager.ts` tests cover the legacy interface. The gap is in the compatibility layer between them.

**Learning Pipeline Direct DB Access:**
- Files: `src/learning/pipeline/learning-pipeline.ts` (line 348)
- Why fragile: The pipeline casts `this.storage` to `{ db: ... }` to directly run SQL on the storage's internal SQLite database, bypassing the `LearningStorage` API entirely. If `LearningStorage` changes its internal `db` field name or type, this will fail silently.
- Safe modification: Add a public `insertEvolutionProposal()` method to `LearningStorage` and remove the direct DB access cast.
- Test coverage: Not specifically tested for this cast path.

**PAOR Reflection Decision Parsing:**
- Files: `src/agents/orchestrator.ts` (lines 1122-1133, function `parseReflectionDecision`)
- Why fragile: The agent loop's control flow depends on regex-matching `**DONE**`, `**REPLAN**`, or `**CONTINUE**` from LLM output text. If the LLM changes formatting (e.g., uses backticks, different casing, or extra whitespace), the parser defaults to `CONTINUE`, potentially causing infinite loops up to `MAX_TOOL_ITERATIONS` (50).
- Safe modification: Add more robust parsing (case-insensitive search, strip markdown formatting). Consider structured output instead of text parsing.
- Test coverage: The regex and fallback logic should be directly unit tested.

## Scaling Limits

**In-Memory Session Storage (100 sessions max):**
- Current capacity: `MAX_SESSIONS = 100` in `src/agents/orchestrator.ts:38`. Sessions are stored in a `Map<string, Session>` with LRU eviction.
- Limit: At 101+ concurrent chats, the oldest session is silently evicted, losing conversation history.
- Scaling path: Persist sessions to SQLite or Redis. The existing `AgentDBMemory` could serve as a session store.

**In-Memory HNSW Index:**
- Current capacity: Configurable via `HNSW_MAX_ELEMENTS` env var (default 100,000) in `src/core/bootstrap.ts:390`.
- Limit: HNSW index lives entirely in memory. At 100K entries with 1536-dimension vectors, this consumes ~600MB RAM.
- Scaling path: Use disk-backed vector stores or shard the index. Consider `hnswlib-node`'s built-in persistence more aggressively.

**SQLite Concurrency:**
- Current capacity: Both `LearningStorage` (`src/learning/storage/learning-storage.ts`) and `AgentDBMemory` use SQLite with WAL mode.
- Limit: SQLite supports one writer at a time. Under heavy concurrent load (multiple channels, background tasks), write contention could cause `SQLITE_BUSY` errors.
- Scaling path: Use connection pooling with retry logic, or migrate to PostgreSQL for multi-writer support.

## Dependencies at Risk

**Playwright as a Runtime Dependency:**
- Risk: `playwright` (v1.58.2) is listed as a production dependency in `package.json`, adding ~100MB+ to the install. It is used only for the `browser_automation` tool (`src/agents/tools/browser-automation.ts`), which most users may never invoke.
- Impact: Significantly increases install time and Docker image size.
- Migration plan: Move `playwright` to an optional/peer dependency. Lazy-import it only when the browser tool is first used.

**hnswlib-node Native Binary:**
- Risk: `hnswlib-node` (v3.0.0) requires native compilation. Build failures on some platforms (Windows ARM, Alpine Linux musl) are common.
- Impact: Deployment to constrained environments may fail.
- Migration plan: Provide a pure-JS fallback (e.g., the existing TF-IDF path) and make HNSW optional at runtime.

**@slack/bolt and discord.js Always Loaded:**
- Risk: All channel SDKs (`grammy`, `discord.js`, `@slack/bolt`, baileys) are loaded at import time in `src/core/bootstrap.ts:38-43` regardless of which channel is selected.
- Impact: Increased startup time and memory usage. The WhatsApp baileys library in particular has known stability issues.
- Migration plan: Use dynamic `import()` to load only the selected channel's SDK.

## Missing Critical Features

**No Automated Schema Migrations:**
- Problem: SQLite databases (`learning.db`, `tasks.db`, memory databases) use `CREATE TABLE IF NOT EXISTS` but have no version-tracked migration system. Schema changes require manual intervention or database deletion.
- Blocks: Safe upgrades between versions; the known `learning.db` embedding column issue is a direct consequence.

**AgentDBMemory Not Wired to Production:**
- Problem: The entire unified memory system (`src/memory/unified/`) including HNSW semantic search, 3-tier memory, MMR diversity, and hybrid retrieval is implemented but never used in production. Bootstrap still uses `FileMemoryManager`.
- Blocks: Achieving the Phase 2 "real memory" goal from the agent evolution roadmap.

**No Graceful Degradation for Missing API Keys:**
- Problem: If an AI provider's API key becomes invalid mid-session, the error surfaces as a generic "An error occurred" message. The fallback chain in `src/agents/providers/fallback-chain.ts` handles provider failures but not mid-session credential rotation.
- Blocks: Production reliability in multi-provider setups.

## Test Coverage Gaps

**Orchestrator PAOR State Machine:**
- What's not tested: The full PAOR cycle (PLANNING -> EXECUTING -> REFLECTING -> REPLANNING -> EXECUTING -> DONE) with real tool calls, error injection, and reflection parsing. The `parseReflectionDecision()` function has no dedicated unit tests.
- Files: `src/agents/orchestrator.ts` (lines 570-840), `src/agents/orchestrator.test.ts`
- Risk: Regression in the agent loop's decision-making logic could cause infinite loops, premature termination, or incorrect phase transitions.
- Priority: High

**Memory Interface Compatibility:**
- What's not tested: The `as unknown as` casting between `UnifiedMemoryEntry` and `MemoryEntry` types is not validated at runtime. If fields diverge, data corruption occurs silently.
- Files: `src/memory/unified/agentdb-memory.ts` (all cast points)
- Risk: Activating `AgentDBMemory` in production could cause runtime failures at any cast point.
- Priority: High (blocking the AgentDBMemory activation)

**Bootstrap Error Paths:**
- What's not tested: The `initializeLearning()` catch block (`src/core/bootstrap.ts:477-484`) returns fallback `TaskPlanner`/`ErrorRecoveryEngine` instances without learning hooks. This degraded state is not tested.
- Files: `src/core/bootstrap.ts` (lines 435-485)
- Risk: If the learning system fails to initialize, the application runs without error learning, and this silent degradation is not validated.
- Priority: Medium

**Streaming Response Path:**
- What's not tested: The `streamResponse()` method (`src/agents/orchestrator.ts:847-911`) uses inline type assertions and has no dedicated tests. Errors in streaming message lifecycle (start/update/finalize) are caught and logged but not tested.
- Files: `src/agents/orchestrator.ts` (lines 847-911)
- Risk: Streaming bugs manifest as truncated or duplicated messages to users.
- Priority: Medium

**Channel-Specific Rate Limiters:**
- What's not tested: Discord (`src/channels/discord/rate-limiter.ts`) and Slack (`src/channels/slack/rate-limiter.ts`) have independent rate limiter implementations. Slack's has tests; Discord's does not have a dedicated test file.
- Files: `src/channels/discord/rate-limiter.ts`
- Risk: Discord API rate limit violations could cause bot disconnection.
- Priority: Low

---

*Concerns audit: 2026-03-06*
