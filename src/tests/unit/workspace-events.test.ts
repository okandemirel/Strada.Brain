import { describe, it, expect } from "vitest";
import type { WorkspaceEventMap } from "../../dashboard/workspace-events.js";

describe("WorkspaceEventMap enrichments", () => {
  it("monitor:task_update accepts optional phase, progress, elapsed", () => {
    const event: WorkspaceEventMap["monitor:task_update"] = {
      rootId: "r1",
      nodeId: "n1",
      status: "executing",
      phase: "acting",
      progress: { current: 3, total: 7, unit: "files" },
      elapsed: 12000,
    };
    expect(event.phase).toBe("acting");
    expect(event.progress?.current).toBe(3);
    expect(event.elapsed).toBe(12000);
  });

  it("monitor:task_update works without new fields (backward compat)", () => {
    const event: WorkspaceEventMap["monitor:task_update"] = {
      rootId: "r1",
      nodeId: "n1",
      status: "completed",
    };
    expect(event.phase).toBeUndefined();
  });

  it("monitor:substep has required fields", () => {
    const event: WorkspaceEventMap["monitor:substep"] = {
      rootId: "r1",
      nodeId: "n1",
      substep: {
        id: "s1",
        label: "Analyzing auth.ts",
        status: "active",
        order: 1,
        files: ["auth.ts"],
      },
    };
    expect(event.substep.status).toBe("active");
  });

  it("progress:narrative has required fields", () => {
    const event: WorkspaceEventMap["progress:narrative"] = {
      narrative: "Fixing auth middleware",
      lang: "en",
      milestone: { current: 2, total: 5, label: "2/5 tasks" },
    };
    expect(event.milestone?.current).toBe(2);
  });

  it("canvas:agent_draw has required fields", () => {
    const event: WorkspaceEventMap["canvas:agent_draw"] = {
      action: "draw",
      shapes: [{ type: "task-card", id: "tc1", props: { title: "Fix bug" } }],
      layout: "tree",
      intent: "Plan visualization",
    };
    expect(event.action).toBe("draw");
    expect(event.shapes).toHaveLength(1);
  });

  it("canvas:user_feedback has required fields", () => {
    const event: WorkspaceEventMap["canvas:user_feedback"] = {
      action: "select",
      shapeIds: ["s1", "s2"],
      annotation: "Focus on this",
    };
    expect(event.shapeIds).toHaveLength(2);
  });
});
