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
