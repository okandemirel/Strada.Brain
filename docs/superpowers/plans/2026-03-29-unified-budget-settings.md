# Unified Budget & Settings Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate 5 fragmented budget systems into a single UnifiedBudgetManager with global caps + sub-limits, and redesign the web portal settings page with sidebar navigation and 10 new setting sections.

**Architecture:** UnifiedBudgetManager wraps existing BudgetTracker/AgentBudgetTracker, adds global daily/monthly limits + source-based breakdown. Runtime config persisted in SQLite with env var fallback. Frontend settings page decomposed into sidebar-navigated sections with real-time budget display via WebSocket push.

**Tech Stack:** TypeScript, better-sqlite3, Node.js EventEmitter, React 18, TanStack Query, Sonner (toast), Tailwind CSS, Vitest

---

## File Structure

### New Backend Files
```
src/budget/
  budget-types.ts              # Shared types (BudgetSource, UnifiedBudgetConfig, BudgetSnapshot, CostMetadata)
  budget-types.test.ts         # Type guard tests
  cost-model.ts                # Provider cost estimation (extracted from rate-limiter.ts)
  cost-model.test.ts           # Cost estimation tests
  budget-config-store.ts       # Runtime config persistence (SQLite + env fallback)
  budget-config-store.test.ts  # Config priority chain tests
  unified-budget-manager.ts    # Core manager singleton
  unified-budget-manager.test.ts
```

### New Frontend Files
```
web-portal/src/pages/
  SettingsPage.tsx              # Rewritten with sidebar shell
  settings/
    BudgetSection.tsx
    BudgetSection.test.tsx
    ProvidersSection.tsx
    ProvidersSection.test.tsx
    AgentsSection.tsx
    AgentsSection.test.tsx
    DaemonSection.tsx
    DaemonSection.test.tsx
    VoiceSection.tsx
    VoiceSection.test.tsx
    PersonaSection.tsx
    PersonaSection.test.tsx
    LearningSection.tsx
    LearningSection.test.tsx
    RateLimitsSection.tsx
    RateLimitsSection.test.tsx
    RoutingSection.tsx
    RoutingSection.test.tsx
    AdvancedSection.tsx
```

### Modified Backend Files
```
src/daemon/daemon-storage.ts          # Add budget_config table, source column migration, settings_overrides table
src/daemon/daemon-events.ts           # Add unified budget events to DaemonEventMap
src/daemon/heartbeat-loop.ts          # Replace BudgetTracker with UnifiedBudgetManager
src/tasks/background-executor.ts      # Record cost via UnifiedBudgetManager
src/agents/multi/agent-manager.ts     # Record cost via UnifiedBudgetManager
src/dashboard/server.ts               # Add budget + settings API endpoints
src/dashboard/websocket-server.ts     # Add budget WS push
src/core/bootstrap-stages/stage-daemon.ts  # Instantiate UnifiedBudgetManager
src/security/rate-limiter.ts          # Remove estimateCost (moved), deprecate budget fields
src/config/config.ts                  # Add new STRADA_BUDGET_* env vars
```

### Modified Frontend Files
```
web-portal/src/hooks/use-api.ts       # Add budget, personality, triggers, learning, voice hooks
web-portal/src/styles/globals.css     # Add settings-sidebar styles
```

---

## Task 1: Budget Types

**Files:**
- Create: `src/budget/budget-types.ts`
- Create: `src/budget/budget-types.test.ts`

- [ ] **Step 1: Create budget types file**

Create `src/budget/budget-types.ts` with these exports:
- `BudgetSource` type: `"daemon" | "agent" | "chat" | "verification"`
- `BUDGET_SOURCES` const array of all valid sources
- `CostMetadata` interface: `{ model?, tokensIn?, tokensOut?, triggerName?, agentId? }`
- `BudgetUsage` interface: `{ usedUsd, limitUsd, pct }`
- `BudgetSnapshot` interface: `{ global: { daily, monthly }, breakdown: { daemon, agents, chat, verification }, subLimitStatus: { daemonExceeded, agentExceeded } }`
- `UnifiedBudgetConfig` interface: `{ dailyLimitUsd, monthlyLimitUsd, warnPct, subLimits: { daemonDailyUsd, agentDefaultUsd, verificationPct } }`
- `DEFAULT_BUDGET_CONFIG` constant: all unlimited (0), warnPct 0.8, agentDefaultUsd 5, verificationPct 15
- `DailyHistoryEntry` interface: `{ date, daemon, agents, chat, verification, total }`
- `isBudgetSource(s: string)` type guard
- `toBudgetUsage(usedUsd, limitUsd)` helper: computes pct, returns 0 pct when limit is 0

