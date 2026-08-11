import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "../../utils/logger.js";

export type ProviderSourceKind = "html" | "markdown" | "json" | "text";

export interface ProviderOfficialSource {
  readonly url: string;
  readonly label?: string;
  readonly kind?: ProviderSourceKind;
}

export interface ProviderSourceRegistry {
  readonly version: number;
  readonly providers: Record<string, ProviderOfficialSource[]>;
}

/**
 * Repo-relative location of the registry file, kept for config defaults and
 * documentation. NOT used to resolve the file at runtime — see
 * {@link resolveDefaultRegistryPath}.
 */
export const DEFAULT_PROVIDER_SOURCE_REGISTRY_PATH = "src/agents/providers/provider-sources.json";

/**
 * Resolve the shipped registry next to THIS module rather than the process
 * cwd.
 *
 * The old default was the cwd-relative string above, so a packaged install
 * looked for `<user's Unity project>/src/agents/providers/provider-sources.json`
 * — a path that exists only in a source checkout. It never threw: the loader
 * warned and returned an empty registry, silently disabling provider
 * official-source enrichment for every installed user.
 *
 * Module-relative works in both layouts: `src/agents/providers/` when running
 * from source via tsx, `dist/agents/providers/` when running the built CLI
 * (the build copies non-TS assets into dist).
 */
export function resolveDefaultRegistryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "provider-sources.json");
}

export interface ProviderOfficialSignal {
  readonly kind: "command" | "feature" | "model";
  readonly title: string;
  readonly value: string;
  readonly url: string;
  readonly sourceLabel: string;
  readonly tags: string[];
}

export interface ProviderOfficialSnapshot {
  readonly provider: string;
  readonly lastUpdated: number;
  readonly sourceUrls: string[];
  readonly signals: ProviderOfficialSignal[];
  readonly featureTags: string[];
}

const SIGNAL_LINE_KEYWORDS = [
  /\b(agent|swarm|multi-agent)\b|智能体/iu,
  /\btool(?:\s|-)?(calling|use)\b|\bfunction(?:\s|-)?calling\b|工具调用/iu,
  /\bjson(?:\s|-)?schema\b|\bjson(?:\s|-)?mode\b|\bstructured outputs?\b|结构化输出/iu,
  /\bmcp\b|\bmodel context protocol\b/iu,
  /\bplan\b|规划/iu,
  /\bloop\b|循环/iu,
  /\bhooks?\b/iu,
  /\breason(?:ing)?\b|\bthink(?:ing)?\b|推理|思考/iu,
  /\bsearch\b|\bgrounding\b|搜索/iu,
  /\bvision\b|\bmultimodal\b|视觉|多模态/iu,
  /\baudio\b|\bvideo\b|音频|视频/iu,
  /\bcoding?\b|\bcode execution\b|编码|代码执行/iu,
  /\bstream(?:ing)?\b|流式输出|流式/iu,
  /\bcache|caching\b|缓存/iu,
  /\bbrowser use\b|\bcomputer use\b/iu,
];

const FEATURE_TAG_PATTERNS: Array<{ readonly tag: string; readonly pattern: RegExp }> = [
  { tag: "agents", pattern: /\b(agent|swarm|multi-agent)\b|智能体/iu },
  { tag: "tool-calling", pattern: /\btool(?:\s|-)?(calling|use)\b|\bfunction(?:\s|-)?calling\b|工具调用/iu },
  { tag: "structured-output", pattern: /\bjson(?:\s|-)?(schema|mode)\b|\bstructured outputs?\b|结构化输出/iu },
  { tag: "mcp", pattern: /\bmcp\b|\bmodel context protocol\b/iu },
  { tag: "planning", pattern: /\bplan\b|规划/iu },
  { tag: "loop", pattern: /\bloop\b|循环/iu },
  { tag: "hooks", pattern: /\bhooks?\b/iu },
  { tag: "reasoning", pattern: /\breason(?:ing)?\b|\bthink(?:ing)?\b|推理|思考/iu },
  { tag: "search", pattern: /\bsearch\b|\bgrounding\b|搜索/iu },
  { tag: "multimodal", pattern: /\bvision\b|\bmultimodal\b|\baudio\b|\bvideo\b|视觉|多模态|音频|视频/iu },
  { tag: "coding", pattern: /\bcoding?\b|\bcode execution\b|编码|代码执行/iu },
  { tag: "streaming", pattern: /\bstream(?:ing)?\b|流式输出|流式/iu },
  { tag: "caching", pattern: /\bcache|caching\b|缓存/iu },
  { tag: "computer-use", pattern: /\bbrowser use\b|\bcomputer use\b/iu },
];

const COMMAND_RE = /(^|\s)(\/[a-z][a-z0-9-]{1,32})(?=\s|$)/gimu;
const MODEL_RE = /\b(?:gpt|gemini|claude|kimi|qwen|deepseek|mistral|llama|minimax|o1|o3|o4|opus|sonnet|haiku)[a-z0-9./-]{1,64}\b/giu;

