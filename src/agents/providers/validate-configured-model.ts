/**
 * Pure validator for a provider's CONFIGURED model id against the provider's
 * LIVE model catalog (the ids returned by the dynamic ProviderModelCatalog
 * after its boot-time refresh).
 *
 * Phase 3 of the dynamic-model-catalog feature. This is a WARN-ONLY guard: it
 * tells the boot path whether a configured model is still offered and, if not,
 * suggests a sensible live fallback. It NEVER mutates runtime config or the
 * running model — the caller logs a warning only.
 */

import { toBareModelId } from "./provider-identity.js";

export interface ModelValidationResult {
  ok: boolean;
  /** A suggested live fallback model id when not ok. */
  corrected?: string;
  /** Human-readable explanation when not ok. */
  reason?: string;
}

/** Tokenize a model id on non-alphanumeric boundaries, lowercased. */
function tokenize(modelId: string): string[] {
  return modelId
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0);
}

/** Length of the longest common token PREFIX of two tokenized model ids. */
function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length);
  let shared = 0;
  for (let i = 0; i < max; i += 1) {
    if (a[i] !== b[i]) {
      break;
    }
    shared += 1;
  }
  return shared;
}

/**
 * Pick a deterministic live fallback for a stale configured model.
 *
 * Heuristic (simple + deterministic): prefer the live id that shares the
 * longest leading token prefix with the configured id — this captures both the
 * `provider/` prefix (e.g. `opencode/...`) and the model family/version base
 * (e.g. `gpt-5...`). Ties break toward the earliest live id (stable).
 * If nothing shares any prefix, fall back to the first live id.
 *
 * Assumes `liveModelIds` is non-empty (callers handle the empty case).
 */
function suggestFallback(configuredModel: string, liveModelIds: readonly string[]): string {
  const configuredTokens = tokenize(configuredModel);
  let best = liveModelIds[0]!;
  let bestScore = sharedPrefixLength(configuredTokens, tokenize(best));
  for (let i = 1; i < liveModelIds.length; i += 1) {
    const candidate = liveModelIds[i]!;
    const score = sharedPrefixLength(configuredTokens, tokenize(candidate));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function validateConfiguredModel(
  provider: string,
  configuredModel: string,
  liveModelIds: readonly string[],
): ModelValidationResult {
  // Discovery failed/unavailable — we cannot validate, so do not block or warn.
  if (liveModelIds.length === 0) {
    return { ok: true };
  }

  // Compare BARE-vs-BARE so a namespaced configured id (e.g. `opencode/qwen3.6-plus`)
  // matches a bare live-catalog id (`qwen3.6-plus`) and vice versa. Providers such as
  // OpenCode expose bare runtime ids while config/preferences store the namespaced
  // form; a strict `includes` would emit a bogus "not offered" warning + wrong
  // correction. An exact match still short-circuits first (cheapest, and preserves the
  // configured id when both sides are already namespaced).
  if (liveModelIds.includes(configuredModel)) {
    return { ok: true };
  }
  const configuredBare = toBareModelId(configuredModel);
  if (liveModelIds.some((id) => toBareModelId(id) === configuredBare)) {
    return { ok: true };
  }

  const corrected = suggestFallback(configuredModel, liveModelIds);
  const reason =
    `Provider '${provider}' is configured with model '${configuredModel}', ` +
    `which is not in the provider's current live model list. ` +
    `It may fail silently at runtime; consider '${corrected}'.`;
  return { ok: false, corrected, reason };
}
