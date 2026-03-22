# Learning Pipeline v2: Surgical Recore + Expand

**Date:** 2026-03-22
**Status:** Approved
**Approach:** Fix working parts, replace broken parts, add new capabilities

---

## Context

The current learning pipeline has a solid foundation (SQLite storage, event bus, instinct model, cross-session provenance) but several critical bugs and gaps:

**Current confidence system (factual):**
- `ConfidenceScorer.calculate()` is a weighted 5-factor model — exists but is **never called from production code** (only tests)
- `ConfidenceScorer.updateConfidence()` uses pure Bayesian posterior (`alpha / (alpha + beta)`) — this is the **active runtime path**
- Alpha/beta parameters are stored in the instincts table and updated on every observation
- The comment in `confidence-scorer.ts` says "Alpha/beta are for evidence tracking, not primary computation" but the opposite is true at runtime

**Existing instinct lifecycle statuses:**
- `proposed` (initial), `active` (confidence >= 0.7), `permanent` (>= 0.95), `deprecated` (<= 0.3), `evolved` (merged/replaced)
- Existing thresholds: `DEPRECATED=0.3`, `ACTIVE=0.7`, `EVOLUTION=0.9`, `AUTO_EVOLVE=0.95`, `MAX_INITIAL=0.5`

**Bugs:**
- `runDetectionBatch()` never called — trajectory-to-instinct extraction is dead code
- `formatInsight()` drops trajectory instincts silently (requires `action.description`)
- `maxInstincts` cap not enforced (unbounded growth)
- `minObservationsBeforeLearning` config ignored
- `strategy` config defined but unused
- `observations` table CHECK constraint missing 'feedback' and 'verification' types

**Gaps:**
- No user feedback mechanism
- No multi-scope learning (user/project/global)
- No cross-channel identity linking
- Instincts only used for passive prompt enrichment

## Design

### 1. Unified Confidence Model

Merge the unused 5-factor model into the active Bayesian system as modifiers. The proven `updateConfidence()` Bayesian path is preserved as the core; factors act as multipliers.

**Formula:**
```
rawBayesian = alpha / (alpha + beta)       // existing, proven path
factorMultiplier = clamp(0.5, sum(factor_i * weight_i) / sum(weight_i) + 0.5, 1.5)
finalScore = rawBayesian * factorMultiplier
```

The weighted average of factors (each 0.0-1.0) produces a value 0.0-1.0, shifted by +0.5 to center the multiplier at 1.0 (neutral), then clamped to 0.5-1.5. This means factors can halve or 1.5x the Bayesian score.

**Five factors (modifier, not replacement):**
1. **Recency** — time since last use (decay). 1.0 = used today, 0.0 = unused for 30+ days
2. **Consistency** — success/failure ratio stability over last 20 observations. 1.0 = all same outcome
3. **Scope breadth** — how many projects/users validate this. 1.0 = 5+ projects
4. **User validation** — explicit feedback ratio. 1.0 = all thumbs up, 0.0 = all thumbs down
5. **Cross-session durability** — survived N restarts without deprecation. 1.0 = 10+ restarts

Default weights: `[0.15, 0.25, 0.15, 0.30, 0.15]` (user validation weighted highest). Configurable via `config.learning.confidenceWeights`.

**Intervention tiers (orthogonal to lifecycle):**

Intervention is a SEPARATE dimension from lifecycle status. An instinct's lifecycle (`proposed/active/permanent/deprecated/evolved`) determines its existence; intervention tier determines how aggressively it's applied.

| Confidence | Intervention Tier | Behavior |
|-----------|-------------------|----------|
| `< 0.3` | Passive | Prompt enrichment only |
| `0.3–0.6` | Suggest | Tool parameter suggestions |
| `0.6–0.8` | Warn | Proactive warnings |
| `> 0.8` | Auto | Automatic application (overridable) |

**Lifecycle ↔ Intervention mapping:**

