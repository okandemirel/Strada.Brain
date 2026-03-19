# src/learning/

Experience replay and pattern learning system. Observes agent behavior, detects error patterns, learns reusable instincts with hybrid weighted confidence scoring, and materializes runtime self-improvement artifacts that the control plane can reuse safely.

## Architecture

```
Agent errors / outcomes
  → ErrorLearningHooks (captures observations)
  → LearningPipeline (processes every 5 minutes)
    → PatternMatcher (matches against stored patterns)
    → ConfidenceScorer (hybrid weighted 5-factor + Elo + Wilson interval)
    → LearningStorage (SQLite persistence)
    → RuntimeArtifactManager (shadow/active runtime artifact lifecycle)
  → Instinct lifecycle: proposed → active → evolved/deprecated
  → Runtime artifacts: shadow → active / rejected / retired
```

## Core Components

### LearningStorage (`storage/learning-storage.ts`)

SQLite database (`learning.db`) with tables:
- `instincts` — atomic learned patterns with confidence, triggers, actions, context conditions, source trajectory lineage, and tags
- `trajectories` — recorded execution paths (tool call sequences with outcomes)
- `trajectory_instincts` — many-to-many join
- `error_patterns` — recurring error signatures with FTS5 full-text search
- `solutions` — fixes linked to error patterns
- `observations` — raw input events for batch processing
- `verdicts` — quality evaluations of trajectories
- `evolution_proposals` — persisted promotion decisions for high-confidence instincts, including affected trajectory provenance
- `runtime_artifacts` — materialized `skill`, `workflow`, and `knowledge_patch` guidance with `shadow` / `active` / `retired` / `rejected` lifecycle state plus verifier-backed stats

### LearningPipeline (`pipeline/learning-pipeline.ts`)

Runs two periodic timers:
- **Detection timer** (every 5 minutes): processes unprocessed observations, detects patterns, creates/updates instincts
- **Evolution timer** (every 1 hour): checks instincts above the auto-evolve threshold (`> 0.95`) and materializes shadow runtime artifacts plus persisted evolution proposals

### RuntimeArtifactManager (`runtime-artifact-manager.ts`)

Builds runtime-first self-improvement artifacts from high-confidence instincts without generating repo-visible files. Artifact kinds:
- `workflow` — ordered execution / verification playbooks, typically derived from stable tool-usage or replay patterns
- `skill` — reusable decision policies or fix heuristics
- `knowledge_patch` — durable factual corrections about providers, tools, or project/world behavior

Lifecycle:
- `shadow` — evaluation-only; collected and scored but not injected as mandatory guidance
- `active` — promoted after verifier-backed clean shadow runs meet promotion thresholds
- `rejected` — harmful shadow artifact; no longer considered
- `retired` — previously active artifact whose rolling quality fell below policy thresholds

The manager also records clean / retry / failure / blocker telemetry so promotion, rejection, and retirement stay evidence-driven. Runtime artifacts keep source instinct and source trajectory provenance so the loop remains auditable instead of becoming a black-box heuristic store. User-facing telemetry stays identity-scoped even though the control plane can still reuse matching project-scoped artifacts internally.

### ConfidenceScorer (`scoring/confidence-scorer.ts`)

Hybrid weighted confidence scoring with 5 factors: successRate (0.35), pattern (0.25), recency (0.20), context (0.15), verification (0.05). Also provides:
- **Elo-style rating** (`calculateEloRating()`) for instinct comparison
- **Wilson score intervals** (`wilsonScoreInterval()`) for statistical validity
- Alpha/beta evidence counters maintained for confidence intervals (not for primary scoring)

### PatternMatcher (`matching/pattern-matcher.ts`)

Matches errors/contexts against stored instincts. Match types:
- Exact string match
- Fuzzy matching
- Contextual (environment conditions)
- Error code matching
- Semantic similarity

### ErrorLearningHooks (`hooks/error-learning-hooks.ts`)

Hooks into the agent's error-handling flow:
- `onBeforeErrorAnalysis` — retrieves learned solutions before analysis
- `onAfterErrorResolution` — records successful fixes for future retrieval

## Instinct Lifecycle

```
proposed (confidence = 0.0)
  → active (confidence >= 0.7)
    → evolved (confidence >= 0.9, proposed for promotion)
  → deprecated (confidence < 0.3)
```

## Runtime Artifact Lifecycle

```
shadow
  → active   (>= 5 shadow samples, >= 80% clean, zero blockers, no repeated regression)
  → rejected (>= 3 harmful outcomes or repeated blocker-causing fingerprint)
active
  → retired  (rolling clean rate < 60% over last 10 uses, or repeated verifier-triggered replans)
```

## Connection to Memory

The `patterns` table in `AgentDBMemory` (`memory/unified/agentdb-memory.ts`) provides a lightweight pattern store (`storePattern()`, `getPatterns()`). This is separate from and simpler than the full learning system — it stores arbitrary keyed data with confidence scores. The learning system uses its own SQLite database.

## Key Files

| File | Purpose |
|------|---------|
| `types.ts` | Domain model: Instinct, Trajectory, Verdict, ErrorPattern, Observation |
| `index.ts` | Module exports |
| `storage/learning-storage.ts` | SQLite schema and queries |
| `pipeline/learning-pipeline.ts` | Pattern detection and evolution timers |
| `runtime-artifact-manager.ts` | Materializes and scores runtime `skill` / `workflow` / `knowledge_patch` artifacts |
| `scoring/confidence-scorer.ts` | Hybrid weighted/Elo/Wilson confidence calculations |
| `matching/pattern-matcher.ts` | Multi-strategy pattern matching |
| `hooks/error-learning-hooks.ts` | Agent error flow integration |
