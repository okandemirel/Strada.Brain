import { describe, it, expect } from "vitest";
import { VaultWatcher } from "./watcher.js";

// These tests exercise the debounce/drain scheduling logic directly (via the
// private dirty set + scheduleDrain) without starting chokidar — no FS events,
// fully deterministic enough with generous timing margins.

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Internals = { dirty: Set<string>; scheduleDrain(): void };

describe("VaultWatcher drain scheduling", () => {
  it("never runs onBatch concurrently (in-flight guard) and loses no events", async () => {
    let active = 0;
    let maxActive = 0;
    const seen: string[] = [];
    const watcher = new VaultWatcher({
      root: "/tmp/vault-watcher-test",
      debounceMs: 10,
      maxWaitMs: 100,
      onBatch: async (paths) => {
        active++;
        maxActive = Math.max(maxActive, active);
        seen.push(...paths);
        await delay(40);
        active--;
      },
    });
    const internal = watcher as unknown as Internals;

    internal.dirty.add("a");
    internal.scheduleDrain();
    await delay(20); // drain #1 fired (~10ms); onBatch("a") is mid-flight (~40ms)

    internal.dirty.add("b");
    internal.scheduleDrain(); // its tick fires while onBatch #1 still runs -> deferred

    await delay(140); // let the deferred drain run after #1 completes

    expect(maxActive).toBe(1); // never overlapped
    expect(seen).toContain("a");
    expect(seen).toContain("b"); // deferred event was not dropped
  });

  it("force-drains under continuous edits via the max-wait cap (no starvation)", async () => {
    const batches: string[][] = [];
    const watcher = new VaultWatcher({
      root: "/tmp/vault-watcher-test-2",
      debounceMs: 30,
      maxWaitMs: 60,
      onBatch: (paths) => {
        batches.push(paths);
      },
    });
    const internal = watcher as unknown as Internals;

    // Edit every 12ms (< debounce) for ~120ms. Trailing-only debounce would
    // reset forever and never fire; the 60ms max-wait must force a drain.
    for (let i = 0; i < 10; i++) {
      internal.dirty.add(`f${i}`);
      internal.scheduleDrain();
      await delay(12);
    }

    // A drain must have fired DURING the continuous-edit stream.
    expect(batches.length).toBeGreaterThanOrEqual(1);
  });
});
