import { describe, expect, it, vi } from "vitest";
import { SwarmTool, createSwarmTool } from "./swarm-tool.js";

const TYPES = [{ name: "implement" }, { name: "review" }] as never[];

function managerWith(delegate: ReturnType<typeof vi.fn>) {
  return { delegate } as never;
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
      return { success: true, output: "done" };
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

  it("reports per-task failures instead of losing the whole batch", async () => {
    const delegate = vi.fn(async (req: { task: string }) =>
      req.task.startsWith("bad")
        ? { success: false, output: "compile error" }
        : { success: true, output: "ok" },
    );
    const tool = new SwarmTool(TYPES, managerWith(delegate as never), "agent-1" as never, 1);

    const result = await tool.execute({ tasks: [{ task: "good one" }, { task: "bad one" }] }, {} as never);

    expect(result.content).toContain("FAILED");
    expect(result.content).toContain("1 of 2 subtasks failed");
    expect(result.isError).toBeFalsy(); // partial success still returns work
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
      return { success: true, output: "ok" };
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
    const delegate = vi.fn(async () => ({ success: true, output: "ok" }));
    const tool = new SwarmTool(TYPES, managerWith(delegate), "agent-1" as never, 1, 4);
    const ctx = { userAuthorizedPaths: ["/tmp/allowed"] } as never;

    await tool.execute({ tasks: [{ task: "A" }, { task: "B" }] }, ctx);

    expect(delegate).toHaveBeenCalledWith(expect.objectContaining({ toolContext: ctx }));
  });

  it("says so when it drops tasks beyond the limit", async () => {
    const delegate = vi.fn(async () => ({ success: true, output: "ok" }));
    const tool = new SwarmTool(TYPES, managerWith(delegate), "agent-1" as never, 1, 4);
    const many = Array.from({ length: 15 }, (_, i) => ({ task: `T${i}` }));

    const result = await tool.execute({ tasks: many }, {} as never);

    expect(delegate).toHaveBeenCalledTimes(12);
    expect(result.content).toContain("3 task(s) beyond the limit");
  });

  it("refuses a single-task swarm and respects the depth rule", async () => {
    const tool = new SwarmTool(TYPES, managerWith(vi.fn()), "agent-1" as never, 1);
    const single = await tool.execute({ tasks: [{ task: "only" }] }, {} as never);
    expect(single.isError).toBe(true);

    expect(createSwarmTool(TYPES, managerWith(vi.fn()), "a" as never, 2, 2)).toHaveLength(0);
    expect(createSwarmTool(TYPES, managerWith(vi.fn()), "a" as never, 0, 2)).toHaveLength(1);
  });
});
