# Unified Budget & Settings Overhaul — Design Spec

**Date**: 2026-03-29
**Status**: Approved
**Scope**: Backend budget unification + full web portal settings overhaul

---

## 1. Problem Statement

Budget management is fragmented across 5 independent systems with no coordination:

| System | Config | Storage | Scope |
|--------|--------|---------|-------|
| RateLimiter | `rateLimit.dailyBudgetUsd/monthlyBudgetUsd` | In-memory | Per-user chat |
| DaemonBudgetTracker | `daemon.budget.dailyBudgetUsd` | SQLite `budget_entries` | Daemon triggers |
| AgentBudgetTracker | `agent.defaultBudgetUsd` | SQLite `budget_entries` (agent_id col) | Per-agent |
| Supervisor | `supervisor.verificationBudgetPct` | In-memory | Verification tasks |
| ProviderCosts | `estimateCost()` in rate-limiter.ts | None | Estimation only |

Additionally, the web portal settings page exposes only 6 editable settings while the backend supports 15+. Many settings are view-only or entirely absent from the UI.

---

## 2. Design Decisions (Brainstorming Outcomes)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Budget model | **Global cap + sub-limits** | Global limit is master gate; sub-limits are optional per-source caps |
| Portal scope | **Full overhaul** | All 10 missing settings categories added |
| Settings layout | **Sidebar navigation** | Scales to 9+ categories, always-visible nav, VS Code pattern |
| Runtime config | **Full runtime** | Portal changes take immediate effect via new API |
| Notifications | **UI + Toast** | Progress bar + Sonner toast for warnings/exceeded |
| History | **Breakdown + 7-day timeline** | Current state + per-source breakdown + sparkline chart |

---

## 3. Architecture

### 3.1 UnifiedBudgetManager

New singleton class at `src/budget/unified-budget-manager.ts` that replaces the coordination gap between existing trackers.

```
src/budget/
├── unified-budget-manager.ts    # Core manager (new)
├── unified-budget-manager.test.ts
├── budget-types.ts              # Shared types (new)
├── budget-config-store.ts       # Runtime config persistence (new)
├── budget-config-store.test.ts
└── cost-model.ts                # Provider cost estimation (moved from rate-limiter.ts)
```

**Key interface:**

```typescript
interface UnifiedBudgetConfig {
  readonly dailyLimitUsd: number;      // 0 = unlimited
  readonly monthlyLimitUsd: number;    // 0 = unlimited
  readonly warnPct: number;            // 0.8 = warn at 80%
  readonly subLimits: {
    readonly daemonDailyUsd: number;   // 0 = no sub-limit (uses global only)
    readonly agentDefaultUsd: number;  // Per-agent cap
    readonly verificationPct: number;  // % of task cost for verification
  };
}

interface BudgetSnapshot {
  readonly global: {
    readonly daily: BudgetUsage;       // { usedUsd, limitUsd, pct }
    readonly monthly: BudgetUsage;
  };
  readonly breakdown: {
    readonly daemon: number;           // USD spent today
    readonly agents: number;
    readonly chat: number;
    readonly verification: number;
  };
  readonly subLimitStatus: {
    readonly daemonExceeded: boolean;
    readonly agentExceeded: Map<string, boolean>;
  };
}

type BudgetSource = 'daemon' | 'agent' | 'chat' | 'verification';

interface CostMetadata {
  readonly model?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly triggerName?: string;    // For daemon sources
  readonly agentId?: string;        // For agent sources
}

interface DailyHistoryEntry {
  readonly date: string;            // ISO date 'YYYY-MM-DD'
  readonly daemon: number;
  readonly agents: number;
  readonly chat: number;
  readonly verification: number;
  readonly total: number;
}
```

**Core methods:**

```typescript
class UnifiedBudgetManager {
  // Cost recording — single entry point for ALL LLM costs
  recordCost(amount: number, source: BudgetSource, metadata: CostMetadata): void;

  // Snapshot for UI/API
  getSnapshot(): BudgetSnapshot;

  // Enforcement checks
  isGlobalExceeded(): boolean;        // daily OR monthly exceeded
  isSourceExceeded(source: BudgetSource, sourceId?: string): boolean;
  canSpend(estimatedCost: number, source: BudgetSource, sourceId?: string): boolean;

  // History for chart
  getDailyHistory(days: number): DailyHistoryEntry[];

  // Runtime config
  updateConfig(partial: Partial<UnifiedBudgetConfig>): void;
  getConfig(): UnifiedBudgetConfig;

  // Reset
  resetDaily(): void;
}
```