- [ ] **Step 2: Write tests for type guards and helpers**

Create `src/budget/budget-types.test.ts` testing:
- `isBudgetSource` accepts all 4 valid sources, rejects invalid strings
- `toBudgetUsage` computes pct correctly, returns 0 for unlimited, handles over-budget (pct > 1)
- `DEFAULT_BUDGET_CONFIG` has expected defaults

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/budget/budget-types.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/budget/budget-types.ts src/budget/budget-types.test.ts
git commit -m "feat(budget): add unified budget type system"
```

---

## Task 2: Cost Model Extraction

**Files:**
- Create: `src/budget/cost-model.ts`
- Create: `src/budget/cost-model.test.ts`
- Modify: `src/security/rate-limiter.ts`

- [ ] **Step 1: Create cost-model.ts**

Move `PROVIDER_COSTS` map and `estimateCost()` function from `src/security/rate-limiter.ts` into `src/budget/cost-model.ts`. Add `gemini` and `kimi` provider entries. Export `estimateCost()` and `getProviderCosts()`.

- [ ] **Step 2: Write tests**

Create `src/budget/cost-model.test.ts` testing:
- Claude cost: 1000 input + 500 output = $0.0105
- Ollama is free (returns 0)
- Unknown provider uses default cost
- `getProviderCosts` returns correct rates for known/unknown providers

- [ ] **Step 3: Update rate-limiter.ts**

Remove `PROVIDER_COSTS`, `DEFAULT_COST`, and `estimateCost()` from `src/security/rate-limiter.ts`. Add re-export: `export { estimateCost } from "../budget/cost-model.js";`

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/budget/cost-model.test.ts` and `npx vitest run src/security/rate-limiter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/budget/cost-model.ts src/budget/cost-model.test.ts src/security/rate-limiter.ts
git commit -m "refactor(budget): extract cost model from rate-limiter into budget module"
```

---

## Task 3: Database Migrations

**Files:**
- Modify: `src/daemon/daemon-storage.ts`

- [ ] **Step 1: Add tables to DAEMON_SCHEMA_SQL**

Append to the `DAEMON_SCHEMA_SQL` constant:
```sql
CREATE TABLE IF NOT EXISTS budget_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_overrides (
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, scope)
);
```

- [ ] **Step 2: Add migrateBudgetSource() method**

Follow the `migrateAgentBudget()` pattern:
- Try ALTER TABLE to add `source TEXT DEFAULT 'daemon'` column (catch and ignore if exists)
- CREATE INDEX IF NOT EXISTS `idx_budget_source` on `(source, timestamp)`
- Prepare statements: `sumBudgetBySource`, `sumBudgetForSource`, `dailyHistory`

- [ ] **Step 3: Add prepared statements and CRUD methods**

Add to `prepareStatements()`: `getBudgetConfig`, `setBudgetConfig`, `getAllBudgetConfig`, `getSettingsOverride`, `setSettingsOverride`.

Add public methods: `getBudgetConfig(key)`, `setBudgetConfig(key, value)`, `getAllBudgetConfig()`, `sumBudgetBySource(windowStart)`, `sumBudgetForSource(source, windowStart)`, `getDailyHistory(windowStart)`, `getSettingsOverride(key, scope)`, `setSettingsOverride(key, value, scope)`.

