import { watchFile, unwatchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { getLogger } from "../utils/logger.js";

export class SecretRotationWatcher {
  private envPath: string = ".env";
  private readonly callbacks = new Map<
    string,
    Array<(oldValue: string, newValue: string) => void>
  >();
  private readonly logger = getLogger();
  private lastValues = new Map<string, string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  onRotation(envKey: string, callback: (oldValue: string, newValue: string) => void): void {
    const existing = this.callbacks.get(envKey) ?? [];
    existing.push(callback);
    this.callbacks.set(envKey, existing);
    const current = process.env[envKey];
    if (current) {
      this.lastValues.set(envKey, current);
    }
  }

  startWatching(envPath: string = ".env"): void {
    this.envPath = envPath;
    try {
      watchFile(envPath, { interval: 2000 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return; // No actual change
        this.handleFileChange(envPath);
      });
      this.logger.info("Secret rotation watcher started", { envPath });
    } catch (error) {
      this.logger.warn("Failed to start secret rotation watcher", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleFileChange(envPath: string): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.processFileChange(envPath);
    }, 500);
  }

  private async processFileChange(envPath: string): Promise<void> {
    try {
      const content = await readFile(envPath, "utf-8");
      const parsed = this.parseEnvFile(content);

      for (const [key, callbacks] of this.callbacks) {
        const newValue = parsed.get(key);
        const oldValue = this.lastValues.get(key);

        if (newValue && newValue !== oldValue) {
          this.logger.info("Secret rotated", { key });
          process.env[key] = newValue;
          this.lastValues.set(key, newValue);
          for (const cb of callbacks) {
            try {
              cb(oldValue ?? "", newValue);
            } catch (error) {
              this.logger.error("Secret rotation callback error", { key, error: String(error) });
            }
          }
        }
      }
    } catch (error) {
      this.logger.error("Failed to process secret rotation", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private parseEnvFile(content: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let value = trimmed.substring(eqIdx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value
          .slice(1, -1)
          .replace(/\\"/g, '"')
          .replace(/\\n/g, "\n")
          .replace(/\\\\/g, "\\");
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1); // Single quotes: no escape processing
      }
      result.set(key, value);
    }
    return result;
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    unwatchFile(this.envPath);
    this.callbacks.clear();
    this.lastValues.clear();
  }
}
