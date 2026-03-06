# Strada.Brain — Phase 2: Agent Evolution (Level 3 → 4)

## What This Is

Strada.Brain is an AI-powered Unity development assistant built on the Strada.Core framework. It operates across 6 channels (Web, Telegram, Discord, Slack, WhatsApp, CLI) with a PAOR state machine driving autonomous agent behavior. Phase 2 evolves the system from a Level 3 Reasoning Agent to a Level 4-4.5 OpenClaw-level autonomous agent by activating dormant infrastructure and adding missing autonomy capabilities.

## Core Value

The agent must reason, learn, and adapt autonomously — not just respond to prompts. Real memory persistence, real-time learning from outcomes, recursive goal decomposition, self-evaluation, and tool synthesis are the five pillars that transform a chatbot wrapper into a genuine autonomous agent.

## Requirements

### Validated

- ✓ Multi-channel messaging (Web, Telegram, Discord, Slack, WhatsApp, CLI) — existing
- ✓ PAOR state machine (Plan → Act → Observe → Reflect) with phase-aware prompts — Phase 1
- ✓ 12 AI provider integrations with per-chat selection and fallback chains — existing
- ✓ 25+ tool implementations (file ops, search, git, shell, .NET, Strata-specific) — existing
- ✓ RAG pipeline with HNSW vector search for Unity/C# code — existing
- ✓ Conversation memory with TF-IDF similarity search (FileMemoryManager) — existing
- ✓ Learning pipeline with pattern matching, confidence scoring, instinct lifecycle — existing
- ✓ InstinctRetriever for proactive learned pattern injection into planning phase — Phase 1
- ✓ Failure classifier with automatic replan triggers — Phase 1
- ✓ TaskDecomposer with LLM-based decomposition (3-8 subtasks) — Phase 1
- ✓ Error recovery engine, task planner, self-verification — existing
- ✓ Security layer (auth, rate limiting, path guard, secret sanitization) — existing
- ✓ Background task execution with concurrency control — existing
- ✓ Zod-validated configuration with per-provider model overrides — existing
- ✓ Dashboard with Prometheus metrics and WebSocket real-time updates — existing

### Active

- [ ] Wire AgentDB (SQLite+HNSW, 3-tier memory) to replace FileMemoryManager in bootstrap
- [ ] Run MemoryMigrator to import existing FileMemoryManager data into AgentDB
- [ ] Enable HNSW semantic search for conversation retrieval via AgentDB
- [ ] Activate 3-tier auto-tiering (Working → Ephemeral → Persistent)
- [ ] Replace 5-min batch learning interval with event-driven real-time learning
- [ ] Populate embedding column in instincts table on every pattern store
- [ ] Wire embedding provider into learning pipeline for immediate HNSW indexing
- [ ] Online confidence updates from tool success/failure outcomes
- [ ] Extend TaskDecomposer for recursive sub-goal creation mid-execution
- [ ] Sub-goal dependency graph with progress tracking at each decomposition level
- [ ] Orchestrator creates sub-goals during execution (not just at start)
- [ ] Instrument task completion rate, iterations per task, pattern reuse rate
- [ ] Bayesian confidence updates from real outcomes (not just LLM judgment)
- [ ] Auto-deprecate patterns with confidence < 0.3
- [ ] Auto-promote patterns with confidence > 0.95
- [ ] Detect and store common tool chains as reusable patterns
- [ ] Runtime tool composition (sequential tool chains as atomic operations)
- [ ] Register synthesized tools dynamically in tool registry

### Out of Scope

- Full agent rewrite — Phase 2 activates dormant code and extends existing systems
- New channel integrations — current 6 channels are sufficient
- New AI provider integrations — 12 providers cover all needs
- UI/dashboard redesign — functional as-is
- RAG pipeline changes — working well for code search
- CI/CD pipeline — user preference to avoid build costs

## Context

**Codebase:** 267 TypeScript files, ~80K lines (25K tests), 1730 tests passing, 0 type errors.

**Dormant Infrastructure (already coded, not wired):**
- `src/memory/unified/agentdb-memory.ts` (51KB) — Full AgentDB implementation with SQLite + HNSW
- `src/memory/unified/migration.ts` (14KB) — MemoryMigrator for FileMemoryManager → AgentDB
- `src/memory/unified/unified-memory.interface.ts` (656 lines) — IUnifiedMemory interface
- `src/rag/hnsw/` — HNSW vector store (reusable for learning semantic search)
- `src/rag/embeddings/` — CachedEmbeddingProvider + resolvers (reusable for instinct embeddings)
- `src/learning/scoring/confidence-scorer.ts` — Bayesian ELO scoring (partially wired)

**Key Files to Modify:**
- `src/core/bootstrap.ts` — Wire AgentDB, embedding provider to learning
- `src/memory/unified/agentdb-memory.ts` — Interface alignment fixes
- `src/memory/unified/migration.ts` — Wire migration into bootstrap
- `src/learning/pipeline/learning-pipeline.ts` — Event-driven refactor
- `src/learning/storage/learning-storage.ts` — Populate embedding column
- `src/learning/matching/pattern-matcher.ts` — Wire real embedder
- `src/agents/orchestrator.ts` — Sub-goals, metrics, per-step injection
- `src/tasks/task-decomposer.ts` — Recursive decomposition
- `src/core/tool-registry.ts` — Dynamic tool registration
- `src/config/config.ts` — Unified memory config options

**Known Issues:**
- `learning.db` schema migration: existing DBs need `ALTER TABLE instincts ADD COLUMN embedding TEXT`
- Gemini returns null embeddings for some files (e.g., `AutoKeystore.cs`) — pre-existing

**Branch:** `feat/agent-evolution-paor` (Phase 1 complete, pushed to origin)

## Constraints

- **Tech Stack**: TypeScript, Node.js 20+, ESM modules, better-sqlite3, hnswlib-node — no new major dependencies
- **Compatibility**: All 1730+ existing tests must continue to pass
- **Migration**: Existing FileMemoryManager data must be migrated to AgentDB (no data loss)
- **Security**: All new code follows existing security patterns (path guard, secret sanitization, input validation)
- **Testing**: 50+ new tests targeting all 5 capabilities
- **Quality Gates**: `/simplify` + `/security-review` after each implementation phase (mandatory)
- **Documentation**: All 8 README language versions updated after completion

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Activate dormant AgentDB rather than build new | 51KB already implemented, tested concept, reduces risk | — Pending |
| Migrate existing data (not fresh start) | Preserve conversation history and learned patterns | — Pending |
| Event-driven learning over batch timer | 5-min delay prevents real-time adaptation; event-driven is more responsive | — Pending |
| All 5 capabilities (no compromise) | Full Level 4 target required for OpenClaw-level autonomy | — Pending |
| Fine granularity (8-12 phases) | Complex brownfield changes need careful sequencing | — Pending |
| Reuse RAG embedding infrastructure for learning | CachedEmbeddingProvider already works; avoid duplicate embedding code | — Pending |

---
*Last updated: 2026-03-06 after Phase 2 initialization*