Update `insertBudgetEntry` to accept optional `source` parameter.

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run src/daemon/daemon-storage.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/daemon-storage.ts
git commit -m "feat(budget): add budget_config, settings_overrides tables and source column migration"
```

---

## Task 4: Budget Config Store

**Files:**
- Create: `src/budget/budget-config-store.ts`
- Create: `src/budget/budget-config-store.test.ts`

- [ ] **Step 1: Write failing tests**

Test the three-tier priority chain: portal override (SQLite) > env var > default.
- Returns defaults when no overrides
- Reads env vars as fallback (set `STRADA_BUDGET_DAILY_USD`)
- Portal override takes priority over env var
- `updateConfig` persists to storage via `setBudgetConfig`
- Validates `warnPct` range (0.1-0.99), throws on invalid

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/budget/budget-config-store.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement BudgetConfigStore**

Class with constructor accepting storage adapter. `getConfig()` resolves via `resolve()` with caching. `updateConfig(partial)` validates and persists each field. `resolve()` uses helper `val(key, envKey, fallback)` checking storage first, then env, then default.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/budget/budget-config-store.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/budget/budget-config-store.ts src/budget/budget-config-store.test.ts
git commit -m "feat(budget): add BudgetConfigStore with portal > env > default priority"
```

---

## Task 5: Unified Budget Manager

**Files:**
- Create: `src/budget/unified-budget-manager.ts`
- Create: `src/budget/unified-budget-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Test with mock storage and mock event bus:
- `recordCost`: daemon uses `insertBudgetEntry` with source, agent uses `insertBudgetEntryWithAgent`, chat uses `insertBudgetEntry` with source="chat"
- `isGlobalExceeded`: false when no limit, true when daily limit exceeded
- `getSnapshot`: returns complete snapshot with breakdown from `sumBudgetBySource`
- `checkAndEmitEvents`: emits `budget:warning` when threshold crossed, emits `budget:exceeded` when limit hit
- `isSourceExceeded`: checks daemon sub-limit, per-agent sub-limit, chat always returns false

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/budget/unified-budget-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement UnifiedBudgetManager**

Constructor takes storage adapter and event bus. Creates internal `BudgetConfigStore`. Methods:
- `recordCost(amount, source, metadata)`: routes to appropriate storage method based on source
- `getSnapshot()`: queries storage for daily/monthly totals and breakdown, builds BudgetSnapshot
- `isGlobalExceeded()`: checks daily AND monthly limits
- `isSourceExceeded(source, sourceId?)`: checks per-source sub-limits
- `canSpend(cost, source, sourceId?)`: combines global + source checks
- `getDailyHistory(days)`: aggregates raw daily history into DailyHistoryEntry[]
- `updateConfig(partial)`: delegates to config store, resets warning flags, emits config_updated
- `checkAndEmitEvents()`: checks thresholds and emits warning/exceeded events with dedup flags

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/budget/unified-budget-manager.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/budget/unified-budget-manager.ts src/budget/unified-budget-manager.test.ts
git commit -m "feat(budget): add UnifiedBudgetManager with global caps and sub-limits"
```

---

## Task 6: Budget Events in DaemonEventMap

**Files:**
- Modify: `src/daemon/daemon-events.ts`

- [ ] **Step 1: Add event types and map entries**

Add interfaces: `UnifiedBudgetWarningEvent`, `UnifiedBudgetExceededEvent`, `BudgetSubExceededEvent`, `BudgetConfigUpdatedEvent`.

Add to `DaemonEventMap`:
- `"budget:warning": UnifiedBudgetWarningEvent`
- `"budget:exceeded": UnifiedBudgetExceededEvent`
- `"budget:sub_exceeded": BudgetSubExceededEvent`
- `"budget:config_updated": BudgetConfigUpdatedEvent`

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/daemon/`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/daemon/daemon-events.ts
git commit -m "feat(budget): add unified budget events to DaemonEventMap"
```

---

## Task 7: Bootstrap Integration

**Files:**
- Modify: `src/core/bootstrap-stages/stage-daemon.ts`
- Modify: `src/daemon/heartbeat-loop.ts`
- Modify: `src/tasks/background-executor.ts`
- Modify: `src/agents/multi/agent-manager.ts`

- [ ] **Step 1: Instantiate UnifiedBudgetManager in stage-daemon.ts**