| Lifecycle Status | Valid Intervention Tiers | Notes |
|-----------------|------------------------|-------|
| `proposed` | Passive only | New instincts never intervene actively |
| `active` | Passive, Suggest, Warn | Based on confidence (0.7+ = active) |
| `permanent` | Passive, Suggest, Warn, Auto | Only permanent can reach Auto (0.95+) |
| `deprecated` | None (not retrieved) | Confidence < 0.3, excluded from retrieval |
| `evolved` | None (replaced) | Successor instinct is used instead |

This means the existing `CONFIDENCE_THRESHOLDS` constants remain unchanged for lifecycle transitions. Intervention tiers are a new orthogonal system read from the same confidence value.

**Migration:** Modify `confidence-scorer.ts` in-place (no rename — avoids breaking 10+ import paths). Remove dead `calculate()` method body, replace with unified formula. Add factor columns to instincts table:

```sql
ALTER TABLE instincts ADD COLUMN factor_recency REAL DEFAULT 0.5;
ALTER TABLE instincts ADD COLUMN factor_consistency REAL DEFAULT 0.5;
ALTER TABLE instincts ADD COLUMN factor_scope_breadth REAL DEFAULT 0.0;
ALTER TABLE instincts ADD COLUMN factor_user_validation REAL DEFAULT 0.5;
ALTER TABLE instincts ADD COLUMN factor_cross_session REAL DEFAULT 0.0;
ALTER TABLE instincts ADD COLUMN trust_level TEXT DEFAULT 'new';
ALTER TABLE instincts ADD COLUMN seed INTEGER DEFAULT 0;
```

**Files:**
- Modify: `src/learning/scoring/confidence-scorer.ts` — replace `calculate()` body with unified formula, keep filename
- Modify: `src/learning/pipeline/learning-pipeline.ts` — use unified scorer
- Modify: `src/learning/storage/learning-storage.ts` — add factor columns via migration

### 2. Detection Pipeline Fix & Enhancement

#### 2a. Inline Detection (replaces dead `runDetectionBatch`)

Event-driven detection on every tool result:

```
tool:result → recordObservation() → detectPatternInline() → extractInstinct()
```

`detectPatternInline()` checks last N observations (configurable, default 20 — larger than `minObservationsBeforeLearning` to give detection a reasonable window):

- **Same error detection:** Uses existing `sanitizePattern(errorDetails.message)` to normalize error messages (replaces names, numbers, paths with placeholders). Same sanitized pattern 3+ times in the window → error pattern instinct.
- **Same tool sequence detection:** Same ordered tool sequence (by tool name) 3+ times → workflow pattern instinct.
- `minObservationsBeforeLearning` (default 5) enforced — no instincts created until 5+ observations recorded in the session.

Performance requirement: inline detection adds <5ms per tool call (window is in-memory, no DB query).

#### 2b. Periodic Trajectory Extraction

Wire the existing `extractInstinctFromTrajectory()` to a periodic timer:

```
periodicTimer (5 min, configurable)
  → find unprocessed trajectories (WHERE processed = 0)
  → extractInstinctFromTrajectory() for each
  → create instinct, mark as processed (UPDATE SET processed = 1)
```

Uses the existing `strategy: "periodic"` config that was previously ignored. Add `processed` column to trajectories table.

#### 2c. formatInsight() Fix

Support both instinct action formats:
```typescript
const text = action.description
  ?? `When using ${action.tool}: ${summarize(action.output)}`;
```

Where `summarize()` truncates to 200 chars with ellipsis.

#### 2d. maxInstincts Enforcement

On `storeInstinct()`, if count exceeds `maxInstincts` (default 1000):
1. Delete lowest-confidence deprecated instincts
2. If still over, deprecate lowest-confidence active instincts

**Files:**
- Modify: `src/learning/pipeline/learning-pipeline.ts` — add `detectPatternInline()`, wire periodic timer, enforce maxInstincts
- Modify: `src/agents/instinct-retriever.ts` — fix `formatInsight()`
- Modify: `src/learning/storage/learning-storage.ts` — add `processed` column to trajectories

### 3. Multi-Scope Learning Architecture

#### 3a. Three Scope Layers

```
Global (all users, all projects)
  └─ Project (per project, cross-user)
      └─ User (per user, cross-channel)
```

