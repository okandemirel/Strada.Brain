---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: planning
stopped_at: Phase 7 context gathered
last_updated: "2026-03-07T15:11:42.433Z"
progress:
  total_phases: 9
  completed_phases: 6
  total_plans: 15
  completed_plans: 15
  percent: 100
---

# State: Strada.Brain Phase 2 — Agent Evolution (Level 3 → 4)

## Project Reference

**Core Value:** The agent must reason, learn, and adapt autonomously -- real memory, real-time learning, recursive goals, self-evaluation, and tool synthesis transform a chatbot wrapper into a genuine autonomous agent.

**Current Focus:** Phase 6 complete (Bayesian Confidence System). Phase 7 next (Recursive Goal Decomposition).

## Current Position

**Milestone:** Phase 7 -- Agent Evolution (Level 3 -> 4)
**Phase:** 6 of 9 complete, Phase 7 next (Recursive Goal Decomposition)
**Plan:** 3/3 plans done in Phase 6
**Status:** Ready to plan

**Progress:**
[██████████] 100%
Phase 2  [##########] 100%  Migration & HNSW Hardening
Phase 3  [##########] 100%  Auto-Tiering & Embedding Infrastructure
Phase 4  [##########] 100%  Event-Driven Learning (complete)
Phase 5  [##########] 100%  Metrics Instrumentation (complete)
Phase 6  [##########] 100%  Bayesian Confidence System (complete)
Phase 7  [..........] 0%    Recursive Goal Decomposition
Phase 8  [..........] 0%    Goal Progress & Execution
Phase 9  [..........] 0%    Tool Chain Synthesis

**Overall:** 6/9 phases complete

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases completed | 6/9 (Phase 6 complete) |
| Plans completed | 16 (2 Phase 1 + 3 Phase 2 + 3 Phase 3 + 2 Phase 4 + 2 Phase 5 + 3 Phase 6) |
| Requirements delivered | 25/32 (MEM-01..07, LRN-01..07, EVAL-01..07) |
| Tests added | 183/50+ target |
| Quality gates passed | 0 |
| Phase 01 P01 | 5min | 2 tasks | 5 files |
| Phase 01 P02 | 7min | 2 tasks | 5 files |
| Phase 02 P01 | 5min | 2 tasks | 6 files |
| Phase 02 P02 | 5min | 2 tasks | 4 files |
| Phase 02 P03 | 2min | 1 task | 2 files |
| Phase 03 P01 | 3min | 2 tasks | 6 files |
| Phase 03 P02 | 4min | 2 tasks | 4 files |
| Phase 03 P03 | 5min | 1 task | 5 files |
| Phase 04 P01 | 5min | 2 tasks | 4 files |
| Phase 04 P02 | 7min | 3 tasks | 10 files |
| Phase 05 P01 | 8min | 2 tasks | 11 files |
| Phase 05 P02 | 5min | 2 tasks | 6 files |
| Phase 06 P01 | 11min | 2 tasks | 8 files |
| Phase 06 P02 | 6min | 2 tasks | 5 files |
| Phase 06 P03 | 4min | 2 tasks | 7 files |

## Accumulated Context

### Key Decisions
- [P1-01] Auto-tiering defaults to OFF (Phase 3 activates it)
- [P1-01] Tier limits match AgentDB defaults: 100/1000/10000
- [P1-01] getHealth() synthesized from getStats() + getIndexHealth()
- [P1-01] Adapter stubs return ok()/defaults for 15+ non-production methods
- [P1-02] AgentDB path is subdirectory of dbPath (join(dbPath, 'agentdb')) to avoid file conflicts
- [P1-02] initializeMemory exported for unit testing (was private function)
- [P1-02] Schema repair opens SQLite directly to validate memories table before retry
- [P1-02] Hash-based embedding warning logged at startup when RAG is disabled
- [P2-01] Mutex uses Promise-chain pattern (zero dependencies, ~30 lines)
- [P2-01] shutdown() not wrapped in mutex (lifecycle method, not concurrent write)
- [P2-01] Chat/type modes retain TF-IDF path (structural filters, not similarity)
- [P2-01] Empty query falls back to TF-IDF (no embedding to search against)
- [P2-02] Marker file (migration-complete.json) chosen over DB flag for idempotency
- [P2-02] Capacity check preserves most recent entries first (createdAt desc)
- [P2-02] triggerLegacyMigration() extracted as helper to keep initializeMemory clean
- [P2-02] Migration runs in both primary and repair AgentDB init paths
- [P2-02] File backend excluded from migration (already on legacy system)
- [P2-03] enforceTierLimits uses batched removes in single withLock (fewer lock acquisitions, matches rebuildIndex pattern)
- [P3-01] Profile-based SqliteProfile union type for pragma config (memory/learning/tasks/preferences)
- [P3-01] foreign_keys=ON added to all SQLite profiles (was only TaskStorage)
- [P3-01] LearningStorage cache reduced 64MB->16MB, 256MB mmap_size removed per locked budget
- [P3-02] Fire-and-forget embedding: failures logged at debug level, never rethrown
- [P3-02] 500ms default batch window balances latency vs. API efficiency
- [P3-02] Shared CachedEmbeddingProvider: single instance for RAG and learning
- [P3-02] Optional provider pattern: when RAG disabled, embeddingQueue stays null
- [P3-02] Embedding text = triggerPattern + " " + action concatenation
- [P3-03] Promotion requires accessCount >= threshold AND lastAccessedAt < 1 day (dual condition)
- [P3-03] Demotion uses only staleness (daysSinceAccess > timeout), access count irrelevant
- [P3-03] enforceTierLimits for all 3 tiers after every sweep (cascade eviction correctness)
- [P3-03] stopAutoTiering before saveEntries in shutdown (prevents sweep during teardown)
- [P3-03] Auto-tiering defaults OFF, requires MEMORY_AUTO_TIERING=true to enable
- Fine granularity (9 phases) chosen for complex brownfield changes
- Memory phases split into 3 (activation, migration, auto-tiering) due to interface drift risk
- Embedding infrastructure placed in Phase 3 (after HNSW hardening) as bridge between memory and learning
- EVAL split into metrics (Phase 5) and Bayesian confidence (Phase 6) -- metrics inform confidence tuning
- GOAL split into decomposition (Phase 7) and execution (Phase 8) -- DAG structure before execution logic
- Tool synthesis is single phase (Phase 9) since all 5 requirements are tightly coupled
- Phase 7 depends on Phase 4 (not Phase 6) -- recursive goals need event bus but not Bayesian scoring
- Phase 9 depends on Phase 6 (not Phase 8) -- tool chains need instinct storage with confidence, not goal execution
- [P4-01] ToolResultEvent errorDetails defined inline to keep src/core/ self-contained (no import from learning/types.ts)
- [P4-01] TypedEventBus wraps EventEmitter with listener-to-wrapper map for correct off() behavior
- [P4-01] LearningQueue shutdown discards remaining items (only in-flight item completes)
- [P4-01] Async listener in-flight tracking uses counter + drain resolvers pattern
- [P4-02] Detection batch timer removed from start() -- event-driven processing via handleToolResult() replaces it
- [P4-02] Confidence updates filtered by tool_name contextCondition match to prevent false attribution
- [P4-02] appliedInstinctIds left undefined in orchestrator emit -- Phase 6 will wire IDs through AgentState
- [P4-02] Shutdown order: drain event bus -> drain queue -> stop pipeline
- [P4-02] Event emission uses chatId as sessionId (orchestrator doesn't track separate session IDs)
- [P5-01] Separate MetricsStorage connection to learning.db (WAL handles concurrency, avoids LearningStorage coupling)
- [P5-01] INSERT OR REPLACE for idempotent metric recording
- [P5-01] No retention/purge policy (metrics rows ~200 bytes, keep indefinitely)
- [P5-01] InsightResult returns both formatted strings and raw instinct IDs (no separate method)
- [P5-01] parentMetricId on BackgroundTaskOptions for subtask correlation
- [P5-02] Route /api/agent-metrics placed before /api/metrics to match startsWith correctly
- [P5-02] metricsStorage passed via registerServices (same pattern as memoryManager/channel)
- [P5-02] CLI creates standalone MetricsStorage for read-only queries (no bootstrap needed)
- [P5-02] Duration shorthand duplicated in server.ts and metrics-cli.ts (2 callsites, not worth shared util)
- [P6-01] Pure Beta posterior chosen over blended heuristic (EVAL-04: Bayesian Beta from real outcomes)
- [P6-01] Beta(1,1) uninformative prior matching MAX_INITIAL=0.5 (EVAL-07)
- [P6-01] Verdict weight formula is uniform: alpha += verdictScore, beta += (1-verdictScore) for all cases
- [P6-01] PRAGMA legacy_alter_table=ON prevents FK corruption during CHECK constraint migration
- [P6-01] SCHEMA_SQL includes 'permanent'/'optimization' upfront; migration only for existing DBs
- [P6-02] Cooling state machine uses coolingStartedAt/coolingFailures sub-state on Instinct, status remains 'active' during cooling
- [P6-02] appliedInstinctIds stored per-session in Map<chatId, string[]>, cleaned up in finally block
- [P6-02] EventBus created before LearningPipeline in bootstrap for constructor injection
- [P6-03] Post-filter deprecated instincts in InstinctRetriever (not storage-level) since PatternMatcher loads all instincts
- [P6-03] Request maxInsights+10 from PatternMatcher to account for deprecated post-filter losses
- [P6-03] Lifecycle data optional on MetricsAggregation (backward compatible)
- [P6-03] LearningStorage added to DashboardServer.registerServices for lifecycle queries

### Research Flags
- Phase 1: AgentDB interface drift is #1 risk (15+ casts in agentdb-memory.ts). Integration tests first.
- Phase 2: Migration can lose data from null embeddings. Backup first, validate counts.
- Phase 3: SQLite pragma standardization (WAL, cache_size, busy_timeout) across all databases.
- Phase 4: Concurrent async listeners risk lost updates. Serial async queue required.
- Phase 7: Recursive decomposition + FailureClassifier interaction needs careful design.
- Phase 9: Causal relationship detection for tool chains is an open design problem.

### Todos
- (none yet)

### Blockers
- (none)

## Session Continuity

**Last session:** 2026-03-07T15:11:42.426Z
**Stopped at:** Phase 7 context gathered
**Context to preserve:**
- 32 v1 requirements across 5 categories (MEM, LRN, GOAL, EVAL, TOOL)
- 9 phases derived from dependency analysis
- Research summary in `.planning/research/SUMMARY.md`
- Key files: bootstrap.ts, agentdb-memory.ts, migration.ts, learning-pipeline.ts, orchestrator.ts, event-bus.ts
- All 1963 tests pass (was 1951, +12 from Phase 6 Plan 03: 6 retriever + 4 CLI + 2 dashboard)
- Quality gates: /simplify + /security-review after each implementation phase
- HnswWriteMutex serializes all HNSW writes in agentdb-memory.ts
- AgentDBAdapter.retrieve() routes text queries through HNSW semantic search
- Migration idempotency marker prevents duplicate runs
- Bootstrap triggers runAutomaticMigration() after AgentDB init (both paths)
- Phase 2 fully complete (all 3 plans), all 6 HNSW write sites mutex-protected
- Phase 3 fully complete: SQLite pragma standardization, embedding queue, auto-tiering sweep
- Auto-tiering sweep activated via startAutoTiering in bootstrap (when config enabled)
- CachedEmbeddingProvider shared between RAG and learning pipeline
- Phase 4 fully complete: event-driven learning wired end-to-end
  - TypedEventBus + LearningQueue created in bootstrap
  - Orchestrator emits tool:result events via IEventEmitter
  - LearningPipeline.handleToolResult() processes per-event via serial queue
  - Detection batch timer removed, only evolution timer remains
  - TaskPlanner decoupled from direct observeToolUse calls
  - Weighted confidence scoring: 0.9/0.6/0.2 tiers
  - appliedInstinctIds deferred to Phase 6 (Bayesian Confidence)
- Phase 5 Plan 01 complete: metrics storage + orchestrator instrumentation
  - MetricsStorage: task_metrics table in learning.db (separate connection, WAL concurrent)
  - MetricsRecorder: startTask/endTask facade with three-state completion mapping
  - InsightResult: enriched InstinctRetriever return with matchedInstinctIds
  - Orchestrator processMessage and runBackgroundTask fully instrumented
  - Bootstrap creates MetricsStorage/MetricsRecorder, injects into orchestrator
  - EVAL-01 (completion rate), EVAL-02 (iterations), EVAL-03 (instinct reuse) all tracked
- Phase 5 Plan 02 complete: dashboard endpoint + CLI command for metrics
  - /api/agent-metrics returns MetricsAggregation JSON with session/type/since filters
  - CLI 'strata-brain metrics' prints ASCII table or JSON (--json)
  - All 3 EVAL surfaces complete: internal methods, dashboard HTTP, CLI command
- Phase 5 fully complete
- Phase 6 Plan 01 complete: Bayesian foundation (types, config, schema, scorer)
  - InstinctStatus: 'permanent' added (5th status)
  - CONFIDENCE_THRESHOLDS.MAX_INITIAL: 0.8 -> 0.5, Beta(1,1) prior
  - BayesianConfig: 13 env vars with threshold ordering validation
  - LearningEventMap: 3 lifecycle events (instinct:cooling-started/deprecated/promoted)
  - SQLite: bayesian_alpha/beta columns, CHECK constraint migration, lifecycle_log/weekly_counters tables
  - ConfidenceScorer: pure Beta posterior (no blend, no temporal discount), permanent freeze
  - EVAL-04 (pure Bayesian) and EVAL-07 (max initial 0.5) requirements complete
- Phase 6 Plan 02 complete: Lifecycle state machine + appliedInstinctIds wiring
  - Cooling state machine: confidence < 0.3 + 10 obs -> cooling -> 7d OR 3 failures -> deprecated
  - Promotion: confidence > 0.95 + 25 obs -> permanent (frozen)
  - Lifecycle events emitted on TypedEventBus (cooling-started, deprecated, promoted)
  - Lifecycle log + weekly counters written on transitions
  - appliedInstinctIds wired end-to-end: orchestrator -> tool:result events -> pipeline
  - Bootstrap injects BayesianConfig + IEventBus into LearningPipeline constructor
  - EVAL-04 (attribution), EVAL-05 (auto-deprecation), EVAL-06 (auto-promotion) complete
- Phase 6 Plan 03 complete: Lifecycle surface integration
  - InstinctRetriever: deprecated instincts excluded, permanent get 1.2x boost
  - CLI: Instinct Library Health section with status counts and weekly trends
  - Dashboard: /api/agent-metrics includes lifecycle field with statusCounts and weeklyTrends
  - MetricsAggregation extended with optional LifecycleData type
  - LearningStorage injected into DashboardServer via registerServices
  - EVAL-05, EVAL-06, EVAL-07 fully surfaced in all user-facing outputs
- Phase 6 fully complete (all 3 plans, all EVAL requirements met)

---
*State initialized: 2026-03-06*
*Last updated: 2026-03-07T14:37:58Z*