After BudgetTracker creation, create UnifiedBudgetManager with daemonStorage and daemonEventBus. Call `daemonStorage.migrateBudgetSource()`. Pass to HeartbeatLoop and return in stage result.

- [ ] **Step 2: Update HeartbeatLoop**

Add optional `unifiedBudgetManager` parameter. In the tick loop, if available, use `unifiedBudgetManager.isGlobalExceeded()` and `checkAndEmitEvents()`. Keep existing BudgetTracker as fallback.

- [ ] **Step 3: Update BackgroundExecutor**

Add optional `unifiedBudgetManager` setter/param. In `buildUsageRecorder()`, record via unified manager with source = "daemon" for daemon tasks, "chat" for user tasks. Keep legacy `daemonBudgetTracker.recordCost()` path alongside.

- [ ] **Step 4: Update AgentManager**

Add optional `unifiedBudgetManager` setter/param. In `onUsage` callback, record via unified manager with source="agent" and agentId. Keep legacy `budgetTracker.recordCost()` path alongside.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/daemon/ src/tasks/ src/agents/ src/budget/`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/bootstrap-stages/stage-daemon.ts src/daemon/heartbeat-loop.ts src/tasks/background-executor.ts src/agents/multi/agent-manager.ts
git commit -m "feat(budget): wire UnifiedBudgetManager into HeartbeatLoop, BackgroundExecutor, AgentManager"
```

---

## Task 8: Budget API Endpoints

**Files:**
- Modify: `src/dashboard/server.ts`

- [ ] **Step 1: Add GET /api/budget**

Follow existing URL matching pattern. Return `unifiedBudgetManager.getSnapshot()` + config. 503 if manager not available.

- [ ] **Step 2: Add POST /api/budget/config**

Parse JSON body, validate fields (dailyLimitUsd >= 0, monthlyLimitUsd >= 0, warnPct 0.1-0.99). Call `updateConfig()`. Return success + updated config.

- [ ] **Step 3: Add GET /api/budget/history**

Parse `days` query param (default 7, max 30). Return `getDailyHistory(days)`.

- [ ] **Step 4: Add POST /api/settings/rate-limits**

Parse body, save each override to `settings_overrides` table via `daemonStorage.setSettingsOverride()`.

- [ ] **Step 5: Add GET/POST /api/settings/voice**

GET: Read voice settings from `settings_overrides` by scope. POST: Save voice settings.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/dashboard/`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat(budget): add budget and settings API endpoints"
```

---

## Task 9: WebSocket Budget Push

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/websocket-server.ts`

- [ ] **Step 1: Subscribe to budget events and forward to WS**

In DashboardServer, subscribe to `budget:warning`, `budget:exceeded`, `budget:config_updated` and call `wsServer.broadcastAuthenticated()` for each.

- [ ] **Step 2: Add budget snapshot to periodic metrics push**

Pass `getBudgetSnapshot` callback from DashboardServer to WebSocketDashboardServer. Include in the 1-second metrics interval payload.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/websocket-server.ts
git commit -m "feat(budget): add WebSocket push for budget events and periodic snapshots"
```

---

## Task 10: Config Schema Updates

**Files:**
- Modify: `src/config/config.ts`

- [ ] **Step 1: Add Zod schema entries**

Add `stradaBudgetDailyUsd`, `stradaBudgetMonthlyUsd`, `stradaBudgetWarnPct` to configSchema with string-to-number transform and validation.

- [ ] **Step 2: Map in validateConfig() and loadFromEnv()**

Add `budget: { dailyLimitUsd, monthlyLimitUsd, warnPct }` to config object.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/config/`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/config/config.ts
git commit -m "feat(config): add STRADA_BUDGET_* env vars for unified budget system"
```

---

## Task 11: Frontend Sidebar Layout

**Files:**
- Rewrite: `web-portal/src/pages/SettingsPage.tsx`
- Create: 10 placeholder section files in `web-portal/src/pages/settings/`
- Modify: `web-portal/src/styles/globals.css`

- [ ] **Step 1: Add sidebar CSS to globals.css**

Add `.settings-sidebar`, `.settings-sidebar-item`, `.settings-sidebar-item.active`, `.settings-content` classes using existing color variables.

