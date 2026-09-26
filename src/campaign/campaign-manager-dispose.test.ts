/**
 * COR-9: on shutdown the campaign stops listening BEFORE the task manager fails
 * its in-flight tasks; otherwise it answers those shutdown failures by
 * submitting a new milestone into a task manager that is closing.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignManager } from "./campaign-manager.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { DeliveryPackageStore } from "./delivery-package.js";
import type { EvidenceLedger } from "./evidence-ledger.js";
import type { TaskManager } from "../tasks/task-manager.js";

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
});
