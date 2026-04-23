/**
 * Lightweight in-order substring fuzzy matching.
 *
 * `fuzzyMatch` returns true iff every character of `query` appears in
 * `haystack` in left-to-right order (not necessarily contiguous).
 *
 * `fuzzyScore` returns a rough 0..1 score — higher is better — based on the
 * average gap between matched positions. It returns 0 for a non-match and 1
 * for an exact substring hit. Callers may use it for tie-breaking.
 *
 * Matching is case-insensitive and allocation-light: a single pass with
 * `indexOf` per query character, no regex.
 */

export function fuzzyMatch(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const hay = haystack.toLowerCase();
  let cursor = 0;
  for (const ch of q) {
    const idx = hay.indexOf(ch, cursor);
    if (idx === -1) return false;
    cursor = idx + 1;
  }
  return true;
}

export function fuzzyScore(haystack: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 1;
  const hay = haystack.toLowerCase();
  if (hay.length === 0) return 0;
  // Exact substring → top score.
  if (hay.includes(q)) return 1;

  const positions: number[] = [];
  let cursor = 0;
  for (const ch of q) {
    const idx = hay.indexOf(ch, cursor);
    if (idx === -1) return 0;
    positions.push(idx);
    cursor = idx + 1;
  }
  if (positions.length < 2) return 0.9;
  // Lower average gap → tighter match → higher score (in (0, 1)).
  const span = positions[positions.length - 1] - positions[0];
  const density = q.length / Math.max(span, 1);
  return Math.max(0, Math.min(0.95, density));
}