- [ ] **Step 2: Rewrite SettingsPage.tsx**

Replace monolithic page with sidebar + content area. Define `SIDEBAR_ITEMS` array with 10 categories. Use `useState` for active section. Lazy-load each section component. Render sidebar nav buttons + active section content.

- [ ] **Step 3: Create placeholder section files**

Create all 10 section files with minimal placeholder content (title + "Loading..." text). Each is a default export function component.

- [ ] **Step 4: Type check**

Run: `cd web-portal && npx tsc --noEmit && cd ..`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/pages/SettingsPage.tsx web-portal/src/pages/settings/ web-portal/src/styles/globals.css
git commit -m "feat(portal): rewrite SettingsPage with sidebar navigation and 10 section placeholders"
```

---

## Task 12: Frontend Budget Hooks

**Files:**
- Modify: `web-portal/src/hooks/use-api.ts`

- [ ] **Step 1: Add types and hooks**

Add response interfaces: `BudgetResponse`, `BudgetHistoryResponse`, `PersonalityProfilesResponse`, `LearningHealthResponse`, `TriggersResponse`.

Add hooks: `useBudget()` (30s refetch), `useBudgetHistory(days)` (60s refetch), `usePersonalityProfiles()`, `useLearningHealth()` (30s refetch), `useTriggers()` (30s refetch).

- [ ] **Step 2: Type check**

Run: `cd web-portal && npx tsc --noEmit && cd ..`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/hooks/use-api.ts
git commit -m "feat(portal): add budget, personality, learning, triggers query hooks"
```

---

## Task 13: Frontend Budget Section

**Files:**
- Rewrite: `web-portal/src/pages/settings/BudgetSection.tsx`
- Create: `web-portal/src/pages/settings/BudgetSection.test.tsx`

- [ ] **Step 1: Implement BudgetSection**

Components: `ProgressBar` (color-coded by pct), `EditableLimit` (click-to-edit number input).

Layout: Daily budget card (progress bar + EditableLimit + usage text), Monthly budget card (same pattern), Sub-limits grid (daemon + per-agent EditableLimits), Breakdown list (4 rows with mini progress bars), 7-day sparkline chart using existing `Sparkline` component.

Config updates via `POST /api/budget/config` with Sonner toast feedback.

- [ ] **Step 2: Write test**

Mock `useBudget` and `useBudgetHistory`. Test renders heading, daily/monthly sections, breakdown categories, usage text.

- [ ] **Step 3: Run tests**

Run: `cd web-portal && npx vitest run src/pages/settings/BudgetSection.test.tsx && cd ..`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/pages/settings/BudgetSection.tsx web-portal/src/pages/settings/BudgetSection.test.tsx
git commit -m "feat(portal): implement BudgetSection with limits, breakdown, and chart"
```

---

## Task 14: Extract Existing Settings into Sections

**Files:**
- Rewrite: `web-portal/src/pages/settings/ProvidersSection.tsx`
- Rewrite: `web-portal/src/pages/settings/DaemonSection.tsx`
- Rewrite: `web-portal/src/pages/settings/VoiceSection.tsx`
- Rewrite: `web-portal/src/pages/settings/RoutingSection.tsx`
- Rewrite: `web-portal/src/pages/settings/AdvancedSection.tsx`

- [ ] **Step 1: Extract ProvidersSection**

Move PrimaryWorkerSelector integration, embedding status display, hard-pin toggle, and model refresh button from original SettingsPage lines 640-889.

- [ ] **Step 2: Extract DaemonSection**

Move daemon start/stop, triggers count from original lines 497-639. Add triggers list with enable/disable toggles. Add approval queue with approve/reject buttons.

- [ ] **Step 3: Extract VoiceSection**

Move voice toggles from original lines 989-1036. Add backend sync via POST /api/settings/voice.

- [ ] **Step 4: Extract RoutingSection**

Move routing preset selector, decisions, traces, outcomes, phase scores display.

- [ ] **Step 5: Extract AdvancedSection**

Move boot report and autonomous mode from original lines 380-494.

- [ ] **Step 6: Run tests**

Run: `cd web-portal && npx tsc --noEmit && npx vitest run && cd ..`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add web-portal/src/pages/settings/
git commit -m "refactor(portal): extract existing settings into sidebar section components"
```

