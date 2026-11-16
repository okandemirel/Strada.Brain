/**
 * A task submitted from inside a run does not spend that run's Budget (task #87, QA attempt 3).
 *
 * BackgroundExecutor.enqueue starts the queue synchronously, so a task submitted from inside a
 * run — an interactive run handing a goal block to the background, a retry, a resumed goal —
 * starts in the submitter's async context. The executor already cut the run's provenance and
 * design document there; the run Budget scope carried over, and a call the new task recorded
 * before opening a run of its own was debited from the submitter's Budget (measured: the
 * supervisor's 3,000 / 500 grounding call landed in the other run's Budget). The next queued task
 * starts from the previous one's settle, so the inheritance could run down the whole queue.
 *
 * Drives the REAL BackgroundExecutor and the REAL accounting funnel; the orchestrator and the
 * runner are scripted.
 */
import { describe, expect, it, vi } from "vitest";
import { BackgroundExecutor } from "./background-executor.js";
import { TaskStatus, type Task } from "./types.js";
import { createBudget, type Budget } from "../agent-core/control/budget.js";
import { runBudget, UNSCOPED_DEBIT_LOG, withRunBudget } from "../agent-core/control/budget-scope.js";
import { recordProviderUsage, type AccountingDeps } from "../agent-core/engine/accounting.js";
import type { AgentRunRequest, AgentRunResult } from "../agent-core/runner/index.js";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLoggerSafe: () => log, getLogger: () => log }));

/** The executor runs every task through the runner seam; this one hands the prompt to the host. */
vi.mock("../agent-core/runner/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-core/runner/index.js")>();
  return {
    ...actual,
    selectAgentRunner: (host: { runBackgroundTask: (prompt: string, opts: { taskRunId?: string }) => Promise<string> }) => ({
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        const output = await host.runBackgroundTask(request.prompt, { taskRunId: request.taskRunId });
        return {
          status: "completed", finalText: output, finalSummary: output, provider: "mock", catalogVersion: "mock:default",
          assignmentVersion: 0, touchedFiles: [], toolTrace: [], verificationResults: [], reviewFindings: [], artifacts: [],
        } as unknown as AgentRunResult;
      },
    }),
  };
});

const DEPS = { getSupervisorRoutingContext: () => ({}) } as unknown as AccountingDeps;
const GROUNDING = { inputTokens: 3_000, outputTokens: 500, totalTokens: 3_500 };

function task(id: string, chatId: string): Task {
  return {
    id: id as Task["id"], chatId, channelType: "cli", title: id, status: TaskStatus.pending,
    prompt: "Summarise the tide gauge readings", progress: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
}

describe("BackgroundExecutor — a task does not spend the Budget of the run that submitted it", () => {
  it("a call the handed-off task records before its own run opens is not debited from the submitter's run", async () => {
    const submitter = createBudget(1_000_000, 1_000);
    const seen = new Map<string, Budget | undefined>();
    let executor!: BackgroundExecutor;
    const orchestrator = {
      // What admission records before any run of the task is open (the supervisor's grounding call).
      evaluateSupervisorAdmission: vi.fn(async (opts: { taskRunId?: string }) => {
        seen.set(String(opts.taskRunId), runBudget());
        if (opts.taskRunId === "task_handed_off") recordProviderUsage(DEPS, "claude", GROUNDING);
        return { path: "direct_worker", reason: "low_complexity" };
      }),
      runBackgroundTask: vi.fn(async (_prompt: string, opts: { taskRunId?: string }) => {
        if (opts.taskRunId === "task_submitter") {
          // Inside the submitting run's scope, as reflection's goal hand-off is.
          withRunBudget(submitter, () => executor.enqueue(task("task_handed_off", "chat2"), new AbortController().signal, vi.fn()));
        }
        return "done";
      }),
    };
    executor = new BackgroundExecutor({ orchestrator: orchestrator as never, concurrencyLimit: 2 });
    const taskManager = { updateStatus: vi.fn(), complete: vi.fn(), fail: vi.fn(), block: vi.fn() };
    executor.setTaskManager(taskManager as never);

    executor.enqueue(task("task_submitter", "chat1"), new AbortController().signal, vi.fn());
    await vi.waitFor(() => expect(taskManager.complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

    expect(seen.has("task_handed_off"), "the handed-off task never reached admission").toBe(true);
    expect(seen.get("task_handed_off"), "the handed-off task started inside the submitter's run Budget").toBeUndefined();
    expect(submitter.spentOutputTokens(), "the handed-off task's call was debited from the run that submitted it").toBe(0);
    expect(submitter.inputTokensSeen()).toBe(0);
    // The call had no run's Budget in scope, and the log says so instead of hiding it.
    expect(log.warn.mock.calls.filter(([message]) => message === UNSCOPED_DEBIT_LOG)).toHaveLength(1);
  });
});
