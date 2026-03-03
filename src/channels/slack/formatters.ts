/**
 * Text formatters for converting various formats to Slack-compatible mrkdwn.
 */

import type { KnownBlock } from "@slack/types";

const MAX_SLACK_MESSAGE_LENGTH = 40000;
const MAX_BLOCK_TEXT_LENGTH = 3000;
const TRUNCATION_MARKER = "\n\n...(truncated)";

/**
 * Convert standard Markdown to Slack mrkdwn format.
 * Handles common differences between standard Markdown and Slack's mrkdwn.
 */
export function formatToSlackMrkdwn(markdown: string): string {
  let text = markdown;

  // Convert headers (### → *bold* for Slack)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, content) => `*${content.trim()}*`);

  // Convert bold (** → *)
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Convert italic (keep _ as is, also handle *)
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Convert strikethrough (~~)
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // Convert inline code
  text = text.replace(/`([^`]+)`/g, "`$1`");

  // Convert code blocks (preserve language)
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    return `
\`\`\`${lang || ""}
${code.trim()}
\`\`\`
`;
  });

  // Convert bullet lists
  text = text.replace(/^[-*]\s+(.+)$/gm, "• $1");

  // Convert numbered lists
  text = text.replace(/^\d+\.\s+(.+)$/gm, "$1");

  // Convert blockquotes
  text = text.replace(/^>\s?(.+)$/gm, ">$1");

  // Convert links [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert bare URLs to links
  text = text.replace(/<(https?:\/\/[^>]+)>/g, "$1");
  text = text.replace(/(https?:\/\/[^\s<>]+)/g, "<$1>");

  // Handle mentions (@user → <@userID> requires user mapping)
  // This is a placeholder - actual implementation needs user ID resolution
  text = text.replace(/@(\w+)/g, "*@$1*");

  return text.trim();
}

/**
 * Truncate text to fit within Slack's message limits.
 */
export function truncateForSlack(
  text: string,
  maxLength = MAX_SLACK_MESSAGE_LENGTH - TRUNCATION_MARKER.length
): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Try to truncate at a natural boundary
  let truncateAt = text.lastIndexOf("\n\n", maxLength);
  if (truncateAt === -1 || truncateAt < maxLength * 0.8) {
    truncateAt = text.lastIndexOf("\n", maxLength);
  }
  if (truncateAt === -1 || truncateAt < maxLength * 0.8) {
    truncateAt = text.lastIndexOf(" ", maxLength);
  }
  if (truncateAt === -1) {
    truncateAt = maxLength;
  }

  return text.substring(0, truncateAt) + TRUNCATION_MARKER;
}

/**
 * Escape special characters for Slack text.
 */
export function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape special characters for Slack mrkdwn.
 */
export function escapeSlackMrkdwn(text: string): string {
  return escapeSlackText(text);
}

/**
 * Format a file path for display in Slack.
 */
export function formatFilePath(path: string, maxLength = 100): string {
  const escaped = escapeSlackText(path);
  if (escaped.length <= maxLength) {
    return `\`${escaped}\``;
  }
  const start = escaped.substring(0, maxLength / 2 - 2);
  const end = escaped.substring(escaped.length - maxLength / 2 + 2);
  return `\`${start}...${end}\``;
}

/**
 * Format code for Slack with optional language.
 */
