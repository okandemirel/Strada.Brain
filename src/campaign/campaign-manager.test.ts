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
    this.createdAts.set(id, Date.now());
    return { id, chatId, status: TaskStatus.executing } as unknown as Task;
  }

  private createdAts = new Map<string, number>();
  updatedAts = new Map<string, number>();

  verifications = new Map<string, { testsGreen?: boolean; detail: string }>();

  getStatus(taskId: string): Task | null {
    const status = this.statuses.get(taskId);
    return status
      ? ({
          id: taskId,
          status,
          result: this.results.get(taskId),
          createdAt: this.createdAts.get(taskId) ?? Date.now(),
          updatedAt: this.updatedAts.get(taskId) ?? Date.now(),
          verification: this.verifications.get(taskId),
        } as unknown as Task)
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

  priorProgressSummary(taskId: string): string {
    return this.progressBlocks.get(taskId) ?? "";
  }
  progressBlocks = new Map<string, string>();

  findLineageRootId(taskId: string): string {
    let current = taskId;
    while (this.parents.has(current)) current = this.parents.get(current)!;
    return current;
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
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
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

  it("a milestone retry carries the previous attempt's progress without persisting it", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.progressBlocks.set(
      "task_1",
      "\n\nPREVIOUS ATTEMPT PROGRESS (verify before redoing any of it):\n- Assets/Scripts/Board.cs",
    );
    tasks.emit("task:failed", "task_1", "compile exploded");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    // The SUBMITTED prompt carries the progress block…
    expect(tasks.submitted[1]!.prompt).toContain("PREVIOUS ATTEMPT PROGRESS");
    expect(tasks.submitted[1]!.prompt).toContain("Assets/Scripts/Board.cs");
    // …but the persisted milestone prompt does not (no accumulation).
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.prompt).not.toContain("PREVIOUS ATTEMPT PROGRESS");
  });

  it("strips retry-machinery noise from the failure tail and keeps only one tail", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // (Reaped/Auto-retry wording is settlement-deferred by design, so the
    // noise strip is exercised with the non-deferring machinery preface.)
    tasks.emit(
      "task:failed",
      "task_1",
      "Transient failure — worker crashed mid-epoch. Board.cs does not compile",
    );
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const prompt1 = storage.get(campaign.id)!.milestones[0]!.prompt;
    expect(prompt1).toContain("Board.cs does not compile");
    expect(prompt1).not.toContain("Transient failure —");
  });

  it("rejects a completion that left the repository untouched (one no-work bounce)", async () => {
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    // Commit timestamps are second-granular; the sprint must start strictly
    // after the baseline's second for "unchanged since sprint start" to hold.
    await new Promise((r) => setTimeout(r, 1100));

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Completion with a clean tree and no commits since the sprint began.
    settleMilestone("sprint A done (allegedly)");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const bounced = storage.get(campaign.id)!;
    expect(bounced.milestones[0]!.status).toBe("running");
    expect(bounced.milestones[0]!.prompt).toContain("NO WORK DETECTED");
    expect(bounced.milestones[0]!.attempts).toBe(1); // bounce burned no attempt

    // Second completion stands either way (one bounce per milestone).
    settleMilestone("sprint A done again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("time-box forces scope narrowing when a sprint spins past its budget", async () => {
    // Measured 2026-08-31: m6 ran 22h at attempts=1 because bounces and
    // deferrals deliberately never burn attempts — nothing bounded the run.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Backdate the clock past the box, then settle badly.
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 3 * 60 * 60_000;
    storage.save(stored);

    tasks.emit("task:failed", "task_1", "compile still red");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    const fresh = storage.get(campaign.id)!;
    expect(tasks.submitted[1]!.prompt).toContain("TIME BOX");
    expect(tasks.submitted[1]!.prompt).toContain("NARROW THE SCOPE");
    expect(fresh.milestones[0]!.timeBoxEscalations).toBe(1);
    expect(fresh.milestones[0]!.attempts).toBe(1); // escalation burns no attempt
    expect(messages.some((m) => m.text.includes("narrowing scope"))).toBe(true);
  });

  it("the time-box binds the ADOPTION path too (a sprint cannot spin forever unadjudicated)", async () => {
    // Measured 2026-09-01: m6 ran 7h+ with timeBoxEscalations=0 because every
    // settle was adopted as an executor retry and never reached an outcome.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 4 * 60 * 60_000;
    storage.save(stored);

    // Executor mints a live retry under a new id: the adoption path.
    const retryId = tasks.addRetry("task_1", TaskStatus.executing);
    tasks.emit("task:blocked", "task_1", "Reaped: no progress signal for 60 minutes.");
    void retryId;

    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.timeBoxEscalations).toBe(1);
    expect(tasks.submitted[1]!.prompt).toContain("NARROW THE SCOPE");
  });

  it("a dead retry promise stops the deferral loop (ghost keep-alive)", async () => {
    // Measured live 2026-08-30 15:33-15:55: keep-alive budget exhausted, no
    // task active anywhere, yet reconcile re-deferred every cycle to a retry
    // that no longer existed — the campaign idled behind a ghost promise.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Tip promises a 1s retry but its updatedAt is 10 minutes old: promise dead.
    tasks.updatedAts.set("task_1", Date.now() - 10 * 60_000);
    tasks.emit(
      "task:blocked",
      "task_1",
      "Transient failure — worker crashed. Auto-retry 1/10 in ~1s.",
    );
    // Not deferred: the outcome is judged and the retry branch resubmits.
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("running");
  });

  it("doubled settle emissions cannot consume the deferral and burn an attempt", async () => {
    // Measured 2026-08-29 19:04: one handler logged the defer, the second
    // (same second, doubled task:blocked emission) consumed the one-shot flag
    // and submitted attempt 2 into a 68-minute quota wall.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    const parkText = "Transient failure — All providers are in cooldown. Auto-retry 2/10 in ~4105s.";
    tasks.emit("task:blocked", "task_1", parkText);
    tasks.emit("task:blocked", "task_1", parkText);

    // Both settles defer (grace 10ms + settle chain) — no resubmission, no
    // attempt burn, campaign still executing on the parked lineage.
    await new Promise((r) => setTimeout(r, 250));
    expect(tasks.submitted).toHaveLength(1);
    const fresh = storage.get(campaign.id)!;
    expect(fresh.state).toBe("executing");
    expect(fresh.milestones[0]!.attempts).toBe(1);
    expect(fresh.milestones[0]!.reconcileDeferredSince).toBeGreaterThan(0);
  });

  it("a stop during a full provider outage arms self-revival and revives when the chain recovers", async () => {
    // Measured 2026-08-29 (00:58 and 12:27): "failed on quota" meant failed
    // until a person typed "kampanya devam" — hours of operator attention for
    // a scheduled, known-duration wait.
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("claude");
    registry.recordOverloaded("claude", "quota wall");
    setLiveChainMemberNames(["claude"]);

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
      // Non-outage wording (reconcile must not defer) while the chain cools —
      // the stop-time health check is what must detect the outage.
      tasks.emit("task:failed", "task_1", "2 fresh plans produced nothing new");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
      tasks.emit("task:failed", "task_2", "2 fresh plans produced nothing new");

      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      const parked = storage.get(campaign.id)!;
      expect(parked.autoReviveAt).toBeGreaterThan(Date.now());
      expect(messages.at(-1)!.text).toContain("Self-revival armed");

      // The chain recovers; the (privately re-scheduled, short) appointment fires.
      registry.clearProviderState("claude");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void })
        .scheduleAutoRevive(campaign.id, 20);
      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("executing"));
      const revived = storage.get(campaign.id)!;
      expect(revived.autoReviveAt).toBeUndefined();
      expect(tasks.submitted.length).toBeGreaterThanOrEqual(3);
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("claude");
    }
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
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
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

  it("bounces a completion once when the sprint demanded a capture and none exists", async () => {
    const planner = {
      planMilestones: vi.fn().mockResolvedValue({
        milestones: [
          { title: "Sprint A — Visual", prompt: "build it; end with a captured frame proving something renders" },
          { title: "Sprint B — Next", prompt: "continue the work with more building" },
        ],
      }),
    } as unknown as CampaignPlanner;
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-capture.db"));
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot, // no Recordings/ dir → no evidence
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    settleMilestone("done, everything renders (it says)");
    // Bounced: resubmitted with the missing-evidence demand, attempts NOT burned.
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("VISUAL EVIDENCE MISSING");
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.status).toBe("running");
    expect(fresh.milestones[0]!.attempts).toBe(1);

    // Second completion stands (one-shot bounce) and the ladder advances.
    settleMilestone("done again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("a completion whose last test run was red is not green (mechanical test gate)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.verifications.set("task_1", {
      testsGreen: false,
      detail: "PlayMode verification FAILED: 5 of 95 tests failed",
    });
    settleMilestone("sprint A complete, everything works great");

    // Routed to the retry path with the red run named — not green.
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.status).not.toBe("green");
    expect(tasks.submitted[1]!.prompt).toContain("Tests were RED at completion");

    // A green-verdict completion passes.
    tasks.verifications.set("task_2", { testsGreen: true, detail: "All 95 tests passed" });
    settleMilestone("sprint A complete for real");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("capture evidence demands meaningful, non-identical frames", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const milestone = storage.get(campaign.id)!.milestones[0]!;
    milestone.taskId = "task_1";
    const gate = (m: unknown) =>
      (manager as unknown as { freshCaptureEvidence(x: unknown): { found: boolean } }).freshCaptureEvidence(m);

    const rec = join(projectRoot, "Recordings");
    mkdirSync(rec, { recursive: true });

    // A tiny file is not evidence.
    writeFileSync(join(rec, "frame_000.png"), Buffer.alloc(300, 7));
    expect(gate(milestone).found).toBe(false);

    // Several byte-identical "frames" are not evidence (unchanging screen).
    writeFileSync(join(rec, "frame_000.png"), Buffer.alloc(4096, 7));
    writeFileSync(join(rec, "frame_001.png"), Buffer.alloc(4096, 7));
    expect(gate(milestone).found).toBe(false);

    // Distinct meaningful frames pass.
    writeFileSync(join(rec, "frame_001.png"), Buffer.alloc(4096, 9));
    expect(gate(milestone).found).toBe(true);
  });

  it("resumeActive leaves a still-running task alone", async () => {
    manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    await manager.resumeActive(); // task_1 still 'executing' in the fake
    expect(tasks.submitted).toHaveLength(1);
  });
});
