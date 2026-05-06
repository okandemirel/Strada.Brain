# Strada.Brain — Phase 2 Action Items

> Prioritized action items extracted from Phase 2 runtime/behavior analysis.
> Each item includes: location, category, severity, and estimated fix effort.

---

## 🔴 P0 — Critical (Immediate Action Required)

### P0-1. Security: User Messages Bypass Prompt Injection Sanitization
- **Location:** `src/agents/orchestrator.ts:4017`, `src/agents/orchestrator.ts:2728`
- **Category:** security / prompt-injection
- **Issue:** User content added to `session.messages` without `sanitizePromptInjection()`
- **Fix:** Call `sanitizePromptInjection()` on `buildUserContent()` result before adding to session
- **Effort:** 30 min

### P0-2. Security: Tool Results Bypass Prompt Injection Sanitization
- **Location:** `src/agents/orchestrator.ts:6565`, `src/agents/tools/file-read.ts:173`, `src/agents/tools/shell-exec.ts:223`, `src/agents/tools/browser-automation.ts:488`, `src/agents/tools/git-tools.ts:37`
- **Category:** security / prompt-injection
- **Issue:** Tool results go directly to LLM context without injection filtering
- **Fix:** Extend `sanitizeToolResult()` with `sanitizePromptInjection()`; add delimiter wrappers in `buildToolResultContentBlocks()`
- **Effort:** 2-3 hours

### P0-3. Security: DM/ReadOnly Guards Use Exact Name Match Only
- **Location:** `src/security/dm-policy.ts:20-27`, `src/security/read-only-guard.ts:11-40`, `src/core/bootstrap.ts:752`, `src/core/tool-registry.ts:174`
- **Category:** security / access-control
- **Issue:** `skill_*`, `plugin_*`, `dynamic_*` tools bypass ALL security checks
- **Fix:** Switch from name-list to metadata-based checks (`metadata.dangerous`, `metadata.readOnly`); default skill/plugin tools to `dangerous: true`
- **Effort:** 4-6 hours

### P0-4. Security: No Sandboxing for Skills/Plugins
- **Location:** `src/skills/skill-loader.ts:187-189`, `src/agents/plugins/plugin-loader.ts:46-184`, `src/plugins/registry.ts:8-9`
- **Category:** security / sandbox
- **Issue:** Third-party code runs in main process with full OS privileges; `PluginPermissions` never enforced
- **Fix:** Implement `vm.Module` or `worker_threads` isolation; enforce `PluginPermissions` manifest
- **Effort:** 2-3 days

### P0-5. Reliability: `BackgroundExecutor` No Task-Level Timeout
- **Location:** `src/tasks/background-executor.ts:640`, `src/tasks/background-executor.ts:985`
- **Category:** reliability / timeout
- **Issue:** Hung LLM call or leaked promise blocks conversation forever
- **Fix:** Add `Promise.race([taskPromise, timeoutPromise])` with 10-min timeout; abort on timeout
- **Effort:** 1-2 hours

### P0-6. Reliability: No Real Resume on Startup
- **Location:** `src/tasks/task-manager.ts:420-455`, `src/supervisor/supervisor-dispatcher.ts:180-198`
- **Category:** reliability / resume
- **Issue:** `recoverOnStartup()` marks tasks as failed, doesn't resume. Supervisor dispatch state lost on crash
- **Fix:** Implement per-wave checkpoint in supervisor; replay-with-summary for LLM conversations
- **Effort:** 1-2 days

### P0-7. Resource Leak: Canvas DB Not Closed on Shutdown
- **Location:** `src/core/bootstrap.ts:1447`, `src/core/bootstrap-wiring.ts:180`
- **Category:** resource-leak / db
- **Issue:** `canvasDb` opened but never closed; WAL/journal corruption risk
- **Fix:** Add `canvasStorage` to `ShutdownOptions`; call `canvasStorage.close()` in shutdown handler
- **Effort:** 30 min

