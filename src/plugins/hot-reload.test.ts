import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PluginHotReload, type HotReloadEvent } from "./hot-reload.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock logger
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("PluginHotReload", () => {
  let hotReload: PluginHotReload;
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = mkdtempSync(join(tmpdir(), "hot-reload-test-"));
    mkdirSync(join(tempDir, "plugins"), { recursive: true });
    
    hotReload = new PluginHotReload([join(tempDir, "plugins")], {
      debounceMs: 100, // Fast debounce for tests
      filePattern: "**/*.js",
    });
  });

  afterEach(async () => {
    await hotReload.stop();
    
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should start and stop watching", async () => {
    expect(hotReload.isActive()).toBe(false);
    
    await hotReload.start();
    expect(hotReload.isActive()).toBe(true);
    
    await hotReload.stop();
    expect(hotReload.isActive()).toBe(false);
  });

  it("should get watched directories", () => {
    const dirs = hotReload.getWatchedDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toContain("plugins");
  });

  it("should register and unregister event listeners", async () => {
    const listener = vi.fn();
    
    const unsubscribe = hotReload.onEvent(listener);
    
    // Manually emit an event
    await (hotReload as unknown as { emitEvent: (e: HotReloadEvent) => Promise<void> }).emitEvent({
      type: "add",
      path: "/test/path.js",
      timestamp: Date.now(),
    });
    
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: "add",
      path: "/test/path.js",
    }));
    
    // Unsubscribe
    unsubscribe();
    
    await (hotReload as unknown as { emitEvent: (e: HotReloadEvent) => Promise<void> }).emitEvent({
      type: "change",
      path: "/test/path2.js",
      timestamp: Date.now(),
    });
    
    // Should still be 1 call
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("should support once listener", async () => {
    const listener = vi.fn();
    
    hotReload.once(listener);
    
    await (hotReload as unknown as { emitEvent: (e: HotReloadEvent) => Promise<void> }).emitEvent({
      type: "add",
      path: "/test/path.js",
      timestamp: Date.now(),
    });
    
    expect(listener).toHaveBeenCalledTimes(1);
    
    // Second event should not trigger
    await (hotReload as unknown as { emitEvent: (e: HotReloadEvent) => Promise<void> }).emitEvent({
      type: "change",
      path: "/test/path2.js",
      timestamp: Date.now(),
    });
    
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("should handle listener errors gracefully", async () => {
    const errorListener = vi.fn().mockRejectedValue(new Error("Listener error"));
    const successListener = vi.fn();
    
    hotReload.onEvent(errorListener);
    hotReload.onEvent(successListener);
    
    await (hotReload as unknown as { emitEvent: (e: HotReloadEvent) => Promise<void> }).emitEvent({
      type: "add",
      path: "/test/path.js",
      timestamp: Date.now(),
    });
    
    // Both should be called even if one errors
    expect(errorListener).toHaveBeenCalled();
    expect(successListener).toHaveBeenCalled();
  });

  it("should trigger manual reload", async () => {
    const listener = vi.fn();
    hotReload.onEvent(listener);
    
    hotReload.triggerReload("/test/manual.js", "change");
    
    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 150));
    
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: "change",
      path: "/test/manual.js",
    }));
  });

  it("should get pending reload count", () => {
    expect(hotReload.getPendingCount()).toBe(0);
    
    hotReload.triggerReload("/test/file1.js", "change");
    hotReload.triggerReload("/test/file2.js", "add");
    
    expect(hotReload.getPendingCount()).toBe(2);
  });

  it("should handle empty plugin directories gracefully", async () => {
    const emptyHotReload = new PluginHotReload([], {
      debounceMs: 100,
    });
    
    // Should not throw
    await emptyHotReload.start();
    expect(emptyHotReload.isActive()).toBe(false);
  });

  it("should not start multiple times", async () => {
    await hotReload.start();
    const firstWatcher = (hotReload as unknown as { watcher: unknown }).watcher;
    
    // Second start should be ignored
    await hotReload.start();
    
    expect((hotReload as unknown as { watcher: unknown }).watcher).toBe(firstWatcher);
  });

  it("should handle stop when not started", async () => {
    // Should not throw
    await hotReload.stop();
    expect(hotReload.isActive()).toBe(false);
  });
});
