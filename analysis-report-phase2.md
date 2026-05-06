# Strada.Brain — Deep System Analysis Report (Phase 2)

> **Runtime, Async Flow, Data Flow, Resource Lifecycle & Security Surface Analysis**
> 
> 18 specialized agents analyzed the codebase from a **runtime behavior** perspective.
> 2 agents timed out (Async Flow & Concurrency, File System Atomicity) but were later re-run.
> Phase 2 covers a completely different angle from Phase 1 (static code review).

---

## Summary

| Category | Findings | Critical P0 | High P1 | Medium P2 | Low P3 |
|----------|----------|-------------|---------|-----------|--------|
| State Machine Validity | 8 | 1 | 2 | 3 | 2 |
| Data Mutation & Side Effects | 20 | 3 | 5 | 7 | 5 |
| Resource Lifecycle & Leaks | 12 | 2 | 5 | 3 | 2 |
| Error Propagation & Recovery | 32 | 4 | 8 | 12 | 8 |
| LLM Prompt Injection Surface | 15 | 3 | 5 | 5 | 2 |
| Configuration Drift | 15 | 2 | 4 | 5 | 4 |
| Plugin/Skill Code Execution | 10 | 3 | 3 | 3 | 1 |
| Memory Pressure & Large Objects | 12 | 1 | 3 | 5 | 3 |
| WebSocket & Streaming Integrity | 8 | 1 | 2 | 3 | 2 |
| Multi-tenant Isolation | 12 | 1 | 3 | 5 | 3 |
| Deployment & Rollback Safety | 8 | 2 | 3 | 2 | 1 |
| Observability Gaps | 18 | 4 | 6 | 5 | 3 |
| API Contract Stability | 12 | 1 | 3 | 5 | 3 |
| Background Job Reliability | 18 | 3 | 5 | 6 | 4 |
| Cache Coherence | 10 | 2 | 3 | 3 | 2 |
| Entropy & Randomness Security | 12 | 1 | 4 | 4 | 3 |
| Startup/Shutdown Sequence | 8 | 1 | 3 | 3 | 1 |
| **TOTAL** | **~230** | **35** | **61** | **81** | **53** |

> **Phase 1 total: 232 findings | Phase 2 total: ~230 findings**
> **Combined: ~462 findings across both phases**

---

## 1. State Machine Validity (PAOR Loop)

### 🔴 P0 — `AgentPhase.COMPLETE` is a Dead State
`VALID_TRANSITIONS` allows transitions to `COMPLETE`, but **no runtime code ever calls `transitionPhase(state, AgentPhase.COMPLETE)`**. Orchestrator loops simply `return` on success, leaving phase at `REFLECTING` or `EXECUTING`. The state machine design and runtime behavior are inconsistent.

### 🔴 P0 — `transitionToVerifierReplan` Bypasses `VALID_TRANSITIONS`
`orchestrator-phase-telemetry.ts:86-89` directly assigns `REPLANNING` without checking `VALID_TRANSITIONS`. This allows invalid transitions like `PLANNING → REPLANNING` and `REPLANNING → REPLANNING` when the verifier requests replan during end-turn handling.

### 🟡 P2 — `FAILED` Transition is a "Zombie Transition"
Catch blocks call `transitionPhase(state, AgentPhase.FAILED)` and then immediately `throw error`. Since `agentState` is a local variable, the `FAILED` phase never escapes the function. The `finally` block records metrics with the new phase, but no other code sees it.

### 🟢 Positive Finding — State Mutation Atomicity
All state mutations in the orchestrator use immutable spread: `agentState = { ...agentState, field: value }`. No direct mutations like `agentState.phase = newPhase`. No intermediate inconsistent states.

---

## 2. Data Mutation & Side Effects

### 🔴 P0 — `metrics.ts:108` — `getRecentToolErrors()` Leaks Mutable References
Returns `Object.fromEntries(this.recentToolErrors)`, which leaks internal array references. Callers can mutate `MetricsCollector`'s internal state directly.

### 🔴 P0 — `agentdb-adapter.ts:464` — `MemoryEntry` Readonly Contract Violated
`AdapterInternalEntry = Mutable<MemoryEntry>` cast bypasses readonly protections. `Object.assign(metadata, typedUpdates)` creates nested reference sharing between stored and caller objects.

