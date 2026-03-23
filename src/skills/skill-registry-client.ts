// ---------------------------------------------------------------------------
// Remote skill registry client — fetches and caches the skill index from
// the strada-skill-registry GitHub repo.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLoggerSafe } from "../utils/logger.js";
import type { SkillRegistry, RegistryEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_URL =
  "https://raw.githubusercontent.com/okandemirel/strada-skill-registry/main/registry.json";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cachePath(): string {
  return join(homedir(), ".strada", "skill-registry.json");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the remote skill registry.
 *
 * - Returns cached data if the cache is less than 1 hour old (unless forceRefresh).
 * - On network failure, falls back to stale cache.
 * - Uses native `fetch()` (Node 18+).
 */
export async function fetchRegistry(forceRefresh = false): Promise<SkillRegistry> {
  const logger = getLoggerSafe();
  const cached = await readCache();

  // Return fresh cache if not forcing refresh
  if (!forceRefresh && cached && cached.age < CACHE_TTL_MS) {
    return cached.data;
  }

  // Attempt network fetch
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = (await response.json()) as SkillRegistry;

    // Validate minimal shape
    if (!data || typeof data.version !== "number" || !data.skills) {
      throw new Error("Invalid registry format");
    }

    // Write cache
    await writeCache(data);
    return data;
  } catch (err) {
    logger.warn("Failed to fetch skill registry", {
      error: err instanceof Error ? err.message : String(err),
    });

    // Fall back to stale cache
    if (cached) {
      logger.info("Using stale skill registry cache");
      return cached.data;
    }

    // No cache at all — return empty registry
    return { version: 0, skills: {} };
  }
}

/**
 * Search the registry by name or tag substring (case-insensitive).
 */
export function searchRegistry(
  registry: SkillRegistry,
  query: string,
): Array<[string, RegistryEntry]> {
  const q = query.toLowerCase();
  const results: Array<[string, RegistryEntry]> = [];

  for (const [name, entry] of Object.entries(registry.skills)) {
    const nameMatch = name.toLowerCase().includes(q);
    const descMatch = entry.description.toLowerCase().includes(q);
    const tagMatch = entry.tags.some((tag) => tag.toLowerCase().includes(q));

    if (nameMatch || descMatch || tagMatch) {
      results.push([name, entry]);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

interface CacheResult {
  data: SkillRegistry;
  age: number; // ms since last write
}

async function readCache(): Promise<CacheResult | null> {
  try {
    const path = cachePath();
    const [content, fileStat] = await Promise.all([
      readFile(path, "utf-8"),
      stat(path),
    ]);
    const data = JSON.parse(content) as SkillRegistry;
    const age = Date.now() - fileStat.mtimeMs;
    return { data, age };
  } catch {
    return null;
  }
}

async function writeCache(data: SkillRegistry): Promise<void> {
  try {
    const dir = join(homedir(), ".strada");
    await mkdir(dir, { recursive: true });
    await writeFile(cachePath(), JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    // Non-critical — cache write failure is silently ignored
  }
}
