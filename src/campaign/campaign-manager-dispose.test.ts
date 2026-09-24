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
});
