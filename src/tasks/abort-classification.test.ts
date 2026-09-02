/**
 * What a task says when it is stopped without the user asking.
 *
 * This branch used to assert one cause unconditionally: any abort that was not
 * a user cancel became "the task stalled without making progress… break the
 * request into smaller steps". That advice is actively wrong when the cause was
 * something else, and nothing logged the real reason, so a run that ended this
 * way could not be explained afterwards.
 *
 * Measured on a real run: the task executed a tool and two LLM calls in the four
 * seconds before it was blocked, and its last progress update was 2.5 minutes
 * earlier — well inside the 10-minute inactivity window. It was told it had made
 * no progress.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createLogger } from "../utils/logger.js";
import { BackgroundExecutor } from "./background-executor.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

type Blocked = { taskId: string; message: string };

function executorWith(): { executor: BackgroundExecutor; blocked: Blocked[] } {
  const blocked: Blocked[] = [];
  const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
  // Prototype-built executor: class fields are not initialised, so the
  // reaper marker set (read at settle) must be provided here.
  (executor as unknown as { reapedInflight: Set<string> }).reapedInflight = new Set();
  (executor as unknown as { taskManager: unknown }).taskManager = {
    block: (taskId: string, message: string) => blocked.push({ taskId, message }),
  };
  return { executor, blocked };
}

function settle(
  executor: BackgroundExecutor,
  prompt: string,
  reason: unknown,
  userCancelled = false,
): boolean {
  const external = { aborted: userCancelled } as AbortSignal;
  return (
    executor as unknown as {
      settleWatchdogAbortIfHung(
        task: { id: string; prompt: string },
        externalSignal: AbortSignal | undefined,
        abortReason?: unknown,
      ): boolean;
    }
  ).settleWatchdogAbortIfHung({ id: "t1", prompt }, external, reason);
}

describe("abort classification", () => {
  it("says 'stalled' only when the inactivity watchdog really fired", () => {
    const { executor, blocked } = executorWith();
    const emitted = settle(executor, "build a thing", new Error("Task made no progress for 600000ms"));

    expect(emitted).toBe(true);
    expect(blocked[0]!.message).toMatch(/stalled without making progress/i);
  });

  it("does not claim stalling for any other abort reason", () => {
    // The case that was being misreported: something else aborted the run and
    // the user was told to split up a request that was progressing fine.
    const { executor, blocked } = executorWith();
    settle(executor, "build a thing", new Error("epoch budget exhausted"));

    expect(blocked[0]!.message).not.toMatch(/stalled without making progress/i);
    expect(blocked[0]!.message).toMatch(/stopped before it finished/i);
    expect(blocked[0]!.message).toContain("epoch budget exhausted");
  });

  it("tells the user their changes were kept", () => {
    // Work is committed before release, so a stopped task usually HAS produced
    // files; saying nothing invites the user to assume it all vanished.
    const { executor, blocked } = executorWith();
    settle(executor, "build a thing", new Error("something else"));
    expect(blocked[0]!.message).toMatch(/changes it made have been kept/i);
  });

  it("stays silent on a genuine user cancel", () => {
    const { executor, blocked } = executorWith();
    const emitted = settle(executor, "build a thing", new Error("aborted"), true);

    expect(emitted).toBe(false);
    expect(blocked).toHaveLength(0);
  });

  it("answers in the language the task was asked in", () => {
    const { executor, blocked } = executorWith();
    settle(executor, "Bir modül oluştur ve testlerini yaz", new Error("Task made no progress for 600000ms"));
    expect(blocked[0]!.message).toMatch(/ilerleme kaydetmeden/i);
  });

  it("copes with an abort that carries no reason", () => {
    const { executor, blocked } = executorWith();
    settle(executor, "build a thing", undefined);
    expect(blocked[0]!.message).toMatch(/stopped before it finished/i);
    // No empty parenthetical when there is nothing to report.
    expect(blocked[0]!.message).not.toContain("()");
  });
});
