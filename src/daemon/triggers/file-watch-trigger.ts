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
// @ts-ignore -- picomatch is a direct dependency (package.json) but ships no bundled types
import picomatch from "picomatch";
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

/**
 * Most buffered events kept between fires. Audited 2026-09-02: the buffer had
 * no cap and onFired() joined every entry into the task prompt, so a Unity
 * re-import under a watched directory during a skipped-tick stretch became a
 * multi-megabyte prompt billed to the daemon. Events past the cap are counted
 * and named in the summary, never silently dropped. (WebhookTrigger caps at
 * 1000 with an O(1) summary; this summary is O(n), hence the smaller cap.)
 */
const MAX_PENDING_EVENTS = 200;

/** Default ignore patterns applied to all file watchers */
const DEFAULT_IGNORE_PATTERNS = ["**/node_modules/**", "**/.git/**"];

/** Build a picomatch matcher for glob pattern filtering on basenames. */
function buildPatternMatcher(pattern: string): (filePath: string) => boolean {
  const isMatch = picomatch(pattern) as (input: string) => boolean;
  return (filePath: string) => isMatch(basename(filePath));
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
  /** Debounced events that arrived while the buffer was full — reported, not listed. */
  private overflowCount = 0;
  private disposed = false;

  /**
   * @param def File watch trigger definition from HEARTBEAT.md
   */
  constructor(def: FileWatchTriggerDef) {
    this.originalAction = def.action;
    // Audited 2026-09-02: `cooldown:` was parsed into def.cooldown but never
    // reached metadata, so the heartbeat computed cooldownMs=0 and the user's
    // throttle was silently dropped. Only CronTrigger was handed it.
    this._metadata = {
      name: def.name,
      description: def.action,
      type: "file-watch",
      cooldownSeconds: def.cooldown,
    };

    this.debounceMs = def.debounce ?? DEFAULT_DEBOUNCE_MS;

    // Build glob pattern matcher if a filter pattern is provided
    if (def.pattern) {
      this.patternMatcher = buildPatternMatcher(def.pattern);
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
        if (this.pendingEvents.length < MAX_PENDING_EVENTS) {
          this.pendingEvents.push({ path: filePath, event: eventType });
        } else {
          // Full: count it so the fire summary can state what it did not list.
          this.overflowCount += 1;
        }
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

    // Name the overflow rather than hide it: the prompt states what it dropped.
    const overflow = this.overflowCount > 0
      ? `; ${this.overflowCount} further change${this.overflowCount !== 1 ? "s" : ""} not listed`
      : "";
    this.overflowCount = 0;
    const summary = `File changes detected: ${count} file${count !== 1 ? "s" : ""} (${details}${overflow}). Action: ${this.originalAction}`;

    // Keep every other field (cooldownSeconds included) — rebuilding from
    // three literals dropped the cooldown after the first fire.
    this._metadata = { ...this._metadata, description: summary };

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
    this.overflowCount = 0;
  }
}