### 🔴 P0 — `config.ts:3280` — Global `_env` Race Condition
Module-level `let _env: Record<string, string | undefined> = process.env`. `loadConfig()` mutates `_env` and restores it in `finally`. Parallel `loadConfig()` calls create race conditions where one call's `_env` change corrupts another's `process.env` read.

### 🟡 P2 — `orchestrator.ts` — `session.messages` and `stepResults` Unbounded Growth
`session.messages.push()` pattern used 20+ times. `stepResults` grows without trimming. `maybeCompactSession` trims messages but not `stepResults`. Long-running tasks cause unbounded memory growth.

---

## 3. Resource Lifecycle & Leak Detection

### 🔴 P0 — `bootstrap.ts:1447` — Canvas DB Not Closed on Shutdown
`canvasDb = new Database(canvasDbPath)` opened but never added to shutdown sequence. `dashboard.stop()` only closes HTTP server, not `canvasStorage`/`canvasDb`. Catch block also missing `canvasDb?.close()`.

### 🔴 P0 — `web/channel.ts:803` — `pendingConfirmations` Key Mismatch Causes Timer Leak
`requestConfirmation` sets key = `randomUUID()` (confirmId). `handleDisconnect` looks up by `chatId`. Keys never match — 5-minute confirmation timeout timers leak on every disconnect + confirmation combination.

### 🟠 P1 — 4x Spawn SIGKILL Fallback Missing
- `auto-updater.ts:318` — `spawnWithTimeout` no SIGKILL fallback
- `web/channel.ts:1395` — verify spawn no SIGKILL fallback
- `readiness-checker.ts:121` — test command spawn no SIGKILL fallback
- `deployment-executor.ts:246` — deploy script spawn no SIGKILL fallback

### 🟠 P1 — `message-router.ts` — Shutdown Doesn't Clean Pending Batch Timers
`MessageRouter` has no `dispose()` method. `pendingTaskBatches` timer'ları shutdown sırasında temizlenmiyor.

---

## 4. Error Propagation & Recovery

### 🔴 P0 — ~22 Fail-Silent Patterns
Critical ones:
- `channels/matrix/channel.ts:163` — message handler error completely swallowed
- `channels/irc/channel.ts:113` — same pattern
- `orchestrator.ts:5234` — stream timeout suppress with zero logging
- `bootstrap.ts:887` — framework prompt generator wiring error swallowed
- `agent-core.ts:350` — instinct outcome recording error swallowed
- `tasks/background-executor.ts:845` — workspace lease release error swallowed
- `vault/write-hook.ts:23` — vault write-hook async error swallowed

### 🟠 P1 — `wrapError()` Missing `Error.cause` Connection
`wrapError()` puts original error info in `context` metadata but never sets native `Error.cause`. Error chain debugging cannot traverse via `error.cause`.

### 🟠 P1 — `withRetry()` is Dead Code
Defined in `src/common/errors.ts:561-607` but **never used anywhere** in the project. Maintenance burden.

### 🟠 P1 — `Promise.all` Instead of `Promise.allSettled` in 4 Places
- `vault/vault-registry.ts:72` — one vault fail kills all vault search
- `vault/vault-search-tool.ts:154` — same
- `agents/context/strada-knowledge.ts:462` — context enrichment fails entirely
- `rag/docs/composite-rag-pipeline.ts:45` — doc/code pipeline init coupled

---

## 5. LLM Prompt Injection Surface

### 🔴 P0 — User Messages Go to LLM Without Any Sanitization
`processMessage()` and `runBackgroundTask()` put user content directly into `session.messages` as `user` role. `sanitizePromptInjection()` is never called on user input. A user can inject `ignore previous instructions` directly.

### 🔴 P0 — Tool Results Go to LLM Without Injection Sanitization
`executeToolCalls()` calls `sanitizeToolResult()` which only redacts API keys and caps length. **Prompt injection payloads in tool results are never filtered.** A malicious file, web page, or shell output can inject instructions.

### 🔴 P0 — `sanitizePromptInjection()` Has Great Coverage But Wrong Targets
The function covers envelope tags, inline overrides, role hijacking, zero-width chars, base64 heuristic, homoglyphs — but is **only used on system prompt context layers and retrieval results**. It is **never** applied to user messages or tool results.

