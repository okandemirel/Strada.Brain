/**
 * Orchestrator Intent Parser
 *
 * Pure, side-effect free classifier that detects recovery-oriented intents
 * in a user's natural-language message (e.g. "devam et", "retry", "I
 * increased the budget to 500k"). Used by the orchestrator to offer an
 * automatic resume from the most recent {@link PendingTaskCheckpoint}
 * without requiring the user to type an explicit slash command.
 *
 * Bilingual (TR + EN). No LLM. Deterministic keyword + fuzzy matching.
 */

// Types

export type RecoveryIntent =
  | { kind: "resume"; confidence: number; keywords: string[] }
  | { kind: "retry"; confidence: number; keywords: string[] }
  | { kind: "update_budget"; confidence: number; keywords: string[]; tokenK?: number }
  | { kind: "none"; confidence: 0 };

export interface IntentParseContext {
  message: string;
  language?: "tr" | "en" | string;
  hasPendingCheckpoint: boolean;
  lastCheckpointStage?: string;
}

// Keyword tables

/** Phrases that strongly imply "retry the previous attempt" (direct match → 0.9). */
const RETRY_DIRECT: readonly string[] = [
  // Turkish
  "tekrar dene",
  "yeniden dene",
  "yeniden başlat",
  "tekrar başlat",
  "baştan dene",
  "tekrar çalıştır",
  // English
  "try again",
  "retry it",
  "retry the task",
  "run it again",
  "rerun",
  "re-run",
];

/** Weaker retry/resume keywords (partial match → 0.6). */
const RETRY_KEYWORDS: readonly string[] = [
  "retry",
  "tekrar",
  "yeniden",
];

/** Phrases that imply "resume from where we left off" (direct match → 0.9). */
const RESUME_DIRECT: readonly string[] = [
  // Turkish
  "devam et",
  "devam edelim",
  "kaldığın yerden",
  "kaldigin yerden",
  "kaldığımız yerden",
  "sürdür",
  "surdur",
  "devam edebilir misin",
  // English
  "resume",
  "continue",
  "pick up where",
  "keep going",
  "carry on",
  "pick it up",
];

/**
 * Weaker resume keywords (partial → 0.6). "continue", "sürdür" and "surdur"
 * are intentionally absent — they already match RESUME_DIRECT with 0.9
 * confidence, so duplicating them here would double-count hits and produce
 * dead paths (the direct check at `resumeDirectHits.length > 0` fires first).
 */
const RESUME_KEYWORDS: readonly string[] = [
  "devam",
];

/** Phrases implying "I changed the budget / limit" (direct match → 0.9). */
const BUDGET_DIRECT: readonly string[] = [
  // Turkish
  "bütçeyi arttırdım",
  "butceyi arttirdim",
  "bütçeyi güncelledim",
  "limiti arttırdım",
  "limiti yükselttim",
  "token limitini arttırdım",
  "token limitini yükselttim",
  "daha fazla token",
  // English
  "increased the budget",
  "increased budget",
  "raised the budget",
  "raised budget",
  "updated the limit",
  "updated limit",
  "raised the token",
  "raised tokens",
  "more tokens",
  "bigger budget",
];

/** Weaker budget-change hints (partial → 0.5 when combined with checkpoint). */
const BUDGET_KEYWORDS: readonly string[] = [
  "budget",
  "bütçe",
  "butce",
  "limit",
  "token",
  "tokens",
  "arttır",
  "arttir",
  "yükselt",
  "yukselt",
  "increase",
  "raise",
  "raised",
  "increased",
];

// Normalization

/** Lowercase, strip Turkish diacritics, collapse whitespace. */
function normalize(input: string): string {
  const lowered = input.toLowerCase();
  const stripped = lowered
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u");
  return stripped.replace(/\s+/g, " ").trim();
}

