/**
 * Diff Generator - Creates unified diffs for file changes
 */

import { createTwoFilesPatch, structuredPatch } from "diff";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_TRUNCATION_LINES = 100;
const NULL_PATH = "/dev/null";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiffStats {
  additions: number;
  deletions: number;
  modifications: number;
  totalChanges: number;
  hunks: number;
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  diff: string;
  stats: DiffStats;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
}

export interface BatchDiff {
  files: FileDiff[];
  totalStats: DiffStats;
  summary: string;
}

export interface DiffGeneratorOptions {
  contextLines?: number;
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
}

// ─── Stats Calculation ───────────────────────────────────────────────────────

export function calculateDiffStats(diff: string): DiffStats {
  const lines = diff.split("\n");
  let additions = 0;
  let deletions = 0;
  let hunks = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunks++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return {
    additions,
    deletions,
    modifications: Math.min(additions, deletions),
    totalChanges: additions + deletions,
    hunks,
  };
}

export function formatDiffStats(stats: DiffStats): string {
  const parts: string[] = [];
  
  if (stats.additions > 0) parts.push(`+${stats.additions}`);
  if (stats.deletions > 0) parts.push(`-${stats.deletions}`);
  
  let result = parts.join("/") || "no changes";
  
  if (stats.hunks > 0) {
    result += ` (${stats.hunks} hunk${stats.hunks === 1 ? "" : "s"})`;
  }
  
  return result;
}

// ─── File Diff Generation ────────────────────────────────────────────────────

export function generateFileDiff(
  oldPath: string,
  newPath: string,
  oldContent: string,
  newContent: string,
  options: DiffGeneratorOptions = {}
): FileDiff {
  const opts = {
    contextLines: options.contextLines ?? DEFAULT_CONTEXT_LINES,
    ignoreWhitespace: options.ignoreWhitespace ?? false,
    ignoreCase: options.ignoreCase ?? false,
  };

  // Handle special cases
  if (oldContent === "" && newContent !== "") {
    return createNewFileDiff(newPath, newContent, opts);
  }
  
  if (newContent === "" && oldContent !== "") {
    return createDeletedFileDiff(oldPath, oldContent, opts);
  }
  
  if (oldContent === newContent && oldPath !== newPath) {
    return createRenameDiff(oldPath, newPath);
  }

  // Normal diff
  const patchOpts = { context: opts.contextLines, ignoreCase: opts.ignoreCase, ignoreWhitespace: opts.ignoreWhitespace };
  const diff = createTwoFilesPatch(oldPath, newPath, oldContent, newContent, undefined, undefined, patchOpts);

  return {
    oldPath,
    newPath,
    diff,
    stats: calculateDiffStats(diff),
    isNew: false,
    isDeleted: false,
    isRename: false,
  };
}

function createNewFileDiff(newPath: string, newContent: string, opts: { contextLines: number }): FileDiff {
  const diff = createTwoFilesPatch(NULL_PATH, newPath, "", newContent, undefined, undefined, { context: opts.contextLines });
  
  return {
    oldPath: NULL_PATH,
    newPath,
    diff,
    stats: calculateDiffStats(diff),
    isNew: true,
    isDeleted: false,
    isRename: false,
  };
}

function createDeletedFileDiff(oldPath: string, oldContent: string, opts: { contextLines: number }): FileDiff {
  const diff = createTwoFilesPatch(oldPath, NULL_PATH, oldContent, "", undefined, undefined, { context: opts.contextLines });
  
  return {
    oldPath,
    newPath: NULL_PATH,
    diff,
    stats: calculateDiffStats(diff),
    isNew: false,
    isDeleted: true,
    isRename: false,
  };
}

function createRenameDiff(oldPath: string, newPath: string): FileDiff {
  return {
    oldPath,
    newPath,
    diff: `--- ${oldPath}\n+++ ${newPath}\n@@ -1,1 +1,1 @@\n rename from ${oldPath}\n rename to ${newPath}`,
    stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 0, hunks: 0 },
    isNew: false,
    isDeleted: false,
    isRename: true,
  };
}

// ─── Batch Diff ──────────────────────────────────────────────────────────────

export function generateBatchDiff(
  files: Array<{ oldPath: string; newPath: string; oldContent: string; newContent: string }>,
  options: DiffGeneratorOptions = {}
): BatchDiff {
  const fileDiffs = files.map(f => generateFileDiff(f.oldPath, f.newPath, f.oldContent, f.newContent, options));

  const totalStats = fileDiffs.reduce(
    (acc, file) => ({
      additions: acc.additions + file.stats.additions,
      deletions: acc.deletions + file.stats.deletions,
      modifications: acc.modifications + file.stats.modifications,
      totalChanges: acc.totalChanges + file.stats.totalChanges,
      hunks: acc.hunks + file.stats.hunks,
    }),
    { additions: 0, deletions: 0, modifications: 0, totalChanges: 0, hunks: 0 }
  );

  return {
    files: fileDiffs,
    totalStats,
    summary: generateSummary(fileDiffs, totalStats),
  };
}

function generateSummary(files: FileDiff[], totalStats: DiffStats): string {
  const changed = files.filter(f => !f.isNew && !f.isDeleted && !f.isRename).length;
  const added = files.filter(f => f.isNew).length;
  const deleted = files.filter(f => f.isDeleted).length;
  const renamed = files.filter(f => f.isRename).length;

  const parts: string[] = [];
  if (changed > 0) parts.push(`${changed} changed`);
  if (added > 0) parts.push(`${added} added`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  if (renamed > 0) parts.push(`${renamed} renamed`);

  return parts.join(", ") + ` (+${totalStats.additions}/-${totalStats.deletions})`;
}

// ─── Utility Functions ───────────────────────────────────────────────────────

export function truncateDiff(diff: string, maxLines: number = DEFAULT_TRUNCATION_LINES): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;

  const truncated = lines.slice(0, maxLines).join("\n");
  const remaining = lines.length - maxLines;
  return `${truncated}\n\n... (${remaining} more lines truncated) ...`;
}

export function hasChanges(diff: FileDiff): boolean {
  return diff.stats.totalChanges > 0 || diff.isNew || diff.isDeleted || diff.isRename;
}

export function generateStructuredPatch(
  oldPath: string,
  newPath: string,
  oldContent: string,
  newContent: string,
  options: DiffGeneratorOptions = {}
): ReturnType<typeof structuredPatch> {
  const context = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  return structuredPatch(oldPath, newPath, oldContent, newContent, undefined, undefined, { context });
}

// ─── Inline Diff (simplified word-level) ─────────────────────────────────────

export function generateInlineDiff(
  oldText: string,
  newText: string
): { added: string; removed: string; unchanged: string } {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  
  const removed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];

  let i = 0, j = 0;
  
  while (i < oldWords.length || j < newWords.length) {
    if (i >= oldWords.length) {
      added.push(newWords[j]!);
      j++;
    } else if (j >= newWords.length) {
      removed.push(oldWords[i]!);
      i++;
    } else if (oldWords[i] === newWords[j]) {
      unchanged.push(oldWords[i]!);
      i++;
      j++;
    } else {
      removed.push(oldWords[i]!);
      added.push(newWords[j]!);
      i++;
      j++;
    }
  }

  return {
    added: added.join(""),
    removed: removed.join(""),
    unchanged: unchanged.join(""),
  };
}
