# Strada.Brain — Unified Action Items (Phase 1 + Phase 2)

> Complete prioritized action list from both static code review (Phase 1) and runtime behavior analysis (Phase 2).

---

## Executive Summary

| Phase | Findings | P0 Critical | P1 High | P2 Medium | P3 Low |
|-------|----------|-------------|---------|-----------|--------|
| Phase 1 (Static) | 232 | 25 | 64 | 98 | 45 |
| Phase 2 (Runtime) | ~230 | 35 | 61 | 81 | 53 |
| **Combined** | **~462** | **60** | **125** | **179** | **98** |

| Action Items | P0 | P1 | P2 | P3 | Total |
|--------------|-----|-----|-----|-----|-------|
| Phase 1 | 10 | 32 | 68 | 62 | 172 |
| Phase 2 | 22 | 28 | 23 | 22 | 95 |
| **Combined** | **32** | **60** | **91** | **84** | **267** |

---

## 🔴 P0 — Critical (Immediate Action Required) — 32 Items

### Security (8 items)
1. **Slack bootstrap missing from `initializeChannel()`** (`src/channels/index.ts`) — channel dead
2. **Slack timeout rejects Error instead of `"timeout"`** (`src/channels/slack/app.ts:335`) — wrong error type
3. **Orchestrator write-gate runtime crash** (`src/agents/orchestrator.ts:6255`) — unsafe cast to `ConfirmableChannel`
4. **User messages bypass prompt injection sanitization** (`src/agents/orchestrator.ts:4017,2728`) — direct injection vector
5. **Tool results bypass prompt injection sanitization** (`src/agents/orchestrator.ts:6565` + tool files) — indirect injection vector
6. **DM/ReadOnly guards use exact name match only** (`src/security/dm-policy.ts`, `read-only-guard.ts`) — all namespaced tools bypass security
7. **No sandboxing for skills/plugins** (`src/skills/skill-loader.ts`, `src/agents/plugins/plugin-loader.ts`) — arbitrary code execution in main process
8. **Widespread `Math.random()` ID generation** (12+ locations) — predictable, collision-prone IDs

### Reliability (6 items)
9. **Orchestrator end-turn `||` logic** (`src/agents/orchestrator.ts:4946`) — incomplete responses when `stopReason="end_turn"` + `toolCalls>0`
10. **`BackgroundExecutor` no task-level timeout** (`src/tasks/background-executor.ts:640`) — hung tasks block conversations forever
11. **No real resume on startup** (`src/tasks/task-manager.ts:420`) — tasks marked failed, never resumed
12. **`setInterval` drift + overlap** (`src/daemon/heartbeat-loop.ts:139`) — tick skipping, concurrent execution risk
13. **`AgentDBMemory.retrieve` ignores `mode: "semantic"`** (`src/memory/unified/agentdb-retrieval.ts`) — falls back to TF-IDF silently
14. **Batch runner skips `tests/` directory** (`scripts/run-vitest-batches.mjs`) — 40 test files never run in CI

### Resource Leaks (4 items)
15. **Canvas DB not closed on shutdown** (`src/core/bootstrap.ts:1447`) — WAL corruption risk
16. **WebChannel `pendingConfirmations` key mismatch** (`src/channels/web/channel.ts:597,803`) — timer leak
17. **`streamSentLengths` not cleared on disconnect** (`src/channels/web/channel.ts:789`) — memory leak
18. **AgentDB `storeEntry()` not atomic** (`src/memory/unified/agentdb-memory.ts:681`) — Map/HNSW/SQLite inconsistency

### Error Handling (3 items)
19. **~22 fail-silent patterns** (channel handlers, stream timeout, learning pipeline, workspace lease, vault hook) — errors swallowed without logging
20. **`wrapError()` missing `Error.cause`** (`src/common/errors.ts:485`) — error chain broken
21. **Duplicate signal handlers** (`src/common/errors.ts:515`, `src/index.ts:869`) — race conditions on uncaughtException/unhandledRejection

### Config (2 items)
22. **`z.coerce.boolean()` makes `"false"` → `true`** (`src/config/config.ts:1263`) — vault/obsidian enabled when explicitly disabled
23. **WebSocket port default mismatch** (`src/config/config.ts:1043` vs `constants.ts:155`) — port collision

### Cache (2 items)
24. **`vaultVectorStore` leak on `rebuild()`** (`src/vault/unity-project-vault.ts`) — stale hnsw_id pointers
25. **Embedding cache doesn't detect model change** (`src/rag/embeddings/embedding-cache.ts:71`) — stale embeddings served

