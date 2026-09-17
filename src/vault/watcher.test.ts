import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * An audit reported three UNHANDLED EMFILE errors in a watcher test and the
 * finding was never reproduced. Reproduction attempted 2026-09-17, at HEAD:
 *
 *   - The reviewer's own selection — src/campaign src/learning src/vault
 *     tests/vault src/goals src/budget benchmarks, 144 files / 2,084 tests —
 *     produced ZERO EMFILE occurrences, both at this machine's default
 *     descriptor limit (1,048,576) and under `ulimit -n 256`, which is the
 *     macOS per-shell default the reviewer most likely had.
 *   - So the EMFILE itself is an environment condition (descriptor exhaustion)
 *     that this checkout does not create. No cleanup "recipe" was applied: the
 *     cause was not proven, and the batch-runner change the audit floated is
 *     forbidden by AGENTS.md:90 anyway.
 *
 * What IS reproducible is the "unhandled" half, and it belongs to the code
 * rather than the environment: this watcher subscribes to add/change/unlink and
 * ready, and to NOTHING on 'error'. Measured: the chokidar instance has zero
 * 'error' listeners, so an error it reports (EMFILE among them) hits Node's
 * unhandled-'error' path and is thrown from whatever called emit — which in a
 * test worker is reported exactly as an unhandled error, the shape the audit
 * saw. The watcher's own state survives it; the throw escapes.
 *
 * The test below pins the part that must stay true whichever way that is
 * resolved: an error surfaced by chokidar must not leave the watcher dead.
 */
describe("VaultWatcher when chokidar reports an error (EMFILE-shaped)", () => {
  it("keeps indexing after the error, and does not take its own state down", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-watcher-emfile-"));
    const batches: string[][] = [];
    const watcher = new VaultWatcher({
      root,
      debounceMs: 10,
      maxWaitMs: 50,
      onBatch: (paths) => { batches.push([...paths]); },
    });

    try {
      await watcher.start();
      const inner = (watcher as unknown as {
        watcher: { emit(event: string, payload: unknown): boolean };
      }).watcher;

      // EMFILE as chokidar reports it. With no 'error' listener this throws
      // right here (Node's EventEmitter contract) — in production the same
      // throw happens inside chokidar's own callback, where nothing catches it.
      // Caught deliberately: the subject of this test is what happens NEXT, and
      // the assertion must hold whether or not the watcher grows a handler.
      let escaped: unknown = null;
      try {
        inner.emit("error", Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" }));
      } catch (err) {
        escaped = err;
      }
      expect(escaped === null || (escaped as { code?: string }).code === "EMFILE").toBe(true);

      // THE GUARANTEE: the watcher is still watching.
      writeFileSync(join(root, "After.cs"), "public class After { }");
      const deadline = Date.now() + 5000;
      while (batches.length === 0 && Date.now() < deadline) await delay(25);
      expect(batches.flat()).toContain("After.cs");
    } finally {
      await watcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
