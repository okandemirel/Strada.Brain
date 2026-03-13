/**
 * Strada.Core API Sync Command
 *
 * CLI command that extracts a CoreAPISnapshot from Strada.Core source,
 * validates it against Brain's STRADA_API, and reports drift.
 */

import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { StradaCoreExtractor } from "./strada-core-extractor.js";
import { validateDrift, formatDriftReport } from "./strada-drift-validator.js";

interface SyncOptions {
  corePath: string;
  dryRun: boolean;
  apply: boolean;
}

/**
 * Run the sync command.
 * Extracts Core API, validates against Brain's knowledge, and reports drift.
 */
export async function runSyncCommand(opts: SyncOptions): Promise<void> {
  const corePath = resolve(opts.corePath);

  // Validate core path exists
  try {
    const stats = await stat(corePath);
    if (!stats.isDirectory()) {
      console.error(`Error: ${corePath} is not a directory`);
      process.exitCode = 1;
      return;
    }
  } catch {
    console.error(`Error: ${corePath} does not exist`);
    process.exitCode = 1;
    return;
  }

  console.log(`Extracting API from: ${corePath}`);
  console.log("");

  const extractor = new StradaCoreExtractor(corePath);
  const snapshot = await extractor.extract();

  console.log(`Extracted: ${snapshot.fileCount} files, ${snapshot.classes.length} classes, ${snapshot.interfaces.length} interfaces`);
  console.log(`Namespaces: ${snapshot.namespaces.length}`);
  console.log("");

  // Validate
  const report = validateDrift(snapshot);
  console.log(formatDriftReport(report));

  if (opts.apply && !opts.dryRun) {
    console.log("");
    console.log("Auto-apply is not yet implemented.");
    console.log("Review the drift report above and manually update strada-api-reference.ts.");
  }

  // Exit with error code if critical drift found
  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}
