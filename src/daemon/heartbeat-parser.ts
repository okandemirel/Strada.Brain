/**
 * HEARTBEAT.md Parser
 *
 * Converts structured markdown content into HeartbeatTriggerDef[] for the
 * daemon trigger registry. Trigger names are derived from h3 headings via
 * slugification. Missing fields are handled leniently (skipped with warning).
 *
 * Supports four trigger types:
 * - cron: time-based (cron expression)
 * - file-watch: filesystem change detection
 * - checklist: natural-language task lists with emoji priorities
 * - webhook: HTTP POST-driven (env-var configured)
 *
 * Used by: HeartbeatLoop (Plan 04) at startup and on HEARTBEAT.md reload
 */

import { Cron } from "croner";
import { getLogger } from "../utils/logger.js";
import type {
  HeartbeatTriggerDef,
  CronTriggerDef,
  FileWatchTriggerDef,
  ChecklistTriggerDef,
  WebhookTriggerDef,
  ChecklistItem,
  TriggerType,
} from "./daemon-types.js";

// =============================================================================
// HELPER UTILITIES
// =============================================================================

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
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^\\s*-\\s*${escaped}:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      return match[1]!.trim();
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
    new Cron(expr, { paused: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract shared fields (timeout, enabled, cooldown) from section lines.
 */
function extractSharedFields(
  sectionLines: string[],
): { timeout?: number; enabled: boolean; cooldown?: number } {
  const timeoutStr = extractField(sectionLines, "timeout");
  const enabledStr = extractField(sectionLines, "enabled");
  const cooldownStr = extractField(sectionLines, "cooldown");

  return {
    timeout: timeoutStr ? parseInt(timeoutStr, 10) * 1000 : undefined, // seconds -> ms
    enabled: enabledStr ? enabledStr.toLowerCase() === "true" : true,
    cooldown: cooldownStr ? parseInt(cooldownStr, 10) : undefined,
  };
}

// =============================================================================
// NATURAL LANGUAGE TIME PARSER
// =============================================================================

/** Configuration for NL time parsing -- hours are configurable via env vars */
export interface TimeConfig {
  morningHour: number;
  afternoonHour: number;
  eveningHour: number;
}

const DAY_MAP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Parse a natural-language time phrase into a cron expression.
 *
 * Supported patterns:
 * - 'every morning' -> 0 {morningHour} * * *
 * - 'every afternoon' -> 0 {afternoonHour} * * *
 * - 'every evening' -> 0 {eveningHour} * * *
 * - 'daily' -> 0 {morningHour} * * *
 * - 'every hour' -> 0 * * * *
 * - 'every N min/minutes' -> * /N * * * *
 * - 'weekly on {day}' -> 0 {morningHour} * * {dayNum}
 *
 * Returns undefined for unrecognized phrases (lenient).
 */
export function parseNaturalTime(
  text: string,
  config: TimeConfig,
): string | undefined {
  if (!text || text.trim().length === 0) return undefined;

  const lower = text.trim().toLowerCase();

  // 'every morning'
  if (/\bevery\s+morning\b/.test(lower)) {
    return `0 ${config.morningHour} * * *`;
  }

  // 'every afternoon'
  if (/\bevery\s+afternoon\b/.test(lower)) {
    return `0 ${config.afternoonHour} * * *`;
  }

  // 'every evening'
  if (/\bevery\s+evening\b/.test(lower)) {
    return `0 ${config.eveningHour} * * *`;
  }

  // 'daily'
  if (/\bdaily\b/.test(lower)) {
    return `0 ${config.morningHour} * * *`;
  }

  // 'every hour'
  if (/\bevery\s+hour\b/.test(lower)) {
    return "0 * * * *";
  }

  // 'every N min/minutes'
  const minMatch = lower.match(/\bevery\s+(\d+)\s+min(?:utes?)?\b/);
  if (minMatch) {
    return `*/${minMatch[1]} * * * *`;
  }

  // 'weekly on {day}'
  const weeklyMatch = lower.match(/\bweekly\s+on\s+(\w+)\b/);
  if (weeklyMatch) {
    const dayNum = DAY_MAP[weeklyMatch[1]!];
    if (dayNum !== undefined) {
      return `0 ${config.morningHour} * * ${dayNum}`;
    }
  }

  return undefined;
}

// =============================================================================
// TYPE-SPECIFIC PARSERS
// =============================================================================

/**
 * Parse a cron trigger section. Same logic as the original parser.
 */
function parseCronSection(
  name: string,
  sectionLines: string[],
  logger: ReturnType<typeof getLogger> | null,
): CronTriggerDef | null {
  const cron = extractField(sectionLines, "cron");
  const action = extractField(sectionLines, "action");

  if (!cron) {
    logger?.warn(`HEARTBEAT.md: trigger '${name}' (cron) missing cron field, skipping`);
    return null;
  }

  if (!action) {
    logger?.warn(`HEARTBEAT.md: trigger '${name}' (cron) missing action field, skipping`);
    return null;
  }

  if (!isValidCron(cron)) {
    logger?.warn(
      `HEARTBEAT.md: trigger '${name}' has invalid cron expression '${cron}', skipping`,
    );
    return null;
  }

  const shared = extractSharedFields(sectionLines);

  return {
    type: "cron",
    name,
    cron,
    action,
    ...shared,
  };
}

/**
 * Parse a file-watch trigger section.
 */
function parseFileWatchSection(
  name: string,
  sectionLines: string[],
  logger: ReturnType<typeof getLogger> | null,
): FileWatchTriggerDef | null {
  const path = extractField(sectionLines, "path");
  const action = extractField(sectionLines, "action");

  if (!path) {
    logger?.warn(`HEARTBEAT.md: trigger '${name}' (file-watch) missing path field, skipping`);
    return null;
  }

  if (!action) {
    logger?.warn(`HEARTBEAT.md: trigger '${name}' (file-watch) missing action field, skipping`);
    return null;
  }

  const patternField = extractField(sectionLines, "pattern");
  const debounceStr = extractField(sectionLines, "debounce");
  const recursiveStr = extractField(sectionLines, "recursive");
  const ignoreStr = extractField(sectionLines, "ignore");

  const shared = extractSharedFields(sectionLines);

  const defaultIgnore = ["node_modules", ".git", "*.d.ts"];
  const ignore = ignoreStr
    ? ignoreStr.split(",").map((s) => s.trim()).filter(Boolean)
    : defaultIgnore;

  return {
    type: "file-watch",
    name,
    action,
    path,
    pattern: patternField,
    debounce: debounceStr ? parseInt(debounceStr, 10) : undefined,
    recursive: recursiveStr ? recursiveStr.toLowerCase() === "true" : true,
    ignore,
    ...shared,
  };
}

// Emoji codepoints for priority detection
const RED_CIRCLE = "\u{1F534}"; // 🔴
const YELLOW_CIRCLE = "\u{1F7E1}"; // 🟡
const GREEN_CIRCLE = "\u{1F7E2}"; // 🟢

/**
 * Detect priority from emoji in a checklist item line.
 */
function detectPriority(text: string): "high" | "medium" | "low" {
  if (text.includes(RED_CIRCLE)) return "high";
  if (text.includes(YELLOW_CIRCLE)) return "medium";
  if (text.includes(GREEN_CIRCLE)) return "low";
  return "medium";
}

/**
 * Strip emoji priority markers from text.
 */
function stripEmoji(text: string): string {
  return text
    .replace(new RegExp(`[${RED_CIRCLE}${YELLOW_CIRCLE}${GREEN_CIRCLE}]`, "g"), "")
    .trim();
}

/**
 * Extract NL time reference from parenthesized text at end of line,
 * or bare NL time phrase.
 */
function extractTimeRef(text: string): { cleanText: string; timePhrase?: string } {
  // Check for parenthesized time reference at end
  const parenMatch = text.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) {
    return {
      cleanText: text.replace(/\s*\([^)]+\)\s*$/, "").trim(),
      timePhrase: parenMatch[1]!.trim(),
    };
  }
  return { cleanText: text.trim() };
}

