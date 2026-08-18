/**
 * The verify checkpoint has to name a tool the run can actually reach.
 *
 * Measured on a probe run: the agent modified two files, the checkpoint said
 * "Run dotnet_build before continuing", and dotnet_build is removed from the
 * offered tools in a Unity project without a solution — which is every Unity
 * project the Editor has not opened yet. It could not clear the flag, the
 * checkpoint fired again, and loop detection eventually stopped the task with
 * "I got stuck on this task after multiple approaches". The task still reported
 * failed: false.
 *
 * Any tool in VERIFY_TOOLS clears the flag, so naming a reachable one costs
 * nothing and unblocks the run.
 */

import { describe, it, expect } from "vitest";
import { TaskPlanner } from "./task-planner.js";

/** Enough mutations to trip the checkpoint, with no verification in between. */
function tripCheckpoint(planner: TaskPlanner): void {
  for (let i = 0; i < 6; i++) {
    planner.trackToolCall("file_write", false, { path: `Assets/Modules/A/F${i}.cs` });
  }
}

describe("which tool the verify checkpoint asks for", () => {
  it("names the headless one by default", () => {
    // The default is the Unity project shape: no solution, no Editor open.
    const planner = new TaskPlanner({ iterationBudget: 100 });
    tripCheckpoint(planner);

    const injection = planner.getStateInjection();

    expect(injection).toContain("[VERIFY]");
    expect(injection).toContain("unity_verify_change");
    expect(injection).not.toContain("dotnet_build");
  });

  it("names dotnet_build when the caller says there is a solution", () => {
    const planner = new TaskPlanner({ iterationBudget: 100, buildToolName: "dotnet_build" });
    tripCheckpoint(planner);

    expect(planner.getStateInjection()).toContain("dotnet_build");
  });

  it("stops asking once the named tool has run", () => {
    // The mechanism was always right — any VERIFY_TOOLS call clears it. Only the
    // name was wrong, which is what made the checkpoint unclearable.
    const planner = new TaskPlanner({ iterationBudget: 100 });
    tripCheckpoint(planner);
    expect(planner.getStateInjection()).toContain("[VERIFY]");

    planner.trackToolCall("unity_verify_change", false, {});

    expect(planner.getStateInjection()).not.toContain("[VERIFY]");
  });
});
