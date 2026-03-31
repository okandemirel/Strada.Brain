/**
 * Plugin Registry
 *
 * Manages plugin lifecycle including registration, dependency resolution,
 * initialization, and disposal.
 *
 * Plugins can optionally declare a permission manifest. When sandboxing is
 * enabled, plugins run in worker_threads with restricted access based on
 * their declared permissions.
 */

import { getLogger } from "../utils/logger.js";

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return console;
  }
}

// ---------------------------------------------------------------------------
// Plugin Types
// ---------------------------------------------------------------------------

/**
 * Metadata describing a plugin's identity and capabilities.
 */
/**
 * Permission manifest for plugin sandboxing.
 * Plugins declare what resources they need access to.
 */
export interface PluginPermissions {
  /** Filesystem paths the plugin may read/write (glob patterns) */
  filesystem?: string[];
  /** Network hosts the plugin may connect to */
  network?: string[];
  /** Maximum CPU time per invocation in ms (default: 30_000) */
  cpuTimeoutMs?: number;
  /** Maximum memory in bytes (default: 128MB) */
  memoryLimitBytes?: number;
  /** Whether the plugin may spawn child processes (default: false) */
  childProcess?: boolean;
}

export interface PluginMetadata {
  /** Unique plugin name (used as registry key) */
  name: string;
  /** Semantic version string */
  version: string;
  /** Human-readable description */
  description: string;
  /** List of capability identifiers this plugin provides */
  capabilities: string[];
  /** Names of other plugins this plugin depends on */
  dependencies?: string[];
  /** Permission manifest for sandboxed execution */
  permissions?: PluginPermissions;
}

/**
 * Plugin interface that all plugins must implement.
 */
export interface Plugin {
  /** Plugin metadata */
  metadata: PluginMetadata;
  /** Initialize the plugin (called after all dependencies are resolved) */
  initialize(): Promise<void>;
  /** Dispose of plugin resources (called during shutdown) */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Plugin Registry
// ---------------------------------------------------------------------------

/**
 * Central registry for managing plugins.
 *
 * Features:
 * - Register and unregister plugins by name
 * - Topological dependency resolution with cycle detection
 * - Bulk initialize / dispose with correct ordering
 * - Capability-based lookup
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, Plugin>();
  private readonly initialized = new Set<string>();
  private initializingPromise: Promise<void> | null = null;

  /**
   * Register a plugin. Throws if a plugin with the same name is already registered.
   */
  register(plugin: Plugin): void {
    const { name } = plugin.metadata;
    if (this.plugins.has(name)) {
      throw new Error(`Plugin '${name}' is already registered`);
    }
    this.plugins.set(name, plugin);
    getLoggerSafe().info("[PluginRegistry] Registered plugin", {
      name,
      version: plugin.metadata.version,
      capabilities: plugin.metadata.capabilities,
    });
  }

  /**
   * Unregister a plugin by name. Disposes the plugin if it was initialized.
   * Throws if other plugins depend on it.
   */
  async unregister(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    // Check if other plugins depend on this one
    for (const [depName, dep] of this.plugins) {
      if (depName === name) continue;
      if (dep.metadata.dependencies?.includes(name)) {
        throw new Error(`Cannot unregister '${name}': '${depName}' depends on it`);
      }
    }

    // Dispose if initialized
    if (this.initialized.has(name)) {
      try {
        await plugin.dispose();
      } catch (error) {
        getLoggerSafe().error(`[PluginRegistry] Error disposing plugin '${name}'`, {
          error: String(error),
        });
      }
      this.initialized.delete(name);
    }

    this.plugins.delete(name);
    getLoggerSafe().info("[PluginRegistry] Unregistered plugin", { name });
  }