### 3.2 Config Priority Chain

```
Portal Override (SQLite budget_config) → Environment Variable → Hardcoded Default
```

**New SQLite table** (in existing DaemonStorage):

```sql
CREATE TABLE IF NOT EXISTS budget_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**BudgetConfigStore** reads from this table, falls back to env vars, then to defaults.

### 3.3 Integration with Existing Systems

The existing `BudgetTracker` and `AgentBudgetTracker` continue to work but are wrapped:

- `UnifiedBudgetManager` delegates storage to existing `DaemonStorage.insertBudgetEntry()` / `insertBudgetEntryWithAgent()`
- Adds a `source` column to `budget_entries` via migration (daemon | agent | chat | verification)
- Existing `HeartbeatLoop` calls `UnifiedBudgetManager.isGlobalExceeded()` instead of `BudgetTracker.isExceeded()`
- Existing `AgentManager` calls `UnifiedBudgetManager.isSourceExceeded('agent', agentId)` instead of `AgentBudgetTracker.isAgentExceeded()`
- `BackgroundExecutor` records cost via `UnifiedBudgetManager.recordCost()` instead of direct tracker calls
- RateLimiter budget fields (`dailyBudgetUsd`, `monthlyBudgetUsd`) are deprecated in favor of UnifiedBudgetManager

### 3.4 Event Bus Integration

```typescript
// New unified events (replace daemon:budget_* and agent:budget_*)
'budget:warning'      → { source, pct, usedUsd, limitUsd }
'budget:exceeded'     → { source, pct, usedUsd, limitUsd, isGlobal: boolean }
'budget:sub_exceeded' → { source, sourceId?, usedUsd, limitUsd }
'budget:config_updated' → { config: UnifiedBudgetConfig }
```

### 3.5 WebSocket Push

Dashboard server subscribes to budget events and pushes to connected clients:

```typescript
// Every heartbeat tick (existing interval)
ws.send({ type: 'budget:tick', data: budgetManager.getSnapshot() })

// On warning threshold
ws.send({ type: 'budget:warning', data: { source, pct, message } })

// On exceeded
ws.send({ type: 'budget:exceeded', data: { source, isGlobal, message } })
```

---

## 4. Backend API

### 4.1 New Budget Endpoints

```
GET  /api/budget
     → BudgetSnapshot (global usage, breakdown, sub-limit status)

POST /api/budget/config
     Body: Partial<UnifiedBudgetConfig>
     Validation: dailyLimitUsd >= 0, monthlyLimitUsd >= 0, warnPct 0.1-0.99,
                 agentDefaultUsd 0.01-100, verificationPct 0-50
     → { success: true, config: UnifiedBudgetConfig }

GET  /api/budget/history?days=7
     → { entries: [{ date: string, daemon: number, agents: number, chat: number,
                      verification: number, total: number }] }

POST /api/budget/reset
     → { success: true } (clears current day entries)
```

### 4.2 New Settings Endpoints

```
# Persona management (backend exists, portal missing)
GET  /api/personality/profiles
POST /api/personality/switch   Body: { profile: string }

# Trigger management (backend exists, portal missing)
GET  /api/triggers
POST /api/triggers/:id/toggle  Body: { enabled: boolean }

# Learning diagnostics (backend exists, portal missing)
GET  /api/learning/health
GET  /api/learning/decisions?limit=20

# Model refresh (backend exists, portal missing)
POST /api/models/refresh

# Approval queue (backend exists, portal missing)
GET  /api/daemon/approvals
POST /api/daemon/approvals/:id  Body: { action: 'approve' | 'reject' }

# Rate limits (new runtime endpoint)
POST /api/settings/rate-limits
     Body: { messagesPerMinute?, messagesPerHour?, tokensPerDay? }
     → { success: true, config: RateLimitConfig }

# Voice settings sync (new)
POST /api/settings/voice
     Body: { inputEnabled: boolean, outputEnabled: boolean }
GET  /api/settings/voice?chatId=X
     → { inputEnabled, outputEnabled }
