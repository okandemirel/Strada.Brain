import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FileWatchTriggerDef } from "../daemon-types.js";

// Mock chokidar before importing the module under test
const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
  closed: false,
};
vi.mock("chokidar", () => ({
  watch: vi.fn(() => mockWatcher),
}));

// Must import after mock setup
import { FileWatchTrigger } from "./file-watch-trigger.js";
import { watch } from "chokidar";

describe("FileWatchTrigger", () => {
  const baseDef: FileWatchTriggerDef = {
    type: "file-watch",
    name: "test-watcher",
    action: "Analyze changed Unity scripts",
    path: "/projects/game/Assets",
    debounce: 100,
  };

  let eventHandlers: Record<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Capture event handlers registered via .on()
    eventHandlers = {};
    mockWatcher.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers[event] = handler;
      return mockWatcher;
    });
    mockWatcher.close.mockResolvedValue(undefined);
    mockWatcher.closed = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // Constructor / Watcher setup
  // ===========================================================================

  it("creates chokidar watcher with correct default options", () => {
    new FileWatchTrigger(baseDef);

    expect(watch).toHaveBeenCalledWith(
      baseDef.path,
      expect.objectContaining({
        ignoreInitial: true,
        persistent: true,
      }),
    );
  });

  it("includes default ignore patterns: node_modules, .git", () => {
    new FileWatchTrigger(baseDef);

    const callArgs = vi.mocked(watch).mock.calls[0]![1]!;
    const ignored = callArgs.ignored as string[];
    expect(ignored).toContain("**/node_modules/**");
    expect(ignored).toContain("**/.git/**");
  });

  it("merges user-provided ignore patterns with defaults", () => {
    new FileWatchTrigger({ ...baseDef, ignore: ["*.meta", "Library/**"] });

    const callArgs = vi.mocked(watch).mock.calls[0]![1]!;
    const ignored = callArgs.ignored as string[];
    expect(ignored).toContain("*.meta");
    expect(ignored).toContain("Library/**");
    expect(ignored).toContain("**/node_modules/**");
    expect(ignored).toContain("**/.git/**");
  });

  it("sets depth: undefined (recursive) when recursive is true or default", () => {
    new FileWatchTrigger(baseDef);

    const callArgs = vi.mocked(watch).mock.calls[0]![1]!;
    // depth should not be set (undefined means full recursion)
    expect(callArgs.depth).toBeUndefined();
  });

  it("sets depth: 0 when recursive is false", () => {
    new FileWatchTrigger({ ...baseDef, recursive: false });

    const callArgs = vi.mocked(watch).mock.calls[0]![1]!;
    expect(callArgs.depth).toBe(0);
  });

  it("registers event handlers for add, change, unlink, error, ready", () => {
    new FileWatchTrigger(baseDef);

    expect(eventHandlers).toHaveProperty("add");
    expect(eventHandlers).toHaveProperty("change");
    expect(eventHandlers).toHaveProperty("unlink");
    expect(eventHandlers).toHaveProperty("error");
    expect(eventHandlers).toHaveProperty("ready");
  });

  // ===========================================================================
  // Metadata
  // ===========================================================================

  it("metadata has correct name, type, and initial description", () => {
    const trigger = new FileWatchTrigger(baseDef);

    expect(trigger.metadata.name).toBe("test-watcher");
    expect(trigger.metadata.type).toBe("file-watch");
    expect(trigger.metadata.description).toBe("Analyze changed Unity scripts");
  });

  // ===========================================================================
  // shouldFire - basic event buffering
  // ===========================================================================

  it("shouldFire returns false when no events have occurred", () => {
    const trigger = new FileWatchTrigger(baseDef);
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("shouldFire returns true after an add event completes debounce", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["add"]!("/projects/game/Assets/Player.cs");
    // Advance past debounce (100ms)
    vi.advanceTimersByTime(150);

    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("shouldFire returns true after a change event completes debounce", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["change"]!("/projects/game/Assets/Enemy.cs");
    vi.advanceTimersByTime(150);

    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("shouldFire returns true after an unlink event completes debounce", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["unlink"]!("/projects/game/Assets/OldScript.cs");
    vi.advanceTimersByTime(150);

    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("shouldFire returns false before debounce completes", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["add"]!("/projects/game/Assets/Player.cs");
    // Only 50ms -- debounce is 100ms
    vi.advanceTimersByTime(50);

    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  // ===========================================================================
  // Debounce behavior
  // ===========================================================================

  it("rapid changes to same file result in only one event (debounce)", () => {
    const trigger = new FileWatchTrigger(baseDef);

    // Simulate rapid saves to same file
    eventHandlers["change"]!("/projects/game/Assets/Player.cs");
    vi.advanceTimersByTime(30);
    eventHandlers["change"]!("/projects/game/Assets/Player.cs");
    vi.advanceTimersByTime(30);
    eventHandlers["change"]!("/projects/game/Assets/Player.cs");
    vi.advanceTimersByTime(150);

    expect(trigger.shouldFire(new Date())).toBe(true);

    // Drain and check count
    trigger.onFired(new Date());
    // After drain, no events remain
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("uses default debounce of 500ms when not specified", () => {
    const defNoDebounce: FileWatchTriggerDef = {
      type: "file-watch",
      name: "no-debounce",
      action: "test",
      path: "/tmp/test",
    };
    const trigger = new FileWatchTrigger(defNoDebounce);

    eventHandlers["add"]!("/tmp/test/file.txt");
    // At 400ms, should still be debouncing
    vi.advanceTimersByTime(400);
    expect(trigger.shouldFire(new Date())).toBe(false);

    // At 550ms total, should be ready
    vi.advanceTimersByTime(150);
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  // ===========================================================================
  // Multiple files
  // ===========================================================================

  it("buffers events from multiple different files", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["change"]!("/projects/game/Assets/A.cs");
    eventHandlers["add"]!("/projects/game/Assets/B.cs");
    eventHandlers["unlink"]!("/projects/game/Assets/C.cs");
    vi.advanceTimersByTime(150);

    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  // ===========================================================================
  // onFired - drain and description update
  // ===========================================================================

  it("onFired drains buffer so shouldFire returns false", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["add"]!("/projects/game/Assets/Player.cs");
    vi.advanceTimersByTime(150);
    expect(trigger.shouldFire(new Date())).toBe(true);

    trigger.onFired(new Date());
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("onFired updates metadata description with event summary", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["change"]!("/projects/game/Assets/Player.cs");
    eventHandlers["add"]!("/projects/game/Assets/NewFile.cs");
    vi.advanceTimersByTime(150);

    trigger.onFired(new Date());

    expect(trigger.metadata.description).toContain("File changes detected");
    expect(trigger.metadata.description).toContain("changed");
    expect(trigger.metadata.description).toContain("added");
  });

  it("onFired restores original description after drain when no events pending", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["add"]!("/projects/game/Assets/Player.cs");
    vi.advanceTimersByTime(150);
    trigger.onFired(new Date());

    // After onFired with empty buffer, description should reference original action
    expect(trigger.metadata.description).toContain("Analyze changed Unity scripts");
  });

  // ===========================================================================
  // Pattern filtering
  // ===========================================================================

  it("filters events by glob pattern (*.cs)", () => {
    const trigger = new FileWatchTrigger({ ...baseDef, pattern: "*.cs" });

    eventHandlers["add"]!("/projects/game/Assets/Player.cs");
    eventHandlers["add"]!("/projects/game/Assets/readme.txt");
    eventHandlers["add"]!("/projects/game/Assets/data.json");
    vi.advanceTimersByTime(150);

    // Only the .cs file should be buffered
    expect(trigger.shouldFire(new Date())).toBe(true);
    trigger.onFired(new Date());

    expect(trigger.metadata.description).toContain("Player.cs");
    expect(trigger.metadata.description).not.toContain("readme.txt");
    expect(trigger.metadata.description).not.toContain("data.json");
  });

  it("pattern filter allows multiple matching files", () => {
    const trigger = new FileWatchTrigger({ ...baseDef, pattern: "*.cs" });

    eventHandlers["change"]!("/projects/game/Assets/A.cs");
    eventHandlers["change"]!("/projects/game/Assets/B.cs");
    eventHandlers["add"]!("/projects/game/Assets/skip.txt");
    vi.advanceTimersByTime(150);

    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("no events buffered when all files fail pattern filter", () => {
    const trigger = new FileWatchTrigger({ ...baseDef, pattern: "*.cs" });

    eventHandlers["add"]!("/projects/game/Assets/readme.txt");
    eventHandlers["add"]!("/projects/game/Assets/data.json");
    vi.advanceTimersByTime(150);

    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("pattern filter with nested paths matches basename", () => {
    const trigger = new FileWatchTrigger({ ...baseDef, pattern: "*.cs" });

    eventHandlers["change"]!("/projects/game/Assets/Scripts/Player.cs");
    vi.advanceTimersByTime(150);

    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  // ===========================================================================
  // getNextRun / getState
  // ===========================================================================

  it("getNextRun returns null (event-driven trigger)", () => {
    const trigger = new FileWatchTrigger(baseDef);
    expect(trigger.getNextRun()).toBeNull();
  });

  it("getState returns active", () => {
    const trigger = new FileWatchTrigger(baseDef);
    expect(trigger.getState()).toBe("active");
  });

  // ===========================================================================
  // dispose
  // ===========================================================================

  it("dispose closes watcher", async () => {
    const trigger = new FileWatchTrigger(baseDef);
    await trigger.dispose();

    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it("dispose clears pending events", async () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["add"]!("/projects/game/Assets/Player.cs");
    vi.advanceTimersByTime(150);
    expect(trigger.shouldFire(new Date())).toBe(true);

    await trigger.dispose();
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("dispose clears debounce timers so no events appear after dispose", async () => {
    const trigger = new FileWatchTrigger(baseDef);

    // Add event but don't let debounce complete
    eventHandlers["change"]!("/projects/game/Assets/Player.cs");
    vi.advanceTimersByTime(30); // debounce still pending

    await trigger.dispose();

    // Now advance past debounce -- event should NOT appear
    vi.advanceTimersByTime(200);
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("dispose is idempotent (can be called twice)", async () => {
    const trigger = new FileWatchTrigger(baseDef);
    await trigger.dispose();
    await trigger.dispose();

    // Should not throw
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  it("error event does not crash the trigger", () => {
    const trigger = new FileWatchTrigger(baseDef);

    // Simulate error
    expect(() => {
      eventHandlers["error"]!(new Error("ENOSPC: file table overflow"));
    }).not.toThrow();

    // Trigger should still be functional
    expect(trigger.getState()).toBe("active");
  });

  it("ready event is handled without error", () => {
    new FileWatchTrigger(baseDef);

    expect(() => {
      eventHandlers["ready"]!();
    }).not.toThrow();
  });

  // ===========================================================================
  // Security: only paths, never file content
  // ===========================================================================

  it("onFired description contains paths and event types only, never file content", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["change"]!("/projects/game/Assets/Secret.cs");
    vi.advanceTimersByTime(150);

    trigger.onFired(new Date());
    const desc = trigger.metadata.description;

    // Should contain path reference
    expect(desc).toContain("Secret.cs");
    // Should contain event type
    expect(desc).toContain("changed");
    // Description should not be unreasonably long (no file content)
    expect(desc.length).toBeLessThan(1000);
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  it("events after onFired are buffered for next cycle", () => {
    const trigger = new FileWatchTrigger(baseDef);

    // First cycle
    eventHandlers["add"]!("/projects/game/Assets/A.cs");
    vi.advanceTimersByTime(150);
    trigger.onFired(new Date());
    expect(trigger.shouldFire(new Date())).toBe(false);

    // Second cycle -- new event
    eventHandlers["change"]!("/projects/game/Assets/B.cs");
    vi.advanceTimersByTime(150);
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("getPendingEvents returns current buffer for introspection", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["add"]!("/projects/game/Assets/Player.cs");
    eventHandlers["change"]!("/projects/game/Assets/Enemy.cs");
    vi.advanceTimersByTime(150);

    const events = trigger.getPendingEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("add");
    expect(events[1]!.event).toBe("change");
  });

  it("getPendingEvents returns a copy (not mutable reference)", () => {
    const trigger = new FileWatchTrigger(baseDef);

    eventHandlers["add"]!("/projects/game/Assets/Player.cs");
    vi.advanceTimersByTime(150);

    const events = trigger.getPendingEvents();
    // Mutating the returned array should not affect internal state
    events.length = 0;
    expect(trigger.shouldFire(new Date())).toBe(true);
  });
});
