// ---------------------------------------------------------------------------
// SkillManager — lifecycle wrapper around PluginRegistry for skills.
//
// Coordinates discovery, gating, env injection, tool loading, and
// registration into the PluginRegistry with correct ordering.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PluginRegistry,
  dependencyListProblem,
  partitionDependencyGraph,
  type Plugin,
  type PluginMetadata,
} from "../plugins/registry.js";
import { SkillEnvInjector } from "./skill-env-injector.js";
import { parseFrontmatter } from "./frontmatter-parser.js";
import { discoverSkills, loadSkillTools, type DiscoveredSkill } from "./skill-loader.js";
import { checkGates } from "./skill-gating.js";
import { readSkillConfig } from "./skill-config.js";
import { assessWorkspaceSkillTrust } from "./skill-trust.js";
import { getLoggerSafe } from "../utils/logger.js";
import type { SkillEntry, SkillRequirements, SkillStatus } from "./types.js";
import type { ITool } from "../agents/tools/tool.interface.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class SkillManager {
  private readonly registry = new PluginRegistry();
  private readonly envInjector = new SkillEnvInjector();
  private readonly entries = new Map<string, SkillEntry>();
  private entriesCache: SkillEntry[] | null = null;

  /** Callback to register tools into the app-level ToolRegistry. */
  private toolRegistrar?: (tools: ITool[]) => void;
  /** Callback to remove tools by name from the app-level ToolRegistry. */
  private toolRemover?: (toolNames: string[]) => void;
  /** App-level config that `requires.config` dot-paths are resolved against. */
  private appConfig?: Record<string, unknown>;

  /**
   * Provide the app-level Config so `requires.config` gates can actually be
   * measured. audited 2026-09-02: before this existed, no caller could supply
   * a config, so every skill declaring `requires.config` was gated forever
   * with "Required config key missing" — a verdict nothing had checked.
   */
  setAppConfig(config: Record<string, unknown> | undefined): void {
    this.appConfig = config;
  }

  /**
   * Wire the SkillManager to the application's ToolRegistry.
   * Called once during bootstrap before `loadAll`.
   */
  setToolRegistrar(
    registrar: (tools: ITool[]) => void,
    remover: (toolNames: string[]) => void,
  ): void {
    this.toolRegistrar = registrar;
    this.toolRemover = remover;
  }

  /**
   * Discover, gate-check, load, and register all skills.
   *
   * Flow (plan 0-B.2 / 4.9 / 1.15 — one lifecycle contract):
   *  1. Read user config (~/.strada/skills.json)
   *  2. Discover skills across tiers
   *  3. Per skill: disabled? → inject env (BEFORE the gate, 4.9) → checkGates
   *     → workspace trust (1.15). A skill that fails here is parked
   *     (disabled / gated / untrusted) and its env is rolled back.
   *  4. Preflight the WHOLE `requires.skills` graph over the survivors (0-B.2):
   *     a skill whose dependency is missing, parked, or cyclic — and every
   *     skill that transitively depends on it — is gated with the reason.
   *     Order-independent: nothing has been registered yet.
   *  5. Load tools and register the resolvable skills as plugins.
   *  6. initializeAll() (never aborts the batch — see PluginRegistry).
   *  7. "active" is assigned only to a skill whose initialize() succeeded; a
   *     failed initialize() is "error" with the reason. Env of every skill
   *     that did not end active is restored.
   */
  async loadAll(projectRoot?: string, extraDirs?: string[]): Promise<SkillEntry[]> {
    const logger = getLoggerSafe();
    const config = await readSkillConfig();
    const discovered = await discoverSkills(projectRoot, extraDirs);

    /** Parked: not going to be registered. Restores env, records the entry. */
    const park = (skill: DiscoveredSkill, status: Exclude<SkillStatus, "active">, reason?: string): void => {
      const { name } = skill.manifest;
      this.envInjector.restore(name);
      this.entries.set(name, {
        manifest: skill.manifest,
        status,
        tier: skill.tier,
        path: skill.path,
        ...(reason ? { gateReason: reason } : {}),
      });
    };

    // --- 3. per-skill checks --------------------------------------------
    const candidates = new Map<string, { skill: DiscoveredSkill; unevaluated?: string }>();
    for (const skill of discovered) {
      const { name } = skill.manifest;
      try {
        if (config.entries[name]?.enabled === false) {
          park(skill, "disabled");
          logger.debug(`Skill "${name}" is disabled by user config`);
          continue;
        }

        // Codex round 6 #10: a manifest whose `requires.skills` is not an
        // array (YAML `skills: missing` is a scalar) is parked on its own with
        // the reason; it used to make the graph preflight throw for everyone.
        const skillsProblem = dependencyListProblem(skill.manifest.requires?.skills);
        if (skillsProblem) {
          const reason = `requires.skills must be an array of skill names (${skillsProblem})`;
          park(skill, "gated", reason);
          logger.warn(`Skill "${name}" gated: ${reason}`);
          continue;
        }

        // 4.9: env overrides from the user config are injected BEFORE the
        // gate, so a gate that reads a variable the user configured for this
        // very skill can pass. Rolled back by park() if the skill does not
        // make it.
        const envOverrides = config.entries[name]?.env;
        if (envOverrides && Object.keys(envOverrides).length > 0) {
          this.envInjector.inject(name, envOverrides);
        }

        // Gate check against the app-level Config (via setAppConfig) — NOT the
        // per-skill SkillConfig, which holds enabled/env entries, not the key
        // paths checkGates resolves. When no app config was provided the config
        // gate is reported unevaluated, not failed (see skill-gating.ts).
        // `requires.skills` is measured by the graph preflight below, so it is
        // not handed to checkGates (which would only report it unevaluated).
        const gateResult = await checkGates(withoutSkillsGate(skill.manifest.requires), this.appConfig);
        if (!gateResult.passed) {
          park(skill, "gated", gateResult.reasons.join("; "));
          logger.info(`Skill "${name}" gated: ${gateResult.reasons.join(", ")}`);
          continue;
        }

        // 1.15: a workspace-tier skill executes code from the project
        // checkout. Without an approval record outside the project it is not
        // imported at all.
        if (skill.tier === "workspace") {
          const trust = await assessWorkspaceSkillTrust(projectRoot ?? dirname(dirname(skill.path)), skill.path, name);
          if (!trust.trusted) {
            park(skill, "untrusted", trust.reason);
            logger.warn(`Skill "${name}" untrusted: ${trust.reason}`);
            continue;
          }
        }

        const unevaluated = gateResult.unevaluated?.length ? gateResult.unevaluated.join("; ") : undefined;
        candidates.set(name, { skill, ...(unevaluated ? { unevaluated } : {}) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        park(skill, "error", `Unexpected error: ${message}`);
        logger.warn(`Skill "${name}" registration failed`, { error: message });
      }
    }

    // --- 4. dependency-graph preflight (0-B.2) --------------------------
    const graph = new Map<string, readonly string[]>();
    for (const [name, { skill }] of candidates) graph.set(name, skill.manifest.requires?.skills ?? []);
    const { order, unresolvable } = partitionDependencyGraph(graph);
    const explain = dependencyFailureExplainer(unresolvable, graph, this.entries);
    for (const name of unresolvable.keys()) {
      const candidate = candidates.get(name)!;
      const explained = explain(name);
      park(candidate.skill, "gated", explained);
      logger.info(`Skill "${name}" gated: ${explained}`);
    }

    // --- 5. load + register the resolvable skills -----------------------
    const registered = new Map<string, { skill: DiscoveredSkill; unevaluated?: string }>();
    for (const name of order) {
      const candidate = candidates.get(name)!;
      const { skill } = candidate;
      try {
        let tools: ITool[];
        try {
          tools = await loadSkillTools(skill);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          park(skill, "error", `Tool loading failed: ${message}`);
          logger.warn(`Skill "${name}" tool loading failed`, { error: message });
          continue;
        }
        this.registry.register(createSkillPlugin(skill, tools, this.toolRegistrar));
        registered.set(name, candidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        park(skill, "error", `Unexpected error: ${message}`);
        logger.warn(`Skill "${name}" registration failed`, { error: message });
      }
    }

    // --- 6. initialize (never aborts the batch) --------------------------
    try {
      await this.registry.initializeAll();
    } catch (err) {
      logger.warn("SkillManager: some skills failed during initialization", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // --- 7. "active" only after initialize() succeeded ------------------
    for (const [name, { skill, unevaluated }] of registered) {
      if (!this.registry.isInitialized(name)) {
        const reason = `Initialization failed: ${this.registry.getInitializationError(name) ?? "unknown"}`;
        park(skill, "error", reason);
        logger.warn(`Skill "${name}" ${reason}`);
        continue;
      }
      // A gate that could not be measured must stay visible on the active
      // entry — a skipped check must never read like a passed one.
      if (unevaluated) {
        logger.info(`Skill "${name}" activated with an unevaluated gate: ${unevaluated}`);
      }
      this.entries.set(name, {
        manifest: skill.manifest,
        status: "active",
        tier: skill.tier,
        path: skill.path,
        ...(unevaluated ? { gateReason: unevaluated } : {}),
        ...(skill.body ? { body: skill.body } : {}),
      });
    }

    const count = (status: SkillStatus): number =>
      [...this.entries.values()].filter((e) => e.status === status).length;
    logger.info(`SkillManager loaded ${this.entries.size} skill(s)`, {
      active: count("active"),
      disabled: count("disabled"),
      gated: count("gated"),
      untrusted: count("untrusted"),
      error: count("error"),
    });

    this.entriesCache = null;
    return [...this.entries.values()];
  }

  /**
   * Hot-load a single skill from its directory path.
   * Used by create_skill to make newly created skills available in the current session.
   */
  async loadSingle(skillPath: string): Promise<SkillEntry | null> {
    const logger = getLoggerSafe();

    const skillMdPath = join(skillPath, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillMdPath, "utf-8");
    } catch {
      logger.warn(`loadSingle: no SKILL.md at ${skillPath}`);
      return null;
    }

    const { data, content: bodyContent } = parseFrontmatter(raw);
    const name = data["name"] as string | undefined;
    if (!name) {
      logger.warn(`loadSingle: missing name in ${skillMdPath}`);
      return null;
    }

    // Skip if already loaded
    const existing = this.entries.get(name);
    if (existing) {
      logger.debug(`loadSingle: skill "${name}" already loaded, skipping`);
      return existing;
    }

    // Build a DiscoveredSkill and load tools
    const manifest = {
      name,
      version: String(data["version"] ?? "1.0.0"),
      description: String(data["description"] ?? ""),
      ...(typeof data["author"] === "string" ? { author: data["author"] } : {}),
      ...(Array.isArray(data["capabilities"])
        ? { capabilities: data["capabilities"] as string[] }
        : {}),
      // Selection metadata (skill-knowledge-selection reads it). The boot
      // loader carried these; the hot-load path dropped them, so a skill
      // created mid-session with `inject: always` was withheld from every
      // prompt until the next boot (Codex review 2026-09-09).
      ...(data["inject"] === "always" || data["inject"] === "on-mention" ? { inject: data["inject"] } : {}),
      ...(Array.isArray(data["triggers"])
        ? { triggers: (data["triggers"] as unknown[]).filter((t): t is string => typeof t === "string") }
        : {}),
    };

    const requires = data["requires"] && typeof data["requires"] === "object"
      ? data["requires"] as Parameters<typeof checkGates>[0]
      : undefined;
    const gateResult = await checkGates(requires, this.appConfig);
    if (!gateResult.passed) {
      const entry: SkillEntry = {
        manifest: manifest as SkillEntry["manifest"],
        status: "gated",
        tier: "workspace",
        path: skillPath,
        gateReason: gateResult.reasons.join("; "),
      };
      this.entries.set(name, entry);
      return entry;
    }

    // 1.15: the hot-load path imports workspace code exactly like loadAll
    // does, so it needs the same approval. The project root is the parent of
    // the skills directory (`<root>/skills/<name>`), which is the only layout
    // this tier has.
    const trust = await assessWorkspaceSkillTrust(dirname(dirname(skillPath)), skillPath, name);
    if (!trust.trusted) {
      const entry: SkillEntry = {
        manifest: manifest as SkillEntry["manifest"],
        status: "untrusted",
        tier: "workspace",
        path: skillPath,
        gateReason: trust.reason,
      };
      this.entries.set(name, entry);
      this.entriesCache = null;
      logger.warn(`Skill "${name}" untrusted: ${trust.reason}`);
      return entry;
    }

    let tools: ITool[];
    try {
      tools = await loadSkillTools({
        manifest: manifest as SkillEntry["manifest"],
        tier: "workspace",
        path: skillPath,
      });
    } catch (err) {
      const entry: SkillEntry = {
        manifest: manifest as SkillEntry["manifest"],
        status: "error",
        tier: "workspace",
        path: skillPath,
        gateReason: `Tool loading failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      this.entries.set(name, entry);
      return entry;
    }

    // Register tools immediately
    if (this.toolRegistrar && tools.length > 0) {
      this.toolRegistrar(tools);
    }

    const trimmedBody = bodyContent?.trim();
    const status: SkillEntry["status"] = (tools.length > 0 || trimmedBody) ? "active" : "incomplete";
    const unevaluatedGate = gateResult.unevaluated?.length ? gateResult.unevaluated.join("; ") : undefined;
    const entry: SkillEntry = {
      manifest: manifest as SkillEntry["manifest"],
      status,
      tier: "workspace",
      path: skillPath,
      ...(tools.length === 0 && !trimmedBody
        ? { gateReason: "No entry point (index.ts/index.js) — skill has no tools or knowledge" }
        : unevaluatedGate ? { gateReason: unevaluatedGate } : {}),
      ...(trimmedBody ? { body: trimmedBody } : {}),
    };
    this.entries.set(name, entry);
    this.entriesCache = null;
    if (tools.length > 0) {
      logger.info(`Hot-loaded skill "${name}" with ${tools.length} tool(s)`);
    } else {
      logger.warn(`Skill "${name}" loaded without tools — missing entry point`);
    }
    return entry;
  }

  /** Return all loaded skill entries (cached — invalidated on load/dispose). */
  getEntries(): readonly SkillEntry[] {
    if (!this.entriesCache) {
      this.entriesCache = [...this.entries.values()];
    }
    return this.entriesCache;
  }

  /** Dispose all skills, restore env, and clear state. */
  async dispose(): Promise<void> {
    // Collect tool names from active skills for removal
    const toolNames: string[] = [];
    for (const plugin of this.registry.getAll()) {
      const skillTools = (plugin as SkillPluginAdapter).getToolNames?.() ?? [];
      toolNames.push(...skillTools);
    }

    if (this.toolRemover && toolNames.length > 0) {
      this.toolRemover(toolNames);
    }

    // Dispose all plugins via registry (reverse dep order)
    await this.registry.disposeAll();

    // Restore env for all skills that had env injected
    for (const name of this.entries.keys()) {
      if (this.envInjector.hasSnapshot(name)) {
        this.envInjector.restore(name);
      }
    }

    this.entries.clear();
    this.entriesCache = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** `requires` minus the `skills` gate, which loadAll measures itself. Same object when there is nothing to strip. */
function withoutSkillsGate(requires: SkillRequirements | undefined): SkillRequirements | undefined {
  if (!requires || requires.skills === undefined) return requires;
  const { skills: _skills, ...rest } = requires;
  return rest;
}

/**
 * Turn the registry's generic partition reason into one that names what the
 * required skill actually is: not discovered at all, parked with a status
 * (disabled / gated / untrusted / error, with its own reason), or gated by
 * its own dependency chain (explained recursively). Memoized; a cycle is
 * reported as such before any recursion can loop.
 */
function dependencyFailureExplainer(
  unresolvable: ReadonlyMap<string, string>,
  graph: ReadonlyMap<string, readonly string[]>,
  entries: ReadonlyMap<string, SkillEntry>,
): (name: string) => string {
  const memo = new Map<string, string>();
  const visiting = new Set<string>();
  const explain = (name: string): string => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const reason = unresolvable.get(name) ?? "unknown";
    let text: string;
    if (reason.startsWith("circular dependency") || visiting.has(name)) {
      text = `Skill dependency cycle: ${reason}`;
    } else {
      visiting.add(name);
      text = `Required skill ${reason}`;
      for (const dep of graph.get(name) ?? []) {
        if (!graph.has(dep)) {
          const parked = entries.get(dep);
          text = parked
            ? `Required skill "${dep}" is ${parked.status}${parked.gateReason ? ` (${parked.gateReason})` : ""}`
            : `Required skill "${dep}" was not discovered`;
          break;
        }
        if (unresolvable.has(dep)) {
          text = `Required skill "${dep}" is gated (${explain(dep)})`;
          break;
        }
      }
      visiting.delete(name);
    }
    memo.set(name, text);
    return text;
  };
  return explain;
}

// ---------------------------------------------------------------------------
// Internal: Plugin adapter
// ---------------------------------------------------------------------------

interface SkillPluginAdapter extends Plugin {
  getToolNames?(): string[];
}

function createSkillPlugin(
  skill: DiscoveredSkill,
  tools: ITool[],
  toolRegistrar?: (tools: ITool[]) => void,
): SkillPluginAdapter {
  const toolNames = tools.map((t) => t.name);

  const metadata: PluginMetadata = {
    name: skill.manifest.name,
    version: skill.manifest.version,
    description: skill.manifest.description,
    capabilities: skill.manifest.capabilities ?? [],
    dependencies: skill.manifest.requires?.skills,
  };

  return {
    metadata,
    async initialize(): Promise<void> {
      if (toolRegistrar && tools.length > 0) {
        toolRegistrar(tools);
      }
    },
    async dispose(): Promise<void> {
      // Nothing to dispose — env restore is handled by SkillManager
    },
    getToolNames(): string[] {
      return toolNames;
    },
  };
}
