/**
 * SoulLoader — Reads and caches the agent personality from soul.md
 *
 * Hot-reloads on file change with debounce. Supports channel-specific overrides.
 * Security: path traversal protection, symlink resolution, file size limits.
 */

import { readFile, realpath } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { getLogger } from "../../utils/logger.js";
import type { ChannelType } from "../../channels/channel-messages.interface.js";

const DEFAULT_SOUL_FILE = "soul.md";
const MAX_SOUL_FILE_SIZE = 10 * 1024; // 10 KB
const DEBOUNCE_MS = 200;

export class SoulLoader {
  private cache = new Map<string, string>();
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private switchInFlight = false;
  private readonly basePath: string;
  private readonly soulFile: string;
  private readonly channelOverrides: Map<string, string>;

  constructor(
    projectPath: string,
    options?: {
      soulFile?: string;
      channelOverrides?: Record<string, string>;
    },
  ) {
    this.basePath = projectPath;
    this.soulFile = options?.soulFile ?? DEFAULT_SOUL_FILE;
    this.channelOverrides = new Map(
      Object.entries(options?.channelOverrides ?? {}),
    );
  }

  /**
   * Initialize — read default + override files, start watching loaded files only.
   */
  async initialize(): Promise<void> {
    const logger = getLogger();

    // Load default soul file
    const defaultLoaded = await this.loadFile("default", this.soulFile);

    // Load channel overrides
    const loadedKeys = new Set<string>();
    if (defaultLoaded) loadedKeys.add("default");
    for (const [channel, file] of this.channelOverrides) {
      const loaded = await this.loadFile(channel, file);
      if (loaded) loadedKeys.add(channel);
    }

    // Watch only successfully loaded files
    if (loadedKeys.has("default")) {
      this.watchFile("default", this.soulFile);
    }
    for (const [channel, file] of this.channelOverrides) {
      if (loadedKeys.has(channel)) {
        this.watchFile(channel, file);
      }
    }

    logger.info("SoulLoader initialized", {
      defaultFile: this.soulFile,
      overrides: Array.from(this.channelOverrides.keys()),
      loaded: this.cache.size,
    });
  }

  /**
   * Get soul content for a specific channel.
   * Falls back to default if no channel-specific override exists.
   */
  getContent(channelType?: ChannelType | string): string {
    if (channelType) {
      const override = this.cache.get(channelType);
      if (override) return override;
    }
    return this.cache.get("default") ?? "";
  }

  /**
   * Shutdown — stop file watchers and debounce timers.
   */
  shutdown(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.watchers = [];
    this.debounceTimers.clear();
    this.cache.clear();
  }

  /**
   * Validate that a file path is safe — within basePath, no symlink escape.
   */
  private async validateFilePath(fileName: string): Promise<string | null> {
    const logger = getLogger();

    // Reject absolute paths
    if (fileName.startsWith("/") || fileName.startsWith("\\") || /^[a-zA-Z]:/.test(fileName)) {
      logger.warn("Soul file rejected — absolute path not allowed", { file: fileName });
      return null;
    }

    // Reject traversal patterns
    if (fileName.includes("..")) {
      logger.warn("Soul file rejected — path traversal detected", { file: fileName });
      return null;
    }

    const filePath = resolve(this.basePath, fileName);

    // Resolve basePath symlinks (e.g., macOS /var → /private/var)
    let resolvedBase: string;
    try {
      resolvedBase = await realpath(resolve(this.basePath));
    } catch {
      resolvedBase = resolve(this.basePath);
    }

    // Verify resolved path is within basePath
    const resolvedFile = resolve(this.basePath, fileName);
    if (!resolvedFile.startsWith(resolvedBase + "/") && resolvedFile !== resolvedBase) {
      // Also check without realpath for non-symlinked setups
      const plainBase = resolve(this.basePath);
      if (!resolvedFile.startsWith(plainBase + "/") && resolvedFile !== plainBase) {
        logger.warn("Soul file rejected — outside project directory", { file: fileName });
        return null;
      }
    }

    // Resolve symlinks on the file itself and re-check
    try {
      const realPath = await realpath(filePath);
      if (!realPath.startsWith(resolvedBase + "/") && realPath !== resolvedBase) {
        logger.warn("Soul file rejected — symlink escapes project directory", { file: fileName, realPath });
        return null;
      }
      return realPath;
    } catch {
      // File doesn't exist — return the unresolved path
      return filePath;
    }
  }

  /**
   * Switch the active personality profile at runtime.
   * Reads from profiles/ directory. "default" reads soul.md.
   * Preserves the current personality if the target profile fails to load.
   */
  async switchProfile(profileName: string): Promise<boolean> {
    const logger = getLogger();

    if (this.switchInFlight) return false;

    // Defense-in-depth: only allow alphanumeric, dash, underscore
    if (profileName !== "default" && !/^[a-zA-Z0-9_-]+$/.test(profileName)) {
      logger.warn("Profile name rejected — invalid characters", { profileName });
      return false;
    }

    this.switchInFlight = true;
    try {
      const previous = this.cache.get("default") ?? null;
      const fileName = profileName === "default"
        ? this.soulFile
        : `profiles/${profileName}.md`;

      const success = await this.loadFile("default", fileName);
      if (!success) {
        if (previous !== null) {
          this.cache.set("default", previous);
        } else {
          this.cache.delete("default");
        }
      } else {
        logger.info("Personality profile switched", { profile: profileName });
      }
      return success;
    } finally {
      this.switchInFlight = false;
    }
  }

  private async loadFile(key: string, fileName: string): Promise<boolean> {
    const logger = getLogger();

    const validPath = await this.validateFilePath(fileName);
    if (!validPath) return false;

    try {
      const content = await readFile(validPath, "utf-8");

      // Enforce size limit
      if (content.length > MAX_SOUL_FILE_SIZE) {
        logger.warn("Soul file rejected — exceeds size limit", {
          file: fileName,
          size: content.length,
          maxSize: MAX_SOUL_FILE_SIZE,
        });
        return false;
      }

      this.cache.set(key, content.trim());
      logger.debug("Soul file loaded", { key, file: fileName, length: content.length });
      return true;
    } catch {
      if (key === "default") {
        logger.warn("Soul file not found, using empty personality", { file: fileName });
        this.cache.set(key, "");
      }
      return false;
    }
  }

  private watchFile(key: string, fileName: string): void {
    const filePath = resolve(this.basePath, fileName);

    try {
      const watcher = watch(filePath, (eventType) => {
        // Handle both change and rename events (editors use atomic write → rename)
        if (eventType === "change" || eventType === "rename") {
          // Debounce — editors fire multiple events per save
          const existing = this.debounceTimers.get(key);
          if (existing) clearTimeout(existing);
          this.debounceTimers.set(
            key,
            setTimeout(() => {
              this.debounceTimers.delete(key);
              getLogger().info("Soul file changed, reloading", { key, file: fileName });
              void this.loadFile(key, fileName);
            }, DEBOUNCE_MS),
          );
        }
      });
      watcher.on("error", () => {
        // File may have been deleted — not an error
      });
      this.watchers.push(watcher);
    } catch {
      // Watch failure is non-fatal
    }
  }
}