### P0-8. Resource Leak: WebChannel `pendingConfirmations` Key Mismatch
- **Location:** `src/channels/web/channel.ts:597`, `src/channels/web/channel.ts:803`
- **Category:** resource-leak / timer
- **Issue:** `set` uses `randomUUID()`, `get` uses `chatId` — timer never found, 5-min leak per disconnect
- **Fix:** Filter `pendingConfirmations.values()` by `chatId` in `handleDisconnect`
- **Effort:** 15 min

### P0-9. Error Handling: Fail-Silent in Channel Handlers
- **Location:** `src/channels/matrix/channel.ts:163`, `src/channels/irc/channel.ts:113`
- **Category:** error-handling / fail-silent
- **Issue:** Message handler errors completely swallowed with `.catch(() => {})`
- **Fix:** Add `logger.warn()` inside catch blocks; send error message to user
- **Effort:** 15 min

### P0-10. Error Handling: `wrapError()` Missing `Error.cause`
- **Location:** `src/common/errors.ts:485-510`
- **Category:** error-handling / chain
- **Issue:** Original error not linked via native `Error.cause`
- **Fix:** `if (error instanceof Error) { wrapped.cause = error; }`
- **Effort:** 15 min

### P0-11. Config: `z.coerce.boolean()` Makes `"false"` → `true`
- **Location:** `src/config/config.ts:1263`, `src/config/config.ts:1270`
- **Category:** config / type-mismatch
- **Issue:** `STRADA_VAULT_ENABLED=false` enables vault
- **Fix:** Replace `z.coerce.boolean()` with `boolFromString()` for `vault.enabled` and `obsidian.enabled`
- **Effort:** 15 min

### P0-12. Config: WebSocket Port Default Mismatch
- **Location:** `src/config/config.ts:1043`, `src/common/constants.ts:155`
- **Category:** config / default-drift
- **Issue:** Default 3100 vs 3101; port collision if both dashboards active
- **Fix:** Set `websocketDashboardPort` default to `"3101"`
- **Effort:** 5 min

### P0-13. Cache: `vaultVectorStore` Leak on `rebuild()`
- **Location:** `src/vault/unity-project-vault.ts:91-96`, `src/vault/unity-project-vault.ts:398-412`
- **Category:** cache / leak
- **Issue:** `rebuild()` drops SQLite but not in-memory Map/`nextId`; stale hnsw_id pointers
- **Fix:** `Map.clear()` + `nextId = 1` in `rebuild()`
- **Effort:** 15 min

### P0-14. Cache: AgentDB `storeEntry()` Not Atomic
- **Location:** `src/memory/unified/agentdb-memory.ts:681-723`
- **Category:** cache / atomicity
- **Issue:** Map→HNSW→SQLite writes not atomic; partial failure = inconsistent state
- **Fix:** Wrap in SQLite transaction; rollback Map/HNSW on SQLite failure
- **Effort:** 2-3 hours

### P0-15. Observability: PrometheusMetrics is a Ghost Instance
- **Location:** `src/dashboard/prometheus.ts:253,260,267`, `src/dashboard/metrics.ts:71-88`
- **Category:** observability / disconnect
- **Issue:** Created but never receives data; all custom metrics empty
- **Fix:** Wire `MetricsCollector` to forward to `PrometheusMetrics`; call `recordLLMLatency()` etc. from orchestrator
- **Effort:** 3-4 hours

### P0-16. Observability: Zero Alerting
- **Location:** `src/audit/security-audit.ts:402-697`, `monitoring/prometheus.yml:19-21`
- **Category:** observability / alerting
- **Issue:** `AlertManager` has no rules; Prometheus alertmanager commented out
- **Fix:** Add default alert rules (memory leak, budget exceeded, provider down, circuit open); uncomment alertmanager config
- **Effort:** 2-3 hours

### P0-17. Observability: Zero Tracing
- **Location:** `src/utils/logger.ts:71-106`, `src/agents/orchestrator.ts:6548-6576`
- **Category:** observability / tracing
- **Issue:** No correlationId/spanId in any log; cannot trace tool→LLM→request chain
- **Fix:** Add `correlationId` to logger; use `AsyncLocalStorage` for context propagation; add span tags to LLM/tool calls
- **Effort:** 4-6 hours

