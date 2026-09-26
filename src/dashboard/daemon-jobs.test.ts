/**
 * The long daemon operations `strada daemon memory:consolidate` and
 * `deploy:check` start (COR-13 follow-up): a job answers at once and is read
 * back until it settles, instead of one HTTP answer that can outlast the
 * client's 300 s header timeout.
 */

import { describe, expect, it } from "vitest";
import { DaemonJobRegistry } from "./daemon-jobs.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("DaemonJobRegistry", () => {
  it("starts the work at once and reports running, then done with its result", async () => {
    let clock = 1_000;
    const jobs = new DaemonJobRegistry({ now: () => clock });
    const work = deferred<{ processed: number }>();
    let calls = 0;

    const start = jobs.start("memory:consolidate", () => {
      calls += 1;
      return work.promise;
    });
    expect(start.started).toBe(true);
    if (!start.started) return;
    expect(calls).toBe(1); // begun before the 202 goes out
    expect(start.job).toEqual({ id: start.job.id, kind: "memory:consolidate", state: "running", startedAt: 1_000 });
    expect(start.job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(jobs.get(start.job.id)).toEqual(start.job);

    clock = 4_000;
    work.resolve({ processed: 3 });
    await settle();
    expect(jobs.get(start.job.id)).toEqual({
      id: start.job.id,
      kind: "memory:consolidate",
      state: "done",
      startedAt: 1_000,
      finishedAt: 4_000,
      result: { processed: 3 },
    });
  });

  it("keeps a failure's message, whether the work rejects or throws before it starts", async () => {
    const jobs = new DaemonJobRegistry();
    const rejected = jobs.start("memory:consolidate", () => Promise.reject(new Error("LLM provider unavailable")));
    const thrown = jobs.start("deploy:check", () => {
      throw new Error("test command is not configured");
    });
    await settle();
    if (!rejected.started || !thrown.started) throw new Error("both should start");
    expect(jobs.get(rejected.job.id)).toMatchObject({ state: "failed", error: "LLM provider unavailable" });
    expect(jobs.get(rejected.job.id)).not.toHaveProperty("result");
    expect(jobs.get(thrown.job.id)).toMatchObject({ state: "failed", error: "test command is not configured" });
  });

  it("runs one job per kind: a second start is told which one is running, and another kind still starts", async () => {
    const jobs = new DaemonJobRegistry();
    const work = deferred<string>();
    const first = jobs.start("memory:consolidate", () => work.promise);
    let secondRan = false;
    const second = jobs.start("memory:consolidate", async () => {
      secondRan = true;
    });
    if (!first.started) throw new Error("first should start");
    expect(second).toEqual({ started: false, running: first.job });
    expect(secondRan).toBe(false);
    expect(jobs.start("deploy:check", async () => "ok").started).toBe(true);

    work.resolve("done");
    await settle();
    expect(jobs.start("memory:consolidate", async () => "again").started).toBe(true);
  });

  it("forgets a finished job once its retention has passed, but never a running one", async () => {
    let clock = 0;
    const jobs = new DaemonJobRegistry({ now: () => clock, retainMs: 60 * 60_000 });
    const quick = jobs.start("deploy:check", async () => "ok");
    const slow = jobs.start("memory:consolidate", () => new Promise(() => undefined));
    if (!quick.started || !slow.started) throw new Error("both should start");
    await settle();

    clock = 60 * 60_000 - 1;
    expect(jobs.get(quick.job.id)).toMatchObject({ state: "done" });
    clock = 60 * 60_000;
    expect(jobs.get(quick.job.id)).toBeUndefined();
    clock = 10 * 60 * 60_000;
    expect(jobs.get(slow.job.id)).toMatchObject({ state: "running" });
  });

  it("is bounded: the oldest finished jobs make room", async () => {
    const jobs = new DaemonJobRegistry({ maxJobs: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const start = jobs.start("deploy:check", async () => i);
      if (!start.started) throw new Error("should start");
      ids.push(start.job.id);
      await settle();
    }
    expect(ids.map((id) => jobs.get(id)?.result)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it("answers undefined for an id it never issued", () => {
    expect(new DaemonJobRegistry().get("0f8fad5b-d9cb-469f-a165-70867728950e")).toBeUndefined();
  });
});
