import { watch, type FSWatcher } from "chokidar";
import { getLogger } from "../utils/logger.js";

/**
 * Hot reload event types
 */
export type HotReloadEventType = 
  | "add" 
  | "change" 
  | "unlink" 
  | "reload_success" 
  | "reload_error";

/**
 * Hot reload event data
 */
export interface HotReloadEvent {
  type: HotReloadEventType;
  path: string;
  timestamp: number;
  error?: string;
}

/**
 * Hot reload event listener
 */
export type HotReloadEventListener = (event: HotReloadEvent) => void | Promise<void>;

/**
 * Plugin Hot Reload Manager
 * 
 * Features:
 * - File watching with chokidar
 * - Debounced reload (1 second)
 * - Event support: add, change, unlink, reload_success, reload_error
 * - Graceful error handling
 * - Multiple listener support via onEvent()
 */
export class PluginHotReload {
  private readonly pluginDirs: string[];
  private readonly debounceMs: number;
  private readonly filePattern: string;
  
  private watcher: FSWatcher | null = null;
  private listeners: HotReloadEventListener[] = [];
  private pendingReloads: Map<string, NodeJS.Timeout> = new Map();
  private isWatching: boolean = false;
  
  private readonly logger = getLogger();

  /**
   * Create a new PluginHotReload instance
   * 
   * @param pluginDirs - Directories to watch for plugin changes
   * @param options - Configuration options
   */
  constructor(
    pluginDirs: string[],
    options: {
      debounceMs?: number;
      filePattern?: string;
      ignoreDotfiles?: boolean;
    } = {}
  ) {
    this.pluginDirs = pluginDirs.filter(Boolean);
    this.debounceMs = options.debounceMs ?? 1000;
    this.filePattern = options.filePattern ?? "**/*.js";
  }

  /**
   * Start watching plugin directories
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      this.logger.warn("Plugin hot reload already started");
      return;
    }

    if (this.pluginDirs.length === 0) {
      this.logger.warn("No plugin directories configured for hot reload");
      return;
    }

    const watchPaths = this.pluginDirs.map(dir => `${dir}/${this.filePattern}`);
    
    this.logger.info("Starting plugin hot reload watcher", { 
      dirs: this.pluginDirs,
      pattern: this.filePattern,
      debounceMs: this.debounceMs
    });

    this.watcher = watch(watchPaths, {
      ignored: [
        /(^|[\/\\])\../, // dotfiles
        "**/node_modules/**",
        "**/*.d.ts",
        "**/*.map"
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    // Handle file additions
    this.watcher.on("add", (path: string) => {
      this.logger.debug(`Plugin file added: ${path}`);
      this.debouncedReload("add", path);
    });

    // Handle file changes
    this.watcher.on("change", (path: string) => {
      this.logger.debug(`Plugin file changed: ${path}`);
      this.debouncedReload("change", path);
    });

    // Handle file removals
    this.watcher.on("unlink", (path: string) => {
      this.logger.debug(`Plugin file removed: ${path}`);
      this.debouncedReload("unlink", path);
    });

    // Handle errors
    this.watcher.on("error", (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Plugin watcher error: ${errorMessage}`);
      this.emitEvent({
        type: "reload_error",
        path: "",
        timestamp: Date.now(),
        error: errorMessage
      });
    });

    // Ready event
    this.watcher.on("ready", () => {
      this.logger.info("Plugin hot reload watcher ready", { 
        dirs: this.pluginDirs 
      });
    });

    this.isWatching = true;
  }

  /**
   * Stop watching plugin directories
   */
  async stop(): Promise<void> {
    if (!this.isWatching || !this.watcher) {
      return;
    }

    this.logger.info("Stopping plugin hot reload watcher");

    // Clear all pending reloads
    for (const timeout of this.pendingReloads.values()) {
      clearTimeout(timeout);
    }
    this.pendingReloads.clear();

    await this.watcher.close();
    this.watcher = null;
    this.isWatching = false;
  }

  /**
   * Register an event listener
   * 
   * @param listener - Event listener function
   * @returns Unsubscribe function
   */
  onEvent(listener: HotReloadEventListener): () => void {
    this.listeners.push(listener);
    
    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Register a one-time event listener
   * 
   * @param listener - Event listener function
   * @returns Unsubscribe function
   */
  once(listener: HotReloadEventListener): () => void {
    const wrappedListener: HotReloadEventListener = (event) => {
      unsubscribe();
      return listener(event);
    };
    
    const unsubscribe = this.onEvent(wrappedListener);
    return unsubscribe;
  }

  /**
   * Get list of watched directories
   */
  getWatchedDirs(): string[] {
    return [...this.pluginDirs];
  }

  /**
   * Check if watching is active
   */
  isActive(): boolean {
    return this.isWatching;
  }

  /**
   * Get count of pending reloads
   */
  getPendingCount(): number {
    return this.pendingReloads.size;
  }

  /**
   * Force trigger a reload for a specific file
   * 
   * @param path - File path
   * @param type - Event type (default: "change")
   */
  triggerReload(path: string, type: HotReloadEventType = "change"): void {
    this.debouncedReload(type, path);
  }

  /**
   * Debounced reload handler
   */
  private debouncedReload(type: HotReloadEventType, path: string): void {
    // Clear existing timeout for this path
    const existingTimeout = this.pendingReloads.get(path);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeout = setTimeout(() => {
      this.pendingReloads.delete(path);
      this.handleReload(type, path);
    }, this.debounceMs);

    this.pendingReloads.set(path, timeout);

    // Emit preliminary event
    this.emitEvent({
      type,
      path,
      timestamp: Date.now()
    });
  }

  /**
   * Handle the actual reload
   */
  private async handleReload(type: HotReloadEventType, path: string): Promise<void> {
    this.logger.info(`Reloading plugin: ${path}`, { type });

    try {
      // Clear module cache for the changed file
      const modulePath = await import("path");
      const absolutePath = modulePath.resolve(path);
      
      if (require.cache?.[absolutePath]) {
        delete require.cache[absolutePath];
      }

      // Emit success event
      this.emitEvent({
        type: "reload_success",
        path,
        timestamp: Date.now()
      });

      this.logger.info(`Plugin reloaded successfully: ${path}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.logger.error(`Plugin reload failed: ${path}`, { error: errorMessage });
      
      // Emit error event
      this.emitEvent({
        type: "reload_error",
        path,
        timestamp: Date.now(),
        error: errorMessage
      });
    }
  }

  /**
   * Emit event to all listeners
   */
  private async emitEvent(event: HotReloadEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error("Hot reload listener error", { 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    }
  }
}

/**
 * Create a hot reload manager with automatic integration to WebSocket dashboard
 */
export function createHotReloadManager(
  pluginDirs: string[],
  options?: {
    debounceMs?: number;
    filePattern?: string;
    onReload?: (event: HotReloadEvent) => void | Promise<void>;
  }
): PluginHotReload {
  const manager = new PluginHotReload(pluginDirs, options);
  
  if (options?.onReload) {
    manager.onEvent(options.onReload);
  }
  
  return manager;
}
