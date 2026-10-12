/**
 * COR-9: on shutdown the campaign stops listening BEFORE the task manager fails
 * its in-flight tasks; otherwise it answers those shutdown failures by
 * submitting a new milestone into a task manager that is closing.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignManager } from "./campaign-manager.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { DeliveryPackageStore } from "./delivery-package.js";
import type { EvidenceLedger } from "./evidence-ledger.js";
import type { TaskManager } from "../tasks/task-manager.js";

/**
 * A slow disk under `under`: each read of a file there is held `delayMs`
 * before it runs, and its stream counts as open until the file is closed.
 */
const slowDisk = vi.hoisted(() => ({
  under: undefined as string | undefined,
  delayMs: 0,
  reads: 0,
  open: 0,
  onRead: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const createReadStream = ((path: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) => {
    const under = slowDisk.under;
    if (under === undefined || typeof path !== "string" || !path.startsWith(under) || typeof options !== "object" || options === null) {
      return actual.createReadStream(path, options);
    }
    const read = (...args: unknown[]): void => {
      slowDisk.reads++;
      slowDisk.onRead?.();
      setTimeout(() => Reflect.apply(actual.read, undefined, args), slowDisk.delayMs);
    };
    const stream = actual.createReadStream(path, { ...options, fs: { open: actual.open, read, close: actual.close } });
    slowDisk.open++;
    stream.once("close", () => { slowDisk.open--; });
    return stream;
  }) as typeof actual.createReadStream;
  return { ...actual, createReadStream };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CampaignManager.dispose (COR-9)", () => {
  it("detaches from task events and closes its store", () => {
    const dir = mkdtempSync(join(tmpdir(), "strada-campaign-dispose-"));
    dirs.push(dir);
    const storage = new CampaignStorage(join(dir, "campaigns.db"));
    const tasks = new EventEmitter();
    const manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn() } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: dir,
    });
    manager.attachEvents();
    expect(tasks.listenerCount("task:failed")).toBe(1);

    manager.dispose();

    for (const event of ["task:completed", "task:failed", "task:blocked", "task:cancelled"]) {
      expect(tasks.listenerCount(event)).toBe(0);
    }
    expect(storage.isOpen()).toBe(false);
    // Idempotent, and a late attach does not resubscribe a disposed manager.
    manager.dispose();
    manager.attachEvents();
    expect(tasks.listenerCount("task:failed")).toBe(0);
  });

  it("closes the project databases it opened on first use, and does not reopen them", () => {
    // An open SQLite file cannot be deleted on Windows: a ledger left open
    // kept the project's .strada directory locked after shutdown.
    const dir = mkdtempSync(join(tmpdir(), "strada-campaign-dispose-"));
    dirs.push(dir);
    const manager = new CampaignManager({
      storage: new CampaignStorage(join(dir, "campaigns.db")),
      planner: { planMilestones: vi.fn() } as unknown as CampaignPlanner,
      taskManager: new EventEmitter() as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: dir,
    });
    const stores = manager as unknown as { ledger(): EvidenceLedger | null; packageStore(): DeliveryPackageStore | null };
    const ledger = stores.ledger();
    const packages = stores.packageStore();
    expect(ledger).not.toBeNull();
    expect(packages).not.toBeNull();

    manager.dispose();

    expect(() => ledger!.forMilestone("c1", "m1")).toThrow(/not open/i);
    expect(() => packages!.latest("c1")).toThrow(/not open/i);
    expect(stores.ledger()).toBeNull();
    expect(stores.packageStore()).toBeNull();
  });

  it("stops an artifact digest still reading a slow build, so dispose() resolves promptly with no digest taken", async () => {
    // A player build is gigabytes and its digest streams all of it. dispose()
    // waited for the whole read, ahead of failing the in-flight tasks and
    // inside the daemon's 60 s forced-exit window.
    const dir = mkdtempSync(join(tmpdir(), "strada-campaign-dispose-"));
    dirs.push(dir);
    const build = join(dir, "Build");
    mkdirSync(build);
    const artifact = join(build, "Game.bin");
    // Read in 1 MiB pieces: nine reads (the last finds the end) at 250 ms
    // each, over two seconds to read whole.
    writeFileSync(artifact, Buffer.alloc(8 * 1024 * 1024, 7));
    const manager = new CampaignManager({
      storage: new CampaignStorage(join(dir, "campaigns.db")),
      planner: { planMilestones: vi.fn() } as unknown as CampaignPlanner,
      taskManager: new EventEmitter() as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: dir,
    });
    let reading!: () => void;
    const firstRead = new Promise<void>((resolve) => { reading = resolve; });
    Object.assign(slowDisk, { under: build, delayMs: 250, reads: 0, open: 0, onRead: reading });
    try {
      const digest = (manager as unknown as { digestArtifact(path: string): Promise<string | undefined> }).digestArtifact(artifact);
      await firstRead;
      const readsBeforeDispose = slowDisk.reads;
      const startedMs = Date.now();
      await manager.dispose();
      expect(Date.now() - startedMs).toBeLessThan(1_500);
      // The read in flight runs out, no other starts, and the file is closed
      // before dispose() returns: an open handle keeps a Windows directory
      // from being removed.
      expect(slowDisk.reads).toBe(readsBeforeDispose);
      expect(slowDisk.open).toBe(0);
      // A read cut short is not the artifact's digest.
      await expect(digest).resolves.toBeUndefined();
    } finally {
      slowDisk.under = undefined;
      slowDisk.onRead = undefined;
    }
  });
});
