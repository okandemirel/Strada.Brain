/**
 * Git State Observer
 * Periodically checks git status for uncommitted changes.
 * Uses async child_process to avoid blocking the event loop.
 * The synchronous collect() returns cached results; refresh runs in background.
 *
 * 2026-09-10: the observation used to be "N uncommitted change(s) detected"
 * with N first, re-emitted on every increase. Measured that evening: the
 * daemon's own play-throughs wrote captures under Recordings/, N grew by one
 * every few minutes, the scorer's dedup (first 60 chars of the summary) saw a
 * new observation each time, and AgentCore spawned an investigation of the
 * "1118 uncommitted changes" every cycle — an investigation that then ran in
 * a worktree lease and measured a clean tree. Now: Strada's own output is
 * counted apart, the summary starts with a stable phrase, the observation
 * carries the breakdown the investigation would have produced, and it
 * re-fires only on meaningful growth.
 */

import { execFileNoThrow } from "../../utils/execFileNoThrow.js";
import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

/** Paths the system itself writes into the project; never "the user's uncommitted work". */
export const SYSTEM_OUTPUT_PREFIXES: readonly string[] = [".strada/", "Recordings/"];
/** Re-report when the user's uncommitted count grew by at least this many files or this share. */
export const GIT_REPORT_GROWTH_MIN = 25;
export const GIT_REPORT_GROWTH_SHARE = 0.1;
/** Stable head of the summary: the scorer's dedup keys on the first 60 characters. */
export const GIT_SUMMARY_PREFIX = "Uncommitted changes in the project's working tree (outside Strada's own output): ";

export interface GitStatusBreakdown {
  readonly total: number;
  /** Changes outside SYSTEM_OUTPUT_PREFIXES. */
  readonly own: number;
  readonly systemOutput: number;
  readonly byStatus: { modified: number; untracked: number; deleted: number; added: number; renamed: number };
  /** Top-level directories of the user's changes, most first. */
  readonly topDirs: ReadonlyArray<readonly [string, number]>;
  readonly sample: readonly string[];
}

/** Pure: classify `git status --porcelain` lines. */
export function summarizeGitStatus(lines: readonly string[]): GitStatusBreakdown {
  const byStatus = { modified: 0, untracked: 0, deleted: 0, added: 0, renamed: 0 };
  const dirs = new Map<string, number>();
  const sample: string[] = [];
  let own = 0;
  let systemOutput = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    let path = raw.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    // Git quotes a path holding unusual bytes: "Recordings/frame\t001.png".
    // Undecoded, it read as user work under a directory named `"Recordings`
    // (Codex 2026-09-11 C#34).
    if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
      path = path.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\[trn]/g, "");
    }
    if (SYSTEM_OUTPUT_PREFIXES.some((p) => path.startsWith(p))) {
      systemOutput += 1;
      continue;
    }
    own += 1;
    if (code.includes("?")) byStatus.untracked += 1;
    else if (code.includes("R")) byStatus.renamed += 1;
    else if (code.includes("D")) byStatus.deleted += 1;
    else if (code.includes("A")) byStatus.added += 1;
    else byStatus.modified += 1;
    const top = path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
    dirs.set(top, (dirs.get(top) ?? 0) + 1);
    if (sample.length < 10) sample.push(raw.trim());
  }
  const topDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { total: own + systemOutput, own, systemOutput, byStatus, topDirs, sample };
}

export function describeGitStatus(b: GitStatusBreakdown, sinceLastReport: number): string {
  const parts: string[] = [];
  if (b.byStatus.modified) parts.push(`${b.byStatus.modified} modified`);
  if (b.byStatus.untracked) parts.push(`${b.byStatus.untracked} untracked`);
  if (b.byStatus.deleted) parts.push(`${b.byStatus.deleted} deleted`);
  if (b.byStatus.added) parts.push(`${b.byStatus.added} added`);
  if (b.byStatus.renamed) parts.push(`${b.byStatus.renamed} renamed`);
  const dirs = b.topDirs.map(([d, n]) => `${d} (${n})`).join(", ");
  return `${GIT_SUMMARY_PREFIX}${b.own} — ${parts.join(", ")}` +
    (dirs ? `; top: ${dirs}` : "") +
    (sinceLastReport > 0 ? `; +${sinceLastReport} since the last report` : "") +
    (b.systemOutput > 0 ? `; ${b.systemOutput} more under Strada's own output (${SYSTEM_OUTPUT_PREFIXES.join(", ")})` : "");
}

