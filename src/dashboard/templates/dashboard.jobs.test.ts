/**
 * POST /api/deployment/check now starts a job (202 { jobId }): the built-in
 * dashboard's "Run Readiness Check" button follows the job to its result
 * instead of reading `ready` off the start answer.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const SCRIPT = readFileSync(new URL("./dashboard.js", import.meta.url), "utf-8");

function loadPage(answers: unknown[]) {
  const sandbox: Record<string, unknown> = {
    fetch: () => new Promise(() => undefined), // the page's own first refresh() never settles
    setInterval: () => 0,
    setTimeout,
    document: {},
    console,
    prompt: () => null,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  };
  runInNewContext(SCRIPT, sandbox);
  const server = vi.fn(async (_path: string) => {
    const body = answers.length > 1 ? answers.shift() : answers[0];
    return { status: 200, json: async () => body };
  });
  sandbox["fetch"] = server;
  const follow = sandbox["followDaemonJob"] as (jobId: string, intervalMs?: number) => Promise<unknown>;
  return { server, follow };
}

describe("the dashboard page follows a readiness-check job", () => {
  it("polls the job until it is done and resolves with its result", async () => {
    const result = { ready: true, testPassed: true, gitClean: true, branchMatch: true };
    const { server, follow } = loadPage([
      { state: "running" },
      { state: "running" },
      { state: "done", result },
    ]);

    await expect(follow("job-1", 1)).resolves.toEqual(result);
    expect(server.mock.calls.map((call) => call[0])).toEqual([
      "/api/daemon/jobs/job-1",
      "/api/daemon/jobs/job-1",
      "/api/daemon/jobs/job-1",
    ]);
  });

  it("rejects with the job's error when it failed", async () => {
    const { follow } = loadPage([{ state: "failed", error: "test command timed out" }]);
    await expect(follow("job-1", 1)).rejects.toThrow("test command timed out");
  });

  it("starts the check through the job route", () => {
    expect(SCRIPT).toContain("started.jobId ? followDaemonJob(started.jobId) : started");
  });
});