### 🟠 P1 — System Prompt Leakage via Supervisor Synthesis
`orchestrator.ts:1603-1607` sends `systemPrompt` directly to the synthesis provider. If synthesis provider is a different/external provider, system prompt content is exposed.

### 🟡 P2 — Encoding Bypasses Not Filtered
Leetspeak (`1gn0r3`), rot13, URL encoding, HTML entity encoding are not filtered by `sanitizePromptInjection()`.

---

## 6. Configuration Drift

### 🔴 P0 — `z.coerce.boolean()` Makes `"false"` → `true`
`vault.enabled` and `obsidian.enabled` use `z.coerce.boolean().default(false)`. `Boolean("false") === true`, so `STRADA_VAULT_ENABLED=false` or `OBSIDIAN_ENABLED=false` **enables** the feature.

### 🔴 P0 — `websocketDashboardPort` Default = 3100, Constants Say 3101
`config.ts` default 3100, `constants.ts` says 3101. If both dashboards active, cross-field validation fails.

### 🟠 P1 — 8+ Env Vars Missing from Central Config
`STRADA_MCP_REPO_URL`, `OLLAMA_BASE_URL`, `STT_MODE`, `STT_MODEL`, `STT_CACHE_DIR`, `SETUP_WIZARD_PORT`, `SOUL_FILE_*`, `WORKSPACE_COPY_EXCLUDES`, `STRADA_INTERACTIVE_TOKEN_BUDGET` — all read directly from `process.env` without going through `loadConfig()`.

### 🟠 P1 — `BudgetConfigStore` Reads `process.env` Directly
`budget-config-store.ts:79-86` reads `process.env` on every call, bypassing `loadConfig()` cache. Runtime `process.env` mutations cause budget config to diverge from main config.

### 🟡 P2 — `.env.example` File Missing
200+ env vars exist but no `.env.example` for new developers/operators.

---

## 7. Plugin/Skill Arbitrary Code Execution

### 🔴 P0 — No Sandboxing for Skills or Plugins
Skills load via `import()` in the **main Node.js process** with full OS privileges. `PluginPermissions` interface exists (filesystem, network, childProcess, memoryLimitBytes, cpuTimeoutMs) but is **never enforced anywhere**.

### 🔴 P0 — Security Mechanisms Use Exact Name Match Only
`DMPolicy`, `ReadOnlyGuard`, `WRITE_TOOLS`, `DESTRUCTIVE_TOOLS` all use exact name matching. Skill/plugin/dynamic tools with `skill_*`, `plugin_*`, `dynamic_*` prefixes completely bypass all security checks.

### 🔴 P0 — All Skill/Plugin Tools Hardcoded as `dangerous: false, readOnly: true`
`bootstrap.ts:752` and `tool-registry.ts:174` register all skill/plugin tools with hardcoded safe metadata, regardless of what the tool actually does.

### 🟠 P1 — `skill-loader.ts:229` — Symlink Escape via `stat()`
`resolveEntryPoint` uses `stat()` which follows symlinks. A symlink in a skill directory can point to `/etc/shadow` or any external JS file.

### 🟠 P1 — `PluginLoader.reloadAll()` Race Condition
Two concurrent `reloadAll()` calls: first clears `this.loadedPlugins`, second copies empty Map. Plugin state corruption.

---

## 8. Memory Pressure & Large Objects

### 🔴 P0 — `web/channel.ts:719` — Static File Serving Loads Entire File to Memory
`readFile(candidate)` loads entire file into memory. Large assets (videos, JS bundles) cause single large buffer allocation. Should use `createReadStream().pipe(res)`.

### 🟠 P1 — `hnsw-vector-store.ts` — `deletedIndices` Never Compacted
Soft-deleted IDs accumulate in `deletedIndices` Set forever. Heap memory grows with deletions.

### 🟠 P1 — `web/channel.ts:178` — `streamSentLengths` Leaks on Abandoned Streams
Code comment explicitly admits: *"streamSentLengths entries are only cleaned in finalizeStreamingMessage. If a stream is abandoned, the entry will leak until the next server restart."*

### 🟠 P1 — `consolidation-engine.ts` — `entries` Map Retains All Memory References
Constructor receives `entries: Map<string, MemoryEntryLike>` and holds reference to all memory entries permanently, even when engine is idle.

---

