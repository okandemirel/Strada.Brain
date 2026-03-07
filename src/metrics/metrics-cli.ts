/**
 * Metrics CLI
 *
 * CLI command logic for `strata-brain metrics`.
 * Provides formatted table and JSON output for agent performance metrics.
 * Creates a standalone MetricsStorage instance for read-only queries.
 */

import { join } from "node:path";
import { loadConfigSafe } from "../config/config.js";
import { MetricsStorage } from "./metrics-storage.js";
import type { MetricsAggregation, MetricsFilter } from "./metrics-types.js";
import { parseDurationToTimestamp } from "./parse-duration.js";

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

    const agg = storage.getAggregation(filter);

    if (opts.json) {
      console.log(formatMetricsJson(agg));
    } else {
      console.log(formatMetricsTable(agg));
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