/** Also keep the original (lowercased) form so exact TR phrases still match. */
function lowered(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

// Matchers

function containsAny(haystack: string, needles: readonly string[]): string[] {
  const hits: string[] = [];
  for (const needle of needles) {
    if (!needle) continue;
    const n = needle.toLowerCase();
    if (haystack.includes(n) || haystack.includes(normalize(needle))) {
      hits.push(needle);
    }
  }
  return hits;
}

/**
 * Extract a token count from budget phrases. Only explicit markers
 * ("k"/"K" suffix, or bare digits immediately followed by "token"/"tok"/
 * "tk") count — otherwise an innocuous phrase like "I only have 1234
 * tokens left" or "fix the 2024 task" would match a bare 4-digit number
 * and silently downgrade the interactive budget via the implicit-
 * recovery NL path. The anchored form ("1234 tokens") is intentionally
 * kept because it is unambiguous.
 */
function extractTokenK(message: string): number | undefined {
  // "500k" / "500 k" / "500K tokens" / "500k tokens"
  const kMatch = message.match(/(\d+(?:[.,]\d+)?)\s*k\b/i);
  if (kMatch?.[1]) {
    const raw = parseFloat(kMatch[1].replace(",", "."));
    if (Number.isFinite(raw) && raw > 0) return raw;
  }
  // Bare digits are only accepted when immediately followed by an
  // explicit token anchor — prevents stray-number false positives.
  const tokenAnchored = message.match(/(\d[\d_,]{2,})\s*(?:token|tok|tk)\b/i);
  if (tokenAnchored?.[1]) {
    const raw = parseInt(tokenAnchored[1].replace(/[_,]/g, ""), 10);
    if (Number.isFinite(raw) && raw >= 1000) {
      return raw / 1000;
    }
  }
  return undefined;
}

// Public API

/**
 * Classify the user's message into a recovery intent.
 *
 * Precedence (strongest wins): update_budget > retry > resume > none.
 * A budget update implies the user fixed the underlying cause, so we
 * return update_budget even when "devam et" is also present — the
 * caller will typically raise the budget first, then retry.
 */
export function parseRecoveryIntent(ctx: IntentParseContext): RecoveryIntent {
  const raw = (ctx.message ?? "").trim();
  if (!raw) return { kind: "none", confidence: 0 };

  const low = lowered(raw);
  const norm = normalize(raw);

  const budgetDirectHits = [
    ...containsAny(low, BUDGET_DIRECT),
    ...containsAny(norm, BUDGET_DIRECT),
  ];
  const budgetKeywordHits = [
    ...containsAny(low, BUDGET_KEYWORDS),
    ...containsAny(norm, BUDGET_KEYWORDS),
  ];

  const retryDirectHits = [
    ...containsAny(low, RETRY_DIRECT),
    ...containsAny(norm, RETRY_DIRECT),
  ];
  const retryKeywordHits = [
    ...containsAny(low, RETRY_KEYWORDS),
    ...containsAny(norm, RETRY_KEYWORDS),
  ];

  const resumeDirectHits = [
    ...containsAny(low, RESUME_DIRECT),
    ...containsAny(norm, RESUME_DIRECT),
  ];
  const resumeKeywordHits = [
    ...containsAny(low, RESUME_KEYWORDS),
    ...containsAny(norm, RESUME_KEYWORDS),
  ];

  // 1. Budget-update intent (highest precedence)
  const tokenK = extractTokenK(low);
  if (budgetDirectHits.length > 0) {
    return {
      kind: "update_budget",
      confidence: 0.9,
      keywords: dedupe(budgetDirectHits),
      ...(tokenK !== undefined ? { tokenK } : {}),
    };
  }
  // Keyword + explicit number (e.g. "budget 500k") → strong signal even without full phrase.
  if (budgetKeywordHits.length > 0 && tokenK !== undefined) {
    return {
      kind: "update_budget",
      confidence: 0.8,
      keywords: dedupe(budgetKeywordHits),
      tokenK,
    };
  }
  // Contextual: pending budget_exceeded checkpoint + budget keyword → weak match.
  if (
    ctx.hasPendingCheckpoint &&
    ctx.lastCheckpointStage === "budget_exceeded" &&
    budgetKeywordHits.length > 0
  ) {
    return {
      kind: "update_budget",
      confidence: 0.5,
      keywords: dedupe(budgetKeywordHits),
      ...(tokenK !== undefined ? { tokenK } : {}),
    };
  }

  // 2. Retry intent
  if (retryDirectHits.length > 0) {
    return {
      kind: "retry",
      confidence: 0.9,
      keywords: dedupe(retryDirectHits),
    };
  }
  if (retryKeywordHits.length > 0) {
    // Plain "retry" without any context still reads as retry.
    const confidence = ctx.hasPendingCheckpoint ? 0.7 : 0.6;
    return {
      kind: "retry",
      confidence,
      keywords: dedupe(retryKeywordHits),
    };
  }

  // 3. Resume intent
  if (resumeDirectHits.length > 0) {
    return {
      kind: "resume",
      confidence: 0.9,
      keywords: dedupe(resumeDirectHits),
    };
  }
  if (resumeKeywordHits.length > 0 && ctx.hasPendingCheckpoint) {
    return {
      kind: "resume",
      confidence: 0.5,
      keywords: dedupe(resumeKeywordHits),
    };
  }

  return { kind: "none", confidence: 0 };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
