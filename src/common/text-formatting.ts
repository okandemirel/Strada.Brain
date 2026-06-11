/**
 * Shared text-chunking/formatting helpers for channel formatters.
 *
 * Extracted from `src/channels/discord/formatters.ts` and
 * `src/channels/slack/formatters.ts` (plan 013). The two originals shared the
 * same algorithmic core — boundary-aware splitting, marker-appending
 * truncation, code fencing, line-prefixed quoting and mention building — but
 * differed in small, deliberate ways. Every such difference is expressed here
 * as a generic, behavior-named option so each channel wrapper keeps
 * byte-identical output. Do NOT "fix" quirks (e.g. UTF-16 length-based
 * truncation that can split surrogate pairs) without deliberately updating
 * the characterization tests of BOTH channels.
 *
 * Channel-specific markdown dialect converters (`formatToDiscordMarkdown`,
 * `formatToSlackMrkdwn`) are real platform differences and stay channel-local.
 */

/** Options controlling boundary-aware splitting of long text into chunks. */
export interface SplitOptions {
  /** Split at a paragraph break ("\n\n") found past ratio*maxLength. */
  readonly paragraphRatio: number;
  /** Split at a newline found past ratio*maxLength. */
  readonly newlineRatio: number;
  /** Split at a sentence end (". ") found past ratio*maxLength. */
  readonly sentenceRatio: number;
  /**
   * Split at a space found past ratio*maxLength.
   * Omit to disable the space boundary entirely.
   */
  readonly spaceRatio?: number;
  /** Trim each emitted chunk. (The remainder is always trimmed.) */
  readonly trimChunks: boolean;
  /**
   * When true, a boundary at exactly ratio*maxLength is accepted (>= gate);
   * when false/omitted, the comparison is strict (> gate).
   */
  readonly inclusiveRatioGate?: boolean;
  /**
   * Offset added to a sentence-boundary split point. Use 1 to keep the "."
   * inside the current chunk; omit (0) to split before the ". " pair.
   */
  readonly sentenceSplitOffset?: number;
  /** Return [""] for empty input instead of []. */
  readonly keepEmptyInput?: boolean;
}

/**
 * Split long text into chunks of at most maxLength characters, preferring
 * natural boundaries (paragraph -> newline -> sentence -> space -> hard cut).
 */
export function splitAtBoundaries(
  text: string,
  maxLength: number,
  options: SplitOptions
): string[] {
  if (text.length <= maxLength) {
    if (text.length === 0 && options.keepEmptyInput !== true) {
      return [];
    }
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const splitPoint = findSplitPoint(remaining, maxLength, options);
    const chunk = remaining.substring(0, splitPoint);
    chunks.push(options.trimChunks ? chunk.trim() : chunk);
    remaining = remaining.substring(splitPoint).trim();
  }

  return chunks;
}

function findSplitPoint(
  remaining: string,
  maxLength: number,
  options: SplitOptions
): number {
  const accepts = (position: number, ratio: number): boolean => {
    const gate = maxLength * ratio;
    // lastIndexOf returns -1 when absent, which never passes the gate.
    return options.inclusiveRatioGate === true ? position >= gate : position > gate;
  };

  const paragraphBreak = remaining.lastIndexOf("\n\n", maxLength);
  if (accepts(paragraphBreak, options.paragraphRatio)) {
    return paragraphBreak;
  }

  const lineBreak = remaining.lastIndexOf("\n", maxLength);
  if (accepts(lineBreak, options.newlineRatio)) {
    return lineBreak;
  }

  const sentenceEnd = remaining.lastIndexOf(". ", maxLength);
  if (accepts(sentenceEnd, options.sentenceRatio)) {
    return sentenceEnd + (options.sentenceSplitOffset ?? 0);
  }

  if (options.spaceRatio !== undefined) {
    const space = remaining.lastIndexOf(" ", maxLength);
    if (accepts(space, options.spaceRatio)) {
      return space;
    }
  }

  return maxLength;
}

/** One natural-boundary preference for truncateText, in priority order. */
export interface TruncateBoundary {
  /** Boundary string located with lastIndexOf(marker, budget). */
  readonly marker: string;
  /**
   * Accept the boundary only at/after minRatio*budget.
   * Omit to accept the boundary wherever it is found.
   */
  readonly minRatio?: number;
}

/** Options controlling truncation of over-long text. */
export interface TruncateOptions {
  /** Marker appended when truncation happens (e.g. "..." or "\n\n...(truncated)"). */
  readonly marker: string;
  /** Ordered natural-boundary preferences; omit for a plain hard cut. */
  readonly boundaries?: readonly TruncateBoundary[];
  /**
   * Reserve room for the marker inside maxLength, guaranteeing
   * result.length <= maxLength. Omit when the caller's maxLength already
   * excludes the marker.
   */
  readonly reserveMarkerSpace?: boolean;
}

/**
 * Truncate text to maxLength characters, appending a marker and optionally
 * preferring natural boundaries over a hard cut.
 */
export function truncateText(
  text: string,
  maxLength: number,
  options: TruncateOptions
): string {
  if (text.length <= maxLength) {
    return text;
  }

  const budget =
    options.reserveMarkerSpace === true ? maxLength - options.marker.length : maxLength;

  let truncateAt = -1;
  for (const boundary of options.boundaries ?? []) {
    const position = text.lastIndexOf(boundary.marker, budget);
    if (
      position !== -1 &&
      (boundary.minRatio === undefined || position >= budget * boundary.minRatio)
    ) {
      truncateAt = position;
      break;
    }
  }
  if (truncateAt === -1) {
    truncateAt = budget;
  }

  return text.substring(0, truncateAt) + options.marker;
}

/** Options controlling code-block fencing. */
export interface FenceOptions {
  /** Add a newline before and after the fenced block (Slack style). */
  readonly surroundingNewlines?: boolean;
  /** Trim the code before fencing (Discord style). */
  readonly trimCode?: boolean;
}

/**
 * Wrap code in a triple-backtick fence with an optional language tag.
 *
 * Note: neither original escaped inner ``` fences — Slack's historical
 * "escape" (`code.replace(/```/g, "\`\`\`")`) replaced ``` with itself, a
 * no-op pinned by the characterization tests — so no escape option exists.
 */
export function fenceCodeBlock(
  code: string,
  language?: string,
  options: FenceOptions = {}
): string {
  const lang = language ?? "";
  const body = options.trimCode === true ? code.trim() : code;
  const fenced = "```" + lang + "\n" + body + "\n```";
  return options.surroundingNewlines === true ? "\n" + fenced + "\n" : fenced;
}

/**
 * Prefix every line of text, optionally transforming each line first
 * (e.g. HTML-escaping). Used for blockquote rendering.
 */
export function prefixLines(
  text: string,
  prefix: string,
  transform?: (line: string) => string
): string {
  return text
    .split("\n")
    .map((line) => prefix + (transform ? transform(line) : line))
    .join("\n");
}

/** Format a user mention: "<@id>" (identical on Discord and Slack). */
export function formatUserMention(userId: string): string {
  return "<@" + userId + ">";
}

/** Format a channel mention: "<#id>" (identical on Discord and Slack). */
export function formatChannelMention(channelId: string): string {
  return "<#" + channelId + ">";
}