### P0-18. Deployment: `/health` Returns Fake Data
- **Location:** `src/dashboard/server.ts:603-614`, `src/dashboard/server.ts:762-833`
- **Category:** deployment / health
- **Issue:** `clients: 0` hardcoded; no DB/disk/error-rate checks
- **Fix:** Use actual client count; add DB connection, disk space, error rate checks to `/ready`
- **Effort:** 1-2 hours

### P0-19. Deployment: No Automatic Rollback
- **Location:** `src/daemon/deployment/deployment-executor.ts:128-135`
- **Category:** deployment / rollback
- **Issue:** Deploy fail = log entry only; no cleanup, no rollback
- **Fix:** Add `rollbackScriptPath` to config; execute on deploy failure; add `post_verify_failed` → `recordFailure()`
- **Effort:** 3-4 hours

### P0-20. Randomness: Widespread `Math.random()` ID Generation
- **Location:** `src/channels/slack/app.ts:282,500,572`, `src/dashboard/websocket-server.ts:430`, `src/audit/security-audit.ts:379,691,695`, `src/memory/memory.interface.ts:597`, `src/learning/types.ts:910-932`, `src/core/bootstrap-wiring.ts:331`
- **Category:** security / entropy
- **Issue:** Predictable, collision-prone IDs in 12+ locations
- **Fix:** Replace all `Math.random()` + `Date.now()` ID generation with `crypto.randomUUID()` or `crypto.randomBytes(16).toString("base64url")`
- **Effort:** 2-3 hours

### P0-21. Startup/Shutdown: Duplicate Signal Handlers
- **Location:** `src/common/errors.ts:515`, `src/index.ts:869`
- **Category:** lifecycle / signal
- **Issue:** `uncaughtException`/`unhandledRejection` registered twice; race conditions
- **Fix:** Consolidate into single handler registration; add `listenerCount` guard
- **Effort:** 30 min

### P0-22. State Machine: `transitionToVerifierReplan` Bypasses Valid Transitions
- **Location:** `src/agents/orchestrator-phase-telemetry.ts:63-90`
- **Category:** state-machine / bypass
- **Issue:** Direct assignment bypasses `VALID_TRANSITIONS`; allows `PLANNING→REPLANNING`
- **Fix:** Always call `transitionPhase()`; throw on invalid transition
- **Effort:** 30 min

---

## 🟠 P1 — High Priority

### P1-1. Resource: 4x Spawn SIGKILL Fallback Missing
- **Location:** `src/core/auto-updater.ts:318`, `src/channels/web/channel.ts:1395`, `src/daemon/deployment/readiness-checker.ts:121`, `src/daemon/deployment/deployment-executor.ts:246`
- **Fix:** Use existing `runProcess` utility or add SIGKILL fallback after 5s
- **Effort:** 1 hour

### P1-2. Resource: `MessageRouter` No Shutdown Cleanup
- **Location:** `src/tasks/message-router.ts:163-181`
- **Fix:** Add `dispose()` method; clear all `pendingTaskBatches` timers on shutdown
- **Effort:** 30 min

### P1-3. Resource: `streamSentLengths` Not Cleared on Disconnect/Shutdown
- **Location:** `src/channels/web/channel.ts:789-814`, `src/channels/web/channel.ts:439-475`
- **Fix:** Add `streamSentLengths.clear()` in `disconnect()` and filter by chatId in `handleDisconnect`
- **Effort:** 30 min

### P1-4. Error: `Promise.all` → `Promise.allSettled` in Vault/Context/RAG
- **Location:** `src/vault/vault-registry.ts:72`, `src/vault/vault-search-tool.ts:154`, `src/agents/context/strada-knowledge.ts:462`, `src/rag/docs/composite-rag-pipeline.ts:45`
- **Fix:** Replace with `Promise.allSettled`; merge successful results; log failures
- **Effort:** 1-2 hours