### Observability (4 items)
26. **PrometheusMetrics is a ghost instance** — created but never receives data
27. **Zero alerting** — AlertManager has no rules; prometheus.yml alertmanager commented out
28. **Zero tracing** — no correlationId/spanId in any log
29. **`MetricsCollector` never forwards to Prometheus** — token usage invisible to metrics

### Deployment (3 items)
30. **`/health` returns fake data** (`src/dashboard/server.ts:603`) — `clients: 0` hardcoded
31. **No automatic rollback** (`src/daemon/deployment/deployment-executor.ts:128`) — deploy fail = no cleanup
32. **`/api/triggers` API mismatch** (`src/dashboard/server-daemon-routes.ts:279`) — frontend expects wrapper, backend returns array

---

## 🟠 P1 — High Priority — 60 Items

### Security (6)
- Supervisor synthesis exposes system prompt to external provider
- Encoding bypasses (leetspeak, rot13) not filtered
- `skill-loader.ts` symlink escape via `stat()`
- `PluginLoader.reloadAll()` race condition
- Dynamic tool factory leaks full `process.env` to shell tools
- `create_tool` tool itself not under DM Policy

### Channels (4)
- Discord timeout promise not awaited in `sendMarkdown`
- IRC `catch(()=>{})` in multiple places
- Matrix message handler error swallowed
- Telegram error recovery missing context

### Memory/RAG (5)
- `RAGPipeline.indexProject` only indexes `**/*.cs` — misses TS/JS/Markdown
- Semantic retrieval mode not implemented
- HNSW `deletedIndices` never compacted
- Static file serving loads entire file to memory
- Consolidation engine retains all memory references

### Providers (3)
- 4x spawn SIGKILL fallback missing
- Provider health state lost on restart
- `fallback-chain.ts` loses original Error object

### Budget (2)
- Interactive chat cost tracking missing — orchestrator never records to `UnifiedBudgetManager`
- `BudgetConfigStore` reads `process.env` directly

### Error Handling (4)
- `Promise.all` → `Promise.allSettled` in vault/context/RAG (4 places)
- `withRetry()` dead code
- Framework prompt generator wiring error swallowed
- Stream timeout suppress with no logging

### Config (4)
- 8+ env vars missing from central config (`OLLAMA_BASE_URL`, `STT_*`, `SETUP_WIZARD_PORT`, etc.)
- `loadConfigSafe()` called per WS connection
- `.env.example` missing
- Rate limit defaults drift (0 vs 5.0/100.0)

### Multi-tenant (3)
- WhatsApp `pendingConfirmations` key collision
- Workspace bus events have no ownership check
- `storeNote()` doesn't accept `chatId`

### WebSocket (2)
- No heartbeat in web channel
- No backpressure handling

### Background Jobs (4)
- `setInterval` → recursive `setTimeout` in heartbeat
- `WorkspaceLeaseManager` no lease GC
- `TaskStorage` not atomic
- `MessageRouter` no shutdown cleanup

### Deployment (3)
- `execute()` is public — bypasses approval queue
- Post-verify failures don't count to circuit breaker
- No zero-downtime deploy

### API/Schema (3)
- `DashboardToolRegistry` type mismatch with frontend
- No DB migration framework for any SQLite DB
- WS protocol has no versioning

### Startup/Shutdown (5)
- `BackgroundExecutor` not stopped on shutdown
- `LearningStorage` not closed on shutdown
- 30s timeout kills pending I/O
- Vault not stopped on shutdown
- `countFiles` no symlink cycle check

### Randomness (2)
- `scryptSync` N=16384 below OWASP minimum
- `WebIdentityStore.issue()` no profileId validation

### State Machine (2)
- `transitionToVerifierReplan` bypasses `VALID_TRANSITIONS`
- `AgentPhase.COMPLETE` is unreachable dead state

---

## 🟡 P2 — Medium Priority — 91 Items

### Code Quality (15)
- Type duplicate cleanup across interfaces
- Threshold values not unified (magic numbers)
- Barrel file inconsistencies
- Missing JSDoc on public APIs
- `TODO`/`FIXME` comments without issue tracking
- Inline styles in web portal components

### Testing (8)
- Test coverage gaps in security module
- Mock drift in channel adapters
- Non-deterministic test patterns
- Time-based flakiness in scheduler tests