---

## Task 15: New Settings Sections

**Files:**
- Rewrite: `web-portal/src/pages/settings/AgentsSection.tsx`
- Rewrite: `web-portal/src/pages/settings/PersonaSection.tsx`
- Rewrite: `web-portal/src/pages/settings/LearningSection.tsx`
- Rewrite: `web-portal/src/pages/settings/RateLimitsSection.tsx`

- [ ] **Step 1: Implement AgentsSection**

Agent enable/disable, per-agent budget cap editor, max concurrent (1-10), idle timeout, active agents list with budget usage from `/api/agents`.

- [ ] **Step 2: Implement PersonaSection**

Active profile display, profile switcher using `POST /api/personality/switch`, profile list from `usePersonalityProfiles()`.

- [ ] **Step 3: Implement LearningSection**

Health indicator, issues list, recent decisions from `useLearningHealth()`, self-improvement artifacts from existing `/api/agent-activity`.

- [ ] **Step 4: Implement RateLimitsSection**

Editable inputs for messages/min, messages/hour, tokens/day. Save via `POST /api/settings/rate-limits`.

- [ ] **Step 5: Run tests**

Run: `cd web-portal && npx tsc --noEmit && npx vitest run && cd ..`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add web-portal/src/pages/settings/
git commit -m "feat(portal): add Agents, Persona, Learning, RateLimits settings sections"
```

---

## Task 16: Toast Notifications

**Files:**
- Modify: `web-portal/src/hooks/use-dashboard-socket.ts`

- [ ] **Step 1: Handle budget WS events**

In the WebSocket message handler, add cases for `budget:warning` and `budget:exceeded`. Use `toast.warning()` and `toast.error()` from Sonner.

- [ ] **Step 2: Commit**

```bash
git add web-portal/src/hooks/use-dashboard-socket.ts
git commit -m "feat(portal): add toast notifications for budget warning and exceeded events"
```

---

## Task 17: Full Test Suite Validation

- [ ] **Step 1: Run backend tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 2: Run portal tests**

Run: `cd web-portal && npx vitest run && cd ..`
Expected: All PASS

- [ ] **Step 3: Type check both**

Run: `npx tsc --noEmit && cd web-portal && npx tsc --noEmit && cd ..`
Expected: No errors

- [ ] **Step 4: Fix and commit if needed**

```bash
git add -A && git commit -m "fix: resolve test failures from unified budget integration"
```

---

## Task 18: Mandatory Reviews

- [ ] **Step 1: Run /simplify**

Review all changed code for reuse, quality, and efficiency.

- [ ] **Step 2: Run /security-review**

Check for input validation, injection risks, and auth on new endpoints.

- [ ] **Step 3: Run code-review**

Full code review of the implementation.

- [ ] **Step 4: Fix any issues, commit**

```bash
git add -A && git commit -m "fix: address review findings from simplify, security, and code review"
```

---

## Execution Summary

| Task | Description | New Files | Modified Files |
|------|-------------|-----------|----------------|
| 1 | Budget types | 2 | 0 |
| 2 | Cost model extraction | 2 | 1 |
| 3 | Database migrations | 0 | 1 |
| 4 | Budget config store | 2 | 0 |
| 5 | Unified budget manager | 2 | 0 |
| 6 | Budget events | 0 | 1 |
| 7 | Bootstrap integration | 0 | 4 |
| 8 | Budget API endpoints | 0 | 1 |
| 9 | WebSocket push | 0 | 2 |
| 10 | Config schema | 0 | 1 |
| 11 | Settings sidebar layout | 11 | 1 |
| 12 | Budget hooks | 0 | 1 |
| 13 | Budget section UI | 2 | 0 |
| 14 | Extract existing sections | 5 | 0 |
| 15 | New sections | 4 | 0 |
| 16 | Toast notifications | 0 | 1 |
| 17 | Full test validation | 0 | 0 |
| 18 | Mandatory reviews | 0 | varies |

**Total: ~30 new files, ~14 modified files, 18 tasks**
