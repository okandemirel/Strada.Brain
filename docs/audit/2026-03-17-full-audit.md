# Strada.Brain Comprehensive Codebase Audit

> Snapshot note: This audit captures findings from 2026-03-17. It is not the authoritative source for current runtime behavior or env defaults. For current behavior, use [README.md](../../README.md), [SECURITY.md](../../SECURITY.md), [src/config/README.md](../../src/config/README.md), [src/channels/README.md](../../src/channels/README.md), and [src/dashboard/README.md](../../src/dashboard/README.md).

**Date**: 2026-03-17
**Scope**: 508 TypeScript files, ~96K lines source code, ~64K lines test code, 50 web portal files
**Method**: 100 parallel agents across 10 audit categories
**Verdict**: OpenClaw-level feature set, with production-readiness gaps requiring targeted fixes

---

## Executive Summary

| Dimension | Score | OpenClaw Comparison |
|-----------|-------|-------------------|
| Feature Completeness | 9/10 | **Exceeds** in 10 of 12 categories |
| Architecture Quality | 7.5/10 | Comparable (God class issue) |
| Security Maturity | 7.5/10 | Strong foundation, MFA stub + CORS gaps |
| Testing Maturity | 6.5/10 | 3,633 tests, portal nearly untested |
| Production Readiness | 6.5/10 | BackupScheduler/AlertManager never wired |
| Code Quality | 7/10 | Clean TypeScript, systematic `as unknown as` debt |
| Documentation | 6/10 | READMEs good, API docs nonexistent |

**Total findings: ~350+ across all categories**
- CRITICAL: 22
- HIGH: 78
- MEDIUM: 134
- LOW: 116+

---

## CRITICAL Findings (Must Fix)

### 1. Security: scrypt N parameter crashes at runtime
`src/encryption/data-protection.ts:274` — N=100000 is NOT a power of 2. `scryptSync` throws immediately. `deriveKey()` is completely non-functional.

### 2. Security: `encryptEnvValue`/`decryptEnvValue` never pass key to KeyManager
`src/encryption/data-protection.ts:647-663` — The resolved encryption key is fetched but never passed to `new KeyManager()`. Both functions always throw "No encryption key available".

### 3. Security: Dashboard API endpoints unprotected when no token
`src/dashboard/server.ts:447` — When `STRADA_DASHBOARD_TOKEN` is not set, ALL `/api/*` endpoints (including daemon approval) are completely unauthenticated.

### 4. Security: Autonomous override bypasses ALL security controls
`src/daemon/security/daemon-security-policy.ts:81` — Returns `"allow"` for ALL tools including `ALWAYS_QUEUE_TOOLS` (file_write, shell_exec, git_push). Permanent override possible with `expiresAt: undefined`.

### 5. Security: `parseApproval` defaults to "approved" for unparseable responses
`src/agent-core/routing/consensus-manager.ts:245` — Destructive operations auto-approved when LLM review response cannot be parsed. Fail-open instead of fail-safe.

### 6. Bug: Infinite recursion on any C# file with nested types
`src/intelligence/csharp-deep-parser.ts:1366` — `flattenTypes()` calls `collectNested(result)` on the same array being mutated. Any nested class triggers infinite recursion.

### 7. Bug: Infinite redecomposition loop on persistently-failing goal nodes
`src/goals/goal-executor.ts:298` — `redecompositionCount` tracked but never guarded. No `MAX_REDECOMPOSITIONS` check.

### 8. Bug: Cancelled task status overwritten to `executing`
`src/tasks/background-executor.ts:209` — `updateStatus(executing)` called before abort signal check. Task permanently stuck in non-terminal DB state.

### 9. Bug: `waiting_for_input` missing from SQL active-status queries
`src/tasks/task-storage.ts:218-219` — Tasks in `waiting_for_input` state orphaned at restart, invisible to `/status`.

### 10. Bug: Force-stopped agent memory left in live map (use-after-close)
`src/agents/multi/agent-manager.ts:222` — `stopAgent(force=true)` shuts down SQLite but leaves agent in `this.agents`. Next `startAgent` crashes on closed DB.

### 11. Bug: Backend-frontend contract mismatches (3 endpoints)
- `/api/providers/available`: `label`/`defaultModel` stripped by bootstrap adapter
- `/api/providers/active`: returns `provider` but frontend expects `providerName`
- `/api/triggers`: returns `name`/`state` but frontend expects `id`/`enabled`