## 9. WebSocket & Streaming Integrity

### 🔴 P0 — `streamSentLengths` Not Cleared on Disconnect or Shutdown
Client disconnect during active stream leaves Map entry permanently. Server shutdown also doesn't call `streamSentLengths.clear()`.

### 🟠 P1 — No Heartbeat in Web Channel
Dashboard WS has 30s ping/pong, but web channel has none. Half-open connections (client cable pulled, TCP timeout not reached) are never detected. Server continues streaming to dead sockets.

### 🟠 P1 — No Backpressure Handling
`ws.send()` is called without checking `ws.bufferedAmount`. Slow clients cause buffer buildup and potential memory issues.

### 🟡 P2 — Empty `stream_end` Deletes Message on Client
If provider returns empty stream, `stream_end` with `seText === ""` causes client to remove the message entirely (`store.removeMessage(streamMsg.id)`).

---

## 10. Multi-tenant Isolation

### 🟠 P1 — WhatsApp `pendingConfirmations` Uses `chatId` as Key
Same chat can have multiple confirmation requests — later overwrites earlier. Different users in same group chat can collide.

### 🟠 P1 — Web Workspace Bus Events Have No Ownership Check
`monitor:move_task`, `monitor:retry_task`, `monitor:cancel_task` events accept any taskId from any connected client without verifying chatId/task ownership.

### 🟠 P1 — `storeNote()` Doesn't Accept `chatId`
Notes stored without session identifier. Different conversation scopes in same agent can see each other's notes.

### 🟡 P2 — `countFiles` in `file-manage.ts` No Symlink Cycle Check
Recursive file counting without symlink detection → infinite recursion / stack overflow on symlink loop.

---

## 11. Deployment & Rollback Safety

### 🔴 P0 — No Automatic Rollback on Deployment Failure
Deployment script fails → only SQLite log entry + `recordFailure()`. No compensating action, no partial state cleanup, no rollback script execution.

### 🔴 P0 — `/health` Endpoint Returns Fake Data
`clients: 0` is a hardcoded constant. No actual WebSocket client count, no DB connection check, no disk space check, no error rate check.

### 🟠 P1 — `DeploymentExecutor.execute()` is Public
Any plugin or injected code can call `daemonContext.deploymentExecutor.execute()` directly, bypassing the approval queue entirely.

### 🟠 P1 — Post-Verify Failures Don't Count Toward Circuit Breaker
`post_verify_failed` results don't call `circuitBreaker.recordFailure()`, so the breaker never learns from post-verify failures.

### 🟡 P2 — No Zero-Downtime Deploy
Single instance, no blue/green, no canary, no request drain before deploy.

---

## 12. Observability Gaps

### 🔴 P0 — PrometheusMetrics is a "Ghost" Instance
`PrometheusMetrics` is created and `start()`ed in bootstrap, but **no service ever sends data to it**. `recordLLMLatency()`, `recordMessageDuration()`, `recordRequestDuration()` are defined but never called.

### 🔴 P0 — Zero Alerting
`AlertManager` exists but `addRule()` is never called. `prometheus.yml` has `rule_files` and `alerting` blocks commented out. Operator receives no alerts for any failure.

### 🔴 P0 — Zero Tracing/Correlation
No `traceId`, `spanId`, or `correlationId` in any log entry. A tool execution error cannot be traced back to which LLM turn, which request, or which user it belonged to.

### 🔴 P0 — `MetricsCollector` Never Forwards to Prometheus
`recordTokenUsage()` only pushes to in-memory array. Prometheus `recordTokens()` is never called. Token usage metrics are invisible to Prometheus.

### 🟠 P1 — Metric Cardinality Bombs
`strada_llm_latency_seconds` uses `model` label — cardinality explodes with new models. `tokens_total{type="total"}` is redundant (input + output = total).

---

## 13. API Contract Stability

### 🔴 P0 — No DB Migration Framework for Any SQLite DB
AgentDB, vault, learning.db, goals.db, metrics storage — all use `CREATE TABLE IF NOT EXISTS`. No `schema_version` table, no migration runner. Schema changes break existing databases.

### 🟠 P1 — `/api/triggers` Returns Raw Array
Frontend expects `{ triggers: [] }`, backend returns `[]`. Phase 1 also found this. Any wrapper addition breaks frontend.