### Memory/Performance (6)
- `session.messages` / `stepResults` unbounded growth
- `agentdb-adapter.ts` shallow merge
- String concatenation bloat in verify stdout
- `agentdb-vector.ts` uses Array instead of Float32Array
- LRU cache returns mutable references
- `kimi.ts` deletes key from original object

### Prompt Injection (2)
- Multi-turn jailbreak detection
- Encoding bypass filters

### Resource (4)
- `dm-policy.ts` confirmation timer not stored
- `process.on` handler re-registration risk
- Browser automation pipeline file handle risk
- Schema repair pragma error → DB leak

### Channels (5)
- WhatsApp typing indicator missing
- Slack message queue ordering edge case
- Matrix reconnection backoff missing
- IRC nickname collision handling
- Telegram media processing timeout

### RAG (3)
- Embedding queue batch size not tuned
- Vector store quantization not configurable
- Code chunk overlap too small

### Observability (4)
- LLM latency metric not wired
- Message duration metric not wired
- Request duration metric not wired
- Memory tier transition metric missing

### Metrics (2)
- `tokens_total{type="total"}` redundant
- `model` label cardinality explosion

### API/Schema (5)
- Goal tree serialization not versioned
- Config Zod `superRefine` too strict
- `DynamicToolSpec` no versioning
- `ToolContext` no version field
- Composite blocked tools hardcoded list

### Background Jobs (5)
- `TriggerDeduplicator` not persisted
- `retryTask()` can create duplicate execution
- DST gap in cron trigger
- `checklist-trigger.ts` `lastFiredMinute` not persisted
- Supervisor dispatcher no per-wave checkpoint

### Cache (4)
- Config cache doesn't auto-invalidate
- Provider cache TTL missing
- `cachedAnalysis` not invalidated on project change
- Dimension mismatch entries not cleaned from SQLite

### Deployment (2)
- Deployment Windows `.cmd` script `shell: false`
- ReadinessChecker doesn't check live instance health

### Startup (2)
- Channel init parallel with provider/memory
- Daemon auto-restart only with `strada supervise`

---

## 🟢 P3 — Low Priority — 84 Items

### Documentation (15)
- README out of sync with latest features
- API docs missing for 6 endpoints
- Channel setup guides incomplete
- Docker deployment guide outdated
- Config variable descriptions missing

### Code Organization (12)
- Unused imports in 8 files
- Dead code in `orchestrator-legacy.ts`
- Commented-out code blocks
- Console.log left in production code
- Inconsistent error message formatting

### Minor Fixes (20)
- Typo in 6 error messages
- Inconsistent variable naming
- Magic string literals not constants
- Date formatting inconsistencies
- Missing `readonly` on class fields

### Polish (15)
- Log level inconsistencies
- Metric naming not following convention
- Event bus topic names not namespaced
- Channel adapter interface drift

### Infrastructure (12)
- CI pipeline doesn't run integration tests
- Docker image size optimization
- Nginx config missing rate limiting
- SSL certificate rotation not automated
- Backup script not tested

### Misc (10)
- Dependency audit findings (low severity)
- npm script inconsistencies
- .gitignore gaps
- Editor config missing

---

## Recommended Execution Order

### Week 1: Security & Stability (P0 items)
- Fix security bypass (metadata-based guards)
- Add prompt injection sanitization to user/tool input
- Implement skill/plugin sandboxing (or at least permission checks)
- Fix `BackgroundExecutor` timeout
- Fix resource leaks (canvas DB, timer mismatch, stream cleanup)
- Fix fail-silent patterns in critical paths

### Week 2: Reliability & Error Handling (P0+P1)
- Fix heartbeat `setInterval` → `setTimeout`
- Add task resume/checkpoint mechanism
- Wire Prometheus metrics
- Add correlationId/tracing
- Fix `Promise.all` → `Promise.allSettled`
- Add SIGKILL fallback to all spawns

### Week 3: Config & Resource (P1+P2)
- Fix `z.coerce.boolean()` bug
- Map all env vars to central config
- Create `.env.example`
- Fix memory pressure issues (streaming, HNSW)
- Add DB migration framework

### Week 4: Polish & API (P2+P3)
- Fix API versioning
- Add WS protocol versioning
- Clean up dead code
- Sync documentation
- Run full test suite

---

*Unified report: Phase 1 + Phase 2*
*Total findings: ~462 | Total action items: 267*
*Generated: 2026-05-05*
