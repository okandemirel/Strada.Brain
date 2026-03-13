/**
 * Metrics CLI
 *
 * CLI command logic for `strada-brain metrics`.
 * Provides formatted table and JSON output for agent performance metrics.
 * Creates a standalone MetricsStorage instance for read-only queries.
 */

import { join } from "node:path";
import { loadConfigSafe } from "../config/config.js";
import { MetricsStorage } from "./metrics-storage.js";
import type { MetricsAggregation, MetricsFilter } from "./metrics-types.js";
import { parseDurationToTimestamp } from "./parse-duration.js";
import { LearningStorage } from "../learning/storage/learning-storage.js";
import { MS_PER_DAY } from "../learning/types.js";
import { MigrationRunner } from "../learning/storage/migrations/index.js";
import { migration001CrossSessionProvenance } from "../learning/storage/migrations/001-cross-session-provenance.js";

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format a MetricsAggregation into a readable ASCII table.
 */
export function formatMetricsTable(agg: MetricsAggregation): string {
  const lines: string[] = [];
  lines.push("Agent Performance Metrics");
  lines.push("========================");
  lines.push(`${"Total Tasks:".padEnd(24)}${agg.totalTasks}`);
  lines.push(
    `${"Completion Rate:".padEnd(24)}${(agg.completionRate * 100).toFixed(1)}%`,
  );
  lines.push(`${"  Success:".padEnd(24)}${agg.successCount}`);
  lines.push(`${"  Failure:".padEnd(24)}${agg.failureCount}`);
  lines.push(`${"  Partial:".padEnd(24)}${agg.partialCount}`);
  lines.push(`${"Avg Iterations:".padEnd(24)}${agg.avgIterations.toFixed(1)}`);
  lines.push(`${"Avg Tool Calls:".padEnd(24)}${agg.avgToolCalls.toFixed(1)}`);
  lines.push(
    `${"Instinct Reuse:".padEnd(24)}${agg.instinctReusePct.toFixed(1)}% of tasks`,
  );
  lines.push(
    `${"Avg Instincts/Task:".padEnd(24)}${agg.avgInstinctsPerInformedTask.toFixed(1)}`,
  );

  // Lifecycle section (Phase 6: Confidence System)
  if (agg.lifecycle) {
    const { statusCounts, weeklyTrends } = agg.lifecycle;
    lines.push("");
    lines.push("Instinct Library Health");
    lines.push("========================");
    lines.push(
      `${"Permanent:".padEnd(14)}${String(statusCounts.permanent).padEnd(6)}` +
      `${"Active:".padEnd(10)}${String(statusCounts.active).padEnd(6)}` +
      `${"Cooling:".padEnd(10)}${String(statusCounts.cooling).padEnd(6)}` +
      `${"Proposed:".padEnd(11)}${String(statusCounts.proposed).padEnd(6)}` +
      `${"Deprecated:".padEnd(13)}${statusCounts.deprecated}`
    );

    // Weekly trends (most recent week)
    if (weeklyTrends.length > 0) {
      const latest = weeklyTrends[0]!;
      lines.push(
        `This week: ${latest.promoted} promoted, ${latest.deprecated} deprecated, ${latest.coolingStarted} cooling started`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Format a MetricsAggregation as pretty-printed JSON.
 */
export function formatMetricsJson(agg: MetricsAggregation): string {
  return JSON.stringify(agg, null, 2);
}

// ─── Command Runner ─────────────────────────────────────────────────────────

/**
 * Run the metrics CLI command. Loads config, queries MetricsStorage, and prints output.
 */
export function runMetricsCommand(opts: {
  json?: boolean;
  session?: string;
  since?: string;
}): void {
  const configResult = loadConfigSafe();
  if (configResult.kind === "err") {
    console.error(`Configuration error: ${configResult.error}`);
    process.exit(1);
  }

  const config = configResult.value;
  const dbPath = join(config.memory.dbPath, "learning.db");

  let storage: MetricsStorage | undefined;
  try {
    storage = new MetricsStorage(dbPath);
    storage.initialize();

    const filter: MetricsFilter = {
      ...(opts.session && { sessionId: opts.session }),
      ...(opts.since && { since: parseDurationToTimestamp(opts.since) || undefined }),
    };

    let enriched: MetricsAggregation = storage.getAggregation(filter);

    // Enrich with lifecycle data from LearningStorage
    try {
      const ls = new LearningStorage(dbPath);
      ls.initialize();
      try {
        const allInstincts = ls.getInstincts();
        const active = allInstincts.filter(i => i.status === "active" && i.coolingStartedAt == null).length;
        const cooling = allInstincts.filter(i => i.coolingStartedAt != null).length;
        const deprecated = allInstincts.filter(i => i.status === "deprecated").length;
        const permanent = allInstincts.filter(i => i.status === "permanent").length;
        const proposed = allInstincts.filter(i => i.status === "proposed").length;
        const rawCounters = ls.getWeeklyCounters(4);

        // Aggregate raw counter rows into LifecycleWeeklyTrend entries
        const byWeek = new Map<number, { promoted: number; deprecated: number; coolingStarted: number; coolingRecovered: number }>();
        for (const c of rawCounters) {
          if (!byWeek.has(c.weekStart)) {
            byWeek.set(c.weekStart, { promoted: 0, deprecated: 0, coolingStarted: 0, coolingRecovered: 0 });
          }
          const entry = byWeek.get(c.weekStart)!;
          switch (c.eventType) {
            case "promoted": entry.promoted = c.count; break;
            case "deprecated": entry.deprecated = c.count; break;
            case "cooling_started": entry.coolingStarted = c.count; break;
            case "cooling_recovered": entry.coolingRecovered = c.count; break;
          }
        }
        const weeklyTrends = Array.from(byWeek.entries())
          .map(([weekStart, data]) => ({ weekStart, ...data }))
          .sort((a, b) => b.weekStart - a.weekStart);

        enriched = {
          ...enriched,
          lifecycle: {
            statusCounts: { permanent, active, cooling, proposed, deprecated },
            weeklyTrends,
          },
        };
      } finally {
        ls.close();
      }
    } catch {
      // LearningStorage not available — lifecycle section omitted
    }

    if (opts.json) {
      console.log(formatMetricsJson(enriched));
    } else {
      console.log(formatMetricsTable(enriched));
    }
  } catch (error) {
    console.error(
      `Failed to read metrics: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  } finally {
    storage?.close();
  }
}

// ─── Cross-Session Command ──────────────────────────────────────────────────

/** Cross-session learning statistics output */
export interface CrossSessionStats {
  provenanceDistribution: Array<{ bootCount: number | null; instinctCount: number }>;
  scopeStats: { projectSpecific: number; universal: number; unscoped: number };
  ageHistogram: Array<{ bucket: string; count: number }>;
  crossSessionValue: Array<{ id: string; name: string; hitCount: number; confidence: number }>;
  migrationStats: { migrationsApplied: number };
}

/**
 * Run the cross-session CLI command. Creates standalone LearningStorage,
 * runs migration, and outputs cross-session learning statistics.
 */
export function crossSessionCommand(opts: { json?: boolean }): void {
  const configResult = loadConfigSafe();
  if (configResult.kind === "err") {
    console.error(`Configuration error: ${configResult.error}`);
    process.exit(1);
  }

  const config = configResult.value;
  const dbPath = join(config.memory.dbPath, "learning.db");

  let ls: LearningStorage | undefined;
  try {
    ls = new LearningStorage(dbPath);
    ls.initialize();

    // Ensure schema is up to date
    const db = ls.getDatabase();
    if (db) {
      try {
        const runner = new MigrationRunner(db, dbPath);
        runner.run([migration001CrossSessionProvenance]);
      } catch {
        // Migration may already be applied
      }
    }

    const stats = gatherCrossSessionStats(ls);

    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(formatCrossSessionTable(stats));
    }
  } catch (error) {
    console.error(
      `Failed to read cross-session stats: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  } finally {
    ls?.close();
  }
}

/**
 * Gather cross-session statistics from LearningStorage.
 * Exported for testing.
 */
export function gatherCrossSessionStats(ls: LearningStorage): CrossSessionStats {
  const db = ls.getDatabase();
  if (!db) {
    return {
      provenanceDistribution: [],
      scopeStats: { projectSpecific: 0, universal: 0, unscoped: 0 },
      ageHistogram: [],
      crossSessionValue: [],
      migrationStats: { migrationsApplied: 0 },
    };
  }

  // Provenance Distribution: count of instincts by origin_boot_count
  const provRows = db.prepare(
    "SELECT origin_boot_count, COUNT(*) as cnt FROM instincts GROUP BY origin_boot_count ORDER BY origin_boot_count"
  ).all() as Array<{ origin_boot_count: number | null; cnt: number }>;
  const provenanceDistribution = provRows.map(r => ({
    bootCount: r.origin_boot_count,
    instinctCount: r.cnt,
  }));

  // Scope Stats: project-specific vs universal vs unscoped
  let projectSpecific = 0;
  let universal = 0;
  let unscoped = 0;
  try {
    const scopeRows = db.prepare(
      "SELECT project_path, COUNT(DISTINCT instinct_id) as cnt FROM instinct_scopes GROUP BY project_path"
    ).all() as Array<{ project_path: string; cnt: number }>;

    for (const row of scopeRows) {
      if (row.project_path === "*") {
        universal = row.cnt;
      } else {
        projectSpecific += row.cnt;
      }
    }

    // Count instincts with no scope
    const totalInstincts = (db.prepare("SELECT COUNT(*) as cnt FROM instincts").get() as { cnt: number }).cnt;
    const scopedInstincts = (db.prepare("SELECT COUNT(DISTINCT instinct_id) as cnt FROM instinct_scopes").get() as { cnt: number }).cnt;
    unscoped = totalInstincts - scopedInstincts;
  } catch {
    // instinct_scopes may not exist yet
  }

  // Age Histogram: bucket instincts by age
  const now = Date.now();
  const allInstincts = ls.getInstincts();
  const buckets = { "0-7d": 0, "7-30d": 0, "30-90d": 0, "90d+": 0 };
  for (const inst of allInstincts) {
    const ageDays = Math.floor((now - inst.createdAt) / MS_PER_DAY);
    if (ageDays <= 7) buckets["0-7d"]++;
    else if (ageDays <= 30) buckets["7-30d"]++;
    else if (ageDays <= 90) buckets["30-90d"]++;
    else buckets["90d+"]++;
  }
  const ageHistogram = Object.entries(buckets).map(([bucket, count]) => ({ bucket, count }));

  // Cross-Session Value: top 10 by cross_session_hit_count
  const valueRows = db.prepare(
    "SELECT id, name, cross_session_hit_count, confidence FROM instincts WHERE cross_session_hit_count > 0 ORDER BY cross_session_hit_count DESC LIMIT 10"
  ).all() as Array<{ id: string; name: string; cross_session_hit_count: number; confidence: number }>;
  const crossSessionValue = valueRows.map(r => ({
    id: r.id,
    name: r.name,
    hitCount: r.cross_session_hit_count,
    confidence: r.confidence,
  }));

  // Migration Stats
  let migrationsApplied = 0;
  try {
    const migRow = db.prepare("SELECT COUNT(*) as cnt FROM migrations").get() as { cnt: number };
    migrationsApplied = migRow.cnt;
  } catch {
    // migrations table may not exist
  }

  return {
    provenanceDistribution,
    scopeStats: { projectSpecific, universal, unscoped },
    ageHistogram,
    crossSessionValue,
    migrationStats: { migrationsApplied },
  };
}

/**
 * Format cross-session stats as a readable ASCII table.
 */
function formatCrossSessionTable(stats: CrossSessionStats): string {
  const lines: string[] = [];

  lines.push("Cross-Session Learning Statistics");
  lines.push("================================");
  lines.push("");

  // Provenance Distribution
  lines.push("Provenance Distribution (instincts per boot session)");
  lines.push("----------------------------------------------------");
  if (stats.provenanceDistribution.length === 0) {
    lines.push("  No instincts found");
  } else {
    for (const row of stats.provenanceDistribution) {
      const boot = row.bootCount !== null ? `Boot #${row.bootCount}` : "Unknown";
      lines.push(`  ${boot.padEnd(20)}${row.instinctCount} instincts`);
    }
  }
  lines.push("");

  // Scope Stats
  lines.push("Scope Stats");
  lines.push("-----------");
  lines.push(`  ${"Project-specific:".padEnd(22)}${stats.scopeStats.projectSpecific}`);
  lines.push(`  ${"Universal:".padEnd(22)}${stats.scopeStats.universal}`);
  lines.push(`  ${"Unscoped:".padEnd(22)}${stats.scopeStats.unscoped}`);
  lines.push("");

  // Age Histogram
  lines.push("Age Histogram");
  lines.push("-------------");
  for (const row of stats.ageHistogram) {
    lines.push(`  ${row.bucket.padEnd(10)}${row.count} instincts`);
  }
  lines.push("");

  // Cross-Session Value
  lines.push("Cross-Session Value (top 10 most retrieved across sessions)");
  lines.push("-----------------------------------------------------------");
  if (stats.crossSessionValue.length === 0) {
    lines.push("  No cross-session hits recorded");
  } else {
    for (const row of stats.crossSessionValue) {
      const conf = Math.round(row.confidence * 100);
      lines.push(`  ${row.name.slice(0, 40).padEnd(42)}${String(row.hitCount).padEnd(6)}hits  ${conf}% confidence`);
    }
  }
  lines.push("");

  // Migration Stats
  lines.push("Migrations");
  lines.push("----------");
  lines.push(`  ${"Applied:".padEnd(22)}${stats.migrationStats.migrationsApplied}`);

  return lines.join("\n");
}
