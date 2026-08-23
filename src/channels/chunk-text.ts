/**
 * Shared, newline-aware text chunker for channels that must respect a provider
 * message-length limit.
 *
 * Several channels (Discord, Teams) historically either
 * truncated long messages (dropping content) or sent them unbounded (rejected by
 * the provider). This helper splits a long message into chunks that each stay
 * within `max`, preferring paragraph/line/word boundaries and hard-splitting any
 * single token that is itself longer than `max`. No chunk ever exceeds `max`, and
 * empty/whitespace input yields no chunks (callers should skip empty sends).
 *
 * Note: `max` is measured in JS string length (UTF-16 code units), not bytes.
 * Channels with a byte-based server limit should pass a conservative `max` (e.g.
 * well under the byte cap) to leave headroom for multi-byte characters and any
 * markup/HTML expansion applied after chunking.
 */
export function chunkText(text: string, max: number): string[] {
  if (!Number.isFinite(max) || max <= 0) {
    throw new RangeError(`chunkText: max must be a positive number, got ${max}`);
  }
  if (text.length === 0) return [];
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of text.split("\n")) {
    // A single line longer than the limit must be hard-split (prefer the last
    // space within the window so we break on a word boundary when possible).
    if (line.length > max) {
      flush();
      let rest = line;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(" ", max);
        if (cut <= 0) cut = max; // no usable space — hard cut at the limit
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ /, ""); // drop the boundary space
      }
      current = rest;
      continue;
    }

    // Re-join lines with their newline separator; flush before overflowing.
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > max) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }

  flush();
  return chunks;
}