### 12. Bug: Web channel `fetchJson` silently swallows all errors
`web-portal/src/utils/api.ts:18` — Returns `null` for network errors, parse failures, and HTTP errors. All `.catch(e.message)` handlers across 6 pages are dead code.

### 13. Security: Telegram bot token exposed in media download URLs
`src/channels/telegram/bot.ts:605,626,647,669` — Token interpolated into download URLs. If logged or leaked, full bot credential is compromised.

### 14. Security: Teams/Matrix/IRC channels have zero authentication
`src/channels/teams/channel.ts`, `matrix/channel.ts`, `irc/channel.ts` — No auth, no rate limiting, no input validation.

### 15. Security: `timingSafeCompare` leaks length on empty input
`src/daemon/triggers/webhook-trigger.ts:295` — Early-exit on falsy input before constant-time work.

### 16. Security: No message text length limit on ANY channel
All channels accept arbitrarily large messages. Only IRC truncates (4096). Potential OOM/DoS.

### 17. Bug: `NotificationRouter.stop()` never unsubscribes event listeners
`src/daemon/reporting/notification-router.ts:195` — Clears tracking array but never calls `eventBus.off()`. Memory leak + ghost notifications.

### 18. Bug: Slack deny-by-default blocks ALL commands when no allowlist
`src/channels/slack/commands.ts:530` — `isValidWorkspace`/`isValidUser` return false on empty lists. Inconsistent with message handler.

### 19. Bug: Discord `pendingReplyCallbacks` keyed by channelId causes cross-contamination
`src/channels/discord/bot.ts:80` — Two concurrent slash commands on same channel: second overwrites first's callback.

### 20. Bug: Deployment approval pipeline never wired
`src/daemon/triggers/deploy-trigger.ts:163` — `onApprovalDecided()` is defined and tested but bootstrap never connects the `daemon:approval_decided` event.

### 21. Security: ReadinessChecker uses `shell: true` for test command
`src/daemon/deployment/readiness-checker.ts:117` — Environment variable injection can execute arbitrary commands.

### 22. Architecture: `LearningEventMap` index signature defeats type safety
`src/core/event-bus.ts:203` — `[key: string]: unknown` means any misspelled event name compiles silently.

---

## Dead Code Summary

| Module | Dead Items | Estimated Lines |
|--------|-----------|----------------|
| Provider interfaces | Entire structured streaming subsystem | ~170 lines |
| Tool interfaces | `IEnhancedTool`, lifecycle interfaces, event types | ~200 lines |
| Orchestrator | `streamResponse` method + `STREAM_THROTTLE_MS` | ~110 lines |
| Learning scoring | `calculate()`, `getConfidenceInterval()`, `compareConfidence()`, `getFactorBreakdown()`, `calculateEloRating()`, `wilsonScoreInterval()` | ~250 lines |
| Learning types | 11 exported functions never called in production | ~100 lines |
| Pattern matcher | 6 exported methods only used in tests | ~200 lines |
| csharp-parser.ts | Largely replaced by deep-parser, kept alive only by `rag/chunker.ts` | ~400 lines |
| Daemon | `BudgetTracker.isExceeded/isWarning`, `DaemonStorage` test-only methods | ~80 lines |
| Multi-agent | `verbosity` config, `agent:started` event, `DelegationStatus` type | ~50 lines |
| Evolution pipeline | `evolveToSkill` + `solutions` table + `EvolutionProposal` type — write-only | ~150 lines |
| **Total estimated** | | **~1,700+ lines** |

---

## Test Coverage Gaps (CRITICAL)

| File | Status | Risk |
|------|--------|------|
| `src/channels/web/channel.ts` | **ZERO tests** | Primary channel, security-critical |
| `src/encryption/data-protection.ts` | **ZERO tests** | AES-256-GCM, key rotation |
| `src/memory/unified/agentdb-memory.ts` | Only migration helpers tested | Core CRUD operations untested |
| `src/validation/schemas.ts` + `index.ts` | **ZERO tests** | Security boundary |
| `src/network/firewall.ts` | **ZERO tests** | CIDR math, DDoS protection |
| `src/core/di-container.ts` | **ZERO tests** | Circular dep detection |
| `src/core/tool-registry.ts` | **ZERO tests** | Central tool dispatch |
| `src/core/setup-wizard.ts` | **ZERO tests** | Security-critical input validation |
| `src/intelligence/unity-guid-resolver.ts` | **ZERO tests** | Safety gate for file deletion |
| `src/intelligence/strada-drift-validator.ts` | Only zero-drift case tested | All error/warning branches untested |
| Web portal | **2 smoke tests** for entire React app | No component/hook tests |