### 🟠 P1 — `DashboardToolRegistry` Type Mismatch with Frontend
Backend: `parameters?: unknown`. Frontend expects `paramCount?: number`, `dangerous?: boolean`. Type safety illusion.

### 🟡 P2 — WS Protocol Has No Versioning
New message types silently ignored by old clients. No `protocolVersion` handshake.

---

## 14. Background Job Reliability

### 🔴 P0 — `BackgroundExecutor` Has No Task-Level Timeout
A hung LLM call or leaked tool promise blocks the conversation forever. All subsequent tasks for that conversation are queued but never execute.

### 🔴 P0 — No Real Resume Mechanism
`recoverOnStartup()` marks incomplete tasks as failed — it does NOT resume them. LLM conversation context, in-flight tool state, supervisor wave state are never persisted.

### 🔴 P0 — `setInterval` Drift + Overlap in Heartbeat Loop
`tick()` is async and can be long. `setInterval` fires the next tick regardless. `running` flag prevents concurrent execution but causes tick skipping.

### 🟠 P1 — `WorkspaceLeaseManager` Has No Lease Expiration or GC
Crash during task execution leaves workspace lease unreleased. No cleanup on startup.

### 🟠 P1 — `TaskStorage` State Transitions Not Atomic
`updateStatus()` + `updateResult()` are separate calls. Crash between them leaves inconsistent state.

---

## 15. Cache Coherence

### 🔴 P0 — `vaultVectorStore` Leak on `rebuild()`
`UnityProjectVault.rebuild()` drops SQLite tables but does NOT clear in-memory `Map` or reset `nextId`. Old vectors leak; new `vault_embeddings` table has stale `hnsw_id` pointers.

### 🔴 P0 — AgentDB `storeEntry()` Not Atomic Across 3 Systems
Writes to `Map` → `HNSW` → `SQLite` sequentially. If SQLite fails, Map and HNSW are not rolled back. Inconsistent state persists.

### 🟠 P1 — Embedding Cache Doesn't Detect Model Change
Persisted `embedding-cache.json` only checks `version: 1`. Model or dimension changes are not detected — stale embeddings served.

### 🟠 P1 — Config Cache Doesn't Auto-Invalidate on `.env` Change
`loadConfig()` uses `cachedConfig` singleton. `.env` file changes require manual `resetConfigCache()` call.

### 🟠 P1 — Provider Health State Lost on Restart
`ProviderHealthRegistry` is in-memory only. All providers start as "healthy" after restart, even if they were down before.

---

## 16. Entropy & Randomness Security

### 🔴 P0 — Widespread `Math.random()` + `Date.now()` ID Generation
12+ locations generate IDs with `Math.random()` — predictable and collision-prone:
- `slack/app.ts:282,500,572` — message queue, action, stream IDs
- `dashboard/websocket-server.ts:430` — client IDs
- `audit/security-audit.ts:379,691,695` — event/rule/alert IDs
- `memory/memory.interface.ts:597` — memory IDs
- `learning/types.ts:910-932` — instinct/trajectory/artifact IDs
- `bootstrap-wiring.ts:331` — session IDs

### 🟠 P1 — `scryptSync` N=16384 Below OWASP 2023 Minimum
OWASP recommends `N >= 32768`. Current `N=16384` with `p=1` is marginal.

### 🟠 P1 — `WebIdentityStore.issue()` No ProfileId Validation
External `preferredProfileId` is only `.trim()`'d. Malicious long string or special characters can be injected.

---

## 17. Startup/Shutdown Sequence

### 🔴 P0 — Duplicate Signal Handlers
`setupGlobalErrorHandlers()` (errors.ts:515) and `setupShutdownHandlers()` (index.ts:869) both register `uncaughtException` and `unhandledRejection` handlers. First handler's `listenerCount<=1` check never fires because second handler is already registered. Double logging, double shutdown attempts, race conditions.

### 🟠 P1 — `BackgroundExecutor` Not Stopped on Shutdown
No `shutdown()`/`stop()` method on `BackgroundExecutor`. `createShutdownHandler()` doesn't stop it. Running tasks may continue after shutdown signal.

### 🟠 P1 — `LearningStorage` Not Closed on Shutdown
`learningStorage.close()` exists but is never called. `learning.db` connection stays open; SIGKILL risk of WAL/journal corruption.

