import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager } from "./campaign-manager.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { Task } from "../tasks/types.js";
import { TaskStatus } from "../tasks/types.js";

class FakeTaskManager extends EventEmitter {
  submitted: Array<{ prompt: string; chatId: string }> = [];
  resumed: string[] = [];
  private counter = 0;
  private statuses = new Map<string, TaskStatus>();
  private parents = new Map<string, string>();
  private results = new Map<string, string>();

  submit(chatId: string, _channelType: string, prompt: string): Task {
    this.counter += 1;
    const id = `task_${this.counter}`;
    this.submitted.push({ chatId, prompt });
    this.statuses.set(id, TaskStatus.executing);
    return { id, chatId, status: TaskStatus.executing } as unknown as Task;
  }

  getStatus(taskId: string): Task | null {
    const status = this.statuses.get(taskId);
    return status
      ? ({ id: taskId, status, result: this.results.get(taskId) } as unknown as Task)
      : null;
  }

  markTerminal(taskId: string, status: TaskStatus, result?: string): void {
    this.statuses.set(taskId, status);
    if (result !== undefined) this.results.set(taskId, result);
  }

  /** Simulate the executor's keep-alive minting a retry under a new id. */
  addRetry(parentId: string, status: TaskStatus = TaskStatus.executing): string {
    this.counter += 1;
    const id = `task_${this.counter}`;
    this.statuses.set(id, status);
    this.parents.set(id, parentId);
    return id;
  }