---

## Architecture Issues

### God Classes
- `orchestrator.ts`: ~1,900 lines, 27-parameter constructor
- `bootstrap.ts`: ~1,350 lines, manual wiring of every subsystem

### Layer Violations (35 total)
- **17 HIGH**: `memory` imports from `agents/providers`, `learning` imports from `agents/tools`, `agent-core` imports from `channels`
- Root cause: `IAIProvider`, `ITool`, `IChannelAdapter` defined in high-level modules but consumed by foundational layers

### Unused Infrastructure
- DI Container exists but is decorative — bootstrap constructs everything manually
- `BackupScheduler` implemented but never started
- `AlertManager` implemented but never wired to events
- `ModelIntelligenceService` never initialized

---

## OpenClaw Comparison

| Feature | Strada.Brain | Claude Code | Winner |
|---------|-------------|-------------|--------|
| Agent orchestration | PAOR + OODA + DAG goals | Reactive loop | **Strada** |
| Multi-model | 12 providers + fallback chain | Claude only | **Strada** |
| Memory | SQLite+HNSW 3-tier + learning | CLAUDE.md static files | **Strada** |
| Multi-channel | 6 channels + session isolation | Terminal only | **Strada** |
| Personality | soul.md + profiles + hot-reload | None | **Strada** |
| Clarification | Structured ask_user + show_plan | Plain text | **Strada** |
| Daemon/Autonomy | HeartbeatLoop + triggers + OODA | None | **Strada** |
| Streaming | Recent fragility fixes | Battle-hardened | **Claude Code** |
| Plugin system | File-scan, no sandbox | MCP (process isolation) | **Claude Code** |
| Production polish | 6.5/10 | 9/10 | **Claude Code** |

**Overall**: Strada.Brain has a significantly richer feature set. Claude Code wins on production polish, streaming reliability, and plugin sandboxing. The gap is in hardening, not in capability.

---

## Priority Remediation Roadmap

### Phase 1: Critical Security (1-2 days)
1. Fix scrypt N parameter (1 line)
2. Fix `encryptEnvValue`/`decryptEnvValue` key passing (2 lines)
3. Enforce auth on dashboard API when no token (3 lines)
4. Add max text length to all channels (6 lines)
5. Fix `parseApproval` to fail-safe (1 line)
6. Fix `timingSafeCompare` empty-input leak (5 lines)
7. Bind Teams channel to 127.0.0.1 (1 line)
8. Add auth + rate limiting to Teams/Matrix/IRC channels

### Phase 2: Critical Bugs (2-3 days)
1. Fix `flattenTypes` infinite recursion (3 lines)
2. Add `MAX_REDECOMPOSITIONS` guard to goal executor (5 lines)
3. Fix cancelled task status overwrite (1 line — add abort check before updateStatus)
4. Add `waiting_for_input` to SQL queries (2 lines)
5. Fix force-stopped agent use-after-close (1 line — delete from map)
6. Fix backend-frontend contract mismatches (3 endpoints)
7. Wire `NotificationRouter.stop()` to call `eventBus.off()`
8. Wire deployment approval pipeline in bootstrap
9. Fix `fetchJson` to throw on errors

### Phase 3: Dead Code Cleanup (1 day)
1. Delete entire structured streaming subsystem from provider interfaces
2. Delete `streamResponse` + `STREAM_THROTTLE_MS` from orchestrator
3. Delete unused scoring methods from `ConfidenceScorer`
4. Migrate `rag/chunker.ts` to deep-parser, then delete `csharp-parser.ts`

### Phase 4: Test Coverage (3-5 days)
1. Web channel tests (highest priority — primary channel, zero coverage)
2. `data-protection.ts` tests
3. `validation/schemas.ts` tests
4. `agentdb-memory.ts` core CRUD tests
5. Web portal component tests with `@testing-library/react`

### Phase 5: Architecture (1 week)
1. Extract `SystemPromptBuilder`, `SessionManager`, `ToolExecutor` from Orchestrator
2. Move `IAIProvider`, `ITool`, `IChannelAdapter` to `src/common/contracts/`
3. Activate DI container for actual dependency wiring
4. Wire `BackupScheduler` and `AlertManager` in bootstrap
5. Add `rehype-sanitize` to ReactMarkdown pipeline
6. Add route-level `React.lazy` code splitting

---

*Generated by 100 parallel audit agents analyzing 508 files across 10 categories.*
