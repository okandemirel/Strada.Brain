import { describe, it, expect, vi, beforeEach } from "vitest";
import { RealTreeGuardian } from "./real-tree-guardian.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { Task } from "../tasks/types.js";
import { TaskStatus } from "../tasks/types.js";

const loggerStub = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => loggerStub,
  getLogger: () => loggerStub,
}));

function makeTaskManager(opts: { active?: boolean; status?: unknown } = {}) {
  const submitted: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
  const cancelled: string[] = [];
  const manager = {
    hasActiveForegroundTasks: vi.fn(() => opts.active ?? false),
    cancel: vi.fn((id: string) => { cancelled.push(id); return true; }),
    getStatus: vi.fn(() => (opts.status ?? null) as never),
    submit: vi.fn((_chatId: string, _channel: string, prompt: string, options?: Record<string, unknown>) => {
      submitted.push({ prompt, options });
      return { id: "task_fix1" } as unknown as Task;
    }),
  };
  return { manager, submitted, cancelled };
}

describe("RealTreeGuardian", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing while sprint work is running", async () => {
    const { manager, submitted } = makeTaskManager({ active: true });
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn().mockResolvedValue({ ok: false, detail: "error CS0101" }),
      projectRoot: "/p",
    });

    await guardian.tick();
    expect(submitted).toHaveLength(0);
  });

  it("a verifier that cannot run is reported, not swallowed: warn with the reason, escalate after 4 blind ticks (audited 2026-09-02)", async () => {
    // Before the fix `ran: false` returned before any log or messenger call,
    // so a guardian whose verifier was permanently unavailable (tool not
    // registered, bridge down) was indistinguishable from a green tree —
    // for days, with "Real-tree guardian started" as the only evidence.
    const { manager, submitted } = makeTaskManager();
    const messages: string[] = [];
    const detail = "unity_verify_change is not registered — verification skipped";
    const verify = vi.fn().mockResolvedValue({ ok: true, ran: false, detail });
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify,
      projectRoot: "/p",
      messenger: async (_chatId, text) => {
        messages.push(text);
      },
    });

    await guardian.tick();
    // The first blind tick is logged with the verifier's own reason.
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not (run|verify)/i),
      expect.objectContaining({ detail, consecutive: 1 }),
    );

    await guardian.tick();
    await guardian.tick();
    expect(messages).toHaveLength(0);

    await guardian.tick(); // 4th consecutive blind tick — escalate once
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(detail);
    expect(messages[0]).toContain("4");

    await guardian.tick(); // 5th — no repeat spam
    expect(messages).toHaveLength(1);
    expect(submitted).toHaveLength(0);

    // A verdict that actually ran resets the streak; a new blind streak reports again.
    verify.mockResolvedValueOnce({ ok: true, ran: true, detail: "compile ok" });
    await guardian.tick();
    for (let i = 0; i < 4; i++) await guardian.tick();
    expect(messages).toHaveLength(2);
  });

  it("does nothing on a green tree", async () => {
    const { manager, submitted } = makeTaskManager();
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn().mockResolvedValue({ ok: true, detail: "compile ok" }),
      projectRoot: "/p",
    });

    await guardian.tick();
    expect(submitted).toHaveLength(0);
  });

  it("on red: submits ONE lease-free fix task with the error list, then goes quiet", async () => {
    const { manager, submitted } = makeTaskManager();
    const messages: string[] = [];
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn().mockResolvedValue({ ok: false, detail: "RocketState.cs(8,17): error CS0101" }),
      projectRoot: "/p",
      messenger: async (_chatId, text) => {
        messages.push(text);
      },
      now: (() => {
        let t = 0;
        return () => t;
      })(),
    });

    await guardian.tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.prompt).toContain("CS0101");
    expect(submitted[0]!.options?.workspacePolicy).toBe("none");
    expect(submitted[0]!.options?.origin).toBe("daemon");
    expect(messages).toHaveLength(1);

    // Quiet period: a second tick must not submit again even while still red.
    await guardian.tick();
    expect(submitted).toHaveLength(1);
  });

  it("does not stack a second fix while the first is still executing", async () => {
    const { manager, submitted } = makeTaskManager();
    let now = 0;
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn().mockResolvedValue({ ok: false, detail: "error CS" }),
      projectRoot: "/p",
      now: () => now,
    });

    await guardian.tick();
    expect(submitted).toHaveLength(1);

    // Past the quiet period, but the fix is still running.
    now += 11 * 60_000;
    manager.getStatus.mockReturnValue({ id: "task_fix1", status: TaskStatus.executing } as unknown as Task);
    await guardian.tick();
    expect(submitted).toHaveLength(1);

    // Fix settled green; next tick re-verifies (still red → second fix).
    manager.getStatus.mockReturnValue({ id: "task_fix1", status: TaskStatus.completed } as unknown as Task);
    await guardian.tick();
    expect(submitted).toHaveLength(2);
  });
});