  /**
   * Get a plugin by name.
   */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all registered plugins.
   */
  getAll(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Check whether a plugin is registered.
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Check whether a plugin has been initialized.
   */
  isInitialized(name: string): boolean {
    return this.initialized.has(name);
  }

  /**
   * Get count of registered plugins.
   */
  get size(): number {
    return this.plugins.size;
  }

  /**
   * Find all plugins that provide a given capability.
   */
  getByCapability(capability: string): Plugin[] {
    const result: Plugin[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.metadata.capabilities.includes(capability)) {
        result.push(plugin);
      }
    }
    return result;
  }

  /**
   * Resolve the dependency chain for a single plugin using topological sort.
   * Returns plugins in initialization order (dependencies first, target last).
   * Throws on missing dependencies or circular references.
   */
  resolveDependencies(name: string): Plugin[] {
    if (!this.plugins.has(name)) {
      throw new Error(`Missing dependency: '${name}' is not registered`);
    }

    // Collect transitive dependency names
    const depNames = new Set<string>();
    const collect = (current: string): void => {
      if (depNames.has(current)) return;
      depNames.add(current);
      const plugin = this.plugins.get(current);
      if (!plugin) {
        throw new Error(`Missing dependency: '${current}' is not registered`);
      }
      for (const dep of plugin.metadata.dependencies ?? []) {
        collect(dep);
      }
    };
    collect(name);

    // Use the shared topologicalSort for ordering and cycle detection,
    // then filter to only include the relevant dependency subgraph.
    const sorted = this.topologicalSort();
    return sorted.filter((p) => depNames.has(p.metadata.name));
  }

  /**
   * Initialize all registered plugins in dependency order.
   * Plugins already initialized are skipped.
   * Concurrent calls are coalesced into a single initialization run.
   */
  async initializeAll(): Promise<void> {
    if (this.initializingPromise) return this.initializingPromise;
    this.initializingPromise = this.doInitializeAll();
    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }
  }

  private async doInitializeAll(): Promise<void> {
    const sorted = this.topologicalSort();
    for (const plugin of sorted) {
      const { name } = plugin.metadata;
      if (this.initialized.has(name)) continue;
      try {
        await plugin.initialize();
        this.initialized.add(name);
        getLoggerSafe().info("[PluginRegistry] Initialized plugin", { name });
      } catch (error) {
        getLoggerSafe().warn("[PluginRegistry] Failed to initialize plugin", {
          name,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with next plugin instead of throwing
      }
    }
  }

  /**
   * Dispose all initialized plugins in reverse dependency order.
   */
  async disposeAll(): Promise<void> {
    const sorted = this.topologicalSort().reverse();
    for (const plugin of sorted) {
      const { name } = plugin.metadata;
      if (!this.initialized.has(name)) continue;
      try {
        await plugin.dispose();
        getLoggerSafe().info("[PluginRegistry] Disposed plugin", { name });
      } catch (error) {
        getLoggerSafe().error("[PluginRegistry] Error disposing plugin", {
          name,
          error: String(error),
        });
      }
      // Always remove from initialized, even on error
      this.initialized.delete(name);
    }
  }

  /**
   * Clear all plugins (disposes first if any are initialized).
   */
  async clear(): Promise<void> {
    await this.disposeAll();
    this.plugins.clear();
    this.initialized.clear();
  }

  /**
   * Topological sort of all registered plugins with cycle detection.
   * Returns plugins in dependency-first order.
   */
  private topologicalSort(): Plugin[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: Plugin[] = [];

    const visit = (name: string): void => {
      if (visited.has(name)) return;

      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving '${name}'`);
      }

      const plugin = this.plugins.get(name);
      if (!plugin) return;

      visiting.add(name);

      for (const dep of plugin.metadata.dependencies ?? []) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Plugin '${name}' depends on '${dep}' which is not registered`);
        }
        visit(dep);
      }

      visiting.delete(name);
      visited.add(name);
      result.push(plugin);
    };

    for (const name of this.plugins.keys()) {
      visit(name);
    }

    return result;
  }
}