function inferProviderFromModelId(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes("claude") || id.includes("opus") || id.includes("sonnet") || id.includes("haiku")) return "claude";
  if (id.includes("gpt") || id.includes("openai") || id.includes("o1") || id.includes("o3") || id.includes("o4")) return "openai";
  if (id.includes("gemini")) return "gemini";
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("qwen")) return "qwen";
  if (id.includes("kimi") || id.includes("moonshot")) return "kimi";
  if (id.includes("mistral") || id.includes("codestral") || id.includes("pixtral")) return "mistral";
  if (id.includes("groq")) return "groq";
  if (id.includes("minimax")) return "minimax";
  if (id.includes("together")) return "together";
  if (id.includes("fireworks")) return "fireworks";
  if (id.includes("ollama") || id.includes("llama")) return "ollama";
  return "unknown";
}

function sanitizeText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeSourceText(kind: ProviderSourceKind | undefined, content: string): string {
  if (kind === "html") {
    return sanitizeText(content);
  }
  if (kind === "json") {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return content;
    }
  }
  return sanitizeText(content);
}

function getFeatureTags(text: string): string[] {
  const tags: string[] = [];
  for (const { tag, pattern } of FEATURE_TAG_PATTERNS) {
    if (pattern.test(text)) {
      tags.push(tag);
    }
  }
  return [...new Set(tags)];
}

function shouldKeepFeatureLine(line: string): boolean {
  if (line.length < 18 || line.length > 180) {
    return false;
  }
  if (line.startsWith("{") || line.startsWith("[") || line.includes("\"object\"")) {
    return false;
  }
  return SIGNAL_LINE_KEYWORDS.some((pattern) => pattern.test(line));
}

function dedupeSignals(signals: ProviderOfficialSignal[], limit: number): ProviderOfficialSignal[] {
  const unique = new Map<string, ProviderOfficialSignal>();
  for (const signal of signals) {
    const key = `${signal.kind}:${signal.value.toLowerCase()}`;
    if (!unique.has(key)) {
      unique.set(key, signal);
    }
  }
  return [...unique.values()].slice(0, limit);
}

export function extractProviderOfficialSignals(
  provider: string,
  source: ProviderOfficialSource,
  content: string,
): ProviderOfficialSignal[] {
  const normalized = normalizeSourceText(source.kind, content);
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const signals: ProviderOfficialSignal[] = [];
  const sourceLabel = source.label ?? source.url;

  for (const match of normalized.matchAll(COMMAND_RE)) {
    const value = match[2]?.trim();
    if (!value) continue;
    signals.push({
      kind: "command",
      title: `Slash command ${value}`,
      value,
      url: source.url,
      sourceLabel,
      tags: ["slash-command", value.slice(1)],
    });
  }

  for (const line of lines) {
    if (!shouldKeepFeatureLine(line)) {
      continue;
    }
    const tags = getFeatureTags(line);
    if (tags.length === 0) {
      continue;
    }
    signals.push({
      kind: "feature",
      title: line,
      value: line.toLowerCase(),
      url: source.url,
      sourceLabel,
      tags,
    });
  }

  for (const match of normalized.matchAll(MODEL_RE)) {
    const value = match[0]?.trim();
    if (!value) continue;
    if (inferProviderFromModelId(value) !== provider.toLowerCase()) {
      continue;
    }
    signals.push({
      kind: "model",
      title: `Model ${value}`,
      value,
      url: source.url,
      sourceLabel,
      tags: ["model"],
    });
  }

  return dedupeSignals(signals, 16);
}

function isProviderSource(value: unknown): value is ProviderOfficialSource {
  return !!value
    && typeof value === "object"
    && typeof (value as ProviderOfficialSource).url === "string"
    && ((value as ProviderOfficialSource).kind === undefined
      || ["html", "markdown", "json", "text"].includes((value as ProviderOfficialSource).kind as string));
}

export function loadProviderSourceRegistry(registryPath?: string): ProviderSourceRegistry {
  const logger = getLogger();
  // An explicit path is the operator's, so it stays cwd-relative. With no
  // path — or with the legacy repo-relative default that a stale config may
  // still carry — resolve the copy that ships beside this module, falling back
  // to cwd only if that is somehow absent.
  const usingDefault =
    registryPath === undefined || registryPath === DEFAULT_PROVIDER_SOURCE_REGISTRY_PATH;
  let resolvedPath: string;
  if (usingDefault) {
    const beside = resolveDefaultRegistryPath();
    resolvedPath = existsSync(beside)
      ? beside
      : resolve(process.cwd(), DEFAULT_PROVIDER_SOURCE_REGISTRY_PATH);
  } else {
    resolvedPath = resolve(process.cwd(), registryPath);
  }
  if (!existsSync(resolvedPath)) {
    logger.warn("Provider source registry file not found", { registryPath: resolvedPath });
    return { version: 1, providers: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as Partial<ProviderSourceRegistry>;
    const providers: Record<string, ProviderOfficialSource[]> = {};
    for (const [provider, sources] of Object.entries(parsed.providers ?? {})) {
      const validSources = Array.isArray(sources) ? sources.filter(isProviderSource) : [];
      if (validSources.length > 0) {
        providers[provider.toLowerCase()] = validSources.map((source) => ({
          url: source.url,
          label: source.label,
          kind: source.kind ?? "html",
        }));
      }
    }
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      providers,
    };
  } catch (error) {
    logger.warn("Failed to load provider source registry", {
      registryPath: resolvedPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { version: 1, providers: {} };
  }
}
