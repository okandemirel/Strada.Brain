/**
 * THE LEDGER'S CLI SURFACE (plan 6.4).
 *
 *   strada learning suspects            — which guidance in effect looks wrong
 *   strada learning coverage            — how much of what we show is ever judged
 *   strada learning search <text>       — find a rule by what it says
 *   strada learning ledger <id>         — the whole record for one rule
 *   strada learning retire <id> --reason "…"   — stop it, and show that it stopped
 *
 * `coverage` is the one that keeps `suspects` honest. Since round 13 #24 and round
 * 14 #14 a misfire is only recorded where something REPORTED which guidance a run
 * applied, so "no suspects" means nothing until you know how many exposures were
 * judged at all. It answers that, over a period, from rows rather than from a
 * counter that dies with the process.
 *
 * There was no `strada learning` group before this: the lifecycle log was
 * written and read only by tests, and the dashboard's /api/learning/* routes
 * report aggregates (counts, top/low performers) — nothing could answer "where
 * did THIS rule come from and what has it done". The measure for this item is
 * how long wrong guidance keeps having an effect, which is a person's
 * find → read → retire → verify loop; these four commands are that loop.
 *
 * Nothing here holds the daemon's LearningStorage: the CLI opens learning.db
 * itself the way `strada metrics` and `strada cross-session` do.
 */

import type { Command } from "commander";
import { join } from "node:path";
import { loadConfigSafe } from "../config/config.js";
import { LearningStorage } from "./storage/learning-storage.js";
import {
  buildInstinctLedger,
  exposureCoverage,
  findSuspectGuidance,
  renderExposureCoverage,
  renderLedgerEntry,
  renderSuspects,
  retireGuidance,
  searchGuidance,
} from "./ledger.js";

/** Open learning.db the way the other read-only CLI commands do. */
export function withLearningStorage<T>(run: (storage: LearningStorage) => T): T {
  const configResult = loadConfigSafe();
  if (configResult.kind === "err") {
    throw new Error(`Configuration error: ${configResult.error}`);
  }
  const dbPath = join(configResult.value.memory.dbPath, "learning.db");
  const storage = new LearningStorage(dbPath);
  storage.initialize();
  try {
    return run(storage);
  } finally {
    storage.close();
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function registerLearningCommands(program: Command): void {
  const learning = program
    .command("learning")
    .description("Audit the learning ledger: where guidance came from, what it has done, and retire it");

  learning
    .command("suspects")
    .description("Guidance still in effect that carries evidence against it (most suspect first)")
    .option("--limit <n>", "How many to list", "10")
    .option("--include-retired", "Also list retired rules (to check nothing still carries them)")
    .option("--json", "Output as JSON")
    .action((opts: { limit?: string; includeRetired?: boolean; json?: boolean }) => {
      const limit = Number.parseInt(opts.limit ?? "10", 10);
      if (!Number.isFinite(limit) || limit <= 0) fail(`--limit must be a positive number, got "${opts.limit}"`);
      try {
        const rows = withLearningStorage((storage) =>
          findSuspectGuidance(storage, { limit, ...(opts.includeRetired ? { includeRetired: true } : {}) }),
        );
        console.log(opts.json ? JSON.stringify(rows, null, 2) : renderSuspects(rows));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });

  learning
    .command("search <text>")
    .description("Find guidance by a substring of its name, trigger or action")
    .option("--limit <n>", "How many to list", "20")
    .option("--json", "Output as JSON")
    .action((text: string, opts: { limit?: string; json?: boolean }) => {
      const limit = Number.parseInt(opts.limit ?? "20", 10);
      if (!Number.isFinite(limit) || limit <= 0) fail(`--limit must be a positive number, got "${opts.limit}"`);
      try {
        const rows = withLearningStorage((storage) => searchGuidance(storage, text, { limit }));
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log(`No guidance matches "${text}".`);
          return;
        }
        for (const row of rows) {
          console.log(`${row.id}  [${row.status}, ${row.confidence.toFixed(3)}]  ${row.name}`);
          console.log(`    when: ${row.trigger.slice(0, 120)}`);
          console.log(`    then: ${row.action.slice(0, 120)}`);
        }
        console.log(`\n${rows.length} match(es). Full record: strada learning ledger <id>`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });

  learning
    .command("coverage")
    .description("How much of the guidance this installation shows is ever judged (the misfire measurement's denominator)")
    .option("--since-days <n>", "Only exposures shown in the last N days (default: everything on record)")
    .option("--json", "Output as JSON")
    .action((opts: { sinceDays?: string; json?: boolean }) => {
      let sinceMs: number | undefined;
      if (opts.sinceDays !== undefined) {
        const days = Number.parseFloat(opts.sinceDays);
        if (!Number.isFinite(days) || days <= 0) fail(`--since-days must be a positive number, got "${opts.sinceDays}"`);
        sinceMs = Date.now() - days * 86_400_000;
      }
      try {
        const coverage = withLearningStorage((storage) =>
          exposureCoverage(storage, sinceMs === undefined ? {} : { sinceMs }),
        );
        console.log(opts.json ? JSON.stringify(coverage, null, 2) : renderExposureCoverage(coverage));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });

  learning
    .command("ledger <instinctId>")
    .description("The whole record for one piece of guidance: origin, evidence, runs, status changes, effect")
    .option("--runs <n>", "How many influenced runs to load", "50")
    .option("--json", "Output as JSON")
    .action((instinctId: string, opts: { runs?: string; json?: boolean }) => {
      const runLimit = Number.parseInt(opts.runs ?? "50", 10);
      if (!Number.isFinite(runLimit) || runLimit <= 0) fail(`--runs must be a positive number, got "${opts.runs}"`);
      try {
        const entry = withLearningStorage((storage) => buildInstinctLedger(storage, instinctId, { runLimit }));
        if (!entry) fail(`No guidance with id ${instinctId}. Find it with: strada learning search <text>`);
        console.log(opts.json ? JSON.stringify(entry, null, 2) : renderLedgerEntry(entry));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });

  learning
    .command("retire <instinctId>")
    .description("Stop a piece of guidance having an effect, and print the ledger that proves it stopped")
    .requiredOption("--reason <text>", "Why it is being retired (recorded in the lifecycle log)")
    .option("--actor <who>", "Who is retiring it", "cli")
    .option("--quarantine", "Quarantine instead of deprecate: it must never come back")
    .option("--json", "Output as JSON")
    .action((instinctId: string, opts: { reason: string; actor?: string; quarantine?: boolean; json?: boolean }) => {
      if (opts.reason.trim().length === 0) fail("--reason must not be empty: the ledger records why it was retired");
      try {
        const result = withLearningStorage((storage) =>
          retireGuidance(storage, instinctId, {
            reason: opts.reason.trim(),
            actor: opts.actor ?? "cli",
            ...(opts.quarantine ? { quarantine: true } : {}),
          }),
        );
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          if (!result.ok) process.exit(1);
          return;
        }
        console.log(result.ok ? `Retired: ${result.detail}` : `NOT retired: ${result.detail}`);
        if (result.entry) {
          console.log("");
          console.log(renderLedgerEntry(result.entry));
        }
        if (!result.ok) process.exit(1);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });
}