```

---

## 5. Frontend — Settings Page Redesign

### 5.1 File Structure

```
web-portal/src/pages/
├── SettingsPage.tsx                    # Sidebar layout shell (rewritten)
└── settings/
    ├── BudgetSection.tsx              # Budget management (new)
    ├── ProvidersSection.tsx           # Provider + model selection (extracted)
    ├── AgentsSection.tsx              # Agent config + per-agent budgets (new)
    ├── DaemonSection.tsx              # Daemon control + triggers + approvals (extracted + enhanced)
    ├── VoiceSection.tsx               # Voice settings with backend sync (extracted + enhanced)
    ├── PersonaSection.tsx             # Personality profiles (new)
    ├── LearningSection.tsx            # Learning diagnostics (new)
    ├── RateLimitsSection.tsx          # Message/token rate limits (new)
    ├── RoutingSection.tsx             # Execution policy + routing history (extracted)
    └── AdvancedSection.tsx            # Autonomous mode + system boot (extracted)
```

### 5.2 Sidebar Categories

| # | Category | Icon | Contents |
|---|----------|------|----------|
| 1 | **Budget** | 💰 | Global limits, sub-limits, breakdown, 7-day chart, warning threshold |
| 2 | **Providers** | 🔄 | Primary worker, hard-pin toggle, model refresh, capabilities |
| 3 | **Agents** | 🤖 | Agent enable/disable, per-agent budget cap, concurrent limit, idle timeout |
| 4 | **Daemon** | ⚡ | Start/stop, triggers list (toggle), approval queue, heartbeat interval |
| 5 | **Voice** | 🎤 | Voice input/output toggles (with backend sync) |
| 6 | **Persona** | 🎭 | Active profile selector, profile list, channel overrides |
| 7 | **Learning** | 🧠 | Health status, recent decisions, self-improvement artifacts |
| 8 | **Rate Limits** | 🛡️ | Messages/min, messages/hour, tokens/day |
| 9 | **Routing** | 📊 | Preset selector, routing decisions, execution traces, phase scores |
| 10 | **Advanced** | ⚙️ | Autonomous mode, boot report, embedding status, system info |

### 5.3 Budget Section Detail

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Budget                                               │
│ Manage spending limits across all systems            │
│                                                      │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Daily Budget           [$10.00 ▼]  [Edit]       │ │
│ │ ████████░░░░░░░░░░░░░  $3.50 / $10.00 (35%)    │ │
│ └─────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Monthly Budget         [$150.00 ▼]  [Edit]      │ │
│ │ ██░░░░░░░░░░░░░░░░░░░  $18.50 / $150.00 (12%)  │ │
│ └─────────────────────────────────────────────────┘ │
│                                                      │
│ Warning Threshold:  [━━━━━━━━━○━━] 80%              │
│                                                      │
│ ─── Sub-Limits ───                                   │
│ ┌──────────────┐ ┌──────────────┐                   │
│ │ Daemon       │ │ Per Agent    │                   │
│ │ $5.00/day    │ │ $2.00/agent  │                   │
│ │ ██░░ 22%     │ │ ██░░ 40%     │                   │
│ └──────────────┘ └──────────────┘                   │
│                                                      │
│ ─── Today's Breakdown ───                            │
│ Daemon:        $1.20  ██████░░░░░░  34%             │
│ Agents:        $1.80  █████████░░░  51%             │
│ Chat:          $0.40  ██░░░░░░░░░░  11%             │
│ Verification:  $0.10  █░░░░░░░░░░░   3%             │
│                                                      │
│ ─── 7-Day Spending ───                               │
│ $12│     ╭─╮                                         │
│    │   ╭─╯ ╰─╮                                       │
│  $6│ ╭─╯     ╰──╮                                    │
│    │─╯           ╰─                                   │
│  $0└──────────────────                               │
│    Mon  Tue  Wed  Thu  Fri  Sat  Sun                 │
└─────────────────────────────────────────────────────┘
```

### 5.4 Toast Notifications

Using existing Sonner integration in AppLayout:

```typescript
// On WS budget:warning event
toast.warning(`Budget at ${pct}% — ${source} spending approaching limit`)

// On WS budget:exceeded event
toast.error(`Budget exceeded — ${isGlobal ? 'all systems paused' : `${source} paused`}`)

// On config update
toast.success('Budget settings updated')
```

### 5.5 Hooks

