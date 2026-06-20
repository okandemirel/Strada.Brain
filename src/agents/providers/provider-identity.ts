import { PROVIDER_PRESETS } from "./provider-registry.js";

const DIRECT_PROVIDER_ALIASES = new Map<string, string>([
  ["anthropic claude", "claude"],
  ["ollama local", "ollama"],
  ["qwen alibaba", "qwen"],
  ["kimi moonshot", "kimi"],
  ["google gemini", "gemini"],
  ["together ai", "together"],
  ["fireworks ai", "fireworks"],
  ["moonshot", "kimi"],
]);

const CANONICAL_PROVIDER_NAMES = new Set<string>([
  "claude",
  "anthropic",
  "ollama",
  ...Object.keys(PROVIDER_PRESETS),
]);

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

function simplifyProviderKey(value: string): string {
  return normalizeProviderKey(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Strip a single leading `provider/` namespace from a model id, returning the
 * BARE id. Several providers (notably OpenCode) expose bare runtime ids
 * (`qwen3.6-plus`) while the catalog/preferences store the namespaced form
 * (`opencode/qwen3.6-plus`). Comparing the two with strict equality silently
 * mismatches; normalize BOTH sides through this helper first.
 *
 * Only the first `/`-delimited segment is removed (`a/b/c` → `b/c`) so model
 * ids that legitimately contain slashes keep their remaining path. A blank or
 * undefined input is returned unchanged.
 */
export function toBareModelId(model: string | null | undefined): string {
  if (!model) {
    return "";
  }
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export function canonicalizeProviderName(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeProviderKey(value);
  if (!normalized) {
    return undefined;
  }
  if (CANONICAL_PROVIDER_NAMES.has(normalized)) {
    return normalized;
  }

  const simplified = simplifyProviderKey(value);
  if (DIRECT_PROVIDER_ALIASES.has(simplified)) {
    return DIRECT_PROVIDER_ALIASES.get(simplified);
  }

  for (const canonicalName of CANONICAL_PROVIDER_NAMES) {
    if (simplifyProviderKey(canonicalName) === simplified) {
      return canonicalName;
    }
  }

  for (const [canonicalName, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (simplifyProviderKey(preset.label) === simplified) {
      return canonicalName;
    }
  }

  return normalized;
}
