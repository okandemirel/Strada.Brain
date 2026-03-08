# Strada.Brain

## What This Is

Strada.Brain is an AI-powered Unity development assistant built on the Strada.Core framework. It operates across 6 channels (Web, Telegram, Discord, Slack, WhatsApp, CLI) with a PAOR state machine driving autonomous agent behavior. As of v1.0, it is a Level 4 autonomous agent with persistent memory, real-time learning, recursive goal decomposition, self-evaluation metrics, and tool chain synthesis.

## Core Value

The agent must reason, learn, and adapt autonomously — not just respond to prompts. Real memory persistence, real-time learning from outcomes, recursive goal decomposition, self-evaluation, and tool synthesis are the five pillars that transform a chatbot wrapper into a genuine autonomous agent.

## Requirements

### Validated

- ✓ Multi-channel messaging (Web, Telegram, Discord, Slack, WhatsApp, CLI) — existing
- ✓ PAOR state machine (Plan → Act → Observe → Reflect) with phase-aware prompts — Phase 1
- ✓ 12 AI provider integrations with per-chat selection and fallback chains — existing
- ✓ 25+ tool implementations (file ops, search, git, shell, .NET, Strata-specific) — existing
- ✓ RAG pipeline with HNSW vector search for Unity/C# code — existing
- ✓ Learning pipeline with pattern matching, confidence scoring, instinct lifecycle — existing
- ✓ InstinctRetriever for proactive learned pattern injection into planning phase — Phase 1
- ✓ Failure classifier with automatic replan triggers — Phase 1
- ✓ Error recovery engine, task planner, self-verification — existing
- ✓ Security layer (auth, rate limiting, path guard, secret sanitization) — existing
- ✓ Background task execution with concurrency control — existing
- ✓ Zod-validated configuration with per-provider model overrides — existing
- ✓ Dashboard with Prometheus metrics and WebSocket real-time updates — existing
- ✓ AgentDB persistent memory backend (SQLite+HNSW, 3-tier auto-tiering) — v1.0
- ✓ FileMemoryManager data migration to AgentDB with zero data loss — v1.0
- ✓ HNSW semantic search for conversation retrieval — v1.0
- ✓ 3-tier auto-tiering (Working → Ephemeral → Persistent) based on access patterns — v1.0
- ✓ Event-driven real-time learning (immediate pattern storage from tool outcomes) — v1.0
- ✓ CachedEmbeddingProvider shared between RAG and learning pipeline — v1.0
- ✓ Online confidence updates from real tool outcomes via TypedEventBus — v1.0
- ✓ Metrics instrumentation (task completion rate, iterations per task, pattern reuse rate) — v1.0
- ✓ Bayesian Beta posterior confidence scoring (auto-deprecation < 0.3, auto-promotion > 0.95) — v1.0
- ✓ Recursive goal decomposition with DAG dependencies and cycle detection — v1.0
- ✓ Wave-based parallel goal execution with failure budgets and resume — v1.0
- ✓ Tool chain synthesis (sequence detection, composite tool generation, dynamic registry) — v1.0

### Active

(No active requirements — define in next milestone)

### Out of Scope

- New channel integrations — current 6 channels are sufficient
- New AI provider integrations — 12 providers cover all needs
- CI/CD pipeline — user preference to avoid build costs
- Arbitrary code generation for tools — security risk
- Unlimited reflection loops — cost explosion risk
- Graph database for memory — SQLite+HNSW sufficient

## Context

**Codebase:** ~97K LOC TypeScript, 2142 tests passing across 133 files, 0 type errors.

**Architecture:**
- Entry: `src/index.ts` (Commander CLI) → `src/core/bootstrap.ts`
- Memory: AgentDB (SQLite+HNSW) with 3-tier auto-tiering, HNSW write mutex
- Learning: Event-driven pipeline via TypedEventBus, Bayesian confidence, instinct lifecycle
- Goals: GoalDecomposer + GoalExecutor with DAG-based recursive decomposition
- Chains: ChainDetector → ChainSynthesizer → CompositeTool → ChainManager lifecycle
- Channels: `src/channels/{web,telegram,discord,slack,whatsapp,cli}/`
- Config: Zod schema with 50+ env-configurable options

**Known Issues:**
- Gemini returns null embeddings for some files (e.g., `AutoKeystore.cs`) — pre-existing
- Quality gates (0 passed) — `/simplify` + `/security-review` were run but STATE tracking was not incremented

## Constraints

- **Tech Stack**: TypeScript, Node.js 20+, ESM modules, better-sqlite3, hnswlib-node — no new major dependencies
- **Compatibility**: All 2142+ tests must continue to pass
- **Security**: All code follows existing security patterns (path guard, secret sanitization, input validation)
- **Quality Gates**: `/simplify` + `/security-review` after each implementation phase (mandatory)
- **Documentation**: All 8 README language versions updated after completion

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Activate dormant AgentDB rather than build new | 51KB already implemented, tested concept, reduces risk | ✓ Good — saved significant development time |
| Migrate existing data (not fresh start) | Preserve conversation history and learned patterns | ✓ Good — zero data loss migration |
| Event-driven learning over batch timer | 5-min delay prevents real-time adaptation | ✓ Good — immediate pattern storage |
| All 5 capabilities (no compromise) | Full Level 4 target required for OpenClaw-level autonomy | ✓ Good — 32/32 requirements delivered |
| Fine granularity (9 phases) | Complex brownfield changes need careful sequencing | ✓ Good — clean dependency ordering |
| Reuse RAG embedding infrastructure for learning | CachedEmbeddingProvider already works | ✓ Good — single shared instance |
| Pure Beta posterior over blended heuristic | Bayesian Beta from real outcomes (EVAL-04) | ✓ Good — principled confidence |
| Kahn's algorithm for cycle detection | O(V+E), produces topological order | ✓ Good — correct and efficient |
| Wave-based parallel execution for goals | Promise.allSettled with semaphore | ✓ Good — independent sibling parallelism |
| Duck-type check for composite tool invalidation | Avoids instanceof across module boundaries | ✓ Good — test-compatible |

---
*Last updated: 2026-03-08 after v1.0 milestone*