```typescript
// New hooks in use-api.ts
useBudget()          → GET /api/budget (30s refetch + WS push)
useBudgetHistory()   → GET /api/budget/history?days=7
usePersonality()     → GET /api/personality/profiles
useTriggers()        → GET /api/triggers
useLearningHealth()  → GET /api/learning/health
useRateLimits()      → derived from existing config endpoint
useVoiceSync()       → GET /api/settings/voice (replaces localStorage-only)
```

---

## 6. Database Migrations

### 6.1 Add `source` column to `budget_entries`

```sql
ALTER TABLE budget_entries ADD COLUMN source TEXT DEFAULT 'daemon';
CREATE INDEX idx_budget_source ON budget_entries(source, timestamp);
```

### 6.2 Create `budget_config` table

```sql
CREATE TABLE IF NOT EXISTS budget_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 6.3 Create `settings_overrides` table (for rate limits, voice sync)

```sql
CREATE TABLE IF NOT EXISTS settings_overrides (
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, scope)
);
```

---

## 7. Backward Compatibility

| Existing System | Change | Migration Path |
|----------------|--------|----------------|
| `BudgetTracker` | Retained as internal impl | UnifiedBudgetManager wraps it |
| `AgentBudgetTracker` | Retained as internal impl | UnifiedBudgetManager wraps it |
| `RateLimiter.dailyBudgetUsd` | Deprecated | Reads from UnifiedBudgetConfig |
| `RateLimiter.monthlyBudgetUsd` | Deprecated | Reads from UnifiedBudgetConfig |
| `RATE_LIMIT_DAILY_BUDGET_USD` env | Still works | Loaded as fallback if no portal override |
| `STRADA_DAEMON_DAILY_BUDGET` env | Still works | Maps to `subLimits.daemonDailyUsd` |
| `AGENT_DEFAULT_BUDGET_USD` env | Still works | Maps to `subLimits.agentDefaultUsd` |
| `budget:*` daemon events | Replaced | New `budget:*` unified events |
| `agent:budget_exceeded` events | Replaced | `budget:sub_exceeded` with source='agent' |
| SettingsPage.tsx | Rewritten | Sidebar layout, extracted sections |

---

## 8. Env Var Mapping

| Env Var | UnifiedBudgetConfig Field | Default |
|---------|--------------------------|---------|
| `STRADA_BUDGET_DAILY_USD` (new) | `dailyLimitUsd` | 0 (unlimited) |
| `STRADA_BUDGET_MONTHLY_USD` (new) | `monthlyLimitUsd` | 0 (unlimited) |
| `STRADA_BUDGET_WARN_PCT` (new) | `warnPct` | 0.8 |
| `STRADA_DAEMON_DAILY_BUDGET` (existing) | `subLimits.daemonDailyUsd` | 0 |
| `AGENT_DEFAULT_BUDGET_USD` (existing) | `subLimits.agentDefaultUsd` | 5.00 |
| `SUPERVISOR_VERIFICATION_BUDGET_PCT` (existing) | `subLimits.verificationPct` | 15 |
| `RATE_LIMIT_DAILY_BUDGET_USD` (deprecated) | Falls back to `dailyLimitUsd` | 0 |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` (deprecated) | Falls back to `monthlyLimitUsd` | 0 |

---

## 9. Testing Strategy

### 9.1 Unit Tests

- `UnifiedBudgetManager`: Global enforcement, sub-limit enforcement, rolling windows, config updates, history aggregation
- `BudgetConfigStore`: Priority chain (portal > env > default), persistence, validation
- `cost-model.ts`: Provider cost estimation (moved from rate-limiter.ts)

### 9.2 Integration Tests

- Dashboard API endpoints: GET/POST budget, history, config
- WebSocket push: budget:tick, budget:warning, budget:exceeded
- Settings API endpoints: rate-limits, voice, personality, triggers

### 9.3 Frontend Tests

- BudgetSection: Renders progress bars, editable inputs, breakdown, sparkline
- SettingsPage: Sidebar navigation, section switching
- Toast notifications: Warning/exceeded toasts on WS events
- Each new section: Renders correctly, handles API responses

---

## 10. Non-Goals

- **Real-time per-token streaming cost** — Cost is estimated post-completion, not mid-stream
- **Multi-currency** — USD only, no currency conversion
- **Per-user budget isolation** — Budget is system-wide (Strada.Brain is typically single-user)
- **Budget alerts via external channels** — Toast only, no email/Slack/webhook alerts for budget
- **Historical budget config changes** — Only current config stored, no audit log
