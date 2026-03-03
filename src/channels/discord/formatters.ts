/**
 * Discord message formatters
 * Handles text formatting, truncation, and markdown conversion for Discord.
 */

const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const DISCORD_MAX_EMBED_DESCRIPTION = 4096;

/**
 * Convert common markdown formats to Discord-compatible markdown.
 * Discord uses a subset of standard markdown with some differences.
 */
export function formatToDiscordMarkdown(text: string): string {
  let formatted = text;

  // Convert GitHub-style code blocks with language hint
  // Discord supports ```lang\ncode\n``` syntax
  formatted = formatted.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const language = lang ?? "";
      return "```" + language + "\n" + code.trim() + "\n```";
    }
  );

  // Handle inline code (Discord supports `code`)
  // No conversion needed, it's the same

  // Convert bold - standard ** works in Discord
  // Convert italic - standard * or _ works in Discord
  // Convert strikethrough - standard ~~ works in Discord
  // Convert underline - standard __ works in Discord

  // Convert headers (# Header) to bold
  formatted = formatted.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

  // Convert bullet points - mostly compatible
  // Discord doesn't have special rendering for different bullet styles

  // Convert numbered lists - mostly compatible
  // Ensure there's a space after the number
  formatted = formatted.replace(/^(\d+)\.\s*/gm, "$1. ");

  // Handle blockquotes - Discord uses > at start of line
  // Multiple levels: >>> for multi-line, > for single line
  formatted = formatted.replace(
    /^>\s*(.+)$/gm,
    "> $1"
  );

  // Handle spoilers (Discord-specific: ||spoiler||)
  // If text contains <!-- spoiler --> style, convert it
  formatted = formatted.replace(
    /<!--\s*spoiler\s*-->([\s\S]*?)<!--\s*\/spoiler\s*-->/gi,
    "||$1||"
  );

  // Handle mentions - Discord has special mention formats
  // @username -> <@userId> (requires lookup, so we skip)
  // @role -> <@&roleId> (requires lookup, so we skip)
  // @channel -> <#channelId> (requires lookup, so we skip)

  // Handle links - [text](url) is supported in Discord
  // No conversion needed

  // Handle horizontal rules
  // Discord doesn't support horizontal rules, replace with dashes
  formatted = formatted.replace(/^-{3,}$/gm, "---");
  formatted = formatted.replace(/^\*{3,}$/gm, "***");
  formatted = formatted.replace(/^_{3,}$/gm, "___");

  // Clean up excessive newlines (Discord renders them literally)
  // Keep max 2 consecutive newlines
  formatted = formatted.replace(/\n{3,}/g, "\n\n");

  return formatted.trim();
}

/**
 * Truncate text to fit within Discord's message limits.
 * Optionally adds an ellipsis if truncated.
 */
export function truncateForDiscord(
  text: string,
  maxLength: number = DISCORD_MAX_MESSAGE_LENGTH,
  addEllipsis: boolean = true
): string {
  if (text.length <= maxLength) {
    return text;
  }

  const ellipsis = addEllipsis ? "..." : "";
  const truncateLength = maxLength - ellipsis.length;

  return text.substring(0, truncateLength) + ellipsis;
}

/**
 * Truncate text for embed descriptions.
 */
export function truncateForEmbedDescription(
  text: string,
  addEllipsis: boolean = true
): string {
  return truncateForDiscord(text, DISCORD_MAX_EMBED_DESCRIPTION, addEllipsis);
}

/**
 * Split a long message into chunks that fit within Discord's limits.
 * Tries to split at natural boundaries (paragraphs, sentences).
 */
export function splitMessage(
  text: string,
  maxLength: number = DISCORD_MAX_MESSAGE_LENGTH
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point
    let splitPoint = maxLength;

    // First, try to split at a double newline (paragraph break)
    const paragraphBreak = remaining.lastIndexOf("\n\n", maxLength);
    if (paragraphBreak > maxLength * 0.5) {
      splitPoint = paragraphBreak;
    } else {
      // Try to split at a single newline
      const lineBreak = remaining.lastIndexOf("\n", maxLength);
      if (lineBreak > maxLength * 0.7) {
        splitPoint = lineBreak;
      } else {
        // Try to split at a sentence end
        const sentenceEnd = remaining.lastIndexOf(". ", maxLength);
        if (sentenceEnd > maxLength * 0.8) {
          splitPoint = sentenceEnd + 1;
        } else {
          // Try to split at a space
          const space = remaining.lastIndexOf(" ", maxLength);
          if (space > maxLength * 0.8) {
            splitPoint = space;
          }
          // Otherwise, hard split at maxLength
        }
      }
    }

    chunks.push(remaining.substring(0, splitPoint).trim());
    remaining = remaining.substring(splitPoint).trim();
  }

  return chunks;
}

/**
 * Format code block for Discord.
 * Optionally specify the language for syntax highlighting.
 */
export function formatCodeBlock(
  code: string,
  language?: string
): string {
  const lang = language ?? "";
  const trimmedCode = code.trim();
  return "```" + lang + "\n" + trimmedCode + "\n```";
}

/**
 * Format inline code for Discord.
 */
export function formatInlineCode(text: string): string {
  // If the text contains backticks, use double backticks
  if (text.includes("`")) {
    return "``" + text + "``";
  }
  return "`" + text + "`";
}

/**
 * Create a Discord spoiler.
 */
export function formatSpoiler(text: string): string {
  return "||" + text + "||";
}

/**
 * Create a Discord mention (requires the ID).
 */
export function formatUserMention(userId: string): string {
  return "<@" + userId + ">";
}

export function formatRoleMention(roleId: string): string {
  return "<@&" + roleId + ">";
}

export function formatChannelMention(channelId: string): string {
  return "<#" + channelId + ">";
}

/**
 * Format a timestamp for Discord (uses Discord's timestamp format).
 * Discord will display it in the user's local timezone.
 * Style: 't' = short time, 'T' = long time, 'd' = short date,
 *        'D' = long date, 'f' = short datetime, 'F' = long datetime,
 *        'R' = relative time
 */
export function formatTimestamp(
  date: Date,
  style: "t" | "T" | "d" | "D" | "f" | "F" | "R" = "f"
): string {
  const unixTimestamp = Math.floor(date.getTime() / 1000);
  return "<t:" + unixTimestamp + ":" + style + ">";
}

/**
 * Escape special Discord markdown characters.
 * Use this when sending raw user input that shouldn't be interpreted as markdown.
 */
export function escapeDiscordMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|");
}

/**
 * Format a file path for display in Discord.
 * Wraps in inline code and escapes markdown.
 */
export function formatFilePath(path: string): string {
  return formatInlineCode(escapeDiscordMarkdown(path));
}

/**
 * Format a diff-style output for Discord.
 * Uses code blocks with diff syntax highlighting.
 */
export function formatDiff(diff: string, filename?: string): string {
  const header = filename ? "--- " + filename + " ---\n" : "";
  return formatCodeBlock(header + diff, "diff");
}

/**
 * Format a quote for Discord blockquote.
 */
export function formatQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => "> " + line)
    .join("\n");
}

/**
 * Format a multi-line quote (Discord uses >>> for multi-line quotes).
 */
export function formatMultiLineQuote(text: string): string {
  return ">>> " + text;
}
