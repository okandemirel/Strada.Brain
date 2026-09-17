/**
 * Plugin Registry
 *
 * Manages plugin lifecycle including registration, dependency resolution,
 * initialization, and disposal.
 *
 * SECURITY: there is no sandbox. Plugins run in-process, on the main thread,
 * with the full privileges of the host — `plugin.initialize()` is an ordinary
 * await in doInitializeAll(). A plugin can read any file, open any socket, and
 * spawn any process the Strada process can.
 *
 * This docstring used to claim that "when sandboxing is enabled, plugins run in
 * worker_threads with restricted access based on their declared permissions."
 * That was never true: `worker_threads` is imported nowhere in the codebase and
 * `metadata.permissions` is read nowhere. The claim is worse than no
 * documentation, because it invites treating an untrusted plugin as contained.
 *
 * Only load plugins you would be willing to run as a plain `import`, because
 * that is exactly what happens. SkillManager registers skills through this same
 * registry, so the same applies to them.
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
 * Declared resource needs for a plugin.
 *
 * NOT ENFORCED. Nothing in the codebase reads these fields — they are
 * documentation a plugin author writes about itself, and the registry neither
 * validates nor restricts anything on their basis. The wording below is
 * deliberately "declares", not "may": a plugin that declares no filesystem
 * access can still read every file on the machine.
 *
 * They are kept because they are a useful, already-adopted description of
 * intent, and because deleting them would break plugins that set them. Treat
 * them as a manifest to read, never as a boundary to rely on. If a real
 * sandbox is ever implemented, the characterization test in registry.test.ts
 * fails and forces this comment to be revisited alongside it.
 */