Each instinct carries a `scope_type`: `user | project | global`.

**Migration SQL for `instinct_scopes` table:**

```sql
-- Add new columns
ALTER TABLE instinct_scopes ADD COLUMN scope_type TEXT DEFAULT 'project';
ALTER TABLE instinct_scopes ADD COLUMN user_id TEXT;

-- Backfill: existing rows with project_path='*' are global, rest are project
UPDATE instinct_scopes SET scope_type = 'global' WHERE project_path = '*';
UPDATE instinct_scopes SET scope_type = 'project' WHERE project_path != '*';

-- New index for scope-type queries
CREATE INDEX IF NOT EXISTS idx_instinct_scopes_type_user
  ON instinct_scopes(scope_type, user_id, project_path);

-- Fix observations CHECK constraint (add missing types)
-- Note: SQLite doesn't support ALTER CHECK, so this is handled in code
-- by removing the CHECK and validating in the application layer
```

The existing composite PK `(instinct_id, project_path)` remains — user-scope entries use `project_path` as normal but with `scope_type='user'` and `user_id` set.

#### 3b. Scope Promotion Rules

- User → Project: 2+ users in same project validate same pattern
- Project → Global: 3+ projects validate same pattern (existing mechanism)

Most specific scope wins on conflict.

#### 3c. Cross-Channel Identity

**New SQLite table:**

```sql
CREATE TABLE IF NOT EXISTS identity_links (
  id TEXT PRIMARY KEY,
  unified_user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  display_name TEXT,
  confirmed INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(channel_type, channel_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identity_links_unified
  ON identity_links(unified_user_id);
```

**New UserProfileStore methods:**

```typescript
linkIdentity(unifiedUserId: string, channelType: string, channelUserId: string, displayName?: string): void
resolveLinkedIdentity(channelType: string, channelUserId: string): string | null  // returns unified_user_id
getLinkedIdentities(unifiedUserId: string): IdentityLink[]
confirmIdentityLink(id: string): void
```

**UX flow for first-match confirmation:**
1. User sends first message from a new channel
2. System checks `identity_links` — no match found
3. System checks heuristics: same `displayName` across channels → candidate match
4. If candidate found: `ask_user("You look like [name] from [other channel]. Link accounts? This shares your learning preferences.")`
5. If confirmed: `linkIdentity()` with `confirmed=1`
6. If no candidate: create new `unified_user_id`, insert unconfirmed link
7. Subsequent messages from same channel_user_id: resolved instantly via index lookup

**Integration with orchestrator:** `resolveIdentityKey()` in `orchestrator-text-utils.ts` calls `resolveLinkedIdentity()` first. If no link exists, falls back to existing `userId > conversationId > chatId` logic.

#### 3d. Scope-Aware Retrieval

`InstinctRetriever.retrieve()` becomes:
1. Get user-scope instincts (userId + projectFingerprint)
2. Get project-scope instincts (projectFingerprint)
3. Get global-scope instincts
4. Merge: most specific scope wins on conflict (by `sanitizePattern()` match)
5. Filter by confidence threshold
6. Return top-N (token budget aware)

**Files:**
- Modify: `src/learning/storage/learning-storage.ts` — schema migration for scope columns + identity_links table
- Modify: `src/learning/pipeline/learning-pipeline.ts` — scope-aware instinct creation
- Modify: `src/agents/instinct-retriever.ts` — scope-aware retrieval
- Modify: `src/memory/unified/user-profile-store.ts` — linked identities (4 new methods)
- Modify: `src/agents/orchestrator-text-utils.ts` — integrate resolveLinkedIdentity

### 4. User Feedback Loop

#### 4a. Thumbs Up/Down

Channel-appropriate feedback mechanism:

| Channel | Mechanism |
|---------|-----------|
| Web | Inline buttons (👍/👎) |
| Telegram | Reaction emoji |
| Discord | Reaction emoji |
| Slack | Reaction emoji |
| WhatsApp | Reply with 👍/👎 (no native reactions API) |
| CLI | None (non-intrusive) |
| Matrix/IRC/Teams | Reaction if supported, else none |