/**
 * Parse a checklist trigger section.
 */
function parseChecklistSection(
  name: string,
  sectionLines: string[],
  logger: ReturnType<typeof getLogger> | null,
  timeConfig: TimeConfig,
): ChecklistTriggerDef | null {
  const action = extractField(sectionLines, "action");

  if (!action) {
    logger?.warn(`HEARTBEAT.md: trigger '${name}' (checklist) missing action field, skipping`);
    return null;
  }

  const shared = extractSharedFields(sectionLines);

  // Find checkbox lines (after optional #### Tasks heading)
  const items: ChecklistItem[] = [];
  const checkboxRegex = /^-\s+\[([ xX])\]\s+(.+)$/;

  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i]!;
    const match = line.trim().match(checkboxRegex);
    if (!match) continue;

    const checked = match[1]!.toLowerCase() === "x";
    const rawText = match[2]!;
    const priority = detectPriority(rawText);
    const strippedText = stripEmoji(rawText);
    const { cleanText, timePhrase } = extractTimeRef(strippedText);

    const schedule = timePhrase
      ? parseNaturalTime(timePhrase, timeConfig)
      : undefined;

    // Collect indented continuation lines
    const continuationLines: string[] = [];
    for (let j = i + 1; j < sectionLines.length; j++) {
      const nextLine = sectionLines[j]!;
      // Continuation line: starts with whitespace (at least 2 spaces) and is not a checkbox
      if (/^\s{2,}\S/.test(nextLine) && !checkboxRegex.test(nextLine.trim())) {
        continuationLines.push(nextLine.trim());
      } else {
        break;
      }
    }

    const multilineDescription =
      continuationLines.length > 0
        ? continuationLines.join("\n")
        : undefined;

    items.push({
      text: cleanText,
      checked,
      priority,
      schedule,
      multilineDescription,
    });
  }

  return {
    type: "checklist",
    name,
    action,
    items,
    ...shared,
  };
}