export function formatCodeBlock(code: string, language?: string): string {
  const escaped = code
    .replace(/```/g, "\`\`\`");
  
  return `
\`\`\`${language || ""}
${escaped}
\`\`\`
`;
}

/**
 * Format an error message for Slack.
 */
export function formatErrorMessage(error: Error | string, context?: string): string {
  const message = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack : undefined;

  let formatted = "❌ *Error*";
  if (context) {
    formatted += ` in ${escapeSlackText(context)}`;
  }
  formatted += `\n\n${escapeSlackText(message)}`;

  if (stack && process.env["NODE_ENV"] === "development") {
    const shortStack = stack.split("\n").slice(0, 5).join("\n");
    formatted += `\n\n\`\`\`\n${escapeSlackText(shortStack)}\n\`\`\``;
  }

  return formatted;
}

/**
 * Format a success message for Slack.
 */
export function formatSuccessMessage(message: string, details?: string): string {
  let formatted = `✅ *Success*\n\n${message}`;
  if (details) {
    formatted += `\n\n_${escapeSlackText(details)}_`;
  }
  return formatted;
}

/**
 * Format a diff output for Slack.
 */
export function formatDiff(diff: string): KnownBlock[] {
  const lines = diff.split("\n");
  const blocks: KnownBlock[] = [];
  let currentChunk = "";

  for (const line of lines) {
    const processedLine = escapeSlackText(line);
    
    if (currentChunk.length + processedLine.length > MAX_BLOCK_TEXT_LENGTH - 10) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `
\`\`\`diff
${currentChunk}
\`\`\`
`,
        },
      });
      currentChunk = "";
    }
    
    currentChunk += processedLine + "\n";
  }

  if (currentChunk) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `
\`\`\`diff
${currentChunk}
\`\`\`
`,
      },
    });
  }

  return blocks;
}

/**
 * Convert a long message into multiple blocks.
 */
export function splitIntoBlocks(text: string): KnownBlock[] {
  const chunks = chunkText(text, MAX_BLOCK_TEXT_LENGTH);
  
  return chunks.map((chunk) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: chunk,
    },
  }));
}

/**
 * Chunk text into smaller pieces.
 */
function chunkText(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = remaining.lastIndexOf("\n\n", maxChunkSize);
    if (breakPoint === -1 || breakPoint < maxChunkSize * 0.5) {
      breakPoint = remaining.lastIndexOf("\n", maxChunkSize);
    }
    if (breakPoint === -1 || breakPoint < maxChunkSize * 0.5) {
      breakPoint = remaining.lastIndexOf(". ", maxChunkSize);
    }
    if (breakPoint === -1 || breakPoint < maxChunkSize * 0.5) {
      breakPoint = maxChunkSize;
    }

    chunks.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks;
}

/**
 * Format a list of items for Slack.
 */
export function formatList(items: string[], ordered = false): string {
  return items
    .map((item, index) => {
      const prefix = ordered ? `${index + 1}.` : "•";
      return `${prefix} ${escapeSlackText(item)}`;
    })
    .join("\n");
}

/**
 * Format user mentions.
 */
export function formatUserMention(userId: string): string {
  return `<@${userId}>`;
}

/**
 * Format channel mentions.
 */
export function formatChannelMention(channelId: string): string {
  return `<#${channelId}>`;
}

/**
 * Format a URL with custom text.
 */
export function formatLink(url: string, text?: string): string {
  if (text) {
    return `<${url}|${escapeSlackText(text)}>`;
  }
  return `<${url}>`;
}

/**
 * Format a quote block.
 */
export function formatQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => `>${escapeSlackText(line)}`)
    .join("\n");
}

/**
 * Strip all formatting and return plain text.
 */
export function stripFormatting(text: string): string {
  return text
    .replace(/\*\*?(.+?)\*\*?/g, "$1")
    .replace(/_(.+?)_/g, "_$1_")
    .replace(/~(.+?)~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/<@(.+?)>/g, "@$1")
    .replace(/<#(.+?)>/g, "#$1")
    .replace(/<([^|]+)\|?.*?>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/**
 * Detect if text contains code blocks.
 */
export function containsCodeBlock(text: string): boolean {
  return /```[\s\S]*?```/.test(text);
}

/**
 * Extract code blocks from text.
 */
export function extractCodeBlocks(text: string): Array<{ language?: string; code: string }> {
  const blocks: Array<{ language?: string; code: string }> = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] ?? undefined,
      code: (match[2] ?? "").trim(),
    });
  }

  return blocks;
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Format duration for display.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}