### 🟠 P1 — 30s Shutdown Timeout Kills Pending I/O
`Promise.race([gracefulShutdown(), timeout])` → `process.exit(1)` on timeout. Critical DB writes, file flushes, network sends may be cut off mid-transaction.

### 🟡 P2 — Vault Subsystem Not Stopped on Shutdown
Async fire-and-forget vault init. Shutdown handler never calls `vaultRegistry.stopAll()` or `vault.close()`. Incomplete indexing may leave inconsistent state.

---

## Positive Findings (What's Working Well)

1. **State Mutation Atomicity** — All orchestrator state changes use immutable spread patterns. No intermediate inconsistent states.
2. **Session Lock Mechanism** — `handleMessage` uses promise chaining for per-chat serialization. Re-entrant-safe with `finally` cleanup.
3. **Fallback Chain** — Mature implementation: non-retryable errors propagate immediately, health-based cooldowns, thundering-herd protection.
4. **Circuit Breaker** — Correct HALF_OPEN probe, cooldown escalation, CLOSED reset logic.
5. **fetchWithRetry** — Exponential backoff, Retry-After header, abort signal, body draining.
6. **Graceful Degradation** — Embedding, vault, docRAG, streaming fallback all fail-safe.
7. **Auth Token Generation** — All tokens use `crypto.randomBytes()` with timing-safe comparison.
8. **Path Guard** — `validatePath` uses `realpath`, `path.sep`, null-byte rejection, recursive walk-up.
9. **Tool Context Isolation** — No API keys or credentials in `ToolContext`.
10. **Resource Cleanup Patterns** — 20+ components have proper `stop()`/`disconnect()`/`shutdown()` with timer/interval cleanup.

---

## Cross-Cutting Critical Themes

### Theme A: Security by Name-Matching is Broken
`DMPolicy`, `ReadOnlyGuard`, `WRITE_TOOLS`, `DESTRUCTIVE_TOOLS` all rely on exact tool name matching. Any tool with a different name (skill, plugin, dynamic) bypasses ALL security checks. This is the #1 systemic security flaw.

### Theme B: No Sandboxing for Third-Party Code
Skills and plugins run in the main Node.js process with full OS privileges. `PluginPermissions` interface exists but is completely unenforced. Any skill can `fs.rmSync("/")` or `process.exit()`.

### Theme C: Fail-Silent is Epidemic
~22 locations swallow errors with `.catch(() => {})` or empty `catch` blocks. No logging, no metrics, no alerts. Silent failures in learning pipeline, vault indexing, workspace lease release, channel handlers.

### Theme D: In-Memory State is Fragile
`ProviderHealthRegistry`, `TriggerDeduplicator`, `MetricsCollector`, `streamSentLengths`, `pendingConfirmations` — all in-memory only. Restart = total state loss. No persistence, no recovery.

### Theme E: Prometheus is Disconnected
Metrics are collected in `MetricsCollector` but never forwarded to `PrometheusMetrics`. All custom metrics are empty. Zero alerting. Zero tracing. Observability is fundamentally broken.

---

## Recommended Remediation Phases

| Phase | Focus | Effort | Impact |
|-------|-------|--------|--------|
| **Phase 1 (Immediate)** | Security: metadata-based DM/RO guards, skill sandboxing, prompt injection on user/tool input | 3-5 days | 🔴 Critical |
| **Phase 2 (Week 1)** | Reliability: task timeout, heartbeat `setTimeout`, resume checkpoint, shutdown cleanup | 3-5 days | 🔴 Critical |
| **Phase 3 (Week 2)** | Resource leaks: canvas DB close, timer key mismatch, SIGKILL fallback, stream cleanup | 2-3 days | 🟠 High |
| **Phase 4 (Week 2-3)** | Observability: Prometheus wire-up, tracing, alerting, correlation ID | 3-4 days | 🟠 High |
| **Phase 5 (Week 3)** | Config drift: coerce.boolean fix, env var mappings, .env.example | 1-2 days | 🟡 Medium |
| **Phase 6 (Week 4)** | DB migrations, API versioning, schema evolution | 3-5 days | 🟡 Medium |

---

*Report generated: 2026-05-05*
*Phase 2: 18 agents, ~230 findings*
*Combined Phase 1+2: ~462 findings*
