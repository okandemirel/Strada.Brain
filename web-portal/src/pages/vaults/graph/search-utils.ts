/**
 * Sublime Text–style fuzzy matcher for the vault graph search.
 *
 * Pure functions, no runtime dependencies. The scoring weights below are tuned
 * for short identifier-like strings (symbol labels, file paths). They roughly
 * mirror the heuristics popularised by Sublime / VS Code:
 *
 *   - all query characters must appear in order in the target (case-insensitive)
 *   - contiguous runs of matches earn a large bonus
 *   - matches landing on a word boundary (start, after `/-_. ` etc., or a
 *     camelCase boundary) earn an extra bonus
 *   - exact case matches earn a small bonus on top of the case-insensitive hit
 *   - gaps between matches and matches deep into the string add a small penalty
 *
 * The matcher uses dynamic programming so that the *best* alignment is chosen
 * (a naive greedy first-occurrence matcher misses word-boundary alignments —
 * e.g. `cfg` in `src/cfg.ts` would lock onto the `c` in `src` and never reach
 * the `c` after the slash).
 *
 * The returned `ranges` are half-open `[start, endExclusive)` slices into the
 * original `target`, suitable for highlight rendering.
 */

export interface FuzzyMatch {
  /** Higher is better; not bounded to any range. */
  score: number;
  /** Half-open `[start, endExclusive)` ranges of matched chars in `target`. */
  ranges: [number, number][];
}

/**
 * DoS caps. The DP matcher is O(qLen * tLen^2) in the worst case — a long
 * query against a long target can chew through CPU. We hard-cap both inputs
 * so a malicious or accidental paste of a 1MB string can't freeze the tab.
 *
 * Query longer than the cap is treated as a non-match (caller should also
 * surface a UI hint). Target longer than the cap is truncated; the prefix
 * is what's searched.
 */
export const MAX_QUERY_LEN = 64;
export const MAX_TARGET_LEN = 256;

// Scoring weights — tuned empirically; see tests for ordering invariants.
const SCORE_BASE_MATCH = 1;
const SCORE_CASE_BONUS = 2;
const SCORE_CONTIGUOUS_BONUS = 12;
const SCORE_WORD_BOUNDARY_BONUS = 8;
const SCORE_FIRST_CHAR_BONUS = 10;
const PENALTY_GAP = 1;
const PENALTY_UNMATCHED_LEADING = 1; // per leading char before the first match
const PENALTY_UNMATCHED_LEADING_MAX = 6;

const WORD_BOUNDARY_CHARS = new Set(['/', '\\', '-', '_', '.', ' ', ':']);

function isWordBoundary(target: string, idx: number): boolean {
  if (idx === 0) return true;
  const prevCh = target[idx - 1];
  if (WORD_BOUNDARY_CHARS.has(prevCh)) return true;
  // camelCase: lowercase/digit followed by uppercase letter
  const prevCode = target.charCodeAt(idx - 1);
  const curCode = target.charCodeAt(idx);
  const isPrevLower = (prevCode >= 97 && prevCode <= 122) || (prevCode >= 48 && prevCode <= 57);
  const isCurUpper = curCode >= 65 && curCode <= 90;
  return isPrevLower && isCurUpper;
}

interface CharScore {
  /** Score for matching query[qi] at target[ti] in isolation (no prev context). */
  base: number;
  /** Extra score added when this match is contiguous with the previous match. */
  contiguousBonus: number;
}

function computeCharScore(
  query: string,
  qi: number,
  target: string,
  ti: number,
): CharScore | null {
  if (query.charCodeAt(qi) !== target.charCodeAt(ti)) {
    // Try case-insensitive fallback.
    if (query[qi].toLowerCase() !== target[ti].toLowerCase()) return null;
  }
  let base = SCORE_BASE_MATCH;
  if (query[qi] === target[ti]) base += SCORE_CASE_BONUS;
  if (ti === 0) base += SCORE_FIRST_CHAR_BONUS;
  if (isWordBoundary(target, ti)) base += SCORE_WORD_BOUNDARY_BONUS;
  return { base, contiguousBonus: SCORE_CONTIGUOUS_BONUS };
}

