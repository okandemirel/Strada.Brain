/**
 * Central token estimator — the ONE heuristic for gating decisions.
 *
 * Why this exists (measured 2026-08-23): three different estimators coexisted —
 * a flat `chars/4` in session compaction and the vault tool, and a CJK-aware
 * character-class model here in rag. Flat chars/4 materially UNDER-counts
 * CJK-heavy and symbol-dense (tool JSON) text, so compaction fired late on
 * exactly the sessions where context pressure is worst. This module is now
 * the single implementation; the others delegate.
 *
 * This is an ESTIMATE for gating/compaction/budget display. It is never used
 * for billing — real usage comes from provider responses.
 *
 * Model: ASCII/Latin averages ~4 chars/token; CJK ideographs, kana and hangul
 * average ~1.5 chars/token (a single ideograph frequently carries a full
 * token). The zero-allocation charCode loop is deliberate: compaction calls
 * this on every PAOR iteration.
 */

const CJK_DIVISOR = 1.5;
const LATIN_DIVISOR = 4;

/** Classify one UTF-16 code unit: true when it belongs to a CJK range. */
function isCjkCode(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xac00 && code <= 0xd7af)    // Hangul Syllables
  );
}

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  const b = createTokenBuckets();
  b.addText(text);
  return b.totalTokens();
}

/**
 * Zero-allocation accumulator for callers that walk structured content
 * (message arrays with tool_use/tool_result blocks) and cannot handily build
 * one big string just to count it.
 */
export interface TokenBuckets {
  /** Add a text segment's characters to the class buckets. */
  addText(text: string): void;
  /** Add pre-counted characters that are known Latin/ASCII (e.g. char totals). */
  addLatinChars(count: number): void;
  totalTokens(): number;
}

export function createTokenBuckets(): TokenBuckets {
  let latinChars = 0;
  let cjkChars = 0;
  return {
    addText(text) {
      for (let i = 0; i < text.length; i++) {
        if (isCjkCode(text.charCodeAt(i))) cjkChars++;
        else latinChars++;
      }
    },
    addLatinChars(count) {
      latinChars += count;
    },
    totalTokens() {
      if (latinChars + cjkChars === 0) return 0;
      return Math.ceil(latinChars / LATIN_DIVISOR + cjkChars / CJK_DIVISOR);
    },
  };
}
