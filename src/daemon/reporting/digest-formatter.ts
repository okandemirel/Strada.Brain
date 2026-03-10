/**
 * DigestFormatter -- Markdown rendering for periodic digest reports.
 *
 * Produces structured markdown with:
 * - TL;DR one-liner at top
 * - Errors section first (bad news first)
 * - Named trigger activity with fire counts
 * - Tasks, Learning, Budget, Goals sections (auto-detected, skipped if empty)
 * - Delta tracking (+N since last digest)
 * - Channel-aware truncation per message limits
 * - Dashboard link footer
 *
 * Requirements: RPT-01
 */

// =============================================================================
// TYPES
// =============================================================================

/** Snapshot of daemon activity data gathered at digest send time */
export interface DigestSnapshot {
  readonly errors: ReadonlyArray<{ message: string; timestamp: number }>;
  readonly triggers: ReadonlyArray<{ name: string; fireCount: number; lastResult: string }>;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  readonly instinctsLearned: number;
  readonly instinctsPromoted: number;
  readonly totalActiveInstincts: number;
  readonly budgetUsed: number | null;
  readonly budgetLimit: number | null;
  readonly goalProgress: { active: number; completed: number; failed: number } | null;
  readonly dashboardUrl: string;
}

/** Delta changes since last digest for "+N" display */
export interface DigestDeltas {
  readonly triggerDelta?: number;
  readonly taskDelta?: number;
  readonly instinctDelta?: number;
  readonly budgetDelta?: number;
  readonly lastDigestTime?: number;
}

// =============================================================================
// CHANNEL LIMITS
// =============================================================================

/** Per-channel message length limits */
const CHANNEL_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  whatsapp: 65536,
  cli: Infinity,
  web: Infinity,
};

// =============================================================================
// FORMAT DIGEST
// =============================================================================

/**
 * Format a digest snapshot into structured markdown.
 *
 * Sections are auto-detected: if no triggers exist, trigger section is skipped.
 * If budget is not configured (null), budget section is skipped.
 * If no activity at all, returns "All quiet" one-liner with dashboard link.
 */
export function formatDigest(snapshot: DigestSnapshot, deltas: DigestDeltas): string {
  const hasErrors = snapshot.errors.length > 0;
  const hasTriggers = snapshot.triggers.length > 0;
  const hasTasks = snapshot.tasksCompleted > 0 || snapshot.tasksFailed > 0;
  const hasLearning = snapshot.instinctsLearned > 0 || snapshot.instinctsPromoted > 0 || snapshot.totalActiveInstincts > 0;
  const hasBudget = snapshot.budgetUsed !== null && snapshot.budgetLimit !== null;
  const hasGoals = snapshot.goalProgress !== null;

  const hasActivity = hasErrors || hasTriggers || hasTasks || hasLearning;

  // "All quiet" case: no meaningful activity
  if (!hasActivity && !hasBudget) {
    return `**All quiet** -- no activity since last digest\n\n---\nDashboard: ${snapshot.dashboardUrl}`;
  }

  const sections: string[] = [];

  // TL;DR one-liner
  sections.push(buildTldr(snapshot));
  sections.push("---");

  // Errors section -- ALWAYS first after TL;DR
  if (hasErrors) {
    sections.push(buildErrorsSection(snapshot.errors));
  }

  // Trigger Activity
  if (hasTriggers) {
    sections.push(buildTriggerSection(snapshot.triggers));
  }

  // Tasks
  if (hasTasks) {
    sections.push(buildTasksSection(snapshot, deltas));
  }

  // Learning
  if (hasLearning) {
    sections.push(buildLearningSection(snapshot, deltas));
  }

  // Budget (skip if not configured)
  if (hasBudget) {
    sections.push(buildBudgetSection(snapshot, deltas));
  }

  // Goals
  if (hasGoals) {
    sections.push(buildGoalsSection(snapshot.goalProgress!));
  }

  // Footer
  sections.push("---");
  sections.push(`Dashboard: ${snapshot.dashboardUrl}`);

  return sections.join("\n\n");
}

// =============================================================================
// TRUNCATE FOR CHANNEL
// =============================================================================

/**
 * Truncate markdown to respect per-channel message length limits.
 * If the markdown exceeds the limit, truncates at the nearest newline
 * before the limit and appends a fallback suffix.
 *
 * Web and CLI channels are unlimited and never truncated.
 */
