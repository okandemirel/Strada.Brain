/**
 * FileWatchTrigger
 *
 * Implements ITrigger using chokidar for file system monitoring.
 * Buffers add/change/unlink events between HeartbeatLoop ticks using a
 * per-path debounce strategy. The shouldFire() contract is synchronous --
 * async chokidar events are buffered into pendingEvents and drained on onFired().
 *
 * Security: Only file paths and event types are passed to the LLM action.
 * File content is never read or transmitted -- this prevents prompt injection.
 *
 * Used by: TriggerRegistry, HeartbeatLoop
 */

import { basename } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type {
  ITrigger,
  TriggerMetadata,
  TriggerState,
  FileWatchTriggerDef,
} from "../daemon-types.js";

/** Internal representation of a file system event */
export interface FileEvent {
  readonly path: string;
  readonly event: "add" | "change" | "unlink";
}

/** Default debounce interval in ms */
const DEFAULT_DEBOUNCE_MS = 500;

/** Default ignore patterns applied to all file watchers */
const DEFAULT_IGNORE_PATTERNS = ["**/node_modules/**", "**/.git/**"];

/**
 * Convert a simple glob pattern (e.g., '*.cs', '*.{ts,tsx}') to a RegExp
 * that matches against a filename (basename only).
 *
 * Supports: * (wildcard), ? (single char), {a,b} (alternation).
 * This avoids depending on picomatch (no type declarations available).
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      regex += ".*";
    } else if (ch === "?") {
      regex += ".";
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end !== -1) {
        const alternatives = pattern.slice(i + 1, end).split(",").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        regex += `(?:${alternatives})`;
        i = end;
      } else {
        regex += "\\{";
      }
    } else if (".+^$|()[]\\".includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i++;
  }
  return new RegExp(`^${regex}$`);
}

/**
 * Map event type to human-readable past tense.
 */
function eventLabel(event: FileEvent["event"]): string {
  switch (event) {
    case "add":
      return "added";
    case "change":
      return "changed";
    case "unlink":
      return "deleted";
  }
}

export class FileWatchTrigger implements ITrigger {
  private _metadata: TriggerMetadata;
  private readonly originalAction: string;
  private readonly pendingEvents: FileEvent[] = [];
  private readonly watcher: FSWatcher;
  private readonly debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly debounceMs: number;
  private readonly patternMatcher: ((path: string) => boolean) | null;
  private disposed = false;

  /**
   * @param def File watch trigger definition from HEARTBEAT.md
   */
  constructor(def: FileWatchTriggerDef) {
    this.originalAction = def.action;
    this._metadata = {
      name: def.name,
      description: def.action,
      type: "file-watch",
    };

    this.debounceMs = def.debounce ?? DEFAULT_DEBOUNCE_MS;

    // Build glob pattern matcher if a filter pattern is provided
    if (def.pattern) {
      const re = globToRegex(def.pattern);
      this.patternMatcher = (filePath: string) => re.test(basename(filePath));
    } else {
      this.patternMatcher = null;
    }

    // Merge user-provided ignore patterns with defaults
    const ignored = [
      ...(def.ignore ?? []),
      ...DEFAULT_IGNORE_PATTERNS,
    ];

    // Configure chokidar watcher
    const watchOpts: Record<string, unknown> = {
      ignoreInitial: true,
      persistent: true,
      ignored,
    };

    // recursive: false means depth 0 (only watch the directory itself)
    if (def.recursive === false) {
      watchOpts.depth = 0;
    }

    this.watcher = watch(def.path, watchOpts);

    // Register event handlers
    this.watcher.on("add", (path: string) => this.handleEvent(path, "add"));
    this.watcher.on("change", (path: string) => this.handleEvent(path, "change"));
    this.watcher.on("unlink", (path: string) => this.handleEvent(path, "unlink"));
    this.watcher.on("error", (_error: unknown) => {
      // Swallow errors -- trigger remains active. Errors are logged by
      // consumers via the daemon event bus, not here.
    });
    this.watcher.on("ready", () => {
      // Watcher is ready. No action needed -- events will start flowing.
    });
  }

  /**
   * Handle a file system event with per-path debouncing.
   * Rapid changes to the same path collapse into a single buffered event.
   */
  private handleEvent(filePath: string, eventType: FileEvent["event"]): void {
    if (this.disposed) return;

    // Apply pattern filter if configured
    if (this.patternMatcher && !this.patternMatcher(filePath)) {
      return;
    }

    // Clear any existing debounce timer for this path
    const existing = this.debounceTimers.get(filePath);
    if (existing != null) {
      clearTimeout(existing);
    }

    // Set a new debounce timer
    const timer = setTimeout(() => {
      if (!this.disposed) {
        this.pendingEvents.push({ path: filePath, event: eventType });
      }
      this.debounceTimers.delete(filePath);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * ITrigger.metadata -- dynamic getter allows description to change after onFired.
   */
  get metadata(): TriggerMetadata {
    return this._metadata;
  }

  /**
   * Returns true when there are pending file events to process.
   * Pure synchronous check -- no I/O.
   */
  shouldFire(_now: Date): boolean {
    return this.pendingEvents.length > 0;
  }

  /**
   * Called after the trigger fires. Drains the event buffer and updates
   * the metadata description with a summary of what changed.
   *
   * Security: only passes file paths and event type strings -- never file content.
   */
  onFired(_now: Date): void {
    if (this.pendingEvents.length === 0) return;

    // Build human-readable summary
    const count = this.pendingEvents.length;
    const details = this.pendingEvents
      .map((e) => `${basename(e.path)} ${eventLabel(e.event)}`)
      .join(", ");

    const summary = `File changes detected: ${count} file${count !== 1 ? "s" : ""} (${details}). Action: ${this.originalAction}`;

    this._metadata = {
      name: this._metadata.name,
      description: summary,
      type: this._metadata.type,
    };

    // Drain the buffer
    this.pendingEvents.length = 0;
  }

  /**
   * Returns null -- file watch triggers are event-driven, not scheduled.
   */
  getNextRun(): Date | null {
    return null;
  }

  /**
   * Always returns 'active'. Circuit breaker state is managed externally
   * by HeartbeatLoop, not by the trigger itself.
   */
  getState(): TriggerState {
    return "active";
  }

  /**
   * Get a read-only copy of the current pending events buffer.
   * Useful for introspection by Plan 03 event payload construction.
   */
  getPendingEvents(): ReadonlyArray<FileEvent> {
    return [...this.pendingEvents];
  }

  /**
   * Clean up all resources: close watcher, clear debounce timers, drain buffer.
   */
  async dispose(): Promise<void> {
    this.disposed = true;

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close the chokidar watcher
    await this.watcher.close();

    // Drain any remaining events
    this.pendingEvents.length = 0;
  }
}
