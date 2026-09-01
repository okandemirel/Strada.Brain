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

  it("refuses a single-task swarm and respects the depth rule", async () => {
    const tool = new SwarmTool(TYPES, managerWith(vi.fn()), "agent-1" as never, 1);
    const single = await tool.execute({ tasks: [{ task: "only" }] }, {} as never);
    expect(single.isError).toBe(true);

    expect(createSwarmTool(TYPES, managerWith(vi.fn()), "a" as never, 2, 2)).toHaveLength(0);
    expect(createSwarmTool(TYPES, managerWith(vi.fn()), "a" as never, 0, 2)).toHaveLength(1);
  });
});
