import { describe, it, expect, vi, beforeEach } from "vitest";
import { RealTreeGuardian } from "./real-tree-guardian.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { Task } from "../tasks/types.js";
import { TaskStatus } from "../tasks/types.js";

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
