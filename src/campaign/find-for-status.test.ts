import { describe, it, expect } from "vitest";
import { CampaignManager } from "./campaign-manager.js";
import type { Campaign } from "./types.js";

function campaign(overrides: Partial<Campaign>): Campaign {
  return {
    id: "c",
    chatId: "chat",
    channelType: "web",
    userId: "u",
    projectRoot: "/proj",
    state: "executing",
    draftAttempts: 0,
    currentMilestone: 0,
    createdAt: 1,
    updatedAt: 1,
    milestones: [{ id: "m1", title: "t", prompt: "p", status: "running", attempts: 1, taskId: "task_1" }],
    ...overrides,
  };
}

function manager(active: Campaign[], terminal: Campaign[]) {
  return new CampaignManager({
    storage: { listActive: () => active, listRecentTerminal: () => terminal } as never,
    planner: {} as never,
    taskManager: {
      getStatus: (id: string) => (id === "task_1" ? { id, title: "T", status: "executing", createdAt: 1, updatedAt: 2, progress: [] } : null),
      listTasks: () => [],
    } as never,
    messenger: async () => undefined,
    projectRoot: "/proj",
    maxMilestoneAttempts: 2,
    milestoneTimeBoxMs: 1000,
  });
}

describe("CampaignManager.findForStatus / describeStatus", () => {
  it("prefers the active campaign on the asking chat, then any active one on the project", () => {
    const telegram = campaign({ id: "tg", chatId: "tg-chat", updatedAt: 5 });
    const web = campaign({ id: "web", chatId: "web-chat", updatedAt: 9 });
    const m = manager([telegram, web], []);
    expect(m.findForStatus("tg-chat")?.id).toBe("tg");
    expect(m.findForStatus("other-chat")?.id).toBe("web");
    expect(m.findForStatus()?.id).toBe("web");
  });

  it("falls back to the newest terminal campaign of this project, ignoring other projects", () => {
    const old = campaign({ id: "old", state: "done", updatedAt: 3 });
    const newer = campaign({ id: "newer", state: "failed", updatedAt: 8 });
    const elsewhere = campaign({ id: "elsewhere", state: "failed", updatedAt: 99, projectRoot: "/other" });
    const m = manager([], [old, elsewhere, newer]);
    expect(m.findForStatus("any")?.id).toBe("newer");
    expect(manager([], [elsewhere]).findForStatus("any")).toBeUndefined();
  });

  it("describeStatus carries the manager's own limits and resolves the milestone task", () => {
    const m = manager([campaign({ id: "live" })], []);
    const snapshot = m.describeStatus("chat");
    expect(snapshot).toMatchObject({
      id: "live",
      milestoneTimeBoxMs: 1000,
      milestones: [{ id: "m1", maxAttempts: 2 }],
      currentTask: { id: "task_1", status: "executing" },
    });
    expect(manager([], []).describeStatus("chat")).toBeUndefined();
  });
});
