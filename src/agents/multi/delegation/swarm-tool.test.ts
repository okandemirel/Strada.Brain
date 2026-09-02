import { describe, expect, it, vi } from "vitest";
import { SwarmTool, createSwarmTool } from "./swarm-tool.js";
import type { DelegationResult } from "./delegation-types.js";

const TYPES = [{ name: "implement" }, { name: "review" }] as never[];

function managerWith(delegate: ReturnType<typeof vi.fn>) {
  return { delegate } as never;
}

/**
 * The REAL shape DelegationManager.delegate() resolves with. The first version
 * of these tests faked `{ success, output }` — a contract the manager never
 * produced — so the suite stayed green while every fulfilled subtask rendered
 * as "(no output)" in production (audited 2026-09-02).
 */
function delegationResult(content: string, status: "completed" | "failed" | "blocked" = "completed"): DelegationResult {
  return {
    content,
    workerResult: {
      status,
      finalSummary: content,
      visibleResponse: content,
      provider: "mock-provider",
      catalogVersion: "mock:mock",
      assignmentVersion: 0,
      touchedFiles: [],
      toolTrace: [],
      verificationResults: [],
      reviewFindings: [],
      artifacts: [],
    },
    metadata: { model: "mock", tier: "cheap", costUsd: 0, durationMs: 1, toolsUsed: [], escalated: false },
  };
}