### P1-5. Error: `withRetry()` Dead Code
- **Location:** `src/common/errors.ts:561-607`
- **Fix:** Remove or consolidate with `fetchWithRetry`
- **Effort:** 15 min

### P1-6. Config: 8+ Env Vars Missing from Central Config
- **Location:** `src/core/bootstrap-providers.ts:194`, `src/core/local-stt-engine.ts:52`, `src/core/bootstrap-stages/stage-runtime.ts:171`, `src/index.ts:407`, `src/budget/budget-config-store.ts:86`
- **Fix:** Add all to `EnvVarName`, `EnvVars`, schema, `loadFromEnv`
- **Effort:** 2-3 hours

### P1-7. Config: `BudgetConfigStore` Reads `process.env` Directly
- **Location:** `src/budget/budget-config-store.ts:79-86`
- **Fix:** Use `loadConfig()` result instead of direct `process.env` access
- **Effort:** 30 min

### P1-8. Memory: Static File Serving Uses `readFile`
- **Location:** `src/channels/web/channel.ts:719`
- **Fix:** Use `fs.createReadStream(candidate).pipe(res)` for streaming serve
- **Effort:** 30 min

### P1-9. Memory: `deletedIndices` Never Compacted in HNSW
- **Location:** `src/rag/hnsw/hnsw-vector-store.ts:135-142`
- **Fix:** Implement periodic `deletedIndices` compaction or `rebuildIndex`
- **Effort:** 2-3 hours

### P1-10. WS: No Heartbeat in Web Channel
- **Location:** `src/channels/web/channel.ts:745-814`
- **Fix:** Add 30s ping/pong like dashboard WS
- **Effort:** 1-2 hours

### P1-11. WS: No Backpressure Handling
- **Location:** `src/channels/web/channel.ts:1601-1610`, `src/dashboard/websocket-server.ts:186-198`
- **Fix:** Check `ws.bufferedAmount` before send; queue or drop for slow clients
- **Effort:** 2-3 hours

### P1-12. Multi-tenant: WhatsApp `pendingConfirmations` Key Collision
- **Location:** `src/channels/whatsapp/client.ts:668`
- **Fix:** Use `randomUUID()` as key; store chatId+userId in value
- **Effort:** 30 min

### P1-13. Multi-tenant: Workspace Bus Events No Ownership Check
- **Location:** `src/channels/web/channel.ts:1145-1268`
- **Fix:** Verify chatId/task ownership before processing monitor events
- **Effort:** 1-2 hours

### P1-14. Deployment: `execute()` is Public — Bypasses Approval Queue
- **Location:** `src/daemon/deployment/deployment-executor.ts:72-143`
- **Fix:** Make `execute()` private or add approval entry validation
- **Effort:** 30 min

### P1-15. Deployment: Post-Verify Failures Don't Count to Circuit Breaker
- **Location:** `src/daemon/deployment/deployment-executor.ts:116-125`
- **Fix:** Call `circuitBreaker.recordFailure()` on all `success: false` results
- **Effort:** 15 min

### P1-16. Background Jobs: `setInterval` → Recursive `setTimeout` in Heartbeat
- **Location:** `src/daemon/heartbeat-loop.ts:139-143`
- **Fix:** Replace `setInterval` with recursive `setTimeout` to prevent drift/overlap
- **Effort:** 30 min

### P1-17. Background Jobs: `WorkspaceLeaseManager` No GC
- **Location:** `src/agents/multi/workspace-lease-manager.ts:113-182`
- **Fix:** Add `expiresAt` to leases; scan and cleanup old leases on startup
- **Effort:** 1-2 hours

### P1-18. Background Jobs: `TaskStorage` Not Atomic
- **Location:** `src/tasks/task-storage.ts:165-183`
- **Fix:** Wrap status+result updates in SQLite transaction
- **Effort:** 1-2 hours

### P1-19. Cache: Embedding Cache Doesn't Detect Model Change
- **Location:** `src/rag/embeddings/embedding-cache.ts:71`
- **Fix:** Store model+fingerprint in cache metadata; reject on mismatch
- **Effort:** 1-2 hours

