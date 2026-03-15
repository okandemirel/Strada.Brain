/**
 * SoulLoader — Reads and caches the agent personality from soul.md
 *
 * Hot-reloads on file change with debounce. Supports channel-specific overrides.
 * Security: path traversal protection, symlink resolution, file size limits.
 */

import { readFile, realpath, readdir, writeFile, unlink } from "node:fs/promises";
import { watch, mkdirSync, existsSync, type FSWatcher } from "node:fs";
import { resolve, join } from "node:path";
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
  private activeProfileName = "default";
  private profileNames: string[] = ["default"];
  private readonly basePath: string;
  private readonly soulFile: string;
  private readonly channelOverrides: Map<string, string>;
  private readonly channelOverridesRecord: Record<string, string>;
  private readonly customProfilesDir: string;

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
    this.channelOverridesRecord = Object.fromEntries(this.channelOverrides);
    this.customProfilesDir = join(projectPath, ".strada-memory", "profiles");
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

    // Scan profiles/ directory for available profiles
    const systemProfiles: string[] = [];
    try {
      const profilesDir = resolve(this.basePath, "profiles");
      const entries = await readdir(profilesDir, { withFileTypes: true });
      systemProfiles.push(
        ...entries.filter(e => e.isFile() && e.name.endsWith(".md")).map(e => e.name.replace(/\.md$/, "")),
      );
    } catch {
      // No system profiles directory — that's fine
    }

    // Ensure custom profiles directory exists and scan it
    const customProfiles: string[] = [];
    try {
      mkdirSync(this.customProfilesDir, { recursive: true });
      const customEntries = await readdir(this.customProfilesDir, { withFileTypes: true });
      customProfiles.push(
        ...customEntries.filter(e => e.isFile() && e.name.endsWith(".md")).map(e => e.name.replace(/\.md$/, "")),
      );
    } catch {
      // Custom profiles directory not accessible — that's fine
    }

    // Merge: default first, then system, then custom (deduplicated)
    const seen = new Set<string>(["default"]);
    this.profileNames = ["default"];
    for (const name of [...systemProfiles, ...customProfiles]) {
      if (!seen.has(name)) {
        seen.add(name);
        this.profileNames.push(name);
      }
    }

    logger.info("SoulLoader initialized", {
      defaultFile: this.soulFile,
      overrides: Array.from(this.channelOverrides.keys()),
      loaded: this.cache.size,
      profiles: this.profileNames.length,
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
   * Get the name of the currently active personality profile.
   */
  getActiveProfile(): string {
    return this.activeProfileName;
  }

  /**
   * Get the list of available profile names (includes "default").
   */
  getProfiles(): string[] {
    return [...this.profileNames];
  }

  /**
   * Get channel-specific override mappings.
   */
  getChannelOverrides(): Record<string, string> {
    return this.channelOverridesRecord;
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
    this.activeProfileName = "default";
    this.profileNames = ["default"];
  }

  /**
   * Validate that a file path is safe — within basePath, no symlink escape.
   */
  private async validateFilePath(fileName: string): Promise<string | null> {
    const logger = getLogger();

    // Reject null bytes
    if (fileName.includes("\0")) {
      logger.warn("Soul file rejected — null byte in path", { file: fileName });
      return null;
    }

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

    if (profileName !== "default" && !this.isValidCustomProfileName(profileName)) {
      logger.warn("Profile name rejected — invalid characters", { profileName });
      return false;
    }

    this.switchInFlight = true;
    try {
      const previous = this.cache.get("default") ?? null;
      const fileName = this.resolveProfilePath(profileName);

      const success = await this.loadFile("default", fileName);
      if (!success) {
        if (previous !== null) {
          this.cache.set("default", previous);
        } else {
          this.cache.delete("default");
        }
      } else {
        this.activeProfileName = profileName;
        logger.info("Personality profile switched", { profile: profileName });
      }
      return success;
    } finally {
      this.switchInFlight = false;
    }
  }

  /**
   * Read-only profile content retrieval.
   * Returns the content of a named profile WITHOUT mutating the default cache.
   * Safe for concurrent multi-user scenarios.
   */
  async getProfileContent(profileName: string): Promise<string | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
      getLogger().warn("Profile name rejected — invalid characters", { profileName });
      return null;
    }

    if (profileName === "default") {
      return this.cache.get("default") ?? null;
    }

    const validPath = await this.validateFilePath(this.resolveProfilePath(profileName));
    if (!validPath) return null;

    try {
      const content = await readFile(validPath, "utf-8");
      if (content.length > MAX_SOUL_FILE_SIZE) {
        getLogger().warn("Profile file rejected — exceeds size limit", {
          profileName,
          size: content.length,
        });
        return null;
      }
      return content.trim();
    } catch {
      return null;
    }
  }

  /**
   * Save a custom profile to .strada-memory/profiles/.
   * Validates name, rejects "default", enforces size limit.
   */
  async saveProfile(name: string, content: string): Promise<boolean> {
    const logger = getLogger();

    if (!this.isValidCustomProfileName(name)) {
      logger.warn("Profile save rejected — invalid name", { name });
      return false;
    }

    if (content.length > MAX_SOUL_FILE_SIZE) {
      logger.warn("Profile save rejected — exceeds size limit", {
        name,
        size: content.length,
        maxSize: MAX_SOUL_FILE_SIZE,
      });
      return false;
    }

    const validPath = await this.validateCustomProfilePath(name);
    if (!validPath) return false;

    try {
      mkdirSync(this.customProfilesDir, { recursive: true });
      await writeFile(validPath, content, "utf-8");

      if (!this.profileNames.includes(name)) {
        this.profileNames.push(name);
      }

      this.watchFile(`custom-profile:${name}`, `.strada-memory/profiles/${name}.md`);
      logger.info("Custom profile saved", { name, size: content.length });
      return true;
    } catch (err) {
      logger.warn("Profile save failed", { name, error: String(err) });
      return false;
    }
  }

  /**
   * Delete a custom profile from .strada-memory/profiles/.
   * Only allows deleting custom profiles, never system profiles.
   * Switches back to "default" if the deleted profile was active.
   */
  async deleteProfile(name: string): Promise<boolean> {
    const logger = getLogger();

    if (!this.isValidCustomProfileName(name)) {
      logger.warn("Profile delete rejected — invalid name", { name });
      return false;
    }

    const filePath = join(this.customProfilesDir, `${name}.md`);
    if (!existsSync(filePath)) {
      logger.warn("Profile delete rejected — not a custom profile or does not exist", { name });
      return false;
    }

    const validPath = await this.validateCustomProfilePath(name);
    if (!validPath) return false;

    try {
      await unlink(validPath);
      this.profileNames = this.profileNames.filter(p => p !== name);

      if (this.activeProfileName === name) {
        this.activeProfileName = "default";
        await this.loadFile("default", this.soulFile);
        logger.info("Active profile deleted, switched back to default", { name });
      } else {
        logger.info("Custom profile deleted", { name });
      }

      return true;
    } catch (err) {
      logger.warn("Profile delete failed", { name, error: String(err) });
      return false;
    }
  }

  /**
   * Check if a profile is a custom (user-created) profile.
   * Returns true if the profile exists in .strada-memory/profiles/.
   */
  isCustomProfile(name: string): boolean {
    if (!this.isValidCustomProfileName(name)) return false;
    return existsSync(join(this.customProfilesDir, `${name}.md`));
  }

  /**
   * Validate that a profile name is safe for use as a custom profile.
   * Rejects "default" and names with invalid characters.
   */
  private isValidCustomProfileName(name: string): boolean {
    return name !== "default" && /^[a-zA-Z0-9_-]+$/.test(name);
  }

  /**
   * Resolve a profile name to its relative file path.
   * Custom profiles (.strada-memory/profiles/) take precedence over system profiles (profiles/).
   */
  private resolveProfilePath(profileName: string): string {
    if (profileName === "default") return this.soulFile;
    const customPath = join(this.customProfilesDir, `${profileName}.md`);
    return existsSync(customPath)
      ? `.strada-memory/profiles/${profileName}.md`
      : `profiles/${profileName}.md`;
  }

  /**
   * Validate the filesystem path for a custom profile name.
   */
  private validateCustomProfilePath(name: string): Promise<string | null> {
    return this.validateFilePath(`.strada-memory/profiles/${name}.md`);
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