describe("SwarmTool", () => {
  it("runs independent subtasks CONCURRENTLY, not one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const delegate = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return delegationResult("done");
    });
    const tool = new SwarmTool(TYPES, managerWith(delegate), "agent-1" as never, 1);

    const result = await tool.execute(
      { tasks: [{ task: "A" }, { task: "B" }, { task: "C" }] },
      {} as never,
    );

    expect(delegate).toHaveBeenCalledTimes(3);
    expect(peak).toBeGreaterThan(1); // the whole point: fan-out
    expect(result.content).toContain("Swarm of 3 sub-agents");
  });

  it("renders every sub-agent's returned content — the real DelegationResult shape", async () => {
    // Measured 2026-09-02: delegate() resolves { content, workerResult, metadata };
    // the tool read `output`/`success` off it, so six successful audits came back
    // as six "(no output)" entries under a success banner, and the parent
    // reported the batch complete with zero evidence of the work.
    const delegate = vi.fn(async (req: { task: string }) =>
      delegationResult(`Audit of ${req.task}: 2 findings, both fixed.`),
    );
    const tool = new SwarmTool(TYPES, managerWith(delegate as never), "agent-1" as never, 1);

    const result = await tool.execute(
      { tasks: [{ task: "module A" }, { task: "module B" }] },
      {} as never,
    );

    expect(result.content).toContain("Audit of module A: 2 findings, both fixed.");
    expect(result.content).toContain("Audit of module B: 2 findings, both fixed.");
    expect(result.content).not.toContain("(no output)");
    expect(result.isError).toBeFalsy();
  });

  it("reports per-task failures instead of losing the whole batch", async () => {
    // The manager THROWS on a failed worker (executeSingleDelegation rethrows),
    // so a failure reaches the swarm as a rejection, never as a fulfilled value.
    const delegate = vi.fn(async (req: { task: string }) => {
      if (req.task.startsWith("bad")) throw new Error("compile error");
      return delegationResult("ok");
    });
    const tool = new SwarmTool(TYPES, managerWith(delegate as never), "agent-1" as never, 1);

    const result = await tool.execute({ tasks: [{ task: "good one" }, { task: "bad one" }] }, {} as never);

    expect(result.content).toContain("FAILED: Error: compile error");
    expect(result.content).toContain("1 of 2 subtasks failed");
    expect(result.isError).toBeFalsy(); // partial success still returns work
  });

  it("does not read a BLOCKED worker as a finished subtask", async () => {
    // delegate() returns blocked workers without throwing (see delegation-manager
    // tests); a swarm must not fold a checkpoint into "N sub-agents finished".
    const delegate = vi.fn(async (req: { task: string }) =>
      req.task === "stuck"
        ? delegationResult("Need a different diagnosis path", "blocked")
        : delegationResult("ok"),
    );
    const tool = new SwarmTool(TYPES, managerWith(delegate as never), "agent-1" as never, 1);

    const result = await tool.execute({ tasks: [{ task: "fine" }, { task: "stuck" }] }, {} as never);

    expect(result.content).toContain("BLOCKED: Need a different diagnosis path");
    expect(result.content).toContain("1 of 2 subtasks failed");
  });

  it("QUEUES past the concurrency limit instead of dropping tasks as failures", async () => {
    // Measured 2026-09-01: delegate() rejects past maxConcurrentPerParent (it
    // does not queue), so firing every task in one tick returned
    // "6 of 12 failed — max concurrent delegations exceeded" — dropped work
    // reported as failure.
    let inFlight = 0;
    let peak = 0;
    const delegate = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (inFlight > 2) throw new Error("Max concurrent delegations (2) exceeded");
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return delegationResult("ok");
    });
    const tool = new SwarmTool(TYPES, managerWith(delegate), "agent-1" as never, 1, 2);

    const result = await tool.execute(
      { tasks: [{ task: "A" }, { task: "B" }, { task: "C" }, { task: "D" }, { task: "E" }] },
      {} as never,
    );

    expect(delegate).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(2); // never exceeds the pool width
    expect(result.content).not.toContain("exceeded");
  });

  it("passes the caller's tool context so sub-agents inherit authorized paths", async () => {
    const delegate = vi.fn(async () => delegationResult("ok"));
    const tool = new SwarmTool(TYPES, managerWith(delegate), "agent-1" as never, 1, 4);
    const ctx = { userAuthorizedPaths: ["/tmp/allowed"] } as never;

    await tool.execute({ tasks: [{ task: "A" }, { task: "B" }] }, ctx);

    expect(delegate).toHaveBeenCalledWith(expect.objectContaining({ toolContext: ctx }));
  });

  it("says so when it drops tasks beyond the limit", async () => {
    const delegate = vi.fn(async () => delegationResult("ok"));
    const tool = new SwarmTool(TYPES, managerWith(delegate), "agent-1" as never, 1, 4);
    const many = Array.from({ length: 15 }, (_, i) => ({ task: `T${i}` }));

    const result = await tool.execute({ tasks: many }, {} as never);

    expect(delegate).toHaveBeenCalledTimes(12);
    expect(result.content).toContain("3 task(s) beyond the limit");
  });

  it("names malformed entries it did not run instead of shrinking the swarm silently", async () => {
    // Measured 2026-09-02: `dropped` was computed from the already-filtered
    // array, so an entry without a usable `task` string vanished and the
    // report opened "Swarm of 5 sub-agents finished." for a six-task request.
    const delegate = vi.fn(async () => delegationResult("ok"));
    const tool = new SwarmTool(TYPES, managerWith(delegate), "agent-1" as never, 1, 4);

    const result = await tool.execute(
      {
        tasks: [
          { task: "A" },
          { description: "audit the input module" },
          { task: "   " },
          { task: "B" },
          { task: "C" },
        ],
      },
      {} as never,
    );

    expect(delegate).toHaveBeenCalledTimes(3);
    expect(result.content).toContain("Swarm of 3 sub-agents");
    expect(result.content).toContain("2 of 5 submitted entries were NOT run");
    expect(result.content).toContain("no usable `task` string");
  });

  it("still reports the over-limit drop when malformed entries hide it", async () => {
    // 12 valid + 3 malformed used to print "Swarm of 12" with NO note at all:
    // the input filter defeated the very cap-note it sits next to.
    const delegate = vi.fn(async () => delegationResult("ok"));
    const tool = new SwarmTool(TYPES, managerWith(delegate), "agent-1" as never, 1, 4);
    const many: Array<Record<string, unknown>> = Array.from({ length: 12 }, (_, i) => ({ task: `T${i}` }));
    many.push({ task: "" }, { nope: 1 }, { task: 42 });

    const result = await tool.execute({ tasks: many }, {} as never);

    expect(delegate).toHaveBeenCalledTimes(12);
    expect(result.content).toContain("3 of 15 submitted entries were NOT run");
  });

  it("refuses a single-task swarm and respects the depth rule", async () => {
    const tool = new SwarmTool(TYPES, managerWith(vi.fn()), "agent-1" as never, 1);
    const single = await tool.execute({ tasks: [{ task: "only" }] }, {} as never);
    expect(single.isError).toBe(true);

    expect(createSwarmTool(TYPES, managerWith(vi.fn()), "a" as never, 2, 2)).toHaveLength(0);
    expect(createSwarmTool(TYPES, managerWith(vi.fn()), "a" as never, 0, 2)).toHaveLength(1);
  });
});
