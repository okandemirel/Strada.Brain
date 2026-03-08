/**
 * HEARTBEAT.md Parser
 *
 * Converts structured markdown content into HeartbeatTriggerDef[] for the
 * daemon trigger registry. Trigger names are derived from h3 headings via
 * slugification. Missing fields are handled leniently (skipped with warning).
 *
 * Format:
 * ```markdown
 * ## Triggers
 *
 * ### Every morning at 9am
 * - cron: 0 9 * * *
 * - action: Check for new Unity compile errors
 * - timeout: 300
 * - enabled: true
 * ```
 *
 * Used by: HeartbeatLoop (Plan 04) at startup and on HEARTBEAT.md reload
 */

import { Cron } from "croner";
import { getLogger } from "../utils/logger.js";
import type { HeartbeatTriggerDef } from "./daemon-types.js";

/**
 * Slugify a heading text: lowercase, replace non-alphanumeric with hyphens,
 * strip leading/trailing hyphens.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract a field value from a section's lines.
 * Matches `- fieldName: value` pattern.
 */
function extractField(lines: string[], fieldName: string): string | undefined {
  const regex = new RegExp(`^\\s*-\\s*${fieldName}:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

/**
 * Validate a cron expression using croner.
 * Returns true if valid, false otherwise.
 */
function isValidCron(expr: string): boolean {
  try {
    // Create a paused Cron to validate the expression without scheduling
    new Cron(expr, { paused: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a HEARTBEAT.md file content into an array of trigger definitions.
 *
 * - Splits by `### ` headings (only h3 subsections)
 * - Extracts cron, action, timeout, enabled, type fields
 * - Skips entries with missing cron or action (lenient)
 * - Validates cron expressions via croner
 * - Returns HeartbeatTriggerDef[] ready for TriggerRegistry
 */
export function parseHeartbeatFile(content: string): HeartbeatTriggerDef[] {
  const results: HeartbeatTriggerDef[] = [];

  if (!content || content.trim().length === 0) {
    return results;
  }

  let logger: ReturnType<typeof getLogger> | null;
  try {
    logger = getLogger();
  } catch {
    // Logger not initialized (e.g., in test context) -- use null
    logger = null;
  }

  // Split by h3 headings. The first element is content before the first h3 (ignored).
  const sections = content.split(/^### /m);

  // Skip the first section (content before first ### heading)
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const lines = section.split("\n");

    // First line is the heading text
    const headingText = lines[0].trim();
    if (!headingText) continue;

    const name = slugify(headingText);
    if (!name) continue;

    const sectionLines = lines.slice(1);

    // Extract required fields
    const cron = extractField(sectionLines, "cron");
    const action = extractField(sectionLines, "action");

    if (!cron) {
      logger?.warn(`HEARTBEAT.md: trigger '${name}' missing cron field, skipping`);
      continue;
    }

    if (!action) {
      logger?.warn(`HEARTBEAT.md: trigger '${name}' missing action field, skipping`);
      continue;
    }

    // Validate cron expression
    if (!isValidCron(cron)) {
      logger?.warn(`HEARTBEAT.md: trigger '${name}' has invalid cron expression '${cron}', skipping`);
      continue;
    }

    // Extract optional fields
    const timeoutStr = extractField(sectionLines, "timeout");
    const enabledStr = extractField(sectionLines, "enabled");
    const _type = extractField(sectionLines, "type"); // stored but unused until Phase 15

    const def: HeartbeatTriggerDef = {
      name,
      cron,
      action,
      timeout: timeoutStr ? parseInt(timeoutStr, 10) * 1000 : undefined, // seconds -> ms
      enabled: enabledStr ? enabledStr.toLowerCase() === "true" : true,
    };

    results.push(def);
  }

  return results;
}