### P1-20. Cache: Config Cache Doesn't Auto-Invalidate
- **Location:** `src/config/config.ts:3287-3288`
- **Fix:** Hash `_env` and auto-bypass cache on change; or link `resetConfigCache()` to dotenv override
- **Effort:** 1-2 hours

### P1-21. Cache: Provider Health Lost on Restart
- **Location:** `src/agents/providers/provider-health.ts:57-61`
- **Fix:** Persist health state to SQLite; or force health check on restart
- **Effort:** 2-3 hours

### P1-22. Randomness: `scryptSync` N Below OWASP Minimum
- **Location:** `src/security/auth-hardened.ts:254`
- **Fix:** Increase `N` from 16384 to 32768
- **Effort:** 5 min

### P1-23. Randomness: `WebIdentityStore.issue()` No ProfileId Validation
- **Location:** `src/channels/web/web-identity-store.ts:53`
- **Fix:** Add UUID regex or `z.string().uuid()` validation to `preferredProfileId`
- **Effort:** 15 min

### P1-24. Startup/Shutdown: `BackgroundExecutor` Not Stopped
- **Location:** `src/core/bootstrap-wiring.ts:129-158`, `src/tasks/background-executor.ts`
- **Fix:** Add `shutdown()` to `BackgroundExecutor`; add to `ShutdownOptions`
- **Effort:** 1-2 hours

### P1-25. Startup/Shutdown: `LearningStorage` Not Closed
- **Location:** `src/core/bootstrap.ts:1640`, `src/learning/storage/learning-storage.ts:825`
- **Fix:** Add `learningStorage` to `ShutdownOptions`; call `close()` in shutdown handler
- **Effort:** 30 min

### P1-26. Startup/Shutdown: 30s Timeout Kills Pending I/O
- **Location:** `src/core/bootstrap-wiring.ts:313-326`
- **Fix:** Force-flush critical DBs before `process.exit(1)`; or abort running ops first
- **Effort:** 2-3 hours

### P1-27. API: `/api/triggers` Returns Raw Array
- **Location:** `src/dashboard/server-daemon-routes.ts:279`, `web-portal/src/hooks/use-api.ts:545`
- **Fix:** Wrap in `{ triggers: [] }` or add API versioning
- **Effort:** 30 min

### P1-28. API: No DB Migration Framework
- **Location:** `src/memory/unified/agentdb-sqlite.ts:28`, `src/vault/schema.sql:1`, `src/metrics/metrics-storage.ts:25`, `src/learning/storage/`
- **Fix:** Add `schema_version` table + migration runner for all SQLite DBs
- **Effort:** 1-2 days

---

## 🟡 P2 — Medium Priority

### P2-1. Data Mutation: `session.messages` / `stepResults` Unbounded Growth
- **Location:** `src/agents/orchestrator.ts:3106,3188,3453,3657,4382,4469,4622,4638,4766,4823,5057,5264`
- **Fix:** Add `stepResults` trimming to `maybeCompactSession`; cap at reasonable limit
- **Effort:** 1-2 hours

### P2-2. Data Mutation: `agentdb-adapter.ts` Shallow Merge
- **Location:** `src/memory/unified/agentdb-adapter.ts:464-480`
- **Fix:** Use immutable update + `structuredClone` for nested metadata
- **Effort:** 1 hour

### P2-3. Error: Stream Timeout Suppress with No Logging
- **Location:** `src/agents/orchestrator.ts:5234,5359`
- **Fix:** Add `logger.debug()` in `.catch()` of stream promise
- **Effort:** 15 min

### P2-4. Error: Framework Prompt Generator Wiring Error Swallowed
- **Location:** `src/core/bootstrap.ts:887`
- **Fix:** Add `logger.warn()` in catch block
- **Effort:** 5 min

### P2-5. Prompt Injection: Encoding Bypasses
- **Location:** `src/agents/orchestrator-text-utils.ts:409-534`
- **Fix:** Add leetspeak/rot13/URL encoding detectors
- **Effort:** 2-3 hours