export interface PluginPermissions {
  /** Filesystem paths the plugin declares it will read/write (glob patterns) */
  filesystem?: string[];
  /** Network hosts the plugin declares it will connect to */
  network?: string[];
  /** CPU time per invocation the plugin declares it needs, in ms */
  cpuTimeoutMs?: number;
  /** Memory the plugin declares it needs, in bytes */
  memoryLimitBytes?: number;
  /** Whether the plugin declares that it spawns child processes */
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
  /** Self-declared resource needs. Not enforced — see PluginPermissions. */
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
  /** Why a registered plugin is NOT initialized after the last initializeAll(). */
  private readonly initFailures = new Map<string, string>();
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
   * The reason a plugin failed to initialize in the last `initializeAll()` —
   * its `initialize()` threw, or its dependency graph could not be resolved
   * (missing dependency, cycle, or a dependency that itself failed). Undefined
   * when the plugin initialized, or was never part of an initialize run.
   */
  getInitializationError(name: string): string | undefined {
    return this.initFailures.get(name);
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

  /**
   * plan 0-B.2 (audit R1/D67, R2, Codex #3): this used to call the throwing
   * `topologicalSort()` BEFORE the per-plugin try/catch, so one plugin with a
   * missing dependency aborted initialization of every plugin in the batch.
   * Now the graph is partitioned first: plugins whose dependency chain is
   * complete and acyclic are initialized in order; the others are recorded as
   * failed with the reason and never touched. A plugin whose dependency threw
   * in initialize() is not initialized either — its dependency contract is
   * "called after all dependencies are resolved".
   */
  private async doInitializeAll(): Promise<void> {
    const { order, unresolvable } = this.partitionByDependencies();
    for (const [name, reason] of unresolvable) {
      if (this.initialized.has(name)) continue;
      this.initFailures.set(name, reason);
      getLoggerSafe().warn("[PluginRegistry] Plugin excluded from initialization", { name, reason });
    }
    for (const plugin of order) {
      const { name } = plugin.metadata;
      if (this.initialized.has(name)) continue;
      const failedDep = (plugin.metadata.dependencies ?? []).find((dep) => !this.initialized.has(dep));
      if (failedDep !== undefined) {
        const reason = `Dependency '${failedDep}' failed to initialize: ${this.initFailures.get(failedDep) ?? "unknown"}`;
        this.initFailures.set(name, reason);
        getLoggerSafe().warn("[PluginRegistry] Plugin skipped: dependency not initialized", { name, reason });
        continue;
      }
      try {
        await plugin.initialize();
        this.initialized.add(name);
        this.initFailures.delete(name);
        getLoggerSafe().info("[PluginRegistry] Initialized plugin", { name });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.initFailures.set(name, message);
        getLoggerSafe().warn("[PluginRegistry] Failed to initialize plugin", { name, error: message });
        // Continue with next plugin instead of throwing
      }
    }
  }

  /**
   * Dispose all initialized plugins in reverse dependency order.
   */
  async disposeAll(): Promise<void> {
    // Non-throwing partition: an unresolvable plugin was never initialized, so
    // it has nothing to dispose and must not block disposal of the others.
    const sorted = this.partitionByDependencies().order.reverse();
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
    this.initFailures.clear();
  }

  /**
   * Split the registered plugins into an initialization order (dependencies
   * first; every dependency of an ordered plugin is itself ordered) and the
   * plugins that can never be initialized, each with the reason: a dependency
   * that is not registered, a cycle, or a dependency that is itself
   * unresolvable. Never throws — that is the point (plan 0-B.2).
   */
  partitionByDependencies(): { order: Plugin[]; unresolvable: Map<string, string> } {
    const graph = new Map<string, readonly string[]>();
    for (const [name, plugin] of this.plugins) graph.set(name, plugin.metadata.dependencies ?? []);
    const { order: names, unresolvable } = partitionDependencyGraph(graph);
    const order: Plugin[] = [];
    for (const name of names) {
      const plugin = this.plugins.get(name);
      if (plugin) order.push(plugin);
    }
    return { order, unresolvable };
  }

  /**
   * Topological sort of all registered plugins with cycle detection.
   * Returns plugins in dependency-first order.
   */
  private topologicalSort(): Plugin[] {
    const { order, unresolvable } = this.partitionByDependencies();
    const first = unresolvable.entries().next();
    if (!first.done) {
      const [name, reason] = first.value;
      throw new Error(`Plugin '${name}': ${reason}`);
    }
    return order;
  }
}

// ---------------------------------------------------------------------------
// Dependency-graph partition (shared with SkillManager's manifest preflight)
// ---------------------------------------------------------------------------

/**
 * Partition a dependency graph (node → names it depends on) into a
 * dependencies-first order over the nodes whose whole transitive chain is
 * present and acyclic, and the rest with a reason each. Order-independent:
 * the verdict for a node does not depend on the iteration order of the input.
 *
 * Reasons name the offending edge: a dependency that is not in the graph, a
 * dependency that reaches back to the node (cycle), or a dependency that is
 * itself unresolvable (transitive).
 */
export function partitionDependencyGraph(
  graph: ReadonlyMap<string, readonly string[]>,
): { order: string[]; unresolvable: Map<string, string> } {
  // Fixpoint: a node is resolvable once every dependency is resolvable. Nodes
  // with a missing dependency, nodes in a cycle, and everything depending on
  // them never enter the set.
  const resolvable = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, deps] of graph) {
      if (resolvable.has(name)) continue;
      if (deps.every((dep) => resolvable.has(dep))) {
        resolvable.add(name);
        grew = true;
      }
    }
  }

  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const dep of graph.get(current) ?? []) stack.push(dep);
    }
    return false;
  };

  const unresolvable = new Map<string, string>();
  for (const [name, deps] of graph) {
    if (resolvable.has(name)) continue;
    const missing = deps.find((dep) => !graph.has(dep));
    if (missing !== undefined) {
      unresolvable.set(name, `depends on '${missing}' which is not registered`);
      continue;
    }
    const cyclic = deps.find((dep) => reaches(dep, name));
    if (cyclic !== undefined) {
      unresolvable.set(name, `circular dependency: '${name}' -> '${cyclic}' -> ... -> '${name}'`);
      continue;
    }
    const blocked = deps.find((dep) => !resolvable.has(dep))!;
    unresolvable.set(name, `depends on '${blocked}' which cannot be initialized`);
  }

  // Dependencies-first order over the resolvable subgraph (acyclic by construction).
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of graph.get(name) ?? []) visit(dep);
    order.push(name);
  };
  for (const name of graph.keys()) {
    if (resolvable.has(name)) visit(name);
  }
  return { order, unresolvable };
}
