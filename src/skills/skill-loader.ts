// ---------------------------------------------------------------------------
// 3-tier skill discovery and ESM tool loading.
//
// Scan order (higher precedence first):
//   1. workspace  — <projectRoot>/skills/
//   2. managed    — ~/.strada/skills/
//   3. bundled    — src/skills/bundled/ (relative to this package)
//   4. extra      — any additional directories passed in
// ---------------------------------------------------------------------------

import { readdir, readFile, stat, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { parseFrontmatter } from "./frontmatter-parser.js";
import { getLoggerSafe } from "../utils/logger.js";
import type { SkillManifest, SkillEntry } from "./types.js";
import type { ITool } from "../agents/tools/tool.interface.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiscoveredSkill {
  manifest: SkillManifest;
  tier: SkillEntry["tier"];
  path: string;
  /** Markdown body content from SKILL.md (below frontmatter). */
  body?: string;
}

// ---------------------------------------------------------------------------
// Tier directories
// ---------------------------------------------------------------------------

const TIERS: Array<{ tier: SkillEntry["tier"]; dir: (projectRoot?: string) => string | null }> = [
  {
    tier: "workspace",
    dir: (projectRoot) => (projectRoot ? join(projectRoot, "skills") : null),
  },
  {
    tier: "managed",
    dir: () => join(homedir(), ".strada", "skills"),
  },
  {
    tier: "bundled",
    dir: () => join(dirname(fileURLToPath(import.meta.url)), "bundled"),
  },
];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover skills across all tiers.
 *
 * Scans workspace, managed, bundled, and extra directories (in that order).
 * Within each directory, looks for `<skill>/SKILL.md` files. Parses
 * frontmatter and validates required fields (`name`, `version`, `description`).
 *
 * When the same skill name appears in multiple tiers, the higher-precedence
 * tier (earlier in scan order) wins.
 */
export async function discoverSkills(
  projectRoot?: string,
  extraDirs?: string[],
): Promise<DiscoveredSkill[]> {
  const logger = getLoggerSafe();
  const byName = new Map<string, DiscoveredSkill>();

  // Build the list of (tier, directory) pairs to scan
  const scanList: Array<{ tier: SkillEntry["tier"]; dir: string }> = [];

  for (const t of TIERS) {
    const d = t.dir(projectRoot);
    if (d) scanList.push({ tier: t.tier, dir: d });
  }

  if (extraDirs) {
    for (const d of extraDirs) {
      scanList.push({ tier: "extra", dir: d });
    }
  }

  for (const { tier, dir } of scanList) {
    let entries: string[];
    try {
      const dirStat = await stat(dir);
      if (!dirStat.isDirectory()) continue;
      entries = (await readdir(dir)).filter(Boolean);
    } catch {
      // Directory does not exist or is inaccessible — skip
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(dir, entry);
      try {
        const skillStat = await lstat(skillDir);
        if (skillStat.isSymbolicLink() || !skillStat.isDirectory()) continue;

        const skillMdPath = join(skillDir, "SKILL.md");
        let raw: string;
        try {
          raw = await readFile(skillMdPath, "utf-8");
        } catch {
          // No SKILL.md — not a skill
          continue;
        }

        const { data, content: bodyContent } = parseFrontmatter(raw);
        const name = data["name"];
        const version = data["version"];
        const description = data["description"];

        if (typeof name !== "string" || !name) {
          logger.warn(`Skipping skill at ${skillDir}: missing or invalid "name" in SKILL.md`);
          continue;
        }
        if (typeof version !== "string" || !version) {
          logger.warn(`Skipping skill at ${skillDir}: missing or invalid "version" in SKILL.md`);
          continue;
        }
        if (typeof description !== "string" || !description) {
          logger.warn(`Skipping skill at ${skillDir}: missing or invalid "description" in SKILL.md`);
          continue;
        }

        // Higher-precedence tier wins: only insert if not already seen
        if (byName.has(name)) {
          logger.debug(`Skill "${name}" already discovered from higher-precedence tier; skipping ${tier} at ${skillDir}`);
          continue;
        }

        const manifest: SkillManifest = {
          name,
          version: String(version),
          description: String(description),
          ...(typeof data["author"] === "string" ? { author: data["author"] } : {}),
          ...(typeof data["homepage"] === "string" ? { homepage: data["homepage"] } : {}),
          ...(data["requires"] && typeof data["requires"] === "object"
            ? { requires: data["requires"] as SkillManifest["requires"] }
            : {}),
          ...(Array.isArray(data["capabilities"])
            ? { capabilities: data["capabilities"] as string[] }
            : {}),
        };

        const trimmedBody = bodyContent?.trim();
        byName.set(name, { manifest, tier, path: skillDir, ...(trimmedBody ? { body: trimmedBody } : {}) });
      } catch (err) {
        logger.warn(`Error scanning skill directory ${skillDir}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Tool loading
// ---------------------------------------------------------------------------

/** Import nonce counter to bust ESM module cache. */
let importNonce = 0;

/**
 * Load tools from a discovered skill.
 *
 * Looks for `index.ts` or `index.js` as the entry point, performs a dynamic
 * ESM import with a nonce query parameter (to avoid stale cache), extracts
 * the `tools` array, and namespaces each tool as `skill_{name}_{toolName}`.
 */
export async function loadSkillTools(skill: DiscoveredSkill): Promise<ITool[]> {
  const logger = getLoggerSafe();

  // Resolve entry point
  const entryPath = await resolveEntryPoint(skill.path);
  if (!entryPath) {
    logger.warn(`Skill "${skill.manifest.name}" has no entry point (index.ts/index.js)`);
    return [];
  }

  // Dynamic ESM import with nonce to bust cache
  const entryUrl = pathToFileURL(entryPath);
  entryUrl.searchParams.set("nonce", String(++importNonce));
  const mod = (await import(entryUrl.href)) as Record<string, unknown>;

  // Extract tools array from module
  let tools: ITool[];
  if (Array.isArray(mod["default"])) {
    tools = mod["default"] as ITool[];
  } else if (Array.isArray(mod["tools"])) {
    tools = mod["tools"] as ITool[];
  } else {
    logger.warn(`Skill "${skill.manifest.name}" does not export a tools array`);
    return [];
  }

  // Namespace and tag each tool
  const seen = new Set<string>();
  const namespacedTools: ITool[] = [];

  for (const tool of tools) {
    const nsName = `skill_${skill.manifest.name}_${tool.name}`;
    if (seen.has(nsName)) {
      logger.warn(`Skill "${skill.manifest.name}": duplicate tool name "${tool.name}" — skipping`);
      continue;
    }
    seen.add(nsName);

    namespacedTools.push({
      ...tool,
      name: nsName,
      execute: tool.execute.bind(tool),
      isPlugin: true,
    });
  }

  return namespacedTools;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveEntryPoint(skillDir: string): Promise<string | null> {
  for (const filename of ["index.ts", "index.js"]) {
    const candidate = join(skillDir, filename);
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // File does not exist
    }
  }
  return null;
}