/**
 * Returns `null` if any query character cannot be found in order, otherwise
 * a {@link FuzzyMatch} with a score and the matched character ranges.
 *
 * Empty queries return `null` by contract — callers filter them upstream.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return null;
  if (!target) return null;

  // DoS guard: oversize query is rejected outright; oversize target is
  // truncated to the cap before scoring.
  if (query.length > MAX_QUERY_LEN) return null;
  const safeTarget = target.length > MAX_TARGET_LEN
    ? target.slice(0, MAX_TARGET_LEN)
    : target;

  const qLen = query.length;
  const tLen = safeTarget.length;
  if (qLen > tLen) return null;

  // dp[qi][ti] = best total score matching query[0..qi] ending at target[ti],
  //              or -Infinity if no such alignment exists.
  // prev[qi][ti] = target index of query[qi-1] in the optimal alignment, or -1.
  const NEG_INF = Number.NEGATIVE_INFINITY;
  const dp: Float64Array[] = new Array(qLen);
  const prev: Int32Array[] = new Array(qLen);
  for (let i = 0; i < qLen; i += 1) {
    dp[i] = new Float64Array(tLen);
    prev[i] = new Int32Array(tLen);
    for (let j = 0; j < tLen; j += 1) {
      dp[i][j] = NEG_INF;
      prev[i][j] = -1;
    }
  }

  // First query char: try every target position.
  for (let ti = 0; ti < tLen; ti += 1) {
    const cs = computeCharScore(query, 0, safeTarget, ti);
    if (cs === null) continue;
    const leadingPenalty = Math.min(ti * PENALTY_UNMATCHED_LEADING, PENALTY_UNMATCHED_LEADING_MAX);
    dp[0][ti] = cs.base - leadingPenalty;
  }

  // Subsequent query chars.
  for (let qi = 1; qi < qLen; qi += 1) {
    for (let ti = qi; ti < tLen; ti += 1) {
      const cs = computeCharScore(query, qi, safeTarget, ti);
      if (cs === null) continue;
      // Pick the best predecessor (any tj < ti with a valid dp[qi-1][tj]).
      let bestPrev = NEG_INF;
      let bestPrevIdx = -1;
      for (let tj = qi - 1; tj < ti; tj += 1) {
        const prevScore = dp[qi - 1][tj];
        if (prevScore === NEG_INF) continue;
        const gap = ti - tj - 1;
        let candidate = prevScore + cs.base - gap * PENALTY_GAP;
        if (gap === 0) candidate += cs.contiguousBonus;
        if (candidate > bestPrev) {
          bestPrev = candidate;
          bestPrevIdx = tj;
        }
      }
      if (bestPrevIdx !== -1) {
        dp[qi][ti] = bestPrev;
        prev[qi][ti] = bestPrevIdx;
      }
    }
  }

  // Find best end position for the last query char.
  let bestScore = NEG_INF;
  let bestEnd = -1;
  for (let ti = qLen - 1; ti < tLen; ti += 1) {
    if (dp[qLen - 1][ti] > bestScore) {
      bestScore = dp[qLen - 1][ti];
      bestEnd = ti;
    }
  }
  if (bestEnd === -1 || bestScore === NEG_INF) return null;

  // Reconstruct match positions by walking prev[] backwards.
  const positions: number[] = new Array(qLen);
  positions[qLen - 1] = bestEnd;
  for (let qi = qLen - 1; qi > 0; qi -= 1) {
    positions[qi - 1] = prev[qi][positions[qi]];
  }

  // Collapse consecutive positions into half-open ranges.
  const ranges: [number, number][] = [];
  let runStart = positions[0];
  let runEnd = positions[0] + 1;
  for (let i = 1; i < qLen; i += 1) {
    const idx = positions[i];
    if (idx === runEnd) {
      runEnd = idx + 1;
    } else {
      ranges.push([runStart, runEnd]);
      runStart = idx;
      runEnd = idx + 1;
    }
  }
  ranges.push([runStart, runEnd]);

  return { score: bestScore, ranges };
}