Response metadata includes `appliedInstinctIds`. Feedback maps to these IDs:
- Thumbs up → `factor_user_validation` boosted by +0.1 (capped at 1.0)
- Thumbs down → `factor_user_validation` reduced by -0.2 (floored at 0.0), offer correction opportunity

**"Approval" and "Rejection" definitions (used throughout spec):**
- **Approval** = thumbs_up feedback with matching `appliedInstinctId` OR successful tool execution where the instinct was applied and user did not correct the output
- **Rejection** = thumbs_down feedback OR user correction within 60s of instinct-influenced output OR explicit "forget this" command

#### 4b. Natural Language Teaching

Orchestrator detects teaching intent ("remember this", "hatirla", "learn", "not et"):

1. Intent detected → `LearningPipeline.teachExplicit(content, scope, userId)` called
2. Content parsed → instinct created
3. Scope auto-determined: "in this project" → project, general → user, ambiguous → ask
4. Initial confidence: `0.7` (explicit teaching = high trust)
5. Confirmation: "Noted as project-level: 'Use UniTask, not System.Threading.Tasks'. Correct?"

No new tool — uses orchestrator's natural language understanding. Teaching instructions added to `STRADA_SYSTEM_PROMPT`.

#### 4c. Correction-Based Learning

Two correction detection mechanisms:

**Primary — Natural language correction (reliable):**
- Agent suggests → user says "no, do X instead" / "hayir, soyle yap"
- Orchestrator detects contradiction/correction in user's next message
- This is reliable because the orchestrator already understands conversational context

**Secondary — File edit heuristic (best-effort):**
- Agent does file_write at timestamp T → file modified again within 60s at timestamp T2
- IF T2 is NOT from an agent tool execution (check against tool execution log timestamps)
- THEN flag as potential correction
- This is best-effort and may produce false positives — corrections from this source start at lower confidence (0.3 vs 0.5)

```typescript
LearningPipeline.recordCorrection({
  original: string,           // agent output
  corrected: string,          // user version
  context: { tool, file, task },
  source: 'natural_language' | 'file_heuristic',
  userId: string,
})
```

Correction confidence: `0.5` for NL corrections, `0.3` for file heuristic (grows on repetition).

#### 4d. Feedback Storage

New table:
```sql
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('thumbs_up', 'thumbs_down', 'teaching', 'correction')),
  user_id TEXT,
  instinct_ids TEXT,           -- JSON array
  content TEXT,                -- teaching text or correction diff
  scope_type TEXT,             -- user | project | global
  source TEXT,                 -- 'natural_language' | 'file_heuristic' | 'reaction' | 'button'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(type, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_instinct ON feedback(instinct_ids);
```

**Relationship with observations table:** Feedback is stored ONLY in the `feedback` table, not in `observations`. The `observations` table remains for tool use/error/success events. The existing `observations` CHECK constraint is NOT modified — 'feedback' type was in the TypeScript union but never used at the DB level.

**Files:**
- New: `src/learning/feedback/feedback-handler.ts` — processes all feedback types
- New: `src/learning/feedback/teaching-parser.ts` — extracts instincts from natural language
- New: `src/learning/feedback/correction-detector.ts` — detects correction patterns (NL + file heuristic)
- Modify: `src/learning/storage/learning-storage.ts` — feedback table + indexes
- Modify: `src/learning/pipeline/learning-pipeline.ts` — `teachExplicit()`, `recordCorrection()`
- Modify: `src/agents/orchestrator.ts` — teaching intent detection, instinct ID tracking in response metadata
- Modify: channel adapters — feedback button/reaction support (web, telegram, discord, slack)

### 5. Confidence-Gated Active Intervention

#### 5a. Four Intervention Levels

See Section 1 for the tier table and lifecycle mapping.

#### 5b. Intervention Engine

New module evaluates before each tool call:

```
InterventionEngine.evaluate(toolName, params, context)
  → get relevant instincts (scope-aware, non-deprecated, non-evolved)
  → determine tier per instinct confidence
  → filter by lifecycle validity (proposed = passive only, etc.)
  → return { action, instincts, modifications }
```