describe("a repair that is not converging", () => {
  /**
   * Measured live 2026-09-04 22:00–22:27 on the user's project:
   *   25 → 40 → 40 → 37 → 40 → 31 → 10 → 22 → 37 → 37
   * Ten rounds, no escalation. The streak keyed on a hash of the error TEXT,
   * so every round that changed which errors exist reset it — and a thrashing
   * repair changes the text every round by definition.
   */
  const runSequence = async (counts: number[]): Promise<{ submitted: number; messages: string[] }> => {
    const { manager, submitted } = makeTaskManager();
    const messages: string[] = [];
    let i = 0;
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      // A distinct error list each round, exactly like the live sequence.
      verify: vi.fn(async () => ({
        ok: false,
        ran: true,
        detail: `Headless compile failed with ${counts[Math.min(i++, counts.length - 1)]} error(s). CS${1000 + i}`,
      })),
      projectRoot: "/p",
      messenger: async (_c, t) => { messages.push(t); },
      now: (() => { let n = 0; return () => Date.now() + (n++) * 60 * 60_000; })(), // past every backoff
    });
    for (let n = 0; n < counts.length; n++) await guardian.tick();
    return { submitted: submitted.length, messages };
  };

  it("escalates instead of looping when the error count never improves", async () => {
    const { messages } = await runSequence([25, 40, 40, 37, 40, 31]);
    const escalation = messages.find((m) => m.includes("NOT converging"));
    expect(escalation).toBeDefined();
    expect(escalation).toContain("25 error(s)");
  });

  it("keeps working while each attempt beats the last", async () => {
    // Real progress must never be mistaken for thrashing.
    const { messages } = await runSequence([40, 31, 22, 10, 4]);
    expect(messages.find((m) => m.includes("NOT converging"))).toBeUndefined();
  });

  it("a verdict naming no count leaves the old fingerprint rule in charge", async () => {
    const { manager } = makeTaskManager();
    const messages: string[] = [];
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn(async () => ({ ok: false, ran: true, detail: "error CS0101: duplicate type" })),
      projectRoot: "/p",
      messenger: async (_c, t) => { messages.push(t); },
      now: (() => { let n = 0; return () => Date.now() + (n++) * 60 * 60_000; })(),
    });
    for (let i = 0; i < 5; i++) await guardian.tick();
    // Same text every round: the fingerprint guard is the one that fires.
    expect(messages.find((m) => m.includes("same errors persist"))).toBeDefined();
    expect(messages.find((m) => m.includes("NOT converging"))).toBeUndefined();
  });
});

describe("a green tick is not silence", () => {
  /**
   * Audited 2026-09-05: the green branch returned without logging. Two hours
   * after a restart the log held one "Real-tree guardian started" and nothing
   * else, and nothing could tell a healthy tree from a guardian that never
   * ticked — the ambiguity this file already closed for the BLIND case, left
   * open for the green one.
   */
  const greenGuardian = (nowRef: { t: number }) => {
    const { manager } = makeTaskManager();
    const messages: string[] = [];
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn(async () => ({ ok: true, ran: true, detail: "0 errors" })),
      projectRoot: "/p",
      messenger: async (_c, t) => { messages.push(t); },
      now: () => nowRef.t,
    });
    return { guardian, messages };
  };

  it("notes a steady green at most hourly, but at least hourly", async () => {
    const nowRef = { t: 1_000_000 };
    const { guardian } = greenGuardian(nowRef);

    await guardian.tick();
    const first = loggerStub.info.mock.calls.filter((c) => String(c[0]).includes("tree is green")).length;
    expect(first).toBe(1);

    // A second tick minutes later must NOT spam.
    nowRef.t += 15 * 60_000;
    await guardian.tick();
    expect(loggerStub.info.mock.calls.filter((c) => String(c[0]).includes("tree is green")).length).toBe(1);

    // An hour on, it says it is still alive.
    nowRef.t += 60 * 60_000;
    await guardian.tick();
    expect(loggerStub.info.mock.calls.filter((c) => String(c[0]).includes("tree is green")).length).toBe(2);
  });

  it("announces the recovery when a red tree turns green", async () => {
    const { manager } = makeTaskManager();
    const messages: string[] = [];
    let green = false;
    let t = 1_000_000;
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn(async () =>
        green
          ? { ok: true, ran: true, detail: "0 errors" }
          : { ok: false, ran: true, detail: "Headless compile failed with 4 error(s)" },
      ),
      projectRoot: "/p",
      messenger: async (_c, m) => { messages.push(m); },
      now: () => (t += 60 * 60_000),
    });

    await guardian.tick();          // red
    green = true;
    await guardian.tick();          // green again

    expect(messages.find((m) => m.includes("compiles again"))).toBeDefined();
  });
});

describe("one fix task cannot hold the tree forever", () => {
  /**
   * Measured live 2026-09-05 09:00–09:50, with a single owner and the
   * convergence guard already in place: ONE fix task ran 35+ minutes and drove
   * the compile-error count 13 → 4 → 22 → 4 → 17 inside itself. The guard
   * never bit, because it counts the GUARDIAN's rounds and the guardian spent
   * the whole time waiting for that task.
   */
  it("cancels a fix task that overran, and counts it as no progress", async () => {
    const { manager, cancelled } = makeTaskManager({
      status: { status: "executing" },
    });
    let t = 1_000_000;
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn(async () => ({ ok: false, ran: true, detail: "Headless compile failed with 4 error(s)" })),
      projectRoot: "/p",
      now: () => t,
    });

    await guardian.tick();                       // submits fix task
    t += 10 * 60_000;
    await guardian.tick();                       // still young: left alone
    expect(cancelled).toHaveLength(0);

    t += 60 * 60_000;                            // past the budget
    await guardian.tick();
    expect(cancelled).toHaveLength(1);
  });

  it("leaves a fix task alone while it is within budget", async () => {
    const { manager, cancelled } = makeTaskManager({ status: { status: "executing" } });
    let t = 1_000_000;
    const guardian = new RealTreeGuardian({
      taskManager: manager as unknown as TaskManager,
      verify: vi.fn(async () => ({ ok: false, ran: true, detail: "Headless compile failed with 4 error(s)" })),
      projectRoot: "/p",
      now: () => t,
    });

    await guardian.tick();
    for (let i = 0; i < 4; i++) { t += 10 * 60_000; await guardian.tick(); }
    // 40 minutes: a real fix deserves the room.
    expect(cancelled).toHaveLength(0);
  });
});
