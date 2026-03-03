# src/learning/

Experience replay and pattern learning system. Observes agent behavior, detects error patterns, and learns reusable instincts with Bayesian confidence scoring.

## Architecture

```
Agent errors / outcomes
  → ErrorLearningHooks (captures observations)
  → LearningPipeline (processes every 5 minutes)
    → PatternMatcher (matches against stored patterns)
    → ConfidenceScorer (Bayesian + Elo + Wilson interval)
    → LearningStorage (SQLite persistence)
  → Instinct lifecycle: proposed → active → evolved/deprecated
```

## Core Components

### LearningStorage (`storage/learning-storage.ts`)

SQLite database (`learning.db`) with tables:
- `instincts` — atomic learned patterns with confidence, triggers, actions, context conditions
- `trajectories` — recorded execution paths (tool call sequences with outcomes)
- `trajectory_instincts` — many-to-many join
- `error_patterns` — recurring error signatures with FTS5 full-text search
- `solutions` — fixes linked to error patterns
- `observations` — raw input events for batch processing
- `verdicts` — quality evaluations of trajectories
- `evolution_proposals` — proposals to promote high-confidence instincts

### LearningPipeline (`pipeline/learning-pipeline.ts`)

Runs two periodic timers:
- **Detection timer** (every 5 minutes): processes unprocessed observations, detects patterns, creates/updates instincts
- **Evolution timer** (every 1 hour): checks instincts at confidence >= 0.9 for promotion to higher-level constructs (skills, commands, agents)

### ConfidenceScorer (`scoring/confidence-scorer.ts`)

Bayesian confidence updates with:
- **Elo-style rating** (`calculateEloRating()`) for instinct comparison
- **Wilson score intervals** (`wilsonScoreInterval()`) for statistical validity
- Scores updated on each success/failure observation

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

## Connection to Memory

The `patterns` table in `AgentDBMemory` (`memory/unified/agentdb-memory.ts`) provides a lightweight pattern store (`storePattern()`, `getPatterns()`). This is separate from and simpler than the full learning system — it stores arbitrary keyed data with confidence scores. The learning system uses its own SQLite database.

## Key Files

| File | Purpose |
|------|---------|
| `types.ts` | Domain model: Instinct, Trajectory, Verdict, ErrorPattern, Observation |
| `index.ts` | Module exports |
| `storage/learning-storage.ts` | SQLite schema and queries |
| `pipeline/learning-pipeline.ts` | Pattern detection and evolution timers |
| `scoring/confidence-scorer.ts` | Bayesian/Elo/Wilson confidence calculations |
| `matching/pattern-matcher.ts` | Multi-strategy pattern matching |
| `hooks/error-learning-hooks.ts` | Agent error flow integration |