#### 5c. Agent Core OODA Integration

Learning intervention enriches existing OODA cycle:
- PriorityScorer uses instinct confidence in scoring
- Reasoning phase includes high-confidence instincts in context
- Action phase: Warn/Auto instincts intervene in tool selection

No new observers — existing observer outputs enriched with instinct data.

#### 5d. Progressive Trust — Per-Instinct

Trust levels per instinct (stored in `trust_level` column):
```
new → suggest_only → warn_enabled → auto_enabled
```

**Trust level ↔ Lifecycle validity matrix:**

| Lifecycle \ Trust | new | suggest_only | warn_enabled | auto_enabled |
|-------------------|-----|-------------|-------------|-------------|
| proposed | Valid | Invalid | Invalid | Invalid |
| active | Valid | Valid | Valid | Invalid |
| permanent | Valid | Valid | Valid | Valid |
| deprecated | N/A | N/A | N/A | N/A |
| evolved | N/A | N/A | N/A | N/A |

Trust level can never exceed what lifecycle allows. A `permanent` instinct can be `auto_enabled`; an `active` instinct maxes out at `warn_enabled`.

**Transitions (using defined approval/rejection from Section 4a):**
- `new → suggest_only`: First approval (any type)
- `suggest_only → warn_enabled`: 3+ approvals, 0 rejections in last 10 uses
- `warn_enabled → auto_enabled`: 10+ approvals, confidence > 0.8, lifecycle = permanent, never overridden

**Reset:** User says "forget this" → instinct deprecated, trust_level = new. "Turn off autonomous" → all `auto_enabled` instincts for that user demoted to `warn_enabled`.

#### 5e. Override & Audit

New table:
```sql
CREATE TABLE IF NOT EXISTS intervention_log (
  id TEXT PRIMARY KEY,
  instinct_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tier TEXT NOT NULL,           -- passive | suggest | warn | auto
  action_taken TEXT NOT NULL,   -- applied | overridden | dismissed
  user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intervention_log_instinct ON intervention_log(instinct_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intervention_log_user ON intervention_log(user_id, created_at);
```

- Every Auto intervention logged
- User can undo Auto interventions → trust level drops one level
- Dashboard: "Learning Decisions" endpoint returns intervention_log with instinct details

**Files:**
- New: `src/learning/intervention/intervention-engine.ts` — core evaluation logic
- New: `src/learning/intervention/intervention-types.ts` — types
- Modify: `src/agents/orchestrator.ts` — call InterventionEngine before tool execution
- Modify: `src/agent-core/agent-core.ts` — integrate instinct confidence into OODA
- Modify: `src/learning/storage/learning-storage.ts` — intervention_log table
- Modify: `src/dashboard/server.ts` — learning decisions endpoint

### 6. Strada.Core Seed Knowledge & Cross-Channel Sync

#### 6a. Seed Instincts

Bootstrap loads Strada.Core conventions as seed instincts:

```typescript
// src/learning/seeds/strada-core-seeds.ts
const STRADA_SEEDS: SeedInstinct[] = [
  {
    pattern: "dependency_injection",
    action: { description: "Use Strada.Core DI container, not Zenject/VContainer" },
    scope: "global",
    confidence: 0.65,         // Warn tier (above 0.6 boundary)
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "mediator_pattern",
    action: { description: "Use Strada.Core MediatR implementation" },
    scope: "global",
    confidence: 0.65,
    trustLevel: "warn_enabled",
    seed: true,
  },
  // ... other Strada.Core conventions
];
```