export function truncateForChannel(markdown: string, channelType: string, dashboardUrl: string): string {
  const limit = CHANNEL_LIMITS[channelType] ?? Infinity;

  if (markdown.length <= limit) {
    return markdown;
  }

  const suffix = `\n\n... view full details on dashboard\nDashboard: ${dashboardUrl}`;
  const maxContent = limit - suffix.length;

  // Find nearest newline before the max content length
  let cutPoint = markdown.lastIndexOf("\n", maxContent);
  if (cutPoint <= 0) {
    cutPoint = maxContent;
  }

  return markdown.slice(0, cutPoint) + suffix;
}

// =============================================================================
// SECTION BUILDERS
// =============================================================================

function buildTldr(snapshot: DigestSnapshot): string {
  const parts: string[] = [];

  const totalTasks = snapshot.tasksCompleted + snapshot.tasksFailed;
  if (totalTasks > 0) {
    parts.push(`${snapshot.tasksCompleted} tasks done`);
  }

  if (snapshot.errors.length > 0) {
    parts.push(`${snapshot.errors.length} error${snapshot.errors.length > 1 ? "s" : ""}`);
  }

  if (snapshot.budgetUsed !== null) {
    parts.push(`$${snapshot.budgetUsed.toFixed(2)} spent`);
  }

  if (parts.length === 0) {
    return "**All quiet** -- no activity since last digest";
  }

  return `**${parts.join(", ")}**`;
}

function buildErrorsSection(errors: ReadonlyArray<{ message: string; timestamp: number }>): string {
  const lines = ["**Errors & Failures**"];
  for (const error of errors) {
    lines.push(`- ${error.message}`);
  }
  return lines.join("\n");
}

function buildTriggerSection(triggers: ReadonlyArray<{ name: string; fireCount: number; lastResult: string }>): string {
  const lines = ["**Trigger Activity**"];
  for (const trigger of triggers) {
    const timesStr = trigger.fireCount === 1 ? "time" : "times";
    lines.push(`- '${trigger.name}' fired ${trigger.fireCount} ${timesStr}`);
  }
  return lines.join("\n");
}

function buildTasksSection(snapshot: DigestSnapshot, deltas: DigestDeltas): string {
  const total = snapshot.tasksCompleted + snapshot.tasksFailed;
  const successPct = total > 0 ? Math.round((snapshot.tasksCompleted / total) * 100) : 0;
  const lines = ["**Tasks**"];
  lines.push(`- ${snapshot.tasksCompleted} completed, ${snapshot.tasksFailed} failed (${successPct}% success)`);

  if (deltas.taskDelta !== undefined && deltas.taskDelta > 0) {
    lines.push(`- +${deltas.taskDelta} since last digest`);
  }

  return lines.join("\n");
}

function buildLearningSection(snapshot: DigestSnapshot, deltas: DigestDeltas): string {
  const lines = ["**Learning**"];

  if (snapshot.instinctsLearned > 0) {
    lines.push(`- ${snapshot.instinctsLearned} new instincts learned`);
  }

  if (snapshot.instinctsPromoted > 0) {
    lines.push(`- ${snapshot.instinctsPromoted} instinct${snapshot.instinctsPromoted > 1 ? "s" : ""} promoted to permanent`);
  }

  if (snapshot.totalActiveInstincts > 0) {
    let activeLine = `- ${snapshot.totalActiveInstincts} total active instincts`;
    if (deltas.instinctDelta !== undefined && deltas.instinctDelta > 0) {
      activeLine += ` (+${deltas.instinctDelta})`;
    }
    lines.push(activeLine);
  }

  return lines.join("\n");
}

function buildBudgetSection(snapshot: DigestSnapshot, deltas: DigestDeltas): string {
  const used = snapshot.budgetUsed!;
  const limit = snapshot.budgetLimit!;
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const lines = ["**Budget**"];
  lines.push(`- $${used.toFixed(2)} / $${limit.toFixed(2)} (${pct}%)`);

  if (deltas.budgetDelta !== undefined && deltas.budgetDelta > 0) {
    lines.push(`- +$${deltas.budgetDelta.toFixed(2)} since last digest`);
  }

  return lines.join("\n");
}

function buildGoalsSection(goals: { active: number; completed: number; failed: number }): string {
  const lines = ["**Goals**"];
  lines.push(`- ${goals.active} active, ${goals.completed} completed, ${goals.failed} failed`);
  return lines.join("\n");
}
