/**
 * Bounds on text a person's message turns into stored learning.
 *
 * A teaching or correction is stored as an instinct's `action` and later
 * rendered into system prompts. Stored whole, one pasted document became a
 * 16 KB "insight" repeated into every matching run, so what is kept is a
 * summary: the text cut to a fixed length, with a marker saying it was cut.
 */

/** The longest teaching or correction kept as an instinct's action. */
export const MAX_LEARNED_TEXT_CHARS = 400;

const TRUNCATION_MARKER = " …[truncated]";

/** `text` cut to at most `max` characters, marked when anything was cut. */
export function capLearnedText(text: string, max: number = MAX_LEARNED_TEXT_CHARS): string {
  if (text.length <= max) return text;
  const kept = text
    .slice(0, Math.max(0, max - TRUNCATION_MARKER.length))
    // Never leave half of a surrogate pair at the cut.
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trimEnd();
  return kept + TRUNCATION_MARKER;
}