/**
 * Parse a webhook trigger section. Minimal -- config is env-var driven.
 */
function parseWebhookSection(
  name: string,
  sectionLines: string[],
  logger: ReturnType<typeof getLogger> | null,
): WebhookTriggerDef | null {
  const action = extractField(sectionLines, "action");

  if (!action) {
    logger?.warn(`HEARTBEAT.md: trigger '${name}' (webhook) missing action field, skipping`);
    return null;
  }

  const shared = extractSharedFields(sectionLines);

  return {
    type: "webhook",
    name,
    action,
    ...shared,
  };
}

// =============================================================================
// VALID TRIGGER TYPES
// =============================================================================

const VALID_TYPES: Set<string> = new Set<string>(["cron", "file-watch", "checklist", "webhook"]);

// =============================================================================
// MAIN PARSER
// =============================================================================

/**
 * Parse a HEARTBEAT.md file content into an array of trigger definitions.
 *
 * - Splits by `### ` headings (only h3 subsections)
 * - Routes by `type` field to type-specific parsers
 * - Defaults to 'cron' when type missing but cron field present (backward compat)
 * - Skips entries with missing/invalid fields (lenient)
 * - Returns HeartbeatTriggerDef[] ready for TriggerRegistry
 */
export function parseHeartbeatFile(
  content: string,
  timeConfig?: TimeConfig,
): HeartbeatTriggerDef[] {
  const results: HeartbeatTriggerDef[] = [];

  if (!content || content.trim().length === 0) {
    return results;
  }

  let logger: ReturnType<typeof getLogger> | null;
  try {
    logger = getLogger();
  } catch {
    logger = null;
  }

  const config: TimeConfig = timeConfig ?? {
    morningHour: 9,
    afternoonHour: 14,
    eveningHour: 18,
  };

  // Split by h3 headings. The first element is content before the first h3 (ignored).
  const sections = content.split(/^### /m);

  // Skip the first section (content before first ### heading)
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i]!;
    const lines = section.split("\n");

    // First line is the heading text
    const headingText = (lines[0] ?? "").trim();
    if (!headingText) continue;

    const name = slugify(headingText);
    if (!name) continue;

    const sectionLines = lines.slice(1);

    // Determine type
    let typeField = extractField(sectionLines, "type");

    // Backward compat: no type field but has cron field -> treat as cron
    if (!typeField) {
      const cronField = extractField(sectionLines, "cron");
      if (cronField) {
        typeField = "cron";
      } else {
        logger?.warn(
          `HEARTBEAT.md: trigger '${name}' has neither type nor cron field, skipping`,
        );
        continue;
      }
    }

    // Validate type
    if (!VALID_TYPES.has(typeField)) {
      logger?.warn(
        `HEARTBEAT.md: trigger '${name}' has unrecognized type '${typeField}', skipping`,
      );
      continue;
    }

    const triggerType = typeField as TriggerType;

    let def: HeartbeatTriggerDef | null = null;

    switch (triggerType) {
      case "cron":
        def = parseCronSection(name, sectionLines, logger);
        break;
      case "file-watch":
        def = parseFileWatchSection(name, sectionLines, logger);
        break;
      case "checklist":
        def = parseChecklistSection(name, sectionLines, logger, config);
        break;
      case "webhook":
        def = parseWebhookSection(name, sectionLines, logger);
        break;
    }

    if (def) {
      results.push(def);
    }
  }

  return results;
}
