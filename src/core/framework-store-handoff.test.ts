import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { FrameworkStoreHandoff } from "./framework-store-handoff.js";

/**
 * The FrameworkPromptGenerator must be wired against a SYNCED store. It used
 * to be wired as soon as the store object existed — mid-bootSync, against an
 * unsynced database — and cached `null` for the life of the process.
 * Audited 2026-09-02.
 */
describe("FrameworkStoreHandoff (audited 2026-09-02)", () => {
  it("does not hand over a store that exists but whose sync has not settled", () => {
    const handoff = new FrameworkStoreHandoff<{ id: string }>();
    const store = { id: "unsynced-yet" };
    const consumer = vi.fn();

    // The store object exists (constructed before the slow bootSync) — the
    // consumer registers now, exactly as the main bootstrap path does.
    handoff.onSettled(consumer);
    expect(handoff.settled).toBe(false);
    expect(consumer).not.toHaveBeenCalled();

    handoff.settle({ store });
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith({ store });
  });

  it("hands over immediately when the sync settled before the consumer registered", () => {
    const handoff = new FrameworkStoreHandoff<{ id: string }>();
    const store = { id: "synced" };
    handoff.settle({ store });

    const consumer = vi.fn();
    handoff.onSettled(consumer);

    expect(consumer).toHaveBeenCalledWith({ store });
  });

  it("carries a failed sync's reason alongside whatever store was opened", () => {
    const handoff = new FrameworkStoreHandoff<{ id: string }>();
    const consumer = vi.fn();
    handoff.onSettled(consumer);

    handoff.settle({ store: { id: "persisted-snapshots" }, failure: "git clone failed: network unreachable" });

    expect(consumer).toHaveBeenCalledWith({
      store: { id: "persisted-snapshots" },
      failure: "git clone failed: network unreachable",
    });
    // A second settlement (e.g. a retry) cannot re-fire the wiring.
    handoff.settle({ store: { id: "again" } });
    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it("is what bootstrap actually uses — the wiring is gated on settlement, not on the store object", () => {
    // Proving the handoff orders correctly says nothing if bootstrap still
    // tests `if (frameworkStore)`. This asserts the boot path went through it.
    const source = readFileSync("src/core/bootstrap.ts", "utf8");
    expect(source).not.toMatch(/if \(frameworkStore\) \{\s*\/\/ IIFE already completed/);
    expect(source).toContain("frameworkHandoff.onSettled(");
    // Settled on BOTH the success and the failure path of the sync IIFE.
    expect(source.match(/frameworkHandoff\.settle\(/g)?.length).toBe(2);
    // A failed sync reaches the startup notices, not only a debug log line.
    expect(source).toMatch(/Framework knowledge sync failed/);
  });
});