  isInLineage(rootId: string, taskId: string): boolean {
    let current: string | undefined = taskId;
    while (current) {
      if (current === rootId) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  findLatestLineageTask(rootId: string): Task | null {
    let latest = rootId;
    for (const [child, parent] of this.parents) {
      if (this.isInLineage(rootId, parent) || parent === rootId) latest = child;
    }
    return this.getStatus(latest);
  }

  resumeTask(taskId: string): Task | null {
    this.resumed.push(taskId);
    return this.submit("cli-local", "cli", `resumed:${taskId}`);
  }

  /** Keep the stored status in sync with emitted lifecycle events, as the real manager does. */
  override emit(event: string, ...args: unknown[]): boolean {
    const taskId = args[0] as string;
    if (event === "task:failed") this.statuses.set(taskId, TaskStatus.failed);
    if (event === "task:blocked") this.statuses.set(taskId, TaskStatus.blocked);
    if (event === "task:cancelled") this.statuses.set(taskId, TaskStatus.cancelled);
    if (event === "task:completed") {
      this.statuses.set(taskId, TaskStatus.completed);
      this.results.set(taskId, String(args[1] ?? ""));
    }
    return super.emit(event, ...args);
  }
}

const LADDER = {
  milestones: [
    { title: "Sprint A — Foundations", prompt: "build the foundations, verify compile" },
    { title: "Sprint B — Elements", prompt: "build the elements, PlayMode green" },
    { title: "Sprint C — Delivery", prompt: "integrate, full suite, DELIVERY REPORT" },
  ],
};

describe("CampaignManager", () => {
  let dir: string;
  let projectRoot: string;
  let storage: CampaignStorage;
  let tasks: FakeTaskManager;
  let messages: Array<{ chatId: string; text: string }>;
  let manager: CampaignManager;

  const ctx = { chatId: "cli-local", channelType: "cli", userId: "u1" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "campaign-mgr-"));
    projectRoot = join(dir, "project");
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), "# Test GDD\n\nElement schedule: ...");
    storage = new CampaignStorage(join(dir, "campaigns.db"));
    tasks = new FakeTaskManager();
    messages = [];

    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
    } as unknown as CampaignPlanner;

    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
    });
    manager.attachEvents();
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const settleMilestone = (result: string) => {
    const last = tasks.submitted.length;
    const taskId = `task_${last}`;
    tasks.emit("task:completed", taskId, result);
  };

  it("GDD mode: plans the ladder and submits sprint 1 immediately (no approval gate)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    expect(campaign.state).toBe("planning");

    await vi.waitFor(() => {
      expect(tasks.submitted).toHaveLength(1);
    });
    expect(tasks.submitted[0]!.prompt).toContain("foundations");
    expect(storage.get(campaign.id)!.state).toBe("executing");
    // The ladder announcement went to the origin conversation.
    expect(messages.some((m) => m.text.includes("Milestone ladder ready"))).toBe(true);
  });

  it("walks the ladder: sprint completion auto-submits the next sprint", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    settleMilestone("sprint A done, committed");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("elements");

    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    settleMilestone("final report");
    await vi.waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("done");
    });
    expect(messages.at(-1)!.text).toContain("Campaign delivery");
  });

  it("retries a failed milestone with the failure appended, then fails loudly", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.emit("task:failed", "task_1", "compile exploded");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("compile exploded");

    tasks.emit("task:failed", "task_2", "compile exploded again");
    await vi.waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("failed");
    });
    expect(messages.at(-1)!.text).toContain("Campaign stopped");
  });

  it("nudges a blocked sprint with the autonomous mandate instead of waiting on a person", async () => {
    manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.emit("task:blocked", "task_1", "blocked:ask_user");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("do not ask the user");
  });

  it("idea mode: drafts the GDD, gates on approval, builds after 'evet'", async () => {
    const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
    expect(campaign.state).toBe("drafting-gdd");
    expect(tasks.submitted).toHaveLength(1);
    expect(tasks.submitted[0]!.prompt).toContain("pigs fly");

    // Draft completes; the GDD file exists in docs/.
    tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
    await vi.waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("awaiting-approval");
    });
    expect(messages.at(-1)!.text).toContain("Game_GDD.md");

    // A random message from another chat is not consumed by the gate.
    expect(await manager.tryHandleApproval("other-chat", "evet")).toBe(false);

    // Revision feedback re-drafts instead of launching.
    expect(await manager.tryHandleApproval("cli-local", "daha fazla bölüm ekle")).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("daha fazla bölüm ekle");

    // Second draft lands, designer approves → ladder plans, sprint 1 starts.
    tasks.emit("task:completed", "task_2", "revised GDD written");
    await vi.waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("awaiting-approval");
    });
    expect(await manager.tryHandleApproval("cli-local", "evet")).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("re-drafts when a 'completed' draft never wrote the GDD file", async () => {
    rmSync(join(projectRoot, "docs", "Game_GDD.md"));
    const campaign = manager.startFromIdea(ctx, "a puzzle game");
    expect(campaign.state).toBe("drafting-gdd");

    tasks.emit("task:completed", "task_1", "I described the GDD in chat");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("never wrote the GDD file");
  });

  it("resumeActive resubmits the in-flight milestone when the task died with the process", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // Simulate crash: the task is terminally failed but its event never arrived.
    tasks.markTerminal("task_1", TaskStatus.failed);

    await manager.resumeActive();
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("adopts the executor's own retry instead of resubmitting and burning an attempt", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Keep-alive parks task_1 as blocked and mints task_2 as its retry.
    const retryId = tasks.addRetry("task_1");
    tasks.emit("task:blocked", "task_1", "Transient failure — provider cooldown. Auto-retry 1/10 in ~30s.");

    // After the grace window the campaign adopts the retry: no resubmission.
    await vi.waitFor(() => {
      const fresh = storage.get(campaign.id)!;
      expect(fresh.milestones[0]!.taskId).toBe(retryId);
    });
    expect(tasks.submitted).toHaveLength(1);
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // untouched

    // The adopted retry completing walks the ladder normally.
    tasks.emit("task:completed", retryId, "sprint A done via retry");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
  });

  it("resumes a paused (startup-recovered) task instead of wedging forever", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.markTerminal("task_1", TaskStatus.paused);

    await manager.resumeActive();
    expect(tasks.resumed).toContain("task_1");
    await vi.waitFor(() => {
      const fresh = storage.get(campaign.id)!;
      expect(fresh.milestones[0]!.taskId).not.toBe("task_1");
    });
  });

  it("'kampanya devam' revives a failed campaign with a fresh attempt budget", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.emit("task:failed", "task_1", "boom");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    tasks.emit("task:failed", "task_2", "boom again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

    const consumed = await manager.tryHandleRevive("cli-local", "kampanya devam");
    expect(consumed).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.state).toBe("executing");
    expect(fresh.milestones[0]!.attempts).toBe(1); // fresh budget, one new attempt
  });

  it("commits the working tree when a milestone goes green", async () => {
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@test.local");
    git("config", "user.name", "Test");

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    writeFileSync(join(projectRoot, "SprintWork.cs"), "class SprintWork {}");
    tasks.emit("task:completed", "task_1", "sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    expect(git("status", "--porcelain").trim()).toBe(""); // tree clean
    expect(git("log", "-1", "--pretty=%s")).toContain("milestone green");
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("appends a coverage-remediation sprint when the audit finds GDD gaps", async () => {
    // Isolated fixtures: the beforeEach manager stays subscribed to the shared
    // emitter, and two managers double-handling one campaign is not a
    // production shape (exactly one CampaignManager attaches per process).
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-coverage.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi
        .fn()
        .mockResolvedValueOnce(["Dragon boss: no milestone implemented it"])
        .mockResolvedValue([]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      retryAdoptionGraceMs: 10,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    settleMilestone("final report"); // last planned milestone → audit fires, finds a gap
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(tasks.submitted[3]!.prompt).toContain("Dragon boss");
    expect(storage.get(campaign.id)!.state).toBe("executing");

    settleMilestone("dragon implemented"); // remediation lands → audit clean → done
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
  });

  it("resumeActive leaves a still-running task alone", async () => {
    manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    await manager.resumeActive(); // task_1 still 'executing' in the fake
    expect(tasks.submitted).toHaveLength(1);
  });
});
