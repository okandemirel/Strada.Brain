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

function makeTaskManager(opts: { active?: boolean } = {}) {
  const submitted: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
  const manager = {
    hasActiveForegroundTasks: vi.fn(() => opts.active ?? false),
    getStatus: vi.fn(() => null),
    submit: vi.fn((_chatId: string, _channel: string, prompt: string, options?: Record<string, unknown>) => {
      submitted.push({ prompt, options });
      return { id: "task_fix1" } as unknown as Task;
    }),
  };
  return { manager, submitted };
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