Seed properties:
- Start at confidence `0.65` (firmly in Warn tier — recommends, doesn't force)
- User approval raises confidence; rejection creates user-scope override
- `seed: true` (stored in instincts table `seed` column) — user can't delete but can override with user-scope instinct
- Updated when Strada.Core version changes (seed instinct has `version` in metadata, compared at boot)

#### 6b. Cross-Channel Sync

No sync mechanism needed — single SQLite DB, scope queries filter by userId (resolved via `identity_links`). Different channels, same `unified_user_id` = same instincts.

`channel_origin` recorded on instinct creation (in metadata) for audit purposes only.

#### 6c. Project Fingerprint

Use existing `createProjectScopeFingerprint()`. Same project from different channels produces same fingerprint → project-scope instincts automatically shared.

**Files:**
- New: `src/learning/seeds/strada-core-seeds.ts` — seed definitions
- Modify: `src/learning/pipeline/learning-pipeline.ts` — `seedStradaConventions()` called at start
- Modify: `src/memory/unified/user-profile-store.ts` — `linkedIdentities` for cross-channel

---

## New Files Summary

| File | Purpose |
|------|---------|
| `src/learning/feedback/feedback-handler.ts` | All feedback type processing |
| `src/learning/feedback/teaching-parser.ts` | Natural language → instinct extraction |
| `src/learning/feedback/correction-detector.ts` | Correction pattern detection (NL + file heuristic) |
| `src/learning/intervention/intervention-engine.ts` | Confidence-gated tool intervention |
| `src/learning/intervention/intervention-types.ts` | Intervention type definitions |
| `src/learning/seeds/strada-core-seeds.ts` | Strada.Core convention seed data |

## Modified Files Summary

| File | Changes |
|------|---------|
| `src/learning/scoring/confidence-scorer.ts` | Replace `calculate()` with unified formula, keep filename |
| `src/learning/pipeline/learning-pipeline.ts` | Inline detection, periodic timer, teachExplicit, recordCorrection, seedStradaConventions, maxInstincts enforcement |
| `src/learning/storage/learning-storage.ts` | Schema migrations (factor columns, scope columns, feedback table, identity_links, intervention_log, trust_level, seed, processed) |
| `src/agents/instinct-retriever.ts` | Scope-aware retrieval, formatInsight fix |
| `src/agents/orchestrator.ts` | Teaching intent detection, instinct ID tracking, InterventionEngine call |
| `src/agents/orchestrator-text-utils.ts` | Integrate resolveLinkedIdentity into resolveIdentityKey |
| `src/agent-core/agent-core.ts` | Instinct confidence in OODA cycle |
| `src/memory/unified/user-profile-store.ts` | identity_links table, 4 new methods |
| `src/dashboard/server.ts` | Learning decisions endpoint |
| Channel adapters (web, telegram, discord, slack) | Feedback button/reaction support |

## Test Strategy

- **Zero regression:** All 235+ existing learning tests must pass
- **Per-module targets (~20-30 tests each):**
  - `unified-confidence-scorer.test.ts` — factor calculation, boundary values, clamping, migration
  - `feedback-handler.test.ts` — all 4 feedback types, instinct ID mapping, validation factor updates
  - `teaching-parser.test.ts` — intent detection (EN + TR), scope extraction, ambiguity handling
  - `correction-detector.test.ts` — NL correction detection, file heuristic with timestamp window, false positive filtering
  - `intervention-engine.test.ts` — all 4 tiers, lifecycle validity matrix, scope-aware retrieval
  - `strada-core-seeds.test.ts` — seed loading, version comparison, user override behavior
  - `identity-links.test.ts` — link creation, resolution, confirmation flow, cross-channel queries
- **Integration tests:**
  - feedback → confidence change → intervention tier change
  - teaching → instinct creation → retrieval in next message
  - correction → instinct with lower confidence → grows on repetition
  - cross-channel: same user, different channel, same instincts
- **Edge cases:**
  - SQLite migration fails mid-way → graceful rollback
  - Concurrent feedback on same instinct → no lost updates (WAL mode)
  - Boundary confidence values (0.3, 0.6, 0.8 exact) → deterministic tier assignment (use `>=` for upper boundary)
  - maxInstincts cap hit during bulk seed loading
- **Performance:**
  - `detectPatternInline()` < 5ms per tool call
  - `InterventionEngine.evaluate()` < 10ms per tool call
  - Scope-aware retrieval < 20ms with 1000 instincts

## Out of Scope

- TTS/voice feedback
- Canvas UI for learning visualization (separate spec)
- Plugin system for custom learning modules
- Real-time collaboration (multi-user same session)