/** Report on the first non-zero count and again only on meaningful growth. */
export function shouldReportGitGrowth(own: number, lastReported: number): boolean {
  if (own <= 0) return false;
  if (lastReported <= 0) return true;
  const growth = own - lastReported;
  return growth >= Math.max(GIT_REPORT_GROWTH_MIN, Math.ceil(lastReported * GIT_REPORT_GROWTH_SHARE));
}

type GitRunner = (args: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>;

export class GitStateObserver implements Observer {
  readonly name = "git-state-observer";
  private lastReportedOwn = 0;
  private readonly projectPath: string;
  private readonly checkIntervalMs: number;
  private readonly runGit: GitRunner;
  private lastCheckMs = 0;
  private pendingResult: AgentObservation[] = [];
  private refreshInFlight = false;

  constructor(projectPath: string, checkIntervalMs = 120_000, runGit?: GitRunner) {
    this.projectPath = projectPath;
    this.checkIntervalMs = checkIntervalMs;
    this.runGit = runGit ?? ((args, timeoutMs) => execFileNoThrow("git", args, timeoutMs));
  }

  collect(): AgentObservation[] {
    const now = Date.now();
    if (now - this.lastCheckMs < this.checkIntervalMs) {
      return []; // Rate limit git commands
    }
    this.lastCheckMs = now;

    // Return cached result and trigger async refresh
    const cached = this.pendingResult;
    this.pendingResult = [];
    this.refreshAsync();
    return cached;
  }

  /** Exposed for tests: the refresh the next collect() would report. */
  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  private refreshAsync(): void {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    this.refresh()
      .catch(() => {
        // Git command failed — non-fatal
      })
      .finally(() => {
        this.refreshInFlight = false;
      });
  }

  private async refresh(): Promise<void> {
    const result = await this.runGit(["-C", this.projectPath, "status", "--porcelain"], 5000);
    if (result.exitCode !== 0) return;
    // Not trim(): porcelain's first column may be a space (" M path"), and
    // trimming the first line ate it — the path lost its first character and
    // "Recordings/…" read as "ecordings/…", i.e. user work (Codex 2026-09-11 #11).
    const status = result.stdout.replace(/\r?\n+$/, "");
    const lines = status ? status.split(/\r?\n/) : [];
    const breakdown = summarizeGitStatus(lines);
    if (breakdown.own === 0) {
      // A clean tree resets the baseline: the next dirty episode is reported
      // from its first file, not from 125 (Codex 2026-09-11 #10).
      this.lastReportedOwn = 0;
      return;
    }
    if (!shouldReportGitGrowth(breakdown.own, this.lastReportedOwn)) return;
    const sinceLastReport = this.lastReportedOwn > 0 ? breakdown.own - this.lastReportedOwn : 0;
    this.lastReportedOwn = breakdown.own;
    this.pendingResult = [
      createObservation("git", describeGitStatus(breakdown, sinceLastReport), {
        priority: 30,
        context: {
          uncommittedCount: breakdown.own,
          systemOutputCount: breakdown.systemOutput,
          byStatus: breakdown.byStatus,
          topDirs: breakdown.topDirs,
          files: breakdown.sample,
          sinceLastReport,
          // The measurement's root: an investigation of it must run HERE, not
          // in a worktree lease seeded from HEAD (measured 2026-09-10 22:31:
          // such a task reported a clean tree against this observation).
          measuredIn: this.projectPath,
        },
      }),
    ];
  }
}