### P2-6. Prompt Injection: Multi-Turn Jailbreak
- **Location:** `src/agents/orchestrator-session-manager.ts:287-355`
- **Fix:** Add conversation-wide cumulative injection score
- **Effort:** 4-6 hours

### P2-7. Config: `.env.example` Missing
- **Location:** project root
- **Fix:** Create `.env.example` with all env vars, defaults, and descriptions
- **Effort:** 2-3 hours

### P2-8. Config: `loadConfigSafe()` Called Per WS Connection
- **Location:** `src/channels/web/channel.ts:893-897`
- **Fix:** Cache config at channel init; don't re-parse per connection
- **Effort:** 30 min

### P2-9. Plugin/Skill: `skill-loader.ts` Symlink Escape
- **Location:** `src/skills/skill-loader.ts:229-238`
- **Fix:** Use `lstat` to detect symlinks; reject or validate target
- **Effort:** 30 min

### P2-10. Plugin/Skill: `reloadAll()` Race Condition
- **Location:** `src/agents/plugins/plugin-loader.ts:214-251`
- **Fix:** Add mutex/lock for reload operations
- **Effort:** 1-2 hours

### P2-11. Memory: `consolidation-engine.ts` Retains All Entries
- **Location:** `src/memory/unified/consolidation-engine.ts:112-114`
- **Fix:** Read entries on-demand from SQLite instead of holding full Map reference
- **Effort:** 2-3 hours

### P2-12. WS: Empty `stream_end` Deletes Message
- **Location:** `src/channels/web/channel.ts:624-637`, `web-portal/src/hooks/useWebSocket.ts:463-488`
- **Fix:** Leave placeholder or "..." for empty streams; or block empty streams server-side
- **Effort:** 30 min

### P2-13. Multi-tenant: `storeNote()` No chatId
- **Location:** `src/memory/unified/agentdb-memory.ts:547`
- **Fix:** Add optional `chatId` param; pass from callers
- **Effort:** 1-2 hours

### P2-14. Multi-tenant: `countFiles` No Symlink Cycle Check
- **Location:** `src/agents/tools/file-manage.ts:245-257`
- **Fix:** Add `entry.isSymbolicLink()` check in `countFiles`
- **Effort:** 30 min

### P2-15. Deployment: No Zero-Downtime Deploy
- **Location:** `src/daemon/deployment/deployment-executor.ts`
- **Fix:** Add request drain before deploy; consider blue/green strategy
- **Effort:** 1-2 days

### P2-16. Background Jobs: `TriggerDeduplicator` Not Persisted
- **Location:** `src/daemon/dedup/trigger-deduplicator.ts:30-49`
- **Fix:** Persist `lastFired` to `DaemonStorage`
- **Effort:** 1-2 hours

### P2-17. Background Jobs: `retryTask()` Can Create Duplicate Execution
- **Location:** `src/tasks/task-manager.ts:222-242`
- **Fix:** Check for active task with same `parentId` before submitting retry
- **Effort:** 1 hour

### P2-18. Background Jobs: DST Gap in Cron Trigger
- **Location:** `src/daemon/triggers/cron-trigger.ts:38-41`
- **Fix:** Validate `croner` DST behavior; log skipped ticks
- **Effort:** 30 min

### P2-19. Cache: `cachedAnalysis` Not Invalidated on Project Change
- **Location:** `src/memory/unified/agentdb-memory.ts:129`
- **Fix:** Add content hash or git commit hash to cache key
- **Effort:** 1-2 hours

### P2-20. Cache: `agentdb-memory.ts` Dimension Mismatch Entries Not Cleaned
- **Location:** `src/memory/unified/agentdb-memory.ts:1243-1357`
- **Fix:** Archive or delete dimension-mismatch entries from SQLite
- **Effort:** 1-2 hours

### P2-21. Startup/Shutdown: Vault Not Stopped on Shutdown
- **Location:** `src/core/bootstrap.ts:588-718`, `src/core/bootstrap-wiring.ts:180-328`
- **Fix:** Add `vaultRegistry.stopAll()` to shutdown sequence
- **Effort:** 30 min

