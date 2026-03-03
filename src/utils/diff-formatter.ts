/**
 * Diff Formatter - Formats diffs for different output channels
 */

import type { FileDiff, BatchDiff } from "./diff-generator.js";
import { truncateDiff, formatDiffStats } from "./diff-generator.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const CHANNEL_LIMITS = {
  telegram: { maxLength: 3500, maxLines: 50, batchMaxLines: 30 },
  whatsapp: { maxLength: 1500, maxLines: 40, batchMaxLines: 20 },
  cli: { maxLength: Infinity, maxLines: 100, batchMaxLines: 100 },
};

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChannelType = "telegram" | "whatsapp" | "cli";

export interface FormatOptions {
  maxLength?: number;
  maxLines?: number;
  showLineNumbers?: boolean;
}

interface FormatterConfig {
  escape: (text: string) => string;
  codeBlock: (text: string, lang?: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  filePrefix: (diff: FileDiff) => string;
  statsFormat: (stats: string) => string;
  separator: string;
}

// ─── Channel Formatters ──────────────────────────────────────────────────────

const FORMATTERS: Record<ChannelType, FormatterConfig> = {
  telegram: {
    escape: escapeMarkdownV2,
    codeBlock: (text, lang) => "```" + (lang || "") + "\n" + text + "\n```",
    bold: text => `*${text}*`,
    italic: text => `_${text}_`,
    filePrefix: diff => {
      let prefix = `📄 *${escapeMarkdownV2(diff.newPath)}*`;
      if (diff.isNew) prefix += " _(new file)_";
      else if (diff.isDeleted) prefix += " _(deleted)_";
      else if (diff.isRename) prefix += ` _(renamed from \`${escapeMarkdownV2(diff.oldPath)}\`)_`;
      return prefix;
    },
    statsFormat: stats => "`" + escapeMarkdownV2(stats) + "`",
    separator: "\n\n─────────────\n\n",
  },
  
  whatsapp: {
    escape: t => t,
    codeBlock: text => "```\n" + text + "\n```",
    bold: text => `*${text}*`,
    italic: text => `_${text}_`,
    filePrefix: diff => {
      let prefix = `📄 *${diff.newPath}*`;
      if (diff.isNew) prefix += " _(new)_";
      else if (diff.isDeleted) prefix += " _(deleted)_";
      else if (diff.isRename) prefix += " _(renamed)_";
      return prefix;
    },
    statsFormat: stats => `_${stats}_`,
    separator: "\n\n",
  },
  
  cli: {
    escape: t => t,
    codeBlock: text => colorizeDiff(text),
    bold: text => `${ANSI.bold}${text}${ANSI.reset}`,
    italic: text => `${ANSI.dim}${text}${ANSI.reset}`,
    filePrefix: diff => {
      const indicator = diff.isNew ? `${ANSI.green}A` : 
                       diff.isDeleted ? `${ANSI.red}D` : 
                       diff.isRename ? `${ANSI.yellow}R` : `${ANSI.yellow}M`;
      let prefix = `${indicator}${ANSI.reset} ${ANSI.bold}${diff.isDeleted ? diff.oldPath : diff.newPath}${ANSI.reset}`;
      if (diff.isRename) prefix += ` → ${diff.newPath}`;
      return prefix;
    },
    statsFormat: stats => `${ANSI.dim}${stats}${ANSI.reset}`,
    separator: "\n\n",
  },
};

// ─── Main Format Functions ───────────────────────────────────────────────────

/**
 * Format a diff for Telegram
 */
export function formatDiffForTelegram(diff: FileDiff, options?: FormatOptions): string {
  return formatDiffForChannel(diff, "telegram", options);
}

/**
 * Format a batch diff for Telegram
 */
export function formatBatchDiffForTelegram(batchDiff: BatchDiff, options?: FormatOptions): string {
  return formatBatchDiffForChannel(batchDiff, "telegram", options);
}

/**
 * Format a diff for WhatsApp
 */
export function formatDiffForWhatsApp(diff: FileDiff, options?: FormatOptions): string {
  return formatDiffForChannel(diff, "whatsapp", options);
}

/**
 * Format a batch diff for WhatsApp
 */
export function formatBatchDiffForWhatsApp(batchDiff: BatchDiff, options?: FormatOptions): string {
  return formatBatchDiffForChannel(batchDiff, "whatsapp", options);
}

/**
 * Format a diff for CLI
 */
export function formatDiffForCLI(diff: FileDiff, options?: FormatOptions): string {
  return formatDiffForChannel(diff, "cli", options);
}

/**
 * Format a batch diff for CLI
 */
export function formatBatchDiffForCLI(batchDiff: BatchDiff, options?: FormatOptions): string {
  return formatBatchDiffForChannel(batchDiff, "cli", options);
}

export function formatDiffForChannel(
  diff: FileDiff,
  channel: ChannelType,
  options?: FormatOptions
): string {
  const fmt = FORMATTERS[channel];
  const limits = CHANNEL_LIMITS[channel];
  const maxLines = options?.maxLines ?? limits.maxLines;

  // File header
  let formatted = fmt.filePrefix(diff) + "\n";
  formatted += fmt.statsFormat(formatDiffStats(diff.stats)) + "\n\n";

  // Pure rename - no content
  if (diff.isRename && diff.stats.totalChanges === 0) {
    return formatted.trim();
  }

  // Diff content
  let content = truncateDiff(diff.diff, maxLines);
  
  if (channel !== "cli" && options?.showLineNumbers) {
    content = addLineNumbers(content);
  }

  formatted += fmt.codeBlock(channel === "telegram" ? escapeCodeBlock(content) : content, "diff");

  return formatted;
}

export function formatBatchDiffForChannel(
  batchDiff: BatchDiff,
  channel: ChannelType,
  options?: FormatOptions
): string {
  const fmt = FORMATTERS[channel];
  const limits = CHANNEL_LIMITS[channel];
  const maxLength = options?.maxLength ?? limits.maxLength;

  // Header
  const fileCount = batchDiff.files.length;
  const fileText = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  
  let formatted = channel === "cli"
    ? `${fmt.bold}📋 Changes Summary${ANSI.reset}\n${fileText} · ${fmt.italic(batchDiff.summary)}${ANSI.reset}\n${ANSI.dim}${"─".repeat(60)}${ANSI.reset}\n\n`
    : `*📋 ${channel === "telegram" ? "Changes Summary" : fileText + " Changed"}*\n${fileText} · ${fmt.statsFormat(batchDiff.summary)}\n\n`;

  // WhatsApp: show compact list for multiple files
  if (channel === "whatsapp" && batchDiff.files.length > 1) {
    return formatWhatsAppBatch(batchDiff, fmt, maxLength, options);
  }

  // Format each file
  const fileDiffs: string[] = [];
  let currentLength = formatted.length;

  for (const fileDiff of batchDiff.files) {
    const formattedDiff = formatDiffForChannel(fileDiff, channel, {
      ...options,
      maxLines: limits.batchMaxLines,
    });

    if (currentLength + formattedDiff.length + 50 > maxLength) {
      fileDiffs.push(`\n_... and ${batchDiff.files.length - fileDiffs.length} more files_`);
      break;
    }

    fileDiffs.push(formattedDiff);
    currentLength += formattedDiff.length + 2;
  }

  return formatted + fileDiffs.join(fmt.separator);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatWhatsAppBatch(
  batchDiff: BatchDiff,
  _fmt: FormatterConfig,
  maxLength: number,
  options?: FormatOptions
): string {
  const fileList = batchDiff.files.map(f => {
    const prefix = f.isNew ? "➕" : f.isDeleted ? "🗑️" : f.isRename ? "📋" : "📝";
    return `${prefix} ${f.newPath} (${formatDiffStats(f.stats)})`;
  });

  let formatted = `*📋 ${batchDiff.files.length} Files Changed*\n_${batchDiff.summary}_\n\n`;
  formatted += fileList.join("\n");

  // Show first file diff if room
  if (batchDiff.files[0] && formatted.length < maxLength - 500) {
    formatted += "\n\n*First file:*\n";
    formatted += formatDiffForChannel(batchDiff.files[0], "whatsapp", { ...options, maxLines: 20 });
  }

  return formatted;
}

export function formatCompactSummary(
  batchDiff: BatchDiff,
  channel: ChannelType
): string {
  const { additions, deletions } = batchDiff.totalStats;
  const fileCount = batchDiff.files.length;
  const fileText = `${fileCount} file${fileCount === 1 ? "" : "s"}`;

  switch (channel) {
    case "telegram":
      return `📊 *${fileText}* · \`+${additions}/-${deletions}\``;
    case "whatsapp":
      return `📊 *${fileText}* · _+${additions}/-${deletions}_`;
    case "cli":
      return `${ANSI.bold}📊 ${fileText}${ANSI.reset} · ${ANSI.green}+${additions}${ANSI.reset} ${ANSI.red}-${deletions}${ANSI.reset}`;
  }
}

// ─── Escaping & Coloring ─────────────────────────────────────────────────────

function escapeMarkdownV2(text: string): string {
  return text
    .replace(/[\_*\[\]\(\)~`>\+#\-=|{}]/g, "\\$&")
    .replace(/\\/g, "\\\\");
}

function escapeCodeBlock(text: string): string {
  return text.replace(/`/g, "\\`").replace(/\\/g, "\\\\");
}

function colorizeDiff(diff: string): string {
  return diff.split("\n").map(line => {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return `${ANSI.bold}${ANSI.cyan}${line}${ANSI.reset}`;
    if (line.startsWith("@@")) return `${ANSI.cyan}${line}${ANSI.reset}`;
    if (line.startsWith("+")) return `${ANSI.green}${line}${ANSI.reset}`;
    if (line.startsWith("-")) return `${ANSI.red}${line}${ANSI.reset}`;
    if (line.startsWith("... (")) return `${ANSI.dim}${line}${ANSI.reset}`;
    return `${ANSI.gray}${line}${ANSI.reset}`;
  }).join("\n");
}

// ─── Line Numbers ────────────────────────────────────────────────────────────

function addLineNumbers(diff: string): string {
  const lines = diff.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  return lines.map(line => {
    if (line.startsWith("@@")) {
      inHunk = true;
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        oldLine = parseInt(match[1]!, 10);
        newLine = parseInt(match[2]!, 10);
      }
      return line;
    }

    if (!inHunk || line.startsWith("\\")) return line;

    const num = (n: number) => n.toString().padStart(4, " ");

    if (line.startsWith("-")) {
      return `${num(oldLine++)} ${line}`;
    }
    if (line.startsWith("+")) {
      return `${num(newLine++)} ${line}`;
    }
    if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
      return `${num(oldLine - 1)} ${line}`;
    }

    return line;
  }).join("\n");
}
