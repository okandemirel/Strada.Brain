---
phase: 06-bayesian-confidence-system
plan: 03
subsystem: learning
tags: [bayesian, lifecycle, retriever, cli, dashboard, metrics]

requires:
  - phase: 06-bayesian-confidence-system
    plan: 02
    provides: "Cooling state machine, promotion logic, lifecycle events, appliedInstinctIds wiring"
provides:
  - "InstinctRetriever excludes deprecated instincts from results"
  - "InstinctRetriever applies 1.2x ranking boost to permanent instincts"
  - "CLI Instinct Library Health section with status counts and weekly trends"
  - "Dashboard /api/agent-metrics lifecycle field with statusCounts and weeklyTrends"
  - "MetricsAggregation extended with optional lifecycle data"
affects: [instinct-retriever, metrics-cli, dashboard, metrics-types]

tech-stack:
  added: []
  patterns:
    - "Post-filter deprecated instincts in retriever after PatternMatcher returns"
    - "1.2x permanent boost with re-sort after score adjustment"
    - "Optional lifecycle enrichment on existing API response (backward compatible)"
    - "LearningStorage injected into DashboardServer via registerServices"

key-files:
  created:
    - ".planning/phases/06-bayesian-confidence-system/06-03-SUMMARY.md"
  modified:
    - "src/agents/instinct-retriever.ts"
    - "src/agents/instinct-retriever.test.ts"
    - "src/metrics/metrics-types.ts"
    - "src/metrics/metrics-cli.ts"
    - "src/metrics/metrics-cli.test.ts"
    - "src/dashboard/server.ts"
    - "src/dashboard/server.test.ts"

key-decisions:
  - "Post-filter in InstinctRetriever instead of storage-level filter: PatternMatcher.findSimilarInstincts loads all instincts, so filtering deprecated at retriever level is cleaner than modifying storage API"
  - "Request maxInsights+10 from PatternMatcher to account for post-filter losses from deprecated instincts"
  - "Lifecycle data is optional on MetricsAggregation (backward compatible) -- existing consumers unaffected"
  - "LearningStorage added to DashboardServer.registerServices() for lifecycle queries (same pattern as metricsStorage)"
  - "Weekly counter aggregation done in dashboard server (not storage) to decouple display logic"

patterns-established:
  - "Post-filter + boost pattern for instinct status in retriever"
  - "Optional enrichment of API responses with lifecycle data"
  - "Backward-compatible type extension (optional lifecycle field)"

requirements-completed: [EVAL-05, EVAL-06, EVAL-07]

duration: 4min
completed: 2026-03-07
---

# Phase 6 Plan 3: Lifecycle Surface Integration Summary

**InstinctRetriever status filtering with permanent boost, CLI lifecycle health section, and dashboard lifecycle API enrichment**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-07T14:33:44Z
- **Completed:** 2026-03-07T14:37:58Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- InstinctRetriever excludes deprecated instincts from all results (insights and matchedInstinctIds)
- Permanent instincts receive 1.2x ranking boost, allowing proven patterns to surface higher
- CLI `formatMetricsTable` shows Instinct Library Health section with permanent/active/cooling/proposed/deprecated counts
- CLI shows weekly trends (promoted, deprecated, cooling started this week)
- Dashboard `/api/agent-metrics` includes lifecycle field with statusCounts and weeklyTrends when LearningStorage is registered
- MetricsAggregation type extended with optional `lifecycle` field (LifecycleData, LifecycleStatusCounts, LifecycleWeeklyTrend interfaces)
- 12 new tests added (6 retriever + 4 CLI + 2 dashboard), all 1963 tests green

## Task Commits

Each task was committed atomically:

1. **Task 1: InstinctRetriever status filtering and permanent boost** - `53ea1ff` (feat)
2. **Task 2: CLI lifecycle section and dashboard lifecycle stats** - `fe4a74f` (feat)

TDD RED commits:
- `e85f300` - Failing tests for retriever status filtering
- `679b91a` - Failing tests for CLI and dashboard lifecycle

## Files Created/Modified
- `src/agents/instinct-retriever.ts` - Post-filter deprecated, 1.2x permanent boost, request extra results
- `src/agents/instinct-retriever.test.ts` - 6 new tests for deprecated exclusion, permanent boost, cooling/proposed/evolved
- `src/metrics/metrics-types.ts` - LifecycleStatusCounts, LifecycleWeeklyTrend, LifecycleData interfaces, optional lifecycle on MetricsAggregation
- `src/metrics/metrics-cli.ts` - Instinct Library Health section in formatMetricsTable with status counts and weekly trends
- `src/metrics/metrics-cli.test.ts` - 4 new tests for lifecycle section, weekly trends, backward compat, JSON lifecycle
- `src/dashboard/server.ts` - LearningStorage in registerServices, getLifecycleData helper, lifecycle enrichment in /api/agent-metrics
- `src/dashboard/server.test.ts` - 2 new tests for lifecycle in response and graceful degradation

## Decisions Made
- **Post-filter in retriever:** PatternMatcher.findSimilarInstincts() loads all instincts without status filter. Rather than modifying the storage API, we filter deprecated instincts in InstinctRetriever after receiving matches. This keeps the change localized and avoids breaking other PatternMatcher consumers.
- **Extra results buffer:** Request maxInsights+10 from PatternMatcher to account for deprecated instincts that get filtered out, ensuring the caller still gets up to maxInsights results.
- **Backward-compatible lifecycle type:** The lifecycle field is optional on MetricsAggregation, so existing code that constructs MetricsAggregation without lifecycle continues to work unchanged.
- **LearningStorage injection:** Added to registerServices() following the same pattern as metricsStorage. Dashboard queries lifecycle data in a try/catch for graceful degradation.
- **Weekly counter aggregation in dashboard:** The aggregateWeeklyCounters helper groups raw counter rows by week, keeping display logic separate from storage.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing test expected exact maxResults parameter**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** The existing test "limits results to maxInsights parameter" asserted `maxResults: 3`, but the implementation now passes `maxResults: maxInsights + 10` to account for deprecated filtering.
- **Fix:** Updated the test assertion to `maxResults: 13` with a comment explaining the reason.
- **Files modified:** src/agents/instinct-retriever.test.ts
- **Committed in:** 53ea1ff (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (bug in existing test expectation)
**Impact on plan:** Minimal -- test assertion update to match new behavior.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 6 (Bayesian Confidence System) is now fully complete (all 3 plans)
- EVAL-04 (pure Bayesian updates), EVAL-05 (auto-deprecation surfaced), EVAL-06 (auto-promotion surfaced), EVAL-07 (lower initial confidence) all complete
- All lifecycle data is now visible in retriever, CLI, and dashboard
- Phase 7 (Recursive Goal Decomposition) can proceed
- All 1963 tests pass with 0 regressions

## Self-Check: PASSED

All files exist, all commits verified, all 1963 tests pass.

---
*Phase: 06-bayesian-confidence-system*
*Completed: 2026-03-07*
