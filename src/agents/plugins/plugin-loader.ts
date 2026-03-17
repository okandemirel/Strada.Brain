import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getLogger } from "../../utils/logger.js";
import type { ITool } from "../tools/tool.interface.js";

/**
 * Plugin manifest file (plugin.json).
 */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  entry: string;
  tools?: string[];
}

/**
 * A loaded plugin with its tools.
 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  tools: ITool[];
  path: string;
}

/**
 * Dynamic plugin loader for Strada Brain.
 * Loads tools from external directories following a convention:
 *
 *   plugins/
 *     my-plugin/
 *       plugin.json    <- manifest
 *       index.js       <- entry point (exports tools array)
 *
 * Plugin manifest (plugin.json):
 *   {
 *     "name": "my-plugin",
 *     "version": "1.0.0",
 *     "description": "My custom tools",
 *     "entry": "index.js"
 *   }
 *
 * Entry point must default-export or named-export `tools: ITool[]`
 */
export class PluginLoader {
  private readonly pluginDirs: string[];
  private readonly loadedPlugins = new Map<string, LoadedPlugin>();
  private importNonce = 0;

  constructor(pluginDirs: string[]) {
    this.pluginDirs = pluginDirs.map((d) => resolve(d));
  }

  private isPathInside(basePath: string, candidatePath: string): boolean {
    const relativePath = relative(basePath, candidatePath);
    return candidatePath === basePath || (
      relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath)
    );
  }

  private async resolvePluginEntryPaths(pluginPath: string, entry: string): Promise<{
    pluginRootPath: string;
    entryPath: string;
  }> {
    const pluginRootPath = await realpath(pluginPath);
    const entryPath = resolve(pluginRootPath, entry);
    const relativeEntryPath = relative(pluginRootPath, entryPath);
    if (relativeEntryPath.startsWith("..") || isAbsolute(relativeEntryPath)) {
      throw new Error("Plugin entry path escapes plugin directory");
    }

    const realEntryPath = await realpath(entryPath);
    if (!this.isPathInside(pluginRootPath, realEntryPath)) {
      throw new Error("Plugin entry path resolves outside plugin directory");
    }

    return {
      pluginRootPath,
      entryPath: realEntryPath,
    };
  }

  private async importPluginModule(entryPath: string): Promise<Record<string, unknown>> {
    const entryFileUrl = pathToFileURL(entryPath);
    entryFileUrl.searchParams.set("strada_plugin_nonce", String(++this.importNonce));
    return import(entryFileUrl.href) as Promise<Record<string, unknown>>;
  }

  /**
   * Scan all plugin directories and load valid plugins.
   * Returns all tools from all loaded plugins.
   */
  async loadAll(): Promise<ITool[]> {
    const logger = getLogger();
    const allTools: ITool[] = [];

    for (const dir of this.pluginDirs) {
      try {
        const dirStat = await stat(dir);
        if (!dirStat.isDirectory()) continue;
      } catch {
        logger.debug(`Plugin directory not found: ${dir}`);
        continue;
      }

      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginPath = join(dir, entry.name);
        try {
          const plugin = await this.loadPlugin(pluginPath);
          if (plugin) {
            this.loadedPlugins.set(plugin.manifest.name, plugin);
            allTools.push(...plugin.tools);
            logger.info(`Plugin loaded: ${plugin.manifest.name} v${plugin.manifest.version}`, {
              tools: plugin.tools.map((t) => t.name),
            });
          }
        } catch (error) {
          logger.warn(`Failed to load plugin at ${pluginPath}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    logger.info(`Plugin loading complete: ${this.loadedPlugins.size} plugins, ${allTools.length} tools`);
    return allTools;
  }

  /**
   * Load a single plugin from a directory.
   */
  private async loadPlugin(pluginPath: string): Promise<LoadedPlugin | null> {
    const manifestPath = join(pluginPath, "plugin.json");

    // Read and validate manifest
    let manifestRaw: string;
    try {
      manifestRaw = await readFile(manifestPath, "utf-8");
    } catch {
      return null; // No manifest = not a plugin
    }

    const manifest = JSON.parse(manifestRaw) as PluginManifest;
    if (!manifest.name || !manifest.entry) {
      throw new Error("Plugin manifest missing required fields: name, entry");
    }

    const { pluginRootPath, entryPath } = await this.resolvePluginEntryPaths(pluginPath, manifest.entry);

    // Dynamic import with a nonce so reloads do not reuse stale ESM cache entries.
    const module = await this.importPluginModule(entryPath);

    // Extract tools - support both default export and named export
    let tools: ITool[] = [];
    if (Array.isArray(module["default"])) {
      tools = module["default"] as ITool[];
    } else if (Array.isArray(module["tools"])) {
      tools = module["tools"] as ITool[];
    } else {
      throw new Error("Plugin must export 'tools' array or default export an array of tools");
    }

    // Validate each tool has required interface
    for (const tool of tools) {
      if (!tool.name || !tool.description || !tool.inputSchema || typeof tool.execute !== "function") {
        throw new Error(`Invalid tool in plugin '${manifest.name}': missing required ITool fields`);
      }
    }

    // Prefix tool names with plugin namespace to avoid collisions
    // Mark tools as plugin-loaded for filtering
    const namespacedTools: ITool[] = tools.map((tool) => ({
      ...tool,
      name: `plugin_${manifest.name}_${tool.name}`,
      execute: tool.execute.bind(tool),
      isPlugin: true,
    }));

    return { manifest, tools: namespacedTools, path: pluginRootPath };
  }

  /**
   * Get all loaded plugins.
   */
  getLoadedPlugins(): LoadedPlugin[] {
    return [...this.loadedPlugins.values()];
  }

  /**
   * Reload a specific plugin by name.
   */
  async reloadPlugin(name: string): Promise<ITool[]> {
    const existing = this.loadedPlugins.get(name);
    if (!existing) {
      throw new Error(`Plugin '${name}' not found`);
    }

    const reloaded = await this.loadPlugin(existing.path);
    if (!reloaded) {
      throw new Error(`Failed to reload plugin '${name}'`);
    }

    this.loadedPlugins.set(name, reloaded);
    return reloaded.tools;
  }

  /**
   * Reload all loaded plugins.
   */
  async reloadAll(): Promise<ITool[]> {
    const logger = getLogger();
    const allTools: ITool[] = [];
    
    // Clear existing plugins
    const pluginPaths = new Map(this.loadedPlugins);
    this.loadedPlugins.clear();
    
    // Reload each plugin
    for (const [name, existing] of pluginPaths) {
      try {
        const reloaded = await this.loadPlugin(existing.path);
        if (reloaded) {
          this.loadedPlugins.set(name, reloaded);
          allTools.push(...reloaded.tools);
          logger.info(`Plugin reloaded: ${name} v${reloaded.manifest.version}`);
        }
      } catch (error) {
        logger.error(`Failed to reload plugin '${name}': ${error instanceof Error ? error.message : error}`);
        // Keep the old version on error
        this.loadedPlugins.set(name, existing);
        allTools.push(...existing.tools);
      }
    }
    
    // Also scan for new plugins
    const newTools = await this.loadAll();
    
    // Merge and deduplicate
    const seenNames = new Set(allTools.map(t => t.name));
    for (const tool of newTools) {
      if (!seenNames.has(tool.name)) {
        allTools.push(tool);
      }
    }
    
    return allTools;
  }
}
