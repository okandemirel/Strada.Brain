# Strada.Brain Comprehensive Audit Report

**Date:** 2026-03-31
**Agents Used:** 42 parallel analysis agents
**Total Bugs Found:** ~330+
**Scope:** Full codebase + provider API research

## Summary by Severity

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL/P0 | ~38 | Fixing |
| HIGH/P1 | ~60 | Fixing |
| MEDIUM/P2 | ~110 | Fixing |
| LOW/P3 | ~112 | Fixing |

## Top 10 Critical Findings

1. **daemonFullAutonomy defaults to true** — All security approval gates bypassed (config.ts:1712)
2. **FrameworkPromptGenerator never wired** — Live framework knowledge never reaches LLM (bootstrap.ts:409)
3. **Pattern table grows unbounded** — No deduplication on storePattern (agentdb-memory.ts:1389)
4. **MMR diversity formula wrong** — queryEmbedding included, results not diverse (agentdb-retrieval.ts:241)
5. **Consolidation bypasses HNSW mutex** — Concurrent index corruption (consolidation-engine.ts:366)
6. **fail()/complete() skip sanitizeSecrets** — API keys can leak in error messages (task-manager.ts:317)
7. **parseLLMOutput too strict for Kimi** — Reasoning blocks break JSON parsing (types.ts:203) [FIXED]
8. **ReDoS in file-utils** — User-controlled regex can freeze event loop (file-utils/index.ts:344)
9. **SSRF in web-search** — web_fetch_url allows internal endpoints (web-search/index.ts:28)
10. **persistEntry runtime crash** — Method doesn't exist, hidden by `as unknown as` cast (agentdb-adapter.ts:904)

## Bug Categories

### Security (P0)
- daemonFullAutonomy default true bypasses all approval gates
- fail()/complete() don't sanitize secrets before storing
- SSRF in web_fetch_url — no internal IP blocking
- ReDoS via user-controlled regex in file-utils
- Soul content injected without sanitizePromptInjection()
- Attachment filename not sanitized (path traversal)
- create_tool bypasses live registry — arbitrary shell exec
- Dynamic shell tools skip blocklist entirely
- Dashboard GET endpoints unauthenticated without token
- /api/logs completely unprotected in no-token config

### Provider/Parsing (P0-P1)
- parseLLMOutput Kimi reasoning block [FIXED]
- chatStream has no AbortSignal — streams can't be cancelled
- Retry-After parseInt loses fractional values
- content_filter finish_reason not mapped
- Single-provider health tracking gap
- supportsThinking:false hardcoded for all LiteLLM models
- LiteLLM max_output_tokens-only models silently dropped
- Provider chain not resilient — health check 429 causes boot failure

### Supervisor/Goals (P0-P1)
- Goal decomposition fallback to single-node [FIXED]
- Adaptive timeout for fallback [FIXED]
- reviewStatus not persisted in SQLite
- upsertTree DELETE+INSERT race condition
- blocked trees never pruned
- Canvas node w/h reset on every update
- Verification auto-approves when provider down
- Stale events from retry (double "running" narrative)

### Orchestrator/Pipeline (P0-P1)
- max_tokens break only exits inner loop
- consecutiveMaxTokens not reset on epoch rollover
- ControlLoopTracker not reset on epoch rollover
- Background tasks never trim session
- System prompt has no size budget
- shouldSynthesize uses stale cross-session stepResults

### Task/WebSocket (P0-P1)
- typing:false never sent — indicator can stick forever
- ACK sent before attachment validation
- Buffer.from can throw on non-string, message silently dropped
- Queue overflow leaks AbortController
- cancel() bypasses terminal status guard

### Monitor/Frontend (P1)
- monitor:clear never emitted — old tasks accumulate
- No DAG replay on reconnect
- reviewStatus from drag-drop never persisted
- useWebSocket store mutation during render
- Single ErrorBoundary — monitor crash kills entire app

### Memory/Learning (P0-P1)
- Pattern table unbounded growth
- MMR diversity formula broken
- Consolidation engine bypasses HNSW mutex
- Cross-session hit count dedup lost on restart
- observeToolUse + handleToolResult double-write

### Daemon (P0-P1)
- daemonFullAutonomy=true by default
- Signal handlers accumulate on restart
- Unscheduled checklist items fire every minute
- Budget events never fire when dailyBudgetUsd undefined

### Skill/Plugin (P0-P1)
- requires.skills dependency gate dead code
- SKILL.md validation no-op on install
- PluginHotReload require.cache dead in ESM
- Single plugin init failure blocks all subsequent plugins

### Model Intelligence (P0-P1)
- FrameworkPromptGenerator never wired to orchestrator
- LiteLLM models with only max_output_tokens silently dropped
- supportsThinking:false hardcoded for all LiteLLM models
- Same-name models from different providers overwrite each other

### Session/Identity (P1)
- switchProfile mutates global singleton
- Background tasks ignore per-user persona
- Synthesis/review LLM calls bypass soul entirely
- chatId vs identityKey mismatch in personality lookup

### Context Window (P1)
- Background tasks have zero trimming
- System prompt no total-size budget
- Summarizer sends unbounded transcript

## Already Fixed (This Session)
1. parseLLMOutput — Kimi reasoning strip + lenient JSON
2. callLLMForDecomposition — Failure logging
3. calculateAdaptiveTimeout — Prompt length-based dynamic
4. handleMoveTask — monitor:task_update emit for Kanban

## Provider API Research Findings
- OpenAI GPT-5.4 (400K context), GPT-4.1 (1M context) current
- Claude Opus 4.6 (1M context GA), adaptive thinking recommended
- Kimi model name is kimi-k2.5, not kimi-for-coding
- Ollama context window 8K hardcoded but models support 32-128K+
- PROVIDER_COSTS missing Together, Fireworks, Qwen entries
