// ---------------------------------------------------------------------------
// SkillManager — lifecycle wrapper around PluginRegistry for skills.
//
// Coordinates discovery, gating, env injection, tool loading, and
// registration into the PluginRegistry with correct ordering.
// ---------------------------------------------------------------------------

import { PluginRegistry, type Plugin, type PluginMetadata } from "../plugins/registry.js";
import { SkillEnvInjector } from "./skill-env-injector.js";
import { discoverSkills, loadSkillTools, type DiscoveredSkill } from "./skill-loader.js";
import { checkGates } from "./skill-gating.js";
import { readSkillConfig } from "./skill-config.js";
import { getLoggerSafe } from "../utils/logger.js";
import type { SkillEntry } from "./types.js";
import type { ITool } from "../agents/tools/tool.interface.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class SkillManager {
  private readonly registry = new PluginRegistry();
  private readonly envInjector = new SkillEnvInjector();
  private readonly entries = new Map<string, SkillEntry>();

  /** Callback to register tools into the app-level ToolRegistry. */
  private toolRegistrar?: (tools: ITool[]) => void;
  /** Callback to remove tools by name from the app-level ToolRegistry. */
  private toolRemover?: (toolNames: string[]) => void;

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
   * Flow:
   *  1. Read user config (~/.strada/skills.json)
   *  2. Discover skills across tiers
   *  3. For each skill: check enabled, check gates, load tools, inject env
   *  4. Register as Plugin in PluginRegistry
   *  5. initializeAll() (topological order)
   *  6. Return all SkillEntry records
   */
  async loadAll(projectRoot?: string, extraDirs?: string[]): Promise<SkillEntry[]> {
    const logger = getLoggerSafe();
    const config = await readSkillConfig();
    const discovered = await discoverSkills(projectRoot, extraDirs);

    for (const skill of discovered) {
      const { name } = skill.manifest;

      try {
        // Check if explicitly disabled
        if (config.entries[name]?.enabled === false) {
          const entry: SkillEntry = {
            manifest: skill.manifest,
            status: "disabled",
            tier: skill.tier,
            path: skill.path,
          };
          this.entries.set(name, entry);
          logger.debug(`Skill "${name}" is disabled by user config`);
          continue;
        }

        // Gate check — pass undefined for the config param: SkillConfig holds
        // per-skill enabled/env entries, not the app-level config key paths
        // that checkGates expects.  Skill authors who need config-key gating
        // must rely on the app-level Config object passed at a higher layer.
        const gateResult = await checkGates(skill.manifest.requires);
        if (!gateResult.passed) {
          const entry: SkillEntry = {
            manifest: skill.manifest,
            status: "gated",
            tier: skill.tier,
            path: skill.path,
            gateReason: gateResult.reasons.join("; "),
          };
          this.entries.set(name, entry);
          logger.info(`Skill "${name}" gated: ${gateResult.reasons.join(", ")}`);
          continue;
        }

        // Load tools
        let tools: ITool[];
        try {
          tools = await loadSkillTools(skill);
        } catch (err) {
          const entry: SkillEntry = {
            manifest: skill.manifest,
            status: "error",
            tier: skill.tier,
            path: skill.path,
            gateReason: `Tool loading failed: ${err instanceof Error ? err.message : String(err)}`,
          };
          this.entries.set(name, entry);
          logger.warn(`Skill "${name}" tool loading failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        // Inject env overrides from user config
        const envOverrides = config.entries[name]?.env;
        if (envOverrides && Object.keys(envOverrides).length > 0) {
          this.envInjector.inject(name, envOverrides);
        }

        // Build Plugin adapter and register
        const toolsCaptured = tools;
        const registrar = this.toolRegistrar;
        const plugin = createSkillPlugin(skill, toolsCaptured, registrar);
        this.registry.register(plugin);

        const entry: SkillEntry = {
          manifest: skill.manifest,
          status: "active",
          tier: skill.tier,
          path: skill.path,
        };
        this.entries.set(name, entry);
      } catch (err) {
        const entry: SkillEntry = {
          manifest: skill.manifest,
          status: "error",
          tier: skill.tier,
          path: skill.path,
          gateReason: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        };
        this.entries.set(name, entry);
        logger.warn(`Skill "${name}" registration failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Initialize all registered plugins in dependency order
    try {
      await this.registry.initializeAll();
    } catch (err) {
      logger.warn("SkillManager: some skills failed during initialization", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info(`SkillManager loaded ${this.entries.size} skill(s)`, {
      active: [...this.entries.values()].filter((e) => e.status === "active").length,
      disabled: [...this.entries.values()].filter((e) => e.status === "disabled").length,
      gated: [...this.entries.values()].filter((e) => e.status === "gated").length,
      error: [...this.entries.values()].filter((e) => e.status === "error").length,
    });

    return [...this.entries.values()];
  }

  /** Return all loaded skill entries. */
  getEntries(): SkillEntry[] {
    return [...this.entries.values()];
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
  }
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