### P2-22. API: `DashboardToolRegistry` Type Mismatch
- **Location:** `src/dashboard/server-types.ts:128`, `web-portal/src/hooks/use-api.ts:27`
- **Fix:** Sync types or add DTO mapper
- **Effort:** 1-2 hours

### P2-23. API: WS Protocol No Versioning
- **Location:** `src/channels/web/channel.ts:898`, `web-portal/src/types/messages.ts:70`
- **Fix:** Add `protocolVersion` to `session_init`; send `unknown_type_warning` for unhandled types
- **Effort:** 2-3 hours

---

## 🟢 P3 — Low Priority

### P3-1. Data Mutation: `kimi.ts` Deletes Key from Original Object
- **Location:** `src/agents/providers/kimi.ts:163`
- **Fix:** Use destructuring instead of `delete`
- **Effort:** 5 min

### P3-2. Data Mutation: `lru-cache.ts` Returns Mutable References
- **Location:** `src/common/lru-cache.ts:20-40`
- **Fix:** `Object.freeze()` cache values or deep clone on get
- **Effort:** 30 min

### P3-3. Resource: `dm-policy.ts` Confirmation Timer Not Stored
- **Location:** `src/security/dm-policy.ts:302`
- **Fix:** Add `timer` field to `PendingConfirmation`; clear on resolve/cancel
- **Effort:** 30 min

### P3-4. Resource: `process.on` Handler Re-registration Risk
- **Location:** `src/index.ts:891-903`, `src/common/errors.ts:520-536`
- **Fix:** Add "already registered" guard
- **Effort:** 15 min

### P3-5. Error: `fallback-chain.ts` Loses Original Error
- **Location:** `src/agents/providers/fallback-chain.ts:257-260`
- **Fix:** Store `Error` object, not string; add `cause` on final throw
- **Effort:** 30 min

### P3-6. Memory: `agentdb-vector.ts` Uses `Array` Instead of `Float32Array`
- **Location:** `src/memory/unified/agentdb-vector.ts:96-97`
- **Fix:** Use `Float32Array(dimensions)` for less GC pressure
- **Effort:** 15 min

### P3-7. Memory: String Concatenation in `web/channel.ts` Verify
- **Location:** `src/channels/web/channel.ts:1406-1414`
- **Fix:** Use `Buffer` or `Array.push` + `join`
- **Effort:** 15 min

### P3-8. WS: Dashboard WS `client.close()` + `clients.delete()` Race
- **Location:** `src/dashboard/websocket-server.ts:402-416`
- **Fix:** Use `client.terminate()` or check Map presence in handler
- **Effort:** 15 min

### P3-9. WS: `streamIdToIndexRef` Not Cleared on Disconnect
- **Location:** `web-portal/src/hooks/useWebSocket.ts:275-295`
- **Fix:** Call `streamIdToIndexRef.current.clear()` in disconnect handler
- **Effort:** 5 min

### P3-10. Metric: Cardinality — `tokens_total{type="total"}` Redundant
- **Location:** `src/dashboard/prometheus.ts:83-88`
- **Fix:** Remove `total` label; compute via PromQL
- **Effort:** 15 min

### P3-11. Metric: Cardinality — `model` Label Explosion
- **Location:** `src/dashboard/prometheus.ts:127-133`
- **Fix:** Normalize model label to vendor+major version
- **Effort:** 30 min

### P3-12. Background Jobs: `checklist-trigger.ts` `lastFiredMinute` Not Persisted
- **Location:** `src/daemon/triggers/checklist-trigger.ts:91-119`
- **Fix:** Persist to `DaemonStorage`
- **Effort:** 1 hour

### P3-13. Startup: Channel Init Parallel with Provider/Memory
- **Location:** `src/core/bootstrap-stages/stage-providers.ts:83-91`
- **Fix:** Separate channel init from provider+memory; graceful degradation on channel failure
- **Effort:** 2-3 hours

---

*Action items: ~95 items | Phase 2 only*
*Combined with Phase 1: ~267 total action items*
